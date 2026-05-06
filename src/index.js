'use strict';

// ═══════════════════════════════════════════════════════════════════
// SWITCH4 — SIA BACKEND  (Switch4 Intelligence Assistant)
// ═══════════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const cfg     = require('./config');
const logger  = require('./services/logger');
const db      = require('./services/db');

const {
  helmetMiddleware,
  corsMiddleware,
  httpLogger,
  limiters,
  errorHandler,
  notFound,
} = require('./middleware');

// ── ROUTES ────────────────────────────────────────────────────────
const chatRoute    = require('./routes/chat');
const jobdivaRoute = require('./routes/jobdiva');
const uploadRoute  = require('./routes/upload');
const contactRoute = require('./routes/contact');

// ── APP ───────────────────────────────────────────────────────────
const app = express();

// Trust one proxy layer (Render.com, Railway, etc.)
app.set('trust proxy', 1);

// ── SECURITY ──────────────────────────────────────────────────────
app.use(helmetMiddleware);
app.use(corsMiddleware);

// ── LOGGING ───────────────────────────────────────────────────────
app.use(httpLogger);

// ── BODY PARSING ──────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ── GLOBAL RATE LIMIT ─────────────────────────────────────────────
app.use('/api/', limiters.global);

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbOk = await db.ping();

  // Render.com uses this endpoint to decide if the service is healthy.
  // Must return HTTP 200 — non-200 causes Render to restart the service.
  res.status(200).json({
    ok:          true,
    status:      'healthy',
    service:     'Switch4 Sia API',
    version:     '1.0.0',
    environment: cfg.nodeEnv,
    timestamp:   new Date().toISOString(),
    uptime:      Math.floor(process.uptime()),
    services: {
      llm:        cfg.openai.provider,           // 'openai' | 'groq' | 'none'
      database:   dbOk ? 'connected' : 'unavailable',
      cloudinary: cfg.cloudinary.configured ? 'configured' : 'local-fallback',
      email:      cfg.email.configured     ? 'configured' : 'not-configured',
      jobdiva:    cfg.jobdiva.configured   ? 'configured' : 'demo-mode',
    },
    // Features available based on current config
    features: {
      aiChat:      cfg.openai.provider !== 'none',
      resumeUpload: true,
      jobSearch:   cfg.jobdiva.configured,
      emailAlerts: cfg.email.configured,
      database:    dbOk,
    },
  });
});

// ── API ROUTES ────────────────────────────────────────────────────
app.use('/api/chat',          chatRoute);
app.use('/api/jobdiva',       jobdivaRoute);
app.use('/api/upload-resume', uploadRoute);

// contact.js handles three routes:
app.use('/api',               contactRoute);   // /api/contact, /api/notify, /api/schedule-call

// ── 404 + ERROR ───────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── START ─────────────────────────────────────────────────────────
const server = app.listen(cfg.port, () => {
  const line = '═'.repeat(58);
  logger.info(line);
  logger.info(`  Switch4 Sia API  ·  ${cfg.nodeEnv.toUpperCase()}`);
  logger.info(`  Port      : ${cfg.port}`);
  logger.info(`  LLM       : ${cfg.openai.provider || '✗ not configured'}`);
  logger.info(`  Database  : ${cfg.database.configured  ? '✓ PostgreSQL'          : '✗ not configured'}`);
  logger.info(`  Cloudinary: ${cfg.cloudinary.configured ? '✓ configured'          : '✗ using local disk'}`);
  logger.info(`  Email     : ${cfg.email.configured     ? '✓ ' + cfg.email.user   : '✗ not configured'}`);
  logger.info(`  JobDiva   : ${cfg.jobdiva.configured   ? '✓ configured'          : '✗ using demo data'}`);
  logger.info(`  CORS      : ${cfg.allowedOrigins.join(', ')}`);
  logger.info(line);
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    await db.disconnect();
    logger.info('Server closed. Goodbye.');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', reason =>
  logger.error('Unhandled rejection', { reason: String(reason) })
);
process.on('uncaughtException', err => {
  logger.error('Uncaught exception', { message: err.message });
  process.exit(1);
});

module.exports = app;
