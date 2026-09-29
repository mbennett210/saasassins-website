// Site access by being ON a clean — src/lib/siteAccess.js, the ONE rule the server's
// door-code reveal and the app's Reveal button share (2026-09-23: the app offered cleaners
// a Reveal the server always refused). Pins the window's edges, the 36 h span cap,
// unreadable times, cancellation and crew membership; the status changes the jobs guard
// keeps (statusChangeKept, the rule that keeps the grant's inputs honest); and that the
// server, the jobs guard and the app import these rules with the same bounds.
//
//   node scripts/test-site-access.mjs
import { readFileSync } from 'node:fs';
import { jobGrantsSiteAccess, statusChangeKept, CODE_REVEAL_WINDOW } from '../src/lib/siteAccess.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const H = 3600e3;
const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const at = (ms) => new Date(NOW + ms).toISOString();
const job = (startMs, endMs, extra = {}) => ({ id: 'j', crewIds: ['u_me'], startAt: at(startMs), endAt: endMs == null ? null : at(endMs), status: 'upcoming', ...extra });
const reveal = (j, user = 'u_me') => jobGrantsSiteAccess(j, user, { ...CODE_REVEAL_WINDOW, now: NOW });

// ── the window (a day before the start → a day after the end) ───────────────
ok('the window is a day before a clean starts and a day after it ends, one clean counting 36 h at most',
  CODE_REVEAL_WINDOW.leadMs === 24 * H && CODE_REVEAL_WINDOW.afterMs === 24 * H && CODE_REVEAL_WINDOW.maxSpanMs === 36 * H
  && Object.isFrozen(CODE_REVEAL_WINDOW));
ok('a clean in progress opens', reveal(job(-1 * H, 1 * H)));
ok('a clean later today opens', reveal(job(5 * H, 7 * H)));
ok('a clean starting in exactly 24h opens (the edge is inclusive)', reveal(job(24 * H, 26 * H)));
ok('🔴 a clean starting in 24h + 1ms does NOT open', !reveal(job(24 * H + 1, 26 * H)));
ok('🔴 a clean in 3 days does NOT open (no codes for a clean weeks away)', !reveal(job(72 * H, 74 * H)));
ok('a clean that ended 23h ago still opens (late notes, overnight cleans)', reveal(job(-25 * H, -23 * H)));
ok('a clean that ended exactly 24h ago still opens (inclusive)', reveal(job(-26 * H, -24 * H)));
ok('🔴 a clean that ended 24h + 1ms ago does NOT open', !reveal(job(-26 * H, -24 * H - 1)));
ok('🔴 a clean that ended 3 days ago does NOT open', !reveal(job(-74 * H, -72 * H)));
ok('a clean with no end is bounded by its start (started 23h ago: open)', reveal(job(-23 * H, null)));
ok('🔴 a clean with no end that started 3 days ago does NOT open', !reveal(job(-72 * H, null)));
ok('🔴 a clean with no start does NOT open when the window has a lead bound', !reveal({ id: 'j', crewIds: ['u_me'], status: 'upcoming' }));
ok('🔴 an unparsable start does NOT open', !reveal(job(0, 1 * H, { startAt: 'soon' })));
ok('🔴 an unparsable END does NOT open (it used to skip the end check: open forever)', !reveal(job(-1 * H, 1 * H, { endAt: 'later' })));
ok('🔴 ...not even for a clean that started 3 days ago', !reveal(job(-72 * H, 1 * H, { endAt: 'later' })));
ok('an empty end reads as no end (bounded by the start)', reveal(job(-1 * H, null, { endAt: '' })) && !reveal(job(-72 * H, null, { endAt: '' })));
ok('an end before the start reads as the start', reveal(job(-23 * H, null, { endAt: at(-50 * H) })) && !reveal(job(-25 * H, null, { endAt: at(-50 * H) })));

