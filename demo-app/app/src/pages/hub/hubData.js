// The client hub's read hooks and its small shared vocabulary for the screens.
//
// The hub has no store (HubRoot): every section reads its own server answer, already scoped
// and allowlisted (api/hub/[...path].js, or the demo's twin). So the screens need exactly two
// shapes of read — one record, and one server-paged list — and they live here once, with the
// words the crew band and the visit page share (the redesign, 2026-10-08).
import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { HUB_PAGE_SIZE } from '../../lib/clientHubView';
import { fmtDate, fmtTime } from '../../lib/dates';

// One read: { data, error, status, loading, reload, setData }. `status` is the HTTP status of a
// failure (404 → the page says "not found"; anything else offers Try again). `deps` name the
// record (a building, a ticket): a new record starts from "loading", a reload of the same one
// keeps what is on screen until the answer arrives.
export function useHubRead(load, deps = []) {
  const key = JSON.stringify(deps);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ data: undefined, error: '', status: null, key });
  useEffect(() => {
    let alive = true;
    setState((s) => (s.key === key ? { ...s, error: '', status: null } : { data: undefined, error: '', status: null, key }));
    Promise.resolve()
      .then(load)
      .then((data) => { if (alive) setState({ data, error: '', status: null, key }); })
      .catch((e) => { if (alive) setState({ data: null, error: e?.message || 'This could not be loaded.', status: e?.status || null, key }); });
    return () => { alive = false; };
  }, [key, tick]);
  const setData = (next) => setState((s) => ({ ...s, data: typeof next === 'function' ? next(s.data) : next }));
  return {
    data: state.data, error: state.error, status: state.status,
    loading: state.data === undefined, reload: () => setTick((t) => t + 1), setData,
  };
}

// A SERVER-paged list (UI_RULES §72's 20 a page). The hub pages on the server — a building's
// year of history is thousands of rows — so this asks for one page at a time and carries the
// same pager shape as usePagedRows, so <ListPager> renders it and `.pageRows` is what the
// table maps (lint:tables). The page lives in the URL (`param`), as every list's does.
export function useHubPage(fetchPage, { param, deps = [] } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(searchParams.get(param) || '1', 10) || 1);
  const [state, setState] = useState({ rows: null, total: 0, error: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchPage({ offset: (page - 1) * HUB_PAGE_SIZE, limit: HUB_PAGE_SIZE })
      .then((r) => { if (alive) setState({ rows: r?.rows || r?.events || [], total: Number(r?.total) || 0, error: '' }); })
      .catch((e) => { if (alive) setState({ rows: [], total: 0, error: e?.message || 'This list could not be loaded.' }); });
    return () => { alive = false; };
  }, [page, tick, ...deps]);
  const total = state.total;
  const totalPages = Math.max(1, Math.ceil(total / HUB_PAGE_SIZE));
  const setPage = (next) => {
    const clamped = Math.min(Math.max(1, next), totalPages);
    const params = new URLSearchParams(searchParams);
    if (clamped <= 1) params.delete(param); else params.set(param, String(clamped));
    setSearchParams(params, { replace: true });
  };
  return {
    pageRows: state.rows || [],
    loading: state.rows === null,
    error: state.error,
    reload: () => setTick((t) => t + 1),
    page, totalPages, setPage, total, pageSize: HUB_PAGE_SIZE,
    start: total === 0 ? 0 : (page - 1) * HUB_PAGE_SIZE + 1,
    end: Math.min(page * HUB_PAGE_SIZE, total),
  };
}

// The layout's outlet context (layouts/HubLayout.jsx): the view, the building in view, its Home
// read, the remembered building, and whether this is the demo's preview.
export const useHub = () => useOutletContext() || {};

// THE CURRENT BUILDING (plan §3.1): `/hub` opens the building last viewed — a per-VIEWER
// convenience in this browser (`cleanspace_hub_current_v1:<client user id>`), ignored once that
// building is no longer in the login's scope — else the first by name. Every access is wrapped:
// private mode, cleared storage or a blocked one simply opens the first building.
const CURRENT_KEY = 'cleanspace_hub_current_v1';
export function readHubCurrent(viewerKey) {
  if (!viewerKey) return null;
  try { return localStorage.getItem(`${CURRENT_KEY}:${viewerKey}`) || null; } catch { return null; }
}
export function rememberHubCurrent(viewerKey, id) {
  if (!viewerKey || !id) return;
  try { localStorage.setItem(`${CURRENT_KEY}:${viewerKey}`, id); } catch { /* a convenience only */ }
}
// The building in view (from the URL) if it is in scope, else the remembered one, else the first.
// `buildings` are the view's, already sorted by name.
export function hubCurrentId(buildings, { urlId = null, viewerKey = '' } = {}) {
  const ids = (Array.isArray(buildings) ? buildings : []).map((b) => b.id);
  if (urlId && ids.includes(urlId)) return urlId;
  const stored = readHubCurrent(viewerKey);
  if (stored && ids.includes(stored)) return stored;
  return ids[0] || null;
}

