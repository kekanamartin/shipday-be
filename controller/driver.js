const mongoose = require('mongoose');
const Driver = require('../models/Driver');
const TempDriver = require('../models/TempDriver');
const VerificationCode = require('../models/VerificationCode');
const Notification = require('../models/Notification');
const Delivery = require('../models/Delivery');
const Shipment = require('../models/Shipment');
const sendMail = require("../utils/mail");
const { sendShipmentStatusEmail } = require('../utils/shipmentEmailTemplates');
const Token = require('../models/Token');
const { refreshShipmentCustomerActivation } = require('../services/marketingActivationService');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Password strength regex
const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;

// Email validator
const validateEmail = (email) => {
  const sanitized = String(email).toLowerCase().trim();
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(sanitized) ? sanitized : null;
};

// Generate unique driverId
const generateDriverId = async () => {
  let driverId;
  let isUnique = false;
  let counter = 1;

  while (!isUnique) {
    const padded = String(counter).padStart(3, '0');
    driverId = `DRV${padded}`;

    const existing = await Driver.findOne({ driverId });
    if (!existing) {
      isUnique = true;
    } else {
      counter++;
    }
  }

  return driverId;
};

// Helper to create notification
const createNotification = async (driverId, title, message, type) => {
  try {
    const notification = new Notification({
      userId: driverId,
      title,
      message,
      type,
    });
    await notification.save();
  } catch (err) {
    console.error("Notification creation failed:", err);
  }
};

// Send verification code
const sendVerificationCode = async (email) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min expiry

  await VerificationCode.findOneAndUpdate(
    { email },
    { code, expiresAt, attempts: 0 },
    { upsert: true, new: true }
  );

  const text = `Your driver verification code is: ${code}. It will expire in 15 minutes.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
      <h2 style="color: #0f172a; text-align: center;">Driver Verification Code</h2>
      <p style="font-size: 16px; color: #4b5563;">Hello,</p>
      <p style="font-size: 16px; color: #4b5563;">Your driver verification code is:</p>
      <div style="font-size: 32px; font-weight: bold; color: #10b981; text-align: center; padding: 20px; margin: 20px 0; background: #f8fafc; border-radius: 8px; letter-spacing: 5px;">
        ${code}
      </div>
      <p style="font-size: 14px; color: #9ca3af; text-align: center;">This code will expire in 15 minutes.</p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
      <p style="font-size: 12px; color: #9ca3af; text-align: center;">If you didn't request this code, please ignore this email.</p>
    </div>
  `;
  await sendMail(email, "Driver Verification Code - ShipDay", text, html);
};

// Verify OTP and create driver account
const requestDriverVerificationCode = async (req, res) => {
  const { email, code } = req.body;
  const sanitizedEmail = validateEmail(email);

  if (!sanitizedEmail || !code) {
    return res.status(400).json({ message: 'Email and verification code are required' });
  }

  try {
    const record = await VerificationCode.findOne({ email: sanitizedEmail });
    if (!record) {
      return res.status(400).json({ message: 'Verification code not found' });
    }

    if (record.expiresAt < new Date() || (record.attempts || 0) >= 5) {
      await VerificationCode.deleteOne({ email: sanitizedEmail });
      return res.status(400).json({ message: 'Verification code expired' });
    }

    if (record.code !== String(code).trim().toUpperCase()) {
      await VerificationCode.updateOne({ email: sanitizedEmail }, { $inc: { attempts: 1 } });
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    // Get temp driver data
    const tempDriver = await TempDriver.findOne({ email: sanitizedEmail });
    if (!tempDriver) {
      return res.status(400).json({ message: 'Registration data not found. Please register again.' });
    }

    // Create driver
    const driverId = await generateDriverId();
    const driver = new Driver({
      driverId,
      username: tempDriver.username,
      email: tempDriver.email,
      phone: tempDriver.phone,
      password: tempDriver.password,
      vehicleType: tempDriver.vehicleType,
      vehicleNumber: tempDriver.vehicleNumber,
      driverImage: tempDriver.driverImage,
      idProof: tempDriver.idProof,
    });

    await driver.save();

    // Cleanup
    await VerificationCode.deleteOne({ email: sanitizedEmail });
    await TempDriver.deleteOne({ email: sanitizedEmail });

    await createNotification(
      driver._id,
      "Driver Registration Successful",
      `Welcome ${tempDriver.username}! Your driver account has been registered and is pending approval.`,
      "registration"
    );

    res.status(201).json({
      message: 'Driver registered successfully. Account is pending approval.',
      driverId: driver.driverId
    });
  } catch (err) {
    console.error('Verification error:', err);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Driver already exists' });
    }
    res.status(500).json({ message: 'Verification failed' });
  }
};

