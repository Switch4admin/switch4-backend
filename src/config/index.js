'use strict';

require('dotenv').config();

// ── REQUIRED VARIABLE GUARD ───────────────────────────────────────
const REQUIRED = ['OPENAI_API_KEY'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.warn(`\n⚠  Missing required env vars: ${missing.join(', ')}`);
  console.warn('   Some features may be degraded. See .env.example\n');
}

const cfg = {
  // ── Server ───────────────────────────────────────────────────
  port:     parseInt(process.env.PORT || '3001', 10),
  nodeEnv:  process.env.NODE_ENV || 'development',
  get isDev() { return this.nodeEnv === 'development'; },

  // ── CORS ─────────────────────────────────────────────────────
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:5500')
    .split(',').map(s => s.trim()),

  // ── OpenAI ───────────────────────────────────────────────────
  openai: {
    apiKey:    process.env.OPENAI_API_KEY    || '',
    model:     process.env.OPENAI_MODEL      || 'gpt-4o-mini',
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '1200', 10),
    // Groq fallback (free tier)
    groqApiKey: process.env.GROQ_API_KEY     || '',
    groqModel:  process.env.GROQ_MODEL       || 'llama-3.3-70b-versatile',
    get provider() { return this.apiKey ? 'openai' : (this.groqApiKey ? 'groq' : 'none'); },
  },

  // ── Database ─────────────────────────────────────────────────
  database: {
    url:        process.env.DATABASE_URL || '',
    get configured() { return !!this.url; },
  },

  // ── Cloudinary ───────────────────────────────────────────────
  cloudinary: {
    cloudName:  process.env.CLOUDINARY_CLOUD_NAME   || '',
    apiKey:     process.env.CLOUDINARY_API_KEY      || '',
    apiSecret:  process.env.CLOUDINARY_API_SECRET   || '',
    folder:     process.env.CLOUDINARY_UPLOAD_FOLDER || 'switch4-resumes',
    get configured() { return !!(this.cloudName && this.apiKey && this.apiSecret); },
  },

  // ── Email ─────────────────────────────────────────────────────
  email: {
    host:           process.env.SMTP_HOST          || 'smtp.gmail.com',
    port:           parseInt(process.env.SMTP_PORT || '587', 10),
    secure:         process.env.SMTP_SECURE        === 'true',
    user:           process.env.SMTP_USER          || '',
    pass:           process.env.SMTP_PASS          || '',
    recruiterEmail: process.env.RECRUITER_EMAIL    || 'info@switch4.co',
    fromEmail:      process.env.FROM_EMAIL         || 'noreply@switch4.co',
    fromName:       process.env.FROM_NAME          || 'Switch4 — Sia',
    get configured() { return !!(this.user && this.pass); },
  },

  // ── JobDiva ───────────────────────────────────────────────────
  jobdiva: {
    baseUrl:   process.env.JOBDIVA_BASE_URL    || 'https://www.jobdiva.com',
    companyId: process.env.JOBDIVA_COMPANY_ID  || '',
    username:  process.env.JOBDIVA_USERNAME    || '',
    password:  process.env.JOBDIVA_PASSWORD    || '',
    get configured() { return !!(this.companyId && this.username && this.password); },
  },

  // ── File Upload ────────────────────────────────────────────────
  upload: {
    maxSizeMB:   parseInt(process.env.MAX_FILE_SIZE_MB || '5', 10),
    allowedMime: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ],
    allowedExt: ['.pdf', '.doc', '.docx', '.txt'],
    localDir:   process.env.UPLOAD_DIR || './uploads',
    get maxSizeBytes() { return this.maxSizeMB * 1024 * 1024; },
  },

  // ── Rate Limiting ──────────────────────────────────────────────
  rateLimit: {
    windowMs:   parseInt(process.env.RATE_LIMIT_WINDOW_MS    || '900000', 10), // 15 min
    globalMax:  parseInt(process.env.RATE_LIMIT_MAX          || '150',    10),
    chatMax:    parseInt(process.env.CHAT_RATE_LIMIT_MAX     || '40',     10),
    contactMax: parseInt(process.env.CONTACT_RATE_LIMIT_MAX  || '10',     10),
    uploadMax:  parseInt(process.env.UPLOAD_RATE_LIMIT_MAX   || '15',     10),
  },
};

module.exports = cfg;
