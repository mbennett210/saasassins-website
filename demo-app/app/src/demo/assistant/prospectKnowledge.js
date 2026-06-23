// ─────────────────────────────────────────────────────────────────────────────
// Prospect Q&A knowledge + local "brain" — the sales-facing chat bot for the
// PolishPoint marketing demo.
//
// Distinct from conciergeKnowledge.js (the parked product concierge, which is
// grounded on the module catalog and DRIVES the demo). This one is grounded on
// the SaaSassins sales story — pricing, ownership, timeline, stack, process,
// case studies, "what if you disappear", booking — and converts prospects via a
// light lead-capture flow. It takes no in-app actions.
//
// Facts here are the single source of truth for the bot's copy. The stub brain
// (runStubProspectBot) is the grounded, no-network fallback that powers the bot
// in local `dev:demo` (no API key) and covers for the live LLM proxy when it's
// unconfigured, rate-limited, or over budget — same { reply, offerLead } shape
// the backend returns.
//
// Source: saasassinsdev.com (home / about / showcase / contact), crawled 2026-06.
// ─────────────────────────────────────────────────────────────────────────────

// ───────────────────────── Contact / booking ─────────────────────────
// BOOKING_URL is the "Book a Strike Call" scheduling surface. The contact page
// exposes an "Open Calendar" link; until the real Calendly/scheduling URL is
// supplied, point at the contact page (easy one-line swap).
export const CONTACT = {
  email: 'hello@saasassins.com',
  bookingUrl: 'https://saasassinsdev.com/contact.html',
  responseTime: 'under 24 hours',
};

// ───────────────────────── Copy ─────────────────────────
export const PROSPECT_GREETING =
  "Hi! 👋 I can answer anything about how SaaSassins builds PolishPoint-style " +
  "software you actually **own** — pricing, timelines, the stack, what happens " +
  "after launch. Ask away, or tap a question below.";

export const PROSPECT_DISCLOSURE =
  'AI assistant — answers can be imperfect. For a firm quote, book a Strike Call.';

export const SUGGESTED_PROMPTS = [
  'How much does a custom build cost?',
  'Do I really own the code?',
  'How long does it take to build?',
  'What if SaaSassins disappears?',
];

// ───────────────────────── Case studies ─────────────────────────
const CASE_STUDIES = [
  {
    name: 'PolishPoint',
    line: 'all-in-one ops platform for a cleaning company — scheduling, CRM, invoicing, ' +
      'GPS clock-in, field ops, customer portal, native mobile app.',
    result: 'Five SaaS subscriptions cancelled. The one-time build paid for itself by month 8.',
  },
  {
    name: 'Meridian Capital Group',
    line: 'lending-ops platform for a private credit fund — deal pipeline, automated KYC/AML, ' +
      'borrower management, secure investor portal.',
    result: 'Compliance filing rate hit 100%. Deal cycle time cut by 40%.',
  },
  {
    name: 'Summit Climate Systems',
    line: 'HVAC service platform — dispatch, equipment/warranty registry, technician messaging, ' +
      'estimates and invoicing.',
    result: '312 equipment units tracked. First-fix rate up to 96%.',
  },
  {
    name: 'Pinnacle Property Group',
    line: 'property management for 284 rental units — portfolio dashboard, tenant ledger, ' +
      'maintenance work orders, tenant self-service portal.',
    result: '96.1% occupancy, 96% rent collected by the 5th, maintenance resolution down to 1.4 days.',
  },
];

// ───────────────────────── Lead detection ─────────────────────────
// Pragmatic email matcher — the widget validates the captured value too.
export const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// Phrases that signal a prospect is ready to talk to a human / get a quote.
const INTEREST_RE =
  /\b(book|schedule|set up|strike call|call|demo with|talk to|speak (to|with)|contact|get (a )?(quote|estimate)|interested|sign me up|get started|reach (out|you)|email me|how do i (start|begin|sign up))\b/;

// ───────────────────────── Local stub brain ─────────────────────────
const list = (arr) => arr.map((s) => `• ${s}`).join('\n');

const PITCH = {
  pricing:
    'Most builds land between **$3K and $15K, one-time** — scoped up front, fixed price, ' +
    'no hidden fees. After launch you pay only real infrastructure, **~$60/month** (Supabase, ' +
    'Vercel, etc.). Custom software typically breaks even around **month 8**, then it\'s pure ' +
    'savings. As a yardstick: $800/mo of SaaS over 7 years is ~$67,200 — versus ~$20,040 to own ' +
    'the equivalent custom build.',

  ownership:
    "**Yes — you own it, legally.** Full IP assignment is written into the contract, and the code " +
    "lives in **your** GitHub org from day one. Your data sits in **your** database. No escrow, no " +
    "licensing games, no vendor lock-in — it's built on a mainstream stack any developer can pick up.",

  timeline:
    '**4–12 weeks** for most projects. Internal tools: **3–5 weeks**. Full operational platforms ' +
    'with a mobile app: **8–12 weeks**. Work starts about 2–4 weeks after you accept the quote, ' +
    'with a live staging URL and weekly demos the whole way.',

  stack:
    'Deliberately boring, proven, widely-hireable tech: **Next.js + TypeScript**, **Supabase / ' +
    'Postgres**, **Vercel** for web, and **React Native + Expo** for mobile. Integrations as ' +
    'needed — Stripe, Twilio, Resend, OpenAI, Anthropic. The point: any developer can extend it, ' +
    "so you're never trapped.",

  disappear:
    "**Your business keeps running — that's the whole design.** The code is in your GitHub, the " +
    'data is in your database, and the stack is mainstream. If SaaSassins vanished tomorrow, ' +
    'nothing turns off and any React/TypeScript developer can take over.',

  process:
    'Five steps, no slides, no pressure:\n\n' +
    list([
      '**Strike Call** — a 30-min audit of what you pay now and what\'s replaceable.',
      '**Blueprint** — scope, fixed price, architecture and a delivery date, within a week.',
      '**Build** — weekly demos on a live staging URL.',
      '**Launch** — deploy to your infrastructure, migrate data, train your team.',
      '**Handoff** — GitHub repo + infrastructure access transferred to you.',
    ]),

  changes:
    'Three ways, your call: keep us on a **retainer / hourly**, **hire any React + TypeScript ' +
    'developer** (it\'s a standard stack), or have your **internal team take it over**. You\'re ' +
    'never locked to us — that\'s the point of owning the code.',

  replace:
    "Usually, yes. Nine times out of ten a team only uses **20–30%** of a SaaS tool's features — " +
    'we rebuild the part you actually use and fold several tools into one. PolishPoint, for ' +
    'instance, replaced five separate subscriptions.',

  services:
    'SaaSassins builds: custom web apps, native mobile apps, internal tools, SaaS replacements, ' +
    'AI integrations, and automation/workflow systems — all customer-owned.',
};

