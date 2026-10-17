const mongoose = require('mongoose');

// A Sales Representative's request to be paid their commission by EFT.
// The amount is held (debited from the rep's wallet) when requested and returned if rejected.
const payoutSchema = new mongoose.Schema({
  rep: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['requested', 'paid', 'rejected'], default: 'requested', index: true },
  bank: {
    bankName: String,
    accountHolder: String,
    accountNumber: String,
    branchCode: String,
    accountType: String,
  },
  reference: String, // EFT reference entered when marked paid
  note: String, // rejection reason
  processedAt: Date,
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Payout', payoutSchema);
