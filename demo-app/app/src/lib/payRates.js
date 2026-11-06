// PAY RATES BY BUILDING (PAY-7 / PAY-18, Matt 2026-09-29: "one cleaner might have two rate
// during the day gets $15 at abd building and at night gets $17 at yzd building").
//
// ONE cleaner, ONE main rate, plus an optional per-CUSTOMER override. This file owns the
// FIELD — its shape, how it is read, and how the office edits it — and nothing else. The MONEY
// that comes out of it (the weekly blended-rate overtime) lives in lib/payroll.js beside
// `basePayForUser`, which is the only pricer; keeping the two apart is what lets payroll.js
// import this without a cycle.
//
// NO React, NO store, NO browser, NO imports at all: the server pay run
// (api/_lib/payroll/compute.js), the demo stub (lib/payrollApi.js), the pay-run views and the
// tests all read this one vocabulary.
//
//   user.pay = {
//     type: 'hourly', hourlyRate: 15,                 // the MAIN rate — unchanged
//     buildingRates: [{ clientId: 'cl_x', hourlyRate: 17 }],   // optional, sparse
//     …
//   }
//
// SPARSE BY CONTRACT. Absent (or null, or []) means "one rate everywhere", which is what every
// existing member carries, so the field is additive and default-safe → NO store-version bump.
// It rides inside `pay`, which `api/_lib/orgStateGuard.js` already covers whole
// (`canonical(u?.pay ?? null)` in `protectedFingerprint`, `FIELD_KEYS` → `payroll.rates.edit`),
// so a building rate is money the guard already protects — no new guard rule, and no way to
// change one without the key.
//
// 🔴 WHY A CUSTOMER AND NOT A SITE. A punch's pay unit in this build is its CUSTOMER
// (`time_entries.client_id`): that is the grain the weekly OT ledger buckets by
// (lib/otLedger `(userId, weekKey, clientId)`), the grain a manager approves OT at, and the
// grain arrears are stored at. In Clean Space's book a customer IS the building (Las Olas
// Medical Group, Lakeside Office Park, Coral Bay HOA), so this matches what Matt means by
// "building" while keeping ONE unit through the whole ledger. A punch with no customer
// (`client_id` null — an ad-hoc clean) prices at the main rate, like everything else unmatched.

// Money in CENTS at the boundary (THE LAW II.8). A rate is STORED in dollars, like
// `pay.hourlyRate` beside it, and converted here so every pricer reads integer cents.
export const rateCentsOf = (rate) => Math.round((Number(rate) || 0) * 100);

// A rate, or null. $0 IS a rate (an unpaid arrangement at one building is a decision the office
// may record). A NEGATIVE one is not, and neither is a BLANK one — `Number('')`, `Number(null)`
// and `Number(false)` are all 0 and finite, so testing `Number.isFinite` alone would read a
// half-typed field as "$0 an hour" and quietly pay nothing for every hour at that building.
// ONE predicate, read by both the reader and the editor, so the two cannot disagree about what
// counts as set.
const numericRate = (v) => {
  const n = typeof v === 'number' ? v
    : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// A valid override row: a real customer id and a real, non-negative rate.
const validRow = (r) => !!r
  && typeof r.clientId === 'string' && r.clientId.trim() !== ''
  && numericRate(r.hourlyRate) !== null;

// The normalized override list: valid rows only, at most one per customer (the FIRST wins, so
// a duplicated id can never make the same week price two ways depending on read order), in
// stored order. [] for every member who has none — the common case.
export function buildingRatesOf(pay) {
  const src = Array.isArray(pay?.buildingRates) ? pay.buildingRates : [];
  const seen = new Set();
  const out = [];
  for (const r of src) {
    if (!validRow(r)) continue;
    const clientId = r.clientId.trim();
    if (seen.has(clientId)) continue;
    seen.add(clientId);
    out.push({ clientId, hourlyRate: numericRate(r.hourlyRate) });
  }
  return out;
}

// Does this member have any building rate at all? The one predicate a display or a fast path
// should branch on, so "one rate everywhere" stays the cheap, unchanged case.
export function hasBuildingRates(pay) {
  return buildingRatesOf(pay).length > 0;
}

// The DOLLARS-per-hour rate a punch at `clientId` prices at: that building's override, else
// the main rate. Non-hourly pay types have no hourly rate, so they read 0 here and are priced
// by their own rule in basePayForUser.
export function rateForBuilding(pay, clientId) {
  const id = clientId == null ? '' : String(clientId);
  if (id !== '') {
    const hit = buildingRatesOf(pay).find((r) => r.clientId === id);
    if (hit) return hit.hourlyRate;
  }
  return Number(pay?.hourlyRate) || 0;
}

// The same rate in integer CENTS — what every pricer buckets by.
export function rateCentsForBuilding(pay, clientId) {
  return rateCentsOf(rateForBuilding(pay, clientId));
}

// The next `buildingRates` value after the office edits one building's rate. `rate` null /
// '' / undefined REMOVES the override (back to the main rate). Returns null — never [] —
// once nothing is left, so the field stays genuinely sparse: the org_state money fingerprint
// returns to its previous value and a reader that predates this module still sees "one rate".
export function setBuildingRate(pay, clientId, rate) {
  const id = clientId == null ? '' : String(clientId).trim();
  if (id === '') return pay?.buildingRates ?? null;
  const rest = buildingRatesOf(pay).filter((r) => r.clientId !== id);
  const n = numericRate(rate);
  const next = n === null ? rest : [...rest, { clientId: id, hourlyRate: n }];
  return next.length ? next : null;
}

// Drop an override (the × on a row).
export function removeBuildingRate(pay, clientId) {
  return setBuildingRate(pay, clientId, null);
}

// 🔴 A DEPARTED CUSTOMER'S RATE IS NOT A RATE. A building rate pointing at a customer that is
// no longer on file can never match a punch (the punch carries the customer id), so it is dead
// weight in the money fingerprint; the office sees it as "Removed customer" and can clear it.
// This is the reader for that display — the pricer needs no such check, because an unmatched
// id simply never resolves.
export function orphanBuildingRates(pay, clientIds) {
  const live = clientIds instanceof Set ? clientIds : new Set(Array.isArray(clientIds) ? clientIds : []);
  return buildingRatesOf(pay).filter((r) => !live.has(r.clientId));
}