function caseStudyReply() {
  const lines = CASE_STUDIES.map((c) => `**${c.name}** — ${c.line}\n  ↳ ${c.result}`);
  return (
    'A few things SaaSassins has shipped:\n\n' +
    `${lines.join('\n\n')}\n\n` +
    'Want to see how this would map to your business? I can set up a Strike Call.'
  );
}

function bookingReply() {
  return (
    "Happy to set that up. The **Strike Call** is a free 30-minute audit — we look at what you're " +
    "paying now, flag what's replaceable, and if it's a fit you get a fixed-price quote within a " +
    `week.\n\nDrop your **email** here and I'll pass it to the team (replies ${CONTACT.responseTime}), ` +
    `book directly at ${CONTACT.bookingUrl}, or email ${CONTACT.email}.`
  );
}

/**
 * Grounded, deterministic keyword brain. Returns { reply, offerLead }.
 * `offerLead: true` hints the widget to invite an email (the widget captures and
 * submits any email the prospect types, regardless).
 *
 * @param {string} rawText — the prospect's latest message
 * @param {{ cartCount?: number }} [context]
 */
export function runStubProspectBot(rawText, context = {}) {
  const text = String(rawText || '').toLowerCase().trim();

  if (!text) return { reply: PROSPECT_GREETING, offerLead: false };

  // Greeting
  if (/^(hi|hey|hello|yo|howdy|sup|good (morning|afternoon|evening))\b/.test(text)) {
    return { reply: PROSPECT_GREETING, offerLead: false };
  }

  // Booking / contact intent — offer the lead path up front.
  if (INTEREST_RE.test(text)) {
    return { reply: bookingReply(), offerLead: true };
  }

  // Pricing / cost / ROI
  if (/\b(price|pricing|cost|how much|fee|fees|budget|expensive|cheap|roi|pay|\$)\b/.test(text)) {
    return { reply: PITCH.pricing, offerLead: false };
  }

  // Ownership / IP / lock-in
  if (/\b(own|owner|ownership|ip|intellectual property|license|licence|lock[- ]?in|rights|source code)\b/.test(text)) {
    return { reply: PITCH.ownership, offerLead: false };
  }

  // Timeline / how long
  if (/\b(how long|timeline|timeframe|time frame|weeks|months|fast|quick|when (can|will)|deliver|turnaround|deadline)\b/.test(text)) {
    return { reply: PITCH.timeline, offerLead: false };
  }

  // Tech stack
  if (/\b(stack|tech|technology|framework|next\.?js|react|supabase|postgres|database|language|built with|what do you use)\b/.test(text)) {
    return { reply: PITCH.stack, offerLead: false };
  }

  // "What if you disappear" / risk / continuity
  if (/\b(disappear|go out of business|shut down|bankrupt|go bust|if you (die|vanish|quit|stop)|out of business|what'?s the catch|risk|continuity)\b/.test(text)) {
    return { reply: PITCH.disappear, offerLead: false };
  }

  // Process / how it works
  if (/\b(process|how (does it|do you) work|steps|what happens|strike call|blueprint|onboard|kick ?off|getting started)\b/.test(text)) {
    return { reply: PITCH.process, offerLead: false };
  }

  // Changes / support after launch
  if (/\b(change|changes|maintenance|support|after launch|later|update|add features|fix|bug|retainer|maintain)\b/.test(text)) {
    return { reply: PITCH.changes, offerLead: false };
  }

  // Replace my SaaS tool
  if (/\b(replace|replacing|migrate (off|from)|switch (off|from)|cancel|get rid of|instead of|alternative to)\b/.test(text)) {
    return { reply: PITCH.replace, offerLead: false };
  }

  // Case studies / proof / examples
  if (/\b(case stud|example|examples|portfolio|showcase|who (have|else)|clients?|proof|results?|track record|built before|other (work|projects))\b/.test(text)) {
    return { reply: caseStudyReply(), offerLead: false };
  }

  // What do you do / services
  if (/\b(what do you (do|build|offer)|services?|mobile app|web app|automation|ai|internal tool)\b/.test(text)) {
    return { reply: PITCH.services, offerLead: false };
  }

  // Fallback — answer at a high level and open the door to a call.
  return {
    reply:
      "I can break down **pricing**, **ownership**, **timelines**, the **tech stack**, the " +
      "**build process**, or show you **case studies** — just ask. If you'd rather talk it " +
      "through, I can set up a free 30-minute Strike Call. Want me to?",
    offerLead: true,
  };
}
