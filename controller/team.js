// Team members with a ShipDay login: head-office staff, hub teams and sales representatives
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Hub = require('../models/Hub');
const Token = require('../models/Token');
const {
  HEAD_OFFICE_ROLES, HUB_ROLES, LEVEL_FOR_ROLE, HUB_LEVEL_LABELS, canonicalRole,
} = require('../config/permissions');
const { isHubUser, isHubRole, hubInScope, sameId } = require('../middleware/access');
const { sendInvite } = require('../services/accountTokens');
const { generateReferralCode, SALES_REP_ROLE } = require('../services/referralService');

const TEAM_ROLES = [...HEAD_OFFICE_ROLES, ...HUB_ROLES, 'Retail Hub', SALES_REP_ROLE];
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const saPhoneRegex = /^0[1-8]\d{8}$/;
const normalizePhone = (phone) => String(phone || '').replace(/[\s().-]/g, '').replace(/^(?:\+27|0027|27)(?=\d{9}$)/, '0');
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

// Hub managers can add people at the levels below them, and Hub Staff at their own hub
const HUB_RANK = { 'Regional Manager': 3, 'Sub-Region Manager': 2, 'Retail Hub Manager': 1, 'Hub Staff': 0 };

// The roles this person can give out
const assignableRoles = (actor) => {
  const role = canonicalRole(actor.role);
  if (role === 'Super Admin') return [...HEAD_OFFICE_ROLES.filter((r) => r !== 'Super Admin'), ...HUB_ROLES, SALES_REP_ROLE];
  if (role === 'Admin') return [...HEAD_OFFICE_ROLES.filter((r) => !['Super Admin', 'Admin'].includes(r)), ...HUB_ROLES, SALES_REP_ROLE];
  if (role === 'Manager') return ['Admin Staff', ...HUB_ROLES];
  if (isHubRole(role)) return HUB_ROLES.filter((r) => HUB_RANK[r] < HUB_RANK[role] || r === 'Hub Staff');
  return [];
};

// The hubs a hub user looks after (their own and everything below it)
const scopeHubIds = async (actor) => {
  if (!isHubUser(actor)) return null;
  if (!actor.hub) return [];
  const hubs = await Hub.find({ $or: [{ _id: actor.hub }, { ancestors: actor.hub }] }).select('_id');
  return hubs.map((h) => h._id);
};

// Can the actor look after this team member (as they are now)?
const canManageMember = (actor, member, scopeIds) => {
  if (sameId(actor._id, member._id)) return false;
  if (member.role === 'Super Admin') return false;
  if (!assignableRoles(actor).includes(canonicalRole(member.role))) return false;
  if (scopeIds) return Boolean(member.hub) && scopeIds.some((id) => sameId(id, member.hub));
  return true;
};

// Check role + hub: head-office roles have no hub; hub managers need a hub of their level
const checkRoleAndHub = async (actor, role, hubId) => {
  if (!assignableRoles(actor).includes(role)) return { error: `You can't give people the ${role} role.` };
  if (!isHubRole(role)) return { hub: null };
  if (!isObjectId(hubId)) return { error: 'Choose the hub this person works at.' };
  const hub = await Hub.findById(hubId).select('name level status ancestors');
  if (!hub) return { error: 'Choose the hub this person works at.' };
  if (isHubUser(actor) && !hubInScope(actor, hub)) return { error: 'You can only add people to hubs in your area.' };
  const level = LEVEL_FOR_ROLE[role];
  if (level && hub.level !== level) return { error: `A ${role} must be linked to a ${HUB_LEVEL_LABELS[level]}.` };
  return { hub };
};

const nextStaffId = async () => {
  let next = (await User.countDocuments({ customerId: /^STF\d+$/ })) + 1;
  while (await User.exists({ customerId: `STF${String(next).padStart(3, '0')}` })) next += 1;
  return `STF${String(next).padStart(3, '0')}`;
};

const nextRepId = async () => {
  let next = (await User.countDocuments({ customerId: /^REP\d+$/ })) + 1;
  while (await User.exists({ customerId: `REP${String(next).padStart(3, '0')}` })) next += 1;
  return `REP${String(next).padStart(3, '0')}`;
};

// Accounts made before invitations existed (no createdBy) already have a password
const hasPassword = (member) => Boolean(member.invite?.acceptedAt || !member.createdBy);

const loginStatus = (member) => {
  if (member.status === 'Disabled') return 'Disabled';
  if (hasPassword(member)) return 'Active';
  return member.invite?.sentAt ? 'Invite sent' : 'Not sent';
};

