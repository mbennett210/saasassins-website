// Unit test for app/src/lib/retention.js (capTail + pruneByAge) and the C22
// notification cap+TTL folded into capInsert (app/src/lib/notifications.js).
// Run: node app/scripts/test-retention.mjs

import { capTail, capTailProtected, pruneByAge, DAY_MS } from '../src/lib/retention.js';
import { capInsert, NOTIFICATION_LIMIT_PER_USER, NOTIFICATION_READ_TTL_DAYS } from '../src/lib/notifications.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.error('  FAIL', name); } };

const NOW = Date.parse('2026-07-18T00:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * DAY_MS).toISOString();
// capInsert reads real `Date.now()` internally (it can't be injected), so its rows
// MUST be dated relative to real now — not the fixed NOW above. Anchoring capInsert
// fixtures to NOW made the suite time-fragile: once real time drifted >60d past a
// `daysAgo(N)` date it crossed NOTIFICATION_MAX_AGE_DAYS and the absolute ceiling
// legitimately swept a row the test expected kept (it started failing 2026-08-08).
const realDaysAgo = (d) => new Date(Date.now() - d * DAY_MS).toISOString();

// ── capTail (append-newest-last: keep the newest N = the tail) ──
{
  const a = [1, 2, 3, 4, 5]; // newest-last
  ok('capTail keeps newest N (tail)', JSON.stringify(capTail(a, 3)) === JSON.stringify([3, 4, 5]));
  ok('capTail same-ref when within bound', capTail(a, 5) === a && capTail(a, 9) === a);
  ok('capTail drops the oldest', !capTail(a, 2).includes(1));
}

// ── pruneByAge ──
{
  const rows = [
    { id: 'old-dated', at: daysAgo(100) },
    { id: 'fresh', at: daysAgo(1) },
    { id: 'undated' },                     // no ts → keep
    { id: 'malformed', at: 'not-a-date' }, // NaN → keep
  ];
  const out = pruneByAge(rows, 30 * DAY_MS, NOW, ['at']);
  const ids = out.map((r) => r.id);
  ok('pruneByAge drops dated+expired', !ids.includes('old-dated'));
  ok('pruneByAge keeps fresh', ids.includes('fresh'));
  ok('pruneByAge keeps undated (no ts)', ids.includes('undated'));
  ok('pruneByAge keeps malformed ts (NaN → keep, never drop on a guess)', ids.includes('malformed'));
  ok('pruneByAge same-ref when nothing dropped', pruneByAge([{ id: 'x', at: daysAgo(1) }], 30 * DAY_MS, NOW, ['at']).length === 1);
  const nothingDropped = [{ id: 'y', at: daysAgo(1) }];
  ok('pruneByAge preserves reference when no drop', pruneByAge(nothingDropped, 30 * DAY_MS, NOW, ['at']) === nothingDropped);
  // keepIf force-keeps regardless of age
  const withUnread = [{ id: 'read-old', at: daysAgo(100), readAt: daysAgo(90) }, { id: 'unread-old', at: daysAgo(100), readAt: null }];
  const kept = pruneByAge(withUnread, 30 * DAY_MS, NOW, ['at'], (r) => !r.readAt).map((r) => r.id);
  ok('pruneByAge keepIf force-keeps (unread never ages out)', kept.includes('unread-old') && !kept.includes('read-old'));
}

// ── C22: capInsert now does absolute-age + read-age TTL then per-user cap ──
{
  // 100→40 (2026-07-21): live data showed 92% of rows unread, so the
  // unread-keeps-forever TTL never fired and every user pinned at the cap —
  // the count limit is the only bound that bites, so it has to be small.
  ok('cap lowered to 40', NOTIFICATION_LIMIT_PER_USER === 40);
  ok('read TTL = 30 days', NOTIFICATION_READ_TTL_DAYS === 30);

  // Build 120 fresh unread rows for user u1 (newest-first prepend order like the app).
  // realDaysAgo(0) = now, so none of these trip the age bounds — the count cap is the
  // only thing that bites, which is what this asserts.
  let list = [];
  for (let i = 0; i < 120; i++) list = capInsert(list, 'u1', { id: `n${i}`, userId: 'u1', createdAt: realDaysAgo(0), readAt: null });
  const u1 = list.filter((n) => n.userId === 'u1');
  ok('capInsert enforces the per-user cap', u1.length === NOTIFICATION_LIMIT_PER_USER);
  ok('capInsert keeps the newest (last inserted at head)', u1[0].id === 'n119');

  // Other users' rows are untouched by a u1 insert.
  let mixed = [{ id: 'u2a', userId: 'u2', createdAt: realDaysAgo(0), readAt: null }];
  mixed = capInsert(mixed, 'u1', { id: 'u1new', userId: 'u1', createdAt: realDaysAgo(0), readAt: null });
  ok('capInsert leaves other users rows untouched', mixed.some((n) => n.id === 'u2a') && mixed.some((n) => n.id === 'u1new'));

  // Three bounds, exercised with real-now-relative ages (capInsert reads Date.now()):
  //   read-40d   — 40d < 60d ceiling (survives it), but read + >30d read-TTL → SWEPT
  //   unread-40d — 40d < 60d ceiling AND unread → force-kept by the read-TTL → KEPT
  //   unread-70d — unread, but 70d > 60d absolute ceiling → SWEPT (the ceiling outranks
  //                unread; this is the exact semantic the old fixed-NOW fixtures missed)
  //   read-5d    — young → kept
  let ttl = [
    { id: 'read-40d', userId: 'u1', createdAt: realDaysAgo(40), readAt: realDaysAgo(35) },
    { id: 'unread-40d', userId: 'u1', createdAt: realDaysAgo(40), readAt: null },
    { id: 'unread-70d', userId: 'u1', createdAt: realDaysAgo(70), readAt: null },
    { id: 'read-5d', userId: 'u1', createdAt: realDaysAgo(5), readAt: realDaysAgo(4) },
  ];
  ttl = capInsert(ttl, 'u1', { id: 'newrow', userId: 'u1', createdAt: realDaysAgo(0), readAt: null });
  const ids = ttl.map((n) => n.id);
  ok('capInsert sweeps a READ expired row', !ids.includes('read-40d'));
  ok('capInsert keeps an UNREAD old row (under the absolute ceiling)', ids.includes('unread-40d'));
  ok('capInsert sweeps an UNREAD row past the absolute age ceiling', !ids.includes('unread-70d'));
  ok('capInsert keeps the new row', ids.includes('newrow'));
}

// ── C21: capTailProtected (marketingSends enrollment-aware ceiling) ──
{
  const live = new Set(['E-live']);
  const row = (id, enr) => ({ id, enrollmentId: enr });
  // under limit → same ref
  const small = [row('a', 'E-done'), row('b', 'E-live')];
  ok('capTailProtected same-ref under limit', capTailProtected(small, 5, live, 'enrollmentId') === small);
  // over limit, mixed: drop OLDEST dead to fit, keep ALL live
  const mixed = [row('d1', 'E-done'), row('d2', 'E-done'), row('d3', 'E-done'), row('d4', 'E-done'), row('l1', 'E-live'), row('l2', 'E-live'), row('l3', 'E-live')];
  const capped = capTailProtected(mixed, 5, live, 'enrollmentId');
  const ids = capped.map((r) => r.id);
  ok('capTailProtected fits the ceiling', capped.length === 5);
  ok('capTailProtected NEVER drops a live-enrollment send (CAN-SPAM safety)', ['l1', 'l2', 'l3'].every((x) => ids.includes(x)));
  ok('capTailProtected drops the OLDEST dead first', !ids.includes('d1') && !ids.includes('d2') && ids.includes('d3') && ids.includes('d4'));
  // all protected + over limit → soft ceiling, keep everything (a live send is never dropped)
  const allLive = Array.from({ length: 7 }, (_, i) => row('L' + i, 'E-live'));
  ok('capTailProtected soft ceiling when all protected (keeps all, over limit)', capTailProtected(allLive, 5, live, 'enrollmentId').length === 7);
  // no protected → behaves like a plain oldest-drop ceiling
  const allDead = Array.from({ length: 7 }, (_, i) => row('D' + i, 'E-done'));
  const dcap = capTailProtected(allDead, 5, live, 'enrollmentId');
  ok('capTailProtected with no protected → keeps newest 5', dcap.length === 5 && dcap.map((r) => r.id).join() === 'D2,D3,D4,D5,D6');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
