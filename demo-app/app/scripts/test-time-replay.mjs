// Node unit test for the PAYROLL-CRITICAL offline clock replay (store.replayPunch).
// It drives the REAL server code with an in-memory fake Supabase table + a fixture
// org-state injected via Node's built-in module mocking — no live backend, no login.
// Run:  node --experimental-test-module-mocks scripts/test-time-replay.mjs   (from app/)
import { mock } from 'node:test';
import { CLEANSPACE_ORG_ID } from '../api/_lib/constants.js';

// ── in-memory time_entries fake (only the chains store.js uses) ────────────────
const rows = [];
let idSeq = 0;
const clone = (r) => (r ? { ...r } : r);

function matches(row, filters) {
  return filters.every(([col, val]) => row[col] === val);
}

function makeFakeDb(store) {
  return {
    from() {
      const st = { op: 'select', filters: [], payload: null };
      const qb = {
        select() { return qb; },
        eq(col, val) { st.filters.push([col, val]); return qb; },
        is(col, val) { st.filters.push([col, val]); return qb; },
        limit() { return qb; }, // pre-insert open-row reconcile chains .limit(1)
        insert(row) { st.op = 'insert'; st.payload = row; return qb; },
        update(patch) { st.op = 'update'; st.payload = patch; return qb; },
        maybeSingle() {
          const m = store.filter((r) => matches(r, st.filters));
          if (m.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
          return { data: clone(m[0]) || null, error: null };
        },
        single() {
          if (st.op === 'insert') {
            const row = { ...st.payload };
            if (!row.id) row.id = `srv_${++idSeq}`;
            // partial-unique (organization_id, client_punch_id) where client_punch_id not null
            if (row.client_punch_id != null
              && store.some((r) => r.organization_id === row.organization_id && r.client_punch_id === row.client_punch_id)) {
              return { data: null, error: { code: '23505', message: 'dup client_punch_id' } };
            }
            // one-open-per-(user,job) where status='in_progress'
            if (row.status === 'in_progress'
              && store.some((r) => r.status === 'in_progress' && r.user_id === row.user_id && r.job_id === row.job_id)) {
              return { data: null, error: { code: '23505', message: 'one open per user/job' } };
            }
            store.push(row);
            return { data: clone(row), error: null };
          }
          if (st.op === 'update') {
            const m = store.filter((r) => matches(r, st.filters));
            if (m.length !== 1) return { data: null, error: { message: 'update not single' } };
            Object.assign(m[0], st.payload);
            return { data: clone(m[0]), error: null };
          }
          const m = store.filter((r) => matches(r, st.filters));
          if (m.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'not single' } };
          return { data: clone(m[0]), error: null };
        },
      };
      return qb;
    },
  };
}
const fakeDb = makeFakeDb(rows);

// ── fixture org-state: one site (geocoded), client, user, and a job assigned to u1 ─
const SITE = { lat: 47.5, lng: -122.3 };
const FIXTURE = {
  jobs: [{ id: 'j1', siteId: 's1', clientId: 'c1', seriesId: 'ser1', shiftId: null, crewIds: ['u1'], startAt: '2026-07-14T15:00:00.000Z', endAt: '2026-07-14T17:00:00.000Z' }],
  sites: [{ id: 's1', clientId: 'c1', name: 'HQ', lat: SITE.lat, lng: SITE.lng, geofenceRadiusM: 76, geofenceEnabled: true, standingCrewIds: [] }],
  clients: [{ id: 'c1', name: 'Acme', standingCrewIds: [], expectedCleanMins: 120 }],
  users: [{ id: 'u1', name: 'Marcus', email: 'marcus@x.com' }, { id: 'u2', name: 'Jamie', email: 'jamie@x.com' }],
  opsSettings: { defaultGeofenceRadiusM: 76, offlineReplayWindowHours: 12 },
};

mock.module('../api/_lib/supabase.js', { namedExports: { getSupabase: () => fakeDb } });
mock.module('../api/_lib/orgState.js', { namedExports: { readOrgState: async () => ({ state: FIXTURE, version: 1 }) } });
// B1 moved jobs out of the blob: resolveJobContext reads public.jobs via
// getJobById, which the fixture must serve (un-mocked it queried the fake
// time_entries store, found nothing, and every replay silently returned
// notFound — the whole suite was broken-in-the-skip-list until this mock).
mock.module('../api/_lib/jobsTable.js', { namedExports: {
  getJobById: async (id) => FIXTURE.jobs.find((j) => j.id === id) || null,
} });

const { replayPunch } = await import('../api/_lib/time/store.js');

// ── harness ───────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };
const reset = () => { rows.length = 0; };
const near = { lat: SITE.lat + 33 / 111320, lng: SITE.lng }; // ~33 m → inside
const far = { lat: SITE.lat + 555 / 111320, lng: SITE.lng };  // ~555 m → outside
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const H = 3600 * 1000;
const MIN = 60 * 1000;

