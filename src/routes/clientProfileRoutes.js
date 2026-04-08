const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { query } = require('../data/db');
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

// ─── GET /client/profile/me ───────────────────────────────

router.get('/me', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         id, first_name, last_name, email, phone,
         country, city, status, kyc_verified, created_at, updated_at
       FROM clients
       WHERE id = $1`,
      [req.client.id]
    );

    if (!result.rows.length) throw HttpError.notFound('Client introuvable');

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /client/profile/me ─────────────────────────────

router.patch(
  '/me',
  [
    body('firstName').optional().trim().notEmpty(),
    body('lastName').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().trim().notEmpty(),
    body('country').optional().trim(),
    body('city').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, email, phone, country, city } = req.body;

      const fields = [];
      const params = [];

      const set = (column, value) => {
        if (value !== undefined) {
          params.push(value);
          fields.push(`${column} = $${params.length}`);
        }
      };

      set('first_name', firstName);
      set('last_name', lastName);
      set('email', email);
      set('phone', phone);
      set('country', country);
      set('city', city);

      if (!fields.length) throw HttpError.badRequest('Aucun champ à mettre à jour');

      params.push(req.client.id);

      const result = await query(
        `UPDATE clients
         SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}
         RETURNING id, first_name, last_name, email, phone, country, city, status, kyc_verified, created_at, updated_at`,
        params
      );

      if (!result.rows.length) throw HttpError.notFound('Client introuvable');

      if (email !== undefined || phone !== undefined) {
        const authFields = [];
        const authParams = [];

        if (email !== undefined) {
          authParams.push(email);
          authFields.push(`email = $${authParams.length}`);
          authFields.push(`is_email_verified = FALSE`);
        }

        if (phone !== undefined) {
          authParams.push(phone);
          authFields.push(`phone = $${authParams.length}`);
          authFields.push(`is_phone_verified = FALSE`);
        }

        authParams.push(req.client.id);

        await query(
          `UPDATE client_auth_accounts
           SET ${authFields.join(', ')}, updated_at = NOW()
           WHERE client_id = $${authParams.length}`,
          authParams
        );
      }

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /client/profile/app-state ────────────────────────

router.get('/app-state', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT *
       FROM client_app_state
       WHERE client_id = $1`,
      [req.client.id]
    );

    return res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    next(error);
  }
});

// ─── POST /client/profile/app-state/onboarding-complete ───

router.post('/app-state/onboarding-complete', async (req, res, next) => {
  try {
    const { version } = req.body || {};

    const result = await query(
      `UPDATE client_app_state
       SET onboarding_completed = TRUE,
           onboarding_completed_at = NOW(),
           onboarding_version = COALESCE($2, onboarding_version),
           updated_at = NOW()
       WHERE client_id = $1
       RETURNING *`,
      [req.client.id, version || null]
    );

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ─── GET /client/profile/notification-prefs ───────────────

router.get('/notification-prefs', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT *
       FROM client_notification_prefs
       WHERE client_id = $1`,
      [req.client.id]
    );

    return res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /client/profile/notification-prefs ─────────────

router.patch('/notification-prefs', async (req, res, next) => {
  try {
    const {
      emailEnabled,
      smsEnabled,
      pushEnabled,
      whatsappEnabled,
      visitNotifs,
      paymentNotifs,
      promoNotifs,
    } = req.body;

    const fields = [];
    const params = [];

    const set = (col, val) => {
      if (val !== undefined) {
        params.push(val);
        fields.push(`${col} = $${params.length}`);
      }
    };

    set('email_enabled', emailEnabled);
    set('sms_enabled', smsEnabled);
    set('push_enabled', pushEnabled);
    set('whatsapp_enabled', whatsappEnabled);
    set('visit_notifs', visitNotifs);
    set('payment_notifs', paymentNotifs);
    set('promo_notifs', promoNotifs);

    if (!fields.length) throw HttpError.badRequest('Aucun champ à mettre à jour');

    params.push(req.client.id);

    const result = await query(
      `UPDATE client_notification_prefs
       SET ${fields.join(', ')}, updated_at = NOW()
       WHERE client_id = $${params.length}
       RETURNING *`,
      params
    );

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ─── GET /client/profile/device-tokens ────────────────────

router.get('/device-tokens', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, token, platform, is_active, created_at, updated_at
       FROM client_device_tokens
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [req.client.id]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// ─── POST /client/profile/device-tokens ───────────────────

router.post(
  '/device-tokens',
  [
    body('token').trim().notEmpty(),
    body('platform').isIn(['ios', 'android', 'web']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { token, platform } = req.body;

      const result = await query(
        `INSERT INTO client_device_tokens (client_id, token, platform, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (client_id, token)
         DO UPDATE
           SET platform = EXCLUDED.platform,
               is_active = TRUE,
               updated_at = NOW()
         RETURNING *`,
        [req.client.id, token, platform]
      );

      await query(
        `UPDATE clients
         SET push_token = $2, updated_at = NOW()
         WHERE id = $1`,
        [req.client.id, token]
      );

      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

// ─── DELETE /client/profile/device-tokens/:tokenId ───────

router.delete('/device-tokens/:tokenId', async (req, res, next) => {
  try {
    await query(
      `DELETE FROM client_device_tokens
       WHERE id = $1
         AND client_id = $2`,
      [req.params.tokenId, req.client.id]
    );

    return res.json({ success: true, message: 'Token supprimé' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;