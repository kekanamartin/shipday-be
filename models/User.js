// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    customerId: {
      type: String,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['Super Admin', 'Admin', 'Manager', 'Admin Staff', 'Driver', 'Customer', 'Retail Hub', 'Sales Representative'],
      default: 'Customer'
    },
    password: {
      type: String,
      required: true,
    },
    tokens: [{ type: String }], //  Multi-device support


    // Profile fields
    accountType: {
      type: String,
      enum: ['Personal', 'Business'],
      default: 'Personal',
    },
    companyName: String,
    fullName: String,
    // false until the customer picks an account type and adds name/phone (Google sign-up, self-registration)
    profileCompleted: Boolean,

    // Referral & commission programme
    referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
    referredBy: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      kind: { type: String, enum: ['SalesRep', 'Customer', null], default: null },
      via: { type: String, enum: ['created', 'link', 'assigned', null], default: null },
      at: { type: Date, default: null },
    },
    // Set when a Sales Representative creates the account: the customer agreed to the Terms and POPIA processing
    consent: {
      acceptedAt: { type: Date, default: null },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    // Only used for role 'Sales Representative'
    repProfile: {
      commissionActive: { type: Boolean, default: false },
      activatedAt: { type: Date, default: null },
      commissionRate: { type: Number, min: 0, default: null }, // null = use the programme rate
      bank: {
        bankName: String,
        accountHolder: String,
        accountNumber: String,
        branchCode: String,
        accountType: String,
      },
    },
    idNumber: {
      type: String,
      unique: true,
      sparse: true,
      match: /^\d{3}$/,
    },
    accountOwnerIdNumber: {
      type: String,
      unique: true,
      sparse: true,
      match: /^\d{3}$/,
    },
    businessRegistrationNumber: {
      type: String,
      unique: true,
      sparse: true,
    },
    nickName: String,
    dob: String,
    phone: String,
    gender: String,
    image: String,

    // Detailed Address Fields
    address: {
      street: String,
      complexOrBusinessHub: String,
      city: String,
      province: String,
      postalCode: String,
      country: { type: String, default: 'South Africa' },
      // Legacy field for backward compatibility
      fullAddress: String,
      // GPS coordinates
      latitude: Number,
      longitude: Number,
    },

    // Legacy location field (deprecated, use address instead)
    location: {
      latitude: Number,
      longitude: Number,
      address: String,
    },
    status: {
      type: String,
      enum: ['Active', 'Disabled'],
      default: 'Active',
    },
    salesRepresentative: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Staff',
      default: null,
    },
    marketingActivation: {
      status: { type: String, enum: ['Not Activated', 'Activated'], default: 'Not Activated' },
      topUpAmount: { type: Number, default: 0 },
      successfulShipments: { type: Number, default: 0 },
      activatedAt: { type: Date, default: null },
      topUpRequirementMet: { type: Boolean, default: false },
      shipmentRequirementMet: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