// 1. Fresh in+out replay, in-window → ONE completed row with the asserted times.
{
  reset();
  const inAt = iso(-2 * H);
  const outAt = iso(-1 * H);
  const r = await replayPunch({ clientPunchId: 'op_1', userId: 'u1', jobId: 'j1', assertedInAt: inAt, assertedOutAt: outAt, inLat: near.lat, inLng: near.lng, inAccuracyM: 10, windowHours: 12 });
  ok(rows.length === 1, `1: exactly one row inserted (got ${rows.length})`);
  ok(r.entry && r.entry.clock_in_at === inAt, '1: clock_in_at = asserted in-time (in window)');
  ok(r.entry && r.entry.clock_out_at === outAt, '1: clock_out_at = asserted out-time');
  ok(r.entry && r.entry.duration_minutes === 60, `1: duration = 60 min (got ${r.entry && r.entry.duration_minutes})`);
  ok(r.entry && r.entry.source === 'offline_replay', '1: source = offline_replay');
  ok(r.entry && r.entry.approval_status === 'pending', '1: approval_status = pending (not auto-paid)');
  ok(r.entry && r.entry.status === 'completed', '1: status = completed');
  ok(r.entry && r.entry.geofence_result === 'inside', '1: geofence re-run server-side → inside');
  ok(r.entry && r.entry.client_punch_id === 'op_1', '1: carries client_punch_id');
}

