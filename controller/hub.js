const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Hub = require('../models/Hub');
const User = require('../models/User');
const Token = require('../models/Token');
const Shipment = require('../models/Shipment');
const { HUB_STATUSES, HUB_SERVICES, DAYS } = require('../models/Hub');
const { HUB_LEVELS, HUB_LEVEL_LABELS, MANAGER_ROLE_FOR_LEVEL } = require('../config/permissions');
const { PROVINCE_NAMES, matchProvince, provinceCode } = require('../utils/provinces');
const { isHubUser, hubInScope, loadPermissions, sameId } = require('../middleware/access');
const { sendInvite } = require('../services/accountTokens');

const PARENT_LEVEL = { SubRegion: 'Regional', Retail: 'SubRegion' };
const CODE_PREFIX = { Regional: 'RH', SubRegion: 'SR', Retail: 'RT' };
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const saPhoneRegex = /^0[1-8]\d{8}$/;
const normalizePhone = (phone) => String(phone || '').replace(/[\s().-]/g, '').replace(/^(?:\+27|0027|27)(?=\d{9}$)/, '0');
const isSuperAdmin = (user) => user?.role === 'Super Admin';
const isObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const text = (value) => (typeof value === 'string' ? value.trim() : '');

// Hubs a user may see: everything for head office, their own area for hub users
const scopeFilter = (user) => (isHubUser(user)
  ? (user.hub ? { $or: [{ _id: user.hub }, { ancestors: user.hub }] } : { _id: null })
  : {});

const canSeeHub = (user, hub) => !isHubUser(user) || hubInScope(user, hub);
// Hub users may manage the hubs below their own, but not their own hub's status or position
const canManageHub = (user, hub) => !isHubUser(user) || (hubInScope(user, hub) && !sameId(hub._id, user.hub));

