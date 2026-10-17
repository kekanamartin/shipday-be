const verifySuperAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Unauthorized: No user info' });
    }

    // Assuming 'role' is stored in req.user, and Super Admin role is 'Super Admin' or 'superadmin'
    // I saw 'role' in User model in createCustomer in admin.js.
    // I'll check strict casing. Usually 'superadmin' or 'Super Admin'.
    // I'll check authMiddleware again to see what it populates. It populates req.user from User.findById.
    // Let's assume the role field is 'role'.
    // I'll allow both 'Super Admin' and 'superadmin'.
    const role = req.user.role || '';
    if (role.toLowerCase().replace(' ', '') === 'superadmin') {
        next();
    } else {
        return res.status(403).json({ message: 'Forbidden: Super Admin access required' });
    }
};

const verifyAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Unauthorized: No user info' });
    }

    const role = (req.user.role || '').toLowerCase().replace(' ', '');
    if (role === 'admin' || role === 'superadmin') {
        next();
    } else {
        return res.status(403).json({ message: 'Forbidden: Admin access required' });
    }
};

const verifySalesRep = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Unauthorized: No user info' });
    }
    if (req.user.role === 'Sales Representative' && req.user.status !== 'Disabled') {
        return next();
    }
    return res.status(403).json({ message: 'Forbidden: Sales Representative access required' });
};

const verifyCustomer = (req, res, next) => {
    if (req.user?.role === 'Customer') return next();
    return res.status(403).json({ message: 'Forbidden: customer accounts only' });
};

module.exports = { verifySuperAdmin, verifyAdmin, verifySalesRep, verifyCustomer };
