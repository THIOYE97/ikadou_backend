const express = require('express');
const { body, query: q, validationResult } = require('express-validator');
const router = express.Router();

const HttpError = require('../utils/httpError');
const requireClientAuth = require('../middleware/requireClientAuth');
const { memoryUpload, saveImage } = require('../services/ImageService');
const clientPaymentProofService = require('../services/clientPaymentProofService');

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

function getClientId(req) {
  const clientId = req.client?.id;
  if (!clientId) throw HttpError.unauthorized('Client non authentifié');
  return clientId;
}

router.get(
  '/options',
  [
    q('terrainId').optional().isUUID().withMessage('terrainId invalide'),
    q('projectId').optional().isUUID().withMessage('projectId invalide'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientPaymentProofService.getClientPaymentOptions({
        clientId: getClientId(req),
        terrainId: req.query.terrainId || null,
        projectId: req.query.projectId || null,
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
    body('terrainId').isUUID().withMessage('terrainId invalide'),
    body('projectId').optional().isUUID().withMessage('projectId invalide'),
    body('amount').isNumeric().withMessage('Montant invalide'),
    body('reason')
      .optional()
      .isIn(['reservation', 'installment', 'balance', 'other'])
      .withMessage('Motif invalide'),
    body('paymentMethod')
      .notEmpty()
      .withMessage('Mode de paiement requis')
      .isIn(['mobile_money', 'bank_transfer', 'cash'])
      .withMessage('Mode de paiement invalide'),
    body('note').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientPaymentProofService.createClientPaymentRequest({
        clientId: getClientId(req),
        terrainId: req.body.terrainId,
        projectId: req.body.projectId || null,
        amount: Number(req.body.amount),
        reason: req.body.reason || 'other',
        paymentMethod: req.body.paymentMethod,
        note: req.body.note || null,
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/',
  [
    q('page').optional().isInt({ min: 1 }),
    q('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientPaymentProofService.listClientPayments({
        clientId: getClientId(req),
        page: req.query.page,
        limit: req.query.limit,
      });

      return res.json({ success: true, ...data });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/:paymentId/reference', async (req, res, next) => {
  try {
    const data = await clientPaymentProofService.getClientPaymentReference(
      req.params.paymentId,
      getClientId(req)
    );

    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/:paymentId/proofs', async (req, res, next) => {
  try {
    const data = await clientPaymentProofService.listPaymentProofs(
      req.params.paymentId,
      getClientId(req)
    );

    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:paymentId/proofs',
  memoryUpload.array('files', 5),
  [body('note').optional().trim()],
  validate,
  async (req, res, next) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        throw HttpError.badRequest('Au moins une preuve est requise');
      }

      const uploadedFiles = [];
      for (const file of files) {
        const uploaded = await saveImage(
          file.buffer,
          'default',
          `payment-proofs/${req.params.paymentId}`
        );

        uploadedFiles.push({
          url: uploaded.url,
          storageKey: uploaded.storageKey,
          fileType: uploaded.format || file.mimetype,
          sizeBytes: uploaded.sizeBytes || file.size,
        });
      }

      const data = await clientPaymentProofService.createPaymentProof({
        paymentId: req.params.paymentId,
        clientId: getClientId(req),
        note: req.body.note || null,
        files: uploadedFiles,
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;