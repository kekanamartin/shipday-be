// Tick-box permissions. The Super Admin switches these on or off per role in
// Settings → Users & roles; the server checks them on every protected request.

const PERMISSIONS = [
  { key: 'dashboard.company', group: 'Dashboard', label: 'See company-wide figures' },
  { key: 'dashboard.hub', group: 'Dashboard', label: 'See their hub dashboard' },

  { key: 'hubs.view', group: 'Hubs', label: 'View hubs' },
  { key: 'hubs.create', group: 'Hubs', label: 'Add hubs' },
  { key: 'hubs.edit', group: 'Hubs', label: 'Edit and suspend hubs' },
  { key: 'hubs.approve', group: 'Hubs', label: 'Approve and reactivate hubs', locked: true },

  { key: 'team.view', group: 'Team', label: 'View team members' },
  { key: 'team.manage', group: 'Team', label: 'Add, edit and disable team members' },

  { key: 'shipments.view', group: 'Shipments', label: 'View shipments' },
  { key: 'shipments.create', group: 'Shipments', label: 'Book shipments' },
  { key: 'shipments.edit', group: 'Shipments', label: 'Edit shipments and change status' },
  { key: 'shipments.view_other_hubs', group: 'Shipments', label: "See other hubs' shipments (customer name and order details only)" },

  { key: 'customers.view', group: 'Customers', label: 'View customers' },
  { key: 'customers.create', group: 'Customers', label: 'Add customers' },

  { key: 'drivers.view', group: 'Drivers & fleet', label: 'View drivers' },
  { key: 'drivers.manage', group: 'Drivers & fleet', label: 'Approve and edit drivers' },
  { key: 'fleet.view', group: 'Drivers & fleet', label: 'View vehicles' },
  { key: 'fleet.manage', group: 'Drivers & fleet', label: 'Add and edit vehicles' },

  { key: 'revenue.view', group: 'Money', label: 'See revenue (hub roles: their own hub only)' },
  { key: 'transactions.view', group: 'Money', label: 'See all transactions' },
  { key: 'wallets.adjust', group: 'Money', label: 'Credit or debit customer wallets' },

  { key: 'reports.view', group: 'Reports', label: 'View reports' },
  { key: 'settings.manage', group: 'Settings', label: 'Change company settings and pricing' },
  { key: 'roles.manage', group: 'Settings', label: 'Change role permissions', locked: true },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);
// Locked permissions belong to the Super Admin only and can't be given to other roles
const LOCKED_KEYS = PERMISSIONS.filter((p) => p.locked).map((p) => p.key);

const HUB_LEVELS = ['Regional', 'SubRegion', 'Retail'];
const HUB_LEVEL_LABELS = { Regional: 'Regional Hub', SubRegion: 'Sub-Region Hub', Retail: 'Retail Hub' };

// Roles that work at head office (no hub) and roles that belong to one hub
const HEAD_OFFICE_ROLES = ['Super Admin', 'Admin', 'Manager', 'Admin Staff', 'Accounts Manager'];
const HUB_ROLES = ['Regional Manager', 'Sub-Region Manager', 'Retail Hub Manager', 'Hub Staff'];
// 'Retail Hub' is the older name for a retail hub login; it is treated like a Retail Hub Manager
const LEGACY_ROLE_ALIASES = { 'Retail Hub': 'Retail Hub Manager' };

// The hub level each hub manager role must be linked to (Hub Staff can work at any level)
const MANAGER_ROLE_FOR_LEVEL = { Regional: 'Regional Manager', SubRegion: 'Sub-Region Manager', Retail: 'Retail Hub Manager' };
const LEVEL_FOR_ROLE = { 'Regional Manager': 'Regional', 'Sub-Region Manager': 'SubRegion', 'Retail Hub Manager': 'Retail' };

// The roles shown in the permission grid, in display order
const CONFIGURABLE_ROLES = ['Admin', 'Manager', 'Admin Staff', 'Accounts Manager', ...HUB_ROLES];

const without = (keys, removed) => keys.filter((key) => !removed.includes(key));

const DEFAULT_PERMISSIONS = {
  'Super Admin': ALL_KEYS,
  Admin: without(ALL_KEYS, LOCKED_KEYS),
  Manager: without(ALL_KEYS, [...LOCKED_KEYS, 'wallets.adjust', 'settings.manage']),
  'Admin Staff': [
    'dashboard.company', 'hubs.view', 'team.view', 'shipments.view', 'shipments.create', 'shipments.edit',
    'shipments.view_other_hubs', 'customers.view', 'customers.create', 'drivers.view', 'fleet.view', 'reports.view',
  ],
  'Accounts Manager': [
    'dashboard.company', 'hubs.view', 'shipments.view', 'shipments.view_other_hubs', 'customers.view',
    'revenue.view', 'transactions.view', 'wallets.adjust', 'reports.view',
  ],
  'Regional Manager': [
    'dashboard.hub', 'hubs.view', 'hubs.create', 'hubs.edit', 'team.view', 'team.manage',
    'shipments.view', 'shipments.create', 'shipments.edit', 'shipments.view_other_hubs',
    'customers.view', 'customers.create', 'drivers.view', 'fleet.view', 'revenue.view', 'reports.view',
  ],
  'Sub-Region Manager': [
    'dashboard.hub', 'hubs.view', 'hubs.create', 'hubs.edit', 'team.view', 'team.manage',
    'shipments.view', 'shipments.create', 'shipments.edit', 'shipments.view_other_hubs',
    'customers.view', 'customers.create', 'drivers.view', 'fleet.view', 'revenue.view', 'reports.view',
  ],
  'Retail Hub Manager': [
    'dashboard.hub', 'hubs.view', 'team.view', 'team.manage', 'shipments.view', 'shipments.create',
    'shipments.edit', 'shipments.view_other_hubs', 'customers.view', 'customers.create', 'revenue.view',
  ],
  'Hub Staff': [
    'dashboard.hub', 'hubs.view', 'shipments.view', 'shipments.create', 'shipments.view_other_hubs',
    'customers.view', 'customers.create',
  ],
};

const canonicalRole = (role) => LEGACY_ROLE_ALIASES[role] || role;

module.exports = {
  PERMISSIONS,
  ALL_KEYS,
  LOCKED_KEYS,
  HUB_LEVELS,
  HUB_LEVEL_LABELS,
  HEAD_OFFICE_ROLES,
  HUB_ROLES,
  LEGACY_ROLE_ALIASES,
  MANAGER_ROLE_FOR_LEVEL,
  LEVEL_FOR_ROLE,
  CONFIGURABLE_ROLES,
  DEFAULT_PERMISSIONS,
  canonicalRole,
};
