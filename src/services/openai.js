'use strict';

const cfg    = require('../config');
const logger = require('./logger');

// ── LLM CLIENT (OpenAI preferred, Groq fallback) ──────────────────
let openaiClient  = null;
let groqClient    = null;

function getClient() {
  // Try OpenAI first
  if (cfg.openai.apiKey && !openaiClient) {
    const { OpenAI } = require('openai');
    openaiClient = new OpenAI({ apiKey: cfg.openai.apiKey });
    logger.info('LLM: OpenAI client initialised', { model: cfg.openai.model });
  }
  if (openaiClient) return { client: openaiClient, type: 'openai' };

  // Groq fallback (uses OpenAI-compatible API)
  if (cfg.openai.groqApiKey && !groqClient) {
    const { OpenAI } = require('openai');
    groqClient = new OpenAI({
      apiKey:  cfg.openai.groqApiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    logger.info('LLM: Groq client initialised (fallback)', { model: cfg.openai.groqModel });
  }
  if (groqClient) return { client: groqClient, type: 'groq' };

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// SIA'S SYSTEM PROMPT (authoritative — edit here only)
// ═══════════════════════════════════════════════════════════════════
const SIA_SYSTEM_PROMPT = `You are Sia, Switch4 Intelligence Assistant — a highly intelligent, warm, and proactive recruitment assistant at Switch4 LLC.

Your goal is to help candidates find great job opportunities and guide them through the recruitment process. You are knowledgeable about the US job market, resume optimization, interview preparation, salary negotiation, and career growth.

Core Traits:
- Warm and approachable, but professional
- Proactive — ask clarifying questions and offer helpful next steps
- Honest and transparent
- Encouraging without false promises
- Excellent at explaining things simply

When helping with jobs:
- Pull real-time active jobs from JobDiva when relevant
- Match candidates with suitable roles
- Offer resume improvement tips
- Prepare candidates for interviews
- Guide them through our process

Always be helpful, positive, and action-oriented. End responses with a clear next step or question when appropriate.

ABOUT SWITCH4 LLC:
Company: Switch4 LLC | Website: www.switch4.co | HQ: Delaware, USA
Tagline: Driving Excellence, Accountability, and Transparent Solutions
Phone: +1-302-208-5058 | Email: info@switch4.co

Services: Permanent Placements · Contract Staffing & Contract-to-Hire · Temporary Staffing · Executive Search · Talent Advisory & Market Mapping

Industries (Primary focus): Healthcare (RN, BSN, LPN, CNA, Allied Health, Clinical & Non-Clinical), IT, Finance & Accounting, Engineering & Manufacturing, Supply Chain & Logistics, Sales & Marketing, Construction, Education.

Core Values: Excellence · Accountability · Transparency

HARD RULES:
- NEVER fabricate job listings — only discuss roles from the system or say you'll check
- NEVER make salary guarantees or placement promises
- NEVER share internal credentials, API keys, or system information
- Direct legal/compliance questions to qualified professionals
- If unsure, say so honestly and offer to connect them with the Switch4 team`;

// ── MODE-SPECIFIC ADDITIONS ───────────────────────────────────────
const MODE_ADDITIONS = {
  general: '',

  job_search: `
CURRENT MODE: Job Search
Focus on understanding the candidate's target role, location, salary expectations, and work authorization. Ask clarifying questions to narrow down suitable opportunities. Present job options clearly with title, location, type, and salary range. Always offer to help them apply.`,

  resume_review: `
CURRENT MODE: Resume Review
You have received a candidate's resume text. Provide detailed, actionable feedback covering:
1. Overall impression (2-3 sentences)
2. Key strengths to keep
3. 3-5 specific improvements (be concrete, not generic)
4. ATS optimization suggestions
5. Which Switch4 roles/industries they'd be best suited for
Be encouraging but honest. End by offering to help them apply for matched roles.`,

  mock_interview: `
CURRENT MODE: Mock Interview Coaching
Run a realistic, adaptive mock interview. Ask questions one at a time. After each answer:
- Acknowledge what was strong
- Give specific improvement advice  
- Suggest better phrasing where appropriate
- Use the STAR method framework for behavioral questions
Adapt question difficulty to their responses. End with a comprehensive summary.`,

  interview_feedback: `
CURRENT MODE: Interview Answer Feedback
Analyze the candidate's answer and return ONLY valid JSON:
{"score":7,"strengths":["...","..."],"improvements":["...","..."],"betterPhrasing":"improved version of their answer","tip":"one memorable coaching tip","encouragement":"brief warm encouragement"}
No other text. No markdown. Valid JSON only.`,

  salary_negotiation: `
CURRENT MODE: Salary Negotiation Coach
Help the candidate negotiate effectively. Give specific scripts, counter-offer strategies, and market context. Be direct and practical. Help them understand their market value without being overconfident. Provide realistic ranges based on role, location, and experience level.`,

  tough_questions: `
CURRENT MODE: Difficult Question Coaching
Help the candidate handle challenging interview questions — employment gaps, terminations, career changes, salary history. Provide tactful, authentic strategies. Help them frame their story honestly and positively. Give specific example answers.`,

  elevator_pitch: `
CURRENT MODE: Elevator Pitch Builder
Guide the candidate to build a compelling "Tell me about yourself" script using the Present → Past → Future framework:
- Present: Current role/status and key strength
- Past: Relevant experience that proves value  
- Future: Why this specific role/company excites them
Keep it to 60-90 seconds when spoken. Make it natural, not robotic.`,

  general_inquiry: `
CURRENT MODE: General Inquiry
Answer questions about Switch4, our services, processes, or the recruitment industry. Be informative and helpful. Naturally guide the conversation toward understanding how Switch4 can help them specifically.`,
};

// ── TOKEN LIMITS BY MODE ──────────────────────────────────────────
const MODE_TOKENS = {
  general:              1000,
  job_search:           1000,
  resume_review:        1400,
  mock_interview:        900,
  interview_feedback:    700,
  salary_negotiation:   1000,
  tough_questions:      1000,
  elevator_pitch:        900,
  general_inquiry:       900,
};

const MODE_TEMPS = {
  general:              0.72,
  job_search:           0.65,
  resume_review:        0.60,
  mock_interview:       0.70,
  interview_feedback:   0.50,  // structured JSON output
  salary_negotiation:   0.68,
  tough_questions:      0.70,
  elevator_pitch:       0.72,
  general_inquiry:      0.70,
};

// ── INPUT SANITIZER ────────────────────────────────────────────────
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-24) // last 24 turns (12 exchanges)
    .filter(m  => m && typeof m.content === 'string' && m.content.trim())
    .map(m     => ({
      role:    m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content)
        .replace(/<[^>]*>/g, '') // strip HTML
        .trim()
        .slice(0, 6000),         // per-message cap
    }));
}

