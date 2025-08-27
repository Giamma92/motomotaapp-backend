// middleware/authorizeRoles.js
const db = require('../models/db');

const authorizeRoles = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      // req.roles was set by authMiddleware after verifying the JWT

      const userRoleNames = req.roles || [];
      const hasRole = userRoleNames.some((role) => allowedRoles.includes(role));

      if (!hasRole) {
        return res.status(403).json({ error: 'Insufficient privileges' });
      }

      console.warn("Admin action permitted!");

      next();
    } catch (err) {
      console.error('Role authorisation failed', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
};

module.exports = authorizeRoles;
