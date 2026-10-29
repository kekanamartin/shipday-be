const express = require("express");
const router = express.Router();
const {
  createTransaction,
  getAllTransactions,
  getTotalRevenue,
  getMonthlyRevenue,
  getMonthlyRevenueBreakdown,
} = require("../controller/transaction");

const authMiddleware = require("../middleware/authMiddleware");
const { requireRoles, ADMIN, requirePermission, headOfficeOnly } = require("../middleware/access");

router.post("/create", authMiddleware, requireRoles(ADMIN), createTransaction);
router.get("/all", authMiddleware, getAllTransactions);
router.get("/total-revenue", authMiddleware, headOfficeOnly, requirePermission("revenue.view"), getTotalRevenue);
router.get("/monthly-revenue", authMiddleware, headOfficeOnly, requirePermission("revenue.view"), getMonthlyRevenue);
router.get("/monthly-revenue-breakdown", authMiddleware, headOfficeOnly, requirePermission("revenue.view"), getMonthlyRevenueBreakdown);


module.exports = router;
