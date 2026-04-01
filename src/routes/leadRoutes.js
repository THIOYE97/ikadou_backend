const express = require('express');
const { body, query: qv, validationResult } = require('express-validator');
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

const SENSITIVE_STATUSES = ['lost', 'duplicate'];

router.use(requireAuth);

// ─── GET /leads ───────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const {
      search, status, source, agent_id,
      page = 1, limit = 20, sort = 'created_at', order = 'desc',
    } = req.query;

    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(l.first_name ILIKE $${n} OR l.last_name ILIKE $${n} OR l.email ILIKE $${n} OR l.phone ILIKE $${n})`);
    }
    if (status) { params.push(status); conditions.push(`l.status = $${params.length}`); }
    if (source) { params.push(source); conditions.push(`l.source = $${params.length}`); }
    if (agent_id) { params.push(agent_id); conditions.push(`l.agent_id = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = ['created_at', 'updated_at', 'last_name', 'status'];
    const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM leads l ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         l.id, l.first_name, l.last_name, l.email, l.phone, l.country,
         l.source, l.status, l.created_at, l.updated_at,
         a.first_name || ' ' || a.last_name AS agent_name,
         l.agent_id,
         t.title AS terrain_title, l.terrain_id
       FROM leads l
       LEFT JOIN agents a ON l.agent_id = a.id
       LEFT JOIN terrains t ON l.terrain_id = t.id
       ${where}
       ORDER BY l.${sortCol} ${sortOrder}
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

// ─── POST /leads ──────────────────────────────────────────

