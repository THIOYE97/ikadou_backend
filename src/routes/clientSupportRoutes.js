const express = require('express');
const { body, query: q, validationResult } = require('express-validator');
const router = express.Router();

const HttpError = require('../utils/httpError');
const { memoryUpload, saveImage } = require('../services/ImageService');
const clientSupportService = require('../services/clientSupportService');
const requireClientAuth = require('../middleware/requireClientAuth');

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
  '/tickets',
  [
    q('status').optional().isString(),
    q('page').optional().isInt({ min: 1 }),
    q('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientSupportService.listClientTickets({
        clientId: getClientId(req),
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
      });

      return res.json({ success: true, ...data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/tickets',
  [
    body('subject').trim().notEmpty(),
    body('description').optional().trim(),
    body('category').optional().isIn(['bug', 'payment', 'account', 'terrain', 'visit', 'other']),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientSupportService.createClientTicket({
        clientId: getClientId(req),
        subject: req.body.subject,
        description: req.body.description || req.body.subject,
        category: req.body.category || 'other',
        priority: req.body.priority || 'medium',
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/:id', async (req, res, next) => {
  try {
    const data = await clientSupportService.getClientTicketDetail(
      req.params.id,
      getClientId(req)
    );
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:id/messages',
  [body('message').trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const data = await clientSupportService.addClientTicketMessage({
        ticketId: req.params.id,
        clientId: getClientId(req),
        message: req.body.message,
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/attachments',
  memoryUpload.array('files', 5),
  async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      const files = req.files || [];

      if (!files.length) {
        throw HttpError.badRequest('Aucun fichier fourni');
      }

      const created = [];
      for (const file of files) {
        const uploaded = await saveImage(file.buffer, 'default', `support/${req.params.id}`);

        const row = await clientSupportService.addClientTicketAttachment({
          ticketId: req.params.id,
          clientId,
          messageId: req.body.messageId ? String(req.body.messageId).trim() : null,
          fileUrl: uploaded.url,
          fileStorageKey: uploaded.storageKey,
          fileType: uploaded.format || file.mimetype,
          sizeBytes: uploaded.sizeBytes || file.size,
        });

        created.push(row);
      }

      return res.status(201).json({ success: true, data: created });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;