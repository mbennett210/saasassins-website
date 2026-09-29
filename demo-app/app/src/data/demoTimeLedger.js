// Demo-only time-clock ledger seed. In local/demo mode the time-clock + variance
// run off a localStorage STUB ledger (lib/timeApi.js STUB_KEY) that starts EMPTY,
// so /variance opens on a blank state. This module builds ~22 realistic entries in
// the EXACT stub row shape written by stubClockIn (timeApi.js) so the Variance
// report — the demo's headline feature — is populated the moment the app loads.
//
// PURE. `buildDemoLedgerEntries(now)` takes the reference Date from the caller and
// NEVER reads the clock at module scope, so the same import is safe to evaluate at
// build time. All dates are RUNTIME-RELATIVE off `now` (a helper `at(...)` walks
// day-offsets in the machine's LOCAL tz) — "last night", 7d and 30d always have
// data no matter which day the demo is opened.
//
// Ids are ALL SYNTHETIC (job `j_demo_*`, entry `te_demo_*`): historical rows must
// NOT reference real "today" jobs, or a live crew clock-in would group with a stale
// seeded clean. Site/client/user ids + denormalized names + each site's expected
// minutes are resolved from the REAL seed so the rows join correctly to the store.
import { INITIAL_STATE } from './seed';
import { seedId } from '../lib/ids';

// ── seed resolvers (pure lookups over the already-imported INITIAL_STATE) ────────
const usersById = new Map((INITIAL_STATE.users || []).map((u) => [u.id, u]));
const sitesById = new Map((INITIAL_STATE.sites || []).map((s) => [s.id, s]));
const clientsById = new Map((INITIAL_STATE.clients || []).map((c) => [c.id, c]));

const userByKey = (key) => usersById.get(seedId('u', key)) || null;
const siteByKey = (key) => sitesById.get(seedId('st', key)) || null;

// ── runtime-relative clock ───────────────────────────────────────────────────────
// Build a LOCAL-time instant `dayOffset` days from `now` at h:m. Date normalizes
// day under/overflow, so month boundaries are handled. Returns epoch ms.
const at = (now, dayOffset, h, m) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m, 0, 0).getTime();

// Build ONE stub row. Field names + shape mirror stubClockIn() in lib/timeApi.js
// exactly (completed rows additionally carry clock_out_lat/lng, as stubClockOut()
// writes). Duration is derived from the timestamps so labor- and wall-clock-basis
// variance agree. Returns null if the site/user didn't resolve (seed drift guard).
function mk(now, spec) {
  const site = siteByKey(spec.site);
  const user = userByKey(spec.user);
  if (!site || !user) return null;
  const client = site.clientId ? clientsById.get(site.clientId) : null;

  const inMs = spec.openMinsAgo != null ? now.getTime() - spec.openMinsAgo * 60000 : at(now, spec.day, spec.inH, spec.inM);
  const open = spec.dur == null;
  const outMs = open ? null : inMs + spec.dur * 60000;
  const hasCoords = Number.isFinite(site.lat) && Number.isFinite(site.lng);

  // expected_minutes_snapshot: the site's expectedCleanMins by default, but a spec
  // may override it (`exp`) for a long-form scheduled job whose planned minutes
  // exceed the site's quick-clean default (e.g. the nightly warehouse deep clean).
  const expected = Number.isFinite(spec.exp) ? spec.exp : (Number.isFinite(site.expectedCleanMins) ? site.expectedCleanMins : null);

  const row = {
    id: spec.id,
    job_id: spec.job,
    series_id: null,
    shift_id: null,
    client_id: site.clientId || null,
    site_id: site.id,
    user_id: user.id,
    client_name: client ? client.name : null,
    site_name: site.name,
    user_name: user.name,
    scheduled_start: null,
    scheduled_end: null,
    expected_minutes_snapshot: expected,
    clock_in_at: new Date(inMs).toISOString(),
    clock_out_at: open ? null : new Date(outMs).toISOString(),
    duration_minutes: open ? null : spec.dur,
    clock_in_lat: hasCoords ? site.lat : null,
    clock_in_lng: hasCoords ? site.lng : null,
    clock_in_accuracy_m: hasCoords ? (spec.acc ?? 8) : null,
    clock_in_distance_m: spec.dist ?? null,
    geofence_result: spec.geo || 'inside',
    override_reason: spec.overrideReason ?? null,
    source: 'crew_mobile',
    status: open ? 'in_progress' : 'completed',
    approval_status: spec.appr || 'approved',
    edit_history: [],
  };
  if (!open && hasCoords) {
    row.clock_out_lat = site.lat;
    row.clock_out_lng = site.lng;
  }
  return row;
}

