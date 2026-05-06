'use strict';

/**
 * POST /api/chat
 * Main endpoint for Sia (Switch4 Intelligence Assistant).
 * Supports: general inquiry, job search, resume review, mock interview,
 *           salary negotiation, tough questions, elevator pitch.
 * Streaming: pass { stream: true } for SSE response.
 */

const express   = require('express');
const { body, validationResult } = require('express-validator');
const { chat, chatStream } = require('../services/openai');
const jobdiva   = require('../services/jobdiva');
const db        = require('../services/db');
const { limiters, sanitize } = require('../middleware');
const logger    = require('../services/logger');

const router = express.Router();

// ── VALIDATION ────────────────────────────────────────────────────
const chatValidation = [
  body('messages')
    .isArray({ min: 1, max: 40 })
    .withMessage('messages must be an array (1–40 items)'),
  body('messages.*.role')
    .isIn(['user', 'assistant'])
    .withMessage('message role must be user or assistant'),
  body('messages.*.content')
    .isString()
    .isLength({ min: 1, max: 6000 })
    .withMessage('message content must be 1–6000 chars'),
  body('mode')
    .optional()
    .isString()
    .isLength({ max: 50 }),
  body('sessionId')
    .optional()
    .isString()
    .isLength({ max: 100 }),
];

// ── POST /api/chat ─────────────────────────────────────────────────
router.post('/', limiters.chat, chatValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const {
    messages,
    mode          = 'general',
    sessionId     = null,
    resumeId      = null,
    jobContext     = '',
    stream        = false,
  } = req.body;

  const safeMode = sanitize(mode, 50);

  // ── Build context ──────────────────────────────────────────────
  let resumeContext = '';
  let liveJobContext = sanitize(jobContext, 2000);

  // Fetch resume text from DB if resumeId provided
  if (resumeId) {
    try {
      const resume = await db.getResume(resumeId);
      if (resume?.extractedText) {
        resumeContext = resume.extractedText;
      }
    } catch (err) {
      logger.warn('chat: failed to fetch resume', { resumeId, error: err.message });
    }
  }

  // Auto-fetch relevant jobs for job_search mode
  if (safeMode === 'job_search' && !liveJobContext && jobdiva) {
    try {
      const lastUserMsg = messages
        .filter(m => m.role === 'user')
        .pop()?.content || '';

      const { jobs } = await jobdiva.searchJobs({
        query: lastUserMsg.slice(0, 200),
        limit: 6,
      });

      if (jobs?.length) {
        liveJobContext = jobs.map(j =>
          `• ${j.title} | ${j.location} | ${j.type}${j.salary ? ' | ' + j.salary : ''}`
        ).join('\n');
      }
    } catch (err) {
      logger.warn('chat: auto job-fetch failed', { error: err.message });
    }
  }

  // ── Update session in DB (non-blocking) ───────────────────────
  if (sessionId) {
    db.upsertChatSession(sessionId, {
      mode:         safeMode,
      messageCount: messages.length,
      updatedAt:    new Date(),
    }).catch(() => {});
  }

  logger.req(req, 'Chat request', { mode: safeMode, messages: messages.length, sessionId });

  // ── STREAMING ─────────────────────────────────────────────────
  if (stream) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      await chatStream(
        { messages, mode: safeMode, resumeContext, jobContext: liveJobContext },
        chunk => res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`)
      );
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      logger.error('chatStream error', { error: err.message });
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
    return;
  }

  // ── NORMAL ────────────────────────────────────────────────────
  try {
    const reply = await chat({
      messages,
      mode:          safeMode,
      resumeContext,
      jobContext:    liveJobContext,
    });

    res.json({ ok: true, reply, mode: safeMode });
  } catch (err) {
    logger.error('chat error', { error: err.message, mode: safeMode });
    res.status(502).json({ error: err.message || 'Could not generate a response.' });
  }
});

module.exports = router;
