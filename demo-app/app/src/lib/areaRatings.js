// QR-30 (Matt, 2026-10-16) — "Should visitors be able to rate an area thumbs up or down? — Yes, and
// only the office sees the results, by building."
//
// A visitor taps 👍 or 👎 under the public scan card (components/ScanAreaRating → EP-415, POST
// /api/public/scan/rate). ONE vote per phone per area per org day, which that phone may change the
// same day (public.area_scan_ratings, migration 20261017110100). The office reads them in Reports →
// Visitor ratings (EP-416), building by building, worst first; never a customer, never a cleaner.
//
// PURE / node-safe (explicit `.js` imports), shared by the route, its demo twin (lib/scanCodesApi),
// the page and the office's report (pages/reports/VisitorRatingsReport via lib/qcApi). The public
// words are English (LANG-8); the office's are catalog lines on its own screen.
import { dayKey, addDaysKey } from './dates.js';
import { scanTimeZone } from './areaScan.js';
import { isArchivedCustomer } from './customerStatus.js';

// ── a vote ──────────────────────────────────────────────────────────────────────────────────
export const AREA_RATING_VALUES = Object.freeze({ up: 1, down: -1 });
export const AREA_RATING_VOTES = Object.freeze(['up', 'down']);
const VOTE_OF_VALUE = Object.freeze({ 1: 'up', '-1': 'down' });
export const voteOfValue = (v) => VOTE_OF_VALUE[Number(v)] || null;

// The DURABLE limits, counted in the table before a NEW vote is written (changing today's vote is
// not a new one; the in-process limiter bounds how often it can flip — lib/visitorReports
// VISITOR_POST_RATE, shared with the report): a code's new votes in an hour, a phone's in 24 hours.
// The table keeps `retentionDays` and the route deletes older votes at the write point.
export const AREA_RATING_LIMITS = Object.freeze({
  perCodePerHour: 20,
  perPhonePerDay: 10,
  retentionDays: 400,
});
// A vote is a few short fields.
export const AREA_RATING_BODY_MAX_BYTES = 4 * 1024;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const AREA_RATING_CODES = Object.freeze({
  value: 'rating-value',
  device: 'rating-device',
  body: 'rating-body',
  contentType: 'rating-content-type',
  tooLarge: 'rating-too-large',
  limitPhone: 'rating-limit-phone',
  limitCode: 'rating-limit-code',
  unavailable: 'rating-unavailable',
});
const R = AREA_RATING_CODES;
export const AREA_RATING_MESSAGES = Object.freeze({
  [R.value]: 'Choose thumbs up or thumbs down.',
  [R.device]: 'Please reload this page and try again.',
  [R.body]: 'That could not be sent. Please try again.',
  [R.contentType]: 'That could not be sent. Please try again.',
  [R.tooLarge]: 'That could not be sent. Please try again.',
  [R.limitPhone]: 'You’ve rated a lot of areas from this phone today. Thank you!',
  [R.limitCode]: 'This area has had a lot of ratings in the last hour. Thank you!',
  [R.unavailable]: 'Rating isn’t available just now. Please try again in a minute.',
});
export const AREA_RATING_STATUS = Object.freeze({
  [R.contentType]: 415, [R.tooLarge]: 413, [R.limitPhone]: 429, [R.limitCode]: 429, [R.unavailable]: 503,
});
export const areaRatingStatus = (code) => AREA_RATING_STATUS[code] || 400;
export const AREA_RATING_THANKS = 'Thanks!';

const refuse = (code) => ({ refused: AREA_RATING_MESSAGES[code], code });

// { token, value: 'up' | 'down', deviceId } → { value: { vote, value, deviceId } } | { refused, code }
export function areaRatingInput(body = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return refuse(R.body);
  if (!(typeof b.deviceId === 'string' && DEVICE_ID_RE.test(b.deviceId))) return refuse(R.device);
  if (!AREA_RATING_VOTES.includes(b.value)) return refuse(R.value);
  return { value: { vote: b.value, value: AREA_RATING_VALUES[b.value], deviceId: b.deviceId } };
}

// `counts`: { codeHour, phoneDay } — the code's NEW votes in the last hour, the phone's in a day.
export function areaRatingLimitVerdict(counts = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (n(counts.phoneDay) >= AREA_RATING_LIMITS.perPhonePerDay) return refuse(R.limitPhone);
  if (n(counts.codeHour) >= AREA_RATING_LIMITS.perCodePerHour) return refuse(R.limitCode);
  return { ok: true };
}

// The ORG's calendar day a vote at `nowMs` belongs to (the company's zone, never the phone's or the
// server's: THE LAW II.8) — 'YYYY-MM-DD'.
export function ratingDay(nowMs = Date.now(), timeZone = null) {
  return dayKey(new Date(nowMs), scanTimeZone(timeZone));
}
// The oldest day the table keeps, for the retention sweep at the write point.
export function ratingRetentionCutoffDay(nowMs = Date.now(), timeZone = null) {
  return addDaysKey(ratingDay(nowMs, timeZone), -AREA_RATING_LIMITS.retentionDays);
}