// ── the ledger story ──────────────────────────────────────────────────────────────
// Drives the Variance StatCards + drill-down. Cleans = rows sharing a job_id.
//   day -1 (17:00–23:45 "last night", ≥6h inside a noon-noon window so a PT/ET
//   machine-tz skew can't drop rows): the hero set — 1 red overrun, 1 amber
//   shortfall, on-targets, a 2-cleaner clean, a geofence override — all PENDING so
//   approve/reject is demoable. day 0: 1 OPEN row (~45m ago). day -2: an 'outside'
//   geofence row. days -2..-6: filler + Andre's nightly warehouse deep cleans that
//   push his week to ~34h (near the 40h OT-watch threshold). Older rows APPROVED.
function ledgerSpecs() {
  return [
    // ---- LAST NIGHT (day -1) — pending, awaiting supervisor review ----
    // 1) RED overrun: Andre +52 (172 vs 120), inside, tight geofence.
    { id: 'te_demo_1', job: 'j_demo_1', user: 'crew1', site: 'evgrn-main', day: -1, inH: 18, inM: 0, dur: 172, geo: 'inside', dist: 12, appr: 'pending' },
    // 2) AMBER shortfall: Tomas -28 (62 vs 90), inside.
    { id: 'te_demo_2', job: 'j_demo_2', user: 'crew2', site: 'mtb-clbhs', day: -1, inH: 17, inM: 30, dur: 62, geo: 'inside', dist: 8, appr: 'pending' },
    // 3–4) ON-TARGET.
    { id: 'te_demo_3', job: 'j_demo_3', user: 'crew3', site: 'lake-main', day: -1, inH: 19, inM: 0, dur: 124, geo: 'inside', dist: 15, appr: 'pending' },
    { id: 'te_demo_4', job: 'j_demo_4', user: 'crew4', site: 'pac-tower', day: -1, inH: 19, inM: 30, dur: 88, exp: 90, geo: 'inside', dist: 20, appr: 'pending' },
    // 5–6) MULTI-CLEANER clean: two rows, SAME job, different crew. Labor 58+62=120
    //      vs 120 → on target; proves we sum labor across cleaners (the Swept fix).
    { id: 'te_demo_5', job: 'j_demo_5', user: 'crew1', site: 'pac-tower', day: -1, inH: 21, inM: 0, dur: 58, geo: 'inside', dist: 9, appr: 'pending' },
    { id: 'te_demo_6', job: 'j_demo_5', user: 'crew4', site: 'pac-tower', day: -1, inH: 21, inM: 2, dur: 62, geo: 'inside', dist: 11, appr: 'pending' },
    // 7) GEOFENCE OVERRIDE: clocked in offsite w/ override, 115 vs 120 on target.
    { id: 'te_demo_7', job: 'j_demo_6', user: 'crew3', site: 'evgrn-main', day: -1, inH: 21, inM: 30, dur: 115, geo: 'override', dist: 125, overrideReason: 'crew_override_offsite', appr: 'pending' },

    // ---- NOW (day 0) — 1 OPEN row, someone on the clock (~45 min in) ----
    { id: 'te_demo_8', job: 'j_demo_7', user: 'crew4', site: 'oly-main', openMinsAgo: 45, dur: null, geo: 'inside', dist: 14, appr: 'pending' },

    // ---- day -2 — 'outside' geofence flag (~640m), on-target by minutes ----
    { id: 'te_demo_9', job: 'j_demo_8', user: 'crew2', site: 'pac-tower', day: -2, inH: 10, inM: 0, dur: 88, exp: 90, geo: 'outside', dist: 640, appr: 'approved' },

    // ---- Andre's nightly warehouse deep cleans (csc-main) — long scheduled jobs
    //      (exp 360, a full deep-clean shift, not the site's quick-clean default),
    //      all on target. These carry his week to ~34h. days -2..-6, approved. ----
    { id: 'te_demo_10', job: 'j_demo_9',  user: 'crew1', site: 'csc-main', day: -2, inH: 17, inM: 30, dur: 362, exp: 360, geo: 'inside', dist: 7, appr: 'approved' },
    { id: 'te_demo_11', job: 'j_demo_10', user: 'crew1', site: 'csc-main', day: -3, inH: 17, inM: 40, dur: 360, exp: 360, geo: 'inside', dist: 13, appr: 'approved' },
    { id: 'te_demo_12', job: 'j_demo_11', user: 'crew1', site: 'csc-main', day: -4, inH: 17, inM: 35, dur: 364, exp: 360, geo: 'inside', dist: 9, appr: 'approved' },
    { id: 'te_demo_13', job: 'j_demo_12', user: 'crew1', site: 'csc-main', day: -5, inH: 17, inM: 45, dur: 360, exp: 360, geo: 'inside', dist: 6, appr: 'approved' },
    { id: 'te_demo_14', job: 'j_demo_13', user: 'crew1', site: 'csc-main', day: -6, inH: 17, inM: 40, dur: 364, exp: 360, geo: 'inside', dist: 10, appr: 'approved' },

    // ---- filler across days -2..-6 (mixed flags, approved) ----
    { id: 'te_demo_15', job: 'j_demo_14', user: 'crew2', site: 'lake-main', day: -2, inH: 9,  inM: 0,  dur: 125, geo: 'inside', dist: 10, appr: 'approved' }, // on target
    { id: 'te_demo_16', job: 'j_demo_15', user: 'crew3', site: 'mtb-clbhs', day: -3, inH: 9,  inM: 0,  dur: 78,  geo: 'inside', dist: 12, appr: 'approved' }, // on target (-12)
    { id: 'te_demo_17', job: 'j_demo_16', user: 'crew4', site: 'evgrn-main', day: -3, inH: 13, inM: 0,  dur: 130, geo: 'inside', dist: 9,  appr: 'approved' }, // on target (+10)
    { id: 'te_demo_18', job: 'j_demo_17', user: 'crew2', site: 'evgrn-main', day: -4, inH: 9,  inM: 0,  dur: 82,  exp: 60, geo: 'inside', dist: 11, appr: 'approved' }, // RED +22
    { id: 'te_demo_19', job: 'j_demo_18', user: 'crew3', site: 'pac-tower', day: -4, inH: 14, inM: 0,  dur: 70,  exp: 90, geo: 'inside', dist: 16, appr: 'approved' }, // AMBER -20
    { id: 'te_demo_20', job: 'j_demo_19', user: 'crew4', site: 'lake-main', day: -5, inH: 10, inM: 0,  dur: 124, geo: 'inside', dist: 14, appr: 'approved' }, // on target
    { id: 'te_demo_21', job: 'j_demo_20', user: 'crew2', site: 'oly-main',  day: -5, inH: 13, inM: 0,  dur: 92,  geo: 'inside', dist: 18, appr: 'approved' }, // on target
    { id: 'te_demo_22', job: 'j_demo_21', user: 'crew3', site: 'evgrn-main', day: -6, inH: 9,  inM: 0,  dur: 128, geo: 'inside', dist: 13, appr: 'approved' }, // on target
  ];
}

// Build the demo ledger entries. `now` is the reference instant (the bootstrap
// passes new Date() at first load). Rows whose site/user can't resolve are dropped
// so seed drift degrades gracefully instead of blanking the app.
export function buildDemoLedgerEntries(now) {
  const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return ledgerSpecs()
    .map((spec) => mk(ref, spec))
    .filter(Boolean);
}

export default buildDemoLedgerEntries;
