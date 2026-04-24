const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth } = require('../middleware/requireAuth');
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

router.use(requireAuth);

router.post(
  '/',
  [
    body('terrainId').isUUID(),
    body('visitDate').isDate(),
    body('visitTime').matches(/^\d{2}:\d{2}$/),
    body('agentId').optional().isUUID(),
    body('clientId').optional().isUUID(),
    body('leadId').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { terrainId, visitDate, visitTime, agentId, clientId, leadId, notes } = req.body;
      const visit = await visitDomainService.createVisit({
        terrainId,
        visitDate,
        visitTime,
        agentId: agentId || null,
        clientId: clientId || null,
        leadId: leadId || null,
        notes: notes || null,
        createdBy: req.user.id,
        source: 'backoffice',
      });

      return res.status(201).json({ success: true, data: visit });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/', async (req, res, next) => {
  try {
    const result = await visitDomainService.listVisits(req.query);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await visitDomainService.getVisitDetail(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.patch(
  '/:id/status',
  [
    body('status').isIn(['scheduled', 'confirmed', 'done', 'cancelled', 'rescheduled', 'no_show']),
    body('reason').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, reason } = req.body;
      const data = await visitDomainService.changeVisitStatus({
        visitId: req.params.id,
        status,
        reason: reason || null,
        userId: req.user.id,
      });

      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;