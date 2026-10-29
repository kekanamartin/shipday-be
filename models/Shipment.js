const mongoose = require('mongoose');

const shipmentSchema = new mongoose.Schema({
  shipmentId: { type: String, required: true, unique: true },
  barcode: { type: String, unique: true, sparse: true, index: true },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  integrationCredential: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntegrationCredential',
    default: null,
    index: true
  },
  integrationQuoteId: { type: String, unique: true, sparse: true },
  courierPartner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CourierPartner',
    default: null,
    index: true
  },
  courierPartnerQuoteId: { type: String, unique: true, sparse: true },
  integrationParcelOperations: [{
    keyHash: { type: String, required: true },
    requestHash: { type: String, required: true },
  }],
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

  // Sender Details
  senderDetails: {
    fullName: { type: String },
    company: String,
    email: { type: String },
    mobile: { type: String },
    telephone: String,
    address: {
      street: { type: String },
      suburb: { type: String },
      city: { type: String },
      complex: String,
      province: { type: String },
      postalCode: { type: String }
    }
  },

  // Collection Details
  collectionDetails: {
    dispatcherName: { type: String },
    company: String,
    mobile: { type: String },
    office: String,
    email: { type: String },
    address: {
      street: { type: String },
      suburb: { type: String },
      city: { type: String },
      complex: String,
      province: { type: String },
      postalCode: { type: String },
      latitude: Number,
      longitude: Number
    },
    numberOfItems: { type: Number, default: 1 }
  },

  // Delivery Details
  deliveryDetails: {
    receiverName: { type: String },
    company: String,
    mobile: { type: String },
    office: String,
    email: { type: String },
    address: {
      street: { type: String },
      suburb: { type: String },
      city: { type: String },
      complex: String,
      province: { type: String },
      postalCode: { type: String },
      latitude: Number,
      longitude: Number
    }
  },

  // Parcel Details
  parcelDetails: {
    serviceType: { type: String, enum: ['economy', 'express'] },
    parcelType: { type: String },
    dimensions: {
      length: Number,
      width: Number,
      height: Number,
      weight: { type: Number }
    },
    packaging: [{
      id: String,
      name: String,
      price: { type: Number, default: 0 }
    }],
    specialInstructions: String,
    satchelSize: { type: String, enum: ['none', 'A4', 'A3'], default: 'none' }
  },

  // Payment Details
  payment: {
    method: { type: String, enum: ['ewallet', 'gateway', 'cod', 'payfast', 'fulfillment', 'invoice'], default: 'gateway' },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    amount: { type: Number },
    transactionId: String
  },
  pricingBreakdown: {
    baseCost: { type: Number, default: 0 },
    packagingCost: { type: Number, default: 0 },
    interProvinceFee: { type: Number, default: 0 },
    oversizeBoxCount: { type: Number, default: 0 },
    oversizeFee: { type: Number, default: 0 },
    additionalBoxCount: { type: Number, default: 0 },
    additionalBoxFee: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },

  // Fulfillment & Marketplace Details
  orderNumber: { type: String, index: true },
  marketplaceName: String,
  numberOfBoxes: { type: Number, default: 1 },
  parcels: [{
    length: Number,
    width: Number,
    height: Number,
    weight: Number
  }],
  bookedBy: String,
  isFulfillment: { type: Boolean, default: false },

  // Legacy/Compatibility fields (populated from above by controller)
  // These are NOT required because controller auto-populates them
  // Added defaults to prevent validation errors
  senderName: { type: String, default: 'N/A' },
  senderPhone: { type: String, default: '0000000000' },
  receiverName: { type: String, default: 'N/A' },
  receiverPhone: { type: String, default: '0000000000' },
  start: { type: String, default: 'Unknown' },
  end: { type: String, default: 'Unknown' },
  parcelWeight: { type: Number, default: 1 },
  packageType: { type: String, default: 'parcel' },
  cost: { type: Number, default: 0 },
  eta: { type: Date, default: Date.now },
  notes: { type: String, default: '' },

  status: {
    type: String,
    enum: [
      'Order Created',
      'Pending Collection',
      'Pending Delivery',
      'Driver Assigned',
      'Picked Up',
      'In Transit',
      'Inter Hub',
      'Arrived at Hub',
      'Out For Delivery',
      'Delivered',
      'Failed Delivery',
      'Failed Collection',
      'Collected',
      'Cancelled',
      'Reschedule',
      'Inter branch Transit',
      'Delivery Failed',
      'Rescheduled',
      'Return to Sender',
      'Returning to hub',
      'Delivery cancelled',
      'At Warehouse',
      'Parcel in Sorting Facility',
      'Out for Delivery',
      'On Hold',
      'Awaiting Payment',
      'Shipping',
      'Assigned',
      'Pending'
    ],
    default: 'Order Created'
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    default: null
  },
  dateShipped: { type: Date, default: Date.now },
  deliveredAt: { type: Date },

  // The hub that booked or handles the shipment, and that hub plus every hub above it.
  // A hub user sees shipments whose hubPath contains their hub.
  hub: { type: mongoose.Schema.Types.ObjectId, ref: 'Hub', default: null, index: true },
  hubPath: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Hub' }], index: true },
  // First time the shipment left for collection or delivery, and when it went back to the sender
  dispatchedAt: { type: Date, index: true },
  returnedAt: { type: Date },
  orders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  routeId: { type: String },
  trackingNumber: { type: String },
  driverName: { type: String, default: "Unassigned" },

  // Proof of Delivery fields
  podSignature: { type: String },
  podPhoto: { type: String },
  podReceiverName: { type: String },
  podSignedAt: { type: Date },
  podCompleted: { type: Boolean, default: false },
  podMethod: { type: String },
  podLocation: {
    latitude: Number,
    longitude: Number,
    address: String
  },
  podData: { type: mongoose.Schema.Types.Mixed },
  
  // Additional fields for compatibility
  recipientName: { type: String },
  recipientPhone: { type: String },
  recipientAddress: { type: String },
  pickupAddress: { type: String },
  senderAddress: { type: String },
  estimatedDelivery: { type: String },
  deliveryDate: { type: String },
  specialInstructions: { type: String },
  description: { type: String },
  weight: { type: String },
  dimensions: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  trackingNumber: { type: String },
  customerName: { type: String },
  customerPhone: { type: String },
  address: { type: String }
},
  {
    timestamps: true
  });

