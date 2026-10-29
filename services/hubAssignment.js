// Linking shipments to hubs
const Hub = require('../models/Hub');
const { matchProvince } = require('../utils/provinces');

// The hub and every hub above it, top first
const hubPathFor = async (hubId) => {
  const hub = await Hub.findById(hubId).select('ancestors');
  return hub ? [...hub.ancestors, hub._id] : [];
};

// The Regional Hub for a province name (any spelling), unless it is still a draft
const regionalHubFor = async (provinceText) => {
  const province = matchProvince(provinceText);
  if (!province) return null;
  return Hub.findOne({ level: 'Regional', province, status: { $ne: 'Draft' } }).select('_id');
};

// Hub fields for a shipment booked by this user: their own hub if they work at one
const hubFieldsForBooking = async (user) => {
  if (!user?.hub) return {};
  const hubPath = await hubPathFor(user.hub);
  return hubPath.length ? { hub: user.hub, hubPath } : {};
};

module.exports = { hubPathFor, regionalHubFor, hubFieldsForBooking };
