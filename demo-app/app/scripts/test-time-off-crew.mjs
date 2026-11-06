// CS-693 — a cleaner who called out sick still saw today's cleans with a live Clock in.
//
// WHAT WAS WRONG. My Day ignored time off: Andre, booked off today (a call-out, sick), saw
// both cleans as normal with a live Clock in, and clocked in — which flips the office's Shift
// check-in from "Called out" to "Done". Only the visit page said anything, in English and in
// the third person ("Scheduling conflict · Andre Baptiste has time off this day but is still
// on this clean"), to Andre himself.
//
// WHAT THIS PINS.
//   §1 the rule both screens read: store/timeOffRules `timeOffEntryFor` — booked off on the
//      org-day the clean STARTS on (an evening clean belongs to the night it started)
//   §2 My Day says so: a notice when the cleaner is booked off today, on the catalog
//   §3 the clock ASKS before a clock-in on a clean of a day they are booked off (a confirm,
//      never a block: a cleaner the manager asked to come in after all can still clock in)
//   §4 the visit's banner reads the catalog: a cleaner reads only their own conflicts, in the
//      second person; the office keeps the third person — and no English literal is left
//
// REGRESSION (THE LAW II.3): on the pre-fix tree My Day and the clock never read time off and
// the banner is English literals, so §2–§4 fail.
//
//   node scripts/test-time-off-crew.mjs
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec)) {
        for (const ext of ['.js', '.jsx', '/index.js']) { try { return next(spec + ext, ctx); } catch { /* next */ } }
      }
      throw e;
    }
  },
});
const rules = await import(pathToFileURL(path.join(APP, 'src/store/timeOffRules.js')).href).catch(() => ({}));
const dates = await import(pathToFileURL(path.join(APP, 'src/lib/dates.js')).href).catch(() => ({}));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// ── §1 the rule ─────────────────────────────────────────────────────────────────────────
{
  const off = typeof rules.timeOffEntryFor === 'function' ? rules.timeOffEntryFor : () => null;
  dates.setOrgTimezone?.('America/New_York');
  const timeOff = [{ id: 'to1', userId: 'u_c1', startDate: '2026-10-13', endDate: '2026-10-13', kind: 'callout', calloutReason: 'sick', reason: '' }];
  ok('§1 a clean on the booked-off day is found', off(timeOff, 'u_c1', '2026-10-13T21:30:00.000Z')?.id === 'to1');
  ok('§1 an evening clean that runs past midnight belongs to the night it started', off(timeOff, 'u_c1', '2026-10-14T01:30:00.000Z')?.id === 'to1');
  ok('§1 the next day is not booked off', off(timeOff, 'u_c1', '2026-10-14T13:00:00.000Z') === null);
  ok('§1 another cleaner is not booked off', off(timeOff, 'u_c2', '2026-10-13T21:30:00.000Z') === null);
}

// ── §2 My Day says so ─────────────────────────────────────────────────────────────────────
const en = read('src/i18n/catalog/en.js');
const myDay = read('src/pages/MyDay.jsx');
{
  ok('§2 My Day reads the cleaner\'s time off for today', /timeOffEntryFor\(/.test(myDay));
  ok('§2 …and says they are booked off, on the catalog', /t\('myDay\.timeOff\.title'\)/.test(myDay) && /'myDay\.timeOff\.title':/.test(en) && /'myDay\.timeOff\.body':/.test(en));
  ok('§2 the notice is a status (read out by a screen reader)', /myday-timeoff[^>]*role="status"|role="status"[^>]*myday-timeoff/.test(myDay));
}

// ── §3 the clock asks first ─────────────────────────────────────────────────────────────
{
  // The ONE clock (the Cleaner Hub, brief A): what a punch does lives in hooks/useClockActions; ClockControl draws it.
  const clock = `${read('src/components/ClockControl.jsx')}\n${read('src/hooks/useClockActions.js')}`;
  ok('§3 the clock knows when the cleaner is booked off on the clean\'s day', /timeOffEntryFor\(s\.timeOff, currentUser\.id, job\.startAt\)/.test(clock));
  ok('§3 the Clock in button asks first when they are', /onClick=\{startClockIn\}/.test(clock) && /function startClockIn\(\) \{\s*if \(bookedOff\) \{ setAskOff\(true\); return; \}\s*doClockIn\(\);\s*\}/.test(clock));
  ok('§3 the question is a confirm whose yes clocks in (never a block)', /<ConfirmDialog[\s\S]{0,400}open=\{askOff\}[\s\S]{0,400}onConfirm=\{\(\) => doClockIn\(\)\}/.test(clock));
  ok('§3 its words are the catalog\'s', /t\('clock\.timeOff\.title'\)/.test(clock) && /t\('clock\.timeOff\.body'\)/.test(clock) && /t\('clock\.timeOff\.confirm'\)/.test(clock)
    && /'clock\.timeOff\.title':/.test(en) && /'clock\.timeOff\.body':/.test(en) && /'clock\.timeOff\.confirm':/.test(en));
}

// ── §4 the visit's banner ─────────────────────────────────────────────────────────────────
{
  const jd = read('src/pages/JobDetail.jsx');
  const start = jd.indexOf('<div className="conflict-warning"');
  const block = start >= 0 ? jd.slice(start, jd.indexOf('<div className="detail-grid">', start)) : '';
  ok('§4 the banner is found', block.length > 0);
  ok('§4 no English literal is left in it', !/Scheduling conflict|has time off this day|but is still on this clean|overlaps with|another job/.test(block), block.slice(0, 300));
  ok('§4 its words are the catalog\'s', /t\('jobPage\.conflict\.title'\)/.test(block) && /'jobPage\.conflict\.title':/.test(en));
  ok('§4 a cleaner reads their own conflicts, in the second person', /t\('jobPage\.conflict\.youOff'\)/.test(block) && /'jobPage\.conflict\.youOff':\s*'You/.test(en)
    && /t\('jobPage\.conflict\.youOverlap'/.test(block) && /'jobPage\.conflict\.youOverlap':\s*'You/.test(en));
  ok('§4 …and only their own', /isCrew \? conflicts\.filter\(\(c\) => c\.userId === currentUser\?\.id\) : conflicts/.test(jd));
  ok('§4 the office keeps the third person, on the catalog', /t\('jobPage\.conflict\.theyOff'/.test(block) && /t\('jobPage\.conflict\.theyOverlap'/.test(block)
    && /'jobPage\.conflict\.theyOff':/.test(en) && /'jobPage\.conflict\.theyOverlap':/.test(en));
}

if (fails.length) {
  console.error(`\ntest-time-off-crew: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ntest-time-off-crew: ${pass}/${pass} passed`);
}
