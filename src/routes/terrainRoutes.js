const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth } = require('../middleware/requireAuth');
const terrainDomainService = require('../services/terrainDomainService');

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

router.get('/', async (req, res, next) => {
  try {
    const result = await terrainDomainService.listTerrains(req.query);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/',
  [
  body('ref').trim().notEmpty().withMessage('Référence requise'),
  body('title').trim().notEmpty().withMessage('Titre requis'),
  body('price').isNumeric().withMessage('Prix requis'),
  body('status').optional().isIn(['draft', 'published', 'reserved', 'sold', 'unavailable']),
  body('currency').optional().isIn(['XOF', 'EUR', 'USD']),

  body('latitude')
    .optional({ nullable: true })
    .isFloat({ min: -90, max: 90 })
    .withMessage('Latitude invalide'),

  body('longitude')
    .optional({ nullable: true })
    .isFloat({ min: -180, max: 180 })
    .withMessage('Longitude invalide'),

  body('environmentBenefits')
    .optional({ nullable: true })
    .isArray()
    .withMessage('environmentBenefits doit être un tableau'),

  body('trustItems')
    .optional({ nullable: true })
    .isArray()
    .withMessage('trustItems doit être un tableau'),

  body('agencyName')
    .optional({ nullable: true })
    .isString()
    .withMessage('agencyName invalide'),

  body('notaryName')
    .optional({ nullable: true })
    .isString()
    .withMessage('notaryName invalide'),

  body('notaryPhone')
    .optional({ nullable: true })
    .isString()
    .withMessage('notaryPhone invalide'),

  body('ninacad')
    .optional({ nullable: true })
    .isString()
    .withMessage('ninacad invalide'),
  body('catalogTags').optional({ nullable: true }).isArray().withMessage('catalogTags doit être un tableau'),
  body('terrainUse').optional({ nullable: true }).isString().withMessage('terrainUse invalide'),
  body('catalogBucket').optional({ nullable: true }).isString().withMessage('catalogBucket invalide'),
  body('displayInDiscovery').optional({ nullable: true }).isBoolean().withMessage('displayInDiscovery invalide'),
],
  validate,
  async (req, res, next) => {
    try {
      const data = await terrainDomainService.createTerrain({
        ...req.body,
        userId: req.user.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/:id', async (req, res, next) => {
  try {
    const data = await terrainDomainService.getTerrainDetail(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.patch(
  '/:id',
  [
  body('status').optional().isIn(['draft', 'published', 'reserved', 'sold', 'unavailable']),
  body('currency').optional().isIn(['XOF', 'EUR', 'USD']),

  body('latitude')
    .optional({ nullable: true })
    .isFloat({ min: -90, max: 90 })
    .withMessage('Latitude invalide'),

  body('longitude')
    .optional({ nullable: true })
    .isFloat({ min: -180, max: 180 })
    .withMessage('Longitude invalide'),

  body('environmentBenefits')
    .optional({ nullable: true })
    .isArray()
    .withMessage('environmentBenefits doit être un tableau'),

  body('trustItems')
    .optional({ nullable: true })
    .isArray()
    .withMessage('trustItems doit être un tableau'),

  body('agencyName')
    .optional({ nullable: true })
    .isString()
    .withMessage('agencyName invalide'),

  body('notaryName')
    .optional({ nullable: true })
    .isString()
    .withMessage('notaryName invalide'),

  body('notaryPhone')
    .optional({ nullable: true })
    .isString()
    .withMessage('notaryPhone invalide'),

  body('ninacad')
    .optional({ nullable: true })
    .isString()
    .withMessage('ninacad invalide'),
  body('catalogTags').optional({ nullable: true }).isArray().withMessage('catalogTags doit être un tableau'),
  body('terrainUse').optional({ nullable: true }).isString().withMessage('terrainUse invalide'),
  body('catalogBucket').optional({ nullable: true }).isString().withMessage('catalogBucket invalide'),
  body('displayInDiscovery').optional({ nullable: true }).isBoolean().withMessage('displayInDiscovery invalide'),
],
  validate,
  async (req, res, next) => {
    try {
      const data = await terrainDomainService.updateTerrain(
        req.params.id,
        req.body,
        req.user.id
      );
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id/status',
  [
    body('status').isIn(['draft', 'published', 'reserved', 'sold', 'unavailable']),
    body('reason').optional().trim(),
    body('comment').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await terrainDomainService.changeTerrainStatus({
        terrainId: req.params.id,
        status: req.body.status,
        reason: req.body.reason || req.body.comment || null,
        userId: req.user.id,
        userRole: req.user.role,
      });
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;