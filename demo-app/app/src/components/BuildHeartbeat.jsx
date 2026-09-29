import { useEffect } from 'react';
import { authHeaders } from '../lib/authHeader';
import { APP_BUILD, TAB_ID } from '../lib/appBuild';
import { pendingPunchCount, isTimeStub } from '../lib/timeApi';

// Fleet build telemetry (Sept 1 hardening). Every authed session periodically
// reports its build + buffered-punch counts to /api/state/heartbeat so the
// office can SEE stale phones and stuck labor instead of discovering them
// through missing payroll months later. Old builds can't report — which is the
// point: on the Settings → Team card, silence IS the stale signal. Fire-and-
// forget everywhere: telemetry must never break or slow the app.
const BEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — cadence only needs day-grain

export default function BuildHeartbeat() {
  useEffect(() => {
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
            tab: TAB_ID,
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
