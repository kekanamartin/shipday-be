const express = require("express");
const router = express.Router();

const {
  addNewStaff,
  getAllStaff,
  assignTaskToStaff,
  getAssignedTasks,
  updateRoute,
  updateStaff,
  deleteRoute,
  deleteStaff,
  getRoutesGroupedByStaff,
  getDriverByRoute,
  getDriverByName,

} = require("../controller/staff");


const authMiddleware = require("../middleware/authMiddleware");
const { verifySuperAdmin } = require("../middleware/roleMiddleware");
const { requireRoles, STAFF } = require("../middleware/access");

router.use(authMiddleware);

router.post("/add", requireRoles(STAFF), addNewStaff);
router.get("/all", requireRoles(STAFF), getAllStaff);
router.post("/assign-task/:staffId", requireRoles(STAFF), assignTaskToStaff);
router.get("/:id/tasks", requireRoles(STAFF), getAssignedTasks);
router.put("/:staffId/update-task/:routeId", requireRoles(STAFF), updateRoute);
router.put("/update/:id", verifySuperAdmin, updateStaff); //  Protected
router.delete("/delete/:id", verifySuperAdmin, deleteStaff); // Protected

router.delete("/:staffId/remove-task/:routeId", requireRoles(STAFF), deleteRoute);


router.get("/grouped-routes", requireRoles(STAFF), getRoutesGroupedByStaff); //  NEW ENDPOINT
router.get("/driver-by-route", requireRoles(STAFF), getDriverByRoute);
router.get("/driver-by-name", requireRoles(STAFF), getDriverByName); //  NEW ENDPOINT





module.exports = router;
