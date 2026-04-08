const express = require('express');
const { body, query: q, validationResult } = require('express-validator');
const router = express.Router();

const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const requireClientAuth = require('../middleware/requireClientAuth');

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

router.use(requireClientAuth);

// ─── GET /client/visits ───────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         v.id,
         v.visit_date,
         v.visit_time,
         v.status,
         v.notes,
         v.cancel_reason,
         v.created_at,
         v.updated_at,
         t.id AS terrain_id,
         t.title AS terrain_title,
         t.ref AS terrain_ref,
         t.location AS terrain_location,
         t.images AS terrain_images,
         a.first_name || ' ' || a.last_name AS agent_name
       FROM visits v
       LEFT JOIN terrains t ON t.id = v.terrain_id
       LEFT JOIN agents a ON a.id = v.agent_id
       WHERE v.client_id = $1
       ORDER BY v.visit_date ASC, v.visit_time ASC`,
      [req.client.id]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// ─── GET /client/visits/:id ───────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const visit = await query(
      `SELECT
         v.*,
         t.title AS terrain_title,
         t.ref AS terrain_ref,
         t.location AS terrain_location,
         t.images AS terrain_images,
         a.first_name || ' ' || a.last_name AS agent_name
       FROM visits v
       LEFT JOIN terrains t ON t.id = v.terrain_id
       LEFT JOIN agents a ON a.id = v.agent_id
       WHERE v.id = $1
         AND v.client_id = $2`,
      [req.params.id, req.client.id]
    );

    if (!visit.rows.length) throw HttpError.notFound('Visite introuvable');

    const history = await query(
      `SELECT *
       FROM visit_history
       WHERE visit_id = $1
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: {
        ...visit.rows[0],
        history: history.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /client/visits/slots ─────────────────────────────

router.get(
  '/slots/search',
  [
    q('terrainId').isUUID(),
    q('date').isDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { terrainId, date } = req.query;

      const terrain = await query(
        `SELECT id, status
         FROM terrains
         WHERE id = $1`,
        [terrainId]
      );

      if (!terrain.rows.length || terrain.rows[0].status !== 'published') {
        throw HttpError.notFound('Terrain introuvable');
      }

      const taken = await query(
        `SELECT visit_time
         FROM visits
         WHERE terrain_id = $1
           AND visit_date = $2
           AND status NOT IN ('cancelled', 'no_show')`,
        [terrainId, date]
      );

      const baseSlots = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00'];
      const busyTimes = new Set(taken.rows.map((r) => String(r.visit_time).slice(0, 5)));

      const slots = baseSlots.map((time) => ({
        time,
        available: !busyTimes.has(time),
      }));

      return res.json({
        success: true,
        data: {
          terrainId,
          date,
          slots,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /client/visits ──────────────────────────────────

router.post(
  '/',
  [
    body('terrainId').isUUID(),
    body('visitDate').isDate(),
    body('visitTime').matches(/^\d{2}:\d{2}$/),
    body('notes').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { terrainId, visitDate, visitTime, notes } = req.body;

      const terrain = await query(
        `SELECT id, status
         FROM terrains
         WHERE id = $1`,
        [terrainId]
      );

      if (!terrain.rows.length || terrain.rows[0].status !== 'published') {
        throw HttpError.notFound('Terrain introuvable');
      }

      const conflict = await query(
        `SELECT id
         FROM visits
         WHERE terrain_id = $1
           AND visit_date = $2
           AND visit_time = $3
           AND status NOT IN ('cancelled', 'no_show')`,
        [terrainId, visitDate, visitTime]
      );

      if (conflict.rows.length) {
        throw HttpError.conflict('Ce créneau n’est plus disponible');
      }

      const result = await query(
        `INSERT INTO visits
          (terrain_id, visit_date, visit_time, client_id, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, NULL)
         RETURNING *`,
        [terrainId, visitDate, visitTime, req.client.id, notes || null]
      );

      await query(
        `INSERT INTO visit_history (visit_id, action, new_value, comment, user_id)
         VALUES ($1, 'created', $2, $3, NULL)`,
        [
          result.rows[0].id,
          JSON.stringify({
            status: 'scheduled',
            visit_date: visitDate,
            visit_time: visitTime,
          }),
          'Créé depuis l’application mobile',
        ]
      );

      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

// ─── PATCH /client/visits/:id/reschedule ──────────────────

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
        `SELECT *
         FROM visits
         WHERE id = $1
           AND client_id = $2`,
        [req.params.id, req.client.id]
      );

      if (!existing.rows.length) throw HttpError.notFound('Visite introuvable');

      const visit = existing.rows[0];

      const conflict = await query(
        `SELECT id
         FROM visits
         WHERE terrain_id = $1
           AND visit_date = $2
           AND visit_time = $3
           AND status NOT IN ('cancelled', 'no_show')
           AND id != $4`,
        [visit.terrain_id, visitDate, visitTime, req.params.id]
      );

      if (conflict.rows.length) {
        throw HttpError.conflict('Ce créneau n’est plus disponible');
      }

      await transaction(async (client) => {
        await client.query(
          `UPDATE visits
           SET visit_date = $1,
               visit_time = $2,
               status = 'rescheduled',
               updated_at = NOW()
           WHERE id = $3`,
          [visitDate, visitTime, req.params.id]
        );

        await client.query(
          `INSERT INTO visit_history (visit_id, action, old_value, new_value, comment, user_id)
           VALUES ($1, 'rescheduled', $2, $3, $4, NULL)`,
          [
            req.params.id,
            `${visit.visit_date} ${String(visit.visit_time).slice(0, 5)}`,
            `${visitDate} ${visitTime}`,
            reason || 'Replanifié depuis l’application mobile',
          ]
        );
      });

      const updated = await query(
        `SELECT *
         FROM visits
         WHERE id = $1`,
        [req.params.id]
      );

      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

// ─── PATCH /client/visits/:id/cancel ──────────────────────

router.patch(
  '/:id/cancel',
  [body('reason').optional().trim()],
  validate,
  async (req, res, next) => {
    try {
      const { reason } = req.body;

      const existing = await query(
        `SELECT *
         FROM visits
         WHERE id = $1
           AND client_id = $2`,
        [req.params.id, req.client.id]
      );

      if (!existing.rows.length) throw HttpError.notFound('Visite introuvable');

      const visit = existing.rows[0];

      await transaction(async (client) => {
        await client.query(
          `UPDATE visits
           SET status = 'cancelled',
               cancel_reason = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [reason || null, req.params.id]
        );

        await client.query(
          `INSERT INTO visit_history (visit_id, action, old_value, new_value, comment, user_id)
           VALUES ($1, 'status_changed', $2, $3, $4, NULL)`,
          [
            req.params.id,
            visit.status,
            'cancelled',
            reason || 'Annulé depuis l’application mobile',
          ]
        );
      });

      const updated = await query(
        `SELECT *
         FROM visits
         WHERE id = $1`,
        [req.params.id]
      );

      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;