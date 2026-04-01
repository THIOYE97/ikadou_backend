const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole } = require('../middleware/requireAuth');
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

// ─── GET /clients ─────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(first_name ILIKE $${n} OR last_name ILIKE $${n} OR email ILIKE $${n} OR phone ILIKE $${n})`);
    }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM clients ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT id, first_name, last_name, email, phone, country, city,
              status, kyc_verified, created_at
       FROM clients ${where}
       ORDER BY created_at DESC
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

// ─── POST /clients ────────────────────────────────────────

router.post(
  '/',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, email, phone, country, city } = req.body;

      const result = await query(
        `INSERT INTO clients (first_name, last_name, email, phone, country, city)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [firstName, lastName, email || null, phone || null, country || null, city || null]
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) { next(error); }
  }
);

// ─── GET /clients/:id — 360 view ──────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const clientRes = await query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
    if (!clientRes.rows.length) throw HttpError.notFound('Client introuvable');

    const [leads, visits, payments, docs, tickets] = await Promise.all([
      query(`SELECT id, first_name, last_name, status, source, created_at FROM leads WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10`, [req.params.id]),
      query(`SELECT v.id, v.visit_date, v.visit_time, v.status, t.title AS terrain_title FROM visits v LEFT JOIN terrains t ON v.terrain_id = t.id WHERE v.client_id = $1 ORDER BY v.visit_date DESC LIMIT 10`, [req.params.id]),
      query(`SELECT id, ref, amount, currency, status, created_at FROM payments WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10`, [req.params.id]),
      query(`SELECT id, name, type, created_at FROM documents WHERE related_type = 'client' AND related_id = $1 ORDER BY created_at DESC`, [req.params.id]),
      query(`SELECT id, ref, subject, status, priority, created_at FROM support_tickets WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10`, [req.params.id]),
    ]);

    return res.json({
      success: true,
      data: {
        ...clientRes.rows[0],
        leads: leads.rows,
        visits: visits.rows,
        payments: payments.rows,
        documents: docs.rows,
        tickets: tickets.rows,
      },
    });
  } catch (error) { next(error); }
});

// ─── PATCH /clients/:id ───────────────────────────────────

router.patch('/:id', validate, async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, country, city, kycVerified } = req.body;
    const fields = [];
    const params = [];

    if (firstName !== undefined) { params.push(firstName); fields.push(`first_name = $${params.length}`); }
    if (lastName !== undefined)  { params.push(lastName);  fields.push(`last_name = $${params.length}`); }
    if (email !== undefined)     { params.push(email);     fields.push(`email = $${params.length}`); }
    if (phone !== undefined)     { params.push(phone);     fields.push(`phone = $${params.length}`); }
    if (country !== undefined)   { params.push(country);   fields.push(`country = $${params.length}`); }
    if (city !== undefined)      { params.push(city);      fields.push(`city = $${params.length}`); }
    if (kycVerified !== undefined) { params.push(kycVerified); fields.push(`kyc_verified = $${params.length}`); }

    if (!fields.length) throw HttpError.badRequest('Aucun champ à mettre à jour');

    params.push(req.params.id);
    const result = await query(
      `UPDATE clients SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) throw HttpError.notFound('Client introuvable');
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── PATCH /clients/:id/status ────────────────────────────

router.patch(
  '/:id/status',
  requireRole('admin', 'super_admin', 'manager'),
  [
    body('status').isIn(['active', 'suspended', 'closed']),
    body('reason').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, reason } = req.body;

      const existing = await query(`SELECT status FROM clients WHERE id = $1`, [req.params.id]);
      if (!existing.rows.length) throw HttpError.notFound('Client introuvable');

      await transaction(async (client) => {
        await client.query(`UPDATE clients SET status = $1 WHERE id = $2`, [status, req.params.id]);
        await client.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
           VALUES ($1, $2, 'client', $3, $4)`,
          [
            req.user.id,
            `client_status_changed_to_${status}`,
            req.params.id,
            JSON.stringify({ old: existing.rows[0].status, new: status, reason }),
          ]
        );
      });

      const updated = await query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, data: updated.rows[0] });
    } catch (error) { next(error); }
  }
);
// ─── GET /clients/:id/notification-prefs ────────────────

router.get('/:id/notification-prefs', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM client_notification_prefs WHERE client_id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) {
      // Auto-create if missing
      const created = await query(
        `INSERT INTO client_notification_prefs (client_id) VALUES ($1) RETURNING *`,
        [req.params.id]
      );
      return res.json({ success: true, data: created.rows[0] });
    }
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── PATCH /clients/:id/notification-prefs ───────────────

router.patch('/:id/notification-prefs', async (req, res, next) => {
  try {
    const { emailEnabled, smsEnabled, pushEnabled, whatsappEnabled,
            visitNotifs, paymentNotifs, promoNotifs } = req.body;

    const fields = []; const params = [];
    const set = (col, val) => {
      if (val !== undefined) { params.push(val); fields.push(`${col} = $${params.length}`); }
    };
    set('email_enabled', emailEnabled);
    set('sms_enabled', smsEnabled);
    set('push_enabled', pushEnabled);
    set('whatsapp_enabled', whatsappEnabled);
    set('visit_notifs', visitNotifs);
    set('payment_notifs', paymentNotifs);
    set('promo_notifs', promoNotifs);

    if (!fields.length) throw HttpError.badRequest('Aucun champ');

    params.push(req.params.id);
    const result = await query(
      `UPDATE client_notification_prefs SET ${fields.join(', ')}, updated_at = NOW()
       WHERE client_id = $${params.length} RETURNING *`,
      params
    );
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── GET /clients/:id/device-tokens ──────────────────────

router.get('/:id/device-tokens', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, token, platform, is_active, created_at FROM client_device_tokens WHERE client_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    return res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// ─── DELETE /clients/:id/device-tokens/:tokenId ──────────

router.delete('/:id/device-tokens/:tokenId', requireRole('admin', 'super_admin', 'manager'), async (req, res, next) => {
  try {
    await query(`DELETE FROM client_device_tokens WHERE id = $1 AND client_id = $2`, [req.params.tokenId, req.params.id]);
    return res.json({ success: true, message: 'Token supprimé' });
  } catch (error) { next(error); }
});
module.exports = router;