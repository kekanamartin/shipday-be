const express = require('express');
const router = express.Router();
const VerificationCode = require('../models/VerificationCode');
const User = require('../models/User');
const { signPasswordToken } = require('../services/accountTokens');

const MAX_ATTEMPTS = 5;

// POST /api/verification/verify-code — "forgot password": check the emailed code and
// hand back a 15-minute link token for setting the new password
router.post('/verify-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim().toUpperCase();

  if (!email || !code) {
    return res.status(400).json({ message: "Email and code are required" });
  }

  try {
    const record = await VerificationCode.findOne({ email });

    if (!record) {
      return res.status(400).json({ message: "Verification code not found" });
    }

    if (record.expiresAt < new Date() || record.attempts >= MAX_ATTEMPTS) {
      await VerificationCode.deleteOne({ email });
      return res.status(400).json({ message: "This code has expired. Please ask for a new one." });
    }

    if (record.code !== code) {
      await VerificationCode.updateOne({ email }, { $inc: { attempts: 1 } });
      return res.status(400).json({ message: "Invalid verification code" });
    }

    await VerificationCode.deleteOne({ email });
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Verification code not found" });

    return res.status(200).json({ message: "Code verified successfully", resetToken: signPasswordToken(user, 'reset') });
  } catch (error) {
    console.error("Error verifying code:", error);
    res.status(500).json({ message: "Server error verifying code" });
  }
});

module.exports = router;
