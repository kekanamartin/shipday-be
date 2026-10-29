// Sign-in check for the driver app.
//
// DRIVER_AUTH=enforce  every request needs a valid driver token ("Authorization: Bearer <token>" from /drivers/login).
// DRIVER_AUTH=warn     (default, until the app is confirmed to send its token) requests without a valid
//                      token still work but are logged. A valid token is always checked against the driver
//                      the request is about, in both modes.
const jwt = require('jsonwebtoken');
const Driver = require('../models/Driver');

const enforcing = () => (process.env.DRIVER_AUTH || 'warn').trim().toLowerCase() === 'enforce';

const readDriver = async (req) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return { reason: 'no token' };
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.role !== 'driver') return { reason: 'not a driver token' };
    const driver = await Driver.findById(decoded.id);
    if (!driver) return { reason: 'driver not found' };
    if (driver.status !== 'approved') return { reason: 'driver not approved' };
    return { driver };
  } catch {
    return { reason: 'invalid or expired token' };
  }
};

// The driver a request is about: /:driverId in the path or driverId in the body
const requestedDriverId = (req) => req.params.driverId || req.body?.driverId || req.query?.driverId;

const driverAuth = async (req, res, next) => {
  const { driver, reason } = await readDriver(req);

  if (!driver) {
    if (enforcing()) return res.status(401).json({ message: 'Please sign in again.' });
    console.warn(`⚠️ Driver app request without a valid token (${reason}): ${req.method} ${req.originalUrl}`);
    return next();
  }

  const requested = requestedDriverId(req);
  if (requested && String(requested) !== String(driver.driverId) && String(requested) !== String(driver._id)) {
    return res.status(403).json({ message: 'You can only access your own deliveries.' });
  }

  req.driver = driver;
  return next();
};

module.exports = driverAuth;
