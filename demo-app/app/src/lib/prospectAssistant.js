// ─────────────────────────────────────────────────────────────────────────────
// Prospect bot adapter — frontend interface for the sales-facing Q&A chat bot.
//
// Mirrors lib/demoAssistant.js (the parked product concierge's adapter): it does
// NOT follow the IS_DEMO hard-pin used by twilio/email/push, because this is a
// READ-ONLY Q&A endpoint — the same posture as the demo's live Stripe checkout
// (api/checkout.js), which already talks to a real backend in the demo.
//
// Resolution order (answers):
//   • VITE_ASSISTANT_BACKEND_URL set  → POST there (the LLM proxy), tagged mode:'prospect'.
//   • unset, OR the backend errors    → grounded local stub (prospectKnowledge.js).
//
// Lead submission (submitLead):
//   • backend set  → POST the lead so it can be delivered for real (e.g. emailed
//                    to hello@saasassins.com via Resend by the proxy).
//   • else         → persist to localStorage 'pp.demo.leads.v1' so it's never lost,
//                    and the bot points the prospect at the direct contact paths.
//
// So local `dev:demo` (no env, no key) gets a fully working, grounded bot for
// free, and the deployed demo lights up the live LLM + real lead delivery just by
// setting the env var — with automatic, silent fallback if the proxy is down.
// ─────────────────────────────────────────────────────────────────────────────

import { runStubProspectBot } from '../demo/assistant/prospectKnowledge';

const BACKEND =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ASSISTANT_BACKEND_URL) || null;

export const ASSISTANT_BACKEND_URL = BACKEND;

const LEADS_KEY = 'pp.demo.leads.v1';
const REQUEST_TIMEOUT_MS = 20000;

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i].content;
  }
  return '';
}

/**
 * Ask the prospect bot. Returns { reply: string, offerLead: boolean, source }.
 *
 * @param {Object} args
 * @param {{role:'user'|'assistant', content:string}[]} args.messages — full turn history
 * @param {{ cartCount?: number }} [args.context] — light context for grounding
 * @param {AbortSignal} [args.signal] — optional caller abort
 */
export async function askProspectBot({ messages, context = {}, signal } = {}) {
  const history = Array.isArray(messages) ? messages : [];

  if (BACKEND) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

      const res = await fetch(BACKEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'prospect', messages: history, context }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        return {
          reply: typeof data.reply === 'string' && data.reply.trim()
            ? data.reply
            : "Sorry — I didn't catch that. Could you rephrase?",
          offerLead: Boolean(data.offerLead),
          source: 'backend',
        };
      }
      // 503 (not configured / disabled), 429 (rate limited), 5xx → fall through.
    } catch {
      /* network error / timeout / abort → fall through to stub */
    }
  }

  const { reply, offerLead } = runStubProspectBot(lastUserMessage(history), context);
  return { reply, offerLead: Boolean(offerLead), source: 'stub' };
}

function persistLeadLocally(lead) {
  try {
    const raw = window.localStorage.getItem(LEADS_KEY);
    const leads = raw ? JSON.parse(raw) : [];
    leads.push(lead);
    window.localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
  } catch {
    /* quota exceeded / private mode — silently drop */
  }
}

/**
 * Submit a captured lead. Returns { ok: boolean, source }.
 * Always records locally; additionally POSTs to the backend when configured so
 * the lead can be delivered for real.
 *
 * @param {Object} args
 * @param {string} args.email — validated by the caller
 * @param {{role:string, content:string}[]} [args.messages] — transcript for context
 * @param {Object} [args.context]
 */
export async function submitLead({ email, messages = [], context = {} } = {}) {
  const lead = { email, at: new Date().toISOString(), context };
  persistLeadLocally(lead);

  if (BACKEND) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(BACKEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'lead', email, messages, context }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return { ok: true, source: 'backend' };
    } catch {
      /* fall through — already persisted locally */
    }
  }

  return { ok: true, source: 'local' };
}
