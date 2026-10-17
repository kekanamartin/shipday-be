const express = require('express');
const router = express.Router();
const roleController = require('../controller/role');
const authMiddleware = require('../middleware/authMiddleware');
const { verifyAdmin } = require('../middleware/roleMiddleware');

// POST create role
router.post('/', authMiddleware, verifyAdmin, roleController.createRole);

// GET all roles
router.get('/', roleController.getRoles);
// PUT update role
router.put('/:id', authMiddleware, verifyAdmin, roleController.updateRole);

//  DELETE role
router.delete('/:id', authMiddleware, verifyAdmin, roleController.deleteRole);


module.exports = router;
