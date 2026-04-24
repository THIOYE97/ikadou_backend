const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const HttpError = require('../utils/httpError');
const { memoryUpload, saveImage } = require('../services/ImageService');
const { requireAuth, requireMinRole } = require('../middleware/requireAuth');
const ticketDomainService = require('../services/ticketDomainService');

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
    const result = await ticketDomainService.listTickets(req.query);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/',
  [
    body('subject').trim().notEmpty(),
    body('priority').isIn(['low', 'medium', 'high', 'urgent']),
    body('clientId').optional().isUUID(),
    body('description').optional().trim(),
    body('assignedTo').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { subject, description, priority, clientId, assignedTo } = req.body;

      const data = await ticketDomainService.createTicket({
        subject,
        description: description || null,
        priority,
        clientId: clientId || null,
        assignedTo: assignedTo || null,
        userId: req.user.id,
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/assignable-support-users', requireMinRole('manager'), async (req, res, next) => {
  try {
    const data = await ticketDomainService.getAssignableSupportUsers();
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await ticketDomainService.getTicketDetail(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.patch(
  '/:id/status',
  [
    body('status').isIn(['open', 'in_progress', 'waiting_client', 'resolved', 'closed']),
    body('comment').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, comment } = req.body;

      const data = await ticketDomainService.changeTicketStatus({
        ticketId: req.params.id,
        status,
        comment: comment || null,
        userId: req.user.id,
      });

      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id/assign',
  requireMinRole('manager'),
  [body('assignedTo').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const data = await ticketDomainService.assignTicket({
        ticketId: req.params.id,
        assignedTo: req.body.assignedTo,
        userId: req.user.id,
      });

      return res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/messages',
  [
    body('content').optional().isString().trim(),
    body('message').optional().isString().trim(),
    body('isInternal').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const content = (req.body.content ?? req.body.message ?? '').trim();

      if (!content) {
        throw HttpError.badRequest('Le contenu du message est requis');
      }

      const data = await ticketDomainService.addTicketMessage({
        ticketId: req.params.id,
        message: content,
        userId: req.user.id,
        isInternal: req.body.isInternal === true,
      });

      return res.status(201).json({
        success: true,
        data,
      });
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
      const files = req.files || [];

      if (!files.length) {
        throw HttpError.badRequest('Aucun fichier fourni');
      }

      const created = [];

      for (const file of files) {
        const uploaded = await saveImage(file.buffer, 'default', `support/${req.params.id}`);

        const row = await ticketDomainService.addTicketAttachment({
          ticketId: req.params.id,
          userId: req.user.id,
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