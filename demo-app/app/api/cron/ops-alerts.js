// GET /api/cron/ops-alerts — server-side OPERATIONAL-ALERT engine (#2/#3), runs
// WITHOUT a browser tab. Driven by a Vercel Cron (see vercel.json). Mirrors
// /api/reminders/run: read org_state + the relational tables the pure walkers need
// (jobs from public.jobs, punches, QC), compute what is due, then record the
// notification rows + dedup markers into org_state in a CAS-retry loop.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The detection walkers (lib/opsAlerts) also run in the client tick
// (components/OpsAlertScheduler), but that only fires while a staff tab is open —
// a shift missed at 2am produced no alert until someone opened the app. This cron
// is the tab-independent path, so late/missed/checklist/inspection alerts reach the
// supervisor even with nobody logged in (the every-minute push-dispatch cron then
// delivers the row to their phone). The client tick STAYS mounted as the fast path
// when a tab is open; the shared dedup marker (opsAlertEvents) makes the two safe to
// run together and idempotent — an alert raised by either path is a no-op for the other.
//
// The apply logic (dedup + marker retention + routing) and the bell copy are the
// SAME pure modules the reducer uses (lib/opsAlertApply, lib/opsAlertCopy), so the
// client and the cron cannot drift.
//
// ?dryRun=1 returns what WOULD raise without writing — safe against prod.

import {
  getDueShiftAlerts, getDueChecklistReminders, getDueInspectionReminders,
  opsAlertReadWindows, shiftLookbackHours, isReminderClient, liveChecklistIdsFrom,
} from '../../src/lib/opsAlerts.js';
import { opsAlertCopy } from '../../src/lib/opsAlertCopy.js';
import { applyOpsAlert } from '../../src/lib/opsAlertApply.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { getJobsInWindow } from '../_lib/jobsTable.js';
import { coveredJobIdsInWindow } from '../_lib/time/store.js';
import {
  listChecklistsInWindow, CHECKLIST_WINDOW_COLUMNS, latestInspectionPerClient, listTemplateIds,
} from '../_lib/qc/store.js';
import { dispatchDue } from '../_lib/push/dispatch.js';
import { pushConfigured } from '../_lib/push/store.js';
import { reportError } from '../_lib/monitor.js';

const CAS_RETRIES = 5;

// The complete reads can page a busy day's punches plus, when an active account has no
// recent inspection, up to a year of inspection records newest-first — headroom past
// the platform default so a heavy run finishes instead of timing out half-way.
export const config = { maxDuration: 60 };

// Gather what is due. Returns an array of walker alert records, or null when
// coverage cannot be confirmed (time-entry fetch failed) — in which case we bail
// rather than risk false late/missed alerts (same stance as the client tick).
async function computeDue(state, now) {
  const settings = state.opsSettings || {};
  const lookbackH = shiftLookbackHours(settings);

  // Jobs live in public.jobs; state.jobs is written empty by every client save, so
  // inject the near-term window the walkers need (same reason as reminders/run).
  const jobs = await getJobsInWindow({ backDays: Math.ceil(lookbackH / 24) + 1, forwardDays: 1 });
  const firedIds = new Set((state.opsAlertEvents || []).map((e) => e.id));

  // Coverage: a job with any real (non-voided, non-no-show) clock-in is not late/missed.
  // COMPLETE over the window (it used to read the newest 2000 punches — at full volume a
  // busy day's earlier punches fell off and their cleans fired false late/missed alerts).
  // A failed or incomplete read bails rather than fire on partial data.
  const windows = opsAlertReadWindows(settings, now);
  let coveredJobIds;
  try {
    coveredJobIds = new Set(await coveredJobIdsInWindow(windows.coverage));
  } catch {
    return null; // cannot confirm coverage -> do not fire
  }

  const alerts = getDueShiftAlerts({ jobs, coveredJobIds, firedIds, now, settings });

  // #3 reminders need QC records: every checklist in the walker's window, and each
  // active account's latest submitted inspection. The reads fail apart — a failed
  // checklist read must not also silence inspection reminders, or the reverse. A failed
  // read skips only its own reminders this run (a detector run on empty or partial data
  // would treat logged checklists as unlogged, or lapsed accounts as never inspected).
  // The live checklist TEMPLATE ids ride the same fail-apart read: a cleaner bound to a
  // checklist that no longer exists must not be reminded (CS-353), but a template read
  // that FAILED must not silence anyone either — so it is passed only when it resolved.
  const clientIds = (state.clients || []).filter(isReminderClient).map((c) => c.id);
  const [checklists, inspections, templates] = await Promise.allSettled([
    listChecklistsInWindow(windows.checklists, { columns: CHECKLIST_WINDOW_COLUMNS }),
    clientIds.length
      ? latestInspectionPerClient({ clientIds, sinceIso: windows.inspectionsSinceIso, untilIso: new Date(now).toISOString() })
      : [],
    listTemplateIds({ kind: 'checklist' }),   // a COMPLETE, narrow, ids-only read
  ]);
  if (checklists.status === 'fulfilled') {
    const clientsById = new Map((state.clients || []).map((c) => [c.id, c]));
    // null for a failed OR misshaped template read — the walker then skips nobody.
    const liveChecklistIds = liveChecklistIdsFrom(templates.status === 'fulfilled' ? templates.value : null);
    // Only ACTIVE roster members are judged: a deactivated cleaner left on a clean's
    // crewIds can receive nothing, and must not be named in the escalation.
    const activeUserIds = new Set((state.users || []).filter((u) => u && u.status === 'active').map((u) => u.id));
    alerts.push(...getDueChecklistReminders({ jobs, clientsById, checklists: checklists.value || [], firedIds, now, settings, liveChecklistIds, activeUserIds }));
  }
  if (inspections.status === 'fulfilled') {
    alerts.push(...getDueInspectionReminders({ clients: state.clients || [], inspections: inspections.value || [], firedIds, now, settings }));
  }

  return alerts;
}

