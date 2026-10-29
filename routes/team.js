const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/access');
const team = require('../controller/team');

const router = express.Router();
router.use(authMiddleware);

router.get('/', requirePermission('team.view'), team.listTeam);
router.post('/', requirePermission('team.manage'), team.addMember);
router.patch('/:id', requirePermission('team.manage'), team.updateMember);
router.post('/:id/resend-invite', requirePermission('team.manage'), team.resendInvite);

module.exports = router;
