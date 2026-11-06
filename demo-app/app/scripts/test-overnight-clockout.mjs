// Crews clean overnight — clock-out must work past midnight (Sept 3). My Day used
// to fetch only today's entries (sinceIso: todayIso()) and list only today's
// cleans, so a shift that crossed org-midnight lost both its entry and its card
// at 00:00 and could not be clocked out (the cron auto-closed it). Source-shape
// test: the fetch is unbounded and open shifts outside today get a clock-out card.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// The Cleaner Hub (brief A, 2026-10-13): My Day became the cleaner's Home, My Stops Today and the
// Clock screen; the punch read is one hook they share (hooks/useCrewDay), and the rule that puts an
// open punch first is lib/crewHome (test-crew-home.mjs holds its branches).
const crewDay = read('src/hooks/useCrewDay.js');
const crewHome = read('src/lib/crewHome.js');
const home = read('src/pages/MyDay.jsx');
const stops = read('src/pages/crew/CrewStops.jsx');
const clockPage = read('src/pages/crew/CrewClock.jsx');
ok('🔴 the clock fetch is NOT bounded to today (an overnight open row must return)', !/sinceIso: todayIso\(\)/.test(crewDay));
ok('  mine() is called with no day bound', /timeApi\.mine\(\{ userId \}\)/.test(crewDay));
ok('  todayIso is not used by the crew screens', ![crewDay, home, stops, clockPage].some((x) => /\btodayIso\b/.test(x)));
ok('🔴 carryover OPEN shifts (open + not in today) are computed', /const carry = \(entries \|\| \[\]\)[\s\S]{0,120}isOpen\(e\) && e\.job_id && !onList\.has\(e\.job_id\)/.test(crewHome)
  && /const open = openPunch\(entries\);[\s\S]{0,200}kind: HERO\.CLOCK_OUT/.test(crewHome));
ok('  a "Still clocked in" chip names them on My Stops Today', /carryover \? 'myDay\.stillClockedIn'/.test(stops)
  && /'myDay\.stillClockedIn': 'Still clocked in',/.test(read('src/i18n/catalog/en.js')) && /<StateChip state=\{state\} carryover=\{row\.carryover\} \/>/.test(stops));
ok('  the carryover row and the hero open the clean\'s clock by the punch\'s job id', /crewPaths\.clock\(jobId\)/.test(stops) && /crewPaths\.clock\(id\)/.test(home));
ok('  the Clock screen clocks out from the punch alone when the clean is gone', /if \(!job && !entry\) \{/.test(clockPage) && /useClockActions\(\{[\s\S]{0,40}job, ctx, entry/.test(clockPage));

// The clock-out itself must not depend on the clean's card being present.
// listMine must union open rows so an overnight/forgotten shift is always returned,
// even past the 100 most-recent window (Sept 3 review C1).
const store = read('api/_lib/time/store.js');
ok('🔴 listMine fetches still-open rows unconditionally', /export async function listMine[\s\S]{0,900}\.is\('clock_out_at', null\)/.test(store));
ok('  and merges them into the returned rows', /for \(const r of openRows\) if \(!seen\.has\(r\.id\)\) rows\.push\(r\)/.test(store));

// The ONE clock (the Cleaner Hub, brief A): what a punch does lives in hooks/useClockActions; ClockControl draws it.
const cc = `${read('src/components/ClockControl.jsx')}\n${read('src/hooks/useClockActions.js')}`;
// The IDENTITY of the punch being closed comes from the ENTRY, never from the clean's card, so a
// carryover row with no job still clocks out. (Since PAY-12 the call also carries `ctx` for the
// clock-out geofence verdict — `null` on the carryover card, where the server resolves the site
// itself from the entry's job_id — so the window is wide enough for the multi-line call.)
ok('🔴 clock-out uses only the entry (works when the job/card is absent)', /doClockOut[\s\S]{0,900}clockOut\(\{[\s\S]{0,200}entryId: entry\.id/.test(cc));
// The open state's button label is no longer a literal in the component: since the
// clock-out block (R4) it comes from lib/clockOutBlock, which also decides whether the
// button is locked. Assert the WIRING here and the label at its source, so this can't pass
// on a component that renders some other string (THE LAW II.3: never a restated literal).
// CS-193: the label is a catalog message, rendered by the control in the cleaner's language.
ok('  the open state renders the clock-out button from the shared state', /if \(isOpen\)[\s\S]{0,1200}\{t\(outState\.label\)\}/.test(cc));
ok('  and its normal label is still "Clock out"', /const CLOCK_OUT = msg\('clock\.out'\)/.test(read('src/lib/clockOutBlock.js'))
  && /'clock\.out': 'Clock out',/.test(read('src/i18n/catalog/en.js')));
// Never gated for someone else's punch: the office closing a forgotten overnight entry is
// the documented escape hatch (R5), and a carryover card may have no clean resolved at all.
ok('  the block applies only to the entry owner', /const ownEntry = !!entry && \(!entry\.user_id \|\| entry\.user_id === currentUser\?\.id\)/.test(cc));

console.log(`\novernight clock-out: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
