const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Earning = require('../models/Earning');
const Payout = require('../models/Payout');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const sendMail = require('../utils/mail');
const { generateCustomerId, generateAutoIdNumber, normalizePhone, saPhoneRegex } = require('./auth');
const { getSettings, ensureReferralCode, creditWallet, roundRand } = require('../services/referralService');

const SA_PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
];

const clean = (value) => String(value ?? '').trim();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A readable temporary password that satisfies the sign-in password rules
const generateTemporaryPassword = () => {
  const pick = (chars, n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  const chars = pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 3) + pick('abcdefghijkmnpqrstuvwxyz', 4) + pick('23456789', 2) + pick('!@#$%', 1);
  return chars.split('').sort(() => crypto.randomInt(3) - 1).join('');
};

const startOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

// Delivered-shipment counts per customer id, matching shipments by customer link or sender email
async function deliveredCountsFor(customers) {
  if (!customers.length) return new Map();
  const ids = customers.map((c) => c._id);
  const byEmail = new Map(customers.map((c) => [c.email, String(c._id)]));
  const shipments = await Shipment.find({
    status: 'Delivered',
    $or: [{ customer: { $in: ids } }, { 'senderDetails.email': { $in: [...byEmail.keys()] } }],
  }).select('customer senderDetails.email');

  const counts = new Map();
  shipments.forEach((s) => {
    const id = s.customer ? String(s.customer) : byEmail.get(String(s.senderDetails?.email || '').toLowerCase());
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  });
  return counts;
}

