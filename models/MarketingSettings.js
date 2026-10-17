const mongoose = require('mongoose');

const marketingSettingsSchema = new mongoose.Schema({
  minimumTopUpAmount: { type: Number, min: 0, default: 500 },
  requiredSuccessfulShipments: { type: Number, min: 0, default: 3 },
  // Flat amounts in rand, set by the Super Admin
  repCommissionAmount: { type: Number, min: 0, default: 10 },
  customerReferralReward: { type: Number, min: 0, default: 5 },
  minimumPayoutAmount: { type: Number, min: 0, default: 200 },
  programmeEnabled: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('MarketingSettings', marketingSettingsSchema);