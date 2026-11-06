// The manager Home's reads, and the manager nav's count pills on the same answers (UI_RULES §152).
//
// Each read goes through lib/sharedRead (hooks/useSharedRead), keyed by the viewer and the scope
// (lib/managerHome homeScopeKey), so the sidebar's pill, the phone menu's pill and the Home's tile
// for one figure are ONE read: whoever mounts first reads, the rest join it or reuse the answer.
// A page view re-reads an answer older than HOME_FRESH_MS; the window regaining focus re-reads
// one older than HOME_FOCUS_GAP_MS; no connection keeps the last answer and reads nothing until
// it returns. Every read is one that already exists (no new endpoint):
//   inspections  qcApi.latestInspectionPerClient + qcApi.listInspections({ siteIds })
//   hours        timeApi.approvals({ supervisorId })           the Hours Approval page's read
//   requests     qcApi.listOpenProblems()                      the Client Requests page's read (every open ticket, CS-640)
//   messages     clientMessagesApi.listWaitingCustomerThreads({ managerId })   every customer thread waiting for
//                                                              the office's reply — its own figure (HUB-24 (c), 2026-10-12)
//   supplies     suppliesApi.buildings({ mgr })                Supplies → By building's read (`team` for an OM's own team)
// The today figures (the shift band, Schedule, Checklists, the Shift Check-in pill) come from
// hooks/useManagerToday, shared the same way.
import { useCallback, useMemo } from 'react';
import { useSelector } from '../store';
import { useAuth } from './useAuth';
import { usePermissionChecker } from './usePermission';
import { useOnlineStatus } from './useOnlineStatus';
import { useSharedRead } from './useSharedRead';
import { useManagerToday } from './useManagerToday';
import * as qcApi from '../lib/qcApi';
import * as timeApi from '../lib/timeApi';
import * as suppliesApi from '../lib/suppliesApi';
import { listWaitingCustomerThreads } from '../lib/clientMessagesApi';
import {
  homeScope, homeScopeKey, holdsGate, hoursFigures, requestFigures, messageFigures, suppliesFigures, suppliesMgrParam, shiftBand, navPills,
} from '../lib/managerHome';

export const HOME_FRESH_MS = 10 * 1000;
export const HOME_FOCUS_GAP_MS = 15 * 1000;

const selClients = (s) => s.clients;
const selUsers = (s) => s.users;
const selSites = (s) => s.sites;
const selOps = (s) => s.opsSettings;

function useHomeRead(name, scope, reader, enabled) {
  const { currentUser } = useAuth();
  const online = useOnlineStatus();
  return useSharedRead(`mgrHome:${name}|${currentUser?.id || ''}|${homeScopeKey(scope)}`, reader, {
    enabled, paused: !online, maxAgeMs: HOME_FRESH_MS, focusGapMs: HOME_FOCUS_GAP_MS,
  });
}

export function useInspectionsRead(scope, enabled) {
  const sites = useSelector(selSites);
  const reader = useCallback(async () => {
    const siteIds = scope.clientIds === null ? null
      : (sites || []).filter((s) => s && scope.clientIds.has(s.clientId)).map((s) => s.id);
    const [latest, history] = await Promise.all([
      qcApi.latestInspectionPerClient(),
      // A scope with no locations has nothing to list (an empty facet would mean "all").
      siteIds && siteIds.length === 0 ? { inspections: [] } : qcApi.listInspections(siteIds ? { siteIds } : {}),
    ]);
    return { latest: latest || [], history: (history && history.inspections) || [] };
  }, [scope, sites]);
  return useHomeRead('inspections', scope, reader, enabled);
}

export function useHoursRead(scope, enabled) {
  const reader = useCallback(() => timeApi.approvals({ supervisorId: scope.mgrId || undefined }), [scope]);
  return useHomeRead('hours', scope, reader, enabled);
}

// The Client Requests page's read as the tile's answer, { problems }: every open ticket. Requests
// only — a customer's message waiting for a reply is useMessagesRead's (HUB-24 (c)).
export function useRequestsRead(scope, enabled) {
  const reader = useCallback(async () => ({ problems: (await qcApi.listOpenProblems({})) || [] }), []);
  return useHomeRead('requests', scope, reader, enabled);
}

