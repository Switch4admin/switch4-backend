'use strict';

/**
 * POST /api/upload-resume
 * Accepts PDF/DOC/DOCX/TXT, stores in Cloudinary (or disk),
 * extracts text, runs Sia AI analysis, matches against JobDiva.
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const { buildStorage, normalizeResult, scheduleCleanup } = require('../services/storage');
const { extractText }        = require('../services/extractor');
const { chat }               = require('../services/openai');
const { searchJobs }         = require('../services/jobdiva');
const { sendResumeNotification } = require('../services/email');
const db = require('../services/db');
const { limiters, sanitize, isValidEmail } = require('../middleware');
const cfg    = require('../config');
const logger = require('../services/logger');

const router = express.Router();

// ── MULTER ─────────────────────────────────────────────────────────
const upload = multer({
  storage:  buildStorage(),
  limits:   { fileSize: cfg.upload.maxSizeBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    const mime = file.mimetype.toLowerCase();
    const ext  = path.extname(file.originalname).toLowerCase();
    if (cfg.upload.allowedMime.includes(mime) && cfg.upload.allowedExt.includes(ext)) {
      return cb(null, true);
    }
    cb(new Error(`Invalid file type. Allowed: PDF, DOC, DOCX, TXT.`));
  },
});

// ── POST /api/upload-resume ────────────────────────────────────────
router.post('/', limiters.upload, upload.single('resume'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No resume file received.' });
  }

  const fileInfo   = normalizeResult(req.file);
  const name       = sanitize(req.body.name  || '', 120);
  const email      = sanitize(req.body.email || '', 320);
  const targetRole = sanitize(req.body.role  || '', 200);

  logger.req(req, 'Resume upload received', {
    file:    fileInfo.originalName,
    storage: fileInfo.isCloud ? 'cloudinary' : 'local',
    name,
  });

  // ── 1. Extract text ─────────────────────────────────────────────
  let extractedText = '';
  if (fileInfo.localPath) {
    extractedText = await extractText(fileInfo.localPath, fileInfo.mimeType);
  }
  // (Cloudinary raw files can be fetched for extraction in production via signed URL)

  // ── 2. AI analysis by Sia ───────────────────────────────────────
  let aiAnalysis = '';
  try {
    if (extractedText.length > 80) {
      aiAnalysis = await chat({
        messages: [{
          role:    'user',
          content: `Please analyse this candidate's resume and provide:\n\n` +
                   `1. A 2-sentence professional summary of who this person is\n` +
                   `2. Their top 3 skills or strengths (be specific)\n` +
                   `3. Which Switch4 industries and role types they'd be best suited for\n` +
                   `4. Two specific, actionable resume improvements\n\n` +
                   `Keep your response concise, warm, and encouraging.\n\n` +
                   `RESUME:\n${extractedText}`,
        }],
        mode: 'resume_review',
      });
    } else {
      aiAnalysis = `Your resume has been securely received and saved! Our Switch4 team will review it and reach out within 1 business day. In the meantime, feel free to ask me about open roles or interview preparation.`;
    }
  } catch (err) {
    logger.warn('Resume: AI analysis failed', { error: err.message });
    aiAnalysis = `Resume received successfully. A Switch4 recruiter will review it and be in touch shortly.`;
  }

  // ── 3. Match against JobDiva ────────────────────────────────────
  let matchedJobs = [];
  try {
    const searchQuery = targetRole || extractedText.split(/\s+/).slice(0, 10).join(' ');
    const { jobs } = await searchJobs({ query: searchQuery, limit: 5 });

    if (jobs?.length) {
      // Lightweight keyword match scoring
      const resumeWords = new Set(extractedText.toLowerCase().split(/\W+/));
      matchedJobs = jobs.map(j => {
        const jobWords = (j.title + ' ' + j.industry + ' ' + (j.tags || []).join(' ')).toLowerCase().split(/\W+/);
        const hits     = jobWords.filter(w => w.length > 2 && resumeWords.has(w)).length;
        const match    = Math.min(95, 55 + Math.round((hits / Math.max(jobWords.length, 1)) * 200));
        return { ...j, match };
      }).sort((a, b) => b.match - a.match);
    }
  } catch (err) {
    logger.warn('Resume: job matching failed', { error: err.message });
  }

  // ── 4. Save to database ─────────────────────────────────────────
  const saved = await db.saveResume({
    originalName:  fileInfo.originalName,
    mimeType:      fileInfo.mimeType,
    sizeBytes:     fileInfo.sizeBytes,
    cloudinaryId:  fileInfo.cloudinaryId,
    cloudinaryUrl: fileInfo.cloudinaryUrl,
    localPath:     fileInfo.localPath || '',
    extractedText: extractedText.slice(0, 8000),
    aiAnalysis:    aiAnalysis.slice(0, 3000),
    matchedJobs:   matchedJobs.length ? matchedJobs : undefined,
  });

  const resumeId = saved?.id || `tmp-${Date.now()}`;

  // ── 5. Notify recruiter (fire-and-forget) ───────────────────────
  sendResumeNotification({
    name,
    email:         isValidEmail(email) ? email : '',
    fileName:      fileInfo.originalName,
    resumeId,
    analysis:      aiAnalysis,
    cloudinaryUrl: fileInfo.cloudinaryUrl,
  }).catch(err => logger.warn('Resume: notification failed', { error: err.message }));

  // ── 6. Schedule local file cleanup ─────────────────────────────
  if (fileInfo.localPath) {
    scheduleCleanup(fileInfo.localPath, 24 * 60 * 60 * 1000);
  }

  res.json({
    ok:          true,
    resumeId,
    fileName:    fileInfo.originalName,
    analysis:    aiAnalysis,
    matchedJobs: matchedJobs.slice(0, 4),
    hasText:     extractedText.length > 0,
  });
});

module.exports = router;
