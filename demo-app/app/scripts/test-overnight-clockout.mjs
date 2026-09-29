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

const myday = read('src/pages/MyDay.jsx');
ok('🔴 the clock fetch is NOT bounded to today (an overnight open row must return)', !/sinceIso: todayIso\(\)/.test(myday));
ok('  mine() is called with no day bound', /timeApi\.mine\(\{ userId \}\)/.test(myday));
ok('  todayIso is no longer imported (dead after the widen)', !/\btodayIso\b/.test(myday));
ok('🔴 carryover OPEN shifts (open + not in today) are computed', /carryoverOpen[\s\S]{0,160}!e\.clock_out_at[\s\S]{0,80}!todayJobIds\.has\(e\.job_id\)/.test(myday));
ok('  a "Still clocked in" section renders them', /Still clocked in/.test(myday) && /carryoverOpen\.map\(\(e\) =>/.test(myday));
ok('  the carryover card is rendered with the entry', /<CarryoverClockCard key=\{e\.id\} entry=\{e\}/.test(myday));
ok('  the carryover card binds ClockControl to the entry', /function CarryoverClockCard\(\{ entry, onChange \}\)/.test(myday) && /<ClockControl job=\{job\} ctx=\{null\} entry=\{entry\} onChange=\{onChange\}/.test(myday));

// The clock-out itself must not depend on the clean's card being present.
// listMine must union open rows so an overnight/forgotten shift is always returned,
// even past the 100 most-recent window (Sept 3 review C1).
const store = read('api/_lib/time/store.js');
ok('🔴 listMine fetches still-open rows unconditionally', /export async function listMine[\s\S]{0,900}\.is\('clock_out_at', null\)/.test(store));
ok('  and merges them into the returned rows', /for \(const r of openRows\) if \(!seen\.has\(r\.id\)\) rows\.push\(r\)/.test(store));

const cc = read('src/components/ClockControl.jsx');
ok('🔴 clock-out uses only the entry (works when the job/card is absent)', /doClockOut[\s\S]{0,200}clockOut\(\{ entryId: entry\.id/.test(cc));
// The open state's button label is no longer a literal in the component: since the
// clock-out block (R4) it comes from lib/clockOutBlock, which also decides whether the
// button is locked. Assert the WIRING here and the label at its source, so this can't pass
// on a component that renders some other string (THE LAW II.3: never a restated literal).
ok('  the open state renders the clock-out button from the shared state', /if \(isOpen\)[\s\S]{0,1200}\{outState\.label\}/.test(cc));
ok('  and its normal label is still "Clock out"', /CLOCK_OUT_LABEL = 'Clock out'/.test(read('src/lib/clockOutBlock.js')));
// Never gated for someone else's punch: the office closing a forgotten overnight entry is
// the documented escape hatch (R5), and a carryover card may have no clean resolved at all.
ok('  the block applies only to the entry owner', /const ownEntry = !!entry && \(!entry\.user_id \|\| entry\.user_id === currentUser\?\.id\)/.test(cc));

console.log(`\novernight clock-out: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
