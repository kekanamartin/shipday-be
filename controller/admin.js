const Driver = require('../models/Driver');
const Notification = require('../models/Notification');
const Shipment = require('../models/Shipment');
const Order = require('../models/Order');
const Status = require('../models/Status');
const Pricing = require('../models/Pricing');
const { calculateShipmentPricing } = require('../utils/shipmentPricing');
const { refreshShipmentCustomerActivation } = require('../services/marketingActivationService');
// Trigger server restart for logic update
const { sendPushNotification } = require('../utils/pushNotification');
const { sendShipmentStatusEmail } = require('../utils/shipmentEmailTemplates');

// Get drivers by vehicle type
const getDriversByVehicleType = async (req, res) => {
  const { vehicleType } = req.params;
  try {
    const drivers = await Driver.find({
      status: 'approved',
      vehicleType: vehicleType
    }).select('-password');
    res.status(200).json({ drivers });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Get all pending drivers
const getPendingDrivers = async (req, res) => {
  try {
    const drivers = await Driver.find({ status: 'pending' }).select('-password');
    res.status(200).json({ drivers });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Get all accepted drivers
const getAcceptedDrivers = async (req, res) => {
  try {

    const drivers = await Driver.find({ status: 'approved' }).select('-password');

    res.status(200).json({ drivers });
  } catch (err) {
    console.error('Error fetching approved drivers:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get all drivers
const getAllDrivers = async (req, res) => {
  try {
    const drivers = await Driver.find().select('-password');
    res.status(200).json({ drivers });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Approve/Reject driver
const updateDriverStatus = async (req, res) => {
  const { driverId, status } = req.body;

  if (!driverId || !status) {
    return res.status(400).json({ message: 'Valid driverId and status are required' });
  }

  // Try to get valid driver statuses from database
  let allowedStatuses = ['approved', 'rejected']; // fallback
  try {
    const statusDocs = await Status.find({ type: 'driver', isActive: true });
    if (statusDocs.length > 0) {
      allowedStatuses = statusDocs.map(s => s.name);
    }
  } catch (dbErr) {
    console.log('Could not fetch driver statuses from database, using fallback');
  }

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: `Invalid status. Allowed statuses: ${allowedStatuses.join(', ')}` });
  }

  try {
    // First check if driver exists
    const existingDriver = await Driver.findOne({ driverId });
    if (!existingDriver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Update the driver
    const driver = await Driver.findOneAndUpdate(
      { driverId },
      { status },
      { new: true }
    );

    // Try to create notification, but don't fail the whole operation if it fails
    try {
      const notification = new Notification({
        userId: driver._id,
        title: status === 'approved' ? 'Account Approved' : 'Account Rejected',
        message: status === 'approved'
          ? 'Your driver account has been approved. You can now start accepting deliveries.'
          : 'Your driver account has been rejected. Please contact support for more information.',
        type: 'status_update'
      });
      await notification.save();
    } catch (notificationErr) {
      console.error('Failed to create notification:', notificationErr.message);
      // Continue with success response even if notification fails
    }

    res.status(200).json({
      message: `Driver ${status} successfully`,
      driver: {
        driverId: driver.driverId,
        username: driver.username,
        status: driver.status
      }
    });
  } catch (err) {
    console.error('Error updating driver status:', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update driver details
const updateDriverDetails = async (req, res) => {
  const { driverId, username, email, phone, vehicleType, vehicleNumber, driverImage } = req.body;

  if (!driverId) {
    return res.status(400).json({ message: 'Driver ID is required' });
  }

  try {
    // First check if driver exists
    const existingDriver = await Driver.findOne({ driverId });
    if (!existingDriver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    // Build update object with only provided fields
    const updateData = {};
    if (username) updateData.username = username;
    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;
    if (vehicleType) updateData.vehicleType = vehicleType;
    if (vehicleNumber) updateData.vehicleNumber = vehicleNumber.toUpperCase();
    
    // Handle file upload for driver image
    if (req.file) {
      updateData.driverImage = req.file.path;
    } else if (driverImage) {
      updateData.driverImage = driverImage;
    }

    // Update the driver
    const driver = await Driver.findOneAndUpdate(
      { driverId },
      updateData,
      { new: true }
    ).select('-password');

    res.status(200).json({
      message: 'Driver details updated successfully',
      driver
    });
  } catch (err) {
    console.error('Error updating driver details:', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Create new shipment
const createShipment = async (req, res) => {
  try {


    const {
      senderDetails, collectionDetails, deliveryDetails, parcelDetails, payment, // New Schema
      orderNumber, marketplaceName, numberOfBoxes, parcels, bookedBy, isFulfillment, // Fulfillment
      selectedPackaging,
      senderName, senderPhone, receiverName, receiverPhone, start, end, parcelWeight, packageType, cost, eta, notes // Legacy
    } = req.body;

    const generateShipmentId = require('../utils/generateShipmentId');
    const { generatePaymentData } = require('../utils/payfast');
    const shipmentId = await generateShipmentId();
    const crypto = require('crypto');

    let shipmentData = {
      shipmentId,
      barcode: shipmentId,
      notes: notes || ''
    };

    let pricingBreakdown = null;
    let shipmentAmount = 0;

    if (senderDetails && collectionDetails && deliveryDetails && parcelDetails) {
      const pricing = await Pricing.findOne() || new Pricing();
      const requestedPackaging = parcelDetails.packaging ?? selectedPackaging ?? [];
      const pricingDimensions = Array.isArray(parcels) && parcels.length > 0
        ? parcels
        : Array.isArray(parcelDetails.dimensions)
          ? parcelDetails.dimensions
          : parcelDetails.dimensions
            ? [parcelDetails.dimensions]
            : [];
      const pricingParcelDetails = {
        ...parcelDetails,
        dimensions: pricingDimensions,
      };
      if (
        !isFulfillment &&
        numberOfBoxes !== undefined &&
        pricingDimensions.length > 0 &&
        Number(numberOfBoxes) !== pricingDimensions.length
      ) {
        return res.status(400).json({ message: 'numberOfBoxes must match the number of parcel dimensions' });
      }
      const shipmentBoxCount = isFulfillment
        ? numberOfBoxes ?? Math.max(pricingDimensions.length, 1)
        : Math.max(pricingDimensions.length, Number(numberOfBoxes) || 1);

      try {
        pricingBreakdown = calculateShipmentPricing({
          parcelDetails: pricingParcelDetails,
          collectionDetails,
          deliveryDetails,
          pricing,
          selectedPackaging: requestedPackaging,
          fulfillmentAmount: isFulfillment ? payment?.amount ?? cost : undefined,
          parcelCount: shipmentBoxCount,
        });
      } catch (pricingError) {
        return res.status(400).json({ message: pricingError.message });
      }

      shipmentAmount = pricingBreakdown.total;
    }

    // Check if using new detailed schema
    if (senderDetails && collectionDetails && deliveryDetails && parcelDetails) {
      // Calculate ETA based on service type
      const today = new Date();
      if (parcelDetails.serviceType === 'express') {
        today.setDate(today.getDate() + 2); // 2 days
      } else {
        today.setDate(today.getDate() + 4); // 4 days
      }

      // Populate BOTH new structure AND legacy fields together
      shipmentData = {
        ...shipmentData,
        senderDetails,
        collectionDetails: {
          ...collectionDetails,
          numberOfItems: shipmentBoxCount,
        },
        deliveryDetails,
        parcelDetails: {
          ...parcelDetails,
          dimensions: pricingDimensions[0] || parcelDetails.dimensions,
          packaging: pricingBreakdown?.packaging || []
        },
        orderNumber,
        marketplaceName,
        numberOfBoxes: shipmentBoxCount,
        parcels: pricingDimensions,
        bookedBy,
        isFulfillment: !!isFulfillment,
        payment: {
          ...payment,
          amount: shipmentAmount,
          status: isFulfillment ? (payment?.status || 'pending') : 'pending'
        },
        pricingBreakdown: pricingBreakdown ? {
          baseCost: pricingBreakdown.baseCost,
          packagingCost: pricingBreakdown.packagingCost,
          interProvinceFee: pricingBreakdown.interProvinceFee,
          oversizeBoxCount: pricingBreakdown.oversizeBoxCount,
          oversizeFee: pricingBreakdown.oversizeFee,
          additionalBoxCount: pricingBreakdown.additionalBoxCount,
          additionalBoxFee: pricingBreakdown.additionalBoxFee,
          total: pricingBreakdown.total
        } : undefined,
        // Auto-assign customer if creator is a Customer
        customer: (req.user && req.user.role === 'Customer') ? req.user._id : null,

        // Populate legacy fields for compatibility - REQUIRED to avoid validation error
        senderName: senderDetails.fullName || 'N/A',
        senderPhone: senderDetails.mobile || '0000000000',
        receiverName: deliveryDetails.receiverName || 'N/A',
        receiverPhone: deliveryDetails.mobile || '0000000000',
        start: collectionDetails.address.city || 'Unknown',
        end: deliveryDetails.address.city || 'Unknown',
        parcelWeight: parcelDetails.dimensions.weight || 1,
        packageType: parcelDetails.parcelType || 'parcel',
        cost: shipmentAmount,
        eta: today
      };

    } else {
      // Legacy flow - Fallback


      const etaDate = eta ? new Date(eta) : new Date();
      etaDate.setDate(etaDate.getDate() + 3); // Default 3 days

      shipmentData = {
        ...shipmentData,
        senderName: senderName || 'N/A',
        senderPhone: senderPhone || '0000000000',
        receiverName: receiverName || 'N/A',
        receiverPhone: receiverPhone || '0000000000',
        start: start || 'Unknown',
        end: end || 'Unknown',
        parcelWeight: parcelWeight || 1,
        packageType: packageType || 'parcel',
        cost: cost || 0,
        eta: etaDate,

        // Construct minimal detailed objects
        senderDetails: {
          fullName: senderName || 'N/A',
          email: 'legacy@example.com',
          mobile: senderPhone || '0000000000',
          address: { street: 'N/A', suburb: 'N/A', city: start || 'Unknown', province: 'N/A', postalCode: '0000' }
        },
        collectionDetails: {
          dispatcherName: senderName || 'N/A',
          email: 'legacy@example.com',
          mobile: senderPhone || '0000000000',
          address: { street: 'N/A', suburb: 'N/A', city: start || 'Unknown', province: 'N/A', postalCode: '0000' }
        },
        deliveryDetails: {
          receiverName: receiverName || 'N/A',
          email: 'legacy@example.com',
          mobile: receiverPhone || '0000000000',
          address: { street: 'N/A', suburb: 'N/A', city: end || 'Unknown', province: 'N/A', postalCode: '0000' }
        },
        parcelDetails: {
          serviceType: 'economy',
          parcelType: packageType || 'parcel',
          dimensions: { weight: parcelWeight || 1 }
        },
        payment: {
          amount: cost || 0,
          method: 'cod',
          status: 'pending'
        }
      };
    }



    const shipment = new Shipment(shipmentData);
    await shipment.save();

    // Create Transaction Record
    try {
      const Transaction = require('../models/Transaction');

      const uuidSmall = crypto.randomBytes(4).toString('hex').toUpperCase();

      const userId = (req.user && req.user._id) ? req.user._id : null;
      // Identify customer name - use User's name if logged in, otherwise Sender Name
      const customerName = (req.user && req.user.fullName)
        ? req.user.fullName
        : (shipmentData.senderDetails?.fullName || shipmentData.senderName || 'Guest');

      // Map methods to match Transaction enum
      const methodMap = {
        'cod': 'COD',
        'payfast': 'PayFast',
        'ewallet': 'Wallet',
        'gateway': 'Card',
        'wallet': 'Wallet',
        'fulfillment': 'Card' // Recorded as a Sale/Card type for reporting
      };

      const rawMethod = shipmentData.payment?.method || 'cod';
      const normalizedMethod = methodMap[rawMethod.toLowerCase()] || 'COD';

      const txnData = {
        txnId: "TXN-" + uuidSmall,
        customer: customerName,
        userId: userId,
        type: 'Debit',
        amount: shipmentData.payment?.amount || shipmentData.cost || 0,
        method: normalizedMethod,
        status: (shipmentData.payment?.status === 'paid' || shipmentData.payment?.status === 'completed') ? 'Completed' : 'Pending',
        orderId: shipment.shipmentId
      };

      await new Transaction(txnData).save();

    } catch (txnError) {
      console.error("Failed to create transaction record:", txnError.message);
    }

    // Trigger automatic email notification for new shipment - DO NOT await to prevent hanging
    sendShipmentStatusEmail(shipment, 'Pending Collect').catch(e => console.error("Async Email Error:", e));

    // Generate PayFast data if payment method is gateway or wallet
    let paymentData = null;
    if (shipment.payment && (shipment.payment.method === 'gateway' || shipment.payment.method === 'wallet' || shipment.payment.method === 'payfast' || shipment.payment.method === 'ewallet')) {
      try {
        paymentData = generatePaymentData(shipment);
      } catch (e) {
        console.error("Error generating payment data:", e);
      }
    }

    res.status(201).json({
      message: 'Shipment created successfully',
      shipment,
      paymentData
    });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Shipment ID already exists' });
    }
    console.error("Create Shipment Error:", err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message, error: err.errors });
    }
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get all assigned shipments
const getAssignedShipments = async (req, res) => {
  try {
    const shipments = await Shipment.find({ driver: { $ne: null } })
      .populate('driver', 'username driverId')
      .sort({ createdAt: -1 });
    res.status(200).json({ shipments });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Assign shipment to driver
const assignShipmentToDriver = async (req, res) => {
  const { shipmentId, driverId } = req.body;

  if (!shipmentId || !driverId) {
    return res.status(400).json({ message: 'shipmentId and driverId are required' });
  }

  try {
    const shipment = await Shipment.findOne({
      shipmentId,
      status: { $nin: ['Delivered', 'Cancelled'] }
    });
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found (must be Pending or Shipping)' });
    }


    const driver = await Driver.findOne({
      driverId,
      status: 'approved'
    });


    if (!driver) {
      return res.status(404).json({ message: 'Approved driver not found' });
    }

    const updatedShipment = await Shipment.findOneAndUpdate(
      { shipmentId },
      {
        driver: driver._id,
        driverName: driver.username,
        status: 'Shipping'
      },
      { new: true }
    ).populate('driver', 'username driverId');

    // Create notification for driver



    const notification = new Notification({
      userId: driver._id,
      title: 'New Shipment Assigned',
      message: `Shipment ID: ${shipmentId}\nFrom: ${shipment.start}\nTo: ${shipment.end}\nPackage: ${shipment.packageType}\nWeight: ${shipment.parcelWeight}kg\nETA: ${shipment.eta}\nNotes: ${shipment.notes || 'None'}`,
      type: 'shipment_assigned'
    });

    const savedNotification = await notification.save();



    // Send push notification if driver has FCM token
    if (driver.fcmToken) {
      try {
        await sendPushNotification(
          driver.fcmToken,
          'New Shipment Assigned',
          `You have been assigned shipment ${shipmentId} from ${shipment.start} to ${shipment.end}`,
          {
            shipmentId,
            type: 'shipment_assigned',
            start: shipment.start,
            end: shipment.end
          }
        );

      } catch (pushError) {
        console.error('Failed to send push notification:', pushError.message);
      }
    } else {

    }

    // Emit socket notification
    const io = req.app?.get('io');
    if (io) {
      io.emit('shipment-assigned', {
        driverId: driver.driverId,
        shipmentId,
        notification
      });
    }

    // Trigger automatic email notification
    await sendShipmentStatusEmail(updatedShipment, 'Shipping');

    res.status(200).json({
      message: 'Shipment assigned successfully',
      shipment: updatedShipment
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get order details by ID
const getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findOne({ orderId });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.status(200).json({ order });
  } catch (err) {
    console.error('Error fetching order details:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get shipment by ID
const getShipmentById = async (req, res) => {
  try {
    const { shipmentId } = req.params;
    const shipment = await Shipment.findOne({ shipmentId })
      .populate({
        path: 'driver',
        select: 'username driverId',
        options: { strictPopulate: false }
      });

    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    res.status(200).json({ shipment });
  } catch (err) {
    console.error('Error fetching shipment:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get all shipments
const getAllShipments = async (req, res) => {
  try {
    const shipments = await Shipment.find()
      .populate({
        path: 'driver',
        select: 'username driverId',
        options: { strictPopulate: false }
      })
      .sort({ createdAt: -1 });

    // Update driverName for shipments with assigned drivers
    const updatedShipments = shipments.map(shipment => {
      const shipmentObj = shipment.toObject();
      if (shipmentObj.driver && shipmentObj.driver.username) {
        shipmentObj.driverName = shipmentObj.driver.username;
      }
      return shipmentObj;
    });

    res.status(200).json({ shipments: updatedShipments });
  } catch (err) {
    console.error('Error fetching shipments:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update shipment details
const updateShipment = async (req, res) => {
  const { shipmentId, senderName, senderPhone, receiverName, receiverPhone, start, end, parcelWeight, packageType, cost, eta, notes, status } = req.body;

  if (!shipmentId) {
    return res.status(400).json({ message: 'shipmentId is required' });
  }

  try {
    const updateData = {};
    if (senderName) updateData.senderName = senderName;
    if (senderPhone) updateData.senderPhone = senderPhone;
    if (receiverName) updateData.receiverName = receiverName;
    if (receiverPhone) updateData.receiverPhone = receiverPhone;
    if (start) updateData.start = start;
    if (end) updateData.end = end;
    if (parcelWeight) updateData.parcelWeight = parcelWeight;
    if (packageType) updateData.packageType = packageType;
    if (cost) updateData.cost = cost;
    if (eta) updateData.eta = new Date(eta);
    if (notes !== undefined) updateData.notes = notes;
    if (status) updateData.status = status;

    const shipment = await Shipment.findOneAndUpdate(
      { shipmentId },
      updateData,
      { new: true }
    );

    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    if (status === 'Delivered') {
      await refreshShipmentCustomerActivation(shipment);
    }

    // Trigger automatic email notification if status was updated
    if (status) {
      await sendShipmentStatusEmail(shipment, status);
    }

    res.status(200).json({
      message: 'Shipment updated successfully',
      shipment
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Delete shipment
const deleteShipment = async (req, res) => {
  const { shipmentId } = req.params;

  if (!shipmentId) {
    return res.status(400).json({ message: 'shipmentId is required' });
  }

  try {
    const shipment = await Shipment.findOneAndDelete({ shipmentId });

    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    res.status(200).json({
      message: 'Shipment deleted successfully'
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Generate Waybill PDF
const downloadWaybill = async (req, res) => {
  const { shipmentId } = req.params;
  try {
    const shipment = await Shipment.findOne({ shipmentId });
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    const { generateWaybill } = require('../utils/pdfGenerator');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=waybill-${shipmentId}.pdf`);
    generateWaybill(shipment, res);
  } catch (err) {
    console.error('Error generating waybill:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Generate POD PDF
const downloadPOD = async (req, res) => {
  const { shipmentId } = req.params;
  try {
    const shipment = await Shipment.findOne({ shipmentId });
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    const { generatePOD } = require('../utils/pdfGenerator');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=pod-${shipmentId}.pdf`);
    generatePOD(shipment, res);
  } catch (err) {
    console.error('Error generating POD:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Create new customer manually from dashboard
const createCustomer = async (req, res) => {
  const {
    fullName,
    email,
    password,
    companyName,
    phone,
    address,
    accountType,
    idNumber,
    accountOwnerIdNumber,
    businessRegistrationNumber,
    status
  } = req.body;
  const User = require('../models/User');
  const bcrypt = require('bcryptjs');

  const normalizeValue = (value) => value === undefined || value === null ? undefined : String(value).trim();
  const normalizedAccountType = accountType === 'Business' ? 'Business' : 'Personal';
  if (status !== undefined && !['Active', 'Disabled'].includes(status)) {
    return res.status(400).json({ message: 'Customer status must be Active or Disabled' });
  }
  const normalizedStatus = status || 'Active';
  const normalizedIdNumber = normalizedAccountType === 'Personal' ? normalizeValue(idNumber) : undefined;
  const normalizedBusinessRegistrationNumber = normalizedAccountType === 'Business' ? normalizeValue(businessRegistrationNumber) : undefined;
  const normalizedAccountOwnerIdNumber = normalizedAccountType === 'Business' ? normalizeValue(accountOwnerIdNumber) : undefined;

  if (normalizedAccountType === 'Personal' && (!fullName || !email || !password || !normalizedIdNumber)) {
    return res.status(400).json({ message: 'Full Name, Email, Password, and ID Number are required for personal accounts' });
  }

  if (normalizedAccountType === 'Business' && (!fullName || !companyName || !email || !password || !normalizedBusinessRegistrationNumber || !normalizedAccountOwnerIdNumber)) {
    return res.status(400).json({ message: 'Full Name, Company Name, Email, Password, Business Registration Number, and ID Number of the account holder are required for business accounts' });
  }

  const identityNumber = normalizedAccountType === 'Personal' ? normalizedIdNumber : normalizedAccountOwnerIdNumber;
  if (identityNumber && !/^\d{3}$/.test(identityNumber)) {
    return res.status(400).json({ message: 'ID number must contain exactly 3 digits' });
  }

  try {
    const normalizedEmail = String(email || '').toLowerCase().trim();
    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    if (normalizedAccountType === 'Personal') {
      const duplicateId = await User.findOne({ idNumber: normalizedIdNumber });
      if (duplicateId) {
        return res.status(400).json({ message: 'This ID number is already linked to an account' });
      }
    }

    if (normalizedAccountType === 'Business') {
      const duplicateBusinessReg = await User.findOne({ businessRegistrationNumber: normalizedBusinessRegistrationNumber });
      if (duplicateBusinessReg) {
        return res.status(400).json({ message: 'This business registration number already has an account' });
      }

      const duplicateAccountOwner = await User.findOne({ accountOwnerIdNumber: normalizedAccountOwnerIdNumber });
      if (duplicateAccountOwner) {
        return res.status(400).json({ message: 'This ID number is already linked to another account opening request' });
      }
    }

    // Generate Customer ID
    const generateCustomerId = async () => {
      const count = await User.countDocuments();
      const nextNumber = count + 1;
      const padded = String(nextNumber).padStart(3, '0');
      return `CUST${padded}`;
    };

    const customerId = await generateCustomerId();
    const hashedPassword = await bcrypt.hash(password, 10);

    const userPayload = {
      customerId,
      email: normalizedEmail,
      password: hashedPassword,
      accountType: normalizedAccountType,
      fullName,
      companyName: normalizedAccountType === 'Business' ? companyName : '',
      phone: phone || '',
      status: normalizedStatus,
      role: 'Customer',
      profileCompleted: Boolean(phone),
      address: address || {
        street: '',
        complexOrBusinessHub: '',
        city: '',
        province: '',
        postalCode: '',
        country: 'South Africa'
      }
    };

    if (normalizedAccountType === 'Personal' && normalizedIdNumber) {
      userPayload.idNumber = normalizedIdNumber;
    }

    if (normalizedAccountType === 'Business' && normalizedBusinessRegistrationNumber) {
      userPayload.businessRegistrationNumber = normalizedBusinessRegistrationNumber;
    }

    if (normalizedAccountType === 'Business' && normalizedAccountOwnerIdNumber) {
      userPayload.accountOwnerIdNumber = normalizedAccountOwnerIdNumber;
    }

    const newUser = new User(userPayload);

    if (address) {
      newUser.location = {
        address: `${address.street || ''}, ${address.city || ''}, ${address.province || ''}, ${address.country || ''}`.replace(/^, |, $/, '').replace(/, , /g, ', '),
      };
    }

    await newUser.save();

    res.status(201).json({
      message: 'Customer created successfully',
      customer: {
        id: newUser.customerId,
        name: newUser.fullName || newUser.companyName,
        email: newUser.email,
        company: newUser.companyName,
        role: newUser.role
      }
    });

  } catch (err) {
    if (err.code === 11000) {
      const duplicateField = Object.keys(err.keyPattern || {})[0];
      return res.status(400).json({ message: `This ${duplicateField.replace(/([A-Z])/g, ' $1').trim()} is already in use` });
    }

    console.error("Create Customer Error:", err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Delete Driver
const deleteDriver = async (req, res) => {
  const { driverId } = req.params;
  try {
    const driver = await Driver.findOneAndDelete({ driverId });
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }
    res.status(200).json({ message: 'Driver deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update customer status and info (Super Admin only)
const updateCustomerStatus = async (req, res) => {
  const { userId, status, fullName, email, companyName, address, phone } = req.body;
  const User = require('../models/User');

  if (!userId || !['Active', 'Disabled'].includes(status)) {
    return res.status(400).json({ message: 'User ID and valid status (Active/Disabled) required' });
  }

  try {
    const updateData = { status };
    if (fullName) updateData.fullName = fullName;
    if (email) updateData.email = email;
    if (companyName !== undefined) updateData.companyName = companyName;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) {
      updateData.address = address;
      // Also update legacy location for backward compatibility
      updateData.location = {
        address: `${address.street || ''}, ${address.city || ''}, ${address.province || ''}, ${address.country || ''}`.replace(/^, |, $/, '').replace(/, , /g, ', '),
      };
    }

    const user = await User.findByIdAndUpdate(userId, updateData, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.status(200).json({ message: 'Customer updated successfully', user });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update customer wallet balance (Super Admin only)
const updateCustomerWallet = async (req, res) => {
  const { userId, amount, description } = req.body;
  const Wallet = require('../models/Wallet');
  const Transaction = require('../models/Transaction');
  const User = require('../models/User');
  const { v4: uuidv4 } = require('uuid');

  const numericAmount = Number(amount);
  const supportingDocument = req.file ? req.file.path.replace(/\\/g, '/') : null;

  if (!userId || amount === undefined || Number.isNaN(numericAmount)) {
    return res.status(400).json({ message: 'User ID and amount are required' });
  }

  try {
    const type = numericAmount >= 0 ? 'credit' : 'debit';
    const absAmount = Math.abs(numericAmount);
    const transactionDescription = description || 'Admin Adjustment';

    const walletTransaction = {
      type,
      amount: absAmount,
      description: transactionDescription,
      date: new Date(),
      supportingDocument
    };

    const updatedWallet = await Wallet.findOneAndUpdate(
      { userId },
      {
        $inc: { balance: numericAmount },
        $push: { transactions: walletTransaction }
      },
      { new: true, upsert: true }
    );

    const user = await User.findById(userId).select('fullName email');
    const customerName = user ? (user.fullName || user.email) : 'Unknown User';

    await Transaction.create({
      txnId: "TXN-ADMIN-ADJ-" + uuidv4().slice(0, 8).toUpperCase(),
      customer: customerName,
      userId: userId,
      type: type === 'credit' ? 'Credit' : 'Debit',
      amount: absAmount,
      method: 'Wallet',
      status: 'Completed',
      orderId: transactionDescription,
      date: new Date(),
      supportingDocument
    });

    res.status(200).json({ message: 'Wallet updated successfully', wallet: updatedWallet });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get all available order statuses
const getOrderStatuses = async (req, res) => {
  try {
    // Try to get statuses from database first
    let statuses = [];
    try {
      const statusDocs = await Status.find({ type: 'order', isActive: true }).sort({ sortOrder: 1, name: 1 });
      statuses = statusDocs.map(s => s.name);
    } catch (dbErr) {
      console.log('Could not fetch from database, using fallback');
    }

    // Fallback to hardcoded statuses if database is empty or fails
    if (statuses.length === 0) {
      statuses = [
        'Pending',
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
    }
    
    res.status(200).json({ statuses });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update order status
const updateOrderStatus = async (req, res) => {
  const { orderId, status } = req.body;

  if (!orderId || !status) {
    return res.status(400).json({ message: 'orderId and status are required' });
  }

  // Try to get valid order statuses from database
  let allowedStatuses = [
    'Pending',
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
  ]; // fallback
  
  try {
    const statusDocs = await Status.find({ type: 'order', isActive: true });
    if (statusDocs.length > 0) {
      allowedStatuses = statusDocs.map(s => s.name);
    }
  } catch (dbErr) {
    console.log('Could not fetch order statuses from database, using fallback');
  }

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: `Invalid status. Allowed statuses: ${allowedStatuses.join(', ')}` });
  }

  try {
    const order = await Order.findOneAndUpdate(
      { orderId },
      { status },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.status(200).json({
      message: `Order status updated to ${status} successfully`,
      order
    });
  } catch (err) {
    console.error('Update Order Status Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Create custom order status (if needed in future)
const createCustomStatus = async (req, res) => {
  const { statusName, description } = req.body;

  if (!statusName) {
    return res.status(400).json({ message: 'statusName is required' });
  }

  try {
    // This could be expanded to store custom statuses in a database
    // For now, return the standard statuses plus the custom one
    const standardStatuses = [
      'Pending',
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

    if (standardStatuses.includes(statusName)) {
      return res.status(400).json({ message: 'Status already exists in standard statuses' });
    }

    // For now, just return a message - in future you might want to store custom statuses
    res.status(200).json({
      message: 'Custom status creation would be implemented with a database table for custom statuses',
      customStatus: { statusName, description },
      note: 'Currently only standard statuses are supported'
    });
  } catch (err) {
    console.error('Create Custom Status Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ============================================
// NEW: Dynamic Status Management CRUD Operations
// ============================================

// Get all statuses (filtered by type if provided)
const getAllStatuses = async (req, res) => {
  try {
    const { type } = req.query;
    const filter = type ? { type, isActive: true } : { isActive: true };
    const statuses = await Status.find(filter).sort({ sortOrder: 1, name: 1 });
    res.status(200).json({ statuses });
  } catch (err) {
    console.error('Get All Statuses Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get status by ID
const getStatusById = async (req, res) => {
  try {
    const { id } = req.params;
    const status = await Status.findById(id);
    if (!status) {
      return res.status(404).json({ message: 'Status not found' });
    }
    res.status(200).json({ status });
  } catch (err) {
    console.error('Get Status By ID Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Create new status
const createStatus = async (req, res) => {
  const { name, type, description, color, sortOrder } = req.body;

  if (!name || !type) {
    return res.status(400).json({ message: 'Name and type are required' });
  }

  if (!['order', 'driver'].includes(type)) {
    return res.status(400).json({ message: 'Type must be either "order" or "driver"' });
  }

  try {
    // Check if status with same name and type already exists
    const existingStatus = await Status.findOne({ name, type });
    if (existingStatus) {
      return res.status(400).json({ message: 'Status with this name already exists for this type' });
    }

    const status = new Status({
      name,
      type,
      description,
      color: color || 'secondary',
      sortOrder: sortOrder || 0
    });

    await status.save();
    res.status(201).json({ message: 'Status created successfully', status });
  } catch (err) {
    console.error('Create Status Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Update status
const updateStatus = async (req, res) => {
  const { id } = req.params;
  const { name, description, color, isActive, sortOrder } = req.body;

  try {
    const status = await Status.findById(id);
    if (!status) {
      return res.status(404).json({ message: 'Status not found' });
    }

    // Don't allow changing the type
    if (req.body.type && req.body.type !== status.type) {
      return res.status(400).json({ message: 'Cannot change status type' });
    }

    // Check if new name conflicts with existing status
    if (name && name !== status.name) {
      const existingStatus = await Status.findOne({ name, type: status.type });
      if (existingStatus) {
        return res.status(400).json({ message: 'Status with this name already exists for this type' });
      }
    }

    // Update fields
    if (name) status.name = name;
    if (description !== undefined) status.description = description;
    if (color) status.color = color;
    if (isActive !== undefined) status.isActive = isActive;
    if (sortOrder !== undefined) status.sortOrder = sortOrder;

    await status.save();
    res.status(200).json({ message: 'Status updated successfully', status });
  } catch (err) {
    console.error('Update Status Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Delete status
const deleteStatus = async (req, res) => {
  const { id } = req.params;

  try {
    const status = await Status.findById(id);
    if (!status) {
      return res.status(404).json({ message: 'Status not found' });
    }

    // Don't allow deletion of default statuses
    if (status.isDefault) {
      return res.status(400).json({ message: 'Cannot delete default status' });
    }

    await Status.findByIdAndDelete(id);
    res.status(200).json({ message: 'Status deleted successfully' });
  } catch (err) {
    console.error('Delete Status Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Initialize default statuses
const initializeDefaultStatuses = async (req, res) => {
  try {
    const defaultOrderStatuses = [
      { name: 'Pending', type: 'order', color: 'warning', sortOrder: 1, isDefault: true },
      { name: 'Picked Up', type: 'order', color: 'primary', sortOrder: 2, isDefault: true },
      { name: 'In Transit', type: 'order', color: 'primary', sortOrder: 3, isDefault: true },
      { name: 'Inter Hub', type: 'order', color: 'info', sortOrder: 4, isDefault: true },
      { name: 'Arrived at Hub', type: 'order', color: 'info', sortOrder: 5, isDefault: true },
      { name: 'Out For Delivery', type: 'order', color: 'primary', sortOrder: 6, isDefault: true },
      { name: 'Delivered', type: 'order', color: 'success', sortOrder: 7, isDefault: true },
      { name: 'Failed Delivery', type: 'order', color: 'danger', sortOrder: 8, isDefault: true },
      { name: 'Failed Collection', type: 'order', color: 'danger', sortOrder: 9, isDefault: true },
      { name: 'Pending Delivery', type: 'order', color: 'warning', sortOrder: 10, isDefault: true },
      { name: 'Pending Collection', type: 'order', color: 'warning', sortOrder: 11, isDefault: true },
      { name: 'Collected', type: 'order', color: 'success', sortOrder: 12, isDefault: true },
      { name: 'Cancelled', type: 'order', color: 'danger', sortOrder: 13, isDefault: true },
      { name: 'Reschedule', type: 'order', color: 'secondary', sortOrder: 14, isDefault: true }
    ];

    const defaultDriverStatuses = [
      { name: 'pending', type: 'driver', color: 'warning', sortOrder: 1, isDefault: true },
      { name: 'approved', type: 'driver', color: 'success', sortOrder: 2, isDefault: true },
      { name: 'rejected', type: 'driver', color: 'danger', sortOrder: 3, isDefault: true },
      { name: 'active', type: 'driver', color: 'success', sortOrder: 4, isDefault: true },
      { name: 'inactive', type: 'driver', color: 'secondary', sortOrder: 5, isDefault: true },
      { name: 'suspended', type: 'driver', color: 'danger', sortOrder: 6, isDefault: true }
    ];

    let createdCount = 0;

    for (const statusData of [...defaultOrderStatuses, ...defaultDriverStatuses]) {
      const existing = await Status.findOne({ name: statusData.name, type: statusData.type });
      if (!existing) {
        await Status.create(statusData);
        createdCount++;
      }
    }

    res.status(200).json({ 
      message: `Initialized ${createdCount} default statuses`,
      createdCount 
    });
  } catch (err) {
    console.error('Initialize Default Statuses Error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = {
  getPendingDrivers,
  getAcceptedDrivers,
  getAllDrivers,
  updateDriverStatus,
  updateDriverDetails,
  createShipment,
  getOrderDetails,
  getShipmentById,
  assignShipmentToDriver,
  getAssignedShipments,
  getAllShipments,
  getDriversByVehicleType,
  updateShipment,
  deleteShipment,
  downloadWaybill,
  downloadPOD,
  createCustomer,
  deleteDriver,
  updateCustomerStatus,
  updateCustomerWallet,
  getOrderStatuses,
  updateOrderStatus,
  createCustomStatus,
  getAllStatuses,
  getStatusById,
  createStatus,
  updateStatus,
  deleteStatus,
  initializeDefaultStatuses
};