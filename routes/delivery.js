const express = require("express");
const router = express.Router();
const deliveryController = require("../controller/delivery");
const authMiddleware = require("../middleware/authMiddleware");
const { requireRoles, STAFF } = require("../middleware/access");

// Company-wide delivery records and figures: staff only
router.use(authMiddleware, requireRoles(STAFF));

router.post("/", deliveryController.createDelivery);
router.get("/", deliveryController.getAllDeliveries);
router.get("/driver", deliveryController.getDriverByShipment);
router.get("/stats", deliveryController.getPendingDeliveryStats);
router.get("/delivered-stats", deliveryController.getDeliveredStats);
router.get("/chart-stats", deliveryController.getChartStats); //  Add this line
router.post("/auto-create", deliveryController.triggerAutoCreateDeliveries);


module.exports = router;
