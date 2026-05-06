'use strict';

const cfg    = require('../config');
const logger = require('./logger');

// ── TOKEN CACHE ───────────────────────────────────────────────────
let _token       = null;
let _tokenExpiry = 0;
const TOKEN_TTL  = 55 * 60 * 1000; // 55 min (JobDiva tokens last 60 min)

// ── LOW-LEVEL FETCH WRAPPER ────────────────────────────────────────
async function jdFetch(endpoint, options = {}) {
  const { default: fetch } = await import('node-fetch');

  const url = `${cfg.jobdiva.baseUrl}${endpoint}`;
  const timeout = options.timeout || 12000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`JobDiva ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('JobDiva request timed out.');
    throw err;
  }
}

// ── AUTHENTICATE ──────────────────────────────────────────────────
async function authenticate() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  if (!cfg.jobdiva.configured) {
    throw new Error('JobDiva credentials not configured.');
  }

  logger.debug('JobDiva: authenticating');

  const data = await jdFetch('/api/jobdiva/authenticate', {
    method: 'POST',
    body: JSON.stringify({
      companyid: cfg.jobdiva.companyId,
      username:  cfg.jobdiva.username,
      password:  cfg.jobdiva.password,
    }),
  });

  const token = data.token || data.sessionid || data.accesstoken;
  if (!token) throw new Error('JobDiva authentication returned no token.');

  _token       = token;
  _tokenExpiry = Date.now() + TOKEN_TTL;

  logger.info('JobDiva: authenticated successfully');
  return _token;
}

function invalidateToken() {
  _token = null;
  _tokenExpiry = 0;
}

// ── AUTHENTICATED FETCH (auto-retry on 401) ─────────────────────
async function jdAuthFetch(endpoint, options = {}, retried = false) {
  const token = await authenticate();

  try {
    return await jdFetch(endpoint, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    // Token expired — retry once with fresh token
    if (!retried && err.message?.includes('401')) {
      logger.warn('JobDiva: token expired, re-authenticating');
      invalidateToken();
      return jdAuthFetch(endpoint, options, true);
    }
    throw err;
  }
}

// ── NORMALIZE JOB OBJECT ───────────────────────────────────────────
function normalizeJob(j) {
  return {
    id:          String(j.id || j.jobId || j.jobid || ''),
    title:       String(j.jobTitle || j.title || j.jobtitle || ''),
    location:    j.city
      ? `${j.city}${j.state ? ', ' + j.state : ''}`
      : String(j.location || 'Location TBD'),
    type:        String(j.jobType || j.employmentType || j.jobtype || 'Full-Time'),
    industry:    String(j.industry || j.vertical || ''),
    salary:      String(j.salaryRange || j.salary || j.salaryrange || ''),
    description: String(j.jobDescription || j.description || j.jobdescription || '').slice(0, 800),
    postedAt:    j.createddate || j.postdate || null,
    tags: [
      j.industry || j.vertical,
      j.jobType  || j.jobtype,
      j.city,
    ].filter(Boolean).map(String),
  };
}

// ── NORMALIZE CANDIDATE OBJECT ─────────────────────────────────────
function normalizeCandidate(c) {
  return {
    id:        String(c.id || c.candidateid || c.candidateId || ''),
    firstName: String(c.firstname || c.firstName || ''),
    lastName:  String(c.lastname  || c.lastName  || ''),
    email:     String(c.email     || ''),
    phone:     String(c.phone     || c.phonenumber || ''),
  };
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

// ── SEARCH OPEN JOBS ───────────────────────────────────────────────
async function searchJobs({ query = '', location = '', industry = '', limit = 10 }) {
  if (!cfg.jobdiva.configured) return { jobs: [], fallback: true };

  try {
    const data = await jdAuthFetch('/api/jobdiva/SearchJob', {
      method: 'POST',
      body: JSON.stringify({
        searchString: query || '',
        location:     location || '',
        industry:     industry || '',
        numResults:   Math.min(parseInt(limit) || 10, 25),
        status:       'Open',
      }),
    });

    const raw  = data.jobs || data.results || data.data || [];
    const jobs = raw.map(normalizeJob);

    logger.debug('JobDiva: searchJobs', { query, count: jobs.length });
    return { jobs, total: data.totalCount || jobs.length };
  } catch (err) {
    logger.warn('JobDiva searchJobs failed', { error: err.message });
    return { jobs: [], error: err.message, fallback: true };
  }
}

// ── GET OPEN JOBS LIST (no search term) ────────────────────────────
async function getOpenJobs({ limit = 20, industry = '' }) {
  if (!cfg.jobdiva.configured) return { jobs: [], fallback: true };

  try {
    const data = await jdAuthFetch('/api/bi/OpenJobsList', {
      method: 'POST',
      body: JSON.stringify({
        companyid:  cfg.jobdiva.companyId,
        industry:   industry || '',
        numResults: Math.min(parseInt(limit) || 20, 50),
      }),
    });

    const raw  = data.jobs || data.result || data.data || [];
    const jobs = raw.map(normalizeJob);

    logger.debug('JobDiva: getOpenJobs', { industry, count: jobs.length });
    return { jobs, total: data.totalCount || jobs.length };
  } catch (err) {
    logger.warn('JobDiva getOpenJobs failed', { error: err.message });
    return { jobs: [], error: err.message, fallback: true };
  }
}

// ── GET JOB DETAIL ─────────────────────────────────────────────────
async function getJobDetail(jobId) {
  if (!cfg.jobdiva.configured) return null;

  try {
    const data = await jdAuthFetch('/api/bi/JobsDetail', {
      method: 'POST',
      body: JSON.stringify({ jobid: jobId }),
    });

    const raw = data.job || data.result || data;
    return normalizeJob(raw);
  } catch (err) {
    logger.warn('JobDiva getJobDetail failed', { jobId, error: err.message });
    return null;
  }
}

// ── CREATE CANDIDATE ───────────────────────────────────────────────
async function createCandidate({ firstName, lastName, email, phone = '', resumeText = '' }) {
  if (!cfg.jobdiva.configured) return { id: null, fallback: true };

  try {
    const data = await jdAuthFetch('/api/jobdiva/createCandidate', {
      method: 'POST',
      body: JSON.stringify({
        firstname:  firstName,
        lastname:   lastName,
        email:      email.toLowerCase().trim(),
        phone:      phone,
        resumetext: resumeText.slice(0, 10000),
      }),
    });

    const id = data.candidateid || data.candidateId || data.id || null;
    logger.info('JobDiva: candidate created', { id, email });
    return { id, raw: data };
  } catch (err) {
    logger.warn('JobDiva createCandidate failed', { email, error: err.message });
    throw err;
  }
}

// ── CREATE JOB APPLICATION ─────────────────────────────────────────
async function createApplication({ candidateId, jobId }) {
  if (!cfg.jobdiva.configured || !candidateId || !jobId) return { ok: false };

  try {
    await jdAuthFetch('/api/jobdiva/createJobApplication', {
      method: 'POST',
      body: JSON.stringify({ candidateId, jobId }),
    });

    logger.info('JobDiva: application created', { candidateId, jobId });
    return { ok: true };
  } catch (err) {
    logger.warn('JobDiva createApplication failed', { candidateId, jobId, error: err.message });
    return { ok: false, error: err.message };
  }
}

// ── UPLOAD RESUME TO JOBDIVA ───────────────────────────────────────
async function uploadResumeToJobDiva({ candidateId, resumeText, fileName }) {
  if (!cfg.jobdiva.configured || !candidateId) return { ok: false };

  try {
    await jdAuthFetch('/api/jobdiva/uploadResume', {
      method: 'POST',
      body: JSON.stringify({
        candidateId,
        resumetext: resumeText.slice(0, 10000),
        filename:   fileName || 'resume.pdf',
      }),
    });

    logger.info('JobDiva: resume uploaded', { candidateId });
    return { ok: true };
  } catch (err) {
    logger.warn('JobDiva uploadResume failed', { candidateId, error: err.message });
    return { ok: false, error: err.message };
  }
}

// ── SEARCH CANDIDATES ──────────────────────────────────────────────
async function searchCandidates({ query = '', email = '', limit = 10 }) {
  if (!cfg.jobdiva.configured) return { candidates: [] };

  try {
    const data = await jdAuthFetch('/api/jobdiva/SearchCandidate', {
      method: 'POST',
      body: JSON.stringify({
        searchString: query || '',
        email:        email || '',
        numResults:   Math.min(parseInt(limit) || 10, 20),
      }),
    });

    const raw        = data.candidates || data.result || data.data || [];
    const candidates = raw.map(normalizeCandidate);
    return { candidates };
  } catch (err) {
    logger.warn('JobDiva searchCandidates failed', { error: err.message });
    return { candidates: [], error: err.message };
  }
}

// ── HEALTH CHECK ───────────────────────────────────────────────────
async function ping() {
  if (!cfg.jobdiva.configured) return { ok: false, reason: 'not configured' };
  try {
    await authenticate();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  authenticate,
  searchJobs,
  getOpenJobs,
  getJobDetail,
  createCandidate,
  createApplication,
  uploadResumeToJobDiva,
  searchCandidates,
  ping,
  normalizeJob,
};
