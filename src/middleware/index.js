'use strict';

const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const cfg       = require('../config');
const logger    = require('../services/logger');

// ── HELMET (HTTP security headers) ────────────────────────────────
const helmetMiddleware = helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  frameguard: { action: 'deny' },
});

// ── CORS ──────────────────────────────────────────────────────────
// Checks exact list + switch4.co subdomains + localhost in dev
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (cfg.allowedOrigins.includes(origin)) return true;
  if (/^https?:\/\/([a-z0-9-]+\.)?switch4\.co$/.test(origin)) return true;
  if (cfg.isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    logger.warn('CORS blocked', { origin });
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods:             ['GET', 'POST', 'OPTIONS'],
  allowedHeaders:      ['Content-Type', 'Authorization', 'X-Session-ID', 'X-Requested-With'],
  exposedHeaders:      ['X-Request-ID'],
  credentials:         false,
  maxAge:              86400,
  preflightContinue:   false,
  optionsSuccessStatus: 204,
});

// ── HTTP LOGGER ────────────────────────────────────────────────────
const httpLogger = morgan(cfg.isDev ? 'dev' : 'combined', {
  stream: { write: msg => logger.info(msg.trim()) },
  skip:   req => req.url === '/health',
});

// ── RATE LIMITERS ──────────────────────────────────────────────────
function makeLimiter(max, message) {
  return rateLimit({
    windowMs:        cfg.rateLimit.windowMs,
    max,
    standardHeaders: true,
    legacyHeaders:   false,
    handler: (req, res) => {
      logger.warn('Rate limit hit', { ip: req.ip, path: req.path });
      res.status(429).json({ error: message });
    },
  });
}

const limiters = {
  global:  makeLimiter(cfg.rateLimit.globalMax,  'Too many requests. Please try again later.'),
  chat:    makeLimiter(cfg.rateLimit.chatMax,     'Chat rate limit reached. Please wait a moment.'),
  contact: makeLimiter(cfg.rateLimit.contactMax,  'Too many submissions. Please wait before trying again.'),
  upload:  makeLimiter(cfg.rateLimit.uploadMax,   'Upload limit reached. Please try again later.'),
};

// ── INPUT SANITIZER ────────────────────────────────────────────────
function sanitize(str, maxLen = 2000) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '')     // strip HTML tags
    .replace(/[<>"]/g, '')       // strip remaining angle brackets / quotes
    .trim()
    .slice(0, maxLen);
}

function isValidEmail(email) {
  return (
    typeof email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) &&
    email.length < 320
  );
}

function isValidPhone(phone) {
  return !phone || /^[+\d\s\-().]{7,30}$/.test(phone);
}

// ── ERROR HANDLER ──────────────────────────────────────────────────
function errorHandler(err, req, res, _next) {
  logger.error('Unhandled error', {
    message: err.message,
    path:    req.path,
    method:  req.method,
    stack:   cfg.isDev ? err.stack : undefined,
  });

  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
  if (err.code === 'LIMIT_FILE_SIZE')  return res.status(400).json({ error: `File too large. Max ${cfg.upload.maxSizeMB}MB.` });
  if (err.message?.includes('file type')) return res.status(400).json({ error: err.message });
  if (err.message?.includes('CORS'))   return res.status(403).json({ error: 'Origin not allowed.' });

  res.status(500).json({ error: 'Internal server error. Please try again.' });
}

// ── 404 HANDLER ────────────────────────────────────────────────────
function notFound(req, res) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
}

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  httpLogger,
  limiters,
  sanitize,
  isValidEmail,
  isValidPhone,
  errorHandler,
  notFound,
};
