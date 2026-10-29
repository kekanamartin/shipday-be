const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/access');
const permission = require('../controller/permission');

const router = express.Router();
router.use(authMiddleware);

router.get('/', requirePermission('roles.manage'), permission.getPermissionGrid);
router.put('/:role', requirePermission('roles.manage'), permission.saveRolePermissions);

module.exports = router;
