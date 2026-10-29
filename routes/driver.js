const express = require('express');
const router = express.Router();
const {
  requestDriverVerificationCode,
  registerDriver,
  loginDriver,
  getDriverNotifications,
  getDriverShipments,
  getDriverShipmentDetails,
  updateShipmentStatus,
  updateShipmentStatusWithPOD,
  updateDriverFCMToken,
  testPushNotification,
  checkDriver,
  forgotPassword,
  resetPassword,
  createTestNotification,
  cleanupLoginNotifications,
  debugNotifications,
  getDriverEarnings,
  getUnallocatedShipments,
  claimShipment,
  linkShipmentWithBarcode,
  getDriverRoute,
  optimizeDriverRoute,
  getDriverReferences,
  getDriverNavigation,
  searchShipments,
} = require('../controller/driver');
const { upload, podUpload, driverRegistrationUpload } = require('../middleware/upload');
const driverAuth = require('../middleware/driverAuth');
const authMiddleware = require('../middleware/authMiddleware');
const { requireRoles, STAFF } = require('../middleware/access');

// Testing and clean-up tools: dashboard staff only
const staffOnly = [authMiddleware, requireRoles(STAFF)];

// Driver registration (collect details and send OTP)
router.post('/register', driverRegistrationUpload, registerDriver);

// Driver verification (confirm OTP and create account)
router.post('/request-verification', requestDriverVerificationCode);

// Driver login
router.post('/login', loginDriver);

// Get driver notifications
router.get('/notifications/:driverId', driverAuth, getDriverNotifications);

// Get driver's assigned shipments
router.get('/shipments/:driverId', driverAuth, getDriverShipments);

// Get specific shipment details
router.get('/shipments/:driverId/:shipmentId', driverAuth, getDriverShipmentDetails);

// Update shipment status
router.put('/update-shipment-status', driverAuth, updateShipmentStatus);

// Update shipment status with POD (signature + photo + location)
router.put('/update-shipment-status-pod', podUpload.fields([
  { name: 'signature', maxCount: 1 },
  { name: 'photo', maxCount: 1 }
]), driverAuth, updateShipmentStatusWithPOD); // after the upload so driverId in the form is readable

// Update driver FCM token
router.put('/fcm-token/:driverId', driverAuth, updateDriverFCMToken);

// Test push notification
router.post('/test-notification/:driverId', staffOnly, testPushNotification);

// Check if driver exists
router.get('/check/:driverId', checkDriver);

// Forgot password
router.post('/forgot-password', forgotPassword);

// Reset password
router.post('/reset-password', resetPassword);

// Create test notification
router.post('/create-test-notification/:driverId', staffOnly, createTestNotification);

// Cleanup login notifications
router.delete('/cleanup-login-notifications', staffOnly, cleanupLoginNotifications);

// Debug notifications
router.get('/debug-notifications/:driverId', staffOnly, debugNotifications);

// Get driver earnings
router.get('/earnings/:driverId', driverAuth, getDriverEarnings);

// Get unallocated shipments for claiming
router.get('/unallocated-shipments/:driverId', driverAuth, getUnallocatedShipments);

// Claim a shipment
router.post('/claim-shipment', driverAuth, claimShipment);

// Link shipment with barcode
router.post('/link-shipment', driverAuth, linkShipmentWithBarcode);

// Get driver route
router.get('/route/:driverId', driverAuth, getDriverRoute);

// Optimize driver route
router.post('/optimize-route/:driverId', driverAuth, optimizeDriverRoute);

// Get driver references
router.get('/references/:driverId', driverAuth, getDriverReferences);

// Get navigation data for a specific shipment
router.get('/navigation/:driverId/:shipmentId', driverAuth, getDriverNavigation);

// Search shipments (for claim screen global search)
router.get('/search-shipments/:driverId', driverAuth, searchShipments);

module.exports = router;