router.post(
  '/',
  [
    body('firstName').trim().notEmpty().withMessage('Prénom requis'),
    body('lastName').trim().notEmpty().withMessage('Nom requis'),
    body('phone').optional().trim(),
    body('email').optional().isEmail().normalizeEmail(),
    body('source').isIn(['landing_page','mobile_app','referral','social_media','whatsapp','phone','email','agent','other']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, email, phone, country, source, agentId, terrainId } = req.body;

      const result = await query(
        `INSERT INTO leads (first_name, last_name, email, phone, country, source, agent_id, terrain_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [firstName, lastName, email || null, phone || null, country || null, source, agentId || null, terrainId || null, req.user.id]
      );

      const lead = result.rows[0];

      // Log history
      await query(
        `INSERT INTO lead_history (lead_id, action, new_value, user_id)
         VALUES ($1, 'created', $2, $3)`,
        [lead.id, JSON.stringify({ source, status: 'new' }), req.user.id]
      );

      return res.status(201).json({ success: true, data: lead });
    } catch (error) { next(error); }
  }
);

// ─── GET /leads/:id ───────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         l.*,
         a.first_name || ' ' || a.last_name AS agent_name,
         t.title AS terrain_title, t.ref AS terrain_ref,
         c.first_name || ' ' || c.last_name AS client_name
       FROM leads l
       LEFT JOIN agents a ON l.agent_id = a.id
       LEFT JOIN terrains t ON l.terrain_id = t.id
       LEFT JOIN clients c ON l.client_id = c.id
       WHERE l.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Lead introuvable');

    // Fetch history
    const history = await query(
      `SELECT lh.*, u.first_name || ' ' || u.last_name AS author
       FROM lead_history lh
       LEFT JOIN internal_users u ON lh.user_id = u.id
       WHERE lh.lead_id = $1
       ORDER BY lh.created_at DESC`,
      [req.params.id]
    );

    // Fetch notes (only for authorised roles)
    let notes = { rows: [] };
    if (['super_admin','admin','manager','sales','support'].includes(req.user.role)) {
      notes = await query(
        `SELECT ln.*, u.first_name || ' ' || u.last_name AS author
         FROM lead_notes ln
         LEFT JOIN internal_users u ON ln.author_id = u.id
         WHERE ln.lead_id = $1
         ORDER BY ln.created_at ASC`,
        [req.params.id]
      );
    }

    return res.json({
      success: true,
      data: { ...result.rows[0], history: history.rows, notes: notes.rows },
    });
  } catch (error) { next(error); }
});

// ─── PATCH /leads/:id/status ──────────────────────────────

router.patch(
  '/:id/status',
  [
    body('status').isIn(['new','contacted','qualified','visit_scheduled','visit_done','negotiation','converted','lost','duplicate']),
    body('reason').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, reason } = req.body;

      if (SENSITIVE_STATUSES.includes(status) && !reason) {
        throw HttpError.badRequest(`Un motif est requis pour le statut "${status}"`);
      }

      const existing = await query(`SELECT status FROM leads WHERE id = $1`, [req.params.id]);
      if (!existing.rows.length) throw HttpError.notFound('Lead introuvable');

      const oldStatus = existing.rows[0].status;

      await transaction(async (client) => {
        await client.query(
          `UPDATE leads SET status = $1, lost_reason = $2 WHERE id = $3`,
          [status, reason || null, req.params.id]
        );
        await client.query(
          `INSERT INTO lead_history (lead_id, action, field, old_value, new_value, comment, user_id)
           VALUES ($1, 'status_changed', 'status', $2, $3, $4, $5)`,
          [req.params.id, oldStatus, status, reason || null, req.user.id]
        );
      });

      const updated = await query(`SELECT * FROM leads WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── PATCH /leads/:id/assign ──────────────────────────────

router.patch(
  '/:id/assign',
  requireMinRole('manager'),
  [body('agentId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { agentId } = req.body;

      const agent = await query(`SELECT id FROM agents WHERE id = $1 AND status = 'active'`, [agentId]);
      if (!agent.rows.length) throw HttpError.notFound('Agent introuvable ou inactif');

      const existing = await query(`SELECT agent_id FROM leads WHERE id = $1`, [req.params.id]);
      if (!existing.rows.length) throw HttpError.notFound('Lead introuvable');

      const oldAgentId = existing.rows[0].agent_id;

      await transaction(async (client) => {
        await client.query(`UPDATE leads SET agent_id = $1 WHERE id = $2`, [agentId, req.params.id]);
        await client.query(
          `INSERT INTO lead_history (lead_id, action, field, old_value, new_value, user_id)
           VALUES ($1, 'assigned', 'agent_id', $2, $3, $4)`,
          [req.params.id, oldAgentId, agentId, req.user.id]
        );
      });

      const updated = await query(`SELECT * FROM leads WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── PATCH /leads/:id ─────────────────────────────────────

router.patch('/:id', validate, async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, country, terrainId } = req.body;
    const fields = [];
    const params = [];

    if (firstName) { params.push(firstName); fields.push(`first_name = $${params.length}`); }
    if (lastName)  { params.push(lastName);  fields.push(`last_name = $${params.length}`); }
    if (email)     { params.push(email);     fields.push(`email = $${params.length}`); }
    if (phone)     { params.push(phone);     fields.push(`phone = $${params.length}`); }
    if (country)   { params.push(country);   fields.push(`country = $${params.length}`); }
    if (terrainId) { params.push(terrainId); fields.push(`terrain_id = $${params.length}`); }

    if (!fields.length) throw HttpError.badRequest('Aucun champ à mettre à jour');

    params.push(req.params.id);
    const result = await query(
      `UPDATE leads SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) throw HttpError.notFound('Lead introuvable');

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /leads/:id/notes ────────────────────────────────

router.post(
  '/:id/notes',
  [body('content').trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const lead = await query(`SELECT id FROM leads WHERE id = $1`, [req.params.id]);
      if (!lead.rows.length) throw HttpError.notFound('Lead introuvable');

      const result = await query(
        `INSERT INTO lead_notes (lead_id, content, author_id) VALUES ($1, $2, $3) RETURNING *`,
        [req.params.id, req.body.content, req.user.id]
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── DELETE /leads/:id/notes/:noteId ─────────────────────

router.delete('/:id/notes/:noteId', async (req, res, next) => {
  try {
    const note = await query(`SELECT author_id FROM lead_notes WHERE id = $1 AND lead_id = $2`, [req.params.noteId, req.params.id]);
    if (!note.rows.length) throw HttpError.notFound('Note introuvable');

    // Only author or admin can delete
    if (note.rows[0].author_id !== req.user.id && !['admin','super_admin'].includes(req.user.role)) {
      throw HttpError.forbidden('Action non autorisée');
    }

    await query(`DELETE FROM lead_notes WHERE id = $1`, [req.params.noteId]);
    return res.json({ success: true, message: 'Note supprimée' });
  } catch (error) { next(error); }
});

module.exports = router;