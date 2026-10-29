// Phase 1: hubs, team logins, tick-box permissions and hub areas, run against the real Express app.
// Needs a throwaway MongoDB: MONGO_TEST_URI=mongodb://127.0.0.1:27099/shipday_phase1_test node --test tests/hubs-team.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const uri = process.env.MONGO_TEST_URI ? process.env.MONGO_TEST_URI.replace(/\/[^/]*$/, '/shipday_phase1_test') : null;
const skip = !uri && 'MONGO_TEST_URI not set';

process.env.MONGO_URI = uri || 'mongodb://127.0.0.1:1/unused';
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'https://app.example.co.za';

// Capture emails instead of sending them
const mails = [];
require.cache[require.resolve('../utils/mail')] = {
  id: require.resolve('../utils/mail'), filename: require.resolve('../utils/mail'), loaded: true,
  exports: async (to, subject, text) => { mails.push({ to, subject, text }); },
};

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Token = require('../models/Token');
const Hub = require('../models/Hub');
const Shipment = require('../models/Shipment');
const VerificationCode = require('../models/VerificationCode');
const { clearCache } = require('../services/permissionService');

let base;
let server;
let seq = 0;

const tokenFor = async (user) => {
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET);
  await Token.create({ userId: user._id, token });
  return token;
};

const signIn = async (fields) => {
  seq += 1;
  const user = await User.create({
    email: `member${seq}@test.co.za`, password: 'x', fullName: `Member ${seq}`, phone: '0830000000', customerId: `T${seq}`, ...fields,
  });
  return { user, token: await tokenFor(user) };
};

const call = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json };
};

const HOURS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  .map((day) => (day === 'Sunday' ? { day, closed: true } : { day, open: '08:00', close: '17:00' }));

const hubForm = (fields = {}) => {
  seq += 1;
  return {
    name: `Hub ${seq}`,
    level: 'Regional',
    province: 'Gauteng',
    manager: { name: 'Thabo Mokoena', email: `manager${seq}@hub.co.za`, cell: '082 123 4567' },
    address: { street: '37 Main Road', suburb: 'Eastleigh', city: 'Edenvale', postalCode: '1609' },
    operatingHours: HOURS,
    administrator: { name: `Admin ${seq}`, email: `admin${seq}@hub.co.za`, phone: '+27 82 555 0101', sendLogin: true },
    services: ['Parcel Drop-off', 'Final-Mile Delivery'],
    status: 'Active',
    ...fields,
  };
};

const lastLinkTo = (email) => {
  const mail = [...mails].reverse().find((m) => m.to === email);
  const match = mail && /set-password\?token=([^\s]+)/.exec(mail.text);
  return match ? decodeURIComponent(match[1]) : null;
};

const makeShipment = (fields = {}) => {
  seq += 1;
  return Shipment.create({
    shipmentId: `SHPT-P1-${seq}`,
    senderDetails: { fullName: 'Nomsa Sender', email: `sender${seq}@mail.co.za`, mobile: '0821112222', address: { street: '1 Long St', city: 'Edenvale', province: 'Gauteng' } },
    deliveryDetails: { receiverName: 'Sipho Receiver', email: 'receiver@mail.co.za', mobile: '0823334444', address: { street: '9 Oak Ave', city: 'Sandton', province: 'Gauteng' } },
    parcelDetails: { serviceType: 'economy' },
    payment: { method: 'ewallet', status: 'paid', amount: 120 },
    ...fields,
  });
};

