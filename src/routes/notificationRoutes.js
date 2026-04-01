const express = require('express');
const { body, query: q, validationResult } = require('express-validator');

const router = express.Router();

const { requireAuth, requireRole, requireMinRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { query } = require('../data/db');
const NotificationService = require('../services/notificationService');

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

/**
 * Helpers
 */
const parsePositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const buildWhereClause = ({ status, channel, search, type }) => {
  const params = [];
  const conditions = [];

  if (status) {
    params.push(status);
    conditions.push(`n.status = $${params.length}`);
  }

  if (channel) {
    params.push(channel);
    conditions.push(`n.channel = $${params.length}`);
  }

  if (type) {
    params.push(type);
    conditions.push(`n.type = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(
      n.recipient ILIKE $${params.length}
      OR n.type ILIKE $${params.length}
      OR COALESCE(n.subject, '') ILIKE $${params.length}
      OR COALESCE(n.content, '') ILIKE $${params.length}
    )`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
};

//
// ──────────────────────────────────────────────────────────
// ADMIN / BACKOFFICE — QUEUE
// ──────────────────────────────────────────────────────────
//

// ─── GET /notifications/stats/summary ────────────────────

router.get('/stats/summary', requireMinRole('manager'), async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const intervalMap = { '7d': '7 days', '30d': '30 days', '3m': '90 days' };
    const interval = intervalMap[period] || '30 days';

    const rows = await query(`
      SELECT
        channel,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'sent' OR status = 'delivered') AS sent,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        ROUND(
          COUNT(*) FILTER (WHERE status IN ('sent','delivered'))::numeric
          / NULLIF(COUNT(*), 0) * 100
        , 1) AS delivery_rate
      FROM notifications
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY channel
      ORDER BY total DESC
    `);

    return res.json({ success: true, data: rows.rows });
  } catch (error) { next(error); }
});

// ─── GET /notifications/settings ─────────────────────────

router.get('/settings', requireMinRole('manager'), async (req, res, next) => {
  try {
    const rows = await query(`SELECT * FROM notification_settings ORDER BY key`);
    // Return as key-value object for easy frontend consumption
    const settings = Object.fromEntries(rows.rows.map(r => [r.key, { value: r.value, description: r.description }]));
    return res.json({ success: true, data: settings });
  } catch (error) { next(error); }
});

// ─── PATCH /notifications/settings ───────────────────────

router.patch('/settings', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { settings } = req.body; // { key: value, ... }
    if (!settings || typeof settings !== 'object') {
      throw HttpError.badRequest('settings object requis');
    }

    for (const [key, value] of Object.entries(settings)) {
      await query(
        `UPDATE notification_settings SET value = $1, updated_by = $2, updated_at = NOW()
         WHERE key = $3`,
        [String(value), req.user.id, key]
      );
    }

    const rows = await query(`SELECT * FROM notification_settings ORDER BY key`);
    const updated = Object.fromEntries(rows.rows.map(r => [r.key, { value: r.value, description: r.description }]));
    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

// ─── POST /notifications/send ─────────────────────────────
// Manual single send from backoffice

router.post('/send', requireMinRole('support'), async (req, res, next) => {
  try {
    const { channel, type, recipient, subject, content, variables, relatedType, relatedId, templateId } = req.body;

    if (!channel || !recipient) throw HttpError.badRequest('channel et recipient requis');

    const notifService = require('../services/notificationService');

    const result = await notifService.send({
      channel,
      type: type || 'custom',
      recipient,
      subject,
      body: content,
      vars: variables || {},
      relatedType, relatedId,
      sentBy: req.user.id,
      templateId,
    });

    return res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

// ─── POST /notifications/broadcast ───────────────────────
// Broadcast to a segment (all clients, by status, etc.)

router.post('/broadcast', requireMinRole('manager'), async (req, res, next) => {
  try {
    const { channel, type, subject, content, variables, segment } = req.body;
    if (!channel || !type) throw HttpError.badRequest('channel et type requis');

    // Build recipient list based on segment
    let recipientsQuery;
    const params = [];

    if (segment === 'all_clients') {
      if (channel === 'email') {
        recipientsQuery = `SELECT id, first_name, last_name, email AS contact, push_token FROM clients WHERE status = 'active' AND email IS NOT NULL`;
      } else if (channel === 'sms' || channel === 'whatsapp') {
        recipientsQuery = `SELECT id, first_name, last_name, phone AS contact, push_token FROM clients WHERE status = 'active' AND phone IS NOT NULL`;
      } else if (channel === 'push') {
        recipientsQuery = `SELECT c.id, c.first_name, c.last_name, cdt.token AS contact FROM clients c JOIN client_device_tokens cdt ON cdt.client_id = c.id WHERE c.status = 'active' AND cdt.is_active = TRUE`;
      }
    } else if (segment === 'leads_new') {
      recipientsQuery = `SELECT DISTINCT l.id, l.first_name, l.last_name, l.email AS contact FROM leads l WHERE l.status = 'new' AND l.email IS NOT NULL`;
    } else {
      throw HttpError.badRequest(`Segment inconnu: ${segment}`);
    }

    const recipients = await query(recipientsQuery, params);
    const notifService = require('../services/notificationService');
    let sent = 0; let failed = 0;

    for (const r of recipients.rows) {
      if (!r.contact) continue;
      const vars = { first_name: r.first_name, last_name: r.last_name, ...(variables || {}) };
      const result = await notifService.send({
        channel, type, recipient: r.contact,
        subject, body: content, vars,
        relatedType: 'client', relatedId: r.id,
        sentBy: req.user.id,
      });
      result.success ? sent++ : failed++;
    }

    return res.json({
      success: true,
      data: { total: recipients.rows.length, sent, failed },
    });
  } catch (error) { next(error); }
});


// GET /notifications
router.get(
  '/',
  requireMinRole('support'),
  [
    q('page').optional().isInt({ min: 1 }),
    q('limit').optional().isInt({ min: 1, max: 100 }),
    q('status').optional().isIn(['pending', 'processing', 'sent', 'failed', 'cancelled']),
    q('channel').optional().isIn(['email', 'sms', 'whatsapp', 'push', 'in_app']),
    q('type').optional().isString(),
    q('search').optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const page = parsePositiveInt(req.query.page, 1);
      const limit = parsePositiveInt(req.query.limit, 20);
      const offset = (page - 1) * limit;

      const { where, params } = buildWhereClause(req.query);

      const countRes = await query(
        `SELECT COUNT(*)::int AS total
         FROM notification_queue n
         ${where}`,
        params
      );

      const total = countRes.rows[0]?.total || 0;

      const dataParams = [...params, limit, offset];
      const result = await query(
        `SELECT
           n.id,
           n.channel,
           n.type,
           n.recipient,
           n.subject,
           n.content,
           n.variables,
           n.related_type,
           n.related_id,
           n.scheduled_at,
           n.attempts,
           n.max_attempts,
           n.status,
           n.error_reason,
           n.created_at,
           n.processed_at,
           n.sent_by,
           u.first_name || ' ' || u.last_name AS sent_by_name
         FROM notification_queue n
         LEFT JOIN internal_users u ON u.id = n.sent_by
         ${where}
         ORDER BY n.created_at DESC
         LIMIT $${dataParams.length - 1}
         OFFSET $${dataParams.length}`,
        dataParams
      );

      return res.json({
        success: true,
        data: result.rows,
        meta: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /notifications/:id
router.get('/:id', requireMinRole('support'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         n.*,
         u.first_name || ' ' || u.last_name AS sent_by_name
       FROM notification_queue n
       LEFT JOIN internal_users u ON u.id = n.sent_by
       WHERE n.id = $1`,
      [req.params.id]
    );

    if (!result.rows.length) {
      throw HttpError.notFound('Notification introuvable');
    }

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /notifications/send
router.post(
  '/send',
  requireMinRole('support'),
  [
    body('channel').isIn(['email', 'sms', 'whatsapp', 'push', 'in_app']),
    body('type').isString().trim().notEmpty(),
    body('recipient').isString().trim().notEmpty(),
    body('subject').optional().isString(),
    body('body').optional().isString(),
    body('vars').optional().isObject(),
    body('relatedType').optional().isString(),
    body('relatedId').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        channel,
        type,
        recipient,
        subject,
        body: rawBody,
        vars = {},
        relatedType,
        relatedId,
      } = req.body;

      const result = await NotificationService.send({
        channel,
        type,
        recipient,
        subject,
        body: rawBody,
        vars,
        relatedType,
        relatedId,
        sentBy: req.user.id,
      });

      return res.status(201).json({
        success: true,
        message: result.success ? 'Notification envoyée' : 'Notification en échec',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /notifications/:id/resend
router.post('/:id/resend', requireMinRole('support'), async (req, res, next) => {
  try {
    const original = await query(
      `SELECT *
       FROM notification_queue
       WHERE id = $1`,
      [req.params.id]
    );

    if (!original.rows.length) {
      throw HttpError.notFound('Notification introuvable');
    }

    const notif = original.rows[0];

    const result = await NotificationService.send({
      channel: notif.channel,
      type: notif.type,
      recipient: notif.recipient,
      subject: notif.subject,
      body: notif.content,
      vars: notif.variables || {},
      relatedType: notif.related_type,
      relatedId: notif.related_id,
      sentBy: req.user.id,
    });

    return res.json({
      success: true,
      message: 'Notification renvoyée',
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /notifications/:id/status
router.patch(
  '/:id/status',
  requireRole('admin', 'super_admin'),
  [
    body('status').isIn(['pending', 'processing', 'sent', 'failed', 'cancelled']),
    body('error_reason').optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, error_reason } = req.body;

      const result = await query(
        `UPDATE notification_queue
         SET
           status = $2,
           error_reason = COALESCE($3, error_reason),
           processed_at = CASE
             WHEN $2 IN ('sent', 'failed', 'cancelled') THEN NOW()
             ELSE processed_at
           END
         WHERE id = $1
         RETURNING *`,
        [req.params.id, status, error_reason || null]
      );

      if (!result.rows.length) {
        throw HttpError.notFound('Notification introuvable');
      }

      return res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);

//
// ──────────────────────────────────────────────────────────
// ADMIN — SETTINGS
// ──────────────────────────────────────────────────────────
//

// GET /notifications/settings
router.get('/settings/list', requireMinRole('manager'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         ns.key,
         ns.value,
         ns.description,
         ns.updated_at,
         ns.updated_by,
         iu.first_name || ' ' || iu.last_name AS updated_by_name
       FROM notification_settings ns
       LEFT JOIN internal_users iu ON iu.id = ns.updated_by
       ORDER BY ns.key ASC`
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /notifications/settings/:key
router.patch(
  '/settings/:key',
  requireRole('admin', 'super_admin'),
  [body('value').exists().isString(), body('description').optional().isString()],
  validate,
  async (req, res, next) => {
    try {
      const { value, description } = req.body;

      const result = await query(
        `UPDATE notification_settings
         SET
           value = $2,
           description = COALESCE($3, description),
           updated_by = $4,
           updated_at = NOW()
         WHERE key = $1
         RETURNING *`,
        [req.params.key, value, description || null, req.user.id]
      );

      if (!result.rows.length) {
        throw HttpError.notFound('Paramètre introuvable');
      }

      return res.json({
        success: true,
        message: 'Paramètre mis à jour',
        data: result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);

//
// ──────────────────────────────────────────────────────────
// TEMPLATES
// ──────────────────────────────────────────────────────────
//

// GET /notifications/templates
router.get('/templates/list', requireMinRole('manager'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         nt.*,
         u.first_name || ' ' || u.last_name AS updated_by_name
       FROM notification_templates nt
       LEFT JOIN internal_users u ON nt.updated_by = u.id
       ORDER BY nt.channel, nt.type`
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /notifications/templates/:id
router.get('/templates/:id', requireMinRole('manager'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM notification_templates WHERE id = $1`,
      [req.params.id]
    );

    if (!result.rows.length) {
      throw HttpError.notFound('Template introuvable');
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PATCH /notifications/templates/:id
router.patch(
  '/templates/:id',
  requireRole('admin', 'super_admin'),
  [
    body('content').optional().trim().notEmpty(),
    body('subject').optional().trim(),
    body('is_active').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { content, subject, is_active } = req.body;
      const fields = [];
      const params = [];

      if (content !== undefined) {
        params.push(content);
        fields.push(`content = $${params.length}`);
      }

      if (subject !== undefined) {
        params.push(subject);
        fields.push(`subject = $${params.length}`);
      }

      if (is_active !== undefined) {
        params.push(is_active);
        fields.push(`is_active = $${params.length}`);
      }

      if (!fields.length) {
        throw HttpError.badRequest('Aucun champ à mettre à jour');
      }

      params.push(req.user.id);
      fields.push(`updated_by = $${params.length}`);

      params.push(req.params.id);

      const result = await query(
        `UPDATE notification_templates
         SET ${fields.join(', ')}
         WHERE id = $${params.length}
         RETURNING *`,
        params
      );
      if (!result.rows.length) {
        throw HttpError.notFound('Template introuvable');
      }

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;