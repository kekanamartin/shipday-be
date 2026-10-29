
const Shipment = require('../models/Shipment');
const Order = require('../models/Order');
const Tracking = require('../models/tracking');
const generateShipmentId = require('../utils/generateShipmentId');
const isWithinRadius = require('../utils/isWithinRadius');
const { sendShipmentStatusEmail } = require('../utils/shipmentEmailTemplates');
const { refreshShipmentCustomerActivation } = require('../services/marketingActivationService');
const { isStaff, isHubUser, loadPermissions, canAccessShipment, limitShipment } = require('../middleware/access');


function getRandomStatus() {
  const statuses = ["Delivery", "In Transit", "Pending", "Cancelled"];
  return statuses[Math.floor(Math.random() * statuses.length)];
}

exports.generateShipments = async (req, res) => {
  try {
    const orders = await Order.find();
    const routes = await Tracking.find().sort({ createdAt: -1 }); // Sort: most recent first




    const assignedOrderIds = new Set(); // Track assigned orders
    const shipments = [];

    //  Fetch all existing shipment orders once
    const existingShipmentOrders = new Set(
      (await Shipment.find({}, "orders")).flatMap(s =>
        s.orders.map(id => id.toString())
      )
    );

    for (const route of routes) {
      const {
        startLatitude: startLat,
        startLongitude: startLng,
        latitude: endLat,
        longitude: endLng,
        routeId,
        trackingId,
        start,
        end,
      } = route || {};

      if (
        typeof startLat !== "number" || typeof startLng !== "number" ||
        typeof endLat !== "number" || typeof endLng !== "number" ||
        typeof end !== "string" || end.trim() === ""
      ) {
        console.warn(`⚠️ Skipping route ${routeId || "(unknown)"} due to missing data`);
        continue;
      }



      // Filter orders within 50 km of this route's end location
      const matchingOrders = orders.filter(order => {
        if (
          !order.location?.lat ||
          !order.location?.lon ||
          !order.deliveryAddress ||
          assignedOrderIds.has(order._id.toString()) ||          // already in this run
          existingShipmentOrders.has(order._id.toString())       // already in DB
        ) {
          return false;
        }

        const distance = isWithinRadius.getDistanceFromLatLonInKm(
          order.location.lat,
          order.location.lon,
          endLat,
          endLng
        );

        return distance <= 50;
      });



      if (matchingOrders.length === 0) continue;

      // Update assigned set
      matchingOrders.forEach(o => assignedOrderIds.add(o._id.toString()));

      // Check if shipment already exists
      let shipment = await Shipment.findOne({ routeId, end });

      if (shipment) {
        const existingOrderIds = shipment.orders.map(id => id.toString());
        const newOrderIds = matchingOrders
          .map(o => o._id.toString())
          .filter(id => !existingOrderIds.includes(id));

        if (newOrderIds.length > 0) {
          shipment.orders.push(...newOrderIds);

        } else {

        }

        shipment.trackingNumber = trackingId || shipment.trackingNumber;
        shipment.start = start || shipment.start;
        shipment.status = "Pending";

        await shipment.save();
      } else {
        shipment = new Shipment({
          shipmentId: generateShipmentId(),
          orders: matchingOrders.map(o => o._id),
          routeId,
          trackingNumber: trackingId,
          start,
          end,
          status: getRandomStatus()
        });

        await shipment.save();

      }

      shipments.push(shipment);
    }

    res.status(200).json({ message: "Shipments created or updated", shipments });
  } catch (err) {
    console.error("❌ Error generating shipments:", err.stack || err);
    res.status(500).json({ message: "Failed to create shipments" });
  }
};



exports.getAllShipments = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};

    // If status is provided, filter by it. 
    if (status) {
      query.status = status;
    }

    // Role-based filtering
    if (req.user) {
      const { role, email, _id } = req.user;

      if (role === 'Customer') {
        // Customer sees shipments they created (linked by ID) or matched email
        query['$or'] = [
          { customer: _id },
          { 'senderDetails.email': email },
          { 'senderEmail': email },
          { 'deliveryDetails.email': email },
          { 'receiverEmail': email }
        ];
      } else if (isHubUser(req.user) && req.user.hub) {
        // Hub teams see their own area; with ?scope=all, other hubs' shipments too (limited details)
        const permissions = await loadPermissions(req);
        if (!permissions.includes('shipments.view')) return res.status(403).json({ message: "You don't have permission to do this." });
        if (!(req.query.scope === 'all' && permissions.includes('shipments.view_other_hubs'))) {
          query['$or'] = [{ hubPath: req.user.hub }, { customer: _id }];
        }
      } else if (role === 'Driver') {
        // Driver sees assigned shipments
        query.driver = _id;
      } else if (!isStaff(req.user)) {
        // Anyone else (e.g. Retail Hub, Sales Representative) sees only shipments they booked
        query['$or'] = [{ customer: _id }, { 'senderDetails.email': email }, { 'senderEmail': email }];
      }
      // Staff see all
    }

    const shipments = await Shipment.find(query)
      .populate("orders")
      .populate({
        path: 'driver',
        model: 'Driver',
        select: 'username driverId vehicleType',
        options: { strictPopulate: false }
      })
      .sort({ createdAt: -1 });

    // Update driverName for shipments with assigned drivers
    const updatedShipments = shipments.map(shipment => {
      // Shipments from outside a hub user's area only show the customer name and order details
      const shipmentObj = isHubUser(req.user) && !canAccessShipment(req.user, shipment)
        ? limitShipment(shipment)
        : shipment.toObject();
      if (shipmentObj.driver && shipmentObj.driver.username) {
        shipmentObj.driverName = shipmentObj.driver.username;
      }
      return shipmentObj;
    });

    res.status(200).json(updatedShipments);
  } catch (err) {
    console.error("❌ Error fetching shipments:", err.stack || err);
    res.status(500).json({ message: "Failed to fetch shipments" });
  }
};

