// ─────────────────────────────────────────────────────────────────────────────
// Concierge knowledge + local "brain" + client-side action registry.
//
// This is the demo-only knowledge layer for the prospect-facing chat concierge:
//
//   1. Suggested-prompt chips, the opening greeting, and the AI disclosure.
//   2. The client-side ACTION vocabulary the bot can drive (navigate the tour,
//      add a module to the cart, open the cart, go to checkout) + validation so
//      the bot can never reference a module/route that doesn't exist.
//   3. `runStubConcierge()` — a grounded, no-network fallback brain. It keyword-
//      matches the prospect's message against the live module catalog + the tour
//      info-points and returns the same { reply, actions } shape the backend
//      returns. This is what powers the widget in local `dev:demo` (no API key)
//      and is the graceful-degradation path if the OpenAI proxy is down or its
//      budget is exhausted in production.
//
// Source of truth is `modules.catalog.js` (display copy + prices) and
// `tour/infoPoints.js` (navigable surfaces) — never hardcode product facts here.
// ─────────────────────────────────────────────────────────────────────────────

import { CORE, MODULE_CATALOG, getModule, formatPrice } from '../modules.catalog';
import { INFO_POINTS } from '../tour/infoPoints';

export const CONCIERGE_GREETING =
  "Hi! I'm the PolishPoint concierge 👋 Ask me what the platform does, what any " +
  "module costs, or say “show me the pipeline” and I'll take you straight there.";

export const CONCIERGE_DISCLOSURE =
  'AI concierge — answers can be imperfect. Pricing is confirmed at checkout.';

export const SUGGESTED_PROMPTS = [
  "What's included in the Core platform?",
  'How much is Email Marketing?',
  'Show me the sales pipeline',
  'Which add-ons can I get?',
];

// ───────────────────────── Action vocabulary ─────────────────────────
// The bot returns a list of these; the widget executes them. Keeping the shape
// tiny + validated means a hallucinated id/route is dropped rather than acted on.
//
//   { type: 'navigate', route, label? }   — react-router navigate (drives the tour)
//   { type: 'addToCart', moduleId }       — useCart().add(moduleId)
//   { type: 'openCart' }                  — open the cart drawer
//   { type: 'checkout' }                  — navigate('/checkout')

// Navigable surfaces, derived from the tour info-points so the concierge and the
// info-pin tour can never drift out of sync. Each entry carries match aliases.
const NAV_ALIASES = {
  dashboard: ['dashboard', 'home', 'command center', 'overview'],
  schedule: ['schedule', 'scheduling', 'calendar', 'jobs', 'day'],
  clients: ['crm', 'contacts', 'clients', 'accounts', 'customers', 'people', 'database'],
  pipeline: ['pipeline', 'deals', 'kanban', 'sales pipeline', 'stages'],
  invoices: ['invoice', 'invoices', 'payments', 'billing'],
  marketing: ['marketing', 'cold email', 'sequences', 'outbound', 'drip'],
  settings: ['settings', 'company', 'team', 'roles', 'permissions', 'services'],
};

export const NAV_TARGETS = INFO_POINTS.map((p) => ({
  key: p.key,
  route: p.path,
  title: p.title,
  aliases: NAV_ALIASES[p.key] || [p.key],
}));

const KNOWN_ROUTES = new Set([...NAV_TARGETS.map((t) => t.route), '/checkout']);

