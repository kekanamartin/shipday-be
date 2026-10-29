// Which permissions a role has: the ticks saved in Settings, or the defaults
const Role = require('../models/Role');
const {
  ALL_KEYS, LOCKED_KEYS, DEFAULT_PERMISSIONS, CONFIGURABLE_ROLES, canonicalRole,
} = require('../config/permissions');

// Saved ticks are cached briefly so permission checks don't hit the database on every request
const CACHE_MS = 30 * 1000;
let cache = { at: 0, byRole: new Map() };

const loadSaved = async () => {
  if (Date.now() - cache.at < CACHE_MS) return cache.byRole;
  const roles = await Role.find({ role: { $in: CONFIGURABLE_ROLES } }).select('role permissionKeys').lean();
  const byRole = new Map();
  roles.forEach((doc) => {
    if (Array.isArray(doc.permissionKeys)) byRole.set(doc.role, doc.permissionKeys);
  });
  cache = { at: Date.now(), byRole };
  return byRole;
};

const clearCache = () => { cache = { at: 0, byRole: new Map() }; };

// Only known keys, and never a Super Admin-only permission
const cleanKeys = (keys) => [...new Set((keys || []).filter((key) => ALL_KEYS.includes(key) && !LOCKED_KEYS.includes(key)))];

const permissionsForRole = async (rawRole) => {
  const role = canonicalRole(rawRole);
  if (role === 'Super Admin') return [...ALL_KEYS];
  if (!CONFIGURABLE_ROLES.includes(role)) return [];
  const saved = (await loadSaved()).get(role);
  return cleanKeys(saved || DEFAULT_PERMISSIONS[role]);
};

const hasPermission = async (user, key) => {
  if (!user) return false;
  const keys = await permissionsForRole(user.role);
  return keys.includes(key);
};

module.exports = { permissionsForRole, hasPermission, clearCache, cleanKeys };
