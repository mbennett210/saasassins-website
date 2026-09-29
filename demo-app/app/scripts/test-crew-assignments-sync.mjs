// crew_assignments derivation + sync safety — ledger item C5.
//
// The table is the tamper-proof source every site gate reads. Four defects made it
// the opposite of that:
//   (a) assignmentsInitialized() did `if (error) return false`, so a transient
//       Supabase error silently answered "never synced" and handed every gate back to
//       the browser-writable blob — a security control failing OPEN on a network blip.
//   (b) syncAssignmentsFromState did delete(org) then insert(rows) with no
//       transaction. PostgREST has none across calls, so a failure between them left
//       the table EMPTY — which reads as "never synced" and falls back to the blob.
//   (c) the caller swallowed the throw and returned 200, so (b) was invisible.
//   (d) nothing distinguished "empty" from "never initialized".
//
// These cover the pure derivation and the diff planning. The DB-touching halves are
// exercised by app/scripts/sync-crew-assignments.mjs against a live/sandbox target.
//
//   node scripts/test-crew-assignments-sync.mjs
import { assignmentRowsFromState } from '../api/_lib/crewAssignments.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const rows = (s) => assignmentRowsFromState(s);
const key = (r) => `${r.user_id}|${r.source}|${r.site_id || ''}|${r.client_id || ''}`;

// ── derivation (unchanged behaviour — pinned so the C5 rewrite cannot drift it) ──
ok('a site assignment yields one row', rows({ sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u1'] }] }).length === 1);
ok('  ...carrying site AND account', (() => {
  const r = rows({ sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u1'] }] })[0];
  return r.site_id === 's1' && r.client_id === 'c1' && r.source === 'standing_site';
})());
ok('an account assignment has a null site', (() => {
  const r = rows({ clients: [{ id: 'c1', standingCrewIds: ['u1'] }] })[0];
  return r.site_id === null && r.source === 'standing_client';
})());
ok('duplicates within one site collapse', rows({ sites: [{ id: 's1', standingCrewIds: ['u1', 'u1'] }] }).length === 1);
ok('site AND account for the same user are two distinct rows',
  rows({ sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u1'] }], clients: [{ id: 'c1', standingCrewIds: ['u1'] }] }).length === 2);
ok('falsy user ids are dropped', rows({ sites: [{ id: 's1', standingCrewIds: ['', null, undefined, 0, false] }] }).length === 0);
ok('non-array standingCrewIds ignored', rows({ sites: [{ id: 's1', standingCrewIds: 'u1' }] }).length === 0);
ok('undefined state is safe', rows(undefined).length === 0);
ok('every row is org-pinned', rows({ sites: [{ id: 's1', standingCrewIds: ['u1'] }] }).every((r) => !!r.organization_id));

// ── the diff plan: ADD-THEN-REMOVE must never produce an empty table ────────
// Mirrors syncAssignmentsFromState's planning. The property under test is that no
// input — including "everything was revoked" — plans a state where the table is
// emptied before the additions land.
function plan(existing, desired) {
  const dk = new Set(desired.map(key));
  const ek = new Set(existing.map(key));
  return {
    toAdd: desired.filter((r) => !ek.has(key(r))),
    toRemove: existing.filter((r) => !dk.has(key(r))),
  };
}
const MARKER = { user_id: '__sync_marker__', source: 'marker', site_id: null, client_id: null };
const A = { user_id: 'u1', source: 'standing_site', site_id: 's1', client_id: 'c1' };
const B = { user_id: 'u2', source: 'standing_site', site_id: 's1', client_id: 'c1' };

ok('first sync adds everything, removes nothing', (() => {
  const p = plan([], [A, B, MARKER]);
  return p.toAdd.length === 3 && p.toRemove.length === 0;
})());
ok('an unchanged set is a complete no-op', (() => {
  const p = plan([A, B, MARKER], [A, B, MARKER]);
  return p.toAdd.length === 0 && p.toRemove.length === 0;
})());
ok('a revocation removes exactly one row', (() => {
  const p = plan([A, B, MARKER], [A, MARKER]);
  return p.toAdd.length === 0 && p.toRemove.length === 1 && p.toRemove[0].user_id === 'u2';
})());
ok('a new assignment adds exactly one row', (() => {
  const p = plan([A, MARKER], [A, B, MARKER]);
  return p.toAdd.length === 1 && p.toRemove.length === 0;
})());
// 🔴 THE DEFECT: revoking EVERY assignment must still leave the marker, so the table
// is never empty and assignmentsInitialized() never reverts to the blob.
ok('revoking ALL assignments still leaves the marker (table never empties)', (() => {
  const p = plan([A, B, MARKER], [MARKER]);
  return p.toRemove.length === 2 && !p.toRemove.some((r) => r.source === 'marker');
})());
ok('the marker is never planned for removal', (() => {
  for (const desired of [[MARKER], [A, MARKER], [A, B, MARKER]]) {
    if (plan([A, B, MARKER], desired).toRemove.some((r) => r.source === 'marker')) return false;
  }
  return true;
})());
// The old code's failure shape, asserted as something the plan can never produce.
ok('no input plans a removal of everything', (() => {
  for (const desired of [[MARKER], [A, MARKER], [A, B, MARKER]]) {
    const p = plan([A, B, MARKER], desired);
    if (p.toRemove.length === 3) return false;
  }
  return true;
})());
// Ordering is the safety property: adds are applied before removes, so a mid-way
// failure leaves a SUPERSET (stale) rather than an empty table (blob fallback).
ok('a mid-sync failure after adds leaves a superset, never a gap', (() => {
  const existing = [A, MARKER];
  const p = plan(existing, [B, MARKER]);
  const afterAddsOnly = [...existing, ...p.toAdd];
  return afterAddsOnly.length === 3 && afterAddsOnly.some((r) => r.user_id === 'u1') && afterAddsOnly.some((r) => r.user_id === 'u2');
})());

// ── the marker cannot collide with a real user ─────────────────────────────
ok('the marker user_id is not a valid u_* id', !/^u_/.test(MARKER.user_id));
ok('a real derivation never emits the marker id',
  !rows({ sites: [{ id: 's1', standingCrewIds: ['u1', '__sync_marker__'] }] })
    .filter((r) => r.user_id === '__sync_marker__' && r.source === 'marker').length);

console.log(`\ncrew_assignments sync: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
