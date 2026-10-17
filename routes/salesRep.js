const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { verifySalesRep } = require('../middleware/roleMiddleware');
const { getDashboard, createCustomer, updateBankDetails, requestPayout } = require('../controller/salesRep');

router.use(authMiddleware, verifySalesRep);
router.get('/dashboard', getDashboard);
router.post('/customers', createCustomer);
router.put('/bank', updateBankDetails);
router.post('/payouts', requestPayout);

module.exports = router;
