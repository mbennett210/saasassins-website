// masterSearch/jobRecords.js — the CLEANS record source (global search's visits), pure and
// node-safe (explicit `.js` imports, nothing from the store) so its build is tested at Matt's
// size: scripts/test-master-search-speed.mjs. sources.js wires it with the Schedule's own
// crew-scoped selector and the store's effective status (makeJobSource below).
//
// 🔴 CS-674 (S128, F11-05): at 49,883 visits the first letter typed in global search built a
// candidate for every visit — two dates through a per-call formatter (lib/dates now caches
// them) and three linear finds each — one 7.3 s frozen task on a desktop, and every realtime
// patch or clock-out started it over. So this source:
//   • looks a visit's customer, location and service up through an id index built once per
//     slice array (never `list.find` per visit);
//   • formats a visit's two dates once per distinct START instant (a schedule repeats a
//     handful of start times) in the reader's language and the org's zone;
//   • declares a `signature` (the names it shows and its status today) and the slices it
//     `reads`, so the engine (collect.js) rebuilds only the visits that changed;
//   • `keep`s visits from the last SEARCH_PAST_DAYS days onward, and every future one, so the
//     work stays the size of the schedule rather than of the history (production loads every
//     visit ever, ~195,000 a year at Matt's size). An older clean is still on the Schedule
//     and its customer's page; search finds the customer.
import { fmtDate, getUiLocale, getOrgTimezone } from '../dates.js';
import { JOB_STATUS_LABELS } from '../jobStatus.js';

// How far back global search looks for cleans.
export const SEARCH_PAST_DAYS = 90;
const DAY_MS = 86400000;

// The two words-helpers every record source uses (sources.js imports them from here).
export const cleanWords = (arr) => arr.filter((x) => x != null && x !== '' && x !== false).map(String);
export const capFirst = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

// id → record for one slice array, built once per array. The FIRST record with an id wins,
// as `list.find` did. A new array (any edit, an adopted shared record) gets its own index; the
// old one goes with its array.
const INDEXES = new WeakMap();
const NO_INDEX = new Map();
function byId(list) {
  if (!Array.isArray(list)) return NO_INDEX;
  let m = INDEXES.get(list);
  if (!m) {
    m = new Map();
    for (const r of list) if (r && r.id != null && !m.has(r.id)) m.set(r.id, r);
    INDEXES.set(list, m);
  }
  return m;
}
const nameOf = (list, id) => (id == null ? undefined : byId(list).get(id)?.name);

// "Wed, Oct 14" (shown) and "Oct 14" (searched) for a visit's start: once per distinct start
// instant, per display language and org zone (the context the engine also keys on).
const WEEKDAY_MONTH_DAY = Object.freeze({ weekday: 'short', month: 'short', day: 'numeric' });
const MONTH_DAY = Object.freeze({ month: 'short', day: 'numeric' });
const DATES_MAX = 20000;
let dates = { ctx: null, map: new Map() };
const displayContext = () => `${getUiLocale()}|${getOrgTimezone()}`;
function visitDates(iso) {
  const ctx = displayContext();
  if (dates.ctx !== ctx) dates = { ctx, map: new Map() };
  let d = dates.map.get(iso);
  if (!d) {
    d = { day: fmtDate(iso, WEEKDAY_MONTH_DAY), short: fmtDate(iso, MONTH_DAY) };
    if (dates.map.size >= DATES_MAX) dates.map.clear();
    dates.map.set(iso, d);
  }
  return d;
}

// The cleans source. `select(state, user)` is the page's own scoped selector (crew see only
// the visits they are on); `effectiveStatus(job, now)` is the store's (an upcoming clean whose
// start has passed reads Missed).
export function makeJobSource({ select, effectiveStatus }) {
  const statusWord = (st) => JOB_STATUS_LABELS[st] || capFirst(st);
  return {
    type: 'job', typeLabel: 'Clean', groupLabel: 'Cleans', groupIcon: 'schedule', perm: 'schedule.view',
    select,
    keep: (j, now) => !j.startAt || !(Date.parse(j.startAt) < now - SEARCH_PAST_DAYS * DAY_MS),
    reads: ['clients', 'sites', 'services'],
    context: displayContext,
    signature: (j, s, now) => `${nameOf(s.clients, j.clientId) ?? ''}\u0001${nameOf(s.sites, j.siteId) ?? ''}\u0001${nameOf(s.services, j.serviceId) ?? ''}\u0001${effectiveStatus(j, now)}`,
    primary: (j, s) => nameOf(s.clients, j.clientId) || 'Clean',
    sublabel: (j, s, now) => cleanWords([
      j.startAt && visitDates(j.startAt).day,
      nameOf(s.services, j.serviceId),
      statusWord(effectiveStatus(j, now)),
    ]).join(' · '),
    keywords: (j, s, now) => cleanWords([
      nameOf(s.services, j.serviceId),
      nameOf(s.sites, j.siteId),
      j.startAt && visitDates(j.startAt).short,
      statusWord(effectiveStatus(j, now)),
      j.notes,
    ]),
    // A customer's cleans all share one label; show the ones nearest today first.
    order: (j, s, now) => (j.startAt ? Math.abs(new Date(j.startAt).getTime() - now) : Number.MAX_SAFE_INTEGER),
    to: (j) => `/schedule/${j.id}`,
    seeAll: () => '/schedule',
    seeAllLabel: 'Schedule',
  };
}
