'use strict';

/**
 * JobDiva proxy routes — keeps credentials server-side.
 *
 * GET  /api/jobdiva/jobs           — Open job listings
 * GET  /api/jobdiva/jobs/:id       — Job detail
 * POST /api/jobdiva/search         — Search jobs by query
 * POST /api/jobdiva/candidate      — Create candidate
 * POST /api/jobdiva/apply          — Create application
 * GET  /api/jobdiva/candidates     — Search candidates
 * GET  /api/jobdiva/health         — Service health
 */

const express   = require('express');
const { body, query, param, validationResult } = require('express-validator');
const jobdiva   = require('../services/jobdiva');
const db        = require('../services/db');
const { limiters, sanitize, isValidEmail, isValidPhone } = require('../middleware');
const logger    = require('../services/logger');

const router = express.Router();

// ── DEMO JOBS (used when JobDiva not configured) ───────────────────
const DEMO_JOBS = [
  { id:'d1', title:'Registered Nurse (RN) — ICU',   location:'Dallas, TX',    type:'Contract',   industry:'Healthcare',    salary:'$42–58/hr',    tags:['Healthcare','RN','ICU']                    },
  { id:'d2', title:'BSN Registered Nurse',           location:'Houston, TX',   type:'Permanent',  industry:'Healthcare',    salary:'$65K–85K',     tags:['Healthcare','BSN','Med-Surg']              },
  { id:'d3', title:'Senior Software Engineer',        location:'Remote',        type:'Full-Time',  industry:'Technology',    salary:'$140K–175K',   tags:['React','Node.js','AWS']                    },
  { id:'d4', title:'VP of Finance',                  location:'Chicago, IL',   type:'Permanent',  industry:'Finance',       salary:'$180K–220K',   tags:['FP&A','M&A','GAAP']                        },
  { id:'d5', title:'Supply Chain Manager',            location:'Houston, TX',   type:'Full-Time',  industry:'Manufacturing', salary:'$90K–120K',    tags:['Logistics','ERP','Lean']                   },
  { id:'d6', title:'Principal Mechanical Engineer',   location:'Seattle, WA',   type:'Full-Time',  industry:'Engineering',   salary:'$115K–145K',   tags:['CAD','FEA','AS9100']                       },
  { id:'d7', title:'Healthcare Operations Director',  location:'Phoenix, AZ',   type:'Contract',   industry:'Healthcare',    salary:'$120K–150K',   tags:['Epic','Lean','Operations']                 },
  { id:'d8', title:'Allied Health — Physical Therapist', location:'Denver, CO',type:'Permanent',  industry:'Healthcare',    salary:'$75K–95K',     tags:['PT','Allied Health','Orthopedic']          },
  { id:'d9', title:'Data Engineer',                  location:'Austin, TX',    type:'Full-Time',  industry:'Technology',    salary:'$120K–155K',   tags:['Python','Spark','dbt','AWS']               },
  { id:'d10',title:'Executive Search — CFO',         location:'New York, NY',  type:'Permanent',  industry:'Finance',       salary:'$250K–350K',   tags:['CFO','Executive','IPO-ready']              },
];

function filterDemoJobs(query='', industry='') {
  const q = query.toLowerCase();
  const i = industry.toLowerCase();
  return DEMO_JOBS.filter(j =>
    (!q || j.title.toLowerCase().includes(q) || j.industry.toLowerCase().includes(q) || j.tags.some(t => t.toLowerCase().includes(q))) &&
    (!i || j.industry.toLowerCase().includes(i))
  );
}

// ── GET /api/jobdiva/health ─────────────────────────────────────
router.get('/health', async (req, res) => {
  const status = await jobdiva.ping();
  res.json({
    ok:         status.ok,
    configured: require('../config').jobdiva.configured,
    reason:     status.reason || null,
  });
});

// ── GET /api/jobdiva/jobs ─────────────────────────────────────────
router.get('/jobs', limiters.global, async (req, res) => {
  const { industry = '', limit = 20 } = req.query;

  try {
    const result = await jobdiva.getOpenJobs({
      industry: sanitize(industry, 100),
      limit:    Math.min(parseInt(limit) || 20, 50),
    });

    if (result.fallback) {
      const jobs = industry ? filterDemoJobs('', industry) : DEMO_JOBS;
      return res.json({ jobs, total: jobs.length, source: 'demo' });
    }

    logger.req(req, 'jobdiva: getOpenJobs', { count: result.jobs.length });
    res.json({ jobs: result.jobs, total: result.total, source: 'jobdiva' });
  } catch (err) {
    logger.error('jobdiva: getOpenJobs error', { error: err.message });
    res.json({ jobs: DEMO_JOBS, total: DEMO_JOBS.length, source: 'demo' });
  }
});

// ── GET /api/jobdiva/jobs/:id ─────────────────────────────────────
router.get('/jobs/:id', limiters.global, [
  param('id').isString().isLength({ max: 50 }),
], async (req, res) => {
  const { id } = req.params;

  try {
    const job = await jobdiva.getJobDetail(id);
    if (!job) {
      const demo = DEMO_JOBS.find(j => j.id === id);
      return demo
        ? res.json({ job: demo, source: 'demo' })
        : res.status(404).json({ error: 'Job not found.' });
    }
    res.json({ job, source: 'jobdiva' });
  } catch (err) {
    logger.error('jobdiva: getJobDetail error', { id, error: err.message });
    res.status(500).json({ error: 'Could not fetch job details.' });
  }
});

