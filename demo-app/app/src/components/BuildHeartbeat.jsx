import { useEffect } from 'react';
import { authHeaders } from '../lib/authHeader';
import { isAuthConfigured } from '../lib/supabaseClient';
import { APP_BUILD, deviceKey } from '../lib/appBuild';
import { pendingPunchCount, isTimeStub } from '../lib/timeApi';

// Fleet build telemetry (Sept 1 hardening). Every authed session periodically
// reports its build + buffered-punch counts to /api/state/heartbeat so the
// office can SEE stale phones and stuck labor instead of discovering them
// through missing payroll months later. Old builds can't report — which is the
// point: on the Settings → Team card, silence IS the stale signal. Fire-and-
// forget everywhere: telemetry must never break or slow the app.
//
// CS-651: only where there IS a backend session to report with. The login-free demo (no
// Supabase auth configured) has none, so the route could only answer 401 — on every page, every
// visit, hiding real errors among them. The rule is the one the other server-only pings use
// (lib/supabaseClient isAuthConfigured: lib/push's flush backend, main.jsx's service worker, the
// store's shared sync); with no session there is no beat, no 6-hour timer and no listener.
const BEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — cadence only needs day-grain

export default function BuildHeartbeat() {
  useEffect(() => {
    if (!isAuthConfigured()) return undefined;
    let alive = true;
    const beat = async () => {
      if (!alive) return;
      try {
        const [pending, withFailed] = await Promise.all([
          pendingPunchCount(),
          pendingPunchCount({ includeFailed: true }),
        ]);
        const auth = await authHeaders();
        await fetch('/api/state/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({
            build: APP_BUILD,
            tab: deviceKey(), // one row per device, not per launch (CS-727)
            pendingPunches: pending,
            failedPunches: Math.max(0, withFailed - pending),
            stub: isTimeStub(), // informational; prod builds can no longer stub
          }),
        });
      } catch { /* best-effort */ }
    };
    beat();
    const onVisible = () => { if (document.visibilityState === 'visible') beat(); };
    document.addEventListener('visibilitychange', onVisible);
    const id = setInterval(beat, BEAT_INTERVAL_MS);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, []);
  return null;
}
