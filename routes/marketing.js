const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { verifySuperAdmin } = require('../middleware/roleMiddleware');
const {
  getMarketingDashboard,
  updateMarketingSettings,
  assignSalesRepresentative,
  updateRep,
  markPayoutPaid,
  rejectPayout,
  reverseEarning,
  exportEarnings,
} = require('../controller/marketing');

// The referral and commission programme is managed by Super Admins only
router.use(authMiddleware, verifySuperAdmin);
router.get('/', getMarketingDashboard);
router.put('/settings', updateMarketingSettings);
router.patch('/customers/:customerId/representative', assignSalesRepresentative);
router.patch('/reps/:repId', updateRep);
router.post('/payouts/:payoutId/pay', markPayoutPaid);
router.post('/payouts/:payoutId/reject', rejectPayout);
router.post('/earnings/:earningId/reverse', reverseEarning);
router.get('/earnings/export', exportEarnings);

module.exports = router;
