// useManagerToday — the manager's TODAY, live: today's visits in the buildings in scope, each
// with where it stands (lib/managerToday, the pure rule). Feeds Shift check-in (/check-in),
// the Schedule's Today view, Checklists today (/checklists) and, from Wave B, the manager
// Home's shift band and tiles (Builder B). Keep the return shape stable; it is documented here.
//
//   const today = useManagerToday({ mgrId, enabled = true, opsManagerId = null });
//
//   mgrId    the Manager filter (?mgr=) for an OWNER or ADMIN: '' / null = All managers,
//            'none' = buildings with no manager, else a manager's user id. An OPERATIONS MANAGER
//            reads their team ('' / 'team') or one member of it (an id on the team). Any other
//            manager is always scoped to the buildings they supervise (client.supervisorId),
//            whatever is passed. ONE rule with the manager Home (lib/managerHome
//            resolveManagerScope — S131 closed the split between the two), and the one Approvals
//            reads (lib/timeRules timeScopeFor).
//   opsManagerId  the owner's Operations view (OwnerHome ?view=ops): read as that OM's team.
//   enabled  false reads nothing (a tile that is not on screen).
//
// Returns {
//   loading     true until the first complete read for THIS scope lands
//   refreshing  a background re-read is in flight (the last answer stays on screen)
//   error       the last read's Error (null when it succeeded); render it with
//               i18n/errors errorText(t, error, key). A failed refresh keeps the previous
//               complete answer and its asOf, so a screen can say how old it is.
//   retry()     read again now
//   offline     the device has no connection; nothing is read until it returns
//   asOf        ISO of the moment the shown answer was judged (the screen's "as of 6:12 PM")
//   dayKey      the org day the answer is for
//   visits      Visit[] (lib/managerToday header) — NULL until the first read lands, so a
//               screen never draws zeros as if they were data (UI_RULES §117)
//   counts      lib/managerToday countVisits() over `visits` — null with them
//   managerId   the scope actually applied (null = all, 'none', a user id, or a team's ids)
//   buildings   how many buildings the scope holds (0 → the "no buildings" state)
//   refused     the viewer is crew: nothing is read (the screens are office-only)
// }
//
// EVERY READ IS COMPLETE (UI_RULES §117): the punches through timeApi.entriesAll (paged, the
// whole window, the Attendance report's read) and the saved checklists through
// qcApi.listChecklists({ fromIso, toIso }) (the window mode, never the newest-200 list). The
// punch read is scoped to the buildings in view on the SERVER's terms (lib/timeRules
// effectiveTimeFilter — W5-M F5: never download other managers' cleaners and filter here).
// NO NEW ENDPOINT: both reads exist and are already gated.
//
// REFRESH: every MANAGER_TODAY_REFRESH_MS while the tab is visible, when the window regains
// focus (at most once per FOCUS_MIN_GAP_MS) and when the connection returns. The jobs, roster
// and time off come from the live store, so a schedule change shows without a re-read.
//
// ONE READ FOR EVERY READER (Wave B, UI_RULES §152): the read goes through lib/sharedRead,
// keyed by the viewer and the scope, so the manager's nav pill, the Home's band and tiles and
// the page on screen share one read in flight and one answer — a second reader mounting within
// FOCUS_MIN_GAP_MS reuses it instead of reading the day again.
import { useCallback, useMemo } from 'react';
import { useSelector } from '../store';
import { useAuth } from './useAuth';
import { useOnlineStatus } from './useOnlineStatus';
import { useSharedRead } from './useSharedRead';
import * as timeApi from '../lib/timeApi';
import * as qcApi from '../lib/qcApi';
import { UNSCOPED_ROLES, effectiveTimeFilter } from '../lib/timeRules';
import { resolveManagerScope } from '../lib/managerHome';
import {
  computeManagerToday, todayWindow, inManagerScope, ALL_MANAGERS, NO_MANAGER,
} from '../lib/managerToday';

// One minute: the statuses move by the minute (late → no check-in at the missed mark), and a
// re-read is two narrow, complete reads of one day.
export const MANAGER_TODAY_REFRESH_MS = 60 * 1000;
const FOCUS_MIN_GAP_MS = 15 * 1000;
// Customer ids per punch read: the filter rides in the query string, so a long scope is read
// in slices rather than as one oversized URL.
const CLIENT_IDS_PER_READ = 100;

const selJobs = (s) => s.jobs;
const selUsers = (s) => s.users;
const selClients = (s) => s.clients;
const selSites = (s) => s.sites;
const selTimeOff = (s) => s.timeOff;
const selOps = (s) => s.opsSettings;

const EMPTY = [];

