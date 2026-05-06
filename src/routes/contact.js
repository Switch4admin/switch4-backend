'use strict';

/**
 * POST /api/contact        — Contact form submission
 * POST /api/notify         — Chatbot lead capture
 * POST /api/schedule-call  — Book a recruiter call
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const email   = require('../services/email');
const db      = require('../services/db');
const { limiters, sanitize, isValidEmail, isValidPhone } = require('../middleware');
const logger  = require('../services/logger');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// POST /api/contact
// ═══════════════════════════════════════════════════════════════════
router.post('/contact', limiters.contact, [
  body('name').isString().isLength({ min: 2, max: 120 }).withMessage('Full name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('message').isString().isLength({ min: 10, max: 2000 }).withMessage('Message must be 10–2000 chars'),
  body('phone').optional().isString().isLength({ max: 30 }),
  body('company').optional().isString().isLength({ max: 200 }),
  body('service').optional().isString().isLength({ max: 100 }),
  body('role').optional().isIn(['employer', 'candidate', 'unknown']),
  // Honeypot field — bots fill this, humans leave it empty
  body('website').optional().isEmpty().withMessage('Bot detected'),
], async (req, res) => {
  // Honeypot — silent success to confuse bots
  if (req.body.website) return res.json({ ok: true });

  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, email: rawEmail, phone, company, service, message, role = 'unknown' } = req.body;

  if (!isValidEmail(rawEmail)) return res.status(400).json({ error: 'Invalid email address.' });
  if (!isValidPhone(phone))    return res.status(400).json({ error: 'Invalid phone format.' });

  const safe = {
    role:    sanitize(role,    30),
    name:    sanitize(name,    120),
    email:   rawEmail.toLowerCase().trim(),
    phone:   sanitize(phone   || '', 30),
    company: sanitize(company || '', 200),
    service: sanitize(service || '', 100),
    message: sanitize(message,  2000),
  };

  logger.req(req, 'Contact form', { name: safe.name, email: safe.email, role: safe.role });

  const [emailResult] = await Promise.allSettled([
    email.sendContactEmail(safe),
    db.saveContact(safe),
  ]);

  if (emailResult.status === 'rejected') {
    logger.error('Contact: email failed', { error: emailResult.reason?.message });
    return res.status(500).json({ error: 'Could not send your message. Please email info@switch4.co directly.' });
  }

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/notify  — chatbot lead capture
// ═══════════════════════════════════════════════════════════════════
router.post('/notify', limiters.contact, [
  body('name').isString().isLength({ min: 2, max: 120 }).withMessage('Name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone').optional().isString().isLength({ max: 30 }),
  body('role').optional().isString().isLength({ max: 200 }),
  body('company').optional().isString().isLength({ max: 200 }),
  body('type').optional().isIn(['CANDIDATE', 'EMPLOYER', 'candidate', 'employer']),
  body('source').optional().isString().isLength({ max: 50 }),
  body('notes').optional().isString().isLength({ max: 2000 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const {
    name, email: rawEmail, phone = '', role = '', company = '',
    type = 'CANDIDATE', source = 'chatbot', notes = '',
    targetJob = null, resumeId = null,
  } = req.body;

  if (!isValidEmail(rawEmail)) return res.status(400).json({ error: 'Invalid email.' });

  const parts = sanitize(name, 120).split(' ');
  const safe  = {
    firstName:    parts[0] || name,
    lastName:     parts.slice(1).join(' ') || '',
    email:        rawEmail.toLowerCase().trim(),
    phone:        sanitize(phone,   30),
    roleInterest: sanitize(role,    200),
    company:      sanitize(company, 200),
    type:         ['CANDIDATE','candidate'].includes(type) ? 'CANDIDATE' : 'EMPLOYER',
    source:       'CHATBOT',
    notes:        sanitize(notes,   2000),
    targetJobId:    sanitize(String(targetJob?.id    || ''), 50),
    targetJobTitle: sanitize(String(targetJob?.title || ''), 200),
    resumeId:     resumeId || undefined,
  };

  logger.req(req, 'Lead captured', { email: safe.email, type: safe.type, source });

  const [notifyResult, dbResult] = await Promise.allSettled([
    email.sendLeadNotification({ ...safe, name: `${safe.firstName} ${safe.lastName}`.trim(), targetJob, notes }),
    db.saveLead(safe),
  ]);

  const leadId = dbResult.status === 'fulfilled' ? dbResult.value?.id : null;
  if (notifyResult.status === 'rejected') {
    logger.warn('Lead: notification failed', { error: notifyResult.reason?.message });
  }

  res.json({ ok: true, leadId });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/schedule-call
// ═══════════════════════════════════════════════════════════════════
router.post('/schedule-call', limiters.contact, [
  body('name').isString().isLength({ min: 2, max: 120 }).withMessage('Name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('slot').isString().isLength({ min: 5, max: 100 }).withMessage('Time slot required'),
  body('phone').optional().isString().isLength({ max: 30 }),
  body('purpose').optional().isString().isLength({ max: 200 }),
  body('timezone').optional().isString().isLength({ max: 20 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, email: rawEmail, slot, phone = '', purpose = 'Recruitment Call', timezone = 'EST' } = req.body;

  if (!isValidEmail(rawEmail)) return res.status(400).json({ error: 'Invalid email.' });
  if (!isValidPhone(phone))    return res.status(400).json({ error: 'Invalid phone.' });

  const safe = {
    name:    sanitize(name,    120),
    email:   rawEmail.toLowerCase().trim(),
    phone:   sanitize(phone,   30),
    slot:    sanitize(slot,    100),
    purpose: sanitize(purpose, 200),
    timezone: sanitize(timezone, 20),
  };

  logger.req(req, 'Schedule call', { name: safe.name, email: safe.email, slot: safe.slot });

  await Promise.allSettled([
    email.sendScheduleNotification(safe),
    db.saveSchedule(safe),
  ]);

  res.json({ ok: true });
});

module.exports = router;
