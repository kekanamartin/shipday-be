const express = require('express');
const router = express.Router();
const walletController = require('../controller/wallet');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission, headOfficeOnly } = require('../middleware/access');

// Get wallet (your own, or any wallet for staff)
router.get('/:userId', authMiddleware, walletController.getWallet);

// Manual credit/debit: head office with the "Credit or debit customer wallets" permission.
// Customers top up through PayFast.
router.post('/transaction', authMiddleware, headOfficeOnly, requirePermission('wallets.adjust'), walletController.addTransaction);

module.exports = router;
