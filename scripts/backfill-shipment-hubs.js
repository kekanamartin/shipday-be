// Link existing shipments to hubs: each shipment without a hub goes to the Regional Hub of the
// province it was collected from (or the sender's province). Run after the Regional Hubs exist.
//
//   node scripts/backfill-shipment-hubs.js            show what would change
//   node scripts/backfill-shipment-hubs.js --apply    make the changes
require('dotenv').config();
const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const Hub = require('../models/Hub');
const { matchProvince } = require('../utils/provinces');

const apply = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const regional = await Hub.find({ level: 'Regional', status: { $ne: 'Draft' } }).select('_id name province').lean();
  const byProvince = new Map(regional.map((hub) => [hub.province, hub]));
  console.log(`Regional Hubs found: ${regional.map((h) => `${h.province} (${h.name})`).join(', ') || 'none'}`);

  const counts = new Map();
  let unmatched = 0;
  const cursor = Shipment.find({ $or: [{ hub: null }, { hub: { $exists: false } }] })
    .select('_id collectionDetails.address.province senderDetails.address.province').lean().cursor();
  const updates = [];
  for await (const shipment of cursor) {
    const province = matchProvince(shipment.collectionDetails?.address?.province)
      || matchProvince(shipment.senderDetails?.address?.province);
    const hub = province && byProvince.get(province);
    if (!hub) { unmatched += 1; continue; }
    counts.set(hub.name, (counts.get(hub.name) || 0) + 1);
    updates.push({ updateOne: { filter: { _id: shipment._id }, update: { $set: { hub: hub._id, hubPath: [hub._id] } } } });
  }

  counts.forEach((count, name) => console.log(`  ${name}: ${count} shipment(s)`));
  console.log(`No matching Regional Hub (left under "No hub"): ${unmatched}`);
  if (apply && updates.length) {
    // bulkWrite skips the status-time hooks, so dispatch dates aren't touched
    const result = await Shipment.bulkWrite(updates);
    console.log(`Updated ${result.modifiedCount} shipment(s).`);
  } else if (!apply) {
    console.log('Nothing changed. Run with --apply to link these shipments.');
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
