const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const clientAuthService = require('../services/clientAuthService');
const clientRegistrationService = require('../services/clientRegistrationService');

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

// ───────────────────────────────────────────────────────────
// REGISTER INIT — EMAIL
// Creates a temporary registration session only
// No final client/account row is created yet
// ───────────────────────────────────────────────────────────
router.post(
  '/register/email/init',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('country').optional().trim(),
    body('city').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientRegistrationService.registerEmailInit(req.body);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// REGISTER INIT — PHONE
// Creates a temporary registration session only
// No final client/account row is created yet
// ───────────────────────────────────────────────────────────
router.post(
  '/register/phone/init',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('phone').trim().notEmpty(),
    body('channel').isIn(['sms', 'whatsapp']),
    body('country').optional().trim(),
    body('city').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientRegistrationService.registerPhoneInit(req.body);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// REGISTER RESEND OTP
// Can resend on same or another allowed channel
// ───────────────────────────────────────────────────────────
router.post(
  '/register/resend',
  [
    body('registrationSessionId').trim().notEmpty(),
    body('channel').optional().isIn(['email', 'sms', 'whatsapp']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientRegistrationService.registerResend(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// REGISTER VERIFY
// Final account creation happens ONLY here after OTP validation
// ───────────────────────────────────────────────────────────
router.post(
  '/register/verify',
  [
    body('registrationSessionId').trim().notEmpty(),
    body('code').trim().isLength({ min: 4 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientRegistrationService.registerVerify(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// LOGIN — EMAIL
// ───────────────────────────────────────────────────────────
router.post(
  '/login/email',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').trim().notEmpty(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.loginEmail(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// LOGIN — PHONE REQUEST OTP
// ───────────────────────────────────────────────────────────
router.post(
  '/login/phone/request-code',
  [
    body('phone').trim().notEmpty(),
    body('channel').isIn(['sms', 'whatsapp']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.loginPhoneRequestCode(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// LOGIN — PHONE VERIFY OTP
// ───────────────────────────────────────────────────────────
router.post(
  '/login/phone/verify-code',
  [
    body('phone').trim().notEmpty(),
    body('code').trim().isLength({ min: 4 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.loginPhoneVerifyCode(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// LOGIN STEP-UP VERIFY
// ───────────────────────────────────────────────────────────
router.post(
  '/login/verify',
  [
    body('target').trim().notEmpty(),
    body('code').trim().isLength({ min: 4 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.verifyLoginOtp(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// FORGOT PASSWORD
// ───────────────────────────────────────────────────────────
router.post(
  '/password/forgot',
  [body('email').isEmail().normalizeEmail()],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.forgotPassword(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// RESET PASSWORD
// ───────────────────────────────────────────────────────────
router.post(
  '/password/reset',
  [
    body('email').isEmail().normalizeEmail(),
    body('code').trim().isLength({ min: 4 }),
    body('newPassword').isLength({ min: 6 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientAuthService.resetPassword(req.body);
      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ───────────────────────────────────────────────────────────
// REFRESH
// ───────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────
// LOGOUT
// ───────────────────────────────────────────────────────────
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