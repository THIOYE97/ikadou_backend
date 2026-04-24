const express = require('express');
const { body, query: q, validationResult } = require('express-validator');
const router = express.Router();

const requireClientAuth = require('../middleware/requireClientAuth');
const visitDomainService = require('../services/visitDomainService');

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

router.get('/', async (req, res, next) => {
  try {
    const data = await visitDomainService.getClientVisits(req.client.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await visitDomainService.getClientVisitDetail(req.params.id, req.client.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/slots/search',
  [
    q('date').isDate().withMessage('date invalide'),
    q('terrainId').optional().isUUID().withMessage('terrainId invalide'),
    q('projectId').optional().isUUID().withMessage('projectId invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { terrainId, projectId, date } = req.query;

      if (!terrainId && !projectId) {
        return res.status(400).json({
          success: false,
          message: 'Veuillez fournir un terrain ou un projet pour rechercher les créneaux.',
        });
      }

      const data = await visitDomainService.searchClientSlots({
        terrainId: terrainId || null,
        projectId: projectId || null,
        clientId: req.client.id,
        date,
      });

      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  [
    body('visitDate').isDate().withMessage('visitDate invalide'),
    body('visitTime').matches(/^\d{2}:\d{2}$/).withMessage('visitTime invalide'),
    body('terrainId').optional().isUUID().withMessage('terrainId invalide'),
    body('projectId').optional().isUUID().withMessage('projectId invalide'),
    body('notes').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { terrainId, projectId, visitDate, visitTime, notes } = req.body;

      if (!terrainId && !projectId) {
        return res.status(400).json({
          success: false,
          message: 'Vous devez fournir un terrain ou un projet pour réserver une visite.',
        });
      }

      const data = await visitDomainService.createClientVisit({
        terrainId: terrainId || null,
        projectId: projectId || null,
        visitDate,
        visitTime,
        clientId: req.client.id,
        notes: notes || null,
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id/reschedule',
  [
    body('visitDate').isDate().withMessage('visitDate invalide'),
    body('visitTime').matches(/^\d{2}:\d{2}$/).withMessage('visitTime invalide'),
    body('reason').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { visitDate, visitTime, reason } = req.body;
      const data = await visitDomainService.rescheduleClientVisit({
        visitId: req.params.id,
        clientId: req.client.id,
        visitDate,
        visitTime,
        reason: reason || null,
      });

      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id/cancel',
  [body('reason').optional().trim()],
  validate,
  async (req, res, next) => {
    try {
      const data = await visitDomainService.cancelClientVisit({
        visitId: req.params.id,
        clientId: req.client.id,
        reason: req.body.reason || null,
      });

      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;