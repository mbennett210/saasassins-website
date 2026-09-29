// Drive time BETWEEN jobs — the paid-travel engine (Swept-parity supplement).
//
// Clean Space pays a cleaner for the time between finishing one clean and arriving at
// the next: the gap from clock-OUT at job A to clock-IN at job B. The commute from
// home to the first clean and from the last clean home is NOT paid — and it can't
// be recorded here by construction, because a segment needs a clock-out on one side
// and a clock-in on the other. Every leg is derived from the time_entries ledger;
// NOTHING is stored per segment, so correcting a clock time self-heals the drive
// numbers (and payroll) with no backfill.
//
// PURE. No React / store / browser deps and explicit .js imports only, so the
// SERVER report route (api/_lib/time/driveCompute.js), the demo stub (driveApi.js)
// and the report UI all derive and flag IDENTICALLY — server and client can never
// disagree. Same contract as lib/variance.js. See CLEANSPACE_SWEPT.md §5.4 / §5.5.
//
// Timestamp math only — NO calendar-day logic. The gap cap (default 3h) is what
// separates "drove to the next site" from "went home"; a day boundary would
// wrongly split a night crew's 10 PM → 2 AM run across two days.

import { haversineMeters } from './geo.js';

export const DEFAULT_DRIVE_MAX_GAP_MINS = 180; // > this and it's a break / went home, not a drive
export const DEFAULT_DRIVE_FLAG_PCT = 15;      // flag when actual exceeds the estimate by this %
export const DEFAULT_DRIVE_GRACE_MINS = 5;     // absolute floor so a 4-min hop can't flag on 1 min

// Entries in these states are INVISIBLE to pairing (removed before we walk the
// list, not treated as a wall). Voiding an accidental wrong-job punch that sat
// between two real cleans must RESTORE the real A→B drive, not delete it.
const TRANSPARENT_STATUSES = new Set(['voided', 'no_show']);

// Statuses whose clock_out_at is SYNTHETIC and therefore can't start a drive: the
// auto-close cron stamps clock_out_at = scheduled_end for a forgotten clock-out, so
// the "gap" after it is fiction. The same row's clock_IN is real, so it can still
// END a drive (auto_closed is only excluded on the `prev` side).
const SYNTHETIC_OUT_STATUSES = new Set(['auto_closed']);

const ts = (v) => (v ? new Date(v).getTime() : NaN);
const fin = (n) => (Number.isFinite(n) ? n : 0);
const num = (n, fallback) => (Number.isFinite(n) ? n : fallback);

// Stable key for one segment — the pair of bounding entry ids. This is also the
// override key (drive_segment_overrides), so a manager ruling survives a report
// refresh but is invalidated the moment the underlying entries change.
export const driveSegmentKey = (fromEntryId, toEntryId) => `${fromEntryId}|${toEntryId}`;
// Cache key for a DIRECTIONAL site pair (A→B and B→A can differ — one-ways, tolls).
export const driveEstimateKey = (fromSiteId, toSiteId) => `${fromSiteId || ''}>${toSiteId || ''}`;

// ── derivation ────────────────────────────────────────────────────────────────
// entries: the neutral camelCase shape (id, userId, userName, siteId, siteName,
// clientId, clientName, clockInAt, clockOutAt, status, approvalStatus). Open rows
// MUST be included by the caller — a forgotten clock-out that's invisible to the
// query would let its neighbours pair across it and fabricate a drive that contains
// a whole clean.
export function deriveDriveSegments(entries, { maxGapMins = DEFAULT_DRIVE_MAX_GAP_MINS } = {}) {
  const cap = num(maxGapMins, DEFAULT_DRIVE_MAX_GAP_MINS);
  const byUser = new Map();
  for (const e of entries || []) {
    if (!e || !e.userId) continue;
    if (TRANSPARENT_STATUSES.has(e.status)) continue;
    if (!Number.isFinite(ts(e.clockInAt))) continue;
    if (!byUser.has(e.userId)) byUser.set(e.userId, []);
    byUser.get(e.userId).push(e);
  }

  const segments = [];
  for (const list of byUser.values()) {
    // Deterministic order — the id tie-break keeps two same-instant clock-ins from
    // deriving differently on the server, in the demo stub, and in the tests.
    list.sort((a, b) => (ts(a.clockInAt) - ts(b.clockInAt)) || String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < list.length; i += 1) {
      const seg = pairSegment(list[i - 1], list[i], cap);
      if (seg) segments.push(seg);
    }
  }
  return segments.sort(
    (a, b) => (ts(a.startAt) - ts(b.startAt)) || String(a.key).localeCompare(String(b.key)),
  );
}

