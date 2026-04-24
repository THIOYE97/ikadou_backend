const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const logger = require('../utils/logger');
const notif = require('../services/notificationService');
const paymentProofReviewService = require('../services/paymentProofReviewService');
const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const { requireAuth, requireRole, requireMinRole } = require('../middleware/requireAuth');
const danaPay = require('../services/danaPayService');
const paymentDomainService = require('../services/paymentDomainService');
const { STATUS_TRANSITIONS, PAYMENT_SELECT } = paymentDomainService;


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

router.get('/stats', requireMinRole('finance'), async (req, res, next) => {
  try {
    const data = await paymentDomainService.getPaymentStats(req.query);
    return res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/installment',
  requireMinRole('finance'),
  [
    body('clientId').isUUID().withMessage('Client invalide'),
    body('terrainId').isUUID().withMessage('Terrain invalide'),
    body('totalAmountXof').isNumeric().withMessage('Montant total requis'),
    body('installments').isArray({ min: 2, max: 24 }).withMessage('Minimum 2 échéances, maximum 24'),
    body('installments.*.amountXof').isNumeric().withMessage('Montant par échéance invalide'),
    body('installments.*.dueDate').isDate().withMessage('Date d\'échéance invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await paymentDomainService.createInstallmentPlan({
        ...req.body,
        userId: req.user.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);

router.get('/operators/:countryCode', (req, res) => {
  const operators = danaPay.getOperatorsByCountry(req.params.countryCode);
  return res.json({ success: true, data: operators });
});

router.get('/', requireMinRole('finance'), async (req, res, next) => {
  try {
    const result = await paymentDomainService.listPayments(req.query);
    return res.json({ success: true, ...result });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/stripe/intent',
  [
    body('clientId').isUUID().withMessage('Client invalide'),
    body('terrainId').isUUID().withMessage('Terrain invalide'),
    body('amountXof').isNumeric().isFloat({ min: 100 }).withMessage('Montant invalide (min 100 XOF)'),
    body('currency').optional().isIn(['eur', 'usd']).withMessage('Devise invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await paymentDomainService.createStripeIntentPayment({
        ...req.body,
        userId: req.user.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/stripe/checkout',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric().isFloat({ min: 100 }),
    body('currency').optional().isIn(['eur', 'usd']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await paymentDomainService.createStripeCheckoutPayment({
        ...req.body,
        userId: req.user.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/danapay/transfer',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric().isFloat({ min: 500 }).withMessage('Montant minimum 500 XOF'),
    body('phone').notEmpty().withMessage('Numéro de téléphone requis'),
    body('operator').isIn(['orange_money', 'wave', 'free_money', 'moov_money', 'mtn_momo'])
      .withMessage('Opérateur Mobile Money invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await paymentDomainService.createDanaPayTransferPayment({
        ...req.body,
        userId: req.user.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/danapay/link',
  [
    body('clientId').isUUID(),
    body('terrainId').isUUID(),
    body('amountXof').isNumeric().isFloat({ min: 500 }).withMessage('Montant minimum 500 XOF'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await paymentDomainService.createDanaPayLinkPayment({
        ...req.body,
        userId: req.user.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);

router.get('/:id', requireMinRole('finance'), async (req, res, next) => {
  try {
    const data = await paymentDomainService.getPaymentDetail(req.params.id);
    return res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/sync', requireMinRole('finance'), async (req, res, next) => {
  try {
    const result = await paymentDomainService.syncPaymentStatus({
      paymentId: req.params.id,
      userId: req.user.id,
    });

    return res.json({
      success: true,
      data: result.payment,
      synced: result.synced,
      message: result.message,
    });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/:id/refund',
  requireRole('admin', 'super_admin', 'manager'),
  [
    body('reason').optional().trim().notEmpty(),
    body('amountXof').optional().isNumeric().isFloat({ min: 1 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await paymentDomainService.refundPayment({
        paymentId: req.params.id,
        reason: req.body.reason,
        amountXof: req.body.amountXof,
        userId: req.user.id,
      });
      return res.json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);
router.patch('/:id/status',
  requireMinRole('finance'),
  [
    body('status').isIn(['pending','confirmed','failed','refunded','partial','cancelled'])
      .withMessage('Statut invalide'),
    body('comment').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, comment } = req.body;

      const pr = await query(`SELECT status FROM payments WHERE id = $1`, [req.params.id]);
      if (!pr.rows.length) throw HttpError.notFound('Paiement introuvable');

      const oldStatus = pr.rows[0].status;
      const allowed   = STATUS_TRANSITIONS[oldStatus] || [];

      if (!allowed.includes(status)) {
        throw HttpError.badRequest(
          `Transition "${oldStatus}" → "${status}" non autorisée.` +
          (allowed.length ? ` Autorisées : ${allowed.join(', ')}` : ' Aucune transition possible.')
        );
      }

      // Sensitive transitions require manager+
      if (['confirmed','refunded'].includes(status)) {
        const roleLevel = { super_admin:7, admin:6, manager:5, finance:4, sales:3, support:3, agent:2 };
        if ((roleLevel[req.user.role] || 0) < 5) {
          throw HttpError.forbidden(`Le rôle "${req.user.role}" ne peut pas effectuer cette transition`);
        }
      }

      await transaction(async (client) => {
        await client.query(`UPDATE payments SET status = $1 WHERE id = $2`, [status, req.params.id]);
        await client.query(
          `INSERT INTO payment_history (payment_id, action, old_status, new_status, comment, user_id)
           VALUES ($1, 'manual_override', $2, $3, $4, $5)`,
          [req.params.id, oldStatus, status, comment || null, req.user.id]
        );
      });

      // Notify on manual confirmation
      const payment = await query(`SELECT * FROM payments WHERE id = $1`, [req.params.id]);
const [clientRes, terrainRes] = await Promise.all([
  query(`SELECT * FROM clients WHERE id = $1`, [payment.rows[0].client_id]),
  query(`SELECT title FROM terrains WHERE id = $1`, [payment.rows[0].terrain_id]),
]);

if (clientRes.rows.length) {
  const client = clientRes.rows[0];
  const terrain = terrainRes.rows[0] || {};

  if (status === 'confirmed') {
    notif.notifyPaymentConfirmed({
      client,
      payment: { ...payment.rows[0], status: 'confirmed' },
      terrain,
      sentBy: req.user.id,
    }).catch(err => logger.warn(`[Payment] Confirmed notif failed: ${err.message}`));
  }

  if (status === 'failed' || status === 'cancelled') {
    notif.notifyPaymentFailed({
      client,
      payment: { ...payment.rows[0], status },
      terrain,
      sentBy: req.user.id,
    }).catch(err => logger.warn(`[Payment] Failed notif failed: ${err.message}`));
  }

  if (status === 'pending') {
    notif.notifyPaymentPending({
      client,
      payment: { ...payment.rows[0], status },
      terrain,
      sentBy: req.user.id,
    }).catch(err => logger.warn(`[Payment] Pending notif failed: ${err.message}`));
  }
}

      const updated = await query(
        `${PAYMENT_SELECT} WHERE p.id = $1`,
        [req.params.id]
      );

      return res.json({ success: true, data: updated.rows[0] });
    } catch (e) { next(e); }
  }
);
router.get(
  '/:id/proofs',
  requireMinRole('finance'),
  async (req, res, next) => {
    try {
      const data = await paymentProofReviewService.listPaymentProofsForReview({
        paymentId: req.params.id,
      });

      return res.json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);

router.patch(
  '/proofs/:proofId/review',
  requireMinRole('finance'),
  [
    body('status')
      .isIn(['under_review', 'approved', 'rejected'])
      .withMessage('Statut de review invalide'),
    body('reviewNote').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await paymentProofReviewService.reviewPaymentProof({
        proofId: req.params.proofId,
        status: req.body.status,
        reviewNote: req.body.reviewNote || null,
        userId: req.user.id,
      });

      return res.json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);
module.exports = router;