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

// ─── GET /tickets ─────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { search, status, priority, assigned_to, page = 1, limit = 20 } = req.query;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(t.ref ILIKE $${n} OR t.subject ILIKE $${n})`);
    }
    if (status)      { params.push(status);      conditions.push(`t.status = $${params.length}`); }
    if (priority)    { params.push(priority);    conditions.push(`t.priority = $${params.length}`); }
    if (assigned_to) { params.push(assigned_to); conditions.push(`t.assigned_to = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM support_tickets t ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         t.id, t.ref, t.subject, t.priority, t.status,
         t.created_at, t.updated_at, t.resolved_at,
         c.first_name || ' ' || c.last_name AS client_name, t.client_id,
         u.first_name || ' ' || u.last_name AS assigned_name, t.assigned_to
       FROM support_tickets t
       LEFT JOIN clients c        ON t.client_id = c.id
       LEFT JOIN internal_users u ON t.assigned_to = u.id
       ${where}
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         t.created_at DESC
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

// ─── POST /tickets ────────────────────────────────────────

router.post(
  '/',
  [
    body('subject').trim().notEmpty(),
    body('priority').isIn(['low','medium','high','urgent']),
    body('clientId').optional().isUUID(),
    body('description').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { subject, description, priority, clientId, assignedTo } = req.body;

      const result = await query(
        `INSERT INTO support_tickets
           (subject, description, priority, client_id, assigned_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [subject, description || null, priority, clientId || null, assignedTo || null, req.user.id]
      );

      const ticket = result.rows[0];

      await query(
        `INSERT INTO ticket_history (ticket_id, action, new_value, user_id)
         VALUES ($1, 'created', $2, $3)`,
        [ticket.id, JSON.stringify({ priority, status: 'open' }), req.user.id]
      );

      return res.status(201).json({ success: true, data: ticket });
    } catch (error) { next(error); }
  }
);
// ─── GET /tickets/assignable-support-users ───────────────

router.get('/assignable-support-users', requireMinRole('manager'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         id,
         first_name,
         last_name,
         email,
         role,
         status
       FROM internal_users
       WHERE role = 'support'
         AND status = 'active'
       ORDER BY first_name ASC, last_name ASC`
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});
// ─── GET /tickets/:id ─────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         t.*,
         c.first_name || ' ' || c.last_name AS client_name,
         c.email AS client_email, c.phone AS client_phone,
         u.first_name || ' ' || u.last_name AS assigned_name
       FROM support_tickets t
       LEFT JOIN clients c        ON t.client_id = c.id
       LEFT JOIN internal_users u ON t.assigned_to = u.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Ticket introuvable');

    const [messages, history] = await Promise.all([
      query(
        `SELECT tm.*, u.first_name || ' ' || u.last_name AS author
         FROM ticket_messages tm
         LEFT JOIN internal_users u ON tm.author_id = u.id
         WHERE tm.ticket_id = $1 ORDER BY tm.created_at ASC`,
        [req.params.id]
      ),
      query(
        `SELECT th.*, u.first_name || ' ' || u.last_name AS author
         FROM ticket_history th
         LEFT JOIN internal_users u ON th.user_id = u.id
         WHERE th.ticket_id = $1 ORDER BY th.created_at DESC`,
        [req.params.id]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        ...result.rows[0],
        messages: messages.rows,
        history: history.rows,
      },
    });
  } catch (error) { next(error); }
});

// ─── PATCH /tickets/:id/status ────────────────────────────

router.patch(
  '/:id/status',
  [
    body('status').isIn(['open','in_progress','waiting_client','resolved','closed']),
    body('comment').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, comment } = req.body;
      const existing = await query(`SELECT status FROM support_tickets WHERE id = $1`, [req.params.id]);
      if (!existing.rows.length) throw HttpError.notFound('Ticket introuvable');

      const resolvedAt = status === 'resolved' ? 'NOW()' : 'NULL';

      await transaction(async (client) => {
        await client.query(
          `UPDATE support_tickets SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2`,
          [status, req.params.id]
        );
        await client.query(
          `INSERT INTO ticket_history (ticket_id, action, old_value, new_value, comment, user_id)
           VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
          [req.params.id, existing.rows[0].status, status, comment || null, req.user.id]
        );
      });

      const updated = await query(`SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── PATCH /tickets/:id/assign ────────────────────────────

router.patch(
  '/:id/assign',
  requireMinRole('manager'),
  [body('assignedTo').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { assignedTo } = req.body;

      const user = await query(
  `SELECT id
   FROM internal_users
   WHERE id = $1
     AND status = 'active'
     AND role = 'support'`,
  [assignedTo]
);
      if (!user.rows.length) throw HttpError.notFound('Utilisateur introuvable ou inactif');

      await transaction(async (client) => {
        await client.query(
          `UPDATE support_tickets SET assigned_to = $1 WHERE id = $2`,
          [assignedTo, req.params.id]
        );
        await client.query(
          `INSERT INTO ticket_history (ticket_id, action, new_value, user_id)
           VALUES ($1, 'assigned', $2, $3)`,
          [req.params.id, assignedTo, req.user.id]
        );
      });

      const updated = await query(`SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── POST /tickets/:id/messages ───────────────────────────

router.post(
  '/:id/messages',
  [
    body('content').trim().notEmpty(),
    body('isInternal').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const ticket = await query(`SELECT id FROM support_tickets WHERE id = $1`, [req.params.id]);
      if (!ticket.rows.length) throw HttpError.notFound('Ticket introuvable');

      const { content, isInternal = false } = req.body;
      const result = await query(
        `INSERT INTO ticket_messages (ticket_id, content, is_internal, author_id)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, content, isInternal, req.user.id]
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) { next(error); }
  }
);


module.exports = router;
