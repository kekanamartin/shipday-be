// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const { createPaymentIntent, initiatePayFastPayment, payWithWallet, initiateWalletTopup, confirmSandboxPayment, handlePayFastNotify } = require('../controller/payment');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/create-payment-intent', authMiddleware, createPaymentIntent);
router.post('/payfast', authMiddleware, initiatePayFastPayment);
router.post('/wallet', authMiddleware, payWithWallet);
router.post('/topup', authMiddleware, initiateWalletTopup);
router.post('/notify', handlePayFastNotify); // Called by PayFast's servers; checked inside
router.post('/confirm-sandbox', authMiddleware, confirmSandboxPayment);

module.exports = router;
