const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/access');
const hub = require('../controller/hub');

const router = express.Router();
router.use(authMiddleware);

router.get('/', requirePermission('hubs.view'), hub.listHubs);
router.get('/next-code', requirePermission('hubs.create'), hub.previewHubCode);
router.post('/', requirePermission('hubs.create'), hub.createHub);
router.get('/:id/dashboard', requirePermission('dashboard.hub', 'hubs.view'), hub.getHubDashboard);
router.get('/:id', requirePermission('hubs.view'), hub.getHub);
router.put('/:id', requirePermission('hubs.edit'), hub.updateHub);
router.post('/:id/status', requirePermission('hubs.create', 'hubs.edit', 'hubs.approve'), hub.changeHubStatus); // checks the action itself
router.delete('/:id', requirePermission('hubs.create', 'hubs.edit'), hub.deleteDraftHub);

module.exports = router;