exports.updateOrderStatus = async (req, res) => {
  const { orderId, newStatus } = req.body;

  try {
    const order = await Order.findByIdAndUpdate(orderId, { status: newStatus }, { new: true });

    if (!order) return res.status(404).json({ message: 'Order not found' });

    const shipment = await Shipment.findOne({ orders: order._id }).populate('orders');

    if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

    const allDelivered = shipment.orders.every(o => o.status === "Delivered");

    if (allDelivered && shipment.status !== "Delivered") {
      shipment.status = "Delivered";
      shipment.deliveredAt = new Date();
      await shipment.save();
      await refreshShipmentCustomerActivation(shipment);

      // Trigger automatic email notification
      await sendShipmentStatusEmail(shipment, "Delivered");
    }

    res.status(200).json({
      message: "Order status updated",
      shipmentStatus: shipment.status,
      updatedOrder: order
    });

  } catch (error) {
    console.error("❌ Error updating order status:", error.stack || error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.syncShipmentStatuses = async (req, res) => {
  try {
    const shipments = await Shipment.find().populate('orders');

    for (const shipment of shipments) {
      const allDelivered = shipment.orders.length > 0 && shipment.orders.every(o => o.status === "Delivered");

      if (allDelivered && shipment.status !== "Delivered") {
        shipment.status = "Delivered";
        await shipment.save();
        await refreshShipmentCustomerActivation(shipment);

      }
    }

    res.status(200).json({ message: "Shipment statuses synchronized" });
  } catch (err) {
    console.error("❌ Error syncing statuses:", err.stack || err);
    res.status(500).json({ message: "Failed to sync statuses" });
  }
};

exports.getShipmentCount = async (req, res) => {
  try {
    const count = await Shipment.countDocuments();
    res.status(200).json({ total: count });
  } catch (err) {
    console.error("❌ Error getting shipment count:", err.stack || err);
    res.status(500).json({ message: "Failed to get shipment count" });
  }
};

exports.getShipmentMetrics = async (req, res) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const total = await Shipment.countDocuments();

    const thisMonthCount = await Shipment.countDocuments({
      createdAt: { $gte: thisMonthStart },
    });

    const lastMonthCount = await Shipment.countDocuments({
      createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd },
    });

    const growth =
      lastMonthCount === 0
        ? 100
        : Math.round(((thisMonthCount - lastMonthCount) / lastMonthCount) * 100);

    res.status(200).json({
      total,
      monthGrowth: growth,
    });
  } catch (err) {
    console.error("❌ Error getting shipment metrics:", err.stack || err);
    res.status(500).json({ message: "Failed to get shipment metrics" });
  }
};

exports.getShipmentStatusBreakdown = async (req, res) => {
  try {
    const breakdown = await Shipment.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const statusMap = {
      Delivery: 0,
      "In Transit": 0,
      Pending: 0,
      Cancelled: 0,
    };

    breakdown.forEach((entry) => {
      const key = entry._id;
      if (statusMap.hasOwnProperty(key)) {
        statusMap[key] = entry.count;
      }
    });

    res.status(200).json(statusMap);
  } catch (err) {
    console.error("❌ Error getting status breakdown:", err.stack || err);
    res.status(500).json({ message: "Failed to get shipment status breakdown" });
  }
};

exports.trackShipment = async (req, res) => {
  try {
    const { trackingNumber } = req.params;
    const shipment = await Shipment.findOne({
      $or: [
        { trackingNumber: trackingNumber },
        { shipmentId: trackingNumber },
        { orderNumber: trackingNumber }
      ]
    })
      .populate('driver', 'username mobile vehicleType')
      .populate('orders');

    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    // Map history or recent updates if needed
    // For now, return basic info and status
    const trackingHistory = [
      { status: 'Order Created', location: shipment.collectionDetails?.address?.city || 'Origin', date: shipment.createdAt, done: true, icon: 'bi-box-seam' },
      { status: 'Collected', location: shipment.collectionDetails?.address?.city || 'Distribution Center', date: shipment.dateShipped || shipment.updatedAt, done: ['Shipping', 'Delivered'].includes(shipment.status), icon: 'bi-truck' },
      { status: 'In Transit', location: 'On Route', date: shipment.updatedAt, done: ['Shipping', 'Delivered'].includes(shipment.status), icon: 'bi-geo-alt' },
      { status: 'Delivered', location: shipment.deliveryDetails?.address?.city || 'Destination', date: shipment.deliveredAt || shipment.updatedAt, done: shipment.status === 'Delivered', icon: 'bi-house-check' }
    ];

    res.status(200).json({
      shipment: {
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        currentLocation: shipment.status === 'Delivered' ? shipment.deliveryDetails?.address?.city : 'In Transit',
        updatedAt: shipment.updatedAt,
        history: trackingHistory
      }
    });
  } catch (err) {
    console.error("❌ Error tracking shipment:", err.stack || err);
    res.status(500).json({ message: "Failed to track shipment" });
  }
};

module.exports = {
  generateShipments: exports.generateShipments,
  getAllShipments: exports.getAllShipments,
  updateOrderStatus: exports.updateOrderStatus,
  syncShipmentStatuses: exports.syncShipmentStatuses,
  getShipmentCount: exports.getShipmentCount,
  getShipmentMetrics: exports.getShipmentMetrics,
  getShipmentStatusBreakdown: exports.getShipmentStatusBreakdown,
  trackShipment: exports.trackShipment
};