const nextHubCode = async (level, province) => {
  const prefix = `${CODE_PREFIX[level]}-${provinceCode(province)}-`;
  const last = await Hub.find({ hubCode: new RegExp(`^${prefix}\\d+$`) }).select('hubCode').lean();
  const highest = last.reduce((max, { hubCode }) => Math.max(max, Number(hubCode.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
};

const cleanHours = (hours) => {
  const byDay = new Map((Array.isArray(hours) ? hours : []).map((row) => [row?.day, row]));
  return DAYS.map((day) => {
    const row = byDay.get(day) || {};
    const closed = Boolean(row.closed);
    return { day, closed, open: closed ? undefined : text(row.open) || undefined, close: closed ? undefined : text(row.close) || undefined };
  });
};

// Check the form and turn it into hub fields. `existing` is the hub being edited, if any.
const readHubForm = async (body, user, existing) => {
  const errors = {};
  const level = existing ? existing.level : body.level;
  if (!HUB_LEVELS.includes(level)) errors.level = 'Choose the hub level.';

  const name = text(body.name);
  if (!name) errors.name = 'Enter the hub name.';

  // Where the hub sits: a Regional Hub has no parent; the others sit under the level above
  let parent = null;
  const parentId = body.parent === undefined && existing ? existing.parent : body.parent;
  if (level && level !== 'Regional') {
    if (!isObjectId(parentId)) {
      errors.parent = `Choose the ${HUB_LEVEL_LABELS[PARENT_LEVEL[level]]} this hub belongs to.`;
    } else {
      parent = await Hub.findById(parentId);
      if (!parent || parent.level !== PARENT_LEVEL[level]) {
        errors.parent = `Choose the ${HUB_LEVEL_LABELS[PARENT_LEVEL[level]]} this hub belongs to.`;
      } else if (parent.status === 'Draft') {
        errors.parent = 'That hub is still a draft. Submit it first.';
      } else if (isHubUser(user) && !hubInScope(user, parent)) {
        errors.parent = 'You can only add hubs inside your own area.';
      } else if (existing && !sameId(parent._id, existing.parent) && isHubUser(user)) {
        errors.parent = 'Only head office can move a hub to a different parent.';
      }
    }
  }

  // A Regional Hub chooses its province; lower hubs take the province of their Regional Hub
  const province = level === 'Regional' ? matchProvince(body.province ?? existing?.province) : parent?.province;
  if (level === 'Regional' && !province) errors.province = 'Choose the province.';

  const address = {
    street: text(body.address?.street),
    suburb: text(body.address?.suburb),
    city: text(body.address?.city),
    province: matchProvince(body.address?.province) || province || undefined,
    postalCode: text(body.address?.postalCode),
  };
  if (!address.street) errors['address.street'] = 'Enter the street address.';
  if (!address.suburb) errors['address.suburb'] = 'Enter the suburb.';
  if (!address.city) errors['address.city'] = 'Enter the city or town.';
  if (!/^\d{4}$/.test(address.postalCode)) errors['address.postalCode'] = 'Enter the 4-digit postal code.';
  if (province && address.province && address.province !== province) {
    errors['address.province'] = `This hub is in ${province}. Its address must be in ${province} too.`;
  }

  const manager = {
    name: text(body.manager?.name),
    email: text(body.manager?.email).toLowerCase(),
    officeLine: normalizePhone(body.manager?.officeLine),
    cell: normalizePhone(body.manager?.cell),
  };
  if (!manager.name) errors['manager.name'] = "Enter the hub manager's name.";
  if (!emailRegex.test(manager.email)) errors['manager.email'] = "Enter the manager's email address.";
  if (!saPhoneRegex.test(manager.cell)) errors['manager.cell'] = 'Enter a South African cell number, e.g. 082 123 4567.';
  if (manager.officeLine && !saPhoneRegex.test(manager.officeLine)) errors['manager.officeLine'] = 'Enter a South African number, e.g. 011 123 4567.';

  const additionalContact = { name: text(body.additionalContact?.name), number: normalizePhone(body.additionalContact?.number) };
  if (additionalContact.number && !saPhoneRegex.test(additionalContact.number)) {
    errors['additionalContact.number'] = 'Enter a South African number.';
  }

  const administrator = {
    name: text(body.administrator?.name),
    email: text(body.administrator?.email).toLowerCase(),
    phone: normalizePhone(body.administrator?.phone),
    sendLogin: body.administrator?.sendLogin !== false,
  };
  if (!administrator.name) errors['administrator.name'] = "Enter the hub administrator's name.";
  if (!emailRegex.test(administrator.email)) errors['administrator.email'] = "Enter the administrator's email address.";
  if (!saPhoneRegex.test(administrator.phone)) errors['administrator.phone'] = 'Enter a South African number, e.g. 082 123 4567.';
  if (!errors['administrator.email']) {
    // The administrator's email must be free, or already belong to this hub's login
    const owner = await User.findOne({ email: administrator.email }).select('_id hub');
    const ours = owner && existing && (sameId(owner._id, existing.administrator?.user) || sameId(owner.hub, existing._id));
    if (owner && !ours) errors['administrator.email'] = `${administrator.email} already has a ShipDay account. Use a different email.`;
  }

  const operatingHours = cleanHours(body.operatingHours);
  operatingHours.forEach((row) => {
    if (row.closed) return;
    if (!row.open || !row.close || !/^\d{2}:\d{2}$/.test(row.open) || !/^\d{2}:\d{2}$/.test(row.close)) {
      errors[`hours.${row.day}`] = `Enter opening and closing times for ${row.day}, or mark it closed.`;
    } else if (row.open >= row.close) {
      errors[`hours.${row.day}`] = `${row.day}: closing time must be after opening time.`;
    }
  });

  const services = [...new Set((body.services || []).filter((s) => HUB_SERVICES.includes(s)))];
  if (!services.length) errors.services = 'Tick at least one service this hub offers.';

  const lat = body.location?.latitude === '' ? null : Number(body.location?.latitude);
  const lng = body.location?.longitude === '' ? null : Number(body.location?.longitude);
  const location = {};
  if (body.location && (lat !== null || lng !== null) && body.location.latitude !== undefined) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -35.5 || lat > -22 || lng < 16 || lng > 33.5) {
      errors.location = 'GPS location must be in South Africa, e.g. -26.1952, 28.0341.';
    } else {
      location.latitude = lat;
      location.longitude = lng;
    }
  }

  let hubCode = text(body.hubCode).toUpperCase();
  if (hubCode && !/^[A-Z0-9-]{3,20}$/.test(hubCode)) errors.hubCode = 'Hub codes use letters, numbers and dashes only.';

  if (level === 'Regional' && province) {
    const clash = await Hub.findOne({ level: 'Regional', province, ...(existing ? { _id: { $ne: existing._id } } : {}) }).select('name');
    if (clash) errors.province = `${province} already has a Regional Hub (${clash.name}).`;
  }
  if (!errors.hubCode && level && province) {
    if (!hubCode && !existing) hubCode = await nextHubCode(level, province);
    if (hubCode) {
      const taken = await Hub.exists({ hubCode, ...(existing ? { _id: { $ne: existing._id } } : {}) });
      if (taken) errors.hubCode = 'That hub code is already in use.';
    }
  }

  const data = {
    name, level, province, address, manager, additionalContact, administrator, operatingHours, services,
    parent: parent?._id || null,
    ancestors: parent ? [...parent.ancestors, parent._id] : [],
  };
  if (Object.keys(location).length) data.location = location;
  if (hubCode) data.hubCode = hubCode;
  return { errors, data };
};

const badRequest = (res, errors) => res.status(400).json({
  message: Object.values(errors)[0] || 'Please check the form.',
  errors,
});

// Create (or update) the administrator's login, and email it once the hub is active
const syncAdministrator = async (hub, actor) => {
  const admin = hub.administrator || {};
  if (!admin.email) return { inviteSent: false };
  let user = admin.user ? await User.findById(admin.user) : null;

  if (!user) {
    const existing = await User.findOne({ email: admin.email });
    if (existing) {
      // Reuse an unattached team login for this hub; never take over a customer or another hub's login
      const sameHub = existing.hub && sameId(existing.hub, hub._id);
      if (!sameHub) {
        const err = new Error(`${admin.email} already has a ShipDay account. Use a different email for the hub administrator.`);
        err.status = 400;
        throw err;
      }
      user = existing;
    } else {
      user = new User({
        email: admin.email,
        password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
        fullName: admin.name,
        phone: admin.phone,
        role: MANAGER_ROLE_FOR_LEVEL[hub.level],
        hub: hub._id,
        customerId: `HUB-${hub.hubCode}`,
        createdBy: actor?._id || null,
        profileCompleted: true,
      });
    }
  } else if (!user.invite?.acceptedAt && user.email !== admin.email) {
    const taken = await User.exists({ email: admin.email, _id: { $ne: user._id } });
    if (taken) {
      const err = new Error(`${admin.email} already has a ShipDay account.`);
      err.status = 400;
      throw err;
    }
    user.email = admin.email;
  }

  user.fullName = admin.name || user.fullName;
  user.phone = admin.phone || user.phone;
  await user.save();
  hub.administrator.user = user._id;

  let inviteSent = false;
  let inviteError = null;
  if (hub.status === 'Active' && admin.sendLogin && !user.invite?.acceptedAt && !hub.administrator.inviteSentAt) {
    try {
      await sendInvite(user, { invitedBy: actor?.fullName, hubName: hub.name });
      hub.administrator.inviteSentAt = new Date();
      inviteSent = true;
    } catch (err) {
      console.error('Hub administrator invite failed:', err.message);
      inviteError = "The hub was saved, but the login email couldn't be sent. Use \"Resend login\" on the Team page.";
    }
  }
  await hub.save();
  return { inviteSent, inviteError };
};

// Team members added while the hub was waiting for approval get their login email now
const inviteWaitingMembers = async (hub, actor) => {
  const waiting = await User.find({
    hub: hub._id, createdBy: { $ne: null }, status: { $ne: 'Disabled' }, 'invite.sentAt': null, 'invite.acceptedAt': null,
  });
  for (const member of waiting) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendInvite(member, { invitedBy: actor?.fullName, hubName: hub.name });
    } catch (err) {
      console.error(`Invite to ${member.email} failed:`, err.message);
    }
  }
};

