'use strict';

const path   = require('path');
const fs     = require('fs');
const cfg    = require('../config');
const logger = require('./logger');

// ── CLOUDINARY CLIENT (lazy init) ─────────────────────────────────
let _cloudinary = null;

function getCloudinary() {
  if (_cloudinary) return _cloudinary;
  if (!cfg.cloudinary.configured) return null;

  try {
    const { v2: cloudinary } = require('cloudinary');
    cloudinary.config({
      cloud_name: cfg.cloudinary.cloudName,
      api_key:    cfg.cloudinary.apiKey,
      api_secret: cfg.cloudinary.apiSecret,
      secure:     true,
    });
    _cloudinary = cloudinary;
    logger.info('Cloudinary: initialised', { cloud: cfg.cloudinary.cloudName });
  } catch (err) {
    logger.warn('Cloudinary: init failed', { error: err.message });
  }
  return _cloudinary;
}

// ── BUILD MULTER STORAGE ENGINE ────────────────────────────────────
function buildStorage() {
  const cl = getCloudinary();

  if (cl) {
    const { CloudinaryStorage } = require('multer-storage-cloudinary');
    return new CloudinaryStorage({
      cloudinary: cl,
      params: async (req, file) => ({
        folder:          cfg.cloudinary.folder,
        resource_type:   'raw',
        public_id:       `resume-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
        access_mode:     'authenticated',
        allowed_formats: ['pdf','doc','docx','txt'],
      }),
    });
  }

  // Local disk fallback
  const uploadDir = path.resolve(cfg.upload.localDir);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  logger.info('Storage: using local disk (configure Cloudinary for production)');

  const multer = require('multer');
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safeName}`);
    },
  });
}

// ── NORMALIZE UPLOAD RESULT ────────────────────────────────────────
// Returns consistent shape regardless of Cloudinary vs disk
function normalizeResult(file) {
  const isCloud = file.path?.startsWith('http');
  return {
    cloudinaryId:  isCloud ? (file.filename || '')  : '',
    cloudinaryUrl: isCloud ? (file.path     || '')  : '',
    localPath:     isCloud ? null                   : file.path,
    originalName:  file.originalname,
    mimeType:      file.mimetype,
    sizeBytes:     file.size || 0,
    isCloud,
  };
}

// ── SCHEDULE LOCAL FILE CLEANUP ────────────────────────────────────
function scheduleCleanup(filePath, delayMs = 24 * 60 * 60 * 1000) {
  if (!filePath) return;
  setTimeout(() => {
    fs.unlink(filePath, err => {
      if (err && err.code !== 'ENOENT') {
        logger.warn('Storage: cleanup failed', { path: filePath, error: err.message });
      }
    });
  }, delayMs);
}

module.exports = { buildStorage, normalizeResult, scheduleCleanup, getCloudinary };