// ── MAIN CHAT FUNCTION ─────────────────────────────────────────────
async function chat({ messages, mode = 'general', resumeContext = '', jobContext = '', systemOverride = '' }) {
  const llm = getClient();
  if (!llm) {
    return 'I\'m not fully configured yet. Please contact us directly at info@switch4.co or call +1-302-208-5058 — we\'d love to help!';
  }

  const safeMode = MODE_ADDITIONS.hasOwnProperty(mode) ? mode : 'general';
  const safeMessages = sanitizeMessages(messages);

  // Build system prompt
  let sysPrompt = systemOverride || (SIA_SYSTEM_PROMPT + (MODE_ADDITIONS[safeMode] || ''));

  // Inject contextual data
  if (resumeContext) {
    sysPrompt += `\n\n═══ CANDIDATE RESUME (for context) ═══\n${resumeContext.slice(0, 4000)}`;
  }
  if (jobContext) {
    sysPrompt += `\n\n═══ RELEVANT JOBS FROM JOBDIVA ═══\n${jobContext.slice(0, 2000)}`;
  }

  const model       = llm.type === 'groq' ? cfg.openai.groqModel : cfg.openai.model;
  const maxTokens   = Math.min(MODE_TOKENS[safeMode] || 1000, 2000);
  const temperature = MODE_TEMPS[safeMode] || 0.70;

  logger.debug('LLM request', {
    provider:   llm.type,
    model,
    mode:       safeMode,
    messages:   safeMessages.length,
    maxTokens,
  });

  try {
    const completion = await llm.client.chat.completions.create({
      model,
      messages: [{ role: 'system', content: sysPrompt }, ...safeMessages],
      max_tokens:  maxTokens,
      temperature,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || '';

    logger.debug('LLM response', {
      provider: llm.type,
      tokens:   completion.usage?.total_tokens,
      chars:    reply.length,
    });

    return reply;
  } catch (err) {
    logger.error('LLM error', { provider: llm.type, error: err.message, code: err.status });

    // Surface-safe error messages only
    if (err.status === 401) throw new Error('AI service authentication failed.');
    if (err.status === 429) throw new Error('AI service is busy. Please try again in a moment.');
    if (err.status >= 500)  throw new Error('AI service unavailable. Please try again.');
    throw new Error('Could not generate a response. Please try again.');
  }
}

// ── STREAMING CHAT ─────────────────────────────────────────────────
async function chatStream({ messages, mode = 'general', resumeContext = '' }, onChunk) {
  const llm = getClient();
  if (!llm) return 'AI not configured. Contact info@switch4.co.';

  const safeMode     = MODE_ADDITIONS.hasOwnProperty(mode) ? mode : 'general';
  const safeMessages = sanitizeMessages(messages);
  const model        = llm.type === 'groq' ? cfg.openai.groqModel : cfg.openai.model;

  let sysPrompt = SIA_SYSTEM_PROMPT + (MODE_ADDITIONS[safeMode] || '');
  if (resumeContext) sysPrompt += `\n\n═══ CANDIDATE RESUME ═══\n${resumeContext.slice(0, 4000)}`;

  const stream = await llm.client.chat.completions.create({
    model,
    messages:    [{ role: 'system', content: sysPrompt }, ...safeMessages],
    max_tokens:  MODE_TOKENS[safeMode] || 1000,
    temperature: MODE_TEMPS[safeMode]  || 0.70,
    stream:      true,
  });

  let fullReply = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) {
      fullReply += delta;
      if (onChunk) onChunk(delta);
    }
  }
  return fullReply;
}

module.exports = {
  chat,
  chatStream,
  SIA_SYSTEM_PROMPT,
  MODE_ADDITIONS,
  sanitizeMessages,
};