const publicHub = (hub) => {
  const obj = typeof hub.toObject === 'function' ? hub.toObject() : hub;
  return { ...obj, levelLabel: HUB_LEVEL_LABELS[obj.level] };
};

// GET /api/hubs
exports.listHubs = async (req, res) => {
  try {
    const { level, province, status, search, parent } = req.query;
    const filter = { ...scopeFilter(req.user) };
    if (HUB_LEVELS.includes(level)) filter.level = level;
    if (PROVINCE_NAMES.includes(province)) filter.province = province;
    if (HUB_STATUSES.includes(status)) filter.status = status;
    if (isObjectId(parent)) filter.parent = parent;
    if (search) {
      const pattern = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = [{ $or: [{ name: pattern }, { hubCode: pattern }, { 'address.city': pattern }, { 'address.suburb': pattern }] }];
    }

    const hubs = await Hub.find(filter).populate('parent', 'name hubCode level').sort({ province: 1, level: 1, name: 1 }).lean();
    const ids = hubs.map((h) => h._id);
    const [childCounts, teamCounts] = await Promise.all([
      Hub.aggregate([{ $match: { parent: { $in: ids } } }, { $group: { _id: '$parent', count: { $sum: 1 } } }]),
      User.aggregate([{ $match: { hub: { $in: ids } } }, { $group: { _id: '$hub', count: { $sum: 1 } } }]),
    ]);
    const children = new Map(childCounts.map((c) => [String(c._id), c.count]));
    const team = new Map(teamCounts.map((c) => [String(c._id), c.count]));

    res.json({
      hubs: hubs.map((hub) => ({
        ...publicHub(hub),
        childCount: children.get(String(hub._id)) || 0,
        teamCount: team.get(String(hub._id)) || 0,
      })),
    });
  } catch (err) {
    console.error('List hubs error:', err);
    res.status(500).json({ message: "We couldn't load the hubs." });
  }
};

