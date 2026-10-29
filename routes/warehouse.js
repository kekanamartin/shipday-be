const express = require("express");
const router = express.Router();
const warehouseController = require("../controller/warehouse");
const authMiddleware = require("../middleware/authMiddleware");
const { requireRoles, ADMIN, STAFF } = require("../middleware/access");

router.use(authMiddleware);

// POST /api/warehouse/add
router.post("/add", requireRoles(STAFF), warehouseController.addWarehouse);

// GET /api/warehouse/all
router.get("/all", requireRoles(STAFF), warehouseController.getAllWarehouses);
router.delete("/delete/:id", requireRoles(ADMIN), warehouseController.deleteWarehouse);
router.put("/update/:id", requireRoles(STAFF), warehouseController.updateWarehouse);


module.exports = router;
