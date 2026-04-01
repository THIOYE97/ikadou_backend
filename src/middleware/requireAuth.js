const { verifyAccessToken } = require('../utils/auth');
const HttpError = require('../utils/httpError');
const { query } = require('../data/db');

/**
 * Role hierarchy for permission checks
 */
const ROLE_HIERARCHY = {
  super_admin: 7,
  admin: 6,
  manager: 5,
  finance: 4,
  sales: 3,
  support: 3,
  agent: 2,
};

/**
 * Authenticate the request by verifying JWT
 */
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw HttpError.unauthorized('Missing or invalid authorization header');
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    // Load fresh user data
    const result = await query(
      `SELECT id, first_name, last_name, email, role, status
       FROM internal_users WHERE id = $1`,
      [decoded.sub]
    );

    if (result.rows.length === 0) {
      throw HttpError.unauthorized('User not found');
    }

    const user = result.rows[0];

    if (user.status !== 'active') {
      throw HttpError.unauthorized('Account is suspended or inactive');
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return next(HttpError.unauthorized('Invalid or expired token'));
    }
    next(error);
  }
};

/**
 * Require one or more specific roles
 * Usage: requireRole('admin', 'manager')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return next(HttpError.unauthorized());
  }
  if (!roles.includes(req.user.role)) {
    return next(HttpError.forbidden('Insufficient permissions'));
  }
  next();
};

/**
 * Require a minimum role level
 * Usage: requireMinRole('manager')
 */
const requireMinRole = (minRole) => (req, res, next) => {
  if (!req.user) {
    return next(HttpError.unauthorized());
  }
  const userLevel = ROLE_HIERARCHY[req.user.role] || 0;
  const minLevel = ROLE_HIERARCHY[minRole] || 0;

  if (userLevel < minLevel) {
    return next(HttpError.forbidden('Insufficient role level'));
  }
  next();
};

module.exports = { requireAuth, requireRole, requireMinRole, ROLE_HIERARCHY };