// GET /api/hubs/next-code?level=&province=
exports.previewHubCode = async (req, res) => {
  const { level } = req.query;
  let province = matchProvince(req.query.province);
  if (!province && isObjectId(req.query.parent)) province = (await Hub.findById(req.query.parent).select('province'))?.province;
  if (!HUB_LEVELS.includes(level) || !province) return res.json({ hubCode: '' });
  return res.json({ hubCode: await nextHubCode(level, province) });
};

// GET /api/hubs/:id
exports.getHub = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Hub not found.' });
    const hub = await Hub.findById(req.params.id)
      .populate('parent', 'name hubCode level status')
      .populate('ancestors', 'name hubCode level')
      .populate('approvedBy', 'fullName')
      .populate('createdBy', 'fullName');
    if (!hub || !canSeeHub(req.user, hub)) return res.status(404).json({ message: 'Hub not found.' });

    const [children, team] = await Promise.all([
      Hub.find({ parent: hub._id }).select('name hubCode level status address.city').sort({ name: 1 }).lean(),
      User.find({ hub: hub._id }).select('fullName email phone role status invite employment.jobTitle').sort({ fullName: 1 }).lean(),
    ]);

    res.json({
      hub: publicHub(hub),
      children: children.map(publicHub),
      team: team.map((member) => ({
        _id: member._id,
        fullName: member.fullName,
        email: member.email,
        phone: member.phone,
        role: member.role,
        jobTitle: member.employment?.jobTitle || '',
        status: member.status || 'Active',
        loginStatus: member.invite?.acceptedAt ? 'Active' : (member.invite?.sentAt ? 'Invite sent' : 'Not sent'),
      })),
      canManage: canManageHub(req.user, hub),
    });
  } catch (err) {
    console.error('Get hub error:', err);
    res.status(500).json({ message: "We couldn't load this hub." });
  }
};

