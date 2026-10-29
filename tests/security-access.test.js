// Phase 0 security checks, run against the real Express app.
// Needs a throwaway MongoDB: MONGO_TEST_URI=mongodb://127.0.0.1:27099/shipday_security_test node --test tests/security-access.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const uri = process.env.MONGO_TEST_URI;
const skip = !uri && 'MONGO_TEST_URI not set';

// Set before app.js loads dotenv, which never overrides existing values
process.env.MONGO_URI = uri || 'mongodb://127.0.0.1:1/unused';
process.env.JWT_SECRET = 'test-secret';
process.env.PAYFAST_MODE = 'sandbox';
process.env.PAYFAST_MERCHANT_ID = '10000100';
process.env.PAYFAST_PASSPHRASE = 'test-passphrase';
process.env.API_URL = 'https://api.example.co.za';
process.env.DRIVER_AUTH = 'warn';

// No real emails
require.cache[require.resolve('../utils/mail')] = {
  id: require.resolve('../utils/mail'), filename: require.resolve('../utils/mail'), loaded: true,
  exports: async () => {},
};

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Token = require('../models/Token');
const Shipment = require('../models/Shipment');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');
const Driver = require('../models/Driver');
const { pfValidSignature, generatePaymentData } = require('../utils/payfast');

const realFetch = global.fetch;
let payfastSays = 'VALID';
global.fetch = async (url, options) => {
  if (String(url).includes('payfast.co.za/eng/query/validate')) {
    return { ok: true, text: async () => payfastSays };
  }
  return realFetch(url, options);
};

let base;
let server;
let seq = 0;

const signIn = async (fields) => {
  seq += 1;
  const user = await User.create({
    email: `person${seq}@test.co.za`, password: 'x', fullName: `Person ${seq}`, phone: `08300000${String(seq).padStart(2, '0')}`, customerId: `S${seq}`, ...fields,
  });
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET);
  await Token.create({ userId: user._id, token });
  return { user, token };
};

const call = async (method, path, { token, body, headers = {}, form } = {}) => {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* PDFs and plain text */ }
  return { status: response.status, json, text };
};

const makeShipment = async (owner, fields = {}) => {
  seq += 1;
  return Shipment.create({
    shipmentId: `SHPT-SEC-${seq}`,
    customer: owner._id,
    senderDetails: { fullName: owner.fullName, email: owner.email },
    parcelDetails: { serviceType: 'economy' },
    payment: { method: 'ewallet', status: 'pending', amount: 150 },
    ...fields,
  });
};

const balance = async (user) => (await Wallet.findOne({ userId: user._id }))?.balance || 0;

