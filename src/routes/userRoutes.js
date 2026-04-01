const express = require('express');
const { body, query: qQuery, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole, requireMinRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { hashPassword } = require('../utils/auth');
const { query } = require('../data/db');

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

// All routes require auth
router.use(requireAuth);

// ─── GET /users — list internal users ────────────────────

router.get(
  '/',
  requireMinRole('manager'),
  async (req, res, next) => {
    try {
      const { search, role, status, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const params = [];
      const conditions = [];

      if (search) {
        params.push(`%${search}%`);
        conditions.push(
          `(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length})`
        );
      }
      if (role) {
        params.push(role);
        conditions.push(`role = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRes = await query(
        `SELECT COUNT(*) FROM internal_users ${where}`,
        params
      );
      const total = parseInt(countRes.rows[0].count, 10);

      params.push(limit, offset);
      const rows = await query(
        `SELECT id, first_name, last_name, email, role, status, last_login_at, created_at
         FROM internal_users ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      return res.json({
        success: true,
        data: rows.rows,
        meta: { total, page: +page, limit: +limit, pages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /users — create user ────────────────────────────

router.post(
  '/',
  requireRole('admin', 'super_admin'),
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('role').isIn(['admin', 'manager', 'sales', 'support', 'finance', 'agent']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, email, password, role } = req.body;

      const existing = await query(
        `SELECT id FROM internal_users WHERE email = $1`,
        [email]
      );
      if (existing.rows.length) throw HttpError.conflict('Email already in use');

      const passwordHash = await hashPassword(password);
      const result = await query(
        `INSERT INTO internal_users (first_name, last_name, email, password_hash, role, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, first_name, last_name, email, role, status, created_at`,
        [firstName, lastName, email, passwordHash, role, req.user.id]
      );

      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /users/:id ───────────────────────────────────────

router.get('/:id', requireMinRole('manager'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, first_name, last_name, email, role, status, last_login_at, created_at
       FROM internal_users WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('User not found');
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /users/:id ─────────────────────────────────────

router.patch(
  '/:id',
  requireRole('admin', 'super_admin'),
  [
    body('firstName').optional().trim().notEmpty(),
    body('lastName').optional().trim().notEmpty(),
    body('role').optional().isIn(['admin', 'manager', 'sales', 'support', 'finance', 'agent']),
    body('status').optional().isIn(['active', 'inactive', 'suspended']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, role, status } = req.body;
      const fields = [];
      const params = [];

      if (firstName) { params.push(firstName); fields.push(`first_name = $${params.length}`); }
      if (lastName) { params.push(lastName); fields.push(`last_name = $${params.length}`); }
      if (role) { params.push(role); fields.push(`role = $${params.length}`); }
      if (status) { params.push(status); fields.push(`status = $${params.length}`); }

      if (!fields.length) throw HttpError.badRequest('No fields to update');

      params.push(req.params.id);
      const result = await query(
        `UPDATE internal_users SET ${fields.join(', ')}
         WHERE id = $${params.length}
         RETURNING id, first_name, last_name, email, role, status`,
        params
      );

      if (!result.rows.length) throw HttpError.notFound('User not found');
      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