// POST /api/hubs
exports.createHub = async (req, res) => {
  try {
    const { errors, data } = await readHubForm(req.body, req.user);
    if (Object.keys(errors).length) return badRequest(res, errors);

    // Only the Super Admin can make a hub active; everyone else saves a draft or sends it for approval
    let status = HUB_STATUSES.includes(req.body.status) ? req.body.status : 'Draft';
    if (status === 'Suspended') status = 'Draft';
    if (status === 'Active' && !isSuperAdmin(req.user)) status = 'Pending Approval';

    const hub = new Hub({
      ...data,
      status,
      createdBy: req.user._id,
      submittedAt: status === 'Pending Approval' ? new Date() : null,
      approvedBy: status === 'Active' ? req.user._id : null,
      approvedAt: status === 'Active' ? new Date() : null,
    });
    await hub.save();

    let login = { inviteSent: false };
    try {
      login = await syncAdministrator(hub, req.user);
    } catch (err) {
      await Hub.deleteOne({ _id: hub._id });
      return res.status(err.status || 500).json({ message: err.message, errors: { 'administrator.email': err.message } });
    }

    res.status(201).json({
      message: status === 'Active' ? 'Hub created and active.' : status === 'Pending Approval' ? 'Hub sent for approval.' : 'Hub saved as a draft.',
      hub: publicHub(hub),
      ...login,
    });
  } catch (err) {
    console.error('Create hub error:', err);
    if (err.code === 11000) return res.status(400).json({ message: 'A hub with that code or province already exists.' });
    res.status(500).json({ message: "We couldn't create the hub." });
  }
};

// Move a hub's descendants (and their shipments) after its parent changes
const refreshTree = async (hub) => {
  const descendants = await Hub.find({ ancestors: hub._id }).sort({ level: 1 });
  const pathOf = new Map([[String(hub._id), [...hub.ancestors, hub._id]]]);
  const ordered = [...descendants].sort((a, b) => HUB_LEVELS.indexOf(a.level) - HUB_LEVELS.indexOf(b.level));
  for (const child of ordered) {
    const parentPath = pathOf.get(String(child.parent));
    child.ancestors = parentPath;
    child.province = hub.province;
    // eslint-disable-next-line no-await-in-loop
    await child.save();
    pathOf.set(String(child._id), [...parentPath, child._id]);
  }
  await Promise.all([...pathOf.entries()].map(([id, path]) => Shipment.updateMany({ hub: id }, { $set: { hubPath: path } })));
};

// PUT /api/hubs/:id
exports.updateHub = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Hub not found.' });
    const hub = await Hub.findById(req.params.id);
    if (!hub || !canSeeHub(req.user, hub)) return res.status(404).json({ message: 'Hub not found.' });
    // Hub users can update their own hub's details, but not where it sits
    if (isHubUser(req.user) && !hubInScope(req.user, hub)) return res.status(403).json({ message: "You can't edit this hub." });

    const { errors, data } = await readHubForm(req.body, req.user, hub);
    if (Object.keys(errors).length) return badRequest(res, errors);
    if (isHubUser(req.user) && sameId(hub._id, req.user.hub) && String(data.parent || '') !== String(hub.parent || '')) {
      return res.status(403).json({ message: 'Only head office can move a hub.' });
    }

    const moved = String(data.parent || '') !== String(hub.parent || '');
    // Keep the link to the administrator's login, unless a different person takes over
    // from someone who already signed in (they keep their own login on the Team page)
    let adminUser = hub.administrator?.user || null;
    let inviteSentAt = hub.administrator?.inviteSentAt || null;
    if (adminUser) {
      const current = await User.findById(adminUser).select('email invite');
      if (current && current.email !== data.administrator.email && current.invite?.acceptedAt) {
        adminUser = null;
        inviteSentAt = null;
      }
    }
    Object.assign(hub, data);
    hub.administrator.user = adminUser;
    hub.administrator.inviteSentAt = inviteSentAt;
    if (req.body.status === 'Pending Approval' && hub.status === 'Draft') {
      hub.status = 'Pending Approval';
      hub.submittedAt = new Date();
    }
    await hub.save();
    if (moved) await refreshTree(hub);

    const login = await syncAdministrator(hub, req.user);
    res.json({ message: 'Hub updated.', hub: publicHub(hub), ...login });
  } catch (err) {
    console.error('Update hub error:', err);
    if (err.status) return res.status(err.status).json({ message: err.message });
    if (err.code === 11000) return res.status(400).json({ message: 'A hub with that code or province already exists.' });
    res.status(500).json({ message: "We couldn't update the hub." });
  }
};

