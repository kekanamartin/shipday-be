const express = require('express');
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { verifyAdmin, verifySuperAdmin } = require("../middleware/roleMiddleware");
const { upload, walletSupportUpload } = require('../middleware/upload');
const { getAllCustomers } = require('../controller/auth');
const courierIntegrationRoutes = require('./courierIntegration');
const {
  createCourierPartner,
  listCourierPartners,
  revokeCourierPartner,
  rotateCourierPartnerKey,
} = require('../controller/courierPartnerAdmin');
const {
  createStoreCredential,
  listStoreCredentials,
  revokeStoreCredential,
  listInvoiceAccounts,
  setInvoiceAccountStatus
} = require('../controller/integrationAdmin');

const {
  getPendingDrivers,
  getAcceptedDrivers,
  getAllDrivers,
  updateDriverStatus,
  updateDriverDetails,
  createShipment,
  assignShipmentToDriver,
  getAssignedShipments,
  getAllShipments,
  getShipmentById,
  getDriversByVehicleType,
  updateShipment,
  deleteShipment,
  downloadWaybill,
  downloadPOD,
  createCustomer,
  deleteDriver,
  updateCustomerStatus,
  updateCustomerWallet,
  getOrderStatuses,
  updateOrderStatus,
  createCustomStatus,
  getAllStatuses,
  getStatusById,
  createStatus,
  updateStatus,
  deleteStatus,
  initializeDefaultStatuses
} = require('../controller/admin');

// Customer handling
router.use('/courier/the-courier-guy', courierIntegrationRoutes);
router.get('/courier-partners', authMiddleware, verifyAdmin, listCourierPartners);
router.post('/courier-partners', authMiddleware, verifyAdmin, createCourierPartner);
router.post('/courier-partners/:partnerId/rotate-key', authMiddleware, verifyAdmin, rotateCourierPartnerKey);
router.delete('/courier-partners/:partnerId', authMiddleware, verifyAdmin, revokeCourierPartner);
router.get('/integrations/store-keys', authMiddleware, verifyAdmin, listStoreCredentials);
router.post('/integrations/store-keys', authMiddleware, verifyAdmin, createStoreCredential);
router.delete('/integrations/store-keys/:credentialId', authMiddleware, verifyAdmin, revokeStoreCredential);
router.get('/invoice-accounts', authMiddleware, verifyAdmin, listInvoiceAccounts);
router.patch('/invoice-accounts/:userId', authMiddleware, verifyAdmin, setInvoiceAccountStatus);

router.get('/customers', authMiddleware, verifyAdmin, getAllCustomers);
router.post('/customers/create', authMiddleware, verifyAdmin, createCustomer);
router.patch('/customers/status', authMiddleware, verifyAdmin, updateCustomerStatus);
router.patch('/customers/wallet', authMiddleware, verifySuperAdmin, walletSupportUpload.single('supportingDocument'), updateCustomerWallet);

// Driver routes
router.get('/drivers/all', authMiddleware, verifyAdmin, getAllDrivers);
router.get('/drivers/pending', authMiddleware, verifyAdmin, getPendingDrivers);
router.get('/drivers/approved', authMiddleware, verifyAdmin, getAcceptedDrivers);
router.get('/drivers/:vehicleType', authMiddleware, verifyAdmin, getDriversByVehicleType);
router.patch('/drivers/status', authMiddleware, verifySuperAdmin, updateDriverStatus);
router.patch('/drivers/details', authMiddleware, verifyAdmin, updateDriverDetails);
router.patch('/drivers/image', authMiddleware, verifyAdmin, upload.single('driverImage'), updateDriverDetails);
router.delete('/drivers/:driverId', authMiddleware, verifySuperAdmin, deleteDriver);

// Shipment routes
// Specific routes first
router.get('/shipments/assign', authMiddleware, verifyAdmin, getAssignedShipments);
router.post('/shipments/assign', authMiddleware, verifyAdmin, assignShipmentToDriver);

router.get('/shipments', authMiddleware, verifyAdmin, getAllShipments);
router.post('/shipments', authMiddleware, verifyAdmin, createShipment);
router.get('/shipments/:shipmentId', authMiddleware, verifyAdmin, getShipmentById);
router.delete('/shipments/:shipmentId', authMiddleware, verifyAdmin, deleteShipment);
router.get('/shipments/:shipmentId/waybill', authMiddleware, downloadWaybill);
router.get('/shipments/:shipmentId/pod', authMiddleware, downloadPOD);

// Order status management
router.get('/orders/statuses', authMiddleware, verifyAdmin, getOrderStatuses);
router.patch('/orders/status', authMiddleware, verifyAdmin, updateOrderStatus);
router.post('/orders/status/custom', authMiddleware, verifySuperAdmin, createCustomStatus);

// Dynamic status management CRUD
router.get('/statuses', authMiddleware, verifyAdmin, getAllStatuses);
router.get('/statuses/:id', authMiddleware, verifyAdmin, getStatusById);
router.post('/statuses', authMiddleware, verifySuperAdmin, createStatus);
router.patch('/statuses/:id', authMiddleware, verifySuperAdmin, updateStatus);
router.delete('/statuses/:id', authMiddleware, verifySuperAdmin, deleteStatus);
router.post('/statuses/initialize', authMiddleware, verifySuperAdmin, initializeDefaultStatuses);

module.exports = router;