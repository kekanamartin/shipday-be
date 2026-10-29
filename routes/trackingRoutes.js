const express = require("express");
const router = express.Router();
const { createTracking,getAllTracking } = require("../controller/tracking");
const authMiddleware = require("../middleware/authMiddleware");
const { requireRoles, STAFF } = require("../middleware/access");

// Delivery routes planned by staff (public parcel tracking is /shipments/track)
router.use(authMiddleware, requireRoles(STAFF));

router.post("/", createTracking);
router.get("/", getAllTracking); 


module.exports = router;
