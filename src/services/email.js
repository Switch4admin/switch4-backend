'use strict';

const nodemailer = require('nodemailer');
const cfg    = require('../config');
const logger = require('./logger');

// ── TRANSPORT (lazy init) ─────────────────────────────────────────
let transport = null;

function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host:   cfg.email.host,
    port:   cfg.email.port,
    secure: cfg.email.secure,
    auth:   { user: cfg.email.user, pass: cfg.email.pass },
    tls:    { rejectUnauthorized: false },
    pool:   true,
    maxConnections: 5,
  });
  return transport;
}

// ── SAFE SEND ─────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!cfg.email.configured) {
    logger.warn('Email skipped — SMTP not configured', { to, subject });
    return { skipped: true };
  }
  try {
    const info = await getTransport().sendMail({
      from:    `"${cfg.email.fromName}" <${cfg.email.fromEmail}>`,
      to,
      subject,
      html,
      text:    text || html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      replyTo: replyTo || cfg.email.recruiterEmail,
    });
    logger.info('Email sent', { to, subject, messageId: info.messageId });
    return info;
  } catch (err) {
    logger.error('Email failed', { to, subject, error: err.message });
    throw err;
  }
}

// ── BRAND COLOURS ─────────────────────────────────────────────────
const B = { teal: '#1BA8B8', green: '#2E9B5F', navy: '#0F2340' };

// ── BASE TEMPLATE ─────────────────────────────────────────────────
function baseTemplate(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>Switch4</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,${B.navy},${B.teal});border-radius:14px 14px 0 0;padding:28px 36px;text-align:center">
    <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:2px">SWITCH4</p>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:11px;letter-spacing:1px;text-transform:uppercase">Driving Excellence · Accountability · Transparency</p>
  </td></tr>
  <!-- Body -->
  <tr><td style="background:#fff;padding:36px;border-radius:0 0 14px 14px">${body}</td></tr>
  <!-- Footer -->
  <tr><td style="padding:20px 0;text-align:center">
    <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.7">
      Switch4 LLC · Newark, Delaware, USA<br>
      <a href="tel:+13022085058" style="color:#94a3b8">+1-302-208-5058</a> ·
      <a href="mailto:info@switch4.co" style="color:#94a3b8">info@switch4.co</a> ·
      <a href="https://www.switch4.co" style="color:#94a3b8">www.switch4.co</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ── HELPER PARTIALS ────────────────────────────────────────────────
const row  = (label, value) =>
  `<tr><td style="padding:6px 14px;font-weight:600;color:#475569;font-size:13px;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:6px 14px;color:#1e293b;font-size:13px">${value || '—'}</td></tr>`;

const sectionHead = (text) =>
  `<p style="margin:22px 0 8px;font-size:11px;font-weight:700;color:${B.teal};text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;padding-bottom:5px">${text}</p>`;

const cta = (text, color) =>
  `<div style="margin-top:24px;padding:14px 18px;background:${color}18;border-left:4px solid ${color};border-radius:8px">
    <p style="margin:0;font-size:12px;color:#0F2340;font-weight:600">⚡ ${text}</p>
  </div>`;

// ─────────────────────────────────────────────────────────────────
// 1. NEW LEAD NOTIFICATION
// ─────────────────────────────────────────────────────────────────
async function sendLeadNotification({ name, email, phone, role, company, type, source, targetJob, resumeId, notes }) {
  const isEmployer = type === 'EMPLOYER';
  const html = baseTemplate(`
    <h2 style="margin:0 0 4px;font-size:20px;color:${B.navy}">${isEmployer ? '🏢 New Employer Inquiry' : '👤 New Candidate Lead'}</h2>
    <p style="margin:0 0 20px;color:#64748b;font-size:13px">Source: <strong>${source || 'chatbot'}</strong> · ${new Date().toUTCString()}</p>

    ${sectionHead('Contact')}
    <table cellpadding="0" cellspacing="0" width="100%">
      ${row('Name',    `<strong>${name}</strong>`)}
      ${row('Email',   `<a href="mailto:${email}" style="color:${B.teal}">${email}</a>`)}
      ${row('Phone',   phone)}
      ${row('Company', company)}
      ${row('Role',    role)}
    </table>

    ${targetJob?.title ? `${sectionHead('Position of Interest')}<table cellpadding="0" cellspacing="0" width="100%">${row('Title', targetJob.title)}${row('Job ID', targetJob.id)}</table>` : ''}
    ${resumeId  ? `${sectionHead('Resume')}<p style="margin:0;font-size:13px;color:#374151">Resume ID: <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${resumeId}</code></p>` : ''}
    ${notes     ? `${sectionHead('Notes')}<p style="margin:0;font-size:13px;color:#374151;line-height:1.6">${notes.replace(/\n/g,'<br>')}</p>` : ''}
    ${cta('Reply within 1 business day to maintain our response standard.', B.teal)}
  `);

  return sendEmail({
    to:      cfg.email.recruiterEmail,
    subject: `${isEmployer ? '🏢' : '👤'} New ${isEmployer ? 'employer' : 'candidate'}: ${name} — Switch4`,
    html,
  });
}