async function readPunches(win, clientIds) {
  const base = { fromIso: win.readFromIso, toIso: win.readToIso, lite: true };
  if (clientIds == null) return timeApi.entriesAll(base);
  const out = [];
  for (let i = 0; i < clientIds.length; i += CLIENT_IDS_PER_READ) {
    out.push(...await timeApi.entriesAll({ ...base, clientIds: clientIds.slice(i, i + CLIENT_IDS_PER_READ) }));
  }
  return out;
}

export function useManagerToday({ mgrId = null, enabled = true, opsManagerId = null } = {}) {
  const { currentUser } = useAuth();
  const online = useOnlineStatus();
  const jobs = useSelector(selJobs) || EMPTY;
  const users = useSelector(selUsers) || EMPTY;
  const clients = useSelector(selClients) || EMPTY;
  const sites = useSelector(selSites) || EMPTY;
  const timeOff = useSelector(selTimeOff) || EMPTY;
  const opsSettings = useSelector(selOps);

  const role = currentUser?.role || null;
  const refused = role === 'crew';
  const unscoped = UNSCOPED_ROLES.includes(role);
  // Whose buildings: the Home's own rule (lib/managerHome resolveManagerScope) — the owner / admin
  // what the filter names, an Operations Manager their team or one member of it, anyone else their
  // own buildings. An array is a team (lib/managerToday inManagerScope reads it).
  const scopeRule = useMemo(
    () => resolveManagerScope({ viewer: currentUser, users, mgrParam: mgrId || '', opsManagerId }),
    [currentUser, users, mgrId, opsManagerId],
  );
  const managerId = scopeRule.mode === 'all' ? ALL_MANAGERS
    : scopeRule.mode === 'none' ? NO_MANAGER
      : scopeRule.mode === 'team' ? scopeRule.managerIds
        : (scopeRule.mgrId || '__no-user__');

  const scopeClientIds = useMemo(
    () => (clients || []).filter((c) => c && inManagerScope(c, managerId)).map((c) => c.id),
    [clients, managerId],
  );
  // What the punch read sends: company-wide only for an unscoped "All managers".
  const readPlan = useMemo(() => {
    if (unscoped && managerId === ALL_MANAGERS) return effectiveTimeFilter({ unscoped: true });
    if (!scopeClientIds.length) return { fetch: false, clientIds: null };
    return unscoped
      ? { fetch: true, clientIds: scopeClientIds }
      : effectiveTimeFilter({ unscoped: false, scopeClientIds });
  }, [unscoped, managerId, scopeClientIds]);
  const scopeKey = `${Array.isArray(managerId) ? `team:${managerId.join(',')}` : managerId}|${readPlan.fetch ? (readPlan.clientIds || ['*']).join(',') : '-'}`;

  // The read itself: the day's punches and saved checklists, judged as of the moment it starts.
  const reader = useCallback(async () => {
    const now = Date.now();
    // Nothing in scope: a complete answer with no visits, not a read.
    if (!readPlan.fetch) return { punches: [], saved: [], asOf: now };
    const win = todayWindow(now);
    const [punches, saved] = await Promise.all([
      readPunches(win, readPlan.clientIds),
      qcApi.listChecklists({ fromIso: win.readFromIso, toIso: win.readToIso }),
    ]);
    return { punches: punches || [], saved: saved || [], asOf: now };
  }, [readPlan]);

  // Shared by every reader of this viewer's scope (the key). Offline, nothing is read (the last
  // answer stays on screen) until the connection returns, which reads at once.
  const shared = useSharedRead(`mgrToday|${currentUser?.id || ''}|${scopeKey}`, reader, {
    enabled: enabled && !refused,
    paused: !online,
    maxAgeMs: FOCUS_MIN_GAP_MS,
    focusGapMs: FOCUS_MIN_GAP_MS,
    intervalMs: MANAGER_TODAY_REFRESH_MS,
  });
  const error = shared.error;
  const inFlight = shared.inFlight;
  const load = shared.refresh;

  // The answer for the scope on screen: the shared entry is keyed by the scope, so a read for
  // another scope (the filter just changed) is never shown under this one.
  const current = shared.data || null;
  const result = useMemo(() => {
    if (!current) return null;
    return computeManagerToday({
      jobs, timeEntries: current.punches, checklists: current.saved, timeOff, users, clients, sites,
      opsSettings: opsSettings || {}, managerId, now: current.asOf,
    });
  }, [current, jobs, timeOff, users, clients, sites, opsSettings, managerId]);

  return {
    // A first read in flight (a retry after a failure included), or about to start; never
    // while offline with nothing read, nor after a failed first read (that is `error`).
    loading: enabled && !refused && !current && (inFlight || (!error && online)),
    refreshing: inFlight && !!current,
    error,
    retry: load,
    offline: !online,
    asOf: result?.asOf || null,
    dayKey: result?.dayKey || null,
    visits: result?.visits || null,
    counts: result?.counts || null,
    managerId,
    buildings: scopeClientIds.length,
    refused,
  };
}

export default useManagerToday;
