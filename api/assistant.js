// POST /api/assistant  { messages: [{role,content}], context: { cartIds } }
//                       ->  { reply: string, actions: Action[] }
// GET  /api/assistant   ->  { ok, configured, enabled }   (health check, no spend)
//
// Server-side OpenAI proxy for the prospect-facing demo concierge. The OpenAI key
// lives ONLY here (server env) — never in the browser, same posture as the Stripe
// key in api/checkout.js. Same-origin call (saasassinsdev.com/polishpoint ->
// /api/assistant), so no CORS.
//
// The model is grounded on the module catalog (names + SERVER-SIDE prices from
// _modules.js, so it can't misquote pricing) and given a small tool surface to
// drive the demo: navigate the tour, add a module to the cart, open the cart, go
// to checkout. The browser executes the returned actions.
//
// Env:
//   OPENAI_API_KEY    required to go live; without it this returns 503 and the
//                     frontend silently falls back to its grounded local stub.
//   OPENAI_MODEL      optional, default 'gpt-4o-mini' (cheap + fast for grounded Q&A).
//   DEMO_CHAT_ENABLED optional kill switch; set to 'false' to disable (also 503).
//
// Uses the global fetch on Vercel's Node runtime — no SDK dependency to install.

const { MODULES } = require('./_modules');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Add-on display blurbs for grounding. Names + prices come from _modules.js (the
// price source of truth); keep these blurbs in step with src/demo/modules.catalog.js.
const ADDON_BLURBS = {
  marketing: 'Multi-step cold-email sequences with shared rotation inboxes and reply-to-pipeline routing.',
  ipr: 'Online card payments (Stripe), customizable invoice templates, automated overdue reminders, recurring billing.',
  quickbooks: 'Two-way sync with QuickBooks Online — customers, invoices, and payments — with AR aging.',
  inventory: 'Track physical client keys per site plus general supplies/equipment, with low-stock alerts.',
  ems: 'HR layer: document storage with expiry, certifications, GPS clock-in/out, digital onboarding, payroll via Gusto.',
  fieldops: 'Digital cleaning checklists, before/after photos, and GPS job-completion verification — works offline.',
};

const CORE_FEATURES = [
  'Operations Dashboard', 'Scheduling & Calendar', 'Client Database (Contacts + Accounts)',
  'Sales Pipeline', 'Messaging Suite', 'SMS via Twilio + A2P',
  'Invoice & Payment logging', 'Automated Reminders', 'Team, Roles & Permissions',
];

// Navigable tour surfaces the bot can send a prospect to (route map mirrors
// src/demo/tour/infoPoints.js). Used to validate the navigate tool's target.
const FEATURE_ROUTES = {
  dashboard: '/', schedule: '/schedule', contacts: '/contacts', pipeline: '/pipeline',
  invoices: '/invoices', marketing: '/marketing', settings: '/settings',
};

const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US')}`;

function buildSystemPrompt() {
  const core = MODULES.core;
  const addonLines = Object.entries(MODULES)
    .filter(([id]) => id !== 'core')
    .map(([id, m]) => `- ${m.name} (id: ${id}) — ${dollars(m.amount)} one-time. ${ADDON_BLURBS[id] || ''}`)
    .join('\n');

  return [
    'You are the PolishPoint product concierge, a friendly, concise sales assistant embedded in an interactive product demo for a field-service operations platform (CRM, scheduling, invoicing, messaging for cleaning/service businesses).',
    '',
    'RULES:',
    '- Only discuss PolishPoint, its features, and pricing. If asked anything off-topic, briefly and politely redirect to the product.',
    '- Never invent features, prices, integrations, or guarantees. Use ONLY the facts below. If you do not know, say so and offer to connect them with the team.',
    '- Quote prices exactly as listed. All prices are one-time fees.',
    '- Keep replies short and skimmable (1-4 sentences or a short bullet list). Be warm, not pushy.',
    '- When the user asks to see/tour a feature, CALL navigate_to. When they want a module, CALL add_module_to_cart. When they want to review their order, CALL open_cart. When they are ready to buy, CALL go_to_checkout. Still give a one-line confirmation in text.',
    '',
    `CORE PLATFORM — ${core.name}, ${dollars(core.amount)} one-time (the mandatory base every plan includes). Features: ${CORE_FEATURES.join('; ')}.`,
    '',
    'OPTIONAL ADD-ON MODULES (à la carte, layered on top of Core):',
    addonLines,
    '',
    `Navigable demo surfaces for navigate_to: ${Object.keys(FEATURE_ROUTES).join(', ')}.`,
  ].join('\n');
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate_to',
      description: 'Open a specific area of the product demo so the prospect can see it (drives the guided tour).',
      parameters: {
        type: 'object',
        properties: { feature: { type: 'string', enum: Object.keys(FEATURE_ROUTES) } },
        required: ['feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_module_to_cart',
      description: 'Add an optional add-on module to the prospect\'s order.',
      parameters: {
        type: 'object',
        properties: {
          module_id: { type: 'string', enum: Object.keys(MODULES).filter((id) => id !== 'core') },
        },
        required: ['module_id'],
      },
    },
  },
  { type: 'function', function: { name: 'open_cart', description: 'Open the cart drawer so the prospect can review their selected modules.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'go_to_checkout', description: 'Send the prospect to the checkout page to complete their order.', parameters: { type: 'object', properties: {} } } },
];

// Map an OpenAI tool call to our client-side action vocabulary. Drops anything
// that doesn't resolve to a real module/route.
function toolCallToAction(call) {
  let args = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
  switch (call.function.name) {
    case 'navigate_to': {
      const route = FEATURE_ROUTES[args.feature];
      return route ? { type: 'navigate', route } : null;
    }
    case 'add_module_to_cart':
      return MODULES[args.module_id] && args.module_id !== 'core'
        ? { type: 'addToCart', moduleId: args.module_id }
        : null;
    case 'open_cart':
      return { type: 'openCart' };
    case 'go_to_checkout':
      return { type: 'checkout' };
    default:
      return null;
  }
}

// ── Best-effort, in-memory rate limit (per warm instance) ────────────────────
// A speed bump, not a guarantee — serverless instances aren't shared, so a
// production demo should back this with a durable store (Vercel KV / Upstash).
const RATE = { windowMs: 60000, max: 20 };
const hits = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE.windowMs });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE.max;
}