// ── the span cap: one clean holds the window at most 36 h past its start ──────
ok('🔴 a clean that started 3 days ago and runs for a week does NOT open (it counts 36 h)', !reveal(job(-72 * H, 96 * H)));
ok('🔴 a clean that started 61 h ago, however long, does NOT open (36 h + a day have passed)', !reveal(job(-61 * H, 900 * H)));
ok('a clean that started 59 h ago and runs 40 h still opens (36 h + a day not yet passed)', reveal(job(-59 * H, -19 * H)));
ok('a clean that started exactly 60 h ago and runs 36 h+ still opens (inclusive)', reveal(job(-60 * H, 0)));
ok('🔴 ...and 60 h + 1 ms ago does NOT', !reveal(job(-60 * H - 1, 0)));
ok('a clean running exactly 36 h is not capped', reveal(job(-59 * H, -23 * H)) && !reveal(job(-61 * H, -25 * H)));
ok('the cap only applies when asked (no maxSpanMs: the real end counts)',
  jobGrantsSiteAccess(job(-72 * H, 96 * H), 'u_me', { leadMs: 24 * H, afterMs: 24 * H, now: NOW }));

// ── who ────────────────────────────────────────────────────────────────────
ok('🔴 someone not on the clean does NOT open', !reveal(job(0, 1 * H), 'u_other'));
ok('🔴 an empty crew does NOT open', !reveal(job(0, 1 * H, { crewIds: [] })));
ok('🔴 a crew that is not a list does NOT open', !reveal(job(0, 1 * H, { crewIds: 'u_me' })));
ok('🔴 no user does NOT open', !reveal(job(0, 1 * H), null));
ok('🔴 a cancelled clean does NOT open', !reveal(job(0, 1 * H, { status: 'cancelled' })));
ok('🔴 a "canceled" clean does NOT open either', !reveal(job(0, 1 * H, { status: 'canceled' })));
ok('a done clean inside the window opens (documenting after it)', reveal(job(-3 * H, -1 * H, { status: 'done' })));
ok('no job does NOT open', !jobGrantsSiteAccess(null, 'u_me', { ...CODE_REVEAL_WINDOW, now: NOW }));

// ── unbounded (account-media's job path: any clean you are on, any time) ──────
const media = (j) => jobGrantsSiteAccess(j, 'u_me', { leadMs: null, afterMs: null, now: NOW });
ok('with no bounds, a clean in 3 days opens (media)', media(job(72 * H, 74 * H)));
ok('with no bounds, a clean 30 days ago opens (media)', media(job(-720 * H, -718 * H)));
ok('with no bounds, someone not on the clean still does NOT open', !jobGrantsSiteAccess(job(0, H), 'u_other', { now: NOW }));
ok('with no bounds, a cancelled clean still does NOT open', !media(job(0, H, { status: 'cancelled' })));

// ── the status changes the jobs guard keeps from a caller it sanitizes ─────────
const st = (startMs, status = 'upcoming') => ({ id: 'j', crewIds: ['u_me'], startAt: at(startMs), endAt: at(startMs + 2 * H), status });
const kept = (j, to) => statusChangeKept(j, to, NOW);
ok('clock-in on the day (upcoming → in_progress, starting in 2 h) is kept', kept(st(2 * H), 'in_progress'));
ok('clock-in on a missed clean (missed → in_progress) is kept', kept(st(-3 * H, 'missed'), 'in_progress'));
ok('clock-out (in_progress → done) is kept', kept(st(-1 * H, 'in_progress'), 'done'));
ok('a status change on a past clean is kept (closing out yesterday)', kept(st(-30 * H, 'in_progress'), 'done'));
ok('a status change a day out (exactly 24 h, inclusive) is kept', kept(st(24 * H), 'in_progress'));
ok('🔴 a status change 24 h + 1 ms out is put back (flipped early, it would dodge a series edit)', !kept(st(24 * H + 1), 'in_progress'));
ok("🔴 marking next week's visit done is put back", !kept(st(7 * 24 * H), 'done'));
ok("🔴 cancelling next week's visit is put back too", !kept(st(7 * 24 * H), 'cancelled'));
ok("cancelling today's clean is kept", kept(st(2 * H), 'cancelled'));
ok('🔴 un-cancelling (cancelled → upcoming) is put back, however near', !kept(st(2 * H, 'cancelled'), 'upcoming'));
ok('🔴 cancelled → in_progress is put back', !kept(st(-1 * H, 'cancelled'), 'in_progress'));
ok('🔴 cancelled → done is put back', !kept(st(-5 * H, 'cancelled'), 'done'));
ok('🔴 "canceled" → upcoming is put back too', !kept(st(2 * H, 'canceled'), 'upcoming'));
ok('an unchanged status is always kept (an echo), a cancelled one included', kept(st(7 * 24 * H), 'upcoming') && kept(st(2 * H, 'cancelled'), 'cancelled'));
ok('a job with no readable start: only the un-cancel limit applies (it opens nothing)',
  kept({ id: 'j', status: 'a' }, 'b') && kept({ id: 'j', status: 'upcoming', startAt: 'soon' }, 'done')
  && !kept({ id: 'j', status: 'cancelled' }, 'upcoming'));