function pairSegment(prev, next, capMins) {
  if (!prev.clockOutAt) return null;                        // still on the clock — no drive yet
  if (SYNTHETIC_OUT_STATUSES.has(prev.status)) return null; // auto-closed out time is fiction
  const out = ts(prev.clockOutAt);
  const inn = ts(next.clockInAt);
  if (!Number.isFinite(out) || !Number.isFinite(inn)) return null;
  const gap = Math.round((inn - out) / 60000);
  if (gap <= 0) return null;        // overlapping / out-of-order rows — not a drive
  if (gap > capMins) return null;   // a break, a second shift, or they went home
  return {
    key: driveSegmentKey(prev.id, next.id),
    userId: prev.userId,
    userName: prev.userName || next.userName || '—',
    fromEntryId: prev.id,
    toEntryId: next.id,
    fromSiteId: prev.siteId || null,
    fromSiteName: prev.siteName || '—',
    fromClientId: prev.clientId || null,
    fromClientName: prev.clientName || '—',
    toSiteId: next.siteId || null,
    toSiteName: next.siteName || '—',
    toClientId: next.clientId || null,
    toClientName: next.clientName || '—',
    startAt: prev.clockOutAt,
    endAt: next.clockInAt,
    actualMinutes: gap,
    // Carried so payability is decidable from the segment alone (payroll never
    // re-joins the entries), and so the drill-down can explain a skipped row.
    fromStatus: prev.status || null,
    toStatus: next.status || null,
    fromApprovalStatus: prev.approvalStatus || 'pending',
    toApprovalStatus: next.approvalStatus || 'pending',
    toOpen: !next.clockOutAt,
  };
}

// ── estimates + flagging ──────────────────────────────────────────────────────
// lookup: Map (or plain object) keyed by driveEstimateKey() -> { durationMinutes,
// distanceMeters, source, fetchedAt } — or a function taking (fromSiteId, toSiteId).
// A miss means "no estimate available" (site not geocoded, Google unreachable, or
// the pair is queued for the next load) — NEVER an implicit zero, which would flag
// every un-estimated leg as an overage.
export function applyDriveEstimates(segments, lookup, {
  flagPct = DEFAULT_DRIVE_FLAG_PCT, graceMins = DEFAULT_DRIVE_GRACE_MINS,
} = {}) {
  const pct = Math.max(0, num(flagPct, DEFAULT_DRIVE_FLAG_PCT));
  const grace = Math.max(0, num(graceMins, DEFAULT_DRIVE_GRACE_MINS));
  const get = (from, to) => {
    if (!lookup) return null;
    if (typeof lookup === 'function') return lookup(from, to) || null;
    const k = driveEstimateKey(from, to);
    return (lookup instanceof Map ? lookup.get(k) : lookup[k]) || null;
  };

  return (segments || []).map((s) => {
    // Same site both sides = they never drove (a split shift / break at one site).
    // Two SITELESS entries are NOT "the same site" — we simply don't know where
    // they were, so they fall through to no_estimate rather than fabricating a
    // zero-minute baseline that flags the whole gap as an overage.
    const sameSite = !!s.fromSiteId && !!s.toSiteId && s.fromSiteId === s.toSiteId;
    const est = sameSite ? null : get(s.fromSiteId, s.toSiteId);
    const estimateMinutes = sameSite ? 0 : (Number.isFinite(est?.durationMinutes) ? est.durationMinutes : null);
    const hasEstimate = estimateMinutes != null;
    const allowedMinutes = hasEstimate ? Math.round(estimateMinutes * (1 + pct / 100) + grace) : null;
    let flag;
    if (sameSite) flag = 'same_site';
    else if (!hasEstimate) flag = 'no_estimate';
    else flag = s.actualMinutes > allowedMinutes ? 'over' : 'on_target';
    return {
      ...s,
      estimateMinutes,
      allowedMinutes,
      estimateSource: sameSite ? 'same_site' : (est?.source || null),
      distanceMeters: sameSite ? 0 : (Number.isFinite(est?.distanceMeters) ? est.distanceMeters : null),
      overMinutes: hasEstimate ? s.actualMinutes - estimateMinutes : null,
      overPct: hasEstimate && estimateMinutes > 0
        ? Math.round(((s.actualMinutes - estimateMinutes) / estimateMinutes) * 100)
        : null,
      flag,
    };
  });
}

