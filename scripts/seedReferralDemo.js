/**
 * Local test data for the referral & commission programme. Never run against production.
 *
 *   MONGO_URI=mongodb://127.0.0.1:27099/shipday_e2e node scripts/seedReferralDemo.js
 *
 * Test logins (password for all: Test@12345):
 *   e2e-admin@shipday.test  Super Admin
 *   e2e-rep@shipday.test    Sales Representative (commission switched on)
 *   e2e-cust@shipday.test   Customer who has referred a friend
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const MarketingSettings = require('../models/MarketingSettings');
const { handleShipmentDelivered, generateReferralCode } = require('../services/referralService');

const PASSWORD = 'Test@12345';

async function main() {
  if (!/127\.0\.0\.1|localhost/.test(process.env.MONGO_URI || '')) {
    throw new Error('Refusing to seed: MONGO_URI must point at a local database');
  }
  await mongoose.connect(process.env.MONGO_URI);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const upsert = async (email, fields) => {
    await User.deleteOne({ email });
    const user = new User({ email, password: hash, ...fields });
    if (['Customer', 'Sales Representative'].includes(fields.role)) user.referralCode = await generateReferralCode(user);
    return user.save();
  };

  await MarketingSettings.deleteMany({});
  await MarketingSettings.create({ repCommissionAmount: 10, customerReferralReward: 5, minimumPayoutAmount: 20, minimumTopUpAmount: 0, requiredSuccessfulShipments: 1 });

  await upsert('e2e-admin@shipday.test', { fullName: 'Test Super Admin', role: 'Super Admin', customerId: 'ADMIN901' });
  const rep = await upsert('e2e-rep@shipday.test', { fullName: 'Lerato Mokoena', role: 'Sales Representative', customerId: 'REP901', phone: '0821110001', repProfile: { commissionActive: true } });
  const cust = await upsert('e2e-cust@shipday.test', { fullName: 'Thabo Nkosi', role: 'Customer', customerId: 'CUST9001', phone: '0821110002', accountType: 'Personal', profileCompleted: true });

  const repCustomer = await upsert('e2e-repcustomer@shipday.test', {
    fullName: 'Sipho Dlamini', role: 'Customer', customerId: 'CUST9002', phone: '0821110003', accountType: 'Business', companyName: 'Dlamini Traders', profileCompleted: true,
    marketingActivation: { status: 'Activated', topUpAmount: 600, successfulShipments: 3, topUpRequirementMet: true, shipmentRequirementMet: true },
    referredBy: { user: rep._id, kind: 'SalesRep', via: 'created', at: new Date() },
  });
  const friend = await upsert('e2e-friend@shipday.test', {
    fullName: 'Naledi Khumalo', role: 'Customer', customerId: 'CUST9003', phone: '0821110004', accountType: 'Personal', profileCompleted: true,
    referredBy: { user: cust._id, kind: 'Customer', via: 'link', at: new Date() },
  });

  await Shipment.deleteMany({ shipmentId: /^SHPE2E/ });
  let n = 0;
  for (const customer of [repCustomer, repCustomer, repCustomer, friend, friend]) {
    n += 1;
    // eslint-disable-next-line no-await-in-loop
    const shipment = await Shipment.create({ shipmentId: `SHPE2E${n}`, customer: customer._id, status: 'Delivered', senderDetails: { email: customer.email } });
    // eslint-disable-next-line no-await-in-loop
    await handleShipmentDelivered(shipment);
  }

  console.log('Seeded referral demo data. Password for all test logins:', PASSWORD);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
