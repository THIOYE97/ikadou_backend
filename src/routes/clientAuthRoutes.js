const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const clientAuthService = require('../services/clientAuthService');

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

router.post(
  '/register/init',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('phone').trim().notEmpty(),
    body('password').isLength({ min: 6 }),
    body('country').optional().trim(),
    body('city').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.registerInit(req.body);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/register/verify',
  [
    body('email').isEmail().normalizeEmail(),
    body('phone').trim().notEmpty(),
    body('emailCode').trim().isLength({ min: 4 }),
    body('phoneCode').trim().isLength({ min: 4 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.registerVerify(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/login',
  [
    body('login').trim().notEmpty(),
    body('password').trim().notEmpty(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.login(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/refresh',
  [body('refreshToken').trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.refresh(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/logout',
  [body('refreshToken').trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.logout(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;