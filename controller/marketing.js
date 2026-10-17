const MarketingSettings = require('../models/MarketingSettings');
const Earning = require('../models/Earning');
const Payout = require('../models/Payout');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const { getMarketingOverview } = require('../services/marketingActivationService');
const { reverseEarning, creditWallet, roundRand, SALES_REP_ROLE } = require('../services/referralService');

const sumBy = (rows, key = 'total') => roundRand(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));

// Everything the Super Admin's Marketing page needs in one response
async function buildOverview() {
  const overview = await getMarketingOverview();
  const reps = overview.representatives;
  const customers = overview.customers;

  const repIds = reps.map((r) => r._id);
  const customerIds = customers.map((c) => c._id);

  const [earnedByEarner, paidByRep, pendingByRep, wallets, customerWallets, payouts, recentEarnings, topReferrers] = await Promise.all([
    Earning.aggregate([{ $match: { status: 'credited' } }, { $group: { _id: { earner: '$earner', kind: '$kind' }, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Payout.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$rep', total: { $sum: '$amount' } } }]),
    Payout.aggregate([{ $match: { status: 'requested' } }, { $group: { _id: '$rep', total: { $sum: '$amount' } } }]),
    Wallet.find({ userId: { $in: repIds } }).select('userId balance'),
    Wallet.find({ userId: { $in: customerIds } }).select('userId balance'),
    Payout.find().sort({ createdAt: -1 }).limit(100).populate('rep', 'fullName customerId email phone'),
    Earning.find().sort({ createdAt: -1 }).limit(100)
      .populate('earner', 'fullName customerId role')
      .populate('customer', 'fullName companyName customerId'),
    Earning.aggregate([
      { $match: { status: 'credited', kind: 'customer_referral' } },
      { $group: { _id: '$earner', total: { $sum: '$amount' }, shipments: { $sum: 1 } } },
      { $sort: { total: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { total: 1, shipments: 1, fullName: '$user.fullName', customerId: '$user.customerId' } },
    ]),
  ]);

  const key = (id) => String(id);
  const earned = new Map();
  earnedByEarner.forEach((row) => {
    if (row._id.kind === 'rep_commission') earned.set(key(row._id.earner), { total: row.total, count: row.count });
  });
  const paid = new Map(paidByRep.map((r) => [key(r._id), r.total]));
  const pending = new Map(pendingByRep.map((r) => [key(r._id), r.total]));
  const walletBalance = new Map(wallets.map((w) => [key(w.userId), w.balance]));
  const customerBalance = new Map(customerWallets.map((w) => [key(w.userId), w.balance]));

  const repRows = reps.map((rep) => {
    const own = customers.filter((c) => c.salesRepresentative && key(c.salesRepresentative._id) === key(rep._id));
    return {
      _id: rep._id,
      fullName: rep.fullName,
      email: rep.email,
      phone: rep.phone,
      customerId: rep.customerId,
      status: rep.status || 'Active',
      referralCode: rep.referralCode,
      joinedAt: rep.createdAt,
      commissionActive: Boolean(rep.repProfile?.commissionActive),
      activatedAt: rep.repProfile?.activatedAt,
      commissionRate: rep.repProfile?.commissionRate ?? null,
      hasBankDetails: Boolean(rep.repProfile?.bank?.accountNumber),
      customers: own.length,
      activatedCustomers: own.filter((c) => c.marketingActivation?.status === 'Activated').length,
      customersWalletBalance: roundRand(own.reduce((s, c) => s + (customerBalance.get(key(c._id)) || 0), 0)),
      deliveredShipments: own.reduce((s, c) => s + (c.marketingActivation?.successfulShipments || 0), 0),
      commissionEarned: roundRand(earned.get(key(rep._id))?.total),
      commissionedShipments: earned.get(key(rep._id))?.count || 0,
      paidOut: roundRand(paid.get(key(rep._id))),
      pendingPayout: roundRand(pending.get(key(rep._id))),
      walletBalance: roundRand(walletBalance.get(key(rep._id))),
    };
  });

  const allCredited = earnedByEarner;
  return {
    ...overview,
    reps: repRows,
    payouts,
    earnings: recentEarnings,
    topReferrers,
    totals: {
      repCommission: sumBy(allCredited.filter((r) => r._id.kind === 'rep_commission')),
      customerRewards: sumBy(allCredited.filter((r) => r._id.kind === 'customer_referral')),
      paidOut: sumBy(paidByRep),
      pendingPayouts: sumBy(pendingByRep),
      referredByCustomers: customers.filter((c) => c.referrerCustomer).length,
      referredByReps: customers.filter((c) => c.salesRepresentative).length,
    },
  };
}

exports.getMarketingDashboard = async (req, res) => {
  try {
    res.status(200).json(await buildOverview());
  } catch (error) {
    console.error('Marketing dashboard error:', error);
    res.status(500).json({ message: 'Failed to load marketing management data' });
  }
};

const NUMERIC_SETTINGS = {
  minimumTopUpAmount: { label: 'Minimum top-up amount', integer: false },
  requiredSuccessfulShipments: { label: 'Required delivered shipments', integer: true },
  repCommissionAmount: { label: 'Sales rep commission', integer: false },
  customerReferralReward: { label: 'Customer referral reward', integer: false },
  minimumPayoutAmount: { label: 'Minimum pay-out', integer: false },
};

exports.updateMarketingSettings = async (req, res) => {
  try {
    let settings = await MarketingSettings.findOne();
    if (!settings) settings = new MarketingSettings();

    for (const [field, rule] of Object.entries(NUMERIC_SETTINGS)) {
      if (req.body[field] === undefined) continue;
      const value = Number(req.body[field]);
      if (!Number.isFinite(value) || value < 0 || (rule.integer && !Number.isInteger(value))) {
        return res.status(400).json({ message: `${rule.label} must be ${rule.integer ? 'a whole number' : 'an amount'} of 0 or more` });
      }
      settings[field] = rule.integer ? value : roundRand(value);
    }
    if (typeof req.body.programmeEnabled === 'boolean') settings.programmeEnabled = req.body.programmeEnabled;
    settings.updatedAt = new Date();
    await settings.save();

    res.status(200).json({ message: 'Marketing settings updated', ...(await buildOverview()) });
  } catch (error) {
    console.error('Marketing settings update error:', error);
    res.status(500).json({ message: 'Failed to update marketing settings' });
  }
};

// Link a customer to a Sales Representative (or unlink). A customer referred by another customer
// can only be moved to a rep on purpose, which ends that customer's referral reward.
exports.assignSalesRepresentative = async (req, res) => {
  const { customerId } = req.params;
  const { representativeId } = req.body;

  try {
    const customer = await User.findOne({ _id: customerId, role: 'Customer' });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    if (!representativeId) {
      if (customer.referredBy?.kind === 'SalesRep') {
        customer.referredBy = { user: null, kind: null, via: null, at: null };
      }
    } else {
      const rep = await User.findOne({ _id: representativeId, role: SALES_REP_ROLE });
      if (!rep) return res.status(400).json({ message: 'Select a valid Sales Representative' });
      customer.referredBy = { user: rep._id, kind: 'SalesRep', via: 'assigned', at: new Date() };
    }

    await customer.save();
    res.status(200).json({ message: 'Sales Representative assignment updated' });
  } catch (error) {
    console.error('Sales Representative assignment error:', error);
    res.status(500).json({ message: 'Failed to update Sales Representative assignment' });
  }
};

// Switch a rep's commission on/off, set a personal rate, or disable the account
exports.updateRep = async (req, res) => {
  try {
    const rep = await User.findOne({ _id: req.params.repId, role: SALES_REP_ROLE });
    if (!rep) return res.status(404).json({ message: 'Sales Representative not found' });

    const { commissionActive, commissionRate, status } = req.body;
    if (typeof commissionActive === 'boolean') {
      rep.repProfile.commissionActive = commissionActive;
      rep.repProfile.activatedAt = commissionActive ? new Date() : null;
    }
    if (commissionRate !== undefined) {
      if (commissionRate === null || commissionRate === '') {
        rep.repProfile.commissionRate = null;
      } else {
        const value = Number(commissionRate);
        if (!Number.isFinite(value) || value < 0) return res.status(400).json({ message: 'Commission rate must be an amount of 0 or more' });
        rep.repProfile.commissionRate = roundRand(value);
      }
    }
    if (status !== undefined) {
      if (!['Active', 'Disabled'].includes(status)) return res.status(400).json({ message: 'Status must be Active or Disabled' });
      rep.status = status;
    }
    await rep.save();
    res.json({ message: 'Sales Representative updated', ...(await buildOverview()) });
  } catch (error) {
    console.error('Update rep error:', error);
    res.status(500).json({ message: 'Could not update the Sales Representative' });
  }
};

exports.markPayoutPaid = async (req, res) => {
  const reference = String(req.body.reference || '').trim();
  if (!reference) return res.status(400).json({ message: 'Enter the EFT reference' });
  try {
    const payout = await Payout.findOneAndUpdate(
      { _id: req.params.payoutId, status: 'requested' },
      { status: 'paid', reference, processedAt: new Date(), processedBy: req.user._id },
      { new: true }
    );
    if (!payout) return res.status(404).json({ message: 'Pay-out not found or already processed' });
    res.json({ message: 'Pay-out marked as paid', ...(await buildOverview()) });
  } catch (error) {
    console.error('Mark pay-out paid error:', error);
    res.status(500).json({ message: 'Could not update the pay-out' });
  }
};

exports.rejectPayout = async (req, res) => {
  const note = String(req.body.reason || '').trim();
  if (!note) return res.status(400).json({ message: 'Give a reason so the rep knows what to fix' });
  try {
    const payout = await Payout.findOneAndUpdate(
      { _id: req.params.payoutId, status: 'requested' },
      { status: 'rejected', note, processedAt: new Date(), processedBy: req.user._id },
      { new: true }
    );
    if (!payout) return res.status(404).json({ message: 'Pay-out not found or already processed' });
    await creditWallet(payout.rep, payout.amount, `Pay-out rejected, amount returned: ${note}`);
    res.json({ message: 'Pay-out rejected and the amount returned to the rep', ...(await buildOverview()) });
  } catch (error) {
    console.error('Reject pay-out error:', error);
    res.status(500).json({ message: 'Could not update the pay-out' });
  }
};

exports.reverseEarning = async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'Give a reason for the reversal' });
  try {
    const earning = await reverseEarning(req.params.earningId, { reason, reversedBy: req.user._id });
    if (!earning) return res.status(404).json({ message: 'Earning not found or already reversed' });
    res.json({ message: 'Earning reversed', ...(await buildOverview()) });
  } catch (error) {
    console.error('Reverse earning error:', error);
    res.status(500).json({ message: 'Could not reverse the earning' });
  }
};

const csvCell = (value) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

exports.exportEarnings = async (req, res) => {
  try {
    const earnings = await Earning.find().sort({ createdAt: -1 })
      .populate('earner', 'fullName customerId role')
      .populate('customer', 'fullName companyName customerId');
    const header = ['Date', 'Type', 'Earner', 'Earner ID', 'Customer', 'Customer ID', 'Shipment', 'Amount (R)', 'Status', 'Reversal reason'];
    const rows = earnings.map((e) => [
      e.createdAt.toISOString().slice(0, 10),
      e.kind === 'rep_commission' ? 'Sales rep commission' : 'Customer referral',
      e.earner?.fullName, e.earner?.customerId,
      e.customer?.companyName || e.customer?.fullName, e.customer?.customerId,
      e.shipmentRef, e.amount.toFixed(2), e.status, e.reversedReason,
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipday-earnings-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Export earnings error:', error);
    res.status(500).json({ message: 'Could not export earnings' });
  }
};
