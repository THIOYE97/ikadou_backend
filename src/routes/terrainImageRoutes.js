const express = require('express');
const router = express.Router();

const { requireAuth, requireMinRole } = require('../middleware/requireAuth');
const HttpError = require('../utils/httpError');
const { query, transaction } = require('../data/db');
const { memoryUpload, saveImage, deleteImage } = require('../services/ImageService');

router.use(requireAuth);

// ─── POST /terrains/:id/images ────────────────────────────
// Upload 1–10 images for a terrain. Each is compressed to WebP.

router.post(
  '/:id/images',
  requireMinRole('sales'),
  memoryUpload.array('images', 10),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      // Verify terrain exists
      const terrain = await query(`SELECT id, images FROM terrains WHERE id = $1`, [id]);
      if (!terrain.rows.length) throw HttpError.notFound('Terrain introuvable');

      if (!req.files || req.files.length === 0) {
        throw HttpError.badRequest('Aucun fichier reçu');
      }

      const currentImages = terrain.rows[0].images || [];

      // Process all uploaded files in parallel
      const saved = await Promise.all(
        req.files.map(async (file, index) => {
          // First file is treated as main image, rest as gallery
          const preset = index === 0 && currentImages.length === 0
            ? 'terrain_main'
            : 'terrain_gallery';

          const result = await saveImage(file.buffer, preset, 'terrains');

          return {
            url: result.url,
            storage_key: result.storageKey,
            width: result.width,
            height: result.height,
            size_bytes: result.sizeBytes,
            original_name: file.originalname,
            is_main: index === 0 && currentImages.length === 0,
            uploaded_at: new Date().toISOString(),
          };
        })
      );

      // Merge with existing images
      const updatedImages = [...currentImages, ...saved];

      await transaction(async (client) => {
        await client.query(
          `UPDATE terrains SET images = $1 WHERE id = $2`,
          [JSON.stringify(updatedImages), id]
        );
        await client.query(
          `INSERT INTO terrain_history (terrain_id, field, new_value, comment, user_id)
           VALUES ($1, 'images', $2, $3, $4)`,
          [
            id,
            `${saved.length} image(s) ajoutée(s)`,
            `Upload: ${req.files.map(f => f.originalname).join(', ')}`,
            req.user.id,
          ]
        );
      });

      // Insert into documents table for central tracking
      for (const img of saved) {
        await query(
          `INSERT INTO documents (name, original_name, type, mime_type, size_bytes, url, storage_key, related_type, related_id, uploaded_by)
           VALUES ($1, $2, 'other', 'image/webp', $3, $4, $5, 'terrain', $6, $7)`,
          [
            `Terrain image - ${img.original_name}`,
            img.original_name,
            img.size_bytes,
            img.url,
            img.storage_key,
            id,
            req.user.id,
          ]
        );
      }

      return res.status(201).json({
        success: true,
        message: `${saved.length} image(s) uploadée(s) et compressée(s) en WebP`,
        data: {
          uploaded: saved,
          total: updatedImages.length,
        },
      });
    } catch (error) {
      // Multer errors (file size, type)
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(HttpError.badRequest(`Fichier trop volumineux. Limite: ${process.env.UPLOAD_MAX_SIZE_MB || 10} MB`));
      }
      next(error);
    }
  }
);

// ─── GET /terrains/:id/images ─────────────────────────────

router.get('/:id/images', async (req, res, next) => {
  try {
    const terrain = await query(`SELECT images FROM terrains WHERE id = $1`, [req.params.id]);
    if (!terrain.rows.length) throw HttpError.notFound('Terrain introuvable');

    return res.json({
      success: true,
      data: terrain.rows[0].images || [],
    });
  } catch (error) { next(error); }
});

// ─── PATCH /terrains/:id/images/reorder ──────────────────
// Reorder images by providing the new ordered array of urls

router.patch('/:id/images/reorder', async (req, res, next) => {
  try {
    const { orderedUrls } = req.body; // array of url strings in desired order
    if (!Array.isArray(orderedUrls)) throw HttpError.badRequest('orderedUrls array requis');

    const terrain = await query(`SELECT images FROM terrains WHERE id = $1`, [req.params.id]);
    if (!terrain.rows.length) throw HttpError.notFound('Terrain introuvable');

    const current = terrain.rows[0].images || [];

    // Reorder based on provided URLs
    const reordered = orderedUrls
      .map((url) => current.find((img) => img.url === url))
      .filter(Boolean);

    // Mark first as main
    if (reordered.length > 0) {
      reordered.forEach((img, i) => { img.is_main = i === 0; });
    }

    await query(`UPDATE terrains SET images = $1 WHERE id = $2`, [JSON.stringify(reordered), req.params.id]);
    return res.json({ success: true, data: reordered });
  } catch (error) { next(error); }
});

// ─── DELETE /terrains/:id/images ─────────────────────────
// Delete one image by its storage_key

router.delete('/:id/images', requireMinRole('sales'), async (req, res, next) => {
  try {
    const { storageKey } = req.body;
    if (!storageKey) throw HttpError.badRequest('storageKey requis');

    const terrain = await query(`SELECT images FROM terrains WHERE id = $1`, [req.params.id]);
    if (!terrain.rows.length) throw HttpError.notFound('Terrain introuvable');

    const current = terrain.rows[0].images || [];
    const filtered = current.filter((img) => img.storage_key !== storageKey);

    if (filtered.length === current.length) {
      throw HttpError.notFound('Image introuvable dans ce terrain');
    }

    // If we removed the main image, make next one main
    if (filtered.length > 0 && !filtered.some((img) => img.is_main)) {
      filtered[0].is_main = true;
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE terrains SET images = $1 WHERE id = $2`,
        [JSON.stringify(filtered), req.params.id]
      );
      await client.query(
        `DELETE FROM documents WHERE storage_key = $1`,
        [storageKey]
      );
    });

    // Delete file from disk
    deleteImage(storageKey);

    return res.json({
      success: true,
      message: 'Image supprimée',
      data: filtered,
    });
  } catch (error) { next(error); }
});

// ─── PATCH /terrains/:id/images/set-main ─────────────────

router.patch('/:id/images/set-main', async (req, res, next) => {
  try {
    const { storageKey } = req.body;
    if (!storageKey) throw HttpError.badRequest('storageKey requis');

    const terrain = await query(`SELECT images FROM terrains WHERE id = $1`, [req.params.id]);
    if (!terrain.rows.length) throw HttpError.notFound('Terrain introuvable');

    const images = (terrain.rows[0].images || []).map((img) => ({
      ...img,
      is_main: img.storage_key === storageKey,
    }));

    await query(`UPDATE terrains SET images = $1 WHERE id = $2`, [JSON.stringify(images), req.params.id]);
    return res.json({ success: true, data: images });
  } catch (error) { next(error); }
});

module.exports = router;