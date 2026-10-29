const User = require('../models/User');
const VerificationCode = require('../models/VerificationCode');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const sendMail = require("../utils/mail");
const Token = require('../models/Token');
const Wallet = require('../models/Wallet');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { resolveReferrer, referralRecord, generateReferralCode, SALES_REP_ROLE } = require('../services/referralService');
const { verifyGoogleAccessToken, GoogleAuthError } = require('../utils/googleAuth');
const { isStaff, isHubUser } = require('../middleware/access');
const Hub = require('../models/Hub');
const { permissionsForRole } = require('../services/permissionService');
const { verifyPasswordToken, signPasswordToken, PasswordTokenError } = require('../services/accountTokens');

// Password strength regex
const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;

//  Email validator
const validateEmail = (email) => {
  const sanitized = String(email).toLowerCase().trim();
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(sanitized) ? sanitized : null;
};

//  Customer ID validator
const validateCustomerId = (id) => {
  return /^CUST\d{3,}$/.test(id) ? id : null;
};

// Generate and send verification code
const sendVerificationCode = async (email) => {
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min expiry

  await VerificationCode.findOneAndUpdate(
    { email },
    { code, expiresAt, attempts: 0 },
    { upsert: true, new: true }
  );

  const text = `Your verification code is: ${code}. It will expire in 15 minutes.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
      <h2 style="color: #0f172a; text-align: center;">Verification Code</h2>
      <p style="font-size: 16px; color: #4b5563;">Hello,</p>
      <p style="font-size: 16px; color: #4b5563;">Your verification code is:</p>
      <div style="font-size: 32px; font-weight: bold; color: #fabb05; text-align: center; padding: 20px; margin: 20px 0; background: #f8fafc; border-radius: 8px; letter-spacing: 5px;">
        ${code}
      </div>
      <p style="font-size: 14px; color: #9ca3af; text-align: center;">This code will expire in 15 minutes.</p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
      <p style="font-size: 12px; color: #9ca3af; text-align: center;">If you didn't request this code, please ignore this email.</p>
    </div>
  `;

  await sendMail(email, "Your Verification Code - ShipDay", text, html);
};

// Helper to create notification
const createNotification = async (userId, title, message, type) => {
  try {
    const notification = new Notification({
      userId,
      title,
      message,
      type,
    });
    await notification.save();
  } catch (err) {
    console.error("Notification creation failed:", err);
  }
};

// Generate unique customerId
const generateCustomerId = async () => {
  const lastUser = await User.findOne({ customerId: /^CUST/ })
    .sort({ customerId: -1 })
    .collation({ locale: "en_US", numericOrdering: true });

  let nextNumber = 1;
  if (lastUser && lastUser.customerId) {
    const match = lastUser.customerId.match(/^CUST(\d+)$/);
    if (match) {
      nextNumber = parseInt(match[1], 10) + 1;
    }
  }

  const padded = String(nextNumber).padStart(3, '0');
  return `CUST${padded}`;
};

// Generate unique Sales Representative ID (REP001, REP002, ...)
const generateRepId = async () => {
  let next = (await User.countDocuments({ customerId: /^REP\d+$/ })) + 1;
  // Counting can collide after deletions, so step forward until the ID is free
  while (await User.exists({ customerId: `REP${String(next).padStart(3, '0')}` })) next += 1;
  return `REP${String(next).padStart(3, '0')}`;
};

// Generate unique Admin ID
const generateAdminId = async () => {
  const count = await User.countDocuments({ customerId: /^ADMIN/ });
  const nextNumber = count + 1; // e.g. if 1 exists (ADMIN001), next is 2
  const padded = String(nextNumber).padStart(3, '0');
  return `ADMIN${padded}`;
};

// Customers must choose an account type and provide name/phone before using the dashboard
const needsProfileSetup = (user) => {
  if ((user.role || 'Customer') !== 'Customer') return false;
  if (user.profileCompleted === true) return false;
  if (user.profileCompleted === false) return true;
  // Legacy accounts: prompt only when details are missing
  return !user.fullName || !user.phone || user.$isDefault('accountType')
    || (user.accountType === 'Business' && !user.companyName);
};

