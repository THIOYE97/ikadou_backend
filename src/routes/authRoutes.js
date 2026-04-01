const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { authLimiter } = require('../middleware/rateLimiter');
const { requireAuth } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const {
  hashPassword,
  comparePassword,
  buildTokenPair,
  verifyRefreshToken,
} = require('../utils/auth');
const { query, transaction } = require('../data/db');

// ─── Validation helpers ───────────────────────────────────

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error('Validation failed');
    err.type = 'validation';
    err.errors = errors.array();
    return next(err);
  }
  next();
};

// ─── POST /auth/login ─────────────────────────────────────

router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const result = await query(
        `SELECT id, first_name, last_name, email, password_hash, role, status
         FROM internal_users WHERE email = $1`,
        [email]
      );

      const user = result.rows[0];

      if (!user || !(await comparePassword(password, user.password_hash))) {
        throw HttpError.unauthorized('Invalid email or password');
      }

      if (user.status !== 'active') {
        throw HttpError.unauthorized('Account is suspended or inactive');
      }

      const { accessToken, refreshToken } = buildTokenPair(user);

      // Store refresh token
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, refreshToken, expiresAt]
      );

      // Update last login
      await query(
        `UPDATE internal_users SET last_login_at = NOW() WHERE id = $1`,
        [user.id]
      );

      return res.json({
        success: true,
        data: {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            firstName: user.first_name,
            lastName: user.last_name,
            email: user.email,
            role: user.role,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /auth/refresh ───────────────────────────────────

router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw HttpError.badRequest('Refresh token required');

    const decoded = verifyRefreshToken(refreshToken);

    const stored = await query(
      `SELECT * FROM refresh_tokens
       WHERE token = $1 AND user_id = $2 AND expires_at > NOW()`,
      [refreshToken, decoded.sub]
    );

    if (stored.rows.length === 0) {
      throw HttpError.unauthorized('Invalid or expired refresh token');
    }

    const userResult = await query(
      `SELECT id, first_name, last_name, email, role, status
       FROM internal_users WHERE id = $1`,
      [decoded.sub]
    );

    const user = userResult.rows[0];
    if (!user || user.status !== 'active') {
      throw HttpError.unauthorized('User not found or inactive');
    }

    // Rotate refresh token
    const { accessToken, refreshToken: newRefreshToken } = buildTokenPair(user);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await transaction(async (client) => {
      await client.query(`DELETE FROM refresh_tokens WHERE token = $1`, [refreshToken]);
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [user.id, newRefreshToken, expiresAt]
      );
    });

    return res.json({
      success: true,
      data: { accessToken, refreshToken: newRefreshToken },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /auth/logout ────────────────────────────────────

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await query(`DELETE FROM refresh_tokens WHERE token = $1`, [refreshToken]);
    }
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
});

// ─── GET /auth/me ─────────────────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
  return res.json({
    success: true,
    data: {
      id: req.user.id,
      firstName: req.user.first_name,
      lastName: req.user.last_name,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

// ─── POST /auth/change-password ───────────────────────────

router.post(
  '/change-password',
  requireAuth,
  [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;

      const result = await query(
        `SELECT password_hash FROM internal_users WHERE id = $1`,
        [req.user.id]
      );

      const valid = await comparePassword(currentPassword, result.rows[0].password_hash);
      if (!valid) throw HttpError.badRequest('Current password is incorrect');

      const newHash = await hashPassword(newPassword);
      await query(
        `UPDATE internal_users SET password_hash = $1 WHERE id = $2`,
        [newHash, req.user.id]
      );

      // Revoke all refresh tokens
      await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [req.user.id]);

      return res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