// POST /api/hubs/:id/status  { action: 'submit' | 'approve' | 'suspend' | 'reactivate', reason }
exports.changeHubStatus = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Hub not found.' });
    const hub = await Hub.findById(req.params.id);
    if (!hub || !canSeeHub(req.user, hub)) return res.status(404).json({ message: 'Hub not found.' });

    const permissions = await loadPermissions(req);
    const { action } = req.body;
    const reason = text(req.body.reason);
    const forbid = (message = "You don't have permission to do this.") => res.status(403).json({ message });

    if (action === 'submit') {
      if (hub.status !== 'Draft') return res.status(400).json({ message: 'Only draft hubs can be sent for approval.' });
      if (!permissions.some((p) => p === 'hubs.create' || p === 'hubs.edit') || !canManageHub(req.user, hub)) return forbid();
      hub.status = 'Pending Approval';
      hub.submittedAt = new Date();
    } else if (action === 'approve' || action === 'reactivate') {
      if (!permissions.includes('hubs.approve')) return forbid('Only the Super Admin can approve or reactivate hubs.');
      if (hub.status === 'Active') return res.status(400).json({ message: 'This hub is already active.' });
      if (hub.parent) {
        const parent = await Hub.findById(hub.parent).select('status name');
        if (parent?.status !== 'Active') return res.status(400).json({ message: `Approve ${parent?.name || 'the parent hub'} first.` });
      }
      hub.status = 'Active';
      hub.approvedBy = req.user._id;
      hub.approvedAt = new Date();
      hub.suspendedAt = null;
      hub.suspendedReason = undefined;
    } else if (action === 'suspend') {
      if (!permissions.includes('hubs.edit') || !canManageHub(req.user, hub)) return forbid();
      if (hub.status !== 'Active') return res.status(400).json({ message: 'Only active hubs can be suspended.' });
      if (!reason) return res.status(400).json({ message: 'Give a reason for suspending the hub.' });
      hub.status = 'Suspended';
      hub.suspendedAt = new Date();
      hub.suspendedReason = reason;
    } else {
      return res.status(400).json({ message: 'Unknown action.' });
    }

    await hub.save();
    // People at a suspended hub are signed out and can't sign in until it is reactivated
    if (hub.status === 'Suspended') {
      const members = await User.find({ hub: hub._id }).select('_id');
      await Token.deleteMany({ userId: { $in: members.map((m) => m._id) } });
    }
    const login = hub.status === 'Active' ? await syncAdministrator(hub, req.user) : { inviteSent: false };
    if (hub.status === 'Active') await inviteWaitingMembers(hub, req.user);

    const messages = {
      submit: 'Hub sent for approval.',
      approve: 'Hub approved and active.',
      reactivate: 'Hub reactivated.',
      suspend: 'Hub suspended. Its team has been signed out.',
    };
    res.json({ message: messages[action], hub: publicHub(hub), ...login });
  } catch (err) {
    console.error('Change hub status error:', err);
    if (err.status) return res.status(err.status).json({ message: err.message });
    res.status(500).json({ message: "We couldn't change the hub's status." });
  }
};