// ─────────────────────────────────────────────────────────────────
// 2. CONTACT FORM
// ─────────────────────────────────────────────────────────────────
async function sendContactEmail({ role, name, email, phone, company, service, message }) {
  const recruiterHtml = baseTemplate(`
    <h2 style="margin:0 0 4px;font-size:20px;color:${B.navy}">📬 New Contact Form</h2>
    <p style="margin:0 0 20px;color:#64748b;font-size:13px">${new Date().toUTCString()}</p>
    ${sectionHead('Sender')}
    <table cellpadding="0" cellspacing="0" width="100%">
      ${row('Type',    role === 'employer' ? '🏢 Employer' : '👤 Candidate')}
      ${row('Name',    `<strong>${name}</strong>`)}
      ${row('Email',   `<a href="mailto:${email}" style="color:${B.teal}">${email}</a>`)}
      ${row('Phone',   phone)}
      ${row('Company', company)}
      ${row('Service', service)}
    </table>
    ${sectionHead('Message')}
    <p style="margin:0;color:#374151;font-size:13px;line-height:1.7">${message.replace(/\n/g,'<br>')}</p>
    ${cta('Reply within 1 business day.', B.green)}
  `);

  const autoReplyHtml = baseTemplate(`
    <h2 style="margin:0 0 10px;font-size:20px;color:${B.navy}">Hi ${name}, we received your message! ✓</h2>
    <p style="color:#475569;font-size:14px;line-height:1.75">Thank you for reaching out to Switch4. A member of our team will contact you within <strong>1 business day</strong>.</p>
    <p style="color:#475569;font-size:14px;line-height:1.75">Prefer to talk now? Call us at <a href="tel:+13022085058" style="color:${B.teal}"><strong>+1-302-208-5058</strong></a>.</p>
    <p style="color:#475569;font-size:14px;margin-top:24px">Warm regards,<br><strong>The Switch4 Team</strong></p>
    <p style="font-size:11px;color:#94a3b8;font-style:italic;margin-top:6px">Sia — Switch4 Intelligence Assistant</p>
  `);

  await Promise.allSettled([
    sendEmail({ to: cfg.email.recruiterEmail, subject: `📬 Contact: ${name} (${role}) — Switch4`, html: recruiterHtml }),
    sendEmail({ to: email, subject: `We received your message — Switch4`, html: autoReplyHtml }),
  ]);
}

// ─────────────────────────────────────────────────────────────────
// 3. RESUME RECEIVED
// ─────────────────────────────────────────────────────────────────
async function sendResumeNotification({ name, email, fileName, resumeId, analysis, cloudinaryUrl }) {
  const html = baseTemplate(`
    <h2 style="margin:0 0 4px;font-size:20px;color:${B.navy}">📄 New Resume Upload</h2>
    <p style="margin:0 0 20px;color:#64748b;font-size:13px">${new Date().toUTCString()}</p>
    ${sectionHead('Candidate')}
    <table cellpadding="0" cellspacing="0" width="100%">
      ${row('Name',      name || 'Not provided')}
      ${row('Email',     email ? `<a href="mailto:${email}" style="color:${B.teal}">${email}</a>` : '—')}
      ${row('File',      fileName)}
      ${row('Resume ID', `<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${resumeId}</code>`)}
      ${cloudinaryUrl ? row('Storage', `<a href="${cloudinaryUrl}" style="color:${B.teal}">View in Cloudinary</a>`) : ''}
    </table>
    ${analysis ? `${sectionHead('AI Analysis Preview')}<p style="margin:0;color:#374151;font-size:13px;line-height:1.7">${analysis.slice(0,600)}${analysis.length > 600 ? '…' : ''}</p>` : ''}
    ${cta('Follow up with this candidate promptly.', B.teal)}
  `);

  return sendEmail({
    to:      cfg.email.recruiterEmail,
    subject: `📄 Resume: ${fileName} — Switch4`,
    html,
  });
}

// ─────────────────────────────────────────────────────────────────
// 4. SCHEDULE CALL
// ─────────────────────────────────────────────────────────────────
async function sendScheduleNotification({ name, email, phone, slot, purpose }) {
  const recruiterHtml = baseTemplate(`
    <h2 style="margin:0 0 4px;font-size:20px;color:${B.navy}">📅 Call Booked via Sia</h2>
    <p style="margin:0 0 20px;color:#64748b;font-size:13px">${new Date().toUTCString()}</p>
    ${sectionHead('Booking')}
    <table cellpadding="0" cellspacing="0" width="100%">
      ${row('Name',    `<strong>${name}</strong>`)}
      ${row('Email',   `<a href="mailto:${email}" style="color:${B.teal}">${email}</a>`)}
      ${row('Phone',   phone)}
      ${row('Slot',    `<strong>${slot} EST</strong>`)}
      ${row('Purpose', purpose || 'Recruitment call')}
    </table>
    ${cta(`Add to your calendar and send an invite to ${email}.`, B.teal)}
  `);

  const candidateHtml = baseTemplate(`
    <h2 style="margin:0 0 10px;font-size:20px;color:${B.navy}">✅ Your call is confirmed!</h2>
    <p style="color:#475569;font-size:14px;line-height:1.75">Hi <strong>${name}</strong>,</p>
    <p style="color:#475569;font-size:14px;line-height:1.75">Your call with Switch4 is confirmed for <strong>${slot} Eastern Time</strong>. We'll send a calendar invite to this email shortly.</p>
    <p style="color:#475569;font-size:14px;line-height:1.75">Need to reschedule? Email us at <a href="mailto:info@switch4.co" style="color:${B.teal}">info@switch4.co</a> or call <a href="tel:+13022085058" style="color:${B.teal}">+1-302-208-5058</a>.</p>
    <p style="color:#475569;font-size:14px;margin-top:24px">We look forward to speaking with you!<br><strong>The Switch4 Team</strong></p>
  `);

  await Promise.allSettled([
    sendEmail({ to: cfg.email.recruiterEmail, subject: `📅 Call: ${name} at ${slot} — Switch4`, html: recruiterHtml }),
    sendEmail({ to: email, subject: `Your Switch4 call is confirmed: ${slot} EST`, html: candidateHtml }),
  ]);
}

module.exports = {
  sendEmail,
  sendLeadNotification,
  sendContactEmail,
  sendResumeNotification,
  sendScheduleNotification,
};
