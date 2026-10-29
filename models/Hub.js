const mongoose = require('mongoose');
const { HUB_LEVELS } = require('../config/permissions');
const { PROVINCE_NAMES } = require('../utils/provinces');

// Regional Hub (one per province) → Sub-Region Hub / Distribution Centre → Retail Hub
const HUB_STATUSES = ['Draft', 'Pending Approval', 'Active', 'Suspended'];
const HUB_SERVICES = [
  'Parcel Drop-off',
  'Parcel Collection',
  'Customer Collection',
  'Returns Accepted',
  'Driver Handover Point',
  'Final-Mile Delivery',
];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const timeOfDay = { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/ };

const hubSchema = new mongoose.Schema({
  hubCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  level: { type: String, enum: HUB_LEVELS, required: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Hub', default: null },
  // Every hub above this one, top first: [regional] for a sub-region, [regional, sub-region] for a retail hub
  ancestors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Hub' }],
  province: { type: String, enum: PROVINCE_NAMES, required: true },

  manager: {
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    officeLine: String,
    cell: String,
  },
  additionalContact: {
    name: { type: String, trim: true },
    number: String,
  },

  address: {
    street: { type: String, trim: true },
    suburb: { type: String, trim: true },
    city: { type: String, trim: true },
    province: { type: String, enum: PROVINCE_NAMES },
    postalCode: { type: String, trim: true },
  },
  location: {
    latitude: Number,
    longitude: Number,
  },

  operatingHours: [{
    _id: false,
    day: { type: String, enum: DAYS },
    open: timeOfDay,
    close: timeOfDay,
    closed: { type: Boolean, default: false },
  }],

  // The person who gets the hub's login
  administrator: {
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: String,
    sendLogin: { type: Boolean, default: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    inviteSentAt: { type: Date, default: null },
  },

  services: [{ type: String, enum: HUB_SERVICES }],
  status: { type: String, enum: HUB_STATUSES, default: 'Draft' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  submittedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },
  suspendedAt: { type: Date, default: null },
  suspendedReason: { type: String, trim: true },
}, { timestamps: true });

hubSchema.index({ ancestors: 1 });
hubSchema.index({ parent: 1 });
// One Regional Hub per province
hubSchema.index({ province: 1 }, { unique: true, partialFilterExpression: { level: 'Regional' } });

const Hub = mongoose.model('Hub', hubSchema);

module.exports = Hub;
module.exports.HUB_STATUSES = HUB_STATUSES;
module.exports.HUB_SERVICES = HUB_SERVICES;
module.exports.DAYS = DAYS;