// Sanitize the client history: only user/assistant roles, last 12 turns, each
// capped, so a crafted client can't blow up the token bill or smuggle a system role.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

module.exports = async function handler(req, res) {
  const key = process.env.OPENAI_API_KEY;
  const enabled = process.env.DEMO_CHAT_ENABLED !== 'false';

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, configured: Boolean(key), enabled });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!enabled || !key) {
    // Frontend silently falls back to its grounded local stub on a 503.
    return res.status(503).json({ error: 'Concierge is not configured.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — give it a moment.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const messages = sanitizeMessages(body && body.messages);
  if (!messages.length) {
    return res.status(400).json({ error: 'No message provided.' });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 18000);
    const apiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 500,
        messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
        tools: TOOLS,
        tool_choice: 'auto',
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!apiRes.ok) {
      const detail = await apiRes.text().catch(() => '');
      return res.status(502).json({ error: `Upstream model error (${apiRes.status})`, detail: detail.slice(0, 300) });
    }

    const data = await apiRes.json();
    const msg = data.choices?.[0]?.message || {};
    const actions = (msg.tool_calls || []).map(toolCallToAction).filter(Boolean);

    // If the model only called a tool (no prose), synthesize a tiny confirmation.
    let reply = (msg.content || '').trim();
    if (!reply && actions.length) reply = 'On it — done.';
    if (!reply) reply = "Sorry, I didn't catch that. Could you rephrase?";

    return res.status(200).json({ reply, actions });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || 'Concierge request failed.' });
  }
};