// Turn a walker alert record into the { id, kind, recipientScope, ...copy } shape
// applyOpsAlert consumes, resolving the account name for the bell copy.
function toAlert(state, al) {
  const name = (state.clients || []).find((c) => c.id === al.clientId)?.name || 'a customer';
  // The checklist escalation names the cleaners still missing; the record carries ids
  // only (checklist_results has no name column, CS-403), so resolve them off the roster.
  const userName = (id) => (state.users || []).find((u) => u.id === id)?.name || null;
  const { title, body, url } = opsAlertCopy(al, name, { userName });
  return {
    id: al.id, kind: al.kind, recipientScope: al.recipientScope,
    clientId: al.clientId || null, jobId: al.jobId || null, crewIds: al.crewIds || [],
    title, body, url,
  };
}

// Deliver the alerts just recorded RIGHT NOW instead of waiting up to a minute for the
// every-minute /api/push/dispatch cron. Uses the SAME shared reserve-then-send core
// (_lib/push/dispatch.dispatchDue) that both that cron and /api/push/flush use; because
// it CAS-claims each row before sending, the two paths can never double-send. A push
// failure must NOT fail the alert run: the rows are already durable in org_state and the
// minute cron will catch up, so it is logged through the monitor and the outcome is
// returned for the response, never thrown.
async function flushPush({ dispatch, pushReady, report }) {
  if (!pushReady()) return { skipped: 'vapid_unconfigured' };
  try {
    return await dispatch();
  } catch (err) {
    report('ops-alerts.push-flush', err);
    return { error: err && err.message ? err.message : 'push dispatch failed' };
  }
}

// Exported + dependency-injected so the offline suite can drive the raise→dispatch
// orchestration with no Supabase and no VAPID (test-ops-alerts-cron.mjs). Production
// calls run(dryRun) with every default, so behaviour is unchanged but for the instant
// push flush after a raise.
export async function run(dryRun, {
  now = Date.now(),
  readState = readOrgState,
  writeState = writeOrgState,
  compute = computeDue,
  dispatch = dispatchDue,
  pushReady = pushConfigured,
  report = reportError,
} = {}) {
  const { state } = await readState();
  const due = await compute(state, now);
  if (due === null) return { skipped: 'time_unavailable', raised: 0 };
  if (!due.length) return { raised: 0 };
  if (dryRun) {
    // dryRun NEVER writes and NEVER dispatches — safe against prod.
    return { raised: 0, would: due.map((a) => ({ id: a.id, kind: a.kind, clientId: a.clientId, recipientScope: a.recipientScope })) };
  }

  // Record phase: idempotent CAS-retry. applyOpsAlert returns null for an alert
  // whose marker is already present, so a re-applied run (or a concurrent client
  // tick) never double-raises.
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state: fresh, version } = await readState();
    let next = fresh;
    let raised = 0;
    for (const al of due) {
      const applied = applyOpsAlert(next, toAlert(next, al), { now });
      if (!applied) continue; // already raised -> idempotent no-op
      next = { ...next, opsAlertEvents: applied.opsAlertEvents, notifications: applied.notifications };
      raised += 1;
    }
    if (raised === 0) return { raised: 0 }; // nothing new -> no write, no dispatch
    const ok = await writeState(next, version);
    if (ok) {
      // ≥1 new alert recorded -> flush push NOW (idempotent with the every-minute cron).
      const push = await flushPush({ dispatch, pushReady, report });
      return { raised, push };
    }
    // version moved under us — re-read + re-apply (markers keep it idempotent)
  }
  throw new Error('org_state write kept conflicting while raising ops alerts');
}

export default async function handler(req, res) {
  // Cron-only. Fail CLOSED (like reminders/run + push/dispatch): with no secret
  // configured, refuse rather than accept an unauthenticated call that could churn
  // org_state or force alerts.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(secret ? 401 : 500).json({ ok: false, error: secret ? 'Unauthorized' : 'CRON_SECRET is not configured' });
    return;
  }
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  try {
    const out = await run(dryRun);
    res.status(200).json({ ok: true, dryRun, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'ops-alert run failed' });
  }
}
