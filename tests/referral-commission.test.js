// Integration tests for the referral & commission programme.
// Needs a throwaway MongoDB: MONGO_TEST_URI=mongodb://127.0.0.1:27099/shipday_test node --test tests/referral-commission.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// Stub outgoing email before any controller loads it
const sentMail = [];
require.cache[require.resolve('../utils/mail')] = {
  id: require.resolve('../utils/mail'), filename: require.resolve('../utils/mail'), loaded: true,
  exports: async (to, subject, text) => { sentMail.push({ to, subject, text }); },
};

const uri = process.env.MONGO_TEST_URI;
const skip = !uri && 'MONGO_TEST_URI not set';

const User = require('../models/User');
const Shipment = require('../models/Shipment');
const Wallet = require('../models/Wallet');
const Earning = require('../models/Earning');
const Payout = require('../models/Payout');
const MarketingSettings = require('../models/MarketingSettings');
const { handleShipmentDelivered, resolveReferrer, reverseEarning, generateReferralCode } = require('../services/referralService');
const { refreshShipmentCustomerActivation } = require('../services/marketingActivationService');

let seq = 0;
const makeUser = async (fields) => {
  seq += 1;
  return User.create({ email: `user${seq}@test.co.za`, password: 'x', fullName: `Test User${seq}`, phone: `08200000${String(seq).padStart(2, '0')}`, customerId: `T${seq}`, ...fields });
};
const makeShipment = async (customer, status = 'Delivered') => {
  seq += 1;
  return Shipment.create({ shipmentId: `SHPT${seq}`, customer: customer._id, status, senderDetails: { email: customer.email } });
};
const balance = async (user) => (await Wallet.findOne({ userId: user._id }))?.balance || 0;
const activated = { status: 'Activated', topUpAmount: 1000, successfulShipments: 5 };

