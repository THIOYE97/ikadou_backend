const express = require('express');
const router = express.Router();

const { requireAuth, requireMinRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const {
  memoryUpload,
  memoryUploadDocuments,
} = require('../services/ImageService');
const terrainDomainService = require('../services/terrainDomainService');

router.use(requireAuth);

// ─── Images ───────────────────────────────────────────────

router.post(
  '/:id/images',
  requireMinRole('sales'),
  memoryUpload.array('images', 10),
  async (req, res, next) => {
    try {
      const data = await terrainDomainService.addTerrainImages({
        terrainId: req.params.id,
        files: req.files,
        userId: req.user.id,
      });

      return res.status(201).json({
        success: true,
        message: `${data.uploaded.length} image(s) uploadée(s) et compressée(s) en WebP`,
        data,
      });
    } catch (error) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(
          HttpError.badRequest(
            `Fichier trop volumineux. Limite: ${process.env.UPLOAD_MAX_SIZE_MB || 10} MB`
          )
        );
      }
      next(error);
    }
  }
);

router.get('/:id/images', async (req, res, next) => {
  try {
    const data = await terrainDomainService.getTerrainImages(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/images/reorder', async (req, res, next) => {
  try {
    const data = await terrainDomainService.reorderTerrainImages({
      terrainId: req.params.id,
      orderedUrls: req.body.orderedUrls,
      userId: req.user.id,
    });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/images', requireMinRole('sales'), async (req, res, next) => {
  try {
    const data = await terrainDomainService.deleteTerrainImage({
      terrainId: req.params.id,
      storageKey: req.body.storageKey,
      userId: req.user.id,
    });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/images/main', requireMinRole('sales'), async (req, res, next) => {
  try {
    const data = await terrainDomainService.setTerrainMainImage({
      terrainId: req.params.id,
      storageKey: req.body.storageKey,
      userId: req.user.id,
    });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── Documents ────────────────────────────────────────────

router.post(
  '/:id/documents',
  requireMinRole('sales'),
  memoryUploadDocuments.array('documents', 10),
  async (req, res, next) => {
    try {
      const data = await terrainDomainService.addTerrainDocuments({
        terrainId: req.params.id,
        files: req.files,
        userId: req.user.id,
      });

      return res.status(201).json({
        success: true,
        message: `${data.uploaded.length} document(s) uploadé(s) sur Cloudinary`,
        data,
      });
    } catch (error) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(
          HttpError.badRequest(
            `Fichier trop volumineux. Limite: ${process.env.UPLOAD_MAX_SIZE_MB || 10} MB`
          )
        );
      }
      next(error);
    }
  }
);

router.get('/:id/documents', async (req, res, next) => {
  try {
    const data = await terrainDomainService.getTerrainDocuments(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/documents/:documentId', requireMinRole('sales'), async (req, res, next) => {
  try {
    const data = await terrainDomainService.deleteTerrainDocument({
      terrainId: req.params.id,
      documentId: req.params.documentId,
      userId: req.user.id,
    });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;