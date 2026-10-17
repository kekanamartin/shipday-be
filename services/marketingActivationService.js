const MarketingSettings = require('../models/MarketingSettings');
const Shipment = require('../models/Shipment');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { evaluateCustomerActivation, getTopUpUserId } = require('../utils/marketingActivation');

const TOP_UP_TRANSACTION_QUERY = {
  type: { $in: ['Credit', 'credit'] },
  status: { $in: ['Completed', 'completed'] },
  method: { $in: ['PayFast', 'payfast'] },
  orderId: /^TOPUP-/,
};

async function getSettings() {
  return (await MarketingSettings.findOne()) || new MarketingSettings();
}

function activationRecord(progress, previousActivation) {
  const wasActivated = previousActivation?.status === 'Activated';
  const activatedAt = progress.isActivated
    ? (wasActivated ? previousActivation.activatedAt : new Date())
    : null;

  return {
    status: progress.isActivated ? 'Activated' : 'Not Activated',
    topUpAmount: progress.topUpAmount,
    successfulShipments: progress.successfulShipments,
    activatedAt,
    topUpRequirementMet: progress.topUpMet,
    shipmentRequirementMet: progress.shipmentsMet,
  };
}

async function refreshCustomerActivation(userId) {
  const user = await User.findOne({ _id: userId, role: 'Customer' });
  if (!user) return null;

  const [settings, topUpTransactions, successfulShipments] = await Promise.all([
    getSettings(),
    Transaction.find({
      ...TOP_UP_TRANSACTION_QUERY,
      $or: [
        { userId: user._id },
        { orderId: new RegExp(`^TOPUP-${user._id}-`) },
      ],
    }).select('amount'),
    Shipment.countDocuments({
      status: 'Delivered',
      $or: [
        { customer: user._id },
        { 'senderDetails.email': user.email },
      ],
    }),
  ]);

  const topUpAmount = topUpTransactions.reduce((total, transaction) => total + (Number(transaction.amount) || 0), 0);
  const progress = evaluateCustomerActivation({
    topUpAmount,
    successfulShipments,
    minimumTopUpAmount: settings.minimumTopUpAmount,
    requiredSuccessfulShipments: settings.requiredSuccessfulShipments,
  });

  user.marketingActivation = activationRecord(progress, user.marketingActivation);
  await user.save();
  return user.marketingActivation;
}

async function refreshShipmentCustomerActivation(shipment) {
  const user = shipment.customer
    ? null
    : await User.findOne({ email: shipment.senderDetails?.email }).select('_id');
  const userId = shipment.customer || user?._id;
  const activation = userId ? await refreshCustomerActivation(userId) : null;

  // Pay rep commission / customer referral reward. Never let a payout problem block a delivery update.
  if (shipment.status === 'Delivered') {
    try {
      // Required lazily: referralService is independent of this module
      // eslint-disable-next-line global-require
      await require('./referralService').handleShipmentDelivered(shipment);
    } catch (err) {
      console.error('Referral earnings error for shipment', shipment.shipmentId, err);
    }
  }

  return activation;
}

async function getMarketingOverview() {
  const [settings, customers, representatives, transactions, deliveredShipments] = await Promise.all([
    getSettings(),
    User.find({ role: 'Customer' })
      .select('customerId fullName companyName email phone accountType referredBy marketingActivation createdAt')
      .populate('referredBy.user', 'fullName email role referralCode customerId repProfile.commissionActive'),
    User.find({ role: 'Sales Representative' }).select('fullName email phone customerId status referralCode repProfile createdAt'),
    Transaction.find(TOP_UP_TRANSACTION_QUERY).select('userId orderId amount'),
    Shipment.find({ status: 'Delivered' }).select('customer senderDetails.email'),
  ]);

  const topUpsByUser = new Map();
  transactions.forEach(transaction => {
    const userId = getTopUpUserId(transaction);
    if (!userId) return;
    topUpsByUser.set(userId, (topUpsByUser.get(userId) || 0) + (Number(transaction.amount) || 0));
  });

  const customersByEmail = new Map(customers.map(customer => [customer.email.toLowerCase(), customer._id.toString()]));
  const shipmentCounts = new Map();
  deliveredShipments.forEach(shipment => {
    const userId = shipment.customer?.toString() || customersByEmail.get(shipment.senderDetails?.email?.toLowerCase());
    if (userId) shipmentCounts.set(userId, (shipmentCounts.get(userId) || 0) + 1);
  });

  const activationUpdates = [];
  const customerRows = customers.map(customer => {
    const customerId = customer._id.toString();
    const previousActivation = customer.marketingActivation?.toObject?.() || customer.marketingActivation;
    const progress = evaluateCustomerActivation({
      topUpAmount: topUpsByUser.get(customerId) || 0,
      successfulShipments: shipmentCounts.get(customerId) || 0,
      minimumTopUpAmount: settings.minimumTopUpAmount,
      requiredSuccessfulShipments: settings.requiredSuccessfulShipments,
    });
    const marketingActivation = activationRecord(progress, previousActivation);

    activationUpdates.push({
      updateOne: {
        filter: { _id: customer._id },
        update: { $set: { marketingActivation } },
      },
    });

    const referrer = customer.referredBy?.user;
    const repReferrer = customer.referredBy?.kind === 'SalesRep' ? referrer : null;
    return {
      ...customer.toObject(),
      // Kept under the old name so the customers table keeps working
      salesRepresentative: repReferrer ? { _id: repReferrer._id, fullName: repReferrer.fullName, staffId: repReferrer.customerId } : null,
      referrerCustomer: customer.referredBy?.kind === 'Customer' && referrer ? { _id: referrer._id, fullName: referrer.fullName } : null,
      marketingActivation,
      commissionEligible: Boolean(repReferrer && repReferrer.repProfile?.commissionActive && progress.isActivated),
    };
  });

  if (activationUpdates.length) await User.bulkWrite(activationUpdates);

  return {
    settings: {
      minimumTopUpAmount: settings.minimumTopUpAmount,
      requiredSuccessfulShipments: settings.requiredSuccessfulShipments,
      repCommissionAmount: settings.repCommissionAmount,
      customerReferralReward: settings.customerReferralReward,
      minimumPayoutAmount: settings.minimumPayoutAmount,
      programmeEnabled: settings.programmeEnabled,
    },
    representatives: representatives.map(rep => ({ ...rep.toObject(), staffId: rep.customerId })),
    customers: customerRows,
  };
}

module.exports = {
  getMarketingOverview,
  refreshCustomerActivation,
  refreshShipmentCustomerActivation,
};