const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test.describe('referral and commission programme', { skip }, () => {
  test.before(async () => {
    await mongoose.connect(uri);
    await mongoose.connection.dropDatabase();
    await Promise.all([User.init(), Earning.init(), Shipment.init()]);
    await MarketingSettings.create({ repCommissionAmount: 10, customerReferralReward: 5, minimumPayoutAmount: 20, minimumTopUpAmount: 0, requiredSuccessfulShipments: 0 });
  });
  test.after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('a referring customer earns the flat reward on every delivered shipment, once per shipment', async () => {
    const referrer = await makeUser({ role: 'Customer' });
    const friend = await makeUser({ role: 'Customer', referredBy: { user: referrer._id, kind: 'Customer', via: 'link', at: new Date() } });

    const s1 = await makeShipment(friend);
    await handleShipmentDelivered(s1);
    await handleShipmentDelivered(s1); // status saved as Delivered again
    assert.equal(await balance(referrer), 5);

    await handleShipmentDelivered(await makeShipment(friend));
    assert.equal(await balance(referrer), 10);
    assert.equal(await Earning.countDocuments({ earner: referrer._id }), 2);
  });

  test('undelivered shipments and customers without a referrer earn nothing', async () => {
    const referrer = await makeUser({ role: 'Customer' });
    const friend = await makeUser({ role: 'Customer', referredBy: { user: referrer._id, kind: 'Customer', via: 'link', at: new Date() } });
    await handleShipmentDelivered(await makeShipment(friend, 'In Transit'));
    const loner = await makeUser({ role: 'Customer' });
    await handleShipmentDelivered(await makeShipment(loner));
    assert.equal(await balance(referrer), 0);
    assert.equal(await Earning.countDocuments({ customer: loner._id }), 0);
  });

  test('a rep earns only once the Super Admin activates them and the customer is activated', async () => {
    const rep = await makeUser({ role: 'Sales Representative', repProfile: { commissionActive: false } });
    const customer = await makeUser({ role: 'Customer', marketingActivation: activated, referredBy: { user: rep._id, kind: 'SalesRep', via: 'created', at: new Date() } });

    await handleShipmentDelivered(await makeShipment(customer));
    assert.equal(await balance(rep), 0, 'no commission before the rep is activated');

    rep.repProfile.commissionActive = true;
    await rep.save();
    await handleShipmentDelivered(await makeShipment(customer));
    assert.equal(await balance(rep), 10);

    rep.repProfile.commissionRate = 15; // personal rate
    await rep.save();
    await handleShipmentDelivered(await makeShipment(customer));
    assert.equal(await balance(rep), 25);

    const notActivated = await makeUser({ role: 'Customer', referredBy: { user: rep._id, kind: 'SalesRep', via: 'created', at: new Date() } });
    await handleShipmentDelivered(await makeShipment(notActivated));
    assert.equal(await balance(rep), 25, 'customer must meet the activation rule');
  });

  test('the delivery hook used by every status update pays out', async () => {
    const referrer = await makeUser({ role: 'Customer' });
    const friend = await makeUser({ role: 'Customer', referredBy: { user: referrer._id, kind: 'Customer', via: 'link', at: new Date() } });
    await refreshShipmentCustomerActivation(await makeShipment(friend));
    assert.equal(await balance(referrer), 5);
  });

  test('self-referral and disabled referrers are ignored', async () => {
    const referrer = await makeUser({ role: 'Customer', phone: '0831112222' });
    const sameEmail = await resolveReferrer(await generateReferralCode(referrer).then(async (code) => { referrer.referralCode = code; await referrer.save(); return code; }), { email: referrer.email });
    assert.equal(sameEmail, null);
    assert.ok(await resolveReferrer(referrer.referralCode, { email: 'someone.else@test.co.za' }));

    const twin = await makeUser({ role: 'Customer', phone: '0831112222', referredBy: { user: referrer._id, kind: 'Customer', via: 'link', at: new Date() } });
    await handleShipmentDelivered(await makeShipment(twin));
    assert.equal(await balance(referrer), 0, 'same phone number = self-referral');

    referrer.status = 'Disabled';
    await referrer.save();
    assert.equal(await resolveReferrer(referrer.referralCode, { email: 'new@test.co.za' }), null);
  });

  test('reversing an earning takes the amount back once', async () => {
    const referrer = await makeUser({ role: 'Customer' });
    const friend = await makeUser({ role: 'Customer', referredBy: { user: referrer._id, kind: 'Customer', via: 'link', at: new Date() } });
    const [earning] = await handleShipmentDelivered(await makeShipment(friend));
    assert.ok(await reverseEarning(earning._id, { reason: 'Refunded' }));
    assert.equal(await reverseEarning(earning._id, { reason: 'Refunded' }), null);
    assert.equal(await balance(referrer), 0);
  });

  test('a rep can create individual and business customers who are linked to them and emailed a password', async () => {
    const { createCustomer } = require('../controller/salesRep');
    const rep = await makeUser({ role: 'Sales Representative', repProfile: { commissionActive: true } });
    const address = { street: '12 Long Street', city: 'Cape Town', province: 'Western Cape', postalCode: '8001' };

    let res = mockRes();
    await createCustomer({ user: rep, body: { fullName: 'Naledi Khumalo', email: 'naledi@test.co.za', phone: '072 555 0199', address } }, res);
    assert.equal(res.statusCode, 400, 'consent is required');

    res = mockRes();
    await createCustomer({ user: rep, body: { fullName: 'Naledi Khumalo', email: 'naledi@test.co.za', phone: '+27 72 555 0199', address, consent: true } }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const individual = await User.findOne({ email: 'naledi@test.co.za' });
    assert.equal(individual.phone, '0725550199');
    assert.equal(String(individual.referredBy.user), String(rep._id));
    assert.equal(individual.referredBy.via, 'created');
    assert.match(individual.idNumber, /^\d{3}$/);
    assert.ok(individual.consent.acceptedAt);
    assert.match(sentMail.at(-1).text, /Temporary password: \S+/);

    res = mockRes();
    await createCustomer({ user: rep, body: { accountType: 'Business', fullName: 'Pieter Botha', companyName: 'Botha Traders', businessRegistrationNumber: '2024/555555/07', email: 'pieter@test.co.za', phone: '0215550100', address, consent: true } }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const business = await User.findOne({ email: 'pieter@test.co.za' });
    assert.equal(business.accountType, 'Business');
    assert.match(business.accountOwnerIdNumber, /^\d{3}$/);

    res = mockRes();
    await createCustomer({ user: rep, body: { fullName: 'Copy', email: 'other@test.co.za', phone: '0725550199', address, consent: true } }, res);
    assert.equal(res.statusCode, 409, 'duplicate phone blocked');
  });

  test('rep pay-outs respect the minimum, hold the amount and return it when rejected', async () => {
    const { requestPayout } = require('../controller/salesRep');
    const { rejectPayout } = require('../controller/marketing');
    const rep = await makeUser({ role: 'Sales Representative', repProfile: { commissionActive: true } });
    await Wallet.create({ userId: rep._id, balance: 30, transactions: [{ type: 'credit', amount: 30, description: 'seed' }] });

    let res = mockRes();
    await requestPayout({ user: rep, body: {} }, res);
    assert.equal(res.statusCode, 400, 'bank details required');

    rep.repProfile.bank = { bankName: 'FNB', accountHolder: 'Rep', accountNumber: '62000000000', branchCode: '250655', accountType: 'Cheque' };
    await rep.save();

    res = mockRes();
    await requestPayout({ user: rep, body: { amount: 10 } }, res);
    assert.equal(res.statusCode, 400, 'below the R20 minimum');

    res = mockRes();
    await requestPayout({ user: rep, body: {} }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(await balance(rep), 0, 'amount held');

    res = mockRes();
    await requestPayout({ user: rep, body: {} }, res);
    assert.equal(res.statusCode, 409, 'one open request at a time');

    const payout = await Payout.findOne({ rep: rep._id });
    res = mockRes();
    await rejectPayout({ params: { payoutId: payout._id }, body: { reason: 'Wrong account' }, user: { _id: rep._id } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(await balance(rep), 30, 'amount returned');
  });
});
