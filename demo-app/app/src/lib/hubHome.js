// THE CLIENT HUB'S HOME — the tiles under the crew band, as pure projections (the client hub
// redesign, plan §3.1, 2026-10-08). GET /api/hub/home and the demo's twin (lib/hubDemo.js) build
// their answer here, so the two cannot differ, and scripts/test-client-hub-routes.mjs compares the
// served keys against these constants.
//
//   Requests     "1 new · 1 in progress", "1 needs your reply", else "No open requests"
//                (WO-8's stages: received / working / needs_info; completed ones are not counted)
//   Checklists   today's saves summed in the ORG's day ("7 of 8 done today"); with none today,
//                the last one ("Last: 8 of 8 · Oct 3"); "View today" opens the one when there is one
//   Inspections  the last report's score, result and day, the last ≤4 scores as a trend (oldest
//                first), and ≤3 of the last report's photos plus "+N"
//   Resolve      "Average time to resolve · 22 min", "5 requests closed in the last 30 days"
//                (Matt, the Oct 6 call; plan 2026-10-11 §4): the building's requests FROM THE HUB
//                resolved in the window (D11 — the set the customer can check against their own
//                Requests list), by the one rule in lib/resolveTime.js. Only the count and the mean
//                leave: the customer never sees a median, a deadline tally or a ticket.
//
// Matt's board labels the inspection thumbnails BEFORE / AFTER; an inspector's photos are not
// before/after, so they show unlabelled here (the visit's real pair is on Today's Visit).
//
// PURE and node-safe: the server imports it.
import { dayKey, DEFAULT_ORG_TIMEZONE } from './dates.js';
import { projectHubPhoto, projectHubInspectionRow } from './clientHubView.js';
import { cleanedCountsOf } from './checklistCount.js';
import { resolveStats, RESOLVE_WINDOW_DAYS } from './resolveTime.js';

export const HUB_HOME_FIELDS = Object.freeze(['building', 'crew', 'requests', 'checklists', 'inspections', 'resolve']);
export const HUB_REQUEST_COUNT_FIELDS = Object.freeze(['received', 'working', 'needsInfo']);
export const HUB_CHECKLIST_TILE_FIELDS = Object.freeze(['today', 'last']);
export const HUB_CHECKLIST_TODAY_FIELDS = Object.freeze(['done', 'total', 'count', 'onlyId']);
export const HUB_CHECKLIST_LAST_FIELDS = Object.freeze(['done', 'total', 'performedAt']);
export const HUB_INSPECTION_TILE_FIELDS = Object.freeze(['last', 'trend', 'photos', 'morePhotos']);
export const HUB_INSPECTION_LAST_FIELDS = Object.freeze(['id', 'score', 'result', 'performedAt']);
export const HUB_TREND_FIELDS = Object.freeze(['score', 'performedAt']);
// The time-to-resolve tile: the window it covers (so the sentence reads it from the answer), how
// many requests were closed in it, and their mean in milliseconds (null when none).
export const HUB_RESOLVE_FIELDS = Object.freeze(['days', 'count', 'meanMs']);
export const HUB_RESOLVE_DAYS = RESOLVE_WINDOW_DAYS;

// The trend's length (the board's "last 4 visits") and the tile's thumbnails.
export const HUB_TREND_MAX = 4;
export const HUB_TILE_PHOTO_MAX = 3;
// Today's saves read for the tile: one building's day, many cleaners, never a crowd.
export const HUB_TILE_CHECKLIST_MAX = 100;

const num = (v) => (Number.isFinite(v) ? v : 0);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; };

// Three head counts (the open ones, those being worked on, those waiting on the customer) are
// what the server reads; "new" is the rest of the open ones. Negative never.
export function hubRequestCounts({ open = 0, working = 0, needsInfo = 0 } = {}) {
  const w = Math.max(0, num(working));
  const n = Math.max(0, num(needsInfo));
  return { received: Math.max(0, num(open) - w - n), working: w, needsInfo: n };
}

// `rows` are checklist saves ({ id, completed_count, total_count, items, performed_at }), any order.
// A task the cleaner marked "not completed" is not done here either (`cleanedCountsOf`, D2).
export function hubChecklistTile(rows, { now = Date.now(), tz = DEFAULT_ORG_TIMEZONE } = {}) {
  const zone = tz || DEFAULT_ORG_TIMEZONE;
  const today = dayKey(now, zone);
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number.isFinite(ms(r.performed_at)))
    .sort((a, b) => ms(b.performed_at) - ms(a.performed_at) || String(b.id).localeCompare(String(a.id)));
  const todays = list.filter((r) => dayKey(ms(r.performed_at), zone) === today);
  const last = list[0] || null;
  return {
    today: {
      done: todays.reduce((s, r) => s + cleanedCountsOf(r).done, 0),
      total: todays.reduce((s, r) => s + num(r.total_count), 0),
      count: todays.length,
      onlyId: todays.length === 1 ? (todays[0].id ?? null) : null,
    },
    last: last ? { done: cleanedCountsOf(last).done, total: num(last.total_count), performedAt: new Date(ms(last.performed_at)).toISOString() } : null,
  };
}

// `rows` are the newest SUBMITTED inspections, newest first (≤ HUB_TREND_MAX); `photos` the last
// report's photos already signed (≤ HUB_TILE_PHOTO_MAX); `totalPhotos` how many it has.
export function hubInspectionTile(rows, { photos = [], totalPhotos = null } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean).slice(0, HUB_TREND_MAX).map(projectHubInspectionRow);
  const last = list[0] || null;
  const shown = (Array.isArray(photos) ? photos : []).slice(0, HUB_TILE_PHOTO_MAX).map(projectHubPhoto);
  const all = Number.isFinite(totalPhotos) ? totalPhotos : shown.length;
  return {
    last: last ? { id: last.id, score: last.score, result: last.result, performedAt: last.performedAt } : null,
    trend: list.slice().reverse().map((r) => ({ score: r.score, performedAt: r.performedAt })),
    photos: last ? shown : [],
    morePhotos: last ? Math.max(0, all - shown.length) : 0,
  };
}

// `rows` are the building's requests from the hub resolved in the window (the caller's query —
// the server's, or the demo's filter — narrows to them), any order.
export function hubResolveTile(rows, { now = Date.now() } = {}) {
  const s = resolveStats(rows, { now, days: HUB_RESOLVE_DAYS });
  return { days: HUB_RESOLVE_DAYS, count: s.count, meanMs: s.meanMs };
}

// GET /api/hub/home, whole, from its declared parts.
export function projectHubHome({ building = null, crew = null, requests = null, checklists = null, inspections = null, resolve = null } = {}) {
  return {
    building,
    crew,
    requests: requests || hubRequestCounts(),
    checklists: checklists || hubChecklistTile([]),
    inspections: inspections || hubInspectionTile([]),
    resolve: resolve || hubResolveTile([]),
  };
}