// Every shipment gets an order number. Sellers can still supply their own store/marketplace
// order number; when none is given we generate one like ORD-261013-7K3QX (date + random code).
const generateOrderNumber = () => {
  const now = new Date();
  const date = [now.getFullYear() % 100, now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
  const code = Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, '0');
  return `ORD-${date}-${code}`;
};

shipmentSchema.pre('validate', async function assignOrderNumber() {
  if (this.orderNumber && String(this.orderNumber).trim()) {
    this.orderNumber = String(this.orderNumber).trim();
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateOrderNumber();
    // eslint-disable-next-line no-await-in-loop
    const taken = await this.constructor.exists({ orderNumber: candidate });
    if (!taken) {
      this.orderNumber = candidate;
      return;
    }
  }
  throw new Error('Could not generate a unique order number');
});

shipmentSchema.statics.generateOrderNumber = generateOrderNumber;

// New shipments without a hub go to the Regional Hub of the province they're collected from.
// (Shipments booked by a hub team are given that hub when they're created.)
shipmentSchema.pre('validate', async function assignHub() {
  if (!this.isNew) return;
  // eslint-disable-next-line global-require
  const { hubPathFor, regionalHubFor } = require('../services/hubAssignment');
  if (this.hub && !(this.hubPath && this.hubPath.length)) {
    this.hubPath = await hubPathFor(this.hub);
    return;
  }
  if (this.hub) return;
  const hub = await regionalHubFor(this.collectionDetails?.address?.province || this.senderDetails?.address?.province);
  if (hub) {
    this.hub = hub._id;
    this.hubPath = [hub._id];
  }
});

// Status groups used by the hub dashboards
const DISPATCHED_STATUSES = [
  'Picked Up', 'Collected', 'In Transit', 'Inter Hub', 'Inter branch Transit',
  'Out For Delivery', 'Out for Delivery', 'Shipping',
];
const RETURN_STATUSES = ['Return to Sender', 'Returning to hub'];
const PENDING_DISPATCH_STATUSES = [
  'Order Created', 'Pending Collection', 'Pending Delivery', 'Driver Assigned', 'Assigned', 'Pending',
  'Arrived at Hub', 'At Warehouse', 'Parcel in Sorting Facility', 'On Hold',
];

// Record when a shipment is first dispatched, delivered or returned, however its status is changed
const STATUS_TIMES = [
  ['dispatchedAt', DISPATCHED_STATUSES],
  ['deliveredAt', ['Delivered']],
  ['returnedAt', RETURN_STATUSES],
];

shipmentSchema.pre('save', function recordStatusTimes() {
  if (!this.isModified('status')) return;
  STATUS_TIMES.forEach(([field, statuses]) => {
    if (statuses.includes(this.status) && !this[field]) this[field] = new Date();
  });
});

function recordStatusTimesOnUpdate() {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) return;
  const status = update.$set?.status ?? update.status;
  if (!status) return;
  const touched = (field) => [update, update.$set, update.$min, update.$setOnInsert, update.$unset]
    .some((part) => part && Object.prototype.hasOwnProperty.call(part, field));
  STATUS_TIMES.forEach(([field, statuses]) => {
    // $min keeps the earliest time if it was already recorded
    if (statuses.includes(status) && !touched(field)) {
      update.$min = { ...(update.$min || {}), [field]: new Date() };
    }
  });
  this.setUpdate(update);
}

shipmentSchema.pre('findOneAndUpdate', recordStatusTimesOnUpdate);
shipmentSchema.pre('updateOne', recordStatusTimesOnUpdate);
shipmentSchema.pre('updateMany', recordStatusTimesOnUpdate);

shipmentSchema.statics.DISPATCHED_STATUSES = DISPATCHED_STATUSES;
shipmentSchema.statics.RETURN_STATUSES = RETURN_STATUSES;
shipmentSchema.statics.PENDING_DISPATCH_STATUSES = PENDING_DISPATCH_STATUSES;

module.exports = mongoose.model('Shipment', shipmentSchema);
