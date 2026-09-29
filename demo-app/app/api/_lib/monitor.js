// Provider-agnostic error/alert sink for the serverless side.
//
// WHY THIS EXISTS: the app emits excellent, DELIBERATE alarms — org_state
// baseline-integrity mismatch, crew_assignments sync failure, the pre-1e direct-write
// fallback — but every one of them only `console.error`s into Vercel function logs,
// which are ephemeral and unalerted. Nobody sees them until users complain (that is
// exactly how the 2026-08-03 timezone/lockout incident stayed invisible). This routes
// those alarms somewhere a human is actually paged.
//
// ZERO external dependency, SAFE BY DEFAULT. With nothing configured it writes ONE
// structured, greppable `[ALERT] <tag>` line so a Vercel log drain / alert rule can
// match it. Set `ALERT_WEBHOOK_URL` (a Slack or Discord incoming-webhook, or any
// endpoint that accepts `{ text }`) to get real-time pages. It is fire-and-forget with
// a short timeout and can NEVER throw or delay the request it reports on — an alarm
// path that can crash the handler is worse than the condition it reports. (A full
// Sentry SDK can be dropped in behind this same seam later if traces/releases are
// wanted; keeping the seam here is what makes that a contained change.)

import { IDENTITY } from '../../src/brand/identity.generated.js';
export function reportError(tag, err, extra = {}) {
  const message = err && err.message ? err.message : String(err == null ? 'unknown' : err);
  const record = { tag, message, ...extra, at: new Date().toISOString(), app: 'cleanspace' };

  // Always land a structured, greppable line in the function logs.
  try { console.error('[ALERT]', tag, JSON.stringify(record)); } catch { console.error('[ALERT]', tag, message); }

  // Optional real-time page. Fire-and-forget — never awaited by the caller.
  const url = process.env.ALERT_WEBHOOK_URL || '';
  if (!url) return;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
    const extraKeys = Object.keys(extra);
    const text = `:rotating_light: *${IDENTITY.wordmark} alert* — \`${tag}\`\n${message}`
      + (extraKeys.length ? `\n\`\`\`${JSON.stringify(extra)}\`\`\`` : '');
    Promise.resolve(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      }),
    ).catch(() => {}).finally(() => { if (timer) clearTimeout(timer); });
  } catch {
    /* never let alerting break the request */
  }
}
