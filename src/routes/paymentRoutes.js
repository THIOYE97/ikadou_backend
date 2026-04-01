const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole, requireMinRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { query, transaction } = require('../data/db');

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

// Transitions autorisées
const STATUS_TRANSITIONS = {
  pending:   ['confirmed', 'failed', 'cancelled'],
  confirmed: ['refunded'],
  failed:    ['pending'],
  partial:   ['confirmed', 'failed', 'cancelled'],
  refunded:  [],
  cancelled: [],
};

// Rôles requis pour chaque transition sensible
const SENSITIVE_TRANSITIONS = ['confirmed', 'refunded'];

router.use(requireAuth);

// ─── GET /payments ────────────────────────────────────────

router.get('/', requireMinRole('finance'), async (req, res, next) => {
  try {
    const { search, status, from_date, to_date, client_id, page = 1, limit = 20 } = req.query;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`p.ref ILIKE $${params.length}`);
    }
    if (status)    { params.push(status);    conditions.push(`p.status = $${params.length}`); }
    if (client_id) { params.push(client_id); conditions.push(`p.client_id = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`p.created_at >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conditions.push(`p.created_at <= $${params.length}::date + interval '1 day'`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM payments p ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         p.id, p.ref, p.amount, p.currency, p.status,
         p.payment_method, p.transaction_ref, p.created_at,
         c.first_name || ' ' || c.last_name AS client_name, p.client_id,
         t.title AS terrain_title, t.ref AS terrain_ref, p.terrain_id
       FROM payments p
       LEFT JOIN clients c  ON p.client_id = c.id
       LEFT JOIN terrains t ON p.terrain_id = t.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data: rows.rows,
      meta: { total, page: +page, limit: +limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

// ─── POST /payments ───────────────────────────────────────

router.post(
  '/',
  requireMinRole('finance'),
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amount').isNumeric(),
    body('currency').isIn(['XOF','EUR','USD']),
    body('paymentMethod').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { clientId, terrainId, amount, currency, paymentMethod, transactionRef, notes } = req.body;

      const result = await query(
        `INSERT INTO payments
           (client_id, terrain_id, amount, currency, payment_method, transaction_ref, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [clientId, terrainId, amount, currency, paymentMethod || null, transactionRef || null, notes || null, req.user.id]
      );

      const payment = result.rows[0];

      await query(
        `INSERT INTO payment_history (payment_id, action, new_status, user_id)
         VALUES ($1, 'created', 'pending', $2)`,
        [payment.id, req.user.id]
      );

      return res.status(201).json({ success: true, data: payment });
    } catch (error) { next(error); }
  }
);

// ─── GET /payments/:id ────────────────────────────────────

router.get('/:id', requireMinRole('finance'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         p.*,
         c.first_name || ' ' || c.last_name AS client_name,
         c.email AS client_email, c.phone AS client_phone,
         t.title AS terrain_title, t.ref AS terrain_ref
       FROM payments p
       LEFT JOIN clients c  ON p.client_id = c.id
       LEFT JOIN terrains t ON p.terrain_id = t.id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Paiement introuvable');

    const history = await query(
      `SELECT ph.*, u.first_name || ' ' || u.last_name AS author
       FROM payment_history ph
       LEFT JOIN internal_users u ON ph.user_id = u.id
       WHERE ph.payment_id = $1 ORDER BY ph.created_at DESC`,
      [req.params.id]
    );

    const docs = await query(
      `SELECT id, name, type, url, created_at FROM documents
       WHERE related_type = 'payment' AND related_id = $1`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: { ...result.rows[0], history: history.rows, documents: docs.rows },
    });
  } catch (error) { next(error); }
});

// ─── PATCH /payments/:id/status ───────────────────────────

router.patch(
  '/:id/status',
  requireMinRole('finance'),
  [
    body('status').isIn(['pending','confirmed','failed','refunded','partial','cancelled']),
    body('comment').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, comment } = req.body;

      const existing = await query(`SELECT status FROM payments WHERE id = $1`, [req.params.id]);
      if (!existing.rows.length) throw HttpError.notFound('Paiement introuvable');

      const oldStatus = existing.rows[0].status;
      const allowed = STATUS_TRANSITIONS[oldStatus] || [];

      if (!allowed.includes(status)) {
        throw HttpError.badRequest(
          `Transition "${oldStatus}" → "${status}" non autorisée. Autorisées: ${allowed.join(', ') || 'aucune'}`
        );
      }

      // Sensitive transitions need manager+
      if (SENSITIVE_TRANSITIONS.includes(status)) {
        const roleLevel = { super_admin: 7, admin: 6, manager: 5, finance: 4, sales: 3, support: 3, agent: 2 };
        if ((roleLevel[req.user.role] || 0) < 5) {
          throw HttpError.forbidden('Rôle insuffisant pour cette transition');
        }
      }

      await transaction(async (client) => {
        await client.query(
          `UPDATE payments SET status = $1 WHERE id = $2`,
          [status, req.params.id]
        );
        await client.query(
          `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
           VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
          [req.params.id, oldStatus, status, comment || null, req.user.id]
        );
      });

      const updated = await query(`SELECT * FROM payments WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

module.exports = router;