// ── the phone's memory of today's vote (the page) ───────────────────────────────────────────
// `{ [token]: { day, vote } }` in the page's storage under RATING_MEMORY_KEY: today's vote shows as
// pressed when the visitor comes back the same day. Retention at the write point: only today's
// entries survive a write, and at most RATING_MEMORY_MAX of them.
export const RATING_MEMORY_KEY = 'cs.scanRating.v1';
export const RATING_MEMORY_MAX = 50;
export function rememberedVote(memory, token, day) {
  const e = memory && typeof memory === 'object' ? memory[token] : null;
  return e && e.day === day && AREA_RATING_VOTES.includes(e.vote) ? e.vote : null;
}
export function rememberVote(memory, token, day, vote) {
  const kept = Object.entries(memory && typeof memory === 'object' ? memory : {})
    .filter(([k, e]) => k !== token && e && e.day === day && AREA_RATING_VOTES.includes(e.vote))
    .slice(-(RATING_MEMORY_MAX - 1));
  return Object.fromEntries([...kept, [token, { day, vote }]]);
}

// ── the office's report: by building, worst first (EP-416) ──────────────────────────────────
export const RATING_PERIODS = Object.freeze([7, 30, 90]);
export const DEFAULT_RATING_PERIOD = 30;
// A period the report offers, in days, or null (the route answers 400).
export function ratingPeriodDays(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_RATING_PERIOD;
  const n = Number(v);
  return RATING_PERIODS.includes(n) ? n : null;
}
// The org days a period covers, today included: { fromDay, toDay }.
export function ratingPeriodWindow({ days = DEFAULT_RATING_PERIOD, nowMs = Date.now(), timeZone = null } = {}) {
  const toDay = ratingDay(nowMs, timeZone);
  return { fromDay: addDaysKey(toDay, -(days - 1)), toDay };
}

// Of `up` votes among `total`, the whole percent (null with no votes).
export const pctPositive = (up, total) => (total > 0 ? Math.round((up / total) * 100) : null);

// Worst first: the lowest share of thumbs up; then the most thumbs down; then the most votes; then
// the name — a stable order.
function worstFirst(a, b) {
  if (a.pctPositive !== b.pctPositive) return (a.pctPositive ?? 101) - (b.pctPositive ?? 101);
  if (a.down !== b.down) return b.down - a.down;
  if (a.total !== b.total) return b.total - a.total;
  return String(a.name ?? a.label ?? '').localeCompare(String(b.name ?? b.label ?? ''));
}

export const REMOVED_LOCATION = 'Removed location';
export const REMOVED_AREA = 'Removed area';

// Every vote in the period (`rows`: { site_id, client_id, area_id, value }) folded into one row per
// BUILDING — the location's customer in the live record, else the customer it had when rated — with
// its areas. Names come from the live record (`sites`, `clients`); a location or an area since
// removed keeps its votes under a plain "Removed …". An ARCHIVED customer stays in its own history
// here (UI_RULES §163: archived, never deleted), marked `archived`.
// → { buildings: [{ key, clientId, name, archived, up, down, total, pctPositive, areas: [{ key,
//     siteId, areaId, label, location, up, down, total, pctPositive }] }], totals: { up, down,
//     total, pctPositive, buildings } }
export function visitorRatingsReport(rows = [], { sites = [], clients = [] } = {}) {
  const siteById = new Map((Array.isArray(sites) ? sites : []).filter((s) => s && s.id).map((s) => [s.id, s]));
  const clientById = new Map((Array.isArray(clients) ? clients : []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const buildings = new Map();
  let up = 0;
  let down = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const vote = voteOfValue(r?.value);
    if (!vote || !r.site_id || !r.area_id) continue;
    const site = siteById.get(r.site_id) || null;
    const clientId = (site && typeof site.clientId === 'string' && site.clientId) || r.client_id || null;
    const client = clientId ? clientById.get(clientId) || null : null;
    const key = clientId ? `c:${clientId}` : `s:${r.site_id}`;
    if (!buildings.has(key)) {
      buildings.set(key, {
        key,
        clientId,
        name: (client && typeof client.name === 'string' && client.name.trim()) || (site && typeof site.name === 'string' && site.name.trim()) || REMOVED_LOCATION,
        archived: isArchivedCustomer(client),
        up: 0, down: 0, total: 0, pctPositive: null,
        areaMap: new Map(),
        siteIds: new Set(),
      });
    }
    const b = buildings.get(key);
    b.siteIds.add(r.site_id);
    const areaKey = `${r.site_id}|${r.area_id}`;
    if (!b.areaMap.has(areaKey)) {
      const area = (Array.isArray(site?.cleaningAreas) ? site.cleaningAreas : []).find((a) => a && String(a.id || '').trim() === r.area_id);
      b.areaMap.set(areaKey, {
        key: areaKey,
        siteId: r.site_id,
        areaId: r.area_id,
        label: (area && typeof area.label === 'string' && area.label.trim()) || REMOVED_AREA,
        location: (site && typeof site.name === 'string' && site.name.trim()) || null,
        up: 0, down: 0, total: 0, pctPositive: null,
      });
    }
    const a = b.areaMap.get(areaKey);
    if (vote === 'up') { a.up += 1; b.up += 1; up += 1; } else { a.down += 1; b.down += 1; down += 1; }
    a.total += 1;
    b.total += 1;
  }
  const out = [...buildings.values()].map(({ areaMap, siteIds, ...b }) => {
    const areas = [...areaMap.values()].map((a) => ({ ...a, pctPositive: pctPositive(a.up, a.total) })).sort(worstFirst);
    // A building with one location needs no location under each area.
    if (siteIds.size < 2) for (const a of areas) a.location = null;
    return { ...b, pctPositive: pctPositive(b.up, b.total), areas };
  }).sort(worstFirst);
  return {
    buildings: out,
    totals: { up, down, total: up + down, pctPositive: pctPositive(up, up + down), buildings: out.length },
  };
}