// Register driver (collect details and send OTP)
const registerDriver = async (req, res) => {
  const { username, email, phone, password, vehicleType, vehicleNumber, idProof } = req.body;
  const sanitizedEmail = validateEmail(email);

  // Handle multiple file uploads
  const driverImageFile = req.files && req.files['driverImage'] ? req.files['driverImage'][0] : null;
  const idProofFile = req.files && req.files['idProof'] ? req.files['idProof'][0] : null;

  if (!username || !sanitizedEmail || !phone || !password || !vehicleType || !vehicleNumber || (!driverImageFile && !idProofFile && !idProof)) {
    return res.status(400).json({ message: 'All fields including driver image and ID proof are required' });
  }

  if (!strongPasswordRegex.test(password)) {
    return res.status(400).json({
      message: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.',
    });
  }

  if (!['bike', 'car', 'van', 'truck'].includes(vehicleType)) {
    return res.status(400).json({ message: 'Invalid vehicle type' });
  }

  try {
    const existingDriver = await Driver.findOne({
      $or: [
        { email: sanitizedEmail },
        { vehicleNumber: vehicleNumber.trim() }
      ]
    });

    if (existingDriver) {
      return res.status(400).json({ message: 'Driver already exists with this email or vehicle number' });
    }

    // Store temp driver data
    const hashedPassword = await bcrypt.hash(password, 10);
    await TempDriver.findOneAndUpdate(
      { email: sanitizedEmail },
      {
        username: username.trim(),
        email: sanitizedEmail,
        phone: phone.trim(),
        password: hashedPassword,
        vehicleType,
        vehicleNumber: vehicleNumber.trim().toUpperCase(),
        driverImage: driverImageFile ? driverImageFile.path : null,
        idProof: idProofFile ? idProofFile.path : idProof
      },
      { upsert: true, new: true }
    );

    await sendVerificationCode(sanitizedEmail);
    res.status(200).json({ message: 'Verification code sent to email. Please verify to complete registration.' });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Failed to send verification code' });
  }
};

// Driver login
const loginDriver = async (req, res) => {
  const { emailOrPhone, password } = req.body;

  if (!emailOrPhone || !password) {
    return res.status(400).json({ message: 'Email/phone and password are required' });
  }

  try {
    const sanitizedEmail = validateEmail(emailOrPhone);
    const driver = await Driver.findOne({
      $or: [
        { email: sanitizedEmail || emailOrPhone },
        { phone: emailOrPhone }
      ]
    });

    if (!driver) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (driver.status !== 'approved') {
      return res.status(403).json({ message: 'Account not approved yet' });
    }

    const isMatch = await bcrypt.compare(password, driver.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Get live delivery statistics from Shipments (not legacy Delivery model)
    const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
    const assignedDeliveries = await Shipment.countDocuments({ driver: driver._id });
    const completedDeliveries = await Shipment.countDocuments({ driver: driver._id, status: 'Delivered' });
    const pendingDeliveries = await Shipment.countDocuments({ driver: driver._id, status: { $in: ['Pending Delivery', 'Out For Delivery', 'In Transit', 'Picked Up', 'Driver Assigned', 'Out for Delivery'] } });
    const completedToday = await Shipment.countDocuments({ driver: driver._id, status: 'Delivered', deliveredAt: { $gte: startOfToday } });
    const pendingCollection = await Shipment.countDocuments({ driver: driver._id, status: { $in: ['Pending Collection', 'Order Created', 'Collected'] } });

    // Calculate earnings (R50 per delivery)
    const earnings = completedDeliveries * 50;

    const token = jwt.sign(
      { id: driver._id, email: driver.email, role: 'driver' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.DRIVER_TOKEN_TTL || '7d' } // the app stays signed in between shifts
    );



    res.status(200).json({
      message: 'Login successful',
      token,
      driver: {
        driverId: driver.driverId,
        username: driver.username,
        email: driver.email,
        phone: driver.phone,
        vehicleType: driver.vehicleType,
        vehicleNumber: driver.vehicleNumber,
        status: driver.status
      },
      statistics: {
        assignedDeliveries,
        completedDeliveries,
        completedToday,
        pendingDeliveries,
        pendingCollection,
        earnings
      }
    });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ message: 'Login error' });
  }
};