// DELETE /api/hubs/:id — drafts only, with nothing attached
exports.deleteDraftHub = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Hub not found.' });
    const hub = await Hub.findById(req.params.id);
    if (!hub || !canSeeHub(req.user, hub)) return res.status(404).json({ message: 'Hub not found.' });
    if (hub.status !== 'Draft') return res.status(400).json({ message: 'Only draft hubs can be deleted. Suspend an active hub instead.' });
    if (!canManageHub(req.user, hub)) return res.status(403).json({ message: "You can't delete this hub." });
    const [children, shipments] = await Promise.all([Hub.exists({ parent: hub._id }), Shipment.exists({ hub: hub._id })]);
    if (children || shipments) return res.status(400).json({ message: 'This hub has hubs or shipments linked to it, so it cannot be deleted.' });

    const adminUser = hub.administrator?.user ? await User.findById(hub.administrator.user) : null;
    if (adminUser && sameId(adminUser.hub, hub._id) && !adminUser.invite?.acceptedAt) await User.deleteOne({ _id: adminUser._id });
    await Hub.deleteOne({ _id: hub._id });
    res.json({ message: 'Draft hub deleted.' });
  } catch (err) {
    console.error('Delete hub error:', err);
    res.status(500).json({ message: "We couldn't delete the hub." });
  }
};