// 2. Idempotency — replaying the SAME punch id again returns the same row, no insert.
{
  const r = await replayPunch({ clientPunchId: 'op_1', userId: 'u1', jobId: 'j1', assertedInAt: iso(-2 * H), assertedOutAt: iso(-1 * H), inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.idempotent === true, '2: second replay flagged idempotent');
  ok(rows.length === 1, `2: no duplicate row (still ${rows.length})`);
}

// 3. Lost-ACK dedup — a row already committed by the online clock-in (same key) blocks the replay.
{
  reset();
  rows.push({ id: 'srv_online', organization_id: CLEANSPACE_ORG_ID, client_punch_id: 'op_2', user_id: 'u1', job_id: 'j1', clock_in_at: iso(-2 * H), clock_out_at: null, status: 'in_progress' });
  const r = await replayPunch({ clientPunchId: 'op_2', userId: 'u1', jobId: 'j1', assertedInAt: iso(-2 * H), inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.idempotent === true && r.entry.id === 'srv_online', '3: lost-ACK → returns the existing online row');
  ok(rows.length === 1, `3: no duplicate payable row (still ${rows.length})`);
}

// 4. Out-of-window — an asserted time 13 h ago is server-stamped (NOT trusted) + flagged.
{
  reset();
  const stale = iso(-13 * H);
  const r = await replayPunch({ clientPunchId: 'op_3', userId: 'u1', jobId: 'j1', assertedInAt: stale, assertedOutAt: iso(-12.5 * H), inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.entry.clock_in_at !== stale, '4: stale asserted in-time NOT used');
  ok(Math.abs(new Date(r.entry.clock_in_at).getTime() - Date.now()) < 5 * MIN, '4: clock_in_at server-stamped ≈ now');
  ok(r.outsideWindow === true, '4: outsideWindow flagged');
  ok(r.entry.edited === true && /outside/i.test(r.entry.note || ''), '4: row flagged (edited + note) for review');
  ok(r.entry.client_asserted_at === stale, '4: asserted time preserved for audit');
}

// 5. Future skew — +2 min accepted (drift), +10 min server-stamped.
{
  reset();
  const soon = iso(2 * MIN);
  const r1 = await replayPunch({ clientPunchId: 'op_4a', userId: 'u1', jobId: 'j1', assertedInAt: soon, inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r1.entry.clock_in_at === soon, '5: +2 min within skew → accepted');
  reset();
  const later = iso(10 * MIN);
  const r2 = await replayPunch({ clientPunchId: 'op_4b', userId: 'u1', jobId: 'j1', assertedInAt: later, inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r2.entry.clock_in_at !== later, '5: +10 min beyond skew → server-stamped');
}

// 6. Identity — a punch whose asserted owner differs from the token user is refused.
{
  reset();
  const r = await replayPunch({ clientPunchId: 'op_5', userId: 'u1', assertedUserId: 'u2', jobId: 'j1', assertedInAt: iso(-1 * H), inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.identityMismatch === true && r.forbidden === true, '6: identity mismatch → forbidden');
  ok(rows.length === 0, '6: no row written under the wrong crew member');
}

// 7. Folded clock-out reconcile — a clock-out folded in after a lost-ACK open row is APPLIED, not dropped.
{
  reset();
  rows.push({ id: 'srv_open', organization_id: CLEANSPACE_ORG_ID, client_punch_id: 'op_6', user_id: 'u1', job_id: 'j1', clock_in_at: iso(-2 * H), clock_out_at: null, status: 'in_progress', edit_history: [] });
  const outAt = iso(-1 * H);
  const r = await replayPunch({ clientPunchId: 'op_6', userId: 'u1', jobId: 'j1', assertedInAt: iso(-2 * H), assertedOutAt: outAt, inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.idempotent === true, '7: matched the prior open row');
  ok(r.entry.clock_out_at === outAt, '7: folded clock-out APPLIED (not discarded)');
  ok(r.entry.status === 'completed', '7: row now completed');
  ok(rows.length === 1, `7: no new row (still ${rows.length})`);
}

// 8. op_* clock-out — a buffered clock-out keyed to a synth op_ id resolves the real row.
{
  reset();
  rows.push({ id: 'srv_synth', organization_id: CLEANSPACE_ORG_ID, client_punch_id: 'op_7in', user_id: 'u1', job_id: 'j1', clock_in_at: iso(-2 * H), clock_out_at: null, status: 'in_progress', edit_history: [] });
  const outAt = iso(-1 * H);
  const r = await replayPunch({ clientPunchId: 'op_7out', userId: 'u1', entryId: 'op_7in', assertedOutAt: outAt, outLat: near.lat, outLng: near.lng, windowHours: 12 });
  ok(r.entry && r.entry.id === 'srv_synth', '8: op_* entryId resolved via client_punch_id');
  ok(r.entry.clock_out_at === outAt, '8: clock-out applied to the real row');
  ok(rows.length === 1, '8: no stray row');
}

// 9. Geofence outside — recorded + flagged, NEVER blocked (the work already happened).
{
  reset();
  const r = await replayPunch({ clientPunchId: 'op_8', userId: 'u1', jobId: 'j1', assertedInAt: iso(-1 * H), inLat: far.lat, inLng: far.lng, windowHours: 12 });
  ok(r.entry && rows.length === 1, '9: outside-geofence punch STILL recorded (not blocked)');
  ok(r.entry.geofence_result === 'outside', '9: server verdict = outside');
  ok(r.entry.approval_status === 'pending', '9: flagged pending for manager review');
}

// 10. Not assigned — a crew member replaying a clock-in for a job they aren't on is forbidden.
{
  reset();
  const r = await replayPunch({ clientPunchId: 'op_9', userId: 'u2', isManager: false, jobId: 'j1', assertedInAt: iso(-1 * H), inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.forbidden === true, '10: not-assigned clock-in → forbidden');
  ok(rows.length === 0, '10: no row written');
}

// 11. Blocking open row with a DIFFERENT punch id (lost-ACK online clock-in that
// minted its own id) — the Sept 2 reconcile: a completed replay must apply its
// clock-out to that row, never double-insert and never evaporate as {duplicate}.
{
  reset();
  rows.push({ id: 'srv_foreign_open', organization_id: CLEANSPACE_ORG_ID, client_punch_id: 'op_online_other', user_id: 'u1', job_id: 'j1', clock_in_at: iso(-3 * H), clock_out_at: null, status: 'in_progress', edit_history: [] });
  const outAt = iso(-1 * H);
  const r = await replayPunch({ clientPunchId: 'op_10', userId: 'u1', jobId: 'j1', assertedInAt: iso(-2 * H), assertedOutAt: outAt, inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.recoveredOpenRow === true, '11: reconcile flagged recoveredOpenRow');
  ok(r.entry && r.entry.id === 'srv_foreign_open', '11: clock-out applied to the BLOCKING open row');
  ok(r.entry && r.entry.clock_out_at === outAt, '11: crew’s real out-time recorded');
  ok(rows.length === 1, `11: no parallel double-labor row (still ${rows.length})`);
  ok(r.duplicate !== true, '11: not reported as a bare duplicate (the old data-loss path)');
}

// 12. In-only replay against a blocking open row — returns that row as the entry
// (it IS this clean's clock-in) instead of the bare {duplicate} the client deletes on.
{
  reset();
  rows.push({ id: 'srv_open2', organization_id: CLEANSPACE_ORG_ID, client_punch_id: 'op_online_other2', user_id: 'u1', job_id: 'j1', clock_in_at: iso(-1 * H), clock_out_at: null, status: 'in_progress', edit_history: [] });
  const r = await replayPunch({ clientPunchId: 'op_11', userId: 'u1', jobId: 'j1', assertedInAt: iso(-2 * H), inLat: near.lat, inLng: near.lng, windowHours: 12 });
  ok(r.entry && r.entry.id === 'srv_open2' && r.idempotent === true, '12: in-only replay resolves to the open row');
  ok(rows.length === 1, '12: no second open/completed row');
}

console.log(`\noffline clock replay (payroll invariants): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
