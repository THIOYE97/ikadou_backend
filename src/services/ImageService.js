const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');
const logger = require('../utils/logger');

// ─── Upload directory setup ───────────────────────────────

const UPLOAD_DIR = path.resolve(config.upload.dir || './uploads');
const IMAGES_DIR = path.join(UPLOAD_DIR, 'images');

// Ensure directories exist
[UPLOAD_DIR, IMAGES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created upload directory: ${dir}`);
  }
});

// ─── Multer — memory storage (we process before writing) ──

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: (config.upload.maxSizeMb || 10) * 1024 * 1024, // default 10 MB
    files: 10,
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Type de fichier non autorisé: ${file.mimetype}. Formats acceptés: JPG, PNG, WebP`));
    }
  },
});

// ─── Image compression presets ────────────────────────────

const PRESETS = {
  // Main display image — full quality, max 1400px
  terrain_main: { width: 1400, height: 900, quality: 82 },
  // Thumbnail — small, very compressed
  terrain_thumb: { width: 400, height: 260, quality: 70 },
  // Gallery — balanced
  terrain_gallery: { width: 1000, height: 667, quality: 78 },
  // Default fallback
  default: { width: 1200, height: 800, quality: 80 },
};

/**
 * Compress and convert an image buffer to WebP.
 *
 * @param {Buffer} inputBuffer  - Raw image buffer from multer
 * @param {string} preset       - One of PRESETS keys
 * @returns {Promise<{buffer: Buffer, width: number, height: number, sizeBytes: number}>}
 */
const compressImage = async (inputBuffer, preset = 'default') => {
  const { width, height, quality } = PRESETS[preset] || PRESETS.default;

  const compressed = await sharp(inputBuffer)
    .rotate()                            // auto-rotate based on EXIF
    .resize(width, height, {
      fit: 'inside',                     // never upscale, keep aspect ratio
      withoutEnlargement: true,
    })
    .webp({ quality, effort: 4 })        // convert to WebP
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: compressed.data,
    width: compressed.info.width,
    height: compressed.info.height,
    sizeBytes: compressed.info.size,
  };
};

/**
 * Save a compressed image to disk and return the relative URL path.
 *
 * @param {Buffer} inputBuffer
 * @param {string} preset
 * @param {string} [subdir]   - subdirectory inside images/ (e.g. 'terrains')
 * @returns {Promise<{url: string, storageKey: string, width, height, sizeBytes, originalSize}>}
 */
const saveImage = async (inputBuffer, preset = 'default', subdir = 'terrains') => {
  const originalSize = inputBuffer.length;
  const dir = path.join(IMAGES_DIR, subdir);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = `${uuidv4()}.webp`;
  const filePath = path.join(dir, filename);
  const storageKey = `images/${subdir}/${filename}`;
  const url = `/uploads/${storageKey}`;

  const { buffer, width, height, sizeBytes } = await compressImage(inputBuffer, preset);

  fs.writeFileSync(filePath, buffer);

  const ratio = ((1 - sizeBytes / originalSize) * 100).toFixed(1);
  logger.info(`Image saved: ${storageKey} | ${(originalSize / 1024).toFixed(0)}KB → ${(sizeBytes / 1024).toFixed(0)}KB (−${ratio}%)`);

  return { url, storageKey, width, height, sizeBytes, originalSize };
};

/**
 * Delete an image from disk by its storageKey.
 */
const deleteImage = (storageKey) => {
  try {
    const filePath = path.join(UPLOAD_DIR, storageKey);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Image deleted: ${storageKey}`);
    }
  } catch (err) {
    logger.warn(`Could not delete image ${storageKey}: ${err.message}`);
  }
};

module.exports = {
  memoryUpload,
  compressImage,
  saveImage,
  deleteImage,
  IMAGES_DIR,
  UPLOAD_DIR,
};