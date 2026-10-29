const express = require('express');
const router = express.Router();
const {
  generateShipments,
  getAllShipments,
  updateOrderStatus,
  getShipmentMetrics,
  getShipmentStatusBreakdown,
  trackShipment
} = require('../controller/shipment');
const { createShipment, getShipmentById, updateShipment, downloadWaybill, downloadPOD } = require('../controller/admin');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/access');

// Shipment routes
// Company-wide tools and figures: head office only
router.post('/generate', authMiddleware, requirePermission('dashboard.company'), requirePermission('shipments.edit'), generateShipments);
router.patch('/orders/status', authMiddleware, requirePermission('dashboard.company'), requirePermission('shipments.edit'), updateOrderStatus);
router.get('/metrics', authMiddleware, requirePermission('dashboard.company'), getShipmentMetrics);
router.get('/status-breakdown', authMiddleware, requirePermission('dashboard.company'), getShipmentStatusBreakdown);
router.get('/track/:trackingNumber', trackShipment); // Public tracking route
router.get('/', authMiddleware, getAllShipments);
router.post('/', authMiddleware, createShipment);
router.get('/:shipmentId', authMiddleware, getShipmentById); // checks access itself
router.put('/:shipmentId', authMiddleware, requirePermission('shipments.edit'), updateShipment); // can set status; hub teams only in their area
router.get('/:shipmentId/waybill', authMiddleware, downloadWaybill);
router.get('/:shipmentId/pod', authMiddleware, downloadPOD);

module.exports = router;