async function earningTotals(earnerId) {
  const [all, month] = await Promise.all([
    Earning.aggregate([{ $match: { earner: earnerId, status: 'credited' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Earning.aggregate([{ $match: { earner: earnerId, status: 'credited', createdAt: { $gte: startOfMonth() } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  return { allTime: roundRand(all[0]?.total), thisMonth: roundRand(month[0]?.total) };
}

exports.getDashboard = async (req, res) => {
  try {
    const rep = req.user;
    const [settings, customers, wallet, earnings, payouts, totals, referralCode] = await Promise.all([
      getSettings(),
      User.find({ role: 'Customer', 'referredBy.user': rep._id, 'referredBy.kind': 'SalesRep' })
        .select('fullName companyName email accountType createdAt marketingActivation referredBy.via')
        .sort({ createdAt: -1 }),
      Wallet.findOne({ userId: rep._id }).select('balance'),
      Earning.find({ earner: rep._id }).sort({ createdAt: -1 }).limit(20)
        .select('amount status shipmentRef reversedReason createdAt'),
      Payout.find({ rep: rep._id }).sort({ createdAt: -1 }).limit(20)
        .select('amount status reference note createdAt processedAt'),
      earningTotals(rep._id),
      ensureReferralCode(rep),
    ]);

    const counts = await deliveredCountsFor(customers);
    const rate = roundRand(rep.repProfile?.commissionRate ?? settings.repCommissionAmount);

    res.json({
      rep: {
        fullName: rep.fullName,
        customerId: rep.customerId,
        referralCode,
        commissionActive: Boolean(rep.repProfile?.commissionActive),
        commissionRate: rate,
        bank: rep.repProfile?.bank || {},
      },
      programme: {
        enabled: settings.programmeEnabled,
        minimumPayoutAmount: settings.minimumPayoutAmount,
        minimumTopUpAmount: settings.minimumTopUpAmount,
        requiredSuccessfulShipments: settings.requiredSuccessfulShipments,
      },
      stats: {
        customers: customers.length,
        individual: customers.filter((c) => c.accountType !== 'Business').length,
        business: customers.filter((c) => c.accountType === 'Business').length,
        activatedCustomers: customers.filter((c) => c.marketingActivation?.status === 'Activated').length,
        deliveredShipments: [...counts.values()].reduce((a, b) => a + b, 0),
        commissionThisMonth: totals.thisMonth,
        commissionAllTime: totals.allTime,
        walletBalance: roundRand(wallet?.balance),
      },
      customers: customers.map((c) => ({
        _id: c._id,
        name: c.accountType === 'Business' && c.companyName ? c.companyName : c.fullName,
        accountType: c.accountType === 'Business' ? 'Business' : 'Individual',
        joinedAt: c.createdAt,
        via: c.referredBy?.via,
        activated: c.marketingActivation?.status === 'Activated',
        deliveredShipments: counts.get(String(c._id)) || 0,
      })),
      earnings,
      payouts,
    });
  } catch (err) {
    console.error('Sales rep dashboard error:', err);
    res.status(500).json({ message: 'Could not load your dashboard' });
  }
};

exports.createCustomer = async (req, res) => {
  const rep = req.user;
  const body = req.body || {};
  const accountType = body.accountType === 'Business' ? 'Business' : 'Personal';
  const fullName = clean(body.fullName);
  const companyName = clean(body.companyName);
  const businessRegistrationNumber = clean(body.businessRegistrationNumber);
  const email = clean(body.email).toLowerCase();
  const phone = normalizePhone(body.phone);
  const address = {
    street: clean(body.address?.street),
    complexOrBusinessHub: clean(body.address?.complexOrBusinessHub),
    city: clean(body.address?.city),
    province: clean(body.address?.province),
    postalCode: clean(body.address?.postalCode),
    country: 'South Africa',
  };

  if (!fullName) return res.status(400).json({ message: "Enter the customer's full name" });
  if (!emailRegex.test(email)) return res.status(400).json({ message: 'Enter a valid email address' });
  if (!saPhoneRegex.test(phone)) return res.status(400).json({ message: 'Enter a valid South African phone number, e.g. 082 123 4567' });
  if (accountType === 'Business' && (!companyName || !businessRegistrationNumber)) {
    return res.status(400).json({ message: 'Company name and registration number are required for business accounts' });
  }
  if (!address.street || !address.city || !SA_PROVINCES.includes(address.province) || !/^\d{4}$/.test(address.postalCode)) {
    return res.status(400).json({ message: 'Enter a full South African address: street, city, province and 4-digit postal code' });
  }
  if (body.consent !== true) {
    return res.status(400).json({ message: 'Confirm that the customer agreed to the Terms and to ShipDay processing their information' });
  }

  try {
    const [emailTaken, phoneTaken, regTaken] = await Promise.all([
      User.exists({ email }),
      User.exists({ phone }),
      accountType === 'Business' ? User.exists({ businessRegistrationNumber }) : null,
    ]);
    if (emailTaken) return res.status(409).json({ message: 'An account with this email already exists' });
    if (phoneTaken) return res.status(409).json({ message: 'An account with this phone number already exists' });
    if (regTaken) return res.status(409).json({ message: 'This business registration number already has an account' });

    const temporaryPassword = generateTemporaryPassword();
    const idNumber = await generateAutoIdNumber();

    const customer = new User({
      customerId: await generateCustomerId(),
      email,
      password: await bcrypt.hash(temporaryPassword, 10),
      role: 'Customer',
      status: 'Active',
      accountType,
      fullName,
      companyName: accountType === 'Business' ? companyName : '',
      phone,
      address,
      profileCompleted: true,
      referredBy: { user: rep._id, kind: 'SalesRep', via: 'created', at: new Date() },
      consent: { acceptedAt: new Date(), recordedBy: rep._id },
      ...(accountType === 'Business'
        ? { businessRegistrationNumber, accountOwnerIdNumber: idNumber }
        : { idNumber }),
    });
    await customer.save();

    let emailed = true;
    try {
      const loginUrl = `${process.env.FRONTEND_URL || 'https://shipday.co.za'}/login`;
      await sendMail(
        email,
        'Your ShipDay account is ready',
        `Hello ${fullName},\n\n${rep.fullName} from ShipDay has created your account.\n\nEmail: ${email}\nTemporary password: ${temporaryPassword}\n\nSign in at ${loginUrl}. You can change your password with "Forgot password" on the sign-in page.\n\nShipDay`,
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #e5e5e5;border-radius:10px">
          <h2 style="margin-top:0">Welcome to ShipDay</h2>
          <p>Hello ${fullName},</p>
          <p>${rep.fullName} from ShipDay has created your ${accountType === 'Business' ? 'business ' : ''}account.</p>
          <p style="background:#F7F6F2;padding:12px 16px;border-radius:8px">Email: <strong>${email}</strong><br/>Temporary password: <strong>${temporaryPassword}</strong></p>
          <p><a href="${loginUrl}" style="display:inline-block;background:#000;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Sign in to ShipDay</a></p>
          <p style="color:#666;font-size:13px">You can change your password at any time with "Forgot password" on the sign-in page.</p>
        </div>`
      );
    } catch (mailErr) {
      emailed = false;
      console.error('Customer welcome email failed:', mailErr.message);
    }

    res.status(201).json({
      message: emailed
        ? `${accountType === 'Business' ? companyName : fullName} has been added and emailed their sign-in details.`
        : `${accountType === 'Business' ? companyName : fullName} has been added, but the welcome email could not be sent. They can use "Forgot password" on the sign-in page.`,
      emailed,
      customer: { _id: customer._id, customerId: customer.customerId },
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'An account with these details already exists' });
    console.error('Sales rep create customer error:', err);
    res.status(500).json({ message: 'Could not create the customer' });
  }
};

exports.updateBankDetails = async (req, res) => {
  const bank = {
    bankName: clean(req.body.bankName),
    accountHolder: clean(req.body.accountHolder),
    accountNumber: clean(req.body.accountNumber).replace(/\s/g, ''),
    branchCode: clean(req.body.branchCode).replace(/\s/g, ''),
    accountType: clean(req.body.accountType) || 'Cheque',
  };
  if (!bank.bankName || !bank.accountHolder) return res.status(400).json({ message: 'Enter the bank name and account holder' });
  if (!/^\d{6,16}$/.test(bank.accountNumber)) return res.status(400).json({ message: 'Account number must be 6 to 16 digits' });
  if (!/^\d{6}$/.test(bank.branchCode)) return res.status(400).json({ message: 'Branch code must be 6 digits' });

  try {
    await User.updateOne({ _id: req.user._id }, { $set: { 'repProfile.bank': bank } });
    res.json({ message: 'Bank details saved', bank });
  } catch (err) {
    console.error('Bank details error:', err);
    res.status(500).json({ message: 'Could not save bank details' });
  }
};

exports.requestPayout = async (req, res) => {
  try {
    const rep = await User.findById(req.user._id);
    const settings = await getSettings();
    const bank = rep.repProfile?.bank || {};
    if (!bank.accountNumber || !bank.branchCode) {
      return res.status(400).json({ message: 'Add your bank details before requesting a pay-out' });
    }
    if (await Payout.exists({ rep: rep._id, status: 'requested' })) {
      return res.status(409).json({ message: 'You already have a pay-out waiting for approval' });
    }

    const wallet = await Wallet.findOne({ userId: rep._id });
    const balance = roundRand(wallet?.balance);
    const amount = roundRand(req.body.amount ?? balance);
    if (amount < settings.minimumPayoutAmount) {
      return res.status(400).json({ message: `The minimum pay-out is R${settings.minimumPayoutAmount.toFixed(2)}` });
    }
    if (amount > balance) return res.status(400).json({ message: 'That is more than your available balance' });

    // Hold the amount so the same commission can't be requested twice
    const held = await Wallet.findOneAndUpdate(
      { userId: rep._id, balance: { $gte: amount } },
      { $inc: { balance: -amount }, $push: { transactions: { type: 'debit', amount, description: 'Pay-out requested (held)', date: new Date() } } },
      { new: true }
    );
    if (!held) return res.status(400).json({ message: 'That is more than your available balance' });

    try {
      const payout = await Payout.create({ rep: rep._id, amount, bank });
      res.status(201).json({ message: 'Pay-out requested. You will be paid by EFT once it is approved.', payout });
    } catch (err) {
      await creditWallet(rep._id, amount, 'Pay-out request failed (returned)');
      throw err;
    }
  } catch (err) {
    console.error('Pay-out request error:', err);
    res.status(500).json({ message: 'Could not request the pay-out' });
  }
};