// Re-read every `ms` while the page is visible (a customer has no realtime): the crew band and
// the visit page follow the crew without a refresh. Off when hidden; one read on coming back.
export function useHubRefresh(reload, ms = 60000) {
  const fn = useRef(reload);
  useEffect(() => { fn.current = reload; });
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const tick = () => { if (document.visibilityState === 'visible') fn.current?.(); };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [ms]);
}

// "Oct 3, 2:15 PM" in the company's zone (lib/dates' default, set from the view's timezone by
// HubRoot), the way every hub row reads.
export const hubWhen = (iso) => (iso ? `${fmtDate(iso, { month: 'short', day: 'numeric', year: 'numeric' })}, ${fmtTime(iso)}` : '');
export const hubDay = (iso) => (iso ? fmtDate(iso, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
// "Fri, Oct 10" — a visit's day. "Sep 27" — a tile's (Matt's boards).
export const hubVisitDay = (iso) => (iso ? fmtDate(iso, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
export const hubShortDay = (iso) => (iso ? fmtDate(iso, { month: 'short', day: 'numeric' }) : '');
export const hubTime = (iso) => (iso ? fmtTime(iso) : '');

// The four client stages (WO-8) in the kit's badge colours.
export const STAGE_BADGE = { received: 'blue', working: 'amber', needs_info: 'purple', completed: 'green' };
// An inspection result in the kit's badge colours.
export const RESULT_BADGE = { pass: 'green', fail: 'red', needs_follow_up: 'amber' };

// "Good morning / afternoon / evening, Jordan" — by the reader's own clock (plan §3.1).
export function hubGreeting(firstName, now = new Date()) {
  const h = now.getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return firstName ? `Good ${part}, ${firstName}` : `Good ${part}`;
}

// ── the crew band's words (lib/hubVisit.js hubVisitStatus → these) ─────────────
// Matt's board: same card, same place; only the colour, the icon and the words change.
export const CREW_LOOK = Object.freeze({
  on_site: { tone: 'live', icon: 'mapPin', title: 'On site now' },
  arriving: { tone: 'soon', icon: 'schedule', title: 'Arriving today' },
  done: { tone: 'done', icon: 'check', title: 'Visit complete' },
  none: { tone: 'idle', icon: 'schedule', title: 'No visit today' },
});

// "2 min early" / "on time" — and nothing when late (M1 ★, HUB-20: the time only).
export function timelinessText(t) {
  if (!t) return '';
  if (t.kind === 'early') return `${t.minutes} min early`;
  if (t.kind === 'on_time') return 'on time';
  return '';
}

// "Carlos M. + 2"
export const crewText = (crew) => (crew?.lead ? `${crew.lead}${crew.others ? ` + ${crew.others}` : ''}` : '');

// The band's second line, by state. `now` decides "Scheduled for" against "Expected at".
export function crewLine(crew, now = Date.now()) {
  if (!crew) return '';
  if (crew.state === 'on_site') return [`Arrived ${hubTime(crew.arrivedAt)}`, crewText(crew.crew)].filter(Boolean).join(' · ');
  if (crew.state === 'arriving') {
    const start = Date.parse(crew.scheduledAt);
    return `${Number.isFinite(start) && start < now ? 'Expected at' : 'Scheduled for'} ${hubTime(crew.scheduledAt)}`;
  }
  if (crew.state === 'done') return `Checked out ${hubTime(crew.checkedOutAt)}`;
  return crew.next?.startAt ? `Next visit ${hubVisitDay(crew.next.startAt)} · ${hubTime(crew.next.startAt)}` : 'No upcoming visits scheduled';
}

// A timeline step's two lines (Today's Visit).
const STEP_LABEL = Object.freeze({
  scheduled: 'Scheduled',
  checked_in: 'Crew checked in',
  checklist_progress: 'Checklist in progress',
  checklist_complete: 'Checklist complete',
  checked_out: 'Crew checked out',
});
export function stepText(step, crew) {
  const label = STEP_LABEL[step.key] || step.key;
  let detail = 'Pending';
  if (step.key === 'scheduled') detail = `${hubTime(step.at)} window`;
  else if (step.state === 'done' && step.key === 'checklist_complete') {
    detail = [hubTime(step.at), step.total ? `${step.done} of ${step.total} items` : ''].filter(Boolean).join(' · ');
  } else if (step.state === 'done' && step.key === 'checklist_progress') detail = 'Done';
  else if (step.state === 'done') detail = hubTime(step.at);
  else if (step.state === 'current' && step.key === 'checked_in' && crew?.scheduledAt) detail = `Expected at ${hubTime(crew.scheduledAt)}`;
  else if (step.state === 'current' && step.key === 'checklist_progress') detail = 'Done when the crew saves it';
  return { label, detail };
}