// The customer threads waiting for the office's reply, { threads, total } — the Customer messages
// tile and the Messages row's pill (one shared read). Narrowed on the server to the manager in
// view (the building's supervisor, as Client Requests narrows); "All managers" reads every one.
// The route's gate is `hub.messages.view` (TILE_GATES.messages).
export function useMessagesRead(scope, enabled) {
  const { currentUser } = useAuth();
  const ctx = useMemo(() => ({ user: currentUser }), [currentUser]);
  const reader = useCallback(() => listWaitingCustomerThreads({ managerId: scope.mgrId || null }, ctx), [scope, ctx]);
  return useHomeRead('messages', scope, reader, enabled);
}

// By building's read (S131 Wave 2): an Operations Manager's own team asks for `team`, one manager in
// view for them, anything else every building (lib/managerHome suppliesMgrParam). The demo's stub
// resolves names, the approver and `team` from the store and the viewer, and keeps the route's office
// gate; the real read takes all of it from the login's claim and ignores this.
export function useSuppliesRead(scope, enabled) {
  const { currentUser } = useAuth();
  const check = usePermissionChecker();
  const clients = useSelector(selClients);
  const users = useSelector(selUsers);
  const opsSettings = useSelector(selOps);
  const canView = check('supplies.view');
  const ctx = useMemo(() => ({
    state: { clients: clients || [], users: users || [], opsSettings: opsSettings || {} }, user: currentUser, holds: { view: canView },
  }), [clients, users, opsSettings, currentUser, canView]);
  const reader = useCallback(() => suppliesApi.buildings({ mgr: suppliesMgrParam(scope, currentUser) }, ctx), [scope, ctx, currentUser]);
  return useHomeRead('supplies', scope, reader, enabled);
}

// Whose menu draws the count pills, on the desktop and the phone alike: a manager's, and the owner's and
// an admin's (the Launcher, Matt's Option D, drew counts on its rows and tiles; Daniel, 2026-10-30). A
// supply manager's app counts its own way (its Order Queue), and crew draw no menu.
export const menuCountsFor = (role) => role === 'manager' || role === 'owner' || role === 'admin';

// The menu's count pills: a MANAGER's own scope, and the owner's and an admin's every building, each
// figure only for a holder of its tile's gate, read through the same shared reads as the Home.
// Never blocks the nav: until an answer lands every pill is null (drawn as nothing).
// The scope is the Home's own default — for an Operations Manager their team (S131), which needs
// the roster: without it an OM resolved to their own (often empty) book and the pills vanished. The
// hours and supplies pills count over that scope exactly as the tiles do.
export function useManagerNavCounts(active) {
  const { currentUser } = useAuth();
  const check = usePermissionChecker();
  const clients = useSelector(selClients);
  const users = useSelector(selUsers);
  const opsSettings = useSelector(selOps);
  const scope = useMemo(
    () => homeScope({ viewer: currentUser, clients: clients || [], users: users || [] }),
    [currentUser, clients, users],
  );
  const has = (k) => !!active && holdsGate(check, k) && !(scope.clientIds && scope.clientIds.size === 0);
  const today = useManagerToday({ enabled: has('band') });
  const hours = useHoursRead(scope, has('hours'));
  const requests = useRequestsRead(scope, has('requests'));
  const messages = useMessagesRead(scope, has('messages'));
  const supplies = useSuppliesRead(scope, has('supplies'));
  return useMemo(() => navPills({
    band: today.counts ? shiftBand(today.counts) : null,
    hours: hours.data ? hoursFigures(hours.data, { user: currentUser, opsSettings, scope }) : null,
    requests: requests.data ? requestFigures(requests.data, { scope, clients: clients || [], settings: opsSettings || {} }) : null,
    messages: messages.data ? messageFigures(messages.data, { scope }) : null,
    supplies: supplies.data ? suppliesFigures(supplies.data, scope) : null,
  }), [today.counts, hours.data, requests.data, messages.data, supplies.data, currentUser, opsSettings, scope, clients]);
}
