const express = require('express');
const { body, validationResult } = require('express-validator');
const path = require('path');
const router = express.Router();

const { requireAuth } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { query } = require('../data/db');
const { memoryUpload, saveImage, deleteImage, UPLOAD_DIR } = require('../services/ImageService');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

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

// Multer for generic documents (PDF, Word, images, etc.)
const docStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, 'documents');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Type non autorisé: ${file.mimetype}`));
  },
});

const ALLOWED_RELATED_TYPES = ['client', 'terrain', 'lead', 'payment'];

router.use(requireAuth);

// ─── GET /documents ───────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { related_type, related_id, type, page = 1, limit = 20 } = req.query;
    const params = [];
    const conditions = [];

    if (related_type) { params.push(related_type); conditions.push(`d.related_type = $${params.length}`); }
    if (related_id)   { params.push(related_id);   conditions.push(`d.related_id = $${params.length}`); }
    if (type)         { params.push(type);          conditions.push(`d.type = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRes = await query(`SELECT COUNT(*) FROM documents d ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(Number(limit), offset);
    const rows = await query(
      `SELECT
         d.id, d.name, d.original_name, d.type, d.mime_type,
         d.size_bytes, d.url, d.related_type, d.related_id,
         d.status, d.created_at,
         u.first_name || ' ' || u.last_name AS uploaded_by_name
       FROM documents d
       LEFT JOIN internal_users u ON d.uploaded_by = u.id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data: rows.rows,
      meta: { total, page: +page, limit: +limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

// ─── POST /documents ──────────────────────────────────────

router.post(
  '/',
  docUpload.single('file'),
  [
    body('relatedType').isIn(ALLOWED_RELATED_TYPES),
    body('relatedId').isUUID(),
    body('type').isIn(['id_card','passport','proof_of_address','title_deed','survey_plan','payment_receipt','contract','other']),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (!req.file) throw HttpError.badRequest('Aucun fichier reçu');

      const { relatedType, relatedId, type } = req.body;
      const storageKey = `documents/${req.file.filename}`;
      const url = `/uploads/${storageKey}`;

      const result = await query(
        `INSERT INTO documents
           (name, original_name, type, mime_type, size_bytes, url, storage_key, related_type, related_id, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          req.body.name || req.file.originalname,
          req.file.originalname,
          type,
          req.file.mimetype,
          req.file.size,
          url,
          storageKey,
          relatedType,
          relatedId,
          req.user.id,
        ]
      );

      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      // Clean up file if DB insert failed
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      next(error);
    }
  }
);

// ─── GET /documents/:id ───────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT d.*, u.first_name || ' ' || u.last_name AS uploaded_by_name
       FROM documents d
       LEFT JOIN internal_users u ON d.uploaded_by = u.id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) throw HttpError.notFound('Document introuvable');
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── DELETE /documents/:id ────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await query(`SELECT storage_key, uploaded_by FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc.rows.length) throw HttpError.notFound('Document introuvable');

    const { storage_key, uploaded_by } = doc.rows[0];

    // Only uploader or admin can delete
    if (uploaded_by !== req.user.id && !['admin','super_admin'].includes(req.user.role)) {
      throw HttpError.forbidden('Action non autorisée');
    }

    await query(`DELETE FROM documents WHERE id = $1`, [req.params.id]);

    // Delete physical file
    const filePath = path.join(UPLOAD_DIR, storage_key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    return res.json({ success: true, message: 'Document supprimé' });
  } catch (error) { next(error); }
});

module.exports = router;