// Get driver notifications
const getDriverNotifications = async (req, res) => {
  const { driverId } = req.params;

  try {
    
    const driver = await Driver.findOne({ driverId });
    

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    
    

    // Get all notifications for debugging
    const allNotifications = await Notification.find({}).sort({ createdAt: -1 });
    
    console.log('All notification userIds:', allNotifications.map(n => ({
      userId: n.userId?.toString(),
      type: n.type,
      title: n.title,
      message: n.message.substring(0, 50) + '...'
    })));

    // Try both exact match and string comparison
    const notifications = await Notification.find({
      userId: driver._id,
      type: 'shipment_assigned'
    }).sort({ createdAt: -1 });

    

    // If still no notifications, check for shipment-related notifications by message content
    if (notifications.length === 0) {
      const shipmentNotifications = await Notification.find({
        type: 'shipment_assigned',
        message: { $regex: 'SHP900155', $options: 'i' }
      }).sort({ createdAt: -1 });

      
      if (shipmentNotifications.length > 0) {
        
        
      }
    }

    res.status(200).json({ notifications });
  } catch (err) {
    console.error('Error in getDriverNotifications:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get driver's assigned shipments
const getDriverShipments = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const shipments = await Shipment.find({ driver: driver._id })
      .sort({ createdAt: -1 });

    // Format shipments for frontend
    const formattedShipments = shipments.map(shipment => {
      const deliveryAddress = shipment.deliveryDetails?.address ? 
        `${shipment.deliveryDetails.address.street || ''}, ${shipment.deliveryDetails.address.suburb || ''}, ${shipment.deliveryDetails.address.city || ''}`.trim() :
        shipment.recipientAddress || shipment.address || 'N/A';
      
      return {
        _id: shipment._id,
        shipmentId: shipment.shipmentId,
        customerName: shipment.deliveryDetails?.receiverName || shipment.recipientName || shipment.customerName || 'Unknown',
        customerPhone: shipment.deliveryDetails?.mobile || shipment.recipientPhone || shipment.customerPhone || 'N/A',
        address: deliveryAddress,
        status: shipment.status,
        weight: shipment.parcelDetails?.dimensions?.weight?.toString() || shipment.weight || 'N/A',
        dimensions: shipment.parcelDetails?.dimensions ? 
          `${shipment.parcelDetails.dimensions.length || 0}x${shipment.parcelDetails.dimensions.width || 0}x${shipment.parcelDetails.dimensions.height || 0} cm` :
          shipment.dimensions || 'N/A',
        specialInstructions: shipment.parcelDetails?.specialInstructions || shipment.specialInstructions || shipment.notes || 'None',
        pickupAddress: shipment.collectionDetails?.address ?
          `${shipment.collectionDetails.address.street || ''}, ${shipment.collectionDetails.address.suburb || ''}, ${shipment.collectionDetails.address.city || ''}`.trim() :
          shipment.pickupAddress || shipment.senderAddress || 'N/A',
        deliveryAddress: deliveryAddress,
        estimatedDelivery: shipment.eta ? shipment.eta.toISOString().split('T')[0] : shipment.estimatedDelivery || shipment.deliveryDate || 'N/A',
        createdAt: shipment.createdAt,
        latitude: shipment.deliveryDetails?.address?.latitude || shipment.latitude || 0,
        longitude: shipment.deliveryDetails?.address?.longitude || shipment.longitude || 0,
        podCompleted: shipment.podCompleted || false,
        podMethod: shipment.podMethod || null,
        podData: shipment.podData || null,
        description: shipment.description || '',
        packageType: shipment.parcelDetails?.parcelType || shipment.packageType || 'Standard',
        trackingNumber: shipment.trackingNumber || shipment.shipmentId,
        senderName: shipment.senderDetails?.fullName || shipment.senderName || 'Unknown',
        senderPhone: shipment.senderDetails?.mobile || shipment.senderPhone || 'N/A',
      };
    });

    res.status(200).json({ shipments: formattedShipments });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Get specific shipment details for a driver
const getDriverShipmentDetails = async (req, res) => {
  const { driverId, shipmentId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const shipment = await Shipment.findOne({ shipmentId, driver: driver._id });
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found or not assigned to this driver' });
    }

    // Extract coordinates from delivery details if not directly available
    const deliveryLat = shipment.deliveryDetails?.address?.latitude || shipment.latitude || 0;
    const deliveryLon = shipment.deliveryDetails?.address?.longitude || shipment.longitude || 0;
    
    // Extract address from delivery details
    const deliveryAddress = shipment.deliveryDetails?.address ? 
      `${shipment.deliveryDetails.address.street || ''}, ${shipment.deliveryDetails.address.suburb || ''}, ${shipment.deliveryDetails.address.city || ''}`.trim() :
      shipment.recipientAddress || shipment.address || 'N/A';
    
    // Extract pickup address from collection details
    const pickupAddress = shipment.collectionDetails?.address ?
      `${shipment.collectionDetails.address.street || ''}, ${shipment.collectionDetails.address.suburb || ''}, ${shipment.collectionDetails.address.city || ''}`.trim() :
      shipment.pickupAddress || shipment.senderAddress || 'N/A';

    // Format response to match frontend expectations
    const formattedShipment = {
      _id: shipment._id,
      shipmentId: shipment.shipmentId,
      customerName: shipment.deliveryDetails?.receiverName || shipment.recipientName || shipment.customerName || 'Unknown',
      customerPhone: shipment.deliveryDetails?.mobile || shipment.recipientPhone || shipment.customerPhone || 'N/A',
      address: deliveryAddress,
      status: shipment.status,
      weight: shipment.parcelDetails?.dimensions?.weight?.toString() || shipment.weight || 'N/A',
      dimensions: shipment.parcelDetails?.dimensions ? 
        `${shipment.parcelDetails.dimensions.length || 0}x${shipment.parcelDetails.dimensions.width || 0}x${shipment.parcelDetails.dimensions.height || 0} cm` :
        shipment.dimensions || 'N/A',
      specialInstructions: shipment.parcelDetails?.specialInstructions || shipment.specialInstructions || shipment.notes || 'None',
      pickupAddress: pickupAddress,
      deliveryAddress: deliveryAddress,
      estimatedDelivery: shipment.eta ? shipment.eta.toISOString().split('T')[0] : shipment.estimatedDelivery || shipment.deliveryDate || 'N/A',
      createdAt: shipment.createdAt,
      latitude: deliveryLat,
      longitude: deliveryLon,
      podCompleted: shipment.podCompleted || false,
      podMethod: shipment.podMethod || null,
      podData: shipment.podData || null,
      description: shipment.description || '',
      packageType: shipment.parcelDetails?.parcelType || shipment.packageType || 'Standard',
      trackingNumber: shipment.trackingNumber || shipment.shipmentId,
      senderName: shipment.senderDetails?.fullName || shipment.senderName || 'Unknown',
      senderPhone: shipment.senderDetails?.mobile || shipment.senderPhone || 'N/A',
    };

    res.status(200).json(formattedShipment);
  } catch (err) {
    console.error('Error fetching shipment details:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update shipment status by driver
const updateShipmentStatus = async (req, res) => {
  const { shipmentId, status } = req.body;

  if (!shipmentId || !status) {
    return res.status(400).json({ message: 'shipmentId and status are required' });
  }

  const allowedStatuses = [
    'Picked Up',
    'In Transit',
    'Inter Hub',
    'Arrived at Hub',
    'Out For Delivery',
    'Delivered',
    'Failed Delivery',
    'Failed Collection',
    'Pending Delivery',
    'Pending Collection',
    'Collected',
    'Cancelled',
    'Reschedule'
  ];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: `Invalid status. Allowed statuses: ${allowedStatuses.join(', ')}` });
  }

  try {
    const updateFields = { status };
    if (status === 'Delivered') {
      updateFields.deliveredAt = new Date();
    }

    // A signed-in driver may only update deliveries assigned to them
    const filter = req.driver ? { shipmentId, driver: req.driver._id } : { shipmentId };
    const shipment = await Shipment.findOneAndUpdate(
      filter,
      updateFields,
      { new: true }
    );

    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    if (status === 'Delivered') {
      await refreshShipmentCustomerActivation(shipment);
    }

    // Trigger automatic email notification
    await sendShipmentStatusEmail(shipment, status);

    res.status(200).json({
      message: `Shipment status updated to ${status} successfully`,
      shipment
    });
  } catch (err) {
    console.error('Update Shipment Status Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update shipment status with Proof of Delivery (signature + photo + location)
const updateShipmentStatusWithPOD = async (req, res) => {
  const { driverId, shipmentId, receiverName, podMethod, location, signature, photo } = req.body;

  if (!driverId || !shipmentId || !receiverName) {
    return res.status(400).json({ message: 'driverId, shipmentId, and receiverName are required' });
  }

  if (!podMethod || !['signature', 'photo', 'location'].includes(podMethod)) {
    return res.status(400).json({ message: 'Valid podMethod (signature, photo, or location) is required' });
  }

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const updateFields = {
      status: 'Delivered',
      deliveredAt: new Date(),
      podReceiverName: receiverName.trim(),
      podSignedAt: new Date(),
      podMethod: podMethod,
      podCompleted: true
    };

    // Handle location data
    if (location) {
      try {
        const locationData = typeof location === 'string' ? JSON.parse(location) : location;
        updateFields.podLocation = {
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          address: locationData.address
        };
      } catch (e) {
        console.error('Error parsing location data:', e);
      }
    }

    // Handle signature (base64 data) - handles png/jpeg
    if (signature && podMethod === 'signature') {
      let signatureData = signature;
      if (signature.includes('base64,')) {
        signatureData = signature.split('base64,')[1];
      }
      // In production, you'd save this to a file storage service
      // For now, we'll store the base64 data (note: this has size limitations)
      updateFields.podSignature = signatureData;
      updateFields.podData = { signature: signatureData };
    }

    // Handle photo (file upload or base64)
    if (photo && podMethod === 'photo') {
      if (req.files && req.files.photo && req.files.photo[0]) {
        // File upload via multer
        updateFields.podPhoto = req.files.photo[0].path;
      } else if (typeof photo === 'string') {
        if (photo.startsWith('data:image')) {
          // Base64 image data
          let photoData = photo;
          if (photo.startsWith('data:image/') && photo.includes('base64,')) {
            photoData = photo.split(',')[1];
          }
          updateFields.podPhoto = photoData; // In production, save to file storage
          updateFields.podData = { photo: photoData };
        } else {
          // File URI from React Native
          updateFields.podPhoto = photo;
        }
      }
    }

    // Find shipment by shipmentId / barcode / _id (frontend may pass any)
    let shipment = await Shipment.findOne({ 
      $or: [
        { shipmentId: shipmentId },
        { barcode: shipmentId },
        { trackingNumber: shipmentId }
      ]
    });
    if (!shipment && mongoose.Types.ObjectId.isValid(shipmentId)) {
      shipment = await Shipment.findById(shipmentId);
    }
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found. Tried: ' + shipmentId });
    }
    // Verify shipment belongs to this driver
    if (!shipment.driver || shipment.driver.toString() !== driver._id.toString()) {
      return res.status(403).json({ message: 'Shipment not assigned to this driver' });
    }
    shipment = await Shipment.findByIdAndUpdate(shipment._id, updateFields, { new: true });

    await refreshShipmentCustomerActivation(shipment);

    await sendShipmentStatusEmail(shipment, 'Delivered');

    res.status(200).json({
      message: 'Delivery confirmed with proof of delivery',
      shipment: {
        shipmentId: shipment.shipmentId,
        status: shipment.status,
        podMethod: shipment.podMethod,
        podCompleted: shipment.podCompleted
      }
    });
  } catch (err) {
    console.error('POD Update Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update driver FCM token
const updateDriverFCMToken = async (req, res) => {
  const { driverId } = req.params;
  const { fcmToken } = req.body;

  if (!fcmToken) {
    return res.status(400).json({ message: 'FCM token is required' });
  }

  try {
    const driver = await Driver.findOneAndUpdate(
      { driverId },
      { fcmToken },
      { new: true }
    );

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    res.status(200).json({
      message: 'FCM token updated successfully'
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Test push notification
const testPushNotification = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    if (!driver.fcmToken) {
      return res.status(400).json({ message: 'Driver has no FCM token' });
    }

    const { sendPushNotification } = require('../utils/pushNotification');
    await sendPushNotification(
      driver.fcmToken,
      'Test Notification',
      'This is a test push notification for driver ' + driver.username,
      { type: 'test' }
    );

    res.status(200).json({
      message: 'Test push notification sent successfully'
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Check if driver exists
const checkDriver = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId }).select('-password');
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    res.status(200).json({
      message: 'Driver found',
      driver
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Forgot password - send reset code
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  const sanitizedEmail = validateEmail(email);

  if (!sanitizedEmail) {
    return res.status(400).json({ message: 'Valid email is required' });
  }

  try {
    const driver = await Driver.findOne({ email: sanitizedEmail });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found with this email' });
    }

    await sendVerificationCode(sanitizedEmail);
    res.status(200).json({ message: 'Password reset code sent to your email' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Failed to send reset code' });
  }
};

// Reset password with verification code
const resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;
  const sanitizedEmail = validateEmail(email);

  if (!sanitizedEmail || !code || !newPassword) {
    return res.status(400).json({ message: 'Email, verification code, and new password are required' });
  }

  if (!strongPasswordRegex.test(newPassword)) {
    return res.status(400).json({
      message: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.',
    });
  }

  try {
    const record = await VerificationCode.findOne({ email: sanitizedEmail });
    if (!record) {
      return res.status(400).json({ message: 'Verification code not found' });
    }

    if (record.expiresAt < new Date() || (record.attempts || 0) >= 5) {
      await VerificationCode.deleteOne({ email: sanitizedEmail });
      return res.status(400).json({ message: 'Verification code expired' });
    }

    if (record.code !== String(code).trim().toUpperCase()) {
      await VerificationCode.updateOne({ email: sanitizedEmail }, { $inc: { attempts: 1 } });
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    const driver = await Driver.findOne({ email: sanitizedEmail });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await Driver.findOneAndUpdate(
      { email: sanitizedEmail },
      { password: hashedPassword }
    );

    await VerificationCode.deleteOne({ email: sanitizedEmail });

    await createNotification(
      driver._id,
      "Password Reset Successful",
      "Your password has been successfully reset.",
      "security"
    );

    res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Password reset failed' });
  }
};

// Clean up login notifications
const cleanupLoginNotifications = async (req, res) => {
  try {
    const result = await Notification.deleteMany({ type: 'login' });
    

    res.status(200).json({
      message: `Successfully deleted ${result.deletedCount} login notifications`
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Test notification creation for driver
const createTestNotification = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const notification = new Notification({
      userId: driver._id,
      title: 'Test Notification',
      message: 'This is a test notification to verify the system works.',
      type: 'shipment_assigned'
    });

    await notification.save();
    
    
    

    res.status(200).json({
      message: 'Test notification created successfully',
      notification
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get driver earnings
const getDriverEarnings = async (req, res) => {
  const { driverId } = req.params;
  const { period = 'week' } = req.query;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Calculate date range based on period
    const now = new Date();
    let startDate;
    
    switch (period) {
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Get completed deliveries in the period
    const completedDeliveries = await Shipment.find({
      driver: driver._id,
      status: 'Delivered',
      deliveredAt: { $gte: startDate }
    });

    // Calculate earnings
    const deliveryEarnings = completedDeliveries.length * 50; // Base rate per delivery
    const collectionEarnings = completedDeliveries.filter(s => s.paymentType === 'COD').length * 15; // Collection fee
    const incentives = Math.floor(Math.random() * 200); // Mock incentives
    const deductions = 0; // Mock deductions

    const totalEarnings = deliveryEarnings + collectionEarnings + incentives - deductions;
    const todayEarnings = completedDeliveries.filter(s => {
      const today = new Date();
      return s.deliveredAt && 
        s.deliveredAt.toDateString() === today.toDateString();
    }).length * 50;

    // Generate weekly data for chart
    const weeklyData = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      
      const dayDeliveries = completedDeliveries.filter(s => 
        s.deliveredAt >= dayStart && s.deliveredAt < dayEnd
      ).length;
      
      weeklyData.push(dayDeliveries * 50);
    }

    // Generate transactions
    const transactions = completedDeliveries.slice(-10).map((shipment, index) => ({
      id: shipment._id.toString(),
      type: 'delivery',
      amount: 50,
      description: `Delivery - ${shipment.shipmentId}`,
      date: shipment.deliveredAt ? shipment.deliveredAt.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    }));

    res.status(200).json({
      totalEarnings,
      weeklyEarnings: weeklyData.reduce((a, b) => a + b, 0),
      todayEarnings,
      deliveryEarnings,
      collectionEarnings,
      incentives,
      deductions,
      weeklyData,
      transactions,
    });
  } catch (err) {
    console.error('Get driver earnings error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get unallocated shipments for claiming
const getUnallocatedShipments = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Get live shipments without assigned drivers (any status except Delivered/Cancelled)
    const availableShipments = await Shipment.find({
      driver: null,
      status: { $nin: ['Delivered', 'Cancelled', 'Delivery cancelled'] }
    }).limit(20);

    // Get live shipments already claimed by this driver (all statuses)
    const claimedShipments = await Shipment.find({
      driver: driver._id,
    }).sort({ createdAt: -1 }).limit(20);

    res.status(200).json({
      available: availableShipments.map(s => ({
        _id: s._id.toString(),
        shipmentId: s.shipmentId,
        barcode: s.barcode || s.shipmentId,
        customerName: s.deliveryDetails?.receiverName || s.receiverName || s.recipientName || s.customerName || 'Unknown',
        address: s.deliveryDetails?.address ? `${s.deliveryDetails.address.street || ''}, ${s.deliveryDetails.address.suburb || ''}, ${s.deliveryDetails.address.city || ''}`.trim().replace(/^,|,$/g,'') : s.recipientAddress || s.pickupAddress || s.address || 'N/A',
        weight: s.parcelDetails?.dimensions?.weight ? `${s.parcelDetails.dimensions.weight} kg` : s.weight || s.parcelWeight ? `${s.parcelWeight} kg` : '1.0 kg',
        cost: s.cost || s.payment?.amount || 50,
        status: s.status,
        latitude: s.deliveryDetails?.address?.latitude || s.latitude || null,
        longitude: s.deliveryDetails?.address?.longitude || s.longitude || null,
      })),
      claimed: claimedShipments.map(s => ({
        _id: s._id.toString(),
        shipmentId: s.shipmentId,
        barcode: s.barcode || s.shipmentId,
        customerName: s.deliveryDetails?.receiverName || s.receiverName || s.recipientName || s.customerName || 'Unknown',
        address: s.deliveryDetails?.address ? `${s.deliveryDetails.address.street || ''}, ${s.deliveryDetails.address.suburb || ''}, ${s.deliveryDetails.address.city || ''}`.trim().replace(/^,|,$/g,'') : s.recipientAddress || s.pickupAddress || s.address || 'N/A',
        weight: s.parcelDetails?.dimensions?.weight ? `${s.parcelDetails.dimensions.weight} kg` : s.weight || s.parcelWeight ? `${s.parcelWeight} kg` : '1.0 kg',
        cost: s.cost || s.payment?.amount || 50,
        status: s.status,
        latitude: s.deliveryDetails?.address?.latitude || s.latitude || null,
        longitude: s.deliveryDetails?.address?.longitude || s.longitude || null,
      })),
    });
  } catch (err) {
    console.error('Get unallocated shipments error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Claim a shipment
const claimShipment = async (req, res) => {
  const { driverId, shipmentId } = req.body;

  if (!driverId || !shipmentId) {
    return res.status(400).json({ message: 'driverId and shipmentId are required' });
  }

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const shipment = await Shipment.findOne({ shipmentId });
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    if (shipment.driver) {
      return res.status(400).json({ message: 'Shipment already claimed' });
    }

    // Assign shipment to driver
    shipment.driver = driver._id;
    shipment.driverName = driver.username;
    shipment.status = 'Driver Assigned';
    await shipment.save({ validateBeforeSave: false });

    // Create notification
    await createNotification(
      driver._id,
      'Shipment Claimed',
      `You have successfully claimed ${shipmentId}`,
      'shipment_claimed'
    );

    res.status(200).json({
      message: 'Shipment claimed successfully',
      shipment
    });
  } catch (err) {
    console.error('Claim shipment error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Link shipment with barcode
const linkShipmentWithBarcode = async (req, res) => {
  const { driverId, barcode } = req.body;
  const cleanBarcode = String(barcode || '').trim();

  if (!driverId || !cleanBarcode) {
    return res.status(400).json({ message: 'driverId and barcode are required' });
  }

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Find shipment by barcode/tracking number - trim and case-insensitive for barcode
    const shipment = await Shipment.findOne({ 
      $or: [
        { shipmentId: cleanBarcode },
        { trackingNumber: cleanBarcode },
        { barcode: cleanBarcode },
        { shipmentId: cleanBarcode.toUpperCase() },
        { barcode: cleanBarcode.toUpperCase() }
      ]
    });

    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found with this barcode. Scanned: ' + cleanBarcode });
    }

    if (shipment.driver && shipment.driver.toString() !== driver._id.toString()) {
      return res.status(400).json({ message: 'Shipment already assigned to another driver' });
    }

    // Assign to driver if not already assigned
    if (!shipment.driver) {
      shipment.driver = driver._id;
      shipment.driverName = driver.username;
      shipment.status = 'Driver Assigned';
      await shipment.save({ validateBeforeSave: false });
    }

    res.status(200).json({
      message: 'Shipment linked successfully',
      shipment: {
        _id: shipment._id,
        shipmentId: shipment.shipmentId,
        barcode: shipment.barcode,
        recipientName: shipment.deliveryDetails?.receiverName || shipment.recipientName || shipment.receiverName || 'Unknown',
        recipientAddress: shipment.deliveryDetails?.address ? `${shipment.deliveryDetails.address.street}, ${shipment.deliveryDetails.address.city}` : shipment.recipientAddress || shipment.address || 'N/A',
        status: shipment.status,
      }
    });
  } catch (err) {
    console.error('Link shipment error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Search shipments for claim screen global search (live)
const searchShipments = async (req, res) => {
  const { driverId } = req.params;
  const { query } = req.query;
  if (!query || String(query).trim().length < 2) {
    return res.status(200).json({ shipments: [] });
  }
  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) return res.status(404).json({ message: 'Driver not found' });
    const q = String(query).trim();
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const shipments = await Shipment.find({
      $or: [
        { shipmentId: regex },
        { barcode: regex },
        { trackingNumber: regex },
        { recipientName: regex },
        { receiverName: regex },
        { 'deliveryDetails.receiverName': regex },
        { 'deliveryDetails.address.city': regex },
        { 'deliveryDetails.address.street': regex },
      ]
    }).limit(20);

    const mapped = shipments.map(s => ({
      _id: s._id.toString(),
      shipmentId: s.shipmentId,
      customerName: s.deliveryDetails?.receiverName || s.recipientName || s.receiverName || 'Unknown',
      address: s.deliveryDetails?.address ? `${s.deliveryDetails.address.street || ''}, ${s.deliveryDetails.address.city || ''}`.trim() : s.recipientAddress || s.address || 'N/A',
      weight: s.parcelDetails?.dimensions?.weight ? `${s.parcelDetails.dimensions.weight} kg` : s.weight || '1.0 kg',
      cost: s.cost || 50,
      status: !s.driver ? 'unallocated' : s.driver.toString() === driver._id.toString() ? 'claimed' : 'assigned_other',
    }));
    res.status(200).json({ shipments: mapped });
  } catch (err) {
    console.error('Search shipments error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get driver route
const getDriverRoute = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Get pending and in-transit shipments
    const shipments = await Shipment.find({
      driver: driver._id,
      status: { $in: ['Assigned', 'Out for Delivery', 'In Transit'] }
    }).sort({ createdAt: 1 });

    // Mock coordinates for demo (in real app, use geocoding)
    const baseLat = -26.2041; // Johannesburg
    const baseLng = 28.0473;

    const stops = shipments.map((shipment, index) => ({
      id: shipment._id.toString(),
      shipmentId: shipment.shipmentId,
      address: shipment.recipientAddress || shipment.destinationAddress,
      customerName: shipment.recipientName || 'Unknown',
      latitude: baseLat + (Math.random() - 0.5) * 0.05,
      longitude: baseLng + (Math.random() - 0.5) * 0.05,
      status: index === 0 ? 'in_progress' : 'pending',
      order: index + 1,
    }));

    res.status(200).json({ stops });
  } catch (err) {
    console.error('Get driver route error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Optimize driver route
const optimizeDriverRoute = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Get shipments that need to be delivered
    const shipments = await Shipment.find({
      driver: driver._id,
      status: { $in: ['Assigned', 'Out for Delivery', 'In Transit', 'Pending Delivery'] }
    });

    // Simple optimization: sort by distance from driver's current location
    // In real app, use Google Maps Directions API or similar for better optimization
    const optimizedShipments = shipments.sort((a, b) => {
      // Extract coordinates from delivery details
      const aLat = a.deliveryDetails?.address?.latitude || a.latitude || 0;
      const aLng = a.deliveryDetails?.address?.longitude || a.longitude || 0;
      const bLat = b.deliveryDetails?.address?.latitude || b.latitude || 0;
      const bLng = b.deliveryDetails?.address?.longitude || b.longitude || 0;
      
      // Simple distance calculation (in real app, use actual driver location)
      const aDistance = Math.sqrt(aLat * aLat + aLng * aLng);
      const bDistance = Math.sqrt(bLat * bLat + bLng * bLng);
      
      return aDistance - bDistance;
    });

    // Update delivery order
    for (let i = 0; i < optimizedShipments.length; i++) {
      optimizedShipments[i].deliveryOrder = i + 1;
      await optimizedShipments[i].save();
    }

    // Format response for frontend
    const optimizedRoute = optimizedShipments.map((shipment, index) => ({
      id: shipment._id.toString(),
      shipmentId: shipment.shipmentId,
      address: shipment.deliveryDetails?.address ? 
        `${shipment.deliveryDetails.address.street || ''}, ${shipment.deliveryDetails.address.suburb || ''}, ${shipment.deliveryDetails.address.city || ''}`.trim() :
        shipment.recipientAddress || shipment.address,
      customerName: shipment.deliveryDetails?.receiverName || shipment.recipientName,
      status: shipment.status,
      order: index + 1,
      latitude: shipment.deliveryDetails?.address?.latitude || shipment.latitude,
      longitude: shipment.deliveryDetails?.address?.longitude || shipment.longitude,
    }));

    res.status(200).json({
      message: 'Route optimized successfully',
      optimizedRoute,
      totalStops: optimizedRoute.length
    });
  } catch (err) {
    console.error('Optimize route error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get driver references
const getDriverReferences = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Get all shipments for this driver
    const shipments = await Shipment.find({ driver: driver._id }).sort({ createdAt: -1 });

    const references = shipments.map(shipment => {
      let type = 'assigned';
      if (shipment.status === 'Delivered') type = 'completed';
      if (shipment.status === 'Returned') type = 'returned';

      return {
        id: shipment._id.toString(),
        shipmentId: shipment.shipmentId,
        type,
        referenceNumber: `REF-${new Date().getFullYear()}-${String(shipments.indexOf(shipment) + 1).padStart(3, '0')}`,
        description: shipment.description || `${shipment.packageType || 'Package'} - ${shipment.recipientName || 'Customer'}`,
        date: shipment.createdAt ? shipment.createdAt.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        status: shipment.status.toLowerCase(),
      };
    });

    res.status(200).json({ references });
  } catch (err) {
    console.error('Get driver references error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Debug function to check notification-driver relationship
const debugNotifications = async (req, res) => {
  const { driverId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Get all notifications
    const allNotifications = await Notification.find({}).sort({ createdAt: -1 });

    // Get notifications for this driver
    const driverNotifications = await Notification.find({ userId: driver._id });

    // Check for shipment SHP900155 specifically
    const shipmentNotifications = await Notification.find({
      message: { $regex: 'SHP900155', $options: 'i' }
    });

    res.status(200).json({
      driverInfo: {
        driverId: driver.driverId,
        objectId: driver._id.toString(),
        username: driver.username
      },
      totalNotifications: allNotifications.length,
      driverNotifications: driverNotifications.length,
      shipmentNotifications: shipmentNotifications.map(n => ({
        id: n._id,
        userId: n.userId?.toString(),
        title: n.title,
        type: n.type,
        message: n.message.substring(0, 100)
      }))
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get navigation data for a specific shipment
const getDriverNavigation = async (req, res) => {
  const { driverId, shipmentId } = req.params;

  try {
    const driver = await Driver.findOne({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const shipment = await Shipment.findOne({ shipmentId });
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    // Check if shipment is assigned to this driver
    if (shipment.driver && shipment.driver.toString() !== driver._id.toString()) {
      return res.status(403).json({ message: 'Shipment not assigned to this driver' });
    }

    // Extract destination coordinates from the proper location in the schema
    let destinationLat = null;
    let destinationLng = null;
    let destinationAddress = 'Destination';

    // Try to get coordinates from deliveryDetails (preferred)
    if (shipment.deliveryDetails && shipment.deliveryDetails.address) {
      destinationLat = shipment.deliveryDetails.address.latitude;
      destinationLng = shipment.deliveryDetails.address.longitude;
      destinationAddress = [
        shipment.deliveryDetails.address.street,
        shipment.deliveryDetails.address.suburb,
        shipment.deliveryDetails.address.city
      ].filter(Boolean).join(', ') || shipment.deliveryDetails.receiverName || 'Destination';
    }
    
    // Fallback to legacy fields
    if (!destinationLat && shipment.latitude) {
      destinationLat = shipment.latitude;
      destinationLng = shipment.longitude;
      destinationAddress = shipment.recipientAddress || shipment.address || 'Destination';
    }

    if (!destinationLat || !destinationLng) {
      return res.status(400).json({ 
        message: 'Destination coordinates not available for this shipment',
        details: 'The shipment does not have valid latitude/longitude coordinates'
      });
    }

    // Live distance/ETA from driver's current location if provided (?lat=&lng=)
    const driverLat = parseFloat(req.query.lat);
    const driverLng = parseFloat(req.query.lng);
    const hasDriverPos = !isNaN(driverLat) && !isNaN(driverLng);

    const haversineKm = (lat1, lon1, lat2, lon2) => {
      const R = 6371;
      const dLat = (lat2-lat1)*Math.PI/180;
      const dLon = (lon2-lon1)*Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };
    const bearing = (lat1, lon1, lat2, lon2) => {
      const y = Math.sin((lon2-lon1)*Math.PI/180)*Math.cos(lat2*Math.PI/180);
      const x = Math.cos(lat1*Math.PI/180)*Math.sin(lat2*Math.PI/180) - Math.sin(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.cos((lon2-lon1)*Math.PI/180);
      const brg = (Math.atan2(y,x)*180/Math.PI+360)%360;
      const dirs = ['N','NE','E','SE','S','SW','W','NW'];
      return dirs[Math.round(brg/45)%8];
    };

    let distanceKm = 5.0;
    if (hasDriverPos) distanceKm = haversineKm(driverLat, driverLng, destinationLat, destinationLng);
    const distanceStr = distanceKm < 1 ? `${Math.round(distanceKm*1000)} m` : `${distanceKm.toFixed(1)} km`;
    const avgSpeedKmh = 35;
    const etaMin = Math.max(1, Math.round((distanceKm / avgSpeedKmh) * 60));
    const estimatedTime = etaMin < 60 ? `${etaMin} min` : `${Math.floor(etaMin/60)}h ${etaMin%60}m`;
    const totalDistance = distanceStr;
    const dir = hasDriverPos ? bearing(driverLat, driverLng, destinationLat, destinationLng) : 'N';
    const instruction = distanceKm < 0.3 ? 'Approaching destination — prepare to stop' : `Head ${dir} toward ${destinationAddress.split(',')[0] || 'destination'}`;
    const nextInstruction = distanceKm < 0.3 ? 'You have arrived' : `Continue ${distanceStr} — ${estimatedTime} remaining`;

    const now = new Date();
    const arrivalTime = new Date(now.getTime() + etaMin * 60000);
    const arrivalTimeStr = arrivalTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    // Remaining stops = pending shipments for this driver
    let remainingStops = 1;
    try {
      remainingStops = await Shipment.countDocuments({ driver: driver._id, status: { $in: ['Pending Delivery','Out For Delivery','In Transit','Picked Up','Driver Assigned','Out for Delivery','Pending Collection'] } });
    } catch {}

    res.status(200).json({
      distance: distanceStr,
      instruction,
      nextInstruction,
      estimatedTime,
      totalDistance,
      arrivalTime: arrivalTimeStr,
      remainingStops,
      destinationAddress,
      destination: { latitude: destinationLat, longitude: destinationLng }
    });
  } catch (err) {
    console.error('Get driver navigation error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = {
  requestDriverVerificationCode,
  registerDriver,
  loginDriver,
  getDriverNotifications,
  getDriverShipments,
  getDriverShipmentDetails,
  updateShipmentStatus,
  updateShipmentStatusWithPOD,
  updateDriverFCMToken,
  testPushNotification,
  checkDriver,
  forgotPassword,
  resetPassword,
  createTestNotification,
  cleanupLoginNotifications,
  debugNotifications,
  getDriverEarnings,
  getUnallocatedShipments,
  claimShipment,
  linkShipmentWithBarcode,
  getDriverRoute,
  optimizeDriverRoute,
  getDriverReferences,
  getDriverNavigation,
  searchShipments,
};