'use strict';

const { createLogger, format, transports } = require('winston');
const path  = require('path');
const cfg   = require('../config');

const { combine, timestamp, printf, colorize, errors, json } = format;

// ── CONSOLE FORMAT ────────────────────────────────────────────────
const consoleFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length
    ? ' ' + JSON.stringify(meta, null, 0)
    : '';
  const stackStr = stack ? `\n${stack}` : '';
  return `${ts} [${level}] ${message}${metaStr}${stackStr}`;
});

const logger = createLogger({
  level: cfg.isDev ? 'debug' : 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    json()
  ),
  transports: [
    // Console — always active
    new transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'HH:mm:ss' }),
        errors({ stack: true }),
        consoleFormat
      ),
    }),
  ],
});

// File transports in production
if (!cfg.isDev) {
  const logDir = path.join(__dirname, '../../logs');

  logger.add(new transports.File({
    filename:  path.join(logDir, 'error.log'),
    level:     'error',
    maxsize:   5 * 1024 * 1024,  // 5MB
    maxFiles:  5,
    tailable:  true,
  }));

  logger.add(new transports.File({
    filename:  path.join(logDir, 'app.log'),
    maxsize:   10 * 1024 * 1024, // 10MB
    maxFiles:  7,
    tailable:  true,
  }));
}

// Convenience method for request logging
logger.req = (req, msg, meta = {}) => {
  logger.info(msg, {
    method: req.method,
    path:   req.path,
    ip:     req.ip,
    ...meta,
  });
};

module.exports = logger;