// ── manager overrides ─────────────────────────────────────────────────────────
// A flagged leg is a conversation, not an automatic deduction: recorded travel
// between job sites is compensable time, so nothing is docked silently. A manager
// may adjust the PAID minutes (or exclude the leg) with a required reason; the
// recorded actual is never rewritten. Payroll pays `paidMinutes`.
// overrides: array of { fromEntryId, toEntryId, excluded, paidMinutes, reason,
// createdByName, createdAt } or a Map keyed by driveSegmentKey().
export function applyDriveOverrides(segments, overrides) {
  const map = overrides instanceof Map
    ? overrides
    : new Map((overrides || []).map((o) => [driveSegmentKey(o.fromEntryId, o.toEntryId), o]));
  return (segments || []).map((s) => {
    const o = map.get(s.key) || null;
    const paidMinutes = !o
      ? s.actualMinutes
      : (o.excluded ? 0 : (Number.isFinite(o.paidMinutes) ? Math.max(0, o.paidMinutes) : s.actualMinutes));
    return { ...s, override: o, adjusted: !!o, paidMinutes };
  });
}

// True when this leg's minutes should reach payroll. BOTH bounding entries gate it:
// a segment can only be paid if the cleans on either side of it are themselves
// payable, so an unapproved / rejected / voided clean can't smuggle its travel in.
// `paidMinutes` (an override may have zeroed it) must be positive.
export function isSegmentPayable(seg, { approvedOnly = false } = {}) {
  if (!seg) return false;
  const paid = Number.isFinite(seg.paidMinutes) ? seg.paidMinutes : seg.actualMinutes;
  if (!Number.isFinite(paid) || paid <= 0) return false;
  if (TRANSPARENT_STATUSES.has(seg.fromStatus) || TRANSPARENT_STATUSES.has(seg.toStatus)) return false;
  if (seg.fromApprovalStatus === 'rejected' || seg.toApprovalStatus === 'rejected') return false;
  if (approvedOnly && (seg.fromApprovalStatus !== 'approved' || seg.toApprovalStatus !== 'approved')) return false;
  return true;
}

// Minutes a segment contributes to pay (0 when it isn't payable).
export function segmentPaidMinutes(seg, opts = {}) {
  if (!isSegmentPayable(seg, opts)) return 0;
  return Number.isFinite(seg.paidMinutes) ? seg.paidMinutes : seg.actualMinutes;
}

// ── report assembly ───────────────────────────────────────────────────────────
// Worst overage first (the morning scan), then longest drive, then most recent.
function reportSort(a, b) {
  const rank = (r) => (r.flag === 'over' ? 0 : r.flag === 'on_target' ? 1 : 2);
  const fr = rank(a) - rank(b);
  if (fr !== 0) return fr;
  const ao = a.overMinutes == null ? -Infinity : a.overMinutes;
  const bo = b.overMinutes == null ? -Infinity : b.overMinutes;
  if (bo !== ao) return bo - ao;
  if (b.actualMinutes !== a.actualMinutes) return b.actualMinutes - a.actualMinutes;
  return String(b.startAt || '').localeCompare(String(a.startAt || ''));
}

export function buildDriveReport(segments) {
  const rows = [...(segments || [])].sort(reportSort);
  const withEstimate = rows.filter((r) => r.estimateMinutes != null && r.flag !== 'same_site');
  const summary = {
    segmentCount: rows.length,
    totalDriveMinutes: rows.reduce((s, r) => s + fin(r.actualMinutes), 0),
    payableDriveMinutes: rows.reduce((s, r) => s + fin(r.paidMinutes ?? r.actualMinutes), 0),
    flaggedCount: rows.filter((r) => r.flag === 'over').length,
    adjustedCount: rows.filter((r) => r.adjusted).length,
    noEstimateCount: rows.filter((r) => r.flag === 'no_estimate').length,
    sameSiteCount: rows.filter((r) => r.flag === 'same_site').length,
    estimatedCount: withEstimate.length,
    // Share of comparable (different-site) legs that actually have an estimate —
    // surfaced so the report never implies full coverage on a partial one.
    estimateCoverage: (() => {
      const comparable = rows.filter((r) => r.flag !== 'same_site').length;
      return comparable ? Math.round((withEstimate.length / comparable) * 100) : null;
    })(),
    totalOverMinutes: withEstimate.reduce((s, r) => s + Math.max(0, fin(r.overMinutes)), 0),
    cleanerCount: new Set(rows.map((r) => r.userId)).size,
  };
  return { rows, summary };
}