const publicMember = (member, actor, scopeIds) => ({
  _id: member._id,
  staffNumber: member.customerId,
  fullName: member.fullName || '',
  email: member.email,
  phone: member.phone || '',
  role: member.role,
  hub: member.hub && member.hub.name ? { _id: member.hub._id, name: member.hub.name, hubCode: member.hub.hubCode, level: member.hub.level } : null,
  jobTitle: member.employment?.jobTitle || '',
  idOrPassport: member.employment?.idOrPassport || '',
  startDate: member.employment?.startDate || null,
  status: member.status || 'Active',
  loginStatus: loginStatus(member),
  inviteSentAt: member.invite?.sentAt || null,
  createdAt: member.createdAt,
  canManage: canManageMember(actor, member, scopeIds),
});

// GET /api/team
exports.listTeam = async (req, res) => {
  try {
    const scopeIds = await scopeHubIds(req.user);
    const filter = { role: { $in: TEAM_ROLES } };
    if (scopeIds) filter.hub = { $in: scopeIds };
    if (TEAM_ROLES.includes(req.query.role)) filter.role = req.query.role;
    if (isObjectId(req.query.hub)) {
      if (scopeIds && !scopeIds.some((id) => sameId(id, req.query.hub))) return res.json({ members: [], assignableRoles: assignableRoles(req.user) });
      filter.hub = req.query.hub;
    } else if (req.query.hub === 'none' && !scopeIds) {
      filter.hub = null;
    }
    if (['Active', 'Disabled'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.search) {
      const pattern = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ fullName: pattern }, { email: pattern }, { phone: pattern }, { customerId: pattern }];
    }

    const members = await User.find(filter)
      .select('customerId fullName email phone role hub employment status invite createdBy createdAt')
      .populate('hub', 'name hubCode level')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      members: members.map((m) => publicMember(m, req.user, scopeIds)),
      assignableRoles: assignableRoles(req.user),
    });
  } catch (err) {
    console.error('List team error:', err);
    res.status(500).json({ message: "We couldn't load the team." });
  }
};

const readMemberForm = (body) => {
  const errors = {};
  const fullName = text(body.fullName);
  const email = text(body.email).toLowerCase();
  const phone = normalizePhone(body.phone);
  const role = text(body.role);
  if (!fullName) errors.fullName = 'Enter their full name.';
  if (!emailRegex.test(email)) errors.email = 'Enter their email address.';
  if (!saPhoneRegex.test(phone)) errors.phone = 'Enter a South African cell number, e.g. 082 123 4567.';
  if (!role) errors.role = 'Choose a role.';
  const startDate = body.startDate ? new Date(body.startDate) : null;
  if (startDate && Number.isNaN(startDate.getTime())) errors.startDate = 'Enter a valid start date.';
  const idOrPassport = text(body.idOrPassport).toUpperCase();
  if (idOrPassport && !/^[A-Z0-9]{6,13}$/.test(idOrPassport)) errors.idOrPassport = 'Enter a 13-digit SA ID number or a passport number.';
  return {
    errors,
    data: {
      fullName, email, phone, role, hub: body.hub,
      employment: { jobTitle: text(body.jobTitle), idOrPassport, startDate },
    },
  };
};

const firstError = (res, errors) => res.status(400).json({ message: Object.values(errors)[0], errors });

// POST /api/team — add a team member and email them a link to set their password
exports.addMember = async (req, res) => {
  try {
    const { errors, data } = readMemberForm(req.body);
    if (Object.keys(errors).length) return firstError(res, errors);
    const { error, hub } = await checkRoleAndHub(req.user, data.role, data.hub);
    if (error) return firstError(res, { role: error });
    if (await User.exists({ email: data.email })) return firstError(res, { email: 'That email already has a ShipDay account.' });

    const isRep = data.role === SALES_REP_ROLE;
    const member = new User({
      email: data.email,
      password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
      fullName: data.fullName,
      phone: data.phone,
      role: data.role,
      hub: hub?._id || null,
      employment: data.employment,
      customerId: isRep ? await nextRepId() : await nextStaffId(),
      createdBy: req.user._id,
      profileCompleted: true,
      invite: { sentAt: null, acceptedAt: null },
      ...(isRep ? { repProfile: { commissionActive: false } } : {}),
    });
    if (isRep) member.referralCode = await generateReferralCode(member);
    await member.save();

    // People at a hub that isn't active yet get their email when the hub is approved
    const waitForHub = hub && hub.status !== 'Active';
    let inviteSent = false;
    if (!waitForHub) {
      try {
        await sendInvite(member, { invitedBy: req.user.fullName, hubName: hub?.name });
        inviteSent = true;
      } catch (err) {
        console.error('Team invite failed:', err.message);
      }
    }

    const saved = await User.findById(member._id).populate('hub', 'name hubCode level').lean();
    res.status(201).json({
      message: waitForHub
        ? `${data.fullName} has been added. They'll get their login email when ${hub.name} is approved.`
        : inviteSent
          ? `${data.fullName} has been added. We've emailed them a link to set their password.`
          : `${data.fullName} has been added, but the email didn't send. Use "Resend login" to try again.`,
      inviteSent,
      member: publicMember(saved, req.user, await scopeHubIds(req.user)),
    });
  } catch (err) {
    console.error('Add team member error:', err);
    if (err.code === 11000) return res.status(400).json({ message: 'That email already has a ShipDay account.' });
    res.status(500).json({ message: "We couldn't add this team member." });
  }
};

