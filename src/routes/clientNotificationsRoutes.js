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

const getClientId = (req) => {
  const clientId = req.client?.id;
  if (!clientId) {
    throw HttpError.unauthorized('Client non authentifié');
  }
  return clientId;
};

//
// ──────────────────────────────────────────────────────────
// GET /client/notifications/preferences
// ──────────────────────────────────────────────────────────
//
router.get('/preferences', async (req, res, next) => {
  try {
    const clientId = getClientId(req);

    await query(
      `
      INSERT INTO client_notification_prefs (client_id)
      VALUES ($1)
      ON CONFLICT (client_id) DO NOTHING
      `,
      [clientId]
    );

    const result = await query(
      `
      SELECT
        client_id,
        email_enabled,
        sms_enabled,
        push_enabled,
        whatsapp_enabled,
        visit_notifs,
        payment_notifs,
        promo_notifs,
        updated_at
      FROM client_notification_prefs
      WHERE client_id = $1
      `,
      [clientId]
    );

    return res.json({
      success: true,
      data: result.rows[0] || null,
    });
  } catch (error) {
    next(error);
  }
});

//
// ──────────────────────────────────────────────────────────
// PATCH /client/notifications/preferences
// ──────────────────────────────────────────────────────────
//
router.patch(
  '/preferences',
  [
    body('email_enabled').optional().isBoolean(),
    body('sms_enabled').optional().isBoolean(),
    body('push_enabled').optional().isBoolean(),
    body('whatsapp_enabled').optional().isBoolean(),
    body('visit_notifs').optional().isBoolean(),
    body('payment_notifs').optional().isBoolean(),
    body('promo_notifs').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);

      await query(
        `
        INSERT INTO client_notification_prefs (client_id)
        VALUES ($1)
        ON CONFLICT (client_id) DO NOTHING
        `,
        [clientId]
      );

      const {
        email_enabled,
        sms_enabled,
        push_enabled,
        whatsapp_enabled,
        visit_notifs,
        payment_notifs,
        promo_notifs,
      } = req.body;

      const result = await query(
        `
        UPDATE client_notification_prefs
        SET
          email_enabled = COALESCE($2, email_enabled),
          sms_enabled = COALESCE($3, sms_enabled),
          push_enabled = COALESCE($4, push_enabled),
          whatsapp_enabled = COALESCE($5, whatsapp_enabled),
          visit_notifs = COALESCE($6, visit_notifs),
          payment_notifs = COALESCE($7, payment_notifs),
          promo_notifs = COALESCE($8, promo_notifs),
          updated_at = NOW()
        WHERE client_id = $1
        RETURNING
          client_id,
          email_enabled,
          sms_enabled,
          push_enabled,
          whatsapp_enabled,
          visit_notifs,
          payment_notifs,
          promo_notifs,
          updated_at
        `,
        [
          clientId,
          email_enabled ?? null,
          sms_enabled ?? null,
          push_enabled ?? null,
          whatsapp_enabled ?? null,
          visit_notifs ?? null,
          payment_notifs ?? null,
          promo_notifs ?? null,
        ]
      );

      return res.json({
        success: true,
        message: 'Préférences mises à jour',
        data: result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);

//
// ──────────────────────────────────────────────────────────
// POST /client/notifications/device-token
// ──────────────────────────────────────────────────────────
//
router.post(
  '/device-token',
  [
    body('token').isString().trim().notEmpty(),
    body('platform').isIn(['ios', 'android', 'web']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const { token, platform } = req.body;

      await query(
        `
        INSERT INTO client_device_tokens
          (client_id, token, platform, is_active, created_at, updated_at)
        VALUES
          ($1, $2, $3, TRUE, NOW(), NOW())
        ON CONFLICT (client_id, token)
        DO UPDATE SET
          platform = EXCLUDED.platform,
          is_active = TRUE,
          updated_at = NOW()
        `,
        [clientId, token, platform]
      );

      await query(
        `
        UPDATE clients
        SET push_token = $2
        WHERE id = $1
        `,
        [clientId, token]
      );

      return res.status(201).json({
        success: true,
        message: 'Device token enregistré',
      });
    } catch (error) {
      next(error);
    }
  }
);

//
// ──────────────────────────────────────────────────────────
// DELETE /client/notifications/device-token
// ──────────────────────────────────────────────────────────
//
router.delete(
  '/device-token',
  [body('token').isString().trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const { token } = req.body;

      await query(
        `
        UPDATE client_device_tokens
        SET
          is_active = FALSE,
          updated_at = NOW()
        WHERE client_id = $1
          AND token = $2
        `,
        [clientId, token]
      );

      await query(
        `
        UPDATE clients
        SET push_token = NULL
        WHERE id = $1
          AND push_token = $2
        `,
        [clientId, token]
      );

      return res.json({
        success: true,
        message: 'Device token désactivé',
      });
    } catch (error) {
      next(error);
    }
  }
);

//
// ──────────────────────────────────────────────────────────
// GET /client/notifications/device-tokens
// ──────────────────────────────────────────────────────────
//
router.get('/device-tokens', async (req, res, next) => {
  try {
    const clientId = getClientId(req);

    const result = await query(
      `
      SELECT
        id,
        token,
        platform,
        is_active,
        created_at,
        updated_at
      FROM client_device_tokens
      WHERE client_id = $1
      ORDER BY created_at DESC
      `,
      [clientId]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;