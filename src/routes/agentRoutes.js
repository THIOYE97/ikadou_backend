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

router.use(requireAuth);

// ─── GET /agents ──────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { search, zone_id, status, page = 1, limit = 20 } = req.query;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(a.first_name ILIKE $${n} OR a.last_name ILIKE $${n} OR a.email ILIKE $${n})`);
    }
    if (zone_id) { params.push(zone_id); conditions.push(`a.zone_id = $${params.length}`); }
    if (status)  { params.push(status);  conditions.push(`a.status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM agents a ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         a.id, a.first_name, a.last_name, a.email, a.phone,
         a.status, a.avatar_url, a.created_at,
         z.name AS zone_name,
         COUNT(DISTINCT l.id) FILTER (WHERE l.status NOT IN ('converted','lost','duplicate')) AS leads_count,
         COUNT(DISTINCT v.id) FILTER (WHERE v.status IN ('scheduled','confirmed')) AS active_visits
       FROM agents a
       LEFT JOIN zones z ON a.zone_id = z.id
       LEFT JOIN leads l ON l.agent_id = a.id
       LEFT JOIN visits v ON v.agent_id = a.id
       ${where}
       GROUP BY a.id, z.name
       ORDER BY a.last_name ASC
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

// ─── POST /agents ─────────────────────────────────────────

router.post(
  '/',
  requireRole('admin', 'super_admin', 'manager'),
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('phone').optional().trim(),
    body('email').optional().isEmail().normalizeEmail(),
    body('zoneId').optional().isUUID(),
    body('status').optional().isIn(['active', 'inactive']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, email, phone, zoneId, status = 'active', bio } = req.body;

      const result = await query(
        `INSERT INTO agents (first_name, last_name, email, phone, zone_id, status, bio, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [firstName, lastName, email || null, phone || null, zoneId || null, status, bio || null, req.user.id]
      );

      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── GET /agents/:id ──────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT a.*, z.name AS zone_name, z.region AS zone_region
       FROM agents a
       LEFT JOIN zones z ON a.zone_id = z.id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Agent introuvable');

    // Zones list (multi-zone support)
    const zones = await query(
      `SELECT z.id, z.name, z.region, az.assigned_at
       FROM agent_zones az
       JOIN zones z ON az.zone_id = z.id
       WHERE az.agent_id = $1`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: { ...result.rows[0], zones: zones.rows },
    });
  } catch (error) { next(error); }
});

// ─── PATCH /agents/:id ────────────────────────────────────

router.patch(
  '/:id',
  requireRole('admin', 'super_admin', 'manager'),
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, email, phone, zoneId, status, bio } = req.body;
      const fields = []; const params = [];

      if (firstName !== undefined) { params.push(firstName); fields.push(`first_name = $${params.length}`); }
      if (lastName !== undefined)  { params.push(lastName);  fields.push(`last_name = $${params.length}`); }
      if (email !== undefined)     { params.push(email);     fields.push(`email = $${params.length}`); }
      if (phone !== undefined)     { params.push(phone);     fields.push(`phone = $${params.length}`); }
      if (zoneId !== undefined)    { params.push(zoneId);    fields.push(`zone_id = $${params.length}`); }
      if (status !== undefined)    { params.push(status);    fields.push(`status = $${params.length}`); }
      if (bio !== undefined)       { params.push(bio);       fields.push(`bio = $${params.length}`); }

      if (!fields.length) throw HttpError.badRequest('Aucun champ à mettre à jour');

      params.push(req.params.id);
      const result = await query(
        `UPDATE agents SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!result.rows.length) throw HttpError.notFound('Agent introuvable');
      return res.json({ success: true, data: result.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── POST /agents/:id/zones ───────────────────────────────

router.post(
  '/:id/zones',
  requireRole('admin', 'super_admin', 'manager'),
  [body('zoneId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { zoneId } = req.body;
      await query(
        `INSERT INTO agent_zones (agent_id, zone_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [req.params.id, zoneId, req.user.id]
      );
      const zones = await query(
        `SELECT z.id, z.name, z.region FROM agent_zones az JOIN zones z ON az.zone_id = z.id WHERE az.agent_id = $1`,
        [req.params.id]
      );
      return res.json({ success: true, data: zones.rows });
    } catch (error) { next(error); }
  }
);

// ─── DELETE /agents/:id/zones/:zoneId ────────────────────

router.delete(
  '/:id/zones/:zoneId',
  requireRole('admin', 'super_admin', 'manager'),
  async (req, res, next) => {
    try {
      await query(
        `DELETE FROM agent_zones WHERE agent_id = $1 AND zone_id = $2`,
        [req.params.id, req.params.zoneId]
      );
      return res.json({ success: true, message: 'Zone retirée' });
    } catch (error) { next(error); }
  }
);

// ─── GET /agents/:id/performance ─────────────────────────

router.get('/:id/performance', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const intervalMap = { '7d': '7 days', '30d': '30 days', '3m': '90 days', '12m': '365 days' };
    const interval = intervalMap[period] || '30 days';

    const [leads, visits, conversions] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'converted') AS converted,
           COUNT(*) FILTER (WHERE status = 'lost') AS lost,
           COUNT(*) FILTER (WHERE status = 'new') AS new
         FROM leads
         WHERE agent_id = $1 AND created_at >= NOW() - INTERVAL '${interval}'`,
        [req.params.id]
      ),
      query(
        `SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'done') AS done,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
           COUNT(*) FILTER (WHERE status IN ('scheduled','confirmed')) AS upcoming
         FROM visits
         WHERE agent_id = $1 AND created_at >= NOW() - INTERVAL '${interval}'`,
        [req.params.id]
      ),
      query(
        `SELECT COUNT(*) AS total_payments
         FROM payments p
         JOIN leads l ON l.client_id = p.client_id
         WHERE l.agent_id = $1 AND p.status = 'confirmed'
           AND p.created_at >= NOW() - INTERVAL '${interval}'`,
        [req.params.id]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        period,
        leads: leads.rows[0],
        visits: visits.rows[0],
        payments: conversions.rows[0],
      },
    });
  } catch (error) { next(error); }
});

module.exports = router;
