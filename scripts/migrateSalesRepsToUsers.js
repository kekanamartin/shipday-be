/**
 * One-off migration: turn Staff records with the "Sales Representative" role into
 * Sales Representative user accounts, and relink the customers that were assigned to them.
 *
 *   node scripts/migrateSalesRepsToUsers.js           # dry run: shows what would change
 *   node scripts/migrateSalesRepsToUsers.js --apply   # writes the changes
 *
 * New rep accounts get a random password: reps sign in with "Forgot password" on the sign-in page.
 * Commission starts switched off; the Super Admin activates each rep on the Marketing page.
 */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Staff = require('../models/Staff');
const User = require('../models/User');
const { generateReferralCode } = require('../services/referralService');

const APPLY = process.argv.includes('--apply');

const toLocalPhone = (value) => {
  const digits = String(value || '').replace(/[\s().-]/g, '').replace(/^(?:\+27|0027|27)(?=\d{9}$)/, '0');
  return /^0[1-8]\d{8}$/.test(digits) ? digits : '';
};

async function nextRepId() {
  let next = (await User.countDocuments({ customerId: /^REP\d+$/ })) + 1;
  while (await User.exists({ customerId: `REP${String(next).padStart(3, '0')}` })) next += 1;
  return `REP${String(next).padStart(3, '0')}`;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const staffReps = await Staff.find({ role: /^Sales Representative$/i });
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}: ${staffReps.length} Sales Representative staff record(s)\n`);

  for (const staff of staffReps) {
    const email = String(staff.email || '').toLowerCase().trim();
    let user = await User.findOne({ email });

    if (user && user.role !== 'Sales Representative') {
      console.log(`SKIP ${staff.fullName} <${email}>: email already used by a ${user.role} account`);
      continue;
    }

    if (!user) {
      console.log(`CREATE rep account for ${staff.fullName} <${email}>`);
      if (APPLY) {
        user = new User({
          email,
          password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
          fullName: staff.fullName,
          phone: toLocalPhone(staff.contactInfo),
          role: 'Sales Representative',
          customerId: await nextRepId(),
          repProfile: { commissionActive: false },
        });
        user.referralCode = await generateReferralCode(user);
        await user.save();
      }
    } else {
      console.log(`EXISTS rep account for ${staff.fullName} <${email}>`);
    }

    const customers = await User.find({ role: 'Customer', salesRepresentative: staff._id, 'referredBy.user': null });
    console.log(`  relink ${customers.length} assigned customer(s)`);
    if (APPLY && user) {
      await User.updateMany(
        { _id: { $in: customers.map((c) => c._id) } },
        { $set: { referredBy: { user: user._id, kind: 'SalesRep', via: 'assigned', at: new Date() } } }
      );
    }
  }

  await mongoose.disconnect();
  console.log(APPLY ? '\nDone.' : '\nNothing was changed. Run again with --apply to migrate.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
