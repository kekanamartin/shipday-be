const mongoose = require('mongoose');

// One record per commission or referral reward. The unique (shipment, kind) index means a shipment can
// never pay the same kind of earning twice, however often its status is saved as Delivered.
const earningSchema = new mongoose.Schema({
  earner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['rep_commission', 'customer_referral'], required: true },
  shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', required: true },
  shipmentRef: String, // shipmentId / order number shown to the earner
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['credited', 'reversed'], default: 'credited' },
  reversedReason: String,
  reversedAt: Date,
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

earningSchema.index({ shipment: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('Earning', earningSchema);
