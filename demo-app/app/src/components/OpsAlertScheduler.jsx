// OpsAlertScheduler — the client-side tick that raises operational alerts: late &
// missed-shift (#2) and checklist / inspection reminders (#3). Mounted in App
// BackgroundServices (authed only). The pure detection lives in lib/opsAlerts (shared
// with the server cron, api/cron/ops-alerts); this component reads the covered cleans +
// the QC records the walkers need (complete over lib/opsAlerts.opsAlertReadWindows — the
// same windows the cron reads — plus each account's latest inspection), runs them, and
// dispatches RAISE_OPS_ALERT per due alert. Dedup: the reducer refuses a duplicate id
// and the module-level inFlight set guards the brief window before the dispatch lands
// (same shape as ReminderScheduler).
import { useEffect, useRef } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  getDueShiftAlerts, getDueChecklistReminders, getDueInspectionReminders, opsAlertReadWindows,
  liveChecklistIdsFrom,
} from '../lib/opsAlerts';
import * as timeApi from '../lib/timeApi';
import * as qcApi from '../lib/qcApi';
import { opsAlertCopy } from '../lib/opsAlertCopy';

const TICK_MS = 60 * 1000;
// Each account's latest inspection moves on a days scale (the reminder cadence is in
// days), and the read can walk a year of records when an account has none recent — so a
// tab re-reads it every 10 minutes, not every tick. The cron reads it fresh each run.
const INSPECTION_READ_MS = 10 * 60 * 1000;
// The checklist TEMPLATE list (CS-353: a binding to a deleted checklist must not remind)
// changes only when someone edits templates, so it is read on the same slow cadence
// rather than every tick. Worst case a template deleted seconds ago is still counted as
// live for one cadence — the same one-shot window CS-353 describes — or one created
// seconds ago is skipped for one cadence, well inside the 60-minute nudge grace.
const TEMPLATE_READ_MS = 10 * 60 * 1000;

// Permanent-per-session dedup for the window between "we decided to raise this" and
// "the RAISE_OPS_ALERT lands in state.opsAlertEvents". Never deleted — the reducer's id
// check covers refires after a reload.
const inFlight = new Set();

export default function OpsAlertScheduler() {
  const state = useStore();
  const dispatch = useDispatch();
  const stateRef = useRef(state);
  stateRef.current = state;
  // The in-flight or settled read is shared, so overlapping scans (tick + a state change)
  // make one request; a failed read is dropped so the next tick retries.
  const inspectionRead = useRef({ at: 0, promise: null });
  const templateRead = useRef({ at: 0, promise: null });
  // One cached-read shape for both slow reads: share the in-flight/settled promise, and
  // drop a failed one so the next tick retries.
  function cachedRead(ref, ttl, now, run) {
    const c = ref.current;
    if (c.promise && now - c.at < ttl) return c.promise;
    const promise = run();
    ref.current = { at: now, promise };
    promise.catch(() => {
      if (ref.current.promise === promise) ref.current = { at: 0, promise: null };
    });
    return promise;
  }
  const latestInspections = (now) => cachedRead(inspectionRead, INSPECTION_READ_MS, now, () => qcApi.latestInspectionPerClient());
  const liveChecklistTemplates = (now) => cachedRead(templateRead, TEMPLATE_READ_MS, now, () => qcApi.listTemplates({ kind: 'checklist' }));

  async function scan() {
    const s = stateRef.current;
    if (!s || !Array.isArray(s.jobs) || s.jobs.length === 0) return;
    const settings = s.opsSettings || {};
    const now = Date.now();
    const firedIds = new Set((s.opsAlertEvents || []).map((e) => e.id));
    // The same windows the cron reads (lib/opsAlerts.opsAlertReadWindows), each read
    // COMPLETE. This tick used to take the newest 500 punches and the newest 200 QC
    // records: at full volume a busy day's earlier clock-ins fell off (false late/missed)
    // and logged checklists read as unlogged (false reminders).
    const windows = opsAlertReadWindows(settings, now);

    // #2 needs to know which shifts are COVERED — the server reads every real clock-in in
    // the window and answers with job ids. If this fails we cannot confirm coverage, so
    // we bail rather than risk false late/missed alerts.
    let coveredJobIds;
    try {
      coveredJobIds = new Set(await timeApi.coveredJobIds(windows.coverage));
    } catch { return; }

    const alerts = getDueShiftAlerts({ jobs: s.jobs, coveredJobIds, firedIds, now, settings });

    // #3 needs the QC records: every checklist in the walker's window, and each account's
    // latest submitted inspection. The reads fail apart — a failed checklist read must not
    // also silence inspection reminders, or the reverse. A failed read skips only its own
    // reminders this tick (a detector run on empty or partial data would treat logged
    // checklists as unlogged and false-fire).
    const [checklists, inspections, templates] = await Promise.allSettled([
      qcApi.listChecklists(windows.checklists),
      latestInspections(now),
      liveChecklistTemplates(now),
    ]);
    if (checklists.status === 'fulfilled') {
      const clientsById = new Map((s.clients || []).map((c) => [c.id, c]));
      // CS-353: skip a cleaner bound to a checklist that no longer exists — but ONLY when
      // the template read actually answered. liveChecklistIdsFrom gives null for a failed
      // OR misshaped read, and the walker then skips nobody: a read that could not run must
      // never silence reminders.
      const liveChecklistIds = liveChecklistIdsFrom(templates.status === 'fulfilled' ? templates.value : null);
      // Only ACTIVE roster members are judged — a deactivated cleaner left on a clean's
      // crewIds can receive nothing, so nudging them or naming them in the escalation is
      // noise (the fan-out drops them too).
      const activeUserIds = new Set((s.users || []).filter((u) => u && u.status === 'active').map((u) => u.id));
      alerts.push(...getDueChecklistReminders({ jobs: s.jobs, clientsById, checklists: checklists.value || [], firedIds, now, settings, liveChecklistIds, activeUserIds }));
    }
    if (inspections.status === 'fulfilled') {
      alerts.push(...getDueInspectionReminders({ clients: s.clients || [], inspections: inspections.value || [], firedIds, now, settings }));
    }

    if (!alerts.length) return;
    const clientName = (id) => (s.clients || []).find((c) => c.id === id)?.name || 'a customer';
    // The checklist escalation carries ids only (CS-403); names come from the roster.
    const userName = (id) => (s.users || []).find((u) => u.id === id)?.name || null;
    for (const al of alerts) {
      if (inFlight.has(al.id)) continue;
      inFlight.add(al.id);
      const { title, body, url } = opsAlertCopy(al, clientName(al.clientId), { userName });
      dispatch({
        type: ACTIONS.RAISE_OPS_ALERT,
        alert: {
          id: al.id,
          kind: al.kind,
          recipientScope: al.recipientScope,
          clientId: al.clientId,
          jobId: al.jobId || null,
          crewIds: al.crewIds || [],
          title,
          body,
          url,
        },
      });
    }
  }

  // Re-scan when the schedule or the thresholds change...
  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.jobs, state.opsSettings]);

  // ...and every 60s to catch a shift crossing its late/missed line or a checklist
  // window closing while state is idle.
  useEffect(() => {
    const id = setInterval(scan, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
