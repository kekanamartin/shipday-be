const Role = require('../models/Role');
const Hub = require('../models/Hub');
const {
  PERMISSIONS, CONFIGURABLE_ROLES, DEFAULT_PERMISSIONS, LOCKED_KEYS, HEAD_OFFICE_ROLES, HUB_ROLES, HUB_LEVEL_LABELS,
} = require('../config/permissions');
const { permissionsForRole, clearCache, cleanKeys } = require('../services/permissionService');

// GET /api/permissions — the tick-box grid for Settings
exports.getPermissionGrid = async (req, res) => {
  try {
    const saved = await Role.find({ role: { $in: CONFIGURABLE_ROLES } }).select('role permissionKeys updatedAt').lean();
    const savedByRole = new Map(saved.map((doc) => [doc.role, doc]));
    const roles = await Promise.all(CONFIGURABLE_ROLES.map(async (role) => ({
      role,
      group: HUB_ROLES.includes(role) ? 'Hub roles' : 'Head office',
      permissions: await permissionsForRole(role),
      isDefault: !Array.isArray(savedByRole.get(role)?.permissionKeys),
      updatedAt: savedByRole.get(role)?.updatedAt || null,
    })));
    res.json({ permissions: PERMISSIONS, roles, defaults: DEFAULT_PERMISSIONS, locked: LOCKED_KEYS });
  } catch (err) {
    console.error('Permission grid error:', err);
    res.status(500).json({ message: "We couldn't load the permissions." });
  }
};

// PUT /api/permissions/:role  { permissions: [...] }  — or { reset: true } to go back to the defaults
exports.saveRolePermissions = async (req, res) => {
  try {
    const { role } = req.params;
    if (!CONFIGURABLE_ROLES.includes(role)) return res.status(400).json({ message: "That role's permissions can't be changed." });
    const update = req.body.reset
      ? { $unset: { permissionKeys: 1 }, $set: { updatedBy: req.user._id } }
      : { $set: { permissionKeys: cleanKeys(req.body.permissions), updatedBy: req.user._id } };
    await Role.findOneAndUpdate(
      { role },
      { ...update, $setOnInsert: { description: `${role} (built-in role)` } },
      { upsert: true, new: true },
    );
    clearCache();
    res.json({ message: req.body.reset ? `${role} is back to the standard permissions.` : `${role} permissions saved.`, permissions: await permissionsForRole(role) });
  } catch (err) {
    console.error('Save permissions error:', err);
    res.status(500).json({ message: "We couldn't save the permissions." });
  }
};

// GET /api/auth/access — what the signed-in person can do, for the menu and pages
exports.getMyAccess = async (req, res) => {
  try {
    const hub = req.user.hub ? await Hub.findById(req.user.hub).select('name hubCode level province status').lean() : null;
    res.json({
      role: req.user.role,
      scope: HEAD_OFFICE_ROLES.includes(req.user.role) ? 'head-office' : (hub ? 'hub' : 'own'),
      permissions: await permissionsForRole(req.user.role),
      hub: hub ? { ...hub, levelLabel: HUB_LEVEL_LABELS[hub.level] } : null,
    });
  } catch (err) {
    console.error('My access error:', err);
    res.status(500).json({ message: "We couldn't load your access." });
  }
};