ok('🔴 no stored job keeps nothing', !statusChangeKept(null, 'done', NOW));

// ── one rule on both sides ─────────────────────────────────────────────────
const route = read('api/site-security/[...path].js');
const authz = read('api/_lib/authz.js');
const guard = read('api/_lib/jobsGuard.js');
const detail = read('src/pages/JobDetail.jsx').replace(/\r\n/g, '\n');
ok('🔴 the reveal route takes the job path for CREW, with the shared window',
  /import \{ CODE_REVEAL_WINDOW \} from '..\/..\/src\/lib\/siteAccess\.js'/.test(route)
  && /allowJobBased: true,\s*jobRoles: \['crew'\],\s*jobWindow: CODE_REVEAL_WINDOW,/.test(route));
ok("🔴 the server decides a job by the shared rule, on the job's own site, for the roles the caller names",
  /import \{ jobGrantsSiteAccess \} from '..\/..\/src\/lib\/siteAccess\.js'/.test(authz)
  && /if \(allowJobBased && \(!jobRoles \|\| \(a\.role && jobRoles\.includes\(a\.role\)\)\)\)/.test(authz)
  && /j\?\.siteId === siteId && jobGrantsSiteAccess\(j, meId, \{ \.\.\.jobWindow, now \}\)/.test(authz));
ok('🔴 the jobs guard puts status back by the shared rule',
  /import \{ statusChangeKept \} from '..\/..\/src\/lib\/siteAccess\.js'/.test(guard)
  && /fieldChanged\(before, next, 'status'\) && !statusChangeKept\(before, next\.status, now\)/.test(guard));
ok('🔴 the app shows the Reveal row by the same rule and window, for crew',
  /import \{ jobGrantsSiteAccess, statusChangeKept, CODE_REVEAL_WINDOW \} from '..\/lib\/siteAccess'/.test(detail)
  && /currentUser\.role !== 'crew'\) return false;/.test(detail)
  && /jobGrantsSiteAccess\(j, currentUser\.id, \{ \.\.\.CODE_REVEAL_WINDOW, now \}\)/.test(detail));
// Every status button offers only a change the server keeps: each is gated on mayMoveTo of
// the very status it sets, and mayMoveTo is "writes whole, or statusChangeKept".
ok("🔴 the app's status buttons follow the same status rule",
  /const mayMoveTo = \(to\) => statusWhole \|\| statusChangeKept\(job, to\);/.test(detail)
  && /const statusWhole = currentUser\?\.role === 'owner' \|\| currentUser\?\.role === 'admin' \|\| canEditJob;/.test(detail));
{
  const controls = (detail.match(/onClick=\{\(\) => transition\('\w+'\)\}|onClick=\{handleCancelClick\}/g) || []).length;
  const gates = [
    [/mayMoveTo\('in_progress'\)[^\n]*\n\s*<button[^\n]*transition\('in_progress'\)/, 'Start'],
    [/mayMoveTo\('done'\)[^\n]*\n\s*<button[^\n]*transition\('done'\)/, 'Mark Done'],
    [/mayMoveTo\('cancelled'\)[^\n]*\n\s*<button[^\n]*handleCancelClick/, 'Cancel Job'],
    [/mayMoveTo\('upcoming'\)[^\n]*\n[^\n]*\n\s*<button[^\n]*transition\('upcoming'\)/, 'Reset to Upcoming'],
  ];
  for (const [re, name] of gates) ok(`  ${name} is gated on mayMoveTo of the status it sets`, re.test(detail));
  ok('  ...and there are exactly those four status controls', controls === 4, `found ${controls}`);
}

console.log(`\nsite access: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
