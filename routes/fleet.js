const express = require("express");
const router = express.Router();
const { createVehicle, getAllVehicles, getVehicleById } = require("../controller/fleet");
const authMiddleware = require("../middleware/authMiddleware");
const { requireRoles, STAFF } = require("../middleware/access");

router.use(authMiddleware, requireRoles(STAFF));

router.post("/add", createVehicle);
router.get("/all", getAllVehicles);
router.get("/:id", getVehicleById); 


module.exports = router;