// ── POST /api/jobdiva/search ──────────────────────────────────────
router.post('/search', limiters.global, [
  body('query').optional().isString().isLength({ max: 200 }),
  body('location').optional().isString().isLength({ max: 100 }),
  body('industry').optional().isString().isLength({ max: 100 }),
  body('limit').optional().isInt({ min: 1, max: 25 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const {
    query    = '',
    location = '',
    industry = '',
    limit    = 10,
    resumeId = null,
  } = req.body;

  try {
    const result = await jobdiva.searchJobs({
      query:    sanitize(query,    200),
      location: sanitize(location, 100),
      industry: sanitize(industry, 100),
      limit:    Math.min(parseInt(limit) || 10, 25),
    });

    let jobs = result.jobs;
    let source = 'jobdiva';

    if (result.fallback || !jobs.length) {
      jobs   = filterDemoJobs(query, industry).slice(0, parseInt(limit) || 10);
      source = 'demo';
    }

    // Score jobs against resume if resumeId provided
    if (resumeId && jobs.length) {
      const resume = await db.getResume(resumeId);
      if (resume?.extractedText) {
        const resumeWords = new Set(resume.extractedText.toLowerCase().split(/\s+/));
        jobs = jobs.map(j => {
          const jobWords = (j.title + ' ' + j.industry + ' ' + (j.tags||[]).join(' ')).toLowerCase().split(/\s+/);
          const hits     = jobWords.filter(w => resumeWords.has(w)).length;
          const match    = Math.min(95, 55 + Math.round((hits / Math.max(jobWords.length, 1)) * 200));
          return { ...j, match };
        }).sort((a, b) => b.match - a.match);
      }
    }

    logger.req(req, 'jobdiva: searchJobs', { query, count: jobs.length, source });
    res.json({ jobs, total: jobs.length, source });
  } catch (err) {
    logger.error('jobdiva: searchJobs error', { error: err.message });
    const fallback = filterDemoJobs(query, industry);
    res.json({ jobs: fallback, total: fallback.length, source: 'demo' });
  }
});

// ── POST /api/jobdiva/candidate ────────────────────────────────────
router.post('/candidate', limiters.contact, [
  body('firstName').isString().isLength({ min: 1, max: 100 }).withMessage('First name required'),
  body('lastName').optional().isString().isLength({ max: 100 }),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone').optional().isString().isLength({ max: 30 }),
  body('roleInterest').optional().isString().isLength({ max: 200 }),
  body('resumeId').optional().isString().isLength({ max: 100 }),
  body('targetJobId').optional().isString().isLength({ max: 50 }),
  body('targetJobTitle').optional().isString().isLength({ max: 200 }),
  body('source').optional().isString().isLength({ max: 50 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const {
    firstName, lastName = '', email, phone = '',
    roleInterest = '', resumeId = null,
    targetJobId = '', targetJobTitle = '',
    source = 'chatbot',
  } = req.body;

  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Invalid phone.' });

  const safeName     = sanitize(firstName, 100);
  const safeLastName = sanitize(lastName,  100);
  const safeEmail    = email.toLowerCase().trim();

  // Get resume text for JobDiva
  let resumeText = '';
  if (resumeId) {
    const resume = await db.getResume(resumeId);
    if (resume?.extractedText) resumeText = resume.extractedText;
  }

  // Save lead to DB
  const lead = await db.saveLead({
    firstName:     safeName,
    lastName:      safeLastName,
    email:         safeEmail,
    phone:         sanitize(phone, 30),
    roleInterest:  sanitize(roleInterest, 200),
    type:          'CANDIDATE',
    source:        'CHATBOT',
    targetJobId,
    targetJobTitle,
    resumeId,
  });

  // Create in JobDiva (non-blocking on failure)
  let jobdivaId = null;
  try {
    const jdResult = await jobdiva.createCandidate({
      firstName: safeName,
      lastName:  safeLastName,
      email:     safeEmail,
      phone,
      resumeText,
    });

    jobdivaId = jdResult.id;

    if (jobdivaId) {
      // Create application if job targeted
      if (targetJobId) {
        await jobdiva.createApplication({ candidateId: jobdivaId, jobId: targetJobId });
      }
      // Update DB with JobDiva ID
      if (lead?.id) {
        await db.updateLead(lead.id, { jobdivaId });
      }
    }
  } catch (err) {
    logger.warn('jobdiva: createCandidate failed', { email: safeEmail, error: err.message });
  }

  logger.req(req, 'candidate created', { email: safeEmail, leadId: lead?.id, jobdivaId });

  res.json({
    ok:         true,
    leadId:     lead?.id    || null,
    jobdivaId:  jobdivaId   || null,
  });
});

// ── POST /api/jobdiva/apply ────────────────────────────────────────
router.post('/apply', limiters.global, [
  body('candidateId').isString().isLength({ min: 1, max: 100 }),
  body('jobId').isString().isLength({ min: 1, max: 50 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { candidateId, jobId } = req.body;
  const result = await jobdiva.createApplication({ candidateId, jobId });
  res.json(result);
});

// ── GET /api/jobdiva/candidates (internal search) ─────────────────
router.get('/candidates', limiters.global, [
  query('q').optional().isString().isLength({ max: 200 }),
  query('email').optional().isEmail(),
  query('limit').optional().isInt({ min: 1, max: 20 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { q = '', email = '', limit = 10 } = req.query;

  try {
    const result = await jobdiva.searchCandidates({
      query: sanitize(q, 200),
      email: sanitize(email, 320),
      limit: parseInt(limit) || 10,
    });
    res.json(result);
  } catch (err) {
    logger.error('jobdiva: searchCandidates', { error: err.message });
    res.status(500).json({ error: 'Could not search candidates.' });
  }
});

module.exports = router;
