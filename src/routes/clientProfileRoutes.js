const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const requireClientAuth = require('../middleware/requireClientAuth');
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

router.use(requireClientAuth);

// ─── GET /client/profile/me ───────────────────────────────

router.get('/me', async (req, res, next) => {
  try {
    const data = await clientDomainService.getClientProfile(req.client.id);
    return res.json({ success: true, data });
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
      const data = await clientDomainService.updateClientProfile(req.client.id, req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /client/profile/app-state ────────────────────────

router.get('/app-state', async (req, res, next) => {
  try {
    const data = await clientDomainService.getClientAppState(req.client.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── POST /client/profile/app-state/onboarding-complete ───

router.post('/app-state/onboarding-complete', async (req, res, next) => {
  try {
    const data = await clientDomainService.completeClientOnboarding(
      req.client.id,
      req.body?.version || null
    );
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── GET /client/profile/notification-prefs ───────────────

router.get('/notification-prefs', async (req, res, next) => {
  try {
    const data = await clientDomainService.getClientNotificationPrefs(req.client.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /client/profile/notification-prefs ─────────────

router.patch('/notification-prefs', async (req, res, next) => {
  try {
    const data = await clientDomainService.updateClientNotificationPrefs(req.client.id, req.body);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;