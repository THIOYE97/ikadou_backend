const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();

const { query } = require('../data/db');
const HttpError = require('../utils/httpError');
const { requireAuth, requireMinRole } = require('../middleware/requireAuth');

const ALLOWED_CODES = ['mobile_money', 'bank_transfer', 'cash'];

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
router.use(requireMinRole('finance'));

router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      `
        SELECT
          id,
          code,
          label,
          description,
          is_active,
          priority,
          country_code,
          currency,
          instructions_json,
          rules_json,
          created_at,
          updated_at
        FROM payment_method_configs
        ORDER BY priority ASC, label ASC
      `
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/:id',
  [param('id').isUUID().withMessage('id invalide')],
  validate,
  async (req, res, next) => {
    try {
      const result = await query(
        `
          SELECT
            id,
            code,
            label,
            description,
            is_active,
            priority,
            country_code,
            currency,
            instructions_json,
            rules_json,
            created_at,
            updated_at
          FROM payment_method_configs
          WHERE id = $1
          LIMIT 1
        `,
        [req.params.id]
      );

      if (!result.rows.length) {
        throw HttpError.notFound('Configuration de paiement introuvable');
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

router.post(
  '/',
  [
    body('code')
      .isIn(ALLOWED_CODES)
      .withMessage('Code invalide'),
    body('label')
      .trim()
      .notEmpty()
      .withMessage('Label requis'),
    body('description').optional().isString(),
    body('isActive').optional().isBoolean(),
    body('priority').optional().isInt({ min: 1, max: 9999 }),
    body('countryCode').optional().isString(),
    body('currency').optional().isString(),
    body('instructions').optional().isObject(),
    body('rules').optional().isObject(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const exists = await query(
        `
          SELECT id
          FROM payment_method_configs
          WHERE code = $1
            AND COALESCE(country_code, '') = COALESCE($2, '')
            AND currency = COALESCE($3, 'XOF')
          LIMIT 1
        `,
        [
          req.body.code,
          req.body.countryCode || null,
          req.body.currency || 'XOF',
        ]
      );

      if (exists.rows.length) {
        throw HttpError.conflict(
          'Une configuration existe déjà pour ce mode de paiement, pays et devise'
        );
      }

      const result = await query(
        `
          INSERT INTO payment_method_configs (
            code,
            label,
            description,
            is_active,
            priority,
            country_code,
            currency,
            instructions_json,
            rules_json
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
          RETURNING *
        `,
        [
          req.body.code,
          req.body.label,
          req.body.description || null,
          req.body.isActive ?? true,
          req.body.priority ?? 100,
          req.body.countryCode || null,
          req.body.currency || 'XOF',
          JSON.stringify(req.body.instructions || {}),
          JSON.stringify(req.body.rules || {}),
        ]
      );

      return res.status(201).json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  [
    param('id').isUUID().withMessage('id invalide'),
    body('label').optional().isString(),
    body('description').optional().isString(),
    body('isActive').optional().isBoolean(),
    body('priority').optional().isInt({ min: 1, max: 9999 }),
    body('countryCode').optional().isString(),
    body('currency').optional().isString(),
    body('instructions').optional().isObject(),
    body('rules').optional().isObject(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const existing = await query(
        `SELECT * FROM payment_method_configs WHERE id = $1 LIMIT 1`,
        [req.params.id]
      );

      if (!existing.rows.length) {
        throw HttpError.notFound('Configuration de paiement introuvable');
      }

      const result = await query(
        `
          UPDATE payment_method_configs
          SET
            label = COALESCE($2, label),
            description = COALESCE($3, description),
            is_active = COALESCE($4, is_active),
            priority = COALESCE($5, priority),
            country_code = COALESCE($6, country_code),
            currency = COALESCE($7, currency),
            instructions_json = COALESCE($8::jsonb, instructions_json),
            rules_json = COALESCE($9::jsonb, rules_json),
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          req.params.id,
          req.body.label ?? null,
          req.body.description ?? null,
          typeof req.body.isActive === 'boolean' ? req.body.isActive : null,
          req.body.priority ?? null,
          req.body.countryCode ?? null,
          req.body.currency ?? null,
          req.body.instructions ? JSON.stringify(req.body.instructions) : null,
          req.body.rules ? JSON.stringify(req.body.rules) : null,
        ]
      );

      return res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id/toggle',
  [
    param('id').isUUID().withMessage('id invalide'),
    body('isActive').isBoolean().withMessage('isActive requis'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await query(
        `
          UPDATE payment_method_configs
          SET
            is_active = $2,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [req.params.id, req.body.isActive]
      );

      if (!result.rows.length) {
        throw HttpError.notFound('Configuration de paiement introuvable');
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

module.exports = router;