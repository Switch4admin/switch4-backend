'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const MAX_TEXT = 8000; // cap extracted text to stay within token budget

async function extractPDF(filePath) {
  try {
    const pdfParse = require('pdf-parse');
    const buffer   = fs.readFileSync(filePath);
    const result   = await pdfParse(buffer);
    return (result.text || '').trim().slice(0, MAX_TEXT);
  } catch (err) {
    logger.warn('Extractor: PDF failed', { error: err.message, filePath });
    return '';
  }
}

async function extractDOCX(filePath) {
  try {
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ path: filePath });
    return (result.value || '').trim().slice(0, MAX_TEXT);
  } catch (err) {
    logger.warn('Extractor: DOCX failed', { error: err.message, filePath });
    return '';
  }
}

function extractTXT(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim().slice(0, MAX_TEXT);
  } catch (err) {
    logger.warn('Extractor: TXT failed', { error: err.message, filePath });
    return '';
  }
}

async function extractText(filePath, mimeType) {
  if (!filePath || !fs.existsSync(filePath)) return '';

  const mime = (mimeType || '').toLowerCase();
  const ext  = path.extname(filePath).toLowerCase();

  if (mime.includes('pdf')  || ext === '.pdf')                   return extractPDF(filePath);
  if (mime.includes('word') || ext === '.docx' || ext === '.doc') return extractDOCX(filePath);
  if (mime.includes('text') || ext === '.txt')                   return extractTXT(filePath);

  logger.warn('Extractor: unsupported type', { mimeType, ext });
  return '';
}

module.exports = { extractText };