// ── The PAYROLL read: a leg belongs to the window its DEPARTURE falls in ────────
// payroll.js buckets a leg by `startAt` (the clock-out it leaves from), so every read
// that pays or totals drive keeps exactly the legs whose startAt is inside its window —
// then contiguous windows (two pay periods, the weekly chunks of one read) pay each leg
// exactly once, in the week it was driven. The punches that can bound such a leg reach
// back to the departing clean's CLOCK-IN (a leg starts at a clock-out, up to a whole
// shift after its clock-in) and forward by the gap cap (the arriving clock-in). The old
// payroll read padded back from the clock-in only by the gap cap and kept legs by their
// ARRIVAL, so a Saturday-night leg into a Sunday clean was paid in neither biweekly run,
// or bucketed into a week the run couldn't see (review, 2026-09-22).
export const PAYROLL_SHIFT_LOOKBACK_MS = 18 * 3600 * 1000; // longer than any single clean

export function payrollLegFetchWindow({ fromIso, toIso, maxGapMins = DEFAULT_DRIVE_MAX_GAP_MINS } = {}) {
  const gap = num(maxGapMins, DEFAULT_DRIVE_MAX_GAP_MINS);
  return {
    fromIso: new Date(ts(fromIso) - PAYROLL_SHIFT_LOOKBACK_MS).toISOString(),
    toIso: new Date(ts(toIso) + gap * 60000).toISOString(),
  };
}

export function legsDepartingIn(segments, { fromIso, toIso } = {}) {
  const from = ts(fromIso);
  const to = ts(toIso);
  return (segments || []).filter((s) => {
    const t = ts(s.startAt);
    return Number.isFinite(t) && t >= from && t <= to;
  });
}

// One call: derive → override → estimate → assemble. Used by the server route and
// the demo stub so the whole pipeline order is defined in exactly one place.
export function runDriveReport(entries, { estimates, overrides, config = {} } = {}) {
  const segments = deriveDriveSegments(entries, { maxGapMins: config.maxGapMins });
  const overridden = applyDriveOverrides(segments, overrides);
  const flagged = applyDriveEstimates(overridden, estimates, {
    flagPct: config.flagPct, graceMins: config.graceMins,
  });
  return buildDriveReport(flagged);
}

// Unique directional site pairs needing an estimate (drops same-site and siteless
// legs — nothing to look up). Feeds the cache read + the Google fetch batch.
export function collectSitePairs(segments) {
  const seen = new Map();
  for (const s of segments || []) {
    if (!s.fromSiteId || !s.toSiteId || s.fromSiteId === s.toSiteId) continue;
    const k = driveEstimateKey(s.fromSiteId, s.toSiteId);
    if (!seen.has(k)) seen.set(k, { fromSiteId: s.fromSiteId, toSiteId: s.toSiteId });
  }
  return [...seen.values()];
}

// ── demo / fallback estimate ─────────────────────────────────────────────────
// Straight-line distance × a road-winding factor at an urban average speed. Used by
// the demo stub (no Google key in local mode) and NEVER in production reporting —
// a real estimate always comes from the Routes API and carries source:'google'.
export const ROAD_WINDING_FACTOR = 1.3;
export const AVG_DRIVE_KPH = 40;

export function stubDriveEstimate(fromSite, toSite) {
  const meters = haversineMeters(fromSite?.lat, fromSite?.lng, toSite?.lat, toSite?.lng);
  if (meters == null) return null;
  const roadMeters = Math.round(meters * ROAD_WINDING_FACTOR);
  const minutes = Math.max(1, Math.round(roadMeters / ((AVG_DRIVE_KPH * 1000) / 60)));
  return { durationMinutes: minutes, distanceMeters: roadMeters, source: 'estimate_stub' };
}

// ── display helpers (the STYLING.md Badge vocabulary) ────────────────────────
// over = red (paying for unbudgeted travel), on_target = green, and the two
// "can't judge this" states stay slate so they never read as a problem.
export function driveFlagBadgeVariant(flag) {
  switch (flag) {
    case 'over': return 'red';
    case 'on_target': return 'green';
    default: return 'slate';
  }
}

export function driveFlagLabel(flag) {
  switch (flag) {
    case 'over': return 'Over estimate';
    case 'on_target': return 'On target';
    case 'same_site': return 'Same site';
    default: return 'No estimate';
  }
}
