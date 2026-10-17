const MarketingSettings = require('../models/MarketingSettings');
const Earning = require('../models/Earning');
const User = require('../models/User');
const Wallet = require('../models/Wallet');

const SALES_REP_ROLE = 'Sales Representative';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, easy to read aloud

async function getSettings() {
  return (await MarketingSettings.findOne()) || new MarketingSettings();
}

const randomChars = (length) =>
  Array.from({ length }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

// e.g. THABO7K2 — first name (up to 5 letters) plus a short random suffix
async function generateReferralCode(user) {
  const base = String(user.fullName || user.companyName || '')
    .split(/\s+/)[0]
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 5) || 'SHIP';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${base}${randomChars(attempt < 5 ? 3 : 5)}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await User.exists({ referralCode: candidate }))) return candidate;
  }
  throw new Error('Could not generate a unique referral code');
}

// Customers and reps created before the programme get a code the first time they need one
async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  user.referralCode = await generateReferralCode(user);
  await user.save();
  return user.referralCode;
}

const normalizeCode = (code) => String(code || '').trim().toUpperCase();

/**
 * Find who owns a referral code. Returns null for unknown, disabled or self-referral codes.
 * `newUser` is the account being created (email, and phone when known).
 */
async function resolveReferrer(code, newUser = {}) {
  const referralCode = normalizeCode(code);
  if (!/^[A-Z0-9]{4,12}$/.test(referralCode)) return null;

  const referrer = await User.findOne({
    referralCode,
    role: { $in: ['Customer', SALES_REP_ROLE] },
    status: { $ne: 'Disabled' },
  }).select('_id role email phone');
  if (!referrer) return null;

  const sameEmail = newUser.email && referrer.email === String(newUser.email).toLowerCase();
  const samePhone = newUser.phone && referrer.phone && referrer.phone === newUser.phone;
  if (sameEmail || samePhone) return null;

  return referrer;
}

const referralRecord = (referrer, via) => ({
  user: referrer._id,
  kind: referrer.role === SALES_REP_ROLE ? 'SalesRep' : 'Customer',
  via,
  at: new Date(),
});

async function creditWallet(userId, amount, description) {
  return Wallet.findOneAndUpdate(
    { userId },
    {
      $inc: { balance: amount },
      $push: { transactions: { type: 'credit', amount, description, date: new Date() } },
    },
    { new: true, upsert: true }
  );
}

async function debitWallet(userId, amount, description) {
  return Wallet.findOneAndUpdate(
    { userId },
    {
      $inc: { balance: -amount },
      $push: { transactions: { type: 'debit', amount, description, date: new Date() } },
    },
    { new: true, upsert: true }
  );
}

const roundRand = (value) => Math.round((Number(value) || 0) * 100) / 100;

async function recordEarning({ earner, kind, shipment, customer, amount, description }) {
  let earning;
  try {
    earning = await Earning.create({
      earner: earner._id,
      kind,
      shipment: shipment._id,
      shipmentRef: shipment.orderNumber || shipment.shipmentId,
      customer: customer._id,
      amount,
    });
  } catch (err) {
    if (err.code === 11000) return null; // already paid for this shipment
    throw err;
  }

  try {
    await creditWallet(earner._id, amount, description);
  } catch (err) {
    await Earning.deleteOne({ _id: earning._id }); // keep ledger and wallet in step
    throw err;
  }
  return earning;
}

/**
 * Called whenever a shipment is saved as Delivered. Credits, at most once per shipment:
 *  - the Sales Representative who owns the customer (rep's commission must be switched on by the
 *    Super Admin and the customer must meet the activation rule), and
 *  - the customer who referred them (no activation needed).
 * A customer has a single referrer, so only one of the two applies to any shipment.
 */
async function handleShipmentDelivered(shipment) {
  if (!shipment || shipment.status !== 'Delivered') return [];

  const customer = shipment.customer
    ? await User.findById(shipment.customer)
    : await User.findOne({ email: String(shipment.senderDetails?.email || '').toLowerCase(), role: 'Customer' });
  if (!customer || customer.role !== 'Customer' || !customer.referredBy?.user) return [];

  const settings = await getSettings();
  if (!settings.programmeEnabled) return [];

  const earner = await User.findById(customer.referredBy.user);
  if (!earner || earner.status === 'Disabled') return [];
  if (earner.phone && customer.phone && earner.phone === customer.phone) return []; // self-referral

  const ref = shipment.orderNumber || shipment.shipmentId;
  const earnings = [];

  if (earner.role === SALES_REP_ROLE) {
    const amount = roundRand(earner.repProfile?.commissionRate ?? settings.repCommissionAmount);
    const customerActivated = customer.marketingActivation?.status === 'Activated';
    if (amount > 0 && earner.repProfile?.commissionActive && customerActivated) {
      const earning = await recordEarning({
        earner, kind: 'rep_commission', shipment, customer, amount,
        description: `Commission: shipment ${ref} delivered`,
      });
      if (earning) earnings.push(earning);
    }
  } else if (earner.role === 'Customer') {
    const amount = roundRand(settings.customerReferralReward);
    if (amount > 0) {
      const earning = await recordEarning({
        earner, kind: 'customer_referral', shipment, customer, amount,
        description: `Referral reward: a friend's shipment ${ref} was delivered`,
      });
      if (earning) earnings.push(earning);
    }
  }

  return earnings;
}

async function reverseEarning(earningId, { reason, reversedBy }) {
  const earning = await Earning.findOneAndUpdate(
    { _id: earningId, status: 'credited' },
    { status: 'reversed', reversedReason: reason, reversedAt: new Date(), reversedBy },
    { new: true }
  );
  if (!earning) return null;
  await debitWallet(earning.earner, earning.amount, `Reversed: ${earning.shipmentRef} (${reason})`);
  return earning;
}

module.exports = {
  SALES_REP_ROLE,
  getSettings,
  generateReferralCode,
  ensureReferralCode,
  resolveReferrer,
  referralRecord,
  creditWallet,
  debitWallet,
  handleShipmentDelivered,
  reverseEarning,
  roundRand,
};
