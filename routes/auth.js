const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  requestVerificationCode,
  logoutUser,
  resetPassword,
  setPassword,
  checkPasswordLink,
  verifyCode,
  updateUserProfile,
  completeProfileSetup,
  getMyProfile,
  updateMyProfile,
  getUserByEmail,
  getAllCustomers,
  googleLogin,
  createAdminUser,
  deleteUser,
  updateUserByAdmin // Import this
} = require('../controller/auth');

const { requirePermission } = require('../middleware/access');
const authMiddleware = require('../middleware/authMiddleware');
const { verifySuperAdmin } = require('../middleware/roleMiddleware');

// Authentication routes
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/google-login', googleLogin);
router.post('/create-admin', authMiddleware, verifySuperAdmin, createAdminUser); // Protected route
router.post('/logout', authMiddleware, logoutUser);
router.post('/reset-password', resetPassword);
router.get('/set-password', checkPasswordLink);
router.post('/set-password', setPassword);
router.get('/access', authMiddleware, require('../controller/permission').getMyAccess);
router.delete('/delete/:id', authMiddleware, verifySuperAdmin, deleteUser); // Delete user route
router.put('/update-user/:id', authMiddleware, verifySuperAdmin, updateUserByAdmin); // Update user route

// Verification routes
router.post('/verification/request', requestVerificationCode);
router.post('/verification/verify', verifyCode);

// User profile routes
router.get('/profile', authMiddleware, getUserByEmail);
router.get('/me', authMiddleware, getMyProfile);
router.patch('/me', authMiddleware, updateMyProfile);
router.patch('/profile', authMiddleware, updateUserProfile);
router.post('/profile/setup', authMiddleware, completeProfileSetup);

// This matches the frontend call /api/user?email=... if mounted at /api
// But frontend calls /api/user directly, while authRoutes is at /api/auth
// We need to see where to add it. Since router is mounted at /api/auth, this would be /api/auth/user
// We should add a root level user route in index.js OR add a specific route here if the frontend calls /api/auth/user.
// BUT the log said /api/user. So I need to add it to index.js or create a userRoutes.js.
// For now, I will add it to index.js as a quick fix or create a transform.

// Customer routes
router.get('/customers', authMiddleware, requirePermission('customers.view'), getAllCustomers);

module.exports = router;