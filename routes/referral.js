const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { verifyCustomer } = require('../middleware/roleMiddleware');
const { getMyReferrals, validateCode } = require('../controller/referral');

router.get('/validate/:code', validateCode);
router.get('/me', authMiddleware, verifyCustomer, getMyReferrals);

module.exports = router;
