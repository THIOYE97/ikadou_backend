const express = require('express');
const { body, query: q, param, validationResult } = require('express-validator');
const router = express.Router();

const { query } = require('../data/db');
const HttpError = require('../utils/httpError');
const publicCatalogService = require('../services/publicCatalogService');

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

router.get('/onboarding', async (req, res, next) => {
  try {
    return res.json({
      success: true,
      data: {
        version: '1',
        canSkip: true,
        screens: [
          {
            id: 'discover',
            title: 'Découvrez des terrains simplement',
            description:
              'Parcourez rapidement les opportunités disponibles selon votre budget et votre zone.',
          },
          {
            id: 'trust',
            title: 'Consultez des fiches rassurantes',
            description:
              'Photos, prix, surface, disponibilité et informations utiles pour décider sereinement.',
          },
          {
            id: 'action',
            title: 'Passez à l’action au bon moment',
            description:
              'Créez un compte pour contacter, suivre vos demandes et planifier une visite.',
          },
        ],
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/zones', async (req, res, next) => {
  try {
    const data = await publicCatalogService.listPublicZones();
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/filters', async (req, res, next) => {
  try {
    const data = await publicCatalogService.listPublicFilterOptions();
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/terrains',
  [
    q('page').optional().isInt({ min: 1 }),
    q('limit').optional().isInt({ min: 1, max: 100 }),
    q('min_price').optional().isNumeric(),
    q('max_price').optional().isNumeric(),
    q('min_surface').optional().isNumeric(),
    q('max_surface').optional().isNumeric(),
    q('search').optional().isString(),
    q('location').optional().isString(),
    q('zone_id').optional().isUUID(),
    q('sort').optional().isIn(['created_at', 'price', 'surface_m2', 'title', 'ref']),
    q('order').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await publicCatalogService.listTerrains(req.query);
      return res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/terrains/map',
  [
    q('min_price').optional().isNumeric(),
    q('max_price').optional().isNumeric(),
    q('min_surface').optional().isNumeric(),
    q('max_surface').optional().isNumeric(),
    q('search').optional().isString(),
    q('location').optional().isString(),
    q('zone_id').optional().isUUID(),
    q('limit').optional().isInt({ min: 1, max: 500 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await publicCatalogService.listMapTerrains(req.query);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/terrains/:id',
  [param('id').isUUID().withMessage('ID terrain invalide')],
  validate,
  async (req, res, next) => {
    try {
      const data = await publicCatalogService.getTerrainById(req.params.id);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/terrains/:id/visit-policy',
  [param('id').isUUID().withMessage('ID terrain invalide')],
  validate,
  async (req, res, next) => {
    try {
      return res.json({
        success: true,
        data: {
          requiresAccount: true,
          message: 'Créez un compte pour planifier une visite.',
          ctaLabel: 'Créer un compte',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/leads',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('phone').trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('terrainId').optional().isUUID(),
    body('message').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { firstName, lastName, phone, email, terrainId, message } = req.body;

      const existing = await query(
        `SELECT *
         FROM leads
         WHERE ($1::varchar IS NOT NULL AND LOWER(email) = LOWER($1))
            OR phone = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [email || null, phone]
      );

      let lead;

      if (existing.rows.length) {
        const updated = await query(
          `UPDATE leads
           SET first_name = $2,
               last_name = $3,
               email = COALESCE($4, email),
               phone = COALESCE($5, phone),
               terrain_id = COALESCE($6, terrain_id),
               message = COALESCE($7, message),
               source = 'mobile_app',
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            existing.rows[0].id,
            firstName,
            lastName,
            email || null,
            phone,
            terrainId || null,
            message || null,
          ]
        );
        lead = updated.rows[0];
      } else {
        const inserted = await query(
          `INSERT INTO leads
            (first_name, last_name, email, phone, source, status, terrain_id, message)
           VALUES ($1, $2, $3, $4, 'mobile_app', 'new', $5, $6)
           RETURNING *`,
          [firstName, lastName, email || null, phone, terrainId || null, message || null]
        );
        lead = inserted.rows[0];
      }

      return res.status(201).json({
        success: true,
        data: {
          id: lead.id,
          status: lead.status,
          message: 'Votre demande a bien été enregistrée.',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/terrains/:id/contact',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('phone').trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('message').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const terrainCheck = await query(
        `SELECT id
         FROM terrains
         WHERE id = $1
           AND status = 'published'`,
        [req.params.id]
      );

      if (!terrainCheck.rows.length) {
        throw HttpError.notFound('Terrain introuvable');
      }

      const existing = await query(
        `SELECT *
         FROM leads
         WHERE ($1::varchar IS NOT NULL AND LOWER(email) = LOWER($1))
            OR phone = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [req.body.email || null, req.body.phone]
      );

      let lead;

      if (existing.rows.length) {
        const updated = await query(
          `UPDATE leads
           SET first_name = $2,
               last_name = $3,
               email = COALESCE($4, email),
               phone = COALESCE($5, phone),
               terrain_id = $6,
               message = COALESCE($7, message),
               source = 'mobile_app',
               source_detail = 'terrain_contact',
               last_contact_at = NOW(),
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            existing.rows[0].id,
            req.body.firstName,
            req.body.lastName,
            req.body.email || null,
            req.body.phone,
            req.params.id,
            req.body.message || null,
          ]
        );
        lead = updated.rows[0];
      } else {
        const inserted = await query(
          `INSERT INTO leads
            (
              first_name,
              last_name,
              email,
              phone,
              source,
              source_detail,
              status,
              terrain_id,
              message,
              last_contact_at
            )
           VALUES ($1, $2, $3, $4, 'mobile_app', 'terrain_contact', 'new', $5, $6, NOW())
           RETURNING *`,
          [
            req.body.firstName,
            req.body.lastName,
            req.body.email || null,
            req.body.phone,
            req.params.id,
            req.body.message || null,
          ]
        );
        lead = inserted.rows[0];
      }

      return res.status(201).json({
        success: true,
        data: {
          id: lead.id,
          status: lead.status,
          message: 'Votre demande de contact a bien été enregistrée.',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);
module.exports = router;