const buildAuthUser = (user) => ({
  email: user.email,
  fullName: user.fullName,
  customerId: user.customerId,
  role: user.role || 'Customer',
  image: user.image,
  phone: user.phone || '',
  accountType: user.accountType,
  companyName: user.companyName || '',
  needsProfileSetup: needsProfileSetup(user),
  hub: user.hub || null,
});

// The signed-in user plus what they're allowed to do, for the menu
const buildSignedInUser = async (user) => ({
  ...buildAuthUser(user),
  permissions: await permissionsForRole(user.role),
});

// Reasons an account can't sign in right now (null when it can)
const signInBlock = async (user) => {
  if (user.status === 'Disabled') return 'This account has been disabled. Please contact ShipDay.';
  // Older 'Retail Hub' logins made before hubs existed keep working until they're linked to a hub
  if (isHubUser(user) && !(user.role === 'Retail Hub' && !user.hub)) {
    const hub = user.hub ? await Hub.findById(user.hub).select('name status') : null;
    if (!hub) return "Your login isn't linked to a hub yet. Please contact head office.";
    if (hub.status === 'Suspended') return `${hub.name} has been suspended, so its logins are paused. Please contact head office.`;
    if (hub.status !== 'Active') return `${hub.name} is waiting for approval. You can sign in once head office approves it.`;
  }
  return null;
};

// South African numbers: accepts 082 123 4567, +27 82 123 4567, 27821234567 or 0027 82 123 4567,
// and stores them in the 10-digit local format (0821234567) used across existing records
const saPhoneRegex = /^0[1-8]\d{8}$/;
const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/[\s().-]/g, '');
  const local = digits.replace(/^(?:\+27|0027|27)(?=\d{9}$)/, '0');
  return local;
};

// Request verification code
const requestVerificationCode = async (req, res) => {
  const { email, source } = req.body;
  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail) return res.status(400).json({ message: 'Valid email is required' });

  try {
    const userExists = await User.findOne({ email: sanitizedEmail });

    if (source === 'register' && userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    if (source === 'forgot' && !userExists) {
      return res.status(404).json({ message: 'User not found' });
    }

    await sendVerificationCode(sanitizedEmail);
    res.status(200).json({ message: 'Verification code sent' });
  } catch (err) {
    console.error('Email error:', err.message);

    // Check for development fallback
    if (err.message && err.message.startsWith('SMTP_FAIL_FALLBACK_OK')) {
      const code = err.message.split(':')[1];
      return res.status(200).json({
        message: 'Email service delayed. Code logged to console (DEV MODE).',
        dev_code: code // For easier testing in dev tools
      });
    }

    res.status(500).json({ message: 'Failed to send verification code. SMTP connect timed out.' });
  }
};

