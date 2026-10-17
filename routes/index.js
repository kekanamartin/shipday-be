const express = require("express");
const router = express.Router();

// Import routes
const authRoutes = require('./auth');
const authController = require('../controller/auth'); // Import controller for direct route
const adminRoutes = require('./admin');
const shipmentsRoutes = require('./shipments');
const verificationRoutes = require('./verification');
const paymentRoutes = require('./paymentRoutes');
const staffRoutes = require("./staff");
const warehouseRoutes = require('./warehouse');
const warehouseStaffRoutes = require('./warehouseStaffRoutes');
const transactionRoutes = require("./transaction");
const orderRoutes = require('./orderRoutes');
const fleetRoutes = require('./fleet');
const trackingRoutes = require("./trackingRoutes");
const deliveryRoutes = require("./delivery");
const roleRoutes = require('./roleRoutes');
const companyInfoRoutes = require('./companyInfoRoutes');
const notificationRoutes = require('./notificationRoutes');
const walletRoutes = require('./walletRoutes');
const driverRoutes = require('./driver');
const pricingRoutes = require('./pricingRoutes');
const contactRoutes = require('./contactRoutes');
const marketingRoutes = require('./marketing');
const storeIntegrationRoutes = require('./storeIntegration');
const courierPartnerApiRoutes = require('./courierPartnerApi');

// Use routes
router.get('/user', authController.getUserByEmail); // Fix for missing /api/user route
router.get('/user/:id', authController.getUserById); // Get user by _id
router.get('/customers', authController.getAllCustomers); // Fix for missing /api/customers route
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/pricing', pricingRoutes); // New Route
router.use('/v1/store', storeIntegrationRoutes);
router.use('/v1/courier-partner', courierPartnerApiRoutes);
router.use('/marketing', marketingRoutes);
router.use('/sales-rep', require('./salesRep'));
router.use('/referrals', require('./referral'));
router.use('/shipments', shipmentsRoutes);
router.use('/verification', verificationRoutes);
router.use('/payments', paymentRoutes);
router.use('/staff', staffRoutes);
router.use('/warehouse', warehouseRoutes);
router.use('/warehouse-staff', warehouseStaffRoutes);
router.use('/transactions', transactionRoutes);
router.use('/orders', orderRoutes);
router.use('/fleet', fleetRoutes);
router.use('/trackings', trackingRoutes);
router.use('/deliveries', deliveryRoutes);
router.use('/roles', roleRoutes);
router.use('/company-info', companyInfoRoutes);
router.use('/notifications', notificationRoutes);
router.use('/wallets', walletRoutes);
router.use('/drivers', driverRoutes);
router.use('/contact', contactRoutes);

module.exports = router;