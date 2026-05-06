'use strict';

const cfg    = require('../config');
const logger = require('./logger');

let _prisma = null;

function db() {
  if (_prisma)                   return _prisma;
  if (!cfg.database.configured)  return null;

  try {
    const { PrismaClient } = require('@prisma/client');
    _prisma = new PrismaClient({
      log: cfg.isDev
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
    });
    logger.info('Database: Prisma client initialised');
  } catch (err) {
    logger.warn('Database: Prisma init failed — DB features disabled', { error: err.message });
    _prisma = null;
  }
  return _prisma;
}

// ── LEAD ──────────────────────────────────────────────────────────
async function saveLead(data) {
  const client = db();
  if (!client) return null;
  try   { return await client.lead.create({ data }); }
  catch (err) { logger.error('DB: saveLead', { error: err.message }); return null; }
}

async function updateLead(id, data) {
  const client = db();
  if (!client || !id) return null;
  try   { return await client.lead.update({ where: { id }, data }); }
  catch (err) { logger.error('DB: updateLead', { error: err.message }); return null; }
}

async function findLeadByEmail(email) {
  const client = db();
  if (!client) return null;
  try   { return await client.lead.findFirst({ where: { email: email.toLowerCase() }, orderBy: { createdAt: 'desc' } }); }
  catch (err) { logger.error('DB: findLeadByEmail', { error: err.message }); return null; }
}

// ── RESUME ────────────────────────────────────────────────────────
async function saveResume(data) {
  const client = db();
  if (!client) return null;
  try   { return await client.resume.create({ data }); }
  catch (err) { logger.error('DB: saveResume', { error: err.message }); return null; }
}

async function getResume(id) {
  const client = db();
  if (!client || !id) return null;
  try   { return await client.resume.findUnique({ where: { id } }); }
  catch (err) { logger.error('DB: getResume', { error: err.message }); return null; }
}

// ── CONTACT ───────────────────────────────────────────────────────
async function saveContact(data) {
  const client = db();
  if (!client) return null;
  try   { return await client.contact.create({ data }); }
  catch (err) { logger.error('DB: saveContact', { error: err.message }); return null; }
}

// ── SCHEDULED CALL ────────────────────────────────────────────────
async function saveSchedule(data) {
  const client = db();
  if (!client) return null;
  try   { return await client.scheduledCall.create({ data }); }
  catch (err) { logger.error('DB: saveSchedule', { error: err.message }); return null; }
}

// ── CHAT SESSION ──────────────────────────────────────────────────
async function upsertChatSession(sessionId, data) {
  const client = db();
  if (!client || !sessionId) return null;
  try {
    return await client.chatSession.upsert({
      where:  { sessionId },
      create: { sessionId, ...data },
      update: data,
    });
  } catch (err) {
    logger.error('DB: upsertChatSession', { error: err.message });
    return null;
  }
}

// ── HEALTH ────────────────────────────────────────────────────────
async function ping() {
  const client = db();
  if (!client) return false;
  try   { await client.$queryRaw`SELECT 1`; return true; }
  catch { return false; }
}

async function disconnect() {
  if (_prisma) { await _prisma.$disconnect(); _prisma = null; }
}

module.exports = {
  saveLead, updateLead, findLeadByEmail,
  saveResume, getResume,
  saveContact,
  saveSchedule,
  upsertChatSession,
  ping, disconnect,
};
