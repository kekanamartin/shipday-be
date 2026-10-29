
const express = require('express');
const router = express.Router();
const { createOrder, getOrderById, deleteOrderById, getAllOrders, updateOrderStatus, getOrdersByPhone, getOrdersWithTracking } = require('../controller/order');
const { getOrderDetails, getShipmentById } = require('../controller/admin');
const authMiddleware = require('../middleware/authMiddleware');
const { requireRoles, ADMIN, STAFF } = require('../middleware/access');

// Orders are an internal, staff-only tool
router.use(authMiddleware);

router.post('/', requireRoles(STAFF), createOrder);
router.get('/with-tracking', requireRoles(STAFF), getOrdersWithTracking);
router.get('/by-phone/:phone', requireRoles(STAFF), getOrdersByPhone);
router.get('/details/:orderId', requireRoles(STAFF), getOrderDetails);
router.get('/shipments/:shipmentId', getShipmentById); // checks access itself
router.get('/:id', requireRoles(STAFF), getOrderById);
router.get('/', requireRoles(STAFF), getAllOrders);
router.put('/:id/status', requireRoles(STAFF), updateOrderStatus);
router.delete('/:id', requireRoles(ADMIN), deleteOrderById);



module.exports = router;
