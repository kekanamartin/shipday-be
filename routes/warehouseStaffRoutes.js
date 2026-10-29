const express = require("express");
const router = express.Router();
const controller = require("../controller/warehouseStaff");
const authMiddleware = require("../middleware/authMiddleware");
const { requireRoles, ADMIN, STAFF } = require("../middleware/access");

router.use(authMiddleware);

router.get("/:warehouseId", requireRoles(STAFF), controller.getWarehouseStaff);
router.post("/assign", requireRoles(STAFF), controller.assignStaff);
router.put("/update/:id", requireRoles(STAFF), controller.updateAssignment);
router.delete("/delete/:id", requireRoles(ADMIN), controller.deleteAssignment);

module.exports = router;
