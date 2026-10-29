// Who may do what. Use after authMiddleware, which sets req.user.
const { HUB_ROLES, canonicalRole } = require('../config/permissions');
const { permissionsForRole } = require('../services/permissionService');

const ADMIN = ['Super Admin', 'Admin'];
const STAFF = [...ADMIN, 'Manager', 'Admin Staff'];

const isAdmin = (user) => ADMIN.includes(user?.role);
const isStaff = (user) => STAFF.includes(user?.role);
// Hub roles (and the older 'Retail Hub' login) work at one hub
const isHubRole = (role) => HUB_ROLES.includes(canonicalRole(role));
const isHubUser = (user) => isHubRole(user?.role);

// router.get('/x', authMiddleware, requireRoles(STAFF), handler)
const requireRoles = (roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Please sign in.' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "You don't have permission to do this." });
  }
  return next();
};

// The signed-in user's permissions, loaded once per request
const loadPermissions = async (req) => {
  if (!req.permissions) req.permissions = await permissionsForRole(req.user?.role);
  return req.permissions;
};

// router.get('/x', authMiddleware, requirePermission('hubs.view'), handler)
// With several keys, any one of them is enough.
const requirePermission = (...keys) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Please sign in.' });
  try {
    const permissions = await loadPermissions(req);
    if (keys.some((key) => permissions.includes(key))) return next();
    return res.status(403).json({ message: "You don't have permission to do this." });
  } catch (err) {
    return next(err);
  }
};

const sameId = (a, b) => Boolean(a && b) && String(a._id || a) === String(b._id || b);
const sameEmail = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// A hub user's area: their own hub and every hub below it
const hubInScope = (user, hub) => Boolean(user?.hub && hub)
  && (sameId(hub._id || hub, user.hub) || (hub.ancestors || []).some((id) => sameId(id, user.hub)));
const shipmentInHubScope = (user, shipment) => Boolean(user?.hub)
  && (shipment.hubPath || []).some((id) => sameId(id, user.hub));

// Staff see every shipment; hub users the ones in their area; drivers the ones assigned
// to them; everyone else only shipments they booked, sent or are receiving.
const canAccessShipment = (user, shipment) => {
  if (!user || !shipment) return false;
  if (isStaff(user)) return true;
  if (isHubUser(user)) return shipmentInHubScope(user, shipment) || sameId(shipment.customer, user._id);
  if (user.role === 'Driver') return sameId(shipment.driver, user._id);
  return sameId(shipment.customer, user._id)
    || [shipment.senderDetails?.email, shipment.senderEmail, shipment.deliveryDetails?.email, shipment.receiverEmail]
      .some((email) => sameEmail(email, user.email));
};

// Other hubs see the customer's name and the order details, but nothing that identifies
// or reaches the customer: no phone numbers, email addresses, street addresses or proof of delivery.
const PERSONAL_FIELDS = [
  'senderPhone', 'receiverPhone', 'recipientPhone', 'customerPhone', 'senderEmail', 'receiverEmail',
  'recipientAddress', 'pickupAddress', 'senderAddress', 'address', 'latitude', 'longitude',
  'podSignature', 'podPhoto', 'podLocation', 'podData', 'podReceiverName', 'customer', 'orders',
];
const CONTACT_FIELDS = ['email', 'mobile', 'telephone', 'office'];
const ADDRESS_KEEP = ['city', 'province'];

const limitAddress = (address) => {
  if (!address) return address;
  return Object.fromEntries(ADDRESS_KEEP.filter((key) => address[key]).map((key) => [key, address[key]]));
};

const limitShipment = (shipment) => {
  const copy = typeof shipment.toObject === 'function' ? shipment.toObject() : { ...shipment };
  PERSONAL_FIELDS.forEach((field) => { delete copy[field]; });
  ['senderDetails', 'collectionDetails', 'deliveryDetails'].forEach((section) => {
    if (!copy[section]) return;
    const details = { ...copy[section] };
    CONTACT_FIELDS.forEach((field) => { delete details[field]; });
    details.address = limitAddress(details.address);
    copy[section] = details;
  });
  copy.limitedView = true;
  return copy;
};

// 'full', 'limited' (another hub's shipment, personal details removed) or null (no access)
const shipmentAccess = async (req, shipment) => {
  if (canAccessShipment(req.user, shipment)) return 'full';
  if (isHubUser(req.user) && (await loadPermissions(req)).includes('shipments.view_other_hubs')) return 'limited';
  return null;
};

// Company-wide figures and tools are for head office; hub teams get their own hub's view
const headOfficeOnly = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Please sign in.' });
  if (isHubUser(req.user)) return res.status(403).json({ message: 'This is only available to head office.' });
  return next();
};

// The user themselves, or staff
const isSelfOrStaff = (user, userId) => isStaff(user) || sameId(user?._id, userId);

module.exports = {
  ADMIN,
  STAFF,
  isAdmin,
  isStaff,
  isHubRole,
  isHubUser,
  requireRoles,
  requirePermission,
  headOfficeOnly,
  loadPermissions,
  hubInScope,
  shipmentInHubScope,
  canAccessShipment,
  shipmentAccess,
  limitShipment,
  isSelfOrStaff,
  sameId,
};