// Dashboard dates use South African time (UTC+2, no daylight saving)
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const startOfSastDay = (dateString) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString || '');
  const base = match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : Math.floor((Date.now() + SAST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return new Date(base - SAST_OFFSET_MS);
};
const sastDateLabel = (date) => new Date(date.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
const change = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);

// GET /api/hubs/:id/dashboard?date=YYYY-MM-DD
exports.getHubDashboard = async (req, res) => {
  try {
    const hubId = req.params.id === 'mine' ? req.user.hub : req.params.id;
    if (!isObjectId(hubId)) return res.status(404).json({ message: 'Hub not found.' });
    const hub = await Hub.findById(hubId).populate('parent', 'name hubCode level').lean();
    if (!hub || !canSeeHub(req.user, hub)) return res.status(404).json({ message: 'Hub not found.' });
    const permissions = await loadPermissions(req);

    const today = startOfSastDay(req.query.date);
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const yesterday = new Date(today.getTime() - DAY_MS);
    const weekStart = new Date(tomorrow.getTime() - 7 * DAY_MS);
    const prevWeekStart = new Date(weekStart.getTime() - 7 * DAY_MS);
    const monthStart = new Date(tomorrow.getTime() - 30 * DAY_MS);
    const inScope = { hubPath: hub._id };
    const between = (field, from, to) => ({ [field]: { $gte: from, $lt: to } });
    const count = (extra) => Shipment.countDocuments({ ...inScope, ...extra });

    const [
      totalWeek, totalPrevWeek, dispatchedToday, dispatchedYesterday, completedToday, completedYesterday,
      returnsWeek, returnsPrevWeek, pendingDispatch, trendRows, children, recent, driverRows, revenueRows, teamCount,
    ] = await Promise.all([
      count(between('createdAt', weekStart, tomorrow)),
      count(between('createdAt', prevWeekStart, weekStart)),
      count(between('dispatchedAt', today, tomorrow)),
      count(between('dispatchedAt', yesterday, today)),
      count(between('deliveredAt', today, tomorrow)),
      count(between('deliveredAt', yesterday, today)),
      count(between('returnedAt', weekStart, tomorrow)),
      count(between('returnedAt', prevWeekStart, weekStart)),
      count({ status: { $in: Shipment.PENDING_DISPATCH_STATUSES } }),
      Shipment.aggregate([
        { $match: { ...inScope, $or: [between('createdAt', weekStart, tomorrow), between('dispatchedAt', weekStart, tomorrow), between('deliveredAt', weekStart, tomorrow)] } },
        { $project: { createdAt: 1, dispatchedAt: 1, deliveredAt: 1 } },
      ]),
      Hub.find({ parent: hub._id }).select('name hubCode level status').sort({ name: 1 }).lean(),
      Shipment.find(inScope).sort({ updatedAt: -1 }).limit(8).select('shipmentId status updatedAt createdAt receiverName hub').populate('hub', 'name').lean(),
      Shipment.aggregate([
        { $match: { ...inScope, driver: { $ne: null }, updatedAt: { $gte: weekStart } } },
        { $group: { _id: '$driver', onDelivery: { $max: { $cond: [{ $in: ['$status', ['Out For Delivery', 'Out for Delivery']] }, 1, 0] } } } },
      ]),
      permissions.includes('revenue.view')
        ? Shipment.aggregate([
          { $match: { ...inScope, 'payment.status': 'paid', createdAt: { $gte: monthStart, $lt: tomorrow } } },
          { $group: { _id: { $gte: ['$createdAt', today] }, total: { $sum: '$payment.amount' }, count: { $sum: 1 } } },
        ])
        : Promise.resolve(null),
      User.countDocuments({ hub: hub._id }),
    ]);

    const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS));
    const dayIndex = (date) => (date ? Math.floor((new Date(date).getTime() - weekStart.getTime()) / DAY_MS) : -1);
    const trend = days.map((day) => ({ date: sastDateLabel(day), booked: 0, dispatched: 0, completed: 0 }));
    trendRows.forEach((row) => {
      [['createdAt', 'booked'], ['dispatchedAt', 'dispatched'], ['deliveredAt', 'completed']].forEach(([field, key]) => {
        const i = dayIndex(row[field]);
        if (i >= 0 && i < 7) trend[i][key] += 1;
      });
    });

    const childIds = children.map((c) => c._id);
    const childStats = childIds.length
      ? await Shipment.aggregate([
        { $match: { hubPath: { $in: childIds } } },
        { $unwind: '$hubPath' },
        { $match: { hubPath: { $in: childIds } } },
        { $group: { _id: '$hubPath', today: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', today] }, { $lt: ['$createdAt', tomorrow] }] }, 1, 0] } }, lastActivity: { $max: '$updatedAt' } } },
      ])
      : [];
    const statsById = new Map(childStats.map((s) => [String(s._id), s]));

    let revenue = null;
    if (revenueRows) {
      const todayRow = revenueRows.find((r) => r._id === true) || { total: 0, count: 0 };
      const total30 = revenueRows.reduce((sum, r) => sum + r.total, 0);
      revenue = { today: todayRow.total, last30Days: total30, paidShipments30Days: revenueRows.reduce((sum, r) => sum + r.count, 0) };
    }

    res.json({
      hub: { ...publicHub(hub), parentName: hub.parent?.name || null },
      date: sastDateLabel(today),
      cards: {
        totalParcels: { value: totalWeek, change: change(totalWeek, totalPrevWeek), compare: 'vs previous 7 days' },
        dispatchedToday: { value: dispatchedToday, change: change(dispatchedToday, dispatchedYesterday), compare: 'vs yesterday' },
        completedToday: { value: completedToday, change: change(completedToday, completedYesterday), compare: 'vs yesterday' },
        returns: { value: returnsWeek, change: change(returnsWeek, returnsPrevWeek), compare: 'last 7 days' },
        pendingDispatch: { value: pendingDispatch, change: null, compare: 'waiting now' },
      },
      trend,
      children: children.map((child) => ({
        ...publicHub(child),
        todayShipments: statsById.get(String(child._id))?.today || 0,
        lastActivity: statsById.get(String(child._id))?.lastActivity || null,
      })),
      drivers: { active7Days: driverRows.length, onDelivery: driverRows.filter((d) => d.onDelivery).length },
      recentActivity: recent.map((s) => ({
        shipmentId: s.shipmentId,
        status: s.status,
        at: s.updatedAt,
        hubName: s.hub?.name || null,
      })),
      revenue,
      teamCount,
    });
  } catch (err) {
    console.error('Hub dashboard error:', err);
    res.status(500).json({ message: "We couldn't load the dashboard." });
  }
};

exports._test = { nextHubCode, startOfSastDay };
