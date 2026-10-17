const Earning = require('../models/Earning');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { getSettings, ensureReferralCode, resolveReferrer, roundRand } = require('../services/referralService');

// "Thabo N." — friends are never shown in full to the person who referred them
const shortName = (user) => {
  const parts = String(user.fullName || user.companyName || 'Customer').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0];
};

// Customer's own referral programme summary
exports.getMyReferrals = async (req, res) => {
  try {
    const user = req.user;
    const [code, settings, friends, earnings] = await Promise.all([
      ensureReferralCode(user),
      getSettings(),
      User.find({ 'referredBy.user': user._id, 'referredBy.kind': 'Customer', role: 'Customer' })
        .select('fullName companyName email createdAt').sort({ createdAt: -1 }),
      Earning.find({ earner: user._id, kind: 'customer_referral' }).sort({ createdAt: -1 })
        .select('amount status shipmentRef customer createdAt'),
    ]);

    const shippedIds = new Set(
      (await Shipment.find({
        status: 'Delivered',
        $or: [{ customer: { $in: friends.map((f) => f._id) } }, { 'senderDetails.email': { $in: friends.map((f) => f.email) } }],
      }).select('customer senderDetails.email'))
        .map((s) => (s.customer ? String(s.customer) : String(friends.find((f) => f.email === s.senderDetails?.email)?._id)))
    );

    const credited = earnings.filter((e) => e.status === 'credited');
    res.json({
      referralCode: code,
      rewardPerShipment: roundRand(settings.customerReferralReward),
      programmeEnabled: settings.programmeEnabled,
      stats: {
        friendsSignedUp: friends.length,
        friendsShipped: friends.filter((f) => shippedIds.has(String(f._id))).length,
        rewardsEarned: roundRand(credited.reduce((sum, e) => sum + e.amount, 0)),
        rewardedShipments: credited.length,
      },
      friends: friends.slice(0, 50).map((f) => ({
        name: shortName(f),
        joinedAt: f.createdAt,
        shipped: shippedIds.has(String(f._id)),
      })),
      recentRewards: earnings.slice(0, 10).map((e) => ({
        amount: e.amount, status: e.status, shipmentRef: e.shipmentRef, date: e.createdAt,
      })),
    });
  } catch (err) {
    console.error('Referral summary error:', err);
    res.status(500).json({ message: 'Could not load your referrals' });
  }
};

// Public: lets the sign-up page show "Invited by Thabo N." for a valid code
exports.validateCode = async (req, res) => {
  try {
    const referrer = await resolveReferrer(req.params.code);
    if (!referrer) return res.status(404).json({ valid: false });
    const user = await User.findById(referrer._id).select('fullName companyName');
    res.json({ valid: true, referrerName: shortName(user) });
  } catch (err) {
    res.status(500).json({ valid: false });
  }
};
