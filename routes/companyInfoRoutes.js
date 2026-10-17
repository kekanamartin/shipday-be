const express = require('express');
const router = express.Router();
const { getCompanyInfo, saveCompanyInfo } = require('../controller/companyInfo');
const authMiddleware = require('../middleware/authMiddleware');
const { verifyAdmin } = require('../middleware/roleMiddleware');

router.get('/', getCompanyInfo);
router.post('/', authMiddleware, verifyAdmin, saveCompanyInfo);

module.exports = router;
