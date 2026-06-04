// ─────────────────────────────────────────────────────────────────────────────
// Demo concierge adapter — frontend interface for the prospect-facing chat bot.
//
// IMPORTANT — this adapter intentionally does NOT follow the IS_DEMO hard-pin
// used by lib/twilio.js, lib/email.js, and lib/push.js. Those are pinned to stub
// in the demo so a sales demo can never trigger a real side effect (sending an
// SMS/email/push). The concierge is different: it's a READ-ONLY Q&A endpoint,
// exactly like the demo's Stripe checkout (api/checkout.js), which already talks
// to a real backend in the demo. So the concierge is allowed to reach its
// backend in the demo build too.
//
// Resolution order:
//   • VITE_ASSISTANT_BACKEND_URL set  → POST there (the OpenAI proxy, /api/assistant).
//   • unset, OR the backend errors    → grounded local stub (conciergeKnowledge.js).
//
// That means local `dev:demo` (no env, no key) gets a fully working, grounded
// concierge for free, and the deployed demo lights up the live LLM just by
// setting the env var — with automatic, silent fallback to the stub if the proxy
// is unconfigured, disabled, rate-limited, or over budget.
// ─────────────────────────────────────────────────────────────────────────────

import { runStubConcierge, normalizeActions } from '../demo/assistant/conciergeKnowledge';

const BACKEND =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ASSISTANT_BACKEND_URL) || null;

export const ASSISTANT_BACKEND_URL = BACKEND;

const REQUEST_TIMEOUT_MS = 20000;

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i].content;
  }
  return '';
}

/**
 * Ask the concierge. Returns { reply: string, actions: Action[], source }.
 *
 * @param {Object} args
 * @param {{role:'user'|'assistant', content:string}[]} args.messages — full turn history
 * @param {{ cartIds?: string[] }} [args.context] — light app context for grounding
 * @param {AbortSignal} [args.signal] — optional caller abort
 */
export async function askConcierge({ messages, context = {}, signal } = {}) {
  const history = Array.isArray(messages) ? messages : [];

  if (BACKEND) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      // Caller can also abort (e.g. widget unmounts mid-flight).
      if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

      const res = await fetch(BACKEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, context }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        return {
          reply: typeof data.reply === 'string' && data.reply.trim()
            ? data.reply
            : "Sorry — I didn't catch that. Could you rephrase?",
          actions: normalizeActions(data.actions),
          source: 'backend',
        };
      }
      // 503 (not configured / disabled), 429 (rate limited), 5xx → fall through
      // to the stub so the demo never shows a dead concierge.
    } catch {
      /* network error / timeout / abort → fall through to stub */
    }
  }

  const { reply, actions } = runStubConcierge(lastUserMessage(history), context);
  return { reply, actions: normalizeActions(actions), source: 'stub' };
}
