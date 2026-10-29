const mongoose = require("mongoose");

const vehicleSchema = new mongoose.Schema({
  vehicleId: { type: String, required: true, unique: true },
  vehicleType: String,
  registrationNumber: String,
  capacity: String,
  baseLocation: String,
  insuranceCompany: String,
  insuranceNumber: String,
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
  },
  status: { type: String, enum: ["Active", "Inactive", "Maintenance"], default: "Active" },
  hub: { type: mongoose.Schema.Types.ObjectId, ref: "Hub", default: null },
}, { timestamps: true });

module.exports = mongoose.model("Vehicle", vehicleSchema);