// Keyword → module-id map for detecting which add-on a prospect means. Order
// matters — detectModule returns the first match — so put more specific phrases
// before broad ones (e.g. "sales automation" before bare "automation").
const MODULE_KEYWORDS = {
  marketing: ['email marketing', 'cold email', 'warm outreach', 'email sequence', 'outbound', 'drip', 'marketing'],
  ipr: ['invoicing', 'quoting', 'quote', 'quotes', 'invoice & payment', 'payment routing', 'online payment', 'card payment', 'ipr', 'billing engine'],
  forms: ['form builder', 'forms', 'lead capture', 'lead-capture', 'web form', 'intake form', 'submission'],
  sms: ['sms', 'texting', 'text message', 'twilio', 'a2p', '10dlc'],
  quickbooks: ['quickbooks', 'qbo', 'accounting sync', 'the books'],
  fieldops: ['field ops', 'fieldops', 'checklist', 'before/after', 'before and after', 'job completion', 'gps'],
  ems: ['employee management', 'ems', ' hr ', 'onboarding', 'certifications', 'clock-in', 'clock in', 'payroll', 'gusto', 'time-off', 'time off'],
  inventory: ['inventory', 'stock', 'low-stock', 'low stock', 'supplies', 'physical keys', 'key tracking'],
  salesautomation: ['sales automation', 'automation', 'workflow', 'workflows', 'timed workflow', 'follow-up automation', 'triggers'],
  datamigration: ['data migration', 'migration', 'migrate', 'import my data', 'gohighlevel', 'ghl', 'csv import'],
};

function detectModule(text) {
  for (const [id, words] of Object.entries(MODULE_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) return getModule(id);
  }
  // Last resort: match against the catalog display names directly.
  return MODULE_CATALOG.find((m) => text.includes(m.name.toLowerCase())) || null;
}

function detectNavTarget(text) {
  for (const t of NAV_TARGETS) {
    if (t.aliases.some((a) => text.includes(a))) return t;
  }
  return null;
}

// Validate + normalize a list of actions (from the backend OR the stub) so the
// widget only ever executes well-formed, real targets.
export function normalizeActions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    switch (a.type) {
      case 'navigate':
        if (typeof a.route === 'string' && KNOWN_ROUTES.has(a.route)) {
          out.push({ type: 'navigate', route: a.route, label: a.label || null });
        }
        break;
      case 'addToCart':
        if (getModule(a.moduleId) && a.moduleId !== 'core') {
          out.push({ type: 'addToCart', moduleId: a.moduleId });
        }
        break;
      case 'openCart':
        out.push({ type: 'openCart' });
        break;
      case 'checkout':
        out.push({ type: 'checkout' });
        break;
      default:
        break;
    }
  }
  return out;
}

// ───────────────────────── Local stub brain ─────────────────────────
// Grounded, deterministic answers built from the catalog. Intentionally simple
// keyword routing — good enough to make the demo shine offline and to cover for
// the live LLM when it's unavailable. Returns { reply, actions }.