test.describe('phase 1 hubs, team and permissions', { skip }, () => {
  let superAdmin;
  let admin;
  let gauteng;
  let edenvale;
  let pretoria;
  let regionalManager;
  let edenvaleManager;
  let pretoriaManager;

  test.before(async () => {
    await mongoose.connect(uri);
    await mongoose.connection.dropDatabase();
    await Promise.all([User.init(), Hub.init(), Shipment.init()]);
    const app = require('../app');
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
    superAdmin = await signIn({ role: 'Super Admin' });
    admin = await signIn({ role: 'Admin' });
  });

  test.after(async () => {
    server?.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('regional hubs: one per province, code made automatically, administrator gets a login email', async () => {
    const created = await call('POST', '/hubs', { token: superAdmin.token, body: hubForm({ name: 'Gauteng Regional Hub' }) });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    gauteng = created.json.hub;
    assert.equal(gauteng.hubCode, 'RH-GP-0001');
    assert.equal(gauteng.status, 'Active');
    assert.equal(created.json.inviteSent, true);

    const login = await User.findById(gauteng.administrator.user);
    assert.equal(login.role, 'Regional Manager');
    assert.equal(String(login.hub), String(gauteng._id));
    assert.equal(login.phone, '0825550101');
    assert.ok(lastLinkTo(login.email), 'invite email has a set-password link');

    const second = await call('POST', '/hubs', { token: superAdmin.token, body: hubForm({ province: 'GP' }) });
    assert.equal(second.status, 400);
    assert.match(second.json.errors.province, /already has a Regional Hub/);
  });

  test('form checks: parent level, province of the address, hours and services', async () => {
    const noParent = await call('POST', '/hubs', { token: superAdmin.token, body: hubForm({ level: 'SubRegion' }) });
    assert.equal(noParent.status, 400);
    assert.ok(noParent.json.errors.parent);

    const wrongParent = await call('POST', '/hubs', { token: superAdmin.token, body: hubForm({ level: 'Retail', parent: gauteng._id }) });
    assert.match(wrongParent.json.errors.parent, /Sub-Region Hub/);

    const bad = await call('POST', '/hubs', {
      token: superAdmin.token,
      body: hubForm({
        level: 'SubRegion', parent: gauteng._id, services: [],
        address: { street: '1 Rd', suburb: 'Sea Point', city: 'Cape Town', province: 'Western Cape', postalCode: '8005' },
        operatingHours: [{ day: 'Monday', open: '17:00', close: '08:00' }],
      }),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.errors['address.province'], /Gauteng/);
    assert.ok(bad.json.errors.services);
    assert.match(bad.json.errors['hours.Monday'], /after opening/);
    assert.ok(bad.json.errors['hours.Tuesday'], 'days with no times must be marked closed');
  });

  test('sub-region hubs take their province and place from the Regional Hub', async () => {
    const res = await call('POST', '/hubs', { token: superAdmin.token, body: hubForm({ name: 'Edenvale DC', level: 'SubRegion', parent: gauteng._id, province: 'Limpopo' }) });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    edenvale = res.json.hub;
    assert.equal(edenvale.province, 'Gauteng');
    assert.equal(edenvale.hubCode, 'SR-GP-0001');
    assert.deepEqual(edenvale.ancestors.map(String), [String(gauteng._id)]);

    const other = await call('POST', '/hubs', { token: superAdmin.token, body: hubForm({ name: 'Pretoria DC', level: 'SubRegion', parent: gauteng._id }) });
    pretoria = other.json.hub;

    regionalManager = { user: await User.findById(gauteng.administrator.user) };
    regionalManager.token = await tokenFor(regionalManager.user);
    edenvaleManager = { user: await User.findById(edenvale.administrator.user) };
    edenvaleManager.token = await tokenFor(edenvaleManager.user);
    pretoriaManager = { user: await User.findById(pretoria.administrator.user) };
    pretoriaManager.token = await tokenFor(pretoriaManager.user);
    assert.equal(edenvaleManager.user.role, 'Sub-Region Manager');
  });

  test('only the Super Admin approves; hub logins wait for approval, then work after setting a password', async () => {
    const sent = mails.length;
    const draft = await call('POST', '/hubs', {
      token: edenvaleManager.token,
      body: hubForm({ name: 'Greenstone Hub', level: 'Retail', parent: edenvale._id, status: 'Active' }),
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    assert.equal(draft.json.hub.status, 'Pending Approval', 'hub managers cannot make a hub active');
    assert.equal(mails.length, sent, 'no login email before approval');
    const retail = draft.json.hub;
    const adminEmail = retail.administrator.email;

    // The login exists but can't be used yet
    const adminUser = await User.findById(retail.administrator.user);
    adminUser.password = await require('bcryptjs').hash('Strong#Pass1', 10);
    await adminUser.save();
    const early = await call('POST', '/auth/login', { body: { email: adminEmail, password: 'Strong#Pass1' } });
    assert.equal(early.status, 403);
    assert.match(early.json.message, /waiting for approval/);

    const byAdmin = await call('POST', `/hubs/${retail._id}/status`, { token: admin.token, body: { action: 'approve' } });
    assert.equal(byAdmin.status, 403, 'Admins cannot approve hubs');
    const byManager = await call('POST', `/hubs/${retail._id}/status`, { token: edenvaleManager.token, body: { action: 'approve' } });
    assert.equal(byManager.status, 403);

    const approved = await call('POST', `/hubs/${retail._id}/status`, { token: superAdmin.token, body: { action: 'approve' } });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.hub.status, 'Active');
    const link = lastLinkTo(adminEmail);
    assert.ok(link, 'login email sent on approval');

    const weak = await call('POST', '/auth/set-password', { body: { token: link, password: 'short' } });
    assert.equal(weak.status, 400);
    const set = await call('POST', '/auth/set-password', { body: { token: link, password: 'New#Password9' } });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    const reused = await call('POST', '/auth/set-password', { body: { token: link, password: 'Other#Password9' } });
    assert.equal(reused.status, 400, 'a link works once');

    const ok = await call('POST', '/auth/login', { body: { email: adminEmail, password: 'New#Password9' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.role, 'Retail Hub Manager');
    assert.ok(ok.json.user.permissions.includes('dashboard.hub'));
    assert.ok(!ok.json.user.permissions.includes('hubs.approve'));

    // Suspending signs the hub's team out and stops new sign-ins
    const noReason = await call('POST', `/hubs/${retail._id}/status`, { token: edenvaleManager.token, body: { action: 'suspend' } });
    assert.equal(noReason.status, 400);
    const suspended = await call('POST', `/hubs/${retail._id}/status`, { token: edenvaleManager.token, body: { action: 'suspend', reason: 'Lease ended' } });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.json));
    const after = await call('POST', '/auth/login', { body: { email: adminEmail, password: 'New#Password9' } });
    assert.equal(after.status, 403);
    assert.match(after.json.message, /suspended/);
    assert.equal(await Token.countDocuments({ userId: adminUser._id }), 0);
    const ownHub = await call('POST', `/hubs/${edenvale._id}/status`, { token: edenvaleManager.token, body: { action: 'suspend', reason: 'x' } });
    assert.equal(ownHub.status, 403, 'hub managers cannot suspend their own hub');
  });

  test('hub users only see and add hubs in their own area', async () => {
    const mine = await call('GET', '/hubs', { token: edenvaleManager.token });
    assert.equal(mine.status, 200);
    const names = mine.json.hubs.map((h) => h.name);
    assert.ok(names.includes('Edenvale DC') && names.includes('Greenstone Hub'));
    assert.ok(!names.includes('Pretoria DC') && !names.includes('Gauteng Regional Hub'));

    const regional = await call('GET', '/hubs', { token: regionalManager.token });
    assert.ok(regional.json.hubs.some((h) => h.name === 'Pretoria DC'));

    const elsewhere = await call('POST', '/hubs', { token: edenvaleManager.token, body: hubForm({ level: 'Retail', parent: pretoria._id }) });
    assert.equal(elsewhere.status, 400);
    assert.match(elsewhere.json.errors.parent, /your own area/);

    const hidden = await call('GET', `/hubs/${pretoria._id}`, { token: edenvaleManager.token });
    assert.equal(hidden.status, 404);

    const customer = await signIn({ role: 'Customer' });
    assert.equal((await call('GET', '/hubs', { token: customer.token })).status, 403);
  });

  test("shipments: a hub's own area in full, other hubs with customer name and order details only", async () => {
    const booked = await call('POST', '/shipments', {
      token: edenvaleManager.token,
      body: {
        senderDetails: { fullName: 'Counter Customer', email: 'counter@mail.co.za', mobile: '0821234567', address: { street: '1 A St', suburb: 'B', city: 'Edenvale', province: 'Gauteng', postalCode: '1609' } },
        collectionDetails: { address: { street: '1 A St', suburb: 'B', city: 'Edenvale', province: 'Gauteng', postalCode: '1609' } },
        deliveryDetails: { receiverName: 'R', mobile: '0821234568', address: { street: '2 C St', suburb: 'D', city: 'Pretoria', province: 'Gauteng', postalCode: '0002' } },
        parcelDetails: { serviceType: 'economy', parcelType: 'parcel', dimensions: { length: 10, width: 10, height: 10, weight: 1 } },
        payment: { method: 'ewallet' },
      },
    });
    assert.ok([200, 201].includes(booked.status), JSON.stringify(booked.json));
    const saved = await Shipment.findOne({ 'senderDetails.email': 'counter@mail.co.za' });
    assert.equal(String(saved.hub), String(edenvale._id));
    assert.deepEqual(saved.hubPath.map(String), [String(gauteng._id), String(edenvale._id)]);

    // Shipments booked elsewhere go to the Regional Hub of the collection province
    const online = await makeShipment({ collectionDetails: { address: { province: 'gauteng' } } });
    assert.equal(String(online.hub), String(gauteng._id));
    const pretoriaShipment = await makeShipment({ hub: pretoria._id });
    assert.deepEqual(pretoriaShipment.hubPath.map(String), [String(gauteng._id), String(pretoria._id)]);

    const ownList = await call('GET', '/shipments', { token: edenvaleManager.token });
    const ownIds = ownList.json.map((s) => s.shipmentId);
    assert.ok(ownIds.includes(saved.shipmentId));
    assert.ok(!ownIds.includes(pretoriaShipment.shipmentId));
    assert.ok(!ownIds.includes(online.shipmentId), 'the Regional Hub level is above a sub-region');

    const regionalList = await call('GET', '/shipments', { token: regionalManager.token });
    assert.ok(regionalList.json.some((s) => s.shipmentId === pretoriaShipment.shipmentId));

    const all = await call('GET', '/shipments?scope=all', { token: edenvaleManager.token });
    const other = all.json.find((s) => s.shipmentId === pretoriaShipment.shipmentId);
    assert.ok(other, 'other hubs are listed with scope=all');
    assert.equal(other.limitedView, true);
    assert.equal(other.senderDetails.fullName, 'Nomsa Sender');
    assert.equal(other.senderDetails.email, undefined);
    assert.equal(other.senderDetails.mobile, undefined);
    assert.equal(other.senderDetails.address.street, undefined);
    assert.equal(other.senderDetails.address.city, 'Edenvale');
    assert.equal(other.payment.amount, 120);

    const detail = await call('GET', `/shipments/${pretoriaShipment.shipmentId}`, { token: edenvaleManager.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.shipment.deliveryDetails.mobile, undefined);
    assert.equal(detail.json.shipment.limitedView, true);
    const waybill = await call('GET', `/shipments/${pretoriaShipment.shipmentId}/waybill`, { token: edenvaleManager.token });
    assert.equal(waybill.status, 404, 'no downloads for other hubs');

    const edit = await call('PUT', `/shipments/${pretoriaShipment.shipmentId}`, { token: edenvaleManager.token, body: { status: 'Delivered' } });
    assert.equal(edit.status, 404, "cannot change another hub's shipment");
    const ownEdit = await call('PUT', `/shipments/${saved.shipmentId}`, { token: edenvaleManager.token, body: { status: 'In Transit' } });
    assert.equal(ownEdit.status, 200);
    assert.ok((await Shipment.findById(saved._id)).dispatchedAt, 'dispatch time recorded');

    const metrics = await call('GET', '/shipments/metrics', { token: edenvaleManager.token });
    assert.equal(metrics.status, 403, 'company-wide figures are head office only');
  });

  test('hub dashboard counts the hub area and hides revenue without the permission', async () => {
    const dash = await call('GET', '/hubs/mine/dashboard', { token: edenvaleManager.token });
    assert.equal(dash.status, 200, JSON.stringify(dash.json));
    assert.equal(dash.json.hub.name, 'Edenvale DC');
    assert.equal(dash.json.cards.totalParcels.value, 1);
    assert.equal(dash.json.cards.dispatchedToday.value, 1);
    assert.equal(dash.json.trend.length, 7);
    assert.ok(dash.json.children.some((c) => c.name === 'Greenstone Hub'));
    assert.ok(dash.json.revenue, 'sub-region managers see their own revenue');

    const regional = await call('GET', `/hubs/${gauteng._id}/dashboard`, { token: regionalManager.token });
    assert.equal(regional.json.cards.totalParcels.value, 3);
    const otherHub = await call('GET', `/hubs/${pretoria._id}/dashboard`, { token: edenvaleManager.token });
    assert.equal(otherHub.status, 404);

    const staff = await signIn({ role: 'Hub Staff', hub: edenvale._id });
    const staffDash = await call('GET', '/hubs/mine/dashboard', { token: staff.token });
    assert.equal(staffDash.status, 200);
    assert.equal(staffDash.json.revenue, null, 'Hub Staff have no revenue permission by default');
  });

  test('team: hub managers add people below them, in their area only; disabling signs them out', async () => {
    const greenstone = await Hub.findOne({ name: 'Greenstone Hub' });
    const roles = await call('GET', '/team', { token: edenvaleManager.token });
    assert.deepEqual(roles.json.assignableRoles, ['Retail Hub Manager', 'Hub Staff']);

    const asAdmin = await call('POST', '/team', { token: edenvaleManager.token, body: { fullName: 'X', email: 'x@shipday.co.za', phone: '0821110000', role: 'Admin' } });
    assert.equal(asAdmin.status, 400);
    const outside = await call('POST', '/team', { token: edenvaleManager.token, body: { fullName: 'Y', email: 'y@shipday.co.za', phone: '0821110000', role: 'Hub Staff', hub: pretoria._id } });
    assert.equal(outside.status, 400);
    assert.match(outside.json.message, /your area/);
    const wrongLevel = await call('POST', '/team', { token: superAdmin.token, body: { fullName: 'Z', email: 'z@shipday.co.za', phone: '0821110000', role: 'Regional Manager', hub: edenvale._id } });
    assert.match(wrongLevel.json.message, /Regional Hub/);

    const added = await call('POST', '/team', {
      token: edenvaleManager.token,
      body: { fullName: 'Lerato Phiri', email: 'Lerato@ShipDay.co.za', phone: '072 555 1234', role: 'Hub Staff', hub: edenvale._id, jobTitle: 'Counter clerk' },
    });
    assert.equal(added.status, 201, JSON.stringify(added.json));
    assert.equal(added.json.member.loginStatus, 'Invite sent');
    assert.ok(lastLinkTo('lerato@shipday.co.za'));

    const toSuspended = await call('POST', '/team', { token: edenvaleManager.token, body: { fullName: 'W', email: 'w@shipday.co.za', phone: '0821110000', role: 'Hub Staff', hub: greenstone._id } });
    assert.equal(toSuspended.status, 201);
    assert.match(toSuspended.json.message, /when Greenstone Hub is approved/);

    const list = await call('GET', '/team', { token: edenvaleManager.token });
    assert.ok(list.json.members.every((m) => ['Edenvale DC', 'Greenstone Hub'].includes(m.hub?.name)));
    assert.ok(!list.json.members.some((m) => m.email === pretoriaManager.user.email));

    const member = await User.findOne({ email: 'lerato@shipday.co.za' });
    const memberToken = await tokenFor(member);
    const disabled = await call('PATCH', `/team/${member._id}`, { token: edenvaleManager.token, body: { status: 'Disabled' } });
    assert.equal(disabled.status, 200);
    assert.equal((await call('GET', '/hubs/mine/dashboard', { token: memberToken })).status, 401);

    const regionalSelf = await call('PATCH', `/team/${regionalManager.user._id}`, { token: edenvaleManager.token, body: { status: 'Disabled' } });
    assert.equal(regionalSelf.status, 404, 'cannot touch people above or outside their area');
  });

  test('tick-box permissions: Super Admin only, saved per role, locked ones stay with the Super Admin', async () => {
    assert.equal((await call('GET', '/permissions', { token: admin.token })).status, 403);
    const grid = await call('GET', '/permissions', { token: superAdmin.token });
    assert.equal(grid.status, 200);
    assert.ok(grid.json.roles.some((r) => r.role === 'Hub Staff' && r.isDefault));

    const staff = await signIn({ role: 'Hub Staff', hub: edenvale._id });
    assert.equal((await call('GET', '/shipments', { token: staff.token })).status, 200);

    const saved = await call('PUT', '/permissions/Hub Staff', { token: superAdmin.token, body: { permissions: ['dashboard.hub', 'hubs.approve', 'roles.manage', 'made.up'] } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.permissions, ['dashboard.hub']);
    clearCache();
    assert.equal((await call('GET', '/shipments', { token: staff.token })).status, 403, 'unticked permission is refused by the server');

    const access = await call('GET', '/auth/access', { token: staff.token });
    assert.deepEqual(access.json.permissions, ['dashboard.hub']);
    assert.equal(access.json.hub.name, 'Edenvale DC');

    const reset = await call('PUT', '/permissions/Hub Staff', { token: superAdmin.token, body: { reset: true } });
    assert.ok(reset.json.permissions.includes('shipments.view'));
    assert.equal((await call('PUT', '/permissions/Super Admin', { token: superAdmin.token, body: { permissions: [] } })).status, 400);
  });

  test('money: Accounts Manager sees revenue and adjusts wallets; hub teams do not', async () => {
    const accounts = await signIn({ role: 'Accounts Manager' });
    assert.equal((await call('GET', '/transactions/total-revenue', { token: accounts.token })).status, 200);
    assert.equal((await call('GET', '/transactions/total-revenue', { token: regionalManager.token })).status, 403);
    const customer = await signIn({ role: 'Customer' });
    const credit = await call('POST', '/wallets/transaction', { token: accounts.token, body: { userId: customer.user._id, type: 'credit', amount: 50, description: 'Goodwill' } });
    assert.ok([200, 201].includes(credit.status), JSON.stringify(credit.json));
    const hubCredit = await call('POST', '/wallets/transaction', { token: regionalManager.token, body: { userId: customer.user._id, type: 'credit', amount: 50 } });
    assert.equal(hubCredit.status, 403);
  });

  test('forgot password needs the emailed code; five wrong guesses use the code up', async () => {
    const person = await signIn({ role: 'Customer', email: 'forgetful@mail.co.za' });
    const blind = await call('POST', '/auth/reset-password', { body: { email: 'forgetful@mail.co.za', newPassword: 'Hijack#Pass1' } });
    assert.equal(blind.status, 400, 'an email address alone no longer resets a password');

    await VerificationCode.create({ email: 'forgetful@mail.co.za', code: 'AB12C', expiresAt: new Date(Date.now() + 60000) });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const wrong = await call('POST', '/verification/verify-code', { body: { email: 'forgetful@mail.co.za', code: 'ZZZZZ' } });
      assert.equal(wrong.status, 400);
    }
    const locked = await call('POST', '/verification/verify-code', { body: { email: 'forgetful@mail.co.za', code: 'AB12C' } });
    assert.equal(locked.status, 400, 'the right code no longer works after five wrong guesses');

    await VerificationCode.create({ email: 'forgetful@mail.co.za', code: 'QW34E', expiresAt: new Date(Date.now() + 60000) });
    const verified = await call('POST', '/verification/verify-code', { body: { email: 'forgetful@mail.co.za', code: 'qw34e' } });
    assert.equal(verified.status, 200);
    const reset = await call('POST', '/auth/reset-password', { body: { email: 'forgetful@mail.co.za', newPassword: 'Fresh#Pass12', resetToken: verified.json.resetToken } });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.equal(await Token.countDocuments({ userId: person.user._id }), 0, 'old sessions signed out');
    const login = await call('POST', '/auth/login', { body: { email: 'forgetful@mail.co.za', password: 'Fresh#Pass12' } });
    assert.equal(login.status, 200);
  });
});
