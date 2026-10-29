const express = require('express');
const router = express.Router();
const { submitContactForm, getAllMessages } = require('../controller/contact');
const authMiddleware = require('../middleware/authMiddleware');
const { requireRoles, ADMIN } = require('../middleware/access');

router.post('/', submitContactForm);
router.get('/', authMiddleware, requireRoles(ADMIN), getAllMessages);

module.exports = router;