const VERB_NAVIGATE = /\b(show|see|view|open|go to|take me|tour|visit|navigate|where)\b/;
const VERB_ADD = /\b(add|want|include|get|buy|purchase|enable|i'?ll take)\b/;
const list = (arr) => arr.map((s) => `• ${s}`).join('\n');
// Human-readable list of every add-on name, derived from the catalog so it never
// drifts as modules are added/renamed.
const ADDON_NAMES = MODULE_CATALOG.map((m) => m.name).join(', ');

function modulePitch(m) {
  return (
    `${m.icon} **${m.name}** — ${formatPrice(m.price)} one-time.\n\n` +
    `${m.longDescription}\n\n` +
    `${list(m.features.slice(0, 5))}\n\n` +
    `Want me to add it to your order, or show you around the platform first?`
  );
}

export function runStubConcierge(rawText, context = {}) {
  const text = String(rawText || '').toLowerCase().trim();
  const cartIds = Array.isArray(context.cartIds) ? context.cartIds : [];

  if (!text) {
    return { reply: CONCIERGE_GREETING, actions: [] };
  }

  // Resolve any module / navigable surface mentioned up front so intent branches
  // below can reference them.
  const mod = detectModule(text);
  const navTarget = detectNavTarget(text);

  // Greeting
  if (/^(hi|hey|hello|yo|howdy|good (morning|afternoon|evening))\b/.test(text)) {
    return { reply: CONCIERGE_GREETING, actions: [] };
  }

  // Checkout intent
  if (/\b(check ?out|pay now|place (my )?order|buy now|finish|complete (my )?order)\b/.test(text)) {
    return {
      reply: "Great — taking you to checkout. Your order always starts with the " +
        `${formatPrice(CORE.price)} Core platform, plus any add-ons you've selected.`,
      actions: [{ type: 'checkout' }],
    };
  }

  // Add-to-cart intent (an add verb + a recognized module). Checked BEFORE the
  // cart-summary branch so "add Field Ops to my order" adds the module rather
  // than matching on the word "order" and merely opening the cart.
  if (mod && VERB_ADD.test(text)) {
    const already = cartIds.includes(mod.id);
    return {
      reply: already
        ? `${mod.name} is already in your order (${formatPrice(mod.price)}). Anything else you'd like to add?`
        : `Added **${mod.name}** to your order — ${formatPrice(mod.price)} one-time. ` +
          `Say "checkout" when you're ready, or keep exploring.`,
      actions: already ? [] : [{ type: 'addToCart', moduleId: mod.id }],
    };
  }

  // Cart / "what have I picked"
  if (/\b(cart|my order|what (have|did) i|basket|selected)\b/.test(text)) {
    const items = cartIds.map(getModule).filter(Boolean);
    const reply = items.length
      ? `You've added ${items.length} add-on${items.length > 1 ? 's' : ''}: ` +
        `${items.map((m) => m.name).join(', ')}. With the ${formatPrice(CORE.price)} Core ` +
        `platform, that's ${formatPrice(CORE.price + items.reduce((s, m) => s + m.price, 0))} one-time. ` +
        `Opening your cart so you can review.`
      : `Your order includes the ${formatPrice(CORE.price)} Core platform so far — no add-ons yet. ` +
        `Opening your cart; explore the demo and add modules as you go.`;
    return { reply, actions: [{ type: 'openCart' }] };
  }

  // Navigate / "show me X" intent
  if (navTarget && (VERB_NAVIGATE.test(text) || /\bdemo\b/.test(text))) {
    return {
      reply: `Sure — opening **${navTarget.title}**. Look for the pinging "i" beside the ` +
        `page title for a quick explainer.`,
      actions: [{ type: 'navigate', route: navTarget.route, label: navTarget.title }],
    };
  }

  // Pricing intent
  if (/\b(price|pricing|cost|how much|fee|fees|\$)\b/.test(text)) {
    if (mod) {
      return { reply: `${mod.name} is ${formatPrice(mod.price)} as a one-time add-on.`, actions: [] };
    }
    const addonLines = MODULE_CATALOG.map((m) => `• ${m.name} — ${formatPrice(m.price)}`);
    return {
      reply: `Every plan starts with the **Core platform** at ${formatPrice(CORE.price)} one-time. ` +
        `Add-on modules are à la carte:\n\n${addonLines.join('\n')}\n\n` +
        `Which one would you like to hear more about?`,
      actions: [],
    };
  }

  // "What's included / Core / features"
  if (/\b(included|core|what do i get|comes with|base plan|out of the box)\b/.test(text)) {
    return {
      reply: `The **${CORE.name}** (${formatPrice(CORE.price)}) is the foundation every plan includes:\n\n` +
        `${list(CORE.features)}\n\n` +
        `Everything else — ${ADDON_NAMES} — is an optional add-on. Want details on any of them?`,
      actions: [],
    };
  }

  // "What add-ons / modules / options"
  if (/\b(add-?ons?|modules?|options|what can i add|upgrades?)\b/.test(text)) {
    const lines = MODULE_CATALOG.map((m) => `${m.icon} **${m.name}** (${formatPrice(m.price)}) — ${m.blurb}`);
    return {
      reply: `Here are the add-on modules you can layer onto Core:\n\n${lines.join('\n\n')}\n\n` +
        `Say "tell me about Field Ops" for details, or "add Email Marketing" to drop one in your order.`,
      actions: [],
    };
  }

  // Describe a specific module ("what is / tell me about <module>")
  if (mod) {
    return { reply: modulePitch(mod), actions: [] };
  }

  // Fallback
  return {
    reply: "I'm the PolishPoint product concierge — I can explain what the platform does, " +
      'break down pricing for Core and any add-on module, walk you through a feature, or add ' +
      'modules to your order. Try one of the suggestions below, or ask me about a specific feature.',
    actions: [],
  };
}
