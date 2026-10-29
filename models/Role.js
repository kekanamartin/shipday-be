const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  role: { type: String, required: true, unique: true },
  description: { type: String },
  permissions: { type: [String], default: [] },
  // Tick-box permissions set in Settings; left unset the role uses its defaults (config/permissions.js)
  permissionKeys: { type: [String], default: undefined },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('Role', roleSchema);
