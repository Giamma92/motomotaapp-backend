// middleware/authorizeRoles.js
const db = require('../models/db');

const authorizeRoles = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      // req.username was set by authMiddleware after verifying the JWT
      const { data: rolesData, error } = await db
        .from('user_roles')
        .select('roles ( description )')
        .eq('user_id', req.username);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const userRoleNames = rolesData?.map((r) => r.roles.description) || [];
      const hasRole = userRoleNames.some((role) => allowedRoles.includes(role));

      if (!hasRole) {
        return res.status(403).json({ error: 'Insufficient privileges' });
      }

      next();
    } catch (err) {
      console.error('Role authorisation failed', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
};

module.exports = authorizeRoles;
