const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireMinRole } = require('../middleware/requireAuth');
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

// ─── GET /visits ──────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { status, agent_id, from_date, to_date, page = 1, limit = 20 } = req.query;
    const params = [];
    const conditions = [];

    if (status)    { params.push(status);    conditions.push(`v.status = $${params.length}`); }
    if (agent_id)  { params.push(agent_id);  conditions.push(`v.agent_id = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`v.visit_date >= $${params.length}`); }
    if (to_date)   { params.push(to_date);   conditions.push(`v.visit_date <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM visits v ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         v.id, v.visit_date, v.visit_time, v.status, v.notes,
         v.created_at, v.updated_at,
         t.title AS terrain_title, t.ref AS terrain_ref,
         a.first_name || ' ' || a.last_name AS agent_name, v.agent_id,
         COALESCE(
           c.first_name || ' ' || c.last_name,
           l.first_name || ' ' || l.last_name
         ) AS client_name,
         v.client_id, v.lead_id
       FROM visits v
       LEFT JOIN terrains t  ON v.terrain_id = t.id
       LEFT JOIN agents a    ON v.agent_id = a.id
       LEFT JOIN clients c   ON v.client_id = c.id
       LEFT JOIN leads l     ON v.lead_id = l.id
       ${where}
       ORDER BY v.visit_date ASC, v.visit_time ASC
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

// ─── POST /visits ─────────────────────────────────────────

router.post(
  '/',
  [
    body('terrainId').isUUID(),
    body('visitDate').isDate(),
    body('visitTime').matches(/^\d{2}:\d{2}$/),
    body('agentId').optional().isUUID(),
    body('clientId').optional().isUUID(),
    body('leadId').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { terrainId, visitDate, visitTime, agentId, clientId, leadId, notes } = req.body;

      if (!clientId && !leadId) {
        throw HttpError.badRequest('Un client ou un lead doit être associé à la visite');
      }

      // Conflict check: same agent, same date+time slot (±30 min)
      if (agentId) {
        const conflict = await query(
          `SELECT id FROM visits
           WHERE agent_id = $1
             AND visit_date = $2
             AND ABS(EXTRACT(EPOCH FROM (visit_time::time - $3::time))) < 1800
             AND status NOT IN ('cancelled', 'no_show')`,
          [agentId, visitDate, visitTime]
        );
        if (conflict.rows.length) {
          throw HttpError.conflict("L'agent a déjà une visite sur ce créneau (±30 min)");
        }
      }

      const result = await query(
        `INSERT INTO visits
           (terrain_id, visit_date, visit_time, agent_id, client_id, lead_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [terrainId, visitDate, visitTime, agentId || null, clientId || null, leadId || null, notes || null, req.user.id]
      );

      const visit = result.rows[0];

      await query(
        `INSERT INTO visit_history (visit_id, action, new_value, user_id)
         VALUES ($1, 'created', $2, $3)`,
        [visit.id, JSON.stringify({ status: 'scheduled', visit_date: visitDate }), req.user.id]
      );

      return res.status(201).json({ success: true, data: visit });
    } catch (error) { next(error); }
  }
);

// ─── GET /visits/:id ──────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         v.*,
         t.title AS terrain_title, t.ref AS terrain_ref,
         a.first_name || ' ' || a.last_name AS agent_name,
         c.first_name || ' ' || c.last_name AS client_name,
         l.first_name || ' ' || l.last_name AS lead_name
       FROM visits v
       LEFT JOIN terrains t ON v.terrain_id = t.id
       LEFT JOIN agents a   ON v.agent_id = a.id
       LEFT JOIN clients c  ON v.client_id = c.id
       LEFT JOIN leads l    ON v.lead_id = l.id
       WHERE v.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Visite introuvable');

    const history = await query(
      `SELECT vh.*, u.first_name || ' ' || u.last_name AS author
       FROM visit_history vh
       LEFT JOIN internal_users u ON vh.user_id = u.id
       WHERE vh.visit_id = $1 ORDER BY vh.created_at DESC`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: { ...result.rows[0], history: history.rows },
    });
  } catch (error) { next(error); }
});

// ─── PATCH /visits/:id/status ─────────────────────────────

router.patch(
  '/:id/status',
  [
    body('status').isIn(['scheduled','confirmed','done','cancelled','rescheduled','no_show']),
    body('reason').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, reason } = req.body;
      const existing = await query(`SELECT status FROM visits WHERE id = $1`, [req.params.id]);
      if (!existing.rows.length) throw HttpError.notFound('Visite introuvable');

      const oldStatus = existing.rows[0].status;

      await transaction(async (client) => {
        await client.query(
          `UPDATE visits SET status = $1, cancel_reason = $2 WHERE id = $3`,
          [status, reason || null, req.params.id]
        );
        await client.query(
          `INSERT INTO visit_history (visit_id, action, old_value, new_value, comment, user_id)
           VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
          [req.params.id, oldStatus, status, reason || null, req.user.id]
        );
      });

      const updated = await query(`SELECT * FROM visits WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── PATCH /visits/:id/reschedule ─────────────────────────

router.patch(
  '/:id/reschedule',
  [
    body('visitDate').isDate(),
    body('visitTime').matches(/^\d{2}:\d{2}$/),
    body('reason').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { visitDate, visitTime, reason } = req.body;
      const existing = await query(
        `SELECT status, visit_date, visit_time, agent_id FROM visits WHERE id = $1`,
        [req.params.id]
      );
      if (!existing.rows.length) throw HttpError.notFound('Visite introuvable');

      const { agent_id, visit_date, visit_time } = existing.rows[0];

      // Conflict check for new slot
      if (agent_id) {
        const conflict = await query(
          `SELECT id FROM visits
           WHERE agent_id = $1 AND visit_date = $2
             AND ABS(EXTRACT(EPOCH FROM (visit_time::time - $3::time))) < 1800
             AND status NOT IN ('cancelled','no_show')
             AND id != $4`,
          [agent_id, visitDate, visitTime, req.params.id]
        );
        if (conflict.rows.length) {
          throw HttpError.conflict("L'agent a déjà une visite sur ce créneau (±30 min)");
        }
      }

      await transaction(async (client) => {
        await client.query(
          `UPDATE visits SET visit_date = $1, visit_time = $2, status = 'rescheduled' WHERE id = $3`,
          [visitDate, visitTime, req.params.id]
        );
        await client.query(
          `INSERT INTO visit_history (visit_id, action, old_value, new_value, comment, user_id)
           VALUES ($1, 'rescheduled', $2, $3, $4, $5)`,
          [
            req.params.id,
            `${visit_date} ${visit_time}`,
            `${visitDate} ${visitTime}`,
            reason || null,
            req.user.id,
          ]
        );
      });

      const updated = await query(`SELECT * FROM visits WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

module.exports = router;