test.describe('phase 0 access and payment checks', { skip }, () => {
  let admin;
  let alice;
  let bob;

  test.before(async () => {
    await mongoose.connect(uri);
    await mongoose.connection.dropDatabase();
    await Promise.all([User.init(), Transaction.init(), Shipment.init()]);
    const app = require('../app');
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;

    admin = await signIn({ role: 'Super Admin' });
    alice = await signIn({ role: 'Customer' });
    bob = await signIn({ role: 'Customer' });
  });

  test.after(async () => {
    server?.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    global.fetch = realFetch;
  });

  test('company-wide endpoints need a staff sign-in', async () => {
    const staffOnly = [
      ['GET', '/customers'], ['GET', '/auth/customers'], ['GET', '/orders'], ['GET', '/staff/all'],
      ['GET', '/warehouse/all'], ['GET', '/fleet/all'], ['GET', '/deliveries/stats'], ['GET', '/trackings'],
      ['GET', '/transactions/monthly-revenue'], ['GET', '/shipments/metrics'], ['GET', '/contact'],
    ];
    for (const [method, path] of staffOnly) {
      assert.equal((await call(method, path)).status, 401, `${path} without sign-in`);
      assert.equal((await call(method, path, { token: alice.token })).status, 403, `${path} as a customer`);
    }
    assert.equal((await call('GET', '/customers', { token: admin.token })).status, 200);
    assert.equal((await call('GET', '/contact', { token: admin.token })).status, 200);
  });

  test('public pages still work without signing in', async () => {
    assert.notEqual((await call('GET', '/pricing')).status, 401);
    assert.notEqual((await call('GET', '/shipments/track/NOPE')).status, 401);
    assert.notEqual((await call('POST', '/contact', { body: {} })).status, 401);
  });

  test('a customer can only look up their own account', async () => {
    assert.equal((await call('GET', `/user?email=${alice.user.email}`, { token: alice.token })).status, 200);
    assert.equal((await call('GET', `/user?email=${bob.user.email}`, { token: alice.token })).status, 403);
    assert.equal((await call('GET', `/user/${bob.user._id}`, { token: alice.token })).status, 403);
    assert.equal((await call('GET', `/auth/profile?email=${bob.user.email}`, { token: alice.token })).status, 403);
    const own = await call('GET', `/user/${alice.user._id}`, { token: alice.token });
    assert.equal(own.status, 200);
    assert.equal(own.json.user.password, undefined);
    assert.equal((await call('GET', `/user/${bob.user._id}`, { token: admin.token })).status, 200);
  });

  test('nobody but an admin can credit a wallet', async () => {
    const credit = { userId: String(alice.user._id), type: 'credit', amount: 1000 };
    assert.equal((await call('POST', '/wallets/transaction', { body: credit })).status, 401);
    assert.equal((await call('POST', '/wallets/transaction', { token: alice.token, body: credit })).status, 403);
    assert.equal(await balance(alice.user), 0);

    assert.equal((await call('POST', '/wallets/transaction', { token: admin.token, body: credit })).status, 201);
    assert.equal(await balance(alice.user), 1000);
    const overdraw = await call('POST', '/wallets/transaction', { token: admin.token, body: { ...credit, type: 'debit', amount: 5000 } });
    assert.equal(overdraw.status, 400);
    assert.equal(await balance(alice.user), 1000);

    assert.equal((await call('GET', `/wallets/${alice.user._id}`, { token: alice.token })).status, 200);
    assert.equal((await call('GET', `/wallets/${alice.user._id}`, { token: bob.token })).status, 403);
  });

  test('pay with wallet always charges the signed-in customer', async () => {
    await Wallet.findOneAndUpdate({ userId: bob.user._id }, { balance: 500 }, { upsert: true });
    const bobsShipment = await makeShipment(bob.user);

    // Alice can't pay for Bob's shipment, or charge Bob's wallet by naming him
    const attempt = await call('POST', '/payments/wallet', { token: alice.token, body: { shipmentId: bobsShipment._id, userId: bob.user._id } });
    assert.equal(attempt.status, 404);
    assert.equal(await balance(bob.user), 500);

    // Alice pays for her own shipment from her own wallet, even if she names Bob
    const alicesShipment = await makeShipment(alice.user);
    const paid = await call('POST', '/payments/wallet', { token: alice.token, body: { shipmentId: alicesShipment._id, userId: bob.user._id } });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(await balance(alice.user), 850);
    assert.equal(await balance(bob.user), 500);

    // Paying twice is refused
    assert.equal((await call('POST', '/payments/wallet', { token: alice.token, body: { shipmentId: alicesShipment._id } })).status, 400);
    assert.equal(await balance(alice.user), 850);

    // Not enough money: refused and the shipment stays unpaid
    const big = await makeShipment(bob.user, { payment: { method: 'ewallet', status: 'pending', amount: 9999 } });
    assert.equal((await call('POST', '/payments/wallet', { token: bob.token, body: { shipmentId: big._id } })).status, 400);
    assert.equal((await Shipment.findById(big._id)).payment.status, 'pending');
  });

  test('shipment details, edits, waybills and POD are limited to people on the shipment', async () => {
    const shipment = await makeShipment(alice.user);
    for (const path of [`/shipments/${shipment.shipmentId}`, `/shipments/${shipment.shipmentId}/waybill`, `/admin/shipments/${shipment.shipmentId}/pod`]) {
      assert.equal((await call('GET', path)).status, 401, path);
      assert.equal((await call('GET', path, { token: bob.token })).status, 404, path);
    }
    assert.equal((await call('GET', `/shipments/${shipment.shipmentId}`, { token: alice.token })).status, 200);
    assert.equal((await call('GET', `/shipments/${shipment.shipmentId}/waybill`, { token: alice.token })).status, 200);
    assert.equal((await call('GET', `/shipments/${shipment.shipmentId}`, { token: admin.token })).status, 200);

    // Customers can't edit (status changes would trigger commission)
    const edit = await call('PUT', `/shipments/${shipment.shipmentId}`, { token: alice.token, body: { status: 'Delivered' } });
    assert.equal(edit.status, 403);
    assert.notEqual((await Shipment.findById(shipment._id)).status, 'Delivered');
  });

  test('notifications are private to each user', async () => {
    await Notification.create({ userId: alice.user._id, title: 'For Alice', message: 'x', type: 'transaction' });
    await Notification.create({ userId: bob.user._id, title: 'For Bob', message: 'x', type: 'transaction' });
    const mine = await call('GET', '/notifications', { token: alice.token });
    assert.ok(mine.json.every((n) => String(n.userId?._id || n.userId) === String(alice.user._id)));
    await call('DELETE', '/notifications/clear-all', { token: alice.token });
    assert.equal(await Notification.countDocuments({ userId: bob.user._id }), 1, "Alice can't clear Bob's");
    assert.equal((await call('POST', '/notifications', { token: alice.token, body: { userId: bob.user._id, title: 't', message: 'm', type: 'order' } })).status, 403);
  });

  test('sandbox confirmation only works in sandbox mode and only for your own payments', async () => {
    const own = `TOPUP-${alice.user._id}-1`;
    const before = await balance(alice.user);

    process.env.PAYFAST_MODE = 'live';
    assert.equal((await call('POST', '/payments/confirm-sandbox', { token: alice.token, body: { mPaymentId: own, amount: 50 } })).status, 403);
    delete process.env.PAYFAST_MODE; // unset no longer means sandbox
    assert.equal((await call('POST', '/payments/confirm-sandbox', { token: alice.token, body: { mPaymentId: own, amount: 50 } })).status, 403);
    process.env.PAYFAST_MODE = 'sandbox';

    assert.equal((await call('POST', '/payments/confirm-sandbox', { body: { mPaymentId: own, amount: 50 } })).status, 401);
    assert.equal((await call('POST', '/payments/confirm-sandbox', { token: bob.token, body: { mPaymentId: own, amount: 50 } })).status, 403);
    assert.equal((await call('POST', '/payments/confirm-sandbox', { token: alice.token, body: { mPaymentId: own, amount: 50 } })).status, 200);
    assert.equal((await call('POST', '/payments/confirm-sandbox', { token: alice.token, body: { mPaymentId: own, amount: 50 } })).status, 200);
    assert.equal(await balance(alice.user), before + 50, 'credited once');

    // A shipment's amount comes from the shipment, not the browser
    const shipment = await makeShipment(alice.user);
    await call('POST', '/payments/confirm-sandbox', { token: alice.token, body: { mPaymentId: String(shipment._id), amount: 1 } });
    const after = await Shipment.findById(shipment._id);
    assert.equal(after.payment.status, 'paid');
    assert.equal(after.payment.amount, 150);
  });

  test('the PayFast notification is checked before any money moves', async () => {
    const PAYFAST_IP = '197.97.145.150';
    const itn = (fields) => {
      const data = { m_payment_id: '', pf_payment_id: '', payment_status: 'COMPLETE', amount_gross: '100.00', name_first: 'Bob', name_last: 'B', merchant_id: '10000100', ...fields };
      return { ...data, signature: pfValidSignature(data, process.env.PAYFAST_PASSPHRASE) };
    };
    const send = (form, ip = PAYFAST_IP) => call('POST', '/payments/notify', { form, headers: { 'X-Forwarded-For': ip } });
    const topUp = (n) => itn({ m_payment_id: `TOPUP-${bob.user._id}-${n}`, pf_payment_id: `PF-${n}` });
    const start = await balance(bob.user);

    assert.equal((await send({ ...topUp(1), signature: 'forged' })).status, 400, 'bad signature');
    assert.equal((await send(topUp(1), '8.8.8.8')).status, 400, 'not from PayFast');
    assert.equal((await send(itn({ m_payment_id: `TOPUP-${bob.user._id}-1`, pf_payment_id: 'PF-1', merchant_id: '999' }))).status, 400, 'wrong merchant');
    payfastSays = 'INVALID';
    assert.equal((await send(topUp(1))).status, 400, 'PayFast did not confirm');
    payfastSays = 'VALID';
    assert.equal(await balance(bob.user), start);

    assert.equal((await send(topUp(1))).status, 200);
    assert.equal((await send(topUp(1))).status, 200, 'replay is acknowledged');
    assert.equal(await balance(bob.user), start + 100, 'but credited once');

    const shipment = await makeShipment(bob.user); // R150
    const underpaid = itn({ m_payment_id: shipment.shipmentId, pf_payment_id: 'PF-SHIP-1', amount_gross: '1.00' });
    assert.equal((await send(underpaid)).status, 400, 'amount must match');
    assert.equal((await Shipment.findById(shipment._id)).payment.status, 'pending');
    const correct = itn({ m_payment_id: shipment.shipmentId, pf_payment_id: 'PF-SHIP-2', amount_gross: '150.00' });
    assert.equal((await send(correct)).status, 200);
    assert.equal((await Shipment.findById(shipment._id)).payment.status, 'paid');
  });

  test('the PayFast notify address always ends in /api', () => {
    process.env.API_URL = 'https://shipday-be.example.app';
    const { data } = generatePaymentData({ shipmentId: 'X', senderDetails: { fullName: 'A B', email: 'a@b.co' }, payment: { amount: 1 }, parcelDetails: { serviceType: 'S' } });
    assert.equal(data.notify_url, 'https://shipday-be.example.app/api/payments/notify');
  });

  test('driver app: a signed-in driver only reaches their own data; test tools are staff-only', async () => {
    const make = (n) => Driver.create({ driverId: `DRV-SEC-${n}`, username: `driver${n}`, email: `d${n}@test.co.za`, phone: `07100000${n}`, password: 'x', vehicleType: 'car', vehicleNumber: `CA ${n}`, idProof: 'x', status: 'approved' });
    const d1 = await make(1);
    const d2 = await make(2);
    const t1 = jwt.sign({ id: d1._id, email: d1.email, role: 'driver' }, process.env.JWT_SECRET);

    assert.equal((await call('GET', `/drivers/shipments/${d2.driverId}`, { token: t1 })).status, 403);
    assert.equal((await call('GET', `/drivers/shipments/${d1.driverId}`, { token: t1 })).status, 200);

    const shipment = await makeShipment(alice.user, { driver: d2._id });
    const sneaky = await call('PUT', '/drivers/update-shipment-status', { token: t1, body: { shipmentId: shipment.shipmentId, status: 'Delivered' } });
    assert.equal(sneaky.status, 404);
    assert.notEqual((await Shipment.findById(shipment._id)).status, 'Delivered');

    assert.equal((await call('DELETE', '/drivers/cleanup-login-notifications')).status, 401);
    assert.equal((await call('GET', `/drivers/debug-notifications/${d1.driverId}`, { token: t1 })).status, 401);

    process.env.DRIVER_AUTH = 'enforce';
    assert.equal((await call('GET', `/drivers/shipments/${d1.driverId}`)).status, 401);
    process.env.DRIVER_AUTH = 'warn';
    assert.equal((await call('GET', `/drivers/shipments/${d1.driverId}`)).status, 200, 'warn mode still lets the current app through');
  });
});
