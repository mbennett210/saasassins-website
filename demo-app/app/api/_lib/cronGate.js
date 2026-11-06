// The one answer every cron gate gives when CRON_SECRET is NOT SET on the server (the ruling on
// CS-215 and the no-leak rule, 2026-10-12).
//
// Vercel calls a cron route with `Authorization: Bearer <CRON_SECRET>`, and every gate FAILS
// CLOSED: with no secret configured it refuses every call. That refusal is a 500, a server error,
// so cron monitoring shows the misconfiguration as a failing run (CS-215: the time crons answered
// 401, which reads like a wrong secret). Its body is ONE fixed object that names nothing, so a
// caller who has not passed the check learns nothing about the configuration (the gates used to
// say "CRON_SECRET is not configured" to anyone). The gap itself goes to the function log, by name.
//
// A wrong or missing bearer on a CONFIGURED server is each route's own 401, unchanged.
// `app/scripts/test-config-gap-refusals.mjs` drives all ten gates through their real handlers.
export const CRON_UNAVAILABLE = Object.freeze({ ok: false, error: 'unavailable' });

// Log the gap and answer it. `route` labels the log line: "[cron/reap] CRON_SECRET is not …".
export function refuseUnconfiguredCron(res, route) {
  console.error(`[${route}] CRON_SECRET is not configured: refusing every call`);
  return res.status(500).json(CRON_UNAVAILABLE);
}