// Verify code
const verifyCode = async (req, res) => {
  const { email, code } = req.body;
  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail || !code)
    return res.status(400).json({ message: 'Valid email and code are required' });

  try {
    const record = await VerificationCode.findOne({ email: sanitizedEmail });
    if (!record)
      return res.status(400).json({ message: 'Verification code not found' });

    // Five wrong guesses use the code up
    if (record.expiresAt < new Date() || (record.attempts || 0) >= 5) {
      await VerificationCode.deleteOne({ email: sanitizedEmail });
      return res.status(400).json({ message: 'Verification code expired' });
    }

    if (record.code !== code.toUpperCase()) {
      await VerificationCode.updateOne({ email: sanitizedEmail }, { $inc: { attempts: 1 } });
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    await VerificationCode.deleteOne({ email: sanitizedEmail });
    res.status(200).json({ message: 'Verification successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Register user
const registerUser = async (req, res) => {
  const { email, password, code, referralCode } = req.body;
  const sanitizedEmail = validateEmail(email);

  if (!sanitizedEmail || !password || !code)
    return res.status(400).json({ message: 'Valid email, password, and code are required' });

  if (!strongPasswordRegex.test(password)) {
    return res.status(400).json({
      message:
        'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.',
    });
  }

  try {
    const existingUser = await User.findOne({ email: sanitizedEmail });
    if (existingUser)
      return res.status(400).json({ message: 'User already exists' });

    const record = await VerificationCode.findOne({ email: sanitizedEmail });
    if (!record)
      return res.status(400).json({ message: 'Verification code not found' });

    // Five wrong guesses use the code up
    if (record.expiresAt < new Date() || (record.attempts || 0) >= 5) {
      await VerificationCode.deleteOne({ email: sanitizedEmail });
      return res.status(400).json({ message: 'Verification code expired' });
    }

    if (record.code !== code.toUpperCase()) {
      await VerificationCode.updateOne({ email: sanitizedEmail }, { $inc: { attempts: 1 } });
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    const customerId = await generateCustomerId();
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      email: sanitizedEmail,
      password: hashedPassword,
      customerId,
      profileCompleted: false,
    });

    const referrer = referralCode ? await resolveReferrer(referralCode, { email: sanitizedEmail }) : null;
    if (referrer) user.referredBy = referralRecord(referrer, 'link');

    await user.save();

    // Now delete the verification code since the save was successful
    await VerificationCode.deleteOne({ email: sanitizedEmail });

    await createNotification(
      user._id,
      "Welcome to SwiftShip",
      `Your account (${sanitizedEmail}) has been successfully registered.`,
      "registration"
    );

    // Send notification to support (Wrap in try/catch to prevent failing the entire registration)
    try {
      await sendMail(
        "support@shipday.co.za",
        "New User Registration",
        `A new user has registered with email: ${sanitizedEmail}`
      );
    } catch (mailError) {
      console.error("Failed to send admin notification email:", mailError.message);
    }

    // Auto-login functionality
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role || 'Customer' },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    const tokenDoc = await Token.create({ userId: user._id, token });
    tokenDoc.expiresAt = new Date(tokenDoc.createdAt.getTime() + 2 * 60 * 60 * 1000); // 2 hours
    await tokenDoc.save();

    res.status(201).json({
      message: 'User registered successfully',
      customerId,
      token,
      user: buildAuthUser(user)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Login user
const loginUser = async (req, res) => {
  const { email, password } = req.body;

  const sanitizedEmail = validateEmail(email);

  if (!sanitizedEmail || !password)
    return res.status(400).json({ message: 'Valid email and password are required' });

  try {
    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) return res.status(401).json({ message: 'Incorrect email or password.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Incorrect email or password.' });

    const blocked = await signInBlock(user);
    if (blocked) return res.status(403).json({ message: blocked });

    const token = jwt.sign({ id: user._id, email: user.email, role: user.role || 'Customer' }, process.env.JWT_SECRET, { expiresIn: '2h' });

    // create Token document
    const tokenDoc = await Token.create({ userId: user._id, token });

    //  Set expiresAt relative to createdAt
    tokenDoc.expiresAt = new Date(tokenDoc.createdAt.getTime() + 2 * 60 * 60 * 1000); // 2 hours
    await tokenDoc.save();



    res.status(200).json({
      message: 'Login successful',
      token,
      user: await buildSignedInUser(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Login error' });
  }
};

//  Logout user
const logoutUser = async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token missing" });

  try {
    await Token.deleteOne({ token });
    res.status(200).json({ message: "Logged out successfully" });
  } catch (err) {
    console.error(err);
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

// Reset password — needs the short-lived link issued after the emailed code is checked
const resetPassword = async (req, res) => {
  const { newPassword, resetToken } = req.body;

  if (!resetToken || !newPassword) {
    return res.status(400).json({ message: 'Please start again from "Forgot password".' });
  }
  req.body = { token: resetToken, password: newPassword };
  return setPassword(req, res);
};

// Set a password from an invitation or reset link: POST /api/auth/set-password { token, password }
const setPassword = async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ message: 'Choose a password.' });
  if (!strongPasswordRegex.test(password)) {
    return res.status(400).json({
      message: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.',
    });
  }

  try {
    const { user, purpose } = await verifyPasswordToken(token);
    if (user.status === 'Disabled') return res.status(403).json({ message: 'This account has been disabled. Please contact ShipDay.' });

    user.password = await bcrypt.hash(password, 10);
    if (!user.invite?.acceptedAt) user.invite = { ...(user.invite || {}), acceptedAt: new Date() };
    await user.save();
    await Token.deleteMany({ userId: user._id });

    await createNotification(
      user._id,
      purpose === 'invite' ? 'Welcome to ShipDay' : 'Password Reset',
      purpose === 'invite' ? 'Your password has been set. Welcome aboard.' : 'Your account password has been successfully reset.',
      'forgot-password'
    );

    res.status(200).json({
      message: purpose === 'invite' ? 'Your password is set. You can sign in now.' : 'Password reset successful. Please log in again.',
      email: user.email,
    });
  } catch (err) {
    if (err instanceof PasswordTokenError) return res.status(400).json({ message: err.message });
    console.error('Set password error:', err);
    res.status(500).json({ message: 'Server error while setting your password' });
  }
};

// Check an invitation link before showing the form: GET /api/auth/set-password?token=
const checkPasswordLink = async (req, res) => {
  try {
    const { user, purpose } = await verifyPasswordToken(req.query.token);
    res.json({ email: user.email, fullName: user.fullName || '', role: user.role, purpose });
  } catch (err) {
    if (err instanceof PasswordTokenError) return res.status(400).json({ message: err.message });
    res.status(500).json({ message: 'Server error' });
  }
};

//  Update user profile
const updateUserProfile = async (req, res) => {
  const {
    email,
    fullName,
    nickName,
    dob,
    phone,
    gender,
    image,
    accountType,
    companyName,
    idNumber,
    accountOwnerIdNumber,
    businessRegistrationNumber,
  } = req.body;
  // Only the signed-in user's own profile can be changed here
  const sanitizedEmail = validateEmail(req.user?.email);

  if (!sanitizedEmail) return res.status(401).json({ message: 'Please sign in to update your profile' });

  try {
    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (accountType && ['Personal', 'Business'].includes(accountType)) {
      user.accountType = accountType;
    }

    if (typeof fullName === 'string' && fullName.trim()) user.fullName = fullName.trim();
    if (typeof nickName === 'string' && nickName.trim()) user.nickName = nickName.trim();
    if (typeof companyName === 'string') user.companyName = companyName.trim();
    if (typeof dob === 'string') user.dob = dob;
    if (typeof phone === 'string') user.phone = phone;
    if (typeof gender === 'string') user.gender = gender;
    if (typeof image === 'string') user.image = image;

    if (typeof idNumber === 'string') {
      const normalizedIdNumber = idNumber.trim();
      if (normalizedIdNumber && !/^\d{3}$/.test(normalizedIdNumber)) {
        return res.status(400).json({ message: 'ID number must contain exactly 3 digits' });
      }
      user.idNumber = normalizedIdNumber || user.idNumber;
    }

    if (typeof accountOwnerIdNumber === 'string') {
      const normalizedOwnerId = accountOwnerIdNumber.trim();
      if (normalizedOwnerId && !/^\d{3}$/.test(normalizedOwnerId)) {
        return res.status(400).json({ message: 'Account holder ID number must contain exactly 3 digits' });
      }
      user.accountOwnerIdNumber = normalizedOwnerId || user.accountOwnerIdNumber;
    }

    if (typeof businessRegistrationNumber === 'string') {
      user.businessRegistrationNumber = businessRegistrationNumber.trim() || user.businessRegistrationNumber;
    }

    await user.save();
    await createNotification(
      user._id,
      "profile update",
      `Your account (${sanitizedEmail}) has been successfully updated.`,
      "registration"
    );
    res.status(200).json({ message: 'Profile updated', user });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ message: 'Server error while updating profile' });
  }
};

const generateAutoIdNumber = async () => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = String(Math.floor(100 + Math.random() * 900));
    const existing = await User.findOne({ $or: [{ idNumber: candidate }, { accountOwnerIdNumber: candidate }] });
    if (!existing) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique ID number');
};

const completeProfileSetup = async (req, res) => {
  const userId = req.user?.id || req.body.userId;
  const {
    accountType,
    fullName,
    companyName,
    businessRegistrationNumber,
    phone,
  } = req.body;

  if (!userId) {
    return res.status(401).json({ message: 'User session is required to complete setup' });
  }

  const normalizedAccountType = accountType === 'Business' ? 'Business' : 'Personal';
  const trimmedFullName = String(fullName || '').trim();
  const trimmedCompanyName = String(companyName || '').trim();
  const trimmedBusinessRegistrationNumber = businessRegistrationNumber === undefined || businessRegistrationNumber === null ? '' : String(businessRegistrationNumber).trim();

  const normalizedPhone = normalizePhone(phone);

  if (!trimmedFullName) {
    return res.status(400).json({ message: 'Full name is required' });
  }

  if (!saPhoneRegex.test(normalizedPhone)) {
    return res.status(400).json({ message: 'Please enter a valid South African phone number, e.g. 082 123 4567' });
  }

  if (normalizedAccountType === 'Business') {
    if (!trimmedCompanyName) {
      return res.status(400).json({ message: 'Company name is required for business accounts' });
    }
    if (!trimmedBusinessRegistrationNumber) {
      return res.status(400).json({ message: 'Business registration number is required' });
    }
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (normalizedAccountType === 'Business') {
      const duplicateBusinessReg = await User.findOne({ businessRegistrationNumber: trimmedBusinessRegistrationNumber, _id: { $ne: userId } });
      if (duplicateBusinessReg) {
        return res.status(400).json({ message: 'This business registration number already has an account' });
      }
    }

    user.accountType = normalizedAccountType;
    user.fullName = trimmedFullName;
    user.phone = normalizedPhone;
    user.companyName = normalizedAccountType === 'Business' ? trimmedCompanyName : '';
    user.businessRegistrationNumber = normalizedAccountType === 'Business' ? trimmedBusinessRegistrationNumber : undefined;

    // Keep an existing ID when re-running setup; otherwise assign a unique 3-digit one
    const existingId = user.idNumber || user.accountOwnerIdNumber;
    const assignedId = existingId || await generateAutoIdNumber();
    if (normalizedAccountType === 'Personal') {
      user.idNumber = assignedId;
      user.accountOwnerIdNumber = undefined;
    } else {
      user.accountOwnerIdNumber = assignedId;
      user.idNumber = undefined;
    }

    user.profileCompleted = true;

    // A referral from someone with the same phone number is a self-referral: drop it
    if (user.referredBy?.user) {
      const referrer = await User.findById(user.referredBy.user).select('phone');
      if (referrer?.phone && referrer.phone === normalizedPhone) {
        user.referredBy = { user: null, kind: null, via: null, at: null };
      }
    }
    await user.save();

    res.status(200).json({
      message: 'Account setup complete',
      user: {
        ...buildAuthUser(user),
        idNumber: user.idNumber || user.accountOwnerIdNumber || '',
      }
    });
  } catch (err) {
    console.error('Complete profile setup error:', err);
    res.status(500).json({ message: 'Server error while setting up account' });
  }
};

// Save user location
const saveUserLocation = async (req, res) => {
  const { place } = req.body;
  if (!place) return res.status(400).json({ message: 'Place is required' });

  try {
    const user = await User.findOne().sort({ createdAt: -1 });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const resGeo = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`
    );
    const data = await resGeo.json();

    if (!data || data.length === 0) {
      return res.status(404).json({ message: 'No location found for the given place' });
    }

    const { lat, lon, display_name } = data[0];
    user.location = {
      latitude: parseFloat(lat),
      longitude: parseFloat(lon),
      address: display_name || place,
    };

    await user.save();

    res.status(200).json({
      message: 'Location saved successfully',
      user: user.email,
      location: user.location,
    });
  } catch (err) {
    console.error('Save location error:', err);
    res.status(500).json({ message: 'Server error while saving location' });
  }
};

//  Get user by email
const getUserByEmail = async (req, res) => {
  const sanitizedEmail = validateEmail(req.query.email);
  if (!sanitizedEmail) return res.status(400).json({ message: 'Valid email is required' });
  if (!isStaff(req.user) && sanitizedEmail.toLowerCase() !== req.user.email.toLowerCase()) {
    return res.status(403).json({ message: 'You can only view your own account.' });
  }

  try {
    const user = await User.findOne({ email: sanitizedEmail }).select('-password -__v -tokens');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.status(200).json({ user });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ message: 'Server error while fetching user' });
  }
};

//  Get all customers
const getAllCustomers = async (req, res) => {
  try {
    const users = await User.find().select('customerId fullName email phone accountType companyName status location address role idNumber accountOwnerIdNumber businessRegistrationNumber');
    const orders = await Order.find();
    const wallets = await Wallet.find();
    const requesterRole = (req.user?.role || '').toLowerCase().replace(/\s/g, '');
    const canSearchIdentity = requesterRole === 'admin' || requesterRole === 'superadmin';

    const enrichedUsers = users.map((user) => {
      const userOrders = orders.filter(
        (order) =>
          order.senderEmail === user.email || order.senderPhone === user.phone
      );

      const userWallet = wallets.find(w => w.userId && w.userId.toString() === user._id.toString());

      const customer = {
        id: user._id,
        customerId: user.customerId,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        accountType: user.accountType || 'Personal',
        company: user.companyName || '',
        status: user.status || 'Active',
        location: user.location || {},
        address: user.address || {},
        role: user.role || 'Customer',
        totalOrders: userOrders.length,
        walletBalance: userWallet ? userWallet.balance : 0
      };

      if (canSearchIdentity) {
        customer.identityNumber = user.idNumber || user.accountOwnerIdNumber || '';
        customer.businessRegistrationNumber = user.businessRegistrationNumber || '';
      }

      return customer;
    });

    res.status(200).json({ customers: enrichedUsers });
  } catch (error) {
    console.error("Error fetching customers", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Current user's own profile (customer "My Profile" page)
const getMyProfile = async (req, res) => {
  try {
    const user = req.user;
    const [wallet, totalOrders] = await Promise.all([
      Wallet.findOne({ userId: user._id }).select('balance'),
      Order.countDocuments({
        $or: [
          { senderEmail: user.email },
          ...(user.phone ? [{ senderPhone: user.phone }] : []),
        ],
      }),
    ]);

    res.status(200).json({
      profile: {
        customerId: user.customerId,
        email: user.email,
        fullName: user.fullName || '',
        phone: user.phone || '',
        image: user.image || '',
        role: user.role || 'Customer',
        status: user.status || 'Active',
        accountType: user.accountType || 'Personal',
        companyName: user.companyName || '',
        idNumber: user.idNumber || user.accountOwnerIdNumber || '',
        businessRegistrationNumber: user.businessRegistrationNumber || '',
        address: user.address || {},
        memberSince: user.createdAt,
        walletBalance: wallet ? wallet.balance : 0,
        totalOrders,
      },
    });
  } catch (err) {
    console.error('Get my profile error:', err);
    res.status(500).json({ message: 'Server error while loading your profile' });
  }
};

const SA_PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
];

// Customers can update their own name, phone and address
const updateMyProfile = async (req, res) => {
  const { fullName, phone, address } = req.body;
  const user = req.user;

  try {
    if (fullName !== undefined) {
      const trimmed = String(fullName).trim();
      if (!trimmed) return res.status(400).json({ message: 'Full name cannot be empty' });
      user.fullName = trimmed;
    }

    if (phone !== undefined) {
      const normalizedPhone = normalizePhone(phone);
      if (!saPhoneRegex.test(normalizedPhone)) {
        return res.status(400).json({ message: 'Please enter a valid South African phone number, e.g. 082 123 4567' });
      }
      user.phone = normalizedPhone;
    }

    if (address !== undefined) {
      const clean = (value) => String(value || '').trim();
      const next = {
        street: clean(address.street),
        complexOrBusinessHub: clean(address.complexOrBusinessHub),
        city: clean(address.city),
        province: clean(address.province),
        postalCode: clean(address.postalCode),
      };

      if (!next.street || !next.city || !next.province || !next.postalCode) {
        return res.status(400).json({ message: 'Street, city, province and postal code are required' });
      }
      if (!SA_PROVINCES.includes(next.province)) {
        return res.status(400).json({ message: 'Please choose a South African province' });
      }
      if (!/^\d{4}$/.test(next.postalCode)) {
        return res.status(400).json({ message: 'Postal code must be 4 digits' });
      }

      const current = user.address || {};
      const changed = ['street', 'complexOrBusinessHub', 'city', 'province', 'postalCode']
        .some((key) => (current[key] || '') !== next[key]);

      if (changed) {
        // Old GPS coordinates no longer match the new address
        user.address = { ...next, country: 'South Africa' };
      }
    }

    await user.save();
    return getMyProfile(req, res);
  } catch (err) {
    console.error('Update my profile error:', err);
    res.status(500).json({ message: 'Server error while updating your profile' });
  }
};

// Get User by ID
const getUserById = async (req, res) => {
  const { id } = req.params;
  if (!isStaff(req.user) && String(req.user._id) !== String(id)) {
    return res.status(403).json({ message: 'You can only view your own account.' });
  }
  try {
    const user = await User.findById(id).select('-password -__v -tokens');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.status(200).json({ user });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

//  Get single customer by ID
const getCustomerById = async (req, res) => {
  const id = validateCustomerId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid customer ID format" });

  try {
    const user = await User.findOne({ customerId: id });

    if (!user) return res.status(404).json({ message: "User not found" });

    const userOrders = await Order.find({ senderEmail: user.email });

    res.json({
      id: user.customerId,
      name: user.fullName,
      email: user.email,
      contact: user.phone,
      address: user.location?.address,
      orders: userOrders.map(order => ({
        orderId: order.orderId,
        date: order.createdAt,
        amount: order.totalAmount,
        status: order.status
      }))
    });
  } catch (err) {
    console.error("Get customer by ID error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Google Login
const googleLogin = async (req, res) => {
  const { accessToken, referralCode } = req.body;

  // Who is signing in comes from Google, never from the request body
  let googleProfile;
  try {
    googleProfile = await verifyGoogleAccessToken(accessToken);
  } catch (err) {
    if (!(err instanceof GoogleAuthError)) console.error('Google token check failed:', err.message);
    return res.status(err.status || 401).json({ message: err instanceof GoogleAuthError ? err.message : 'Google sign-in failed. Please try again.' });
  }
  const { fullName, image } = googleProfile;
  const sanitizedEmail = validateEmail(googleProfile.email);
  if (!sanitizedEmail) return res.status(400).json({ message: "Your Google account has no usable email address" });

  try {
    let user = await User.findOne({ email: sanitizedEmail });

    if (user) {
      const blocked = await signInBlock(user);
      if (blocked) return res.status(403).json({ message: blocked });
      // Google has confirmed the email, so an invited team member is now set up
      if (user.createdBy && !user.invite?.acceptedAt) {
        user.invite = { ...(user.invite || {}), acceptedAt: new Date() };
        await user.save();
      }
    }

    const base64Image = await convertImageToBase64(image);

    if (!user) {
      const customerId = await generateCustomerId();
      user = new User({
        email: sanitizedEmail,
        fullName,
        image: base64Image,
        customerId,
        password: await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10),
        profileCompleted: false,
      });
      // Referral links only count for brand-new accounts
      const referrer = referralCode ? await resolveReferrer(referralCode, { email: sanitizedEmail }) : null;
      if (referrer) user.referredBy = referralRecord(referrer, 'link');
      await user.save();
    } else {
      if (!user.image || !user.image.startsWith("data:image")) {
        user.image = base64Image;
        await user.save();
      }
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role || 'Customer' },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    //  create Token with expiresAt relative to createdAt
    const tokenDoc = await Token.create({ userId: user._id, token });
    tokenDoc.expiresAt = new Date(tokenDoc.createdAt.getTime() + 2 * 60 * 60 * 1000); // 2 hours
    await tokenDoc.save();

    res.status(200).json({
      message: "Google login successful",
      token,
      user: await buildSignedInUser(user),
    });
  } catch (err) {
    console.error("Google login error:", err);
    console.error("Error details:", err.message);
    res.status(500).json({ message: "Google login failed", error: err.message });
  }
};

// 🔧 Helper to convert image to Base64
const convertImageToBase64 = async (url) => {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.error("Failed to convert image:", err);
    return null;
  }
};

// Create Admin/Staff User (Super Admin only)
const createAdminUser = async (req, res) => {
  const { email, password, fullName, role, phone } = req.body;
  const sanitizedEmail = validateEmail(email);

  if (!sanitizedEmail || !password || !fullName)
    return res.status(400).json({ message: 'Valid email, password, and name are required' });

  if (!['Admin', 'Manager', 'Admin Staff', SALES_REP_ROLE].includes(role)) {
    return res.status(400).json({ message: 'Invalid role for admin creation' });
  }

  const isRep = role === SALES_REP_ROLE;
  const normalizedPhone = phone ? normalizePhone(phone) : '';
  if (isRep && !saPhoneRegex.test(normalizedPhone)) {
    return res.status(400).json({ message: 'Please enter a valid South African phone number for the sales representative' });
  }

  try {
    const existingUser = await User.findOne({ email: sanitizedEmail });
    if (existingUser)
      return res.status(400).json({ message: 'User already exists' });

    const customerId = isRep ? await generateRepId() : await generateAdminId();
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create direct user with Role
    const user = new User({
      email: sanitizedEmail,
      password: hashedPassword,
      fullName: fullName,
      customerId,
      role: role, // Explicitly set role
      ...(isRep ? { phone: normalizedPhone, repProfile: { commissionActive: false } } : {}),
    });
    if (isRep) user.referralCode = await generateReferralCode(user);

    await user.save();

    res.status(201).json({ message: `${role} created successfully`, userId: user._id });
  } catch (err) {
    console.error('Create Admin Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete User (Super Admin only)
const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "User not found" });

    // Optional: Clean up related data like Wallet, Tokens, etc.
    await Token.deleteMany({ userId: id });
    await Wallet.deleteOne({ userId: id });

    res.status(200).json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Update User (Super Admin only)
const updateUserByAdmin = async (req, res) => {
  const { id } = req.params;
  const { fullName, email, role, password } = req.body;

  try {
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (fullName) user.fullName = fullName;
    if (email) user.email = email;
    if (role) user.role = role;

    if (password && password.trim() !== "") {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();
    res.status(200).json({ message: "User updated successfully", user });
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

//  Export all
module.exports = {
  requestVerificationCode,
  verifyCode,
  registerUser,
  createAdminUser,
  deleteUser,
  updateUserByAdmin,
  loginUser,
  logoutUser,
  resetPassword,
  setPassword,
  checkPasswordLink,
  signPasswordToken,
  signInBlock,
  updateUserProfile,
  completeProfileSetup,
  getMyProfile,
  updateMyProfile,
  generateCustomerId,
  generateAutoIdNumber,
  normalizePhone,
  saPhoneRegex,
  saveUserLocation,
  getUserByEmail,
  getAllCustomers,
  getCustomerById,
  getUserById,
  googleLogin,
  createNotification,
};