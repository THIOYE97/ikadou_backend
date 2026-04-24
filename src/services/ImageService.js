const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { Readable } = require('stream');
const { v2: cloudinary } = require('cloudinary');

const config = require('../config/env');
const logger = require('../utils/logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || config.cloudinary?.cloudName,
  api_key: process.env.CLOUDINARY_API_KEY || config.cloudinary?.apiKey,
  api_secret: process.env.CLOUDINARY_API_SECRET || config.cloudinary?.apiSecret,
  secure: true,
});

const baseLimits = {
  fileSize: (config.upload?.maxSizeMb || 10) * 1024 * 1024,
  files: 10,
};

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: baseLimits,
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Type de fichier non autorisé: ${file.mimetype}. Formats acceptés: JPG, PNG, WebP`));
  },
});

const memoryUploadDocuments = multer({
  storage: multer.memoryStorage(),
  limits: {
    ...baseLimits,
    fileSize: (config.upload?.maxSizeMb || 20) * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ];

    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Type de document non autorisé: ${file.mimetype}`));
  },
});

const PRESETS = {
  terrain_main: { width: 1400, height: 900, quality: 82 },
  terrain_thumb: { width: 400, height: 260, quality: 70 },
  terrain_gallery: { width: 1000, height: 667, quality: 78 },
  default: { width: 1200, height: 800, quality: 80 },
};

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

const uploadBufferToCloudinary = (buffer, options = {}) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });

    Readable.from(buffer).pipe(uploadStream);
  });

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
    `Image uploaded to Cloudinary: ${uploaded.public_id} | ${(originalSize / 1024).toFixed(0)}KB -> ${(sizeBytes / 1024).toFixed(0)}KB (-${ratio}%)`
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
    resourceType: 'image',
  };
};

const getExtension = (filename = '') => {
  const ext = path.extname(filename).replace('.', '').toLowerCase();
  return ext || 'bin';
};

const isPdf = (mimeType = '', originalName = '') =>
  mimeType === 'application/pdf' || getExtension(originalName) === 'pdf';

const saveDocument = async ({
  inputBuffer,
  originalName,
  mimeType,
  subdir = 'terrains/documents',
}) => {
  const originalSize = inputBuffer.length;
  const ext = getExtension(originalName);
  const basePublicId = `${subdir}/${uuidv4()}`;

  // PDF => image resource for better delivery/preview in Cloudinary
  if (isPdf(mimeType, originalName)) {
    const uploaded = await uploadBufferToCloudinary(inputBuffer, {
      folder: 'ikadou',
      public_id: basePublicId,
      resource_type: 'image',
      overwrite: false,
      format: 'pdf',
    });

    return {
      url: uploaded.secure_url,
      storageKey: uploaded.public_id,
      sizeBytes: uploaded.bytes || originalSize,
      originalSize,
      format: uploaded.format || 'pdf',
      version: uploaded.version,
      resourceType: 'image',
      mimeType: 'application/pdf',
      originalName,
    };
  }

  // images uploaded as documents => keep previewable
  if ((mimeType || '').startsWith('image/')) {
    const uploaded = await uploadBufferToCloudinary(inputBuffer, {
      folder: 'ikadou',
      public_id: basePublicId,
      resource_type: 'image',
      overwrite: false,
    });

    return {
      url: uploaded.secure_url,
      storageKey: uploaded.public_id,
      sizeBytes: uploaded.bytes || originalSize,
      originalSize,
      format: uploaded.format || ext,
      version: uploaded.version,
      resourceType: 'image',
      mimeType,
      originalName,
    };
  }

  // autres fichiers => raw
  const uploaded = await uploadBufferToCloudinary(inputBuffer, {
    folder: 'ikadou',
    public_id: `${basePublicId}.${ext}`,
    resource_type: 'raw',
    overwrite: false,
  });

  return {
    url: uploaded.secure_url,
    storageKey: uploaded.public_id,
    sizeBytes: uploaded.bytes || originalSize,
    originalSize,
    format: uploaded.format || ext,
    version: uploaded.version,
    resourceType: 'raw',
    mimeType,
    originalName,
  };
};

const deleteImage = async (storageKey) => {
  if (!storageKey) return;
  try {
    await cloudinary.uploader.destroy(storageKey, {
      resource_type: 'image',
      invalidate: true,
    });
  } catch (err) {
    logger.warn(`Could not delete Cloudinary image ${storageKey}: ${err.message}`);
  }
};

const deleteDocument = async (storageKey, resourceType = 'raw') => {
  if (!storageKey) return;
  try {
    await cloudinary.uploader.destroy(storageKey, {
      resource_type: resourceType,
      invalidate: true,
    });
  } catch (err) {
    logger.warn(`Could not delete Cloudinary document ${storageKey}: ${err.message}`);
  }
};

const buildImageUrl = (storageKey, transformation = {}) =>
  cloudinary.url(storageKey, {
    secure: true,
    fetch_format: 'auto',
    quality: 'auto',
    ...transformation,
  });

module.exports = {
  memoryUpload,
  memoryUploadDocuments,
  compressImage,
  saveImage,
  saveDocument,
  deleteImage,
  deleteDocument,
  buildImageUrl,
  cloudinary,
  PRESETS,
};