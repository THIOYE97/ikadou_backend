const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { Readable } = require('stream');
const { v2: cloudinary } = require('cloudinary');

const config = require('../config/env');
const logger = require('../utils/logger');

// ─── Cloudinary config ────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || config.cloudinary?.cloudName,
  api_key: process.env.CLOUDINARY_API_KEY || config.cloudinary?.apiKey,
  api_secret: process.env.CLOUDINARY_API_SECRET || config.cloudinary?.apiSecret,
  secure: true,
});

// ─── Multer — memory storage (same contract as before) ────

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: (config.upload?.maxSizeMb || 10) * 1024 * 1024,
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
  terrain_main: { width: 1400, height: 900, quality: 82 },
  terrain_thumb: { width: 400, height: 260, quality: 70 },
  terrain_gallery: { width: 1000, height: 667, quality: 78 },
  default: { width: 1200, height: 800, quality: 80 },
};

/**
 * Compress and convert an image buffer to WebP.
 *
 * @param {Buffer} inputBuffer
 * @param {string} preset
 * @returns {Promise<{buffer: Buffer, width: number, height: number, sizeBytes: number}>}
 */
const compressImage = async (inputBuffer, preset = 'default') => {
  const { width, height, quality } = PRESETS[preset] || PRESETS.default;

  const compressed = await sharp(inputBuffer)
    .rotate()
    .resize(width, height, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: compressed.data,
    width: compressed.info.width,
    height: compressed.info.height,
    sizeBytes: compressed.info.size,
  };
};

/**
 * Upload a buffer to Cloudinary using upload_stream.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @returns {Promise<object>}
 */
const uploadBufferToCloudinary = (buffer, options = {}) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });

    Readable.from(buffer).pipe(uploadStream);
  });

/**
 * Save a compressed image to Cloudinary and return the same shape
 * expected by the existing terrain image routes.
 *
 * @param {Buffer} inputBuffer
 * @param {string} preset
 * @param {string} subdir
 * @returns {Promise<{url: string, storageKey: string, width: number, height: number, sizeBytes: number, originalSize: number, format: string, version: string | number}>}
 */
const saveImage = async (inputBuffer, preset = 'default', subdir = 'terrains') => {
  const originalSize = inputBuffer.length;
  const publicId = `${subdir}/${uuidv4()}`;

  const { buffer, width, height, sizeBytes } = await compressImage(inputBuffer, preset);

  const uploaded = await uploadBufferToCloudinary(buffer, {
    folder: 'ikadou',
    public_id: publicId,
    resource_type: 'image',
    overwrite: false,
    format: 'webp',
  });

  const ratio = ((1 - sizeBytes / originalSize) * 100).toFixed(1);

  logger.info(
    `Image uploaded to Cloudinary: ${uploaded.public_id} | ${(originalSize / 1024).toFixed(0)}KB → ${(sizeBytes / 1024).toFixed(0)}KB (-${ratio}%)`
  );

  return {
    url: uploaded.secure_url,
    storageKey: uploaded.public_id,
    width: uploaded.width || width,
    height: uploaded.height || height,
    sizeBytes: uploaded.bytes || sizeBytes,
    originalSize,
    format: uploaded.format || 'webp',
    version: uploaded.version,
  };
};

/**
 * Delete an image from Cloudinary by public_id / storageKey.
 *
 * @param {string} storageKey
 * @returns {Promise<void>}
 */
const deleteImage = async (storageKey) => {
  if (!storageKey) return;

  try {
    const result = await cloudinary.uploader.destroy(storageKey, {
      resource_type: 'image',
      invalidate: true,
    });

    logger.info(`Cloudinary delete result for ${storageKey}: ${result.result}`);
  } catch (err) {
    logger.warn(`Could not delete Cloudinary image ${storageKey}: ${err.message}`);
  }
};

/**
 * Optional helper to build transformed delivery URLs later if needed.
 *
 * @param {string} storageKey
 * @param {object} transformation
 * @returns {string}
 */
const buildImageUrl = (storageKey, transformation = {}) => {
  return cloudinary.url(storageKey, {
    secure: true,
    fetch_format: 'auto',
    quality: 'auto',
    ...transformation,
  });
};

module.exports = {
  memoryUpload,
  compressImage,
  saveImage,
  deleteImage,
  buildImageUrl,
  cloudinary,
  PRESETS,
};