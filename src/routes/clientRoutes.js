const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole } = require('../middleware/requireAuth');
const clientDomainService = require('../services/clientDomainService');

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
    const result = await clientDomainService.listClients(req.query);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
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
      const data = await clientDomainService.createClient({
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        email: req.body.email || null,
        phone: req.body.phone || null,
        country: req.body.country || null,
        city: req.body.city || null,
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /clients/:id — 360 view ──────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const data = await clientDomainService.getClient360(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /clients/:id ───────────────────────────────────

router.patch('/:id', validate, async (req, res, next) => {
  try {
    const data = await clientDomainService.updateClient(req.params.id, req.body);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
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
      const data = await clientDomainService.changeClientStatus({
        clientId: req.params.id,
        status: req.body.status,
        reason: req.body.reason || null,
        userId: req.user.id,
      });

      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;