const loadManagedMember = async (req, res) => {
  if (!isObjectId(req.params.id)) {
    res.status(404).json({ message: 'Team member not found.' });
    return null;
  }
  const member = await User.findById(req.params.id);
  const scopeIds = await scopeHubIds(req.user);
  if (!member || !TEAM_ROLES.includes(member.role) || (scopeIds && !scopeIds.some((id) => sameId(id, member.hub)))) {
    res.status(404).json({ message: 'Team member not found.' });
    return null;
  }
  if (!canManageMember(req.user, member, scopeIds)) {
    res.status(403).json({ message: "You can't change this person's account." });
    return null;
  }
  return { member, scopeIds };
};

// PATCH /api/team/:id
exports.updateMember = async (req, res) => {
  try {
    const loaded = await loadManagedMember(req, res);
    if (!loaded) return;
    const { member, scopeIds } = loaded;

    const merged = {
      fullName: req.body.fullName ?? member.fullName,
      email: req.body.email ?? member.email,
      phone: req.body.phone ?? member.phone,
      role: req.body.role ?? canonicalRole(member.role),
      hub: req.body.hub !== undefined ? req.body.hub : member.hub,
      jobTitle: req.body.jobTitle ?? member.employment?.jobTitle,
      idOrPassport: req.body.idOrPassport ?? member.employment?.idOrPassport,
      startDate: req.body.startDate !== undefined ? req.body.startDate : member.employment?.startDate,
    };
    const { errors, data } = readMemberForm(merged);
    if (Object.keys(errors).length) return firstError(res, errors);
    const { error, hub } = await checkRoleAndHub(req.user, data.role, data.hub);
    if (error) return firstError(res, { role: error });

    if (data.email !== member.email) {
      if (hasPassword(member)) return firstError(res, { email: 'People who have already signed in change their own email address.' });
      if (await User.exists({ email: data.email, _id: { $ne: member._id } })) return firstError(res, { email: 'That email already has a ShipDay account.' });
      member.email = data.email;
    }

    const roleOrHubChanged = data.role !== member.role || String(hub?._id || '') !== String(member.hub || '');
    member.fullName = data.fullName;
    member.phone = data.phone;
    member.role = data.role;
    member.hub = hub?._id || null;
    member.employment = data.employment;

    if (['Active', 'Disabled'].includes(req.body.status)) member.status = req.body.status;
    await member.save();
    // Sign them out so the new role, hub or disabled status takes effect straight away
    if (roleOrHubChanged || member.status === 'Disabled') await Token.deleteMany({ userId: member._id });

    const saved = await User.findById(member._id).populate('hub', 'name hubCode level').lean();
    res.json({ message: member.status === 'Disabled' ? `${member.fullName}'s login has been disabled.` : 'Team member updated.', member: publicMember(saved, req.user, scopeIds) });
  } catch (err) {
    console.error('Update team member error:', err);
    res.status(500).json({ message: "We couldn't update this team member." });
  }
};

// POST /api/team/:id/resend-invite
exports.resendInvite = async (req, res) => {
  try {
    const loaded = await loadManagedMember(req, res);
    if (!loaded) return;
    const { member } = loaded;
    if (member.status === 'Disabled') return res.status(400).json({ message: 'Enable this login before sending it again.' });
    if (hasPassword(member)) return res.status(400).json({ message: 'This person has already set their password. They can use "Forgot password" on the sign-in page.' });
    const hub = member.hub ? await Hub.findById(member.hub).select('name status') : null;
    if (hub && hub.status !== 'Active') return res.status(400).json({ message: `${hub.name} isn't active yet. The login is sent when the hub is approved.` });
    await sendInvite(member, { invitedBy: req.user.fullName, hubName: hub?.name });
    res.json({ message: `Login email sent to ${member.email}.` });
  } catch (err) {
    console.error('Resend invite error:', err);
    res.status(500).json({ message: "We couldn't send the email. Please try again." });
  }
};

exports._test = { assignableRoles };
exports.hasPassword = hasPassword;
