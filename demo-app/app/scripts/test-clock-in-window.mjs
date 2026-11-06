// CS-052 — a cleaner who arrives after midnight for an 11 PM clean can clock in.
//
// THE BUG (re-verified at 6e61596c). `components/ClockControl` refused a clock-in unless the
// clean was scheduled on TODAY's org calendar day (`dates.sameDay`), and My Day listed only
// today's cleans. A 23:00 clean reached at 00:30 is "yesterday's": the button was disabled
// ("Available on the day of the clean"), the clean had left My Day, and the night's hours were
// never recorded. (The server's clock-in has no day rule; the refusal was the screen's.)
//
// THE FIX. ONE rule, `src/lib/clockInWindow.js`: a clean can be clocked into from
// CLOCK_IN_LEAD_MS (2 h) before it starts until its scheduled end plus the auto-close grace
// (`opsSettings.autoCloseGraceMins`, 120 by default — after that the hourly cron would close the
// punch at once). ClockControl asks it instead of the calendar day, and My Day keeps a clean from
// an earlier day on "Today" while its window is still open.
//
//   node app/scripts/test-clock-in-window.mjs
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const dates = await import('../src/lib/dates.js');
dates.setOrgTimezone('America/New_York');
let W = null;
try { W = await import('../src/lib/clockInWindow.js'); } catch { W = null; }
const { selectTodayCleansForUser } = await import('../src/store/selectors.js');

// 23:00–01:00 New York, the night of Oct 7 → 03:00Z–05:00Z on Oct 8.
const JOB = { id: 'j_late', siteId: 's1', clientId: 'c1', status: 'upcoming', crewIds: ['u_ana'],
  startAt: '2026-10-08T03:00:00.000Z', endAt: '2026-10-08T05:00:00.000Z' };
const at = (isoZ) => Date.parse(isoZ);
const refusal = (job, now, opts) => (W ? W.clockInRefusal(job, now, opts) : 'no-module');

// ── 1. The rule ───────────────────────────────────────────────────────────────────────────
ok('1.1 the rule lives in one module (src/lib/clockInWindow.js)', !!W && typeof W.clockInRefusal === 'function');
ok('1.2 a 23:00 clean, now 00:30 the next day → clock-in ALLOWED', refusal(JOB, at('2026-10-08T04:30:00.000Z')) === null, String(refusal(JOB, at('2026-10-08T04:30:00.000Z'))));
ok('1.3 2 h before the start → allowed (the window opens)', refusal(JOB, at('2026-10-08T01:00:00.000Z')) === null);
ok('1.4 a minute before that → "early"', refusal(JOB, at('2026-10-08T00:59:00.000Z')) === 'early');
ok('1.5 the end + the 120-minute auto-close grace → still allowed', refusal(JOB, at('2026-10-08T07:00:00.000Z')) === null);
ok('1.6 a minute after → "late" (the hourly cron would close the punch at once)', refusal(JOB, at('2026-10-08T07:01:00.000Z')) === 'late');
ok('1.7 the office\'s grace setting moves the late edge', refusal(JOB, at('2026-10-08T05:30:00.000Z'), { graceMins: 15 }) === 'late'
  && refusal(JOB, at('2026-10-08T05:10:00.000Z'), { graceMins: 15 }) === null);
ok('1.8 the lead is a named constant (2 h)', !!W && W.CLOCK_IN_LEAD_MS === 2 * 60 * 60 * 1000);
ok('1.9 a clean with no start time is not gated (as before)', refusal({ ...JOB, startAt: null }, at('2026-10-08T12:00:00.000Z')) === null);
ok('1.10 a clean with no end runs its window to start + grace', refusal({ ...JOB, endAt: null }, at('2026-10-08T04:59:00.000Z')) === null
  && refusal({ ...JOB, endAt: null }, at('2026-10-08T05:01:00.000Z')) === 'late');
ok('1.11 a 9:00 AM clean the same day is still open at 9:30 AM (the ordinary case)',
  refusal({ ...JOB, startAt: '2026-10-08T13:00:00.000Z', endAt: '2026-10-08T15:00:00.000Z' }, at('2026-10-08T13:30:00.000Z')) === null);

// ── 2. My Day keeps the late clean on "Today" after midnight ─────────────────────────────
{
  const state = {
    opsSettings: { autoCloseGraceMins: 120 },
    users: [{ id: 'u_ana', role: 'crew', status: 'active' }],
    jobs: [
      JOB,
      { ...JOB, id: 'j_morning', startAt: '2026-10-07T13:00:00.000Z', endAt: '2026-10-07T15:00:00.000Z' },   // yesterday 9 AM: long over
      { ...JOB, id: 'j_done', status: 'done' },                                                                // the late clean, already done
      { ...JOB, id: 'j_cancel', status: 'cancelled' },
      { ...JOB, id: 'j_today', startAt: '2026-10-08T13:00:00.000Z', endAt: '2026-10-08T15:00:00.000Z' },     // today 9 AM
    ],
    sites: [], clients: [],
  };
  const ids = selectTodayCleansForUser(state, 'u_ana', at('2026-10-08T04:30:00.000Z')).map((j) => j.id);
  ok('2.1 at 00:30, yesterday\'s 23:00 clean is still on Today (its window is open)', ids.includes('j_late'), JSON.stringify(ids));
  ok('2.2 …and today\'s cleans are too', ids.includes('j_today'), JSON.stringify(ids));
  ok('2.3 a clean from yesterday whose window has closed is not', !ids.includes('j_morning'), JSON.stringify(ids));
  ok('2.4 nor a done or cancelled one', !ids.includes('j_done') && !ids.includes('j_cancel'), JSON.stringify(ids));
  ok('2.5 the carried-over clean sorts first (its start is earliest)', ids[0] === 'j_late', JSON.stringify(ids));
}

// ── 3. The screens read the rule, not the calendar day ───────────────────────────────────
{
  // The ONE clock (the Cleaner Hub, brief A): what a punch does lives in hooks/useClockActions; ClockControl draws it.
  const clock = `${read('../src/components/ClockControl.jsx')}\n${read('../src/hooks/useClockActions.js')}`;
  ok('3.1 ClockControl asks clockInRefusal', /clockInRefusal\(/.test(clock));
  ok('3.2 …and no longer gates on the calendar day (sameDay)', !/sameDay\(/.test(clock));
  const en = read('../src/i18n/catalog/en.js');
  ok('3.3 the old "on the day of the clean" lines are gone (replace means delete)', !/'clock\.wrongDay/.test(en) && !/'clock\.error\.wrongDay'/.test(en));
  ok('3.4 the new lines say when it opens and that it has ended', /'clock\.window\.opensAt':/.test(en) && /'clock\.window\.closed':/.test(en));
}

console.log(`\ntest-clock-in-window: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
