const express = require('express');
const router = express.Router();
const notificationController = require('../controller/notification');
const authMiddleware = require('../middleware/authMiddleware');
const { requireRoles, STAFF } = require('../middleware/access');

router.use(authMiddleware);

router.post('/', requireRoles(STAFF), notificationController.createNotification);
router.get('/', notificationController.getNotifications);
router.patch('/:id/read', notificationController.markAsRead);
router.delete('/clear-all', notificationController.clearAllNotifications);


module.exports = router;
