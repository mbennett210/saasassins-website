// CS-689 — after an off-site clock-in, the cleaner's card said "On site" all shift.
//
// WHAT WAS WRONG. My Day's card showed a green "On site" chip on ANY open punch
// (`MyDay.jsx`, `isOpen ? <On site>`) and never read the punch's `geofence_result`. A cleaner
// 0.55 mi away (or with Location off) got a 3-second toast that a supervisor would review the
// time — and then "On site" for the rest of the shift, so they never learned their pay was
// held. With Location off the toast also said "You're outside the building's area", wrong for
// someone standing in the lobby.
//
// WHAT THIS PINS.
//   §1 the rule (lib/geo punchSiteState): the SERVER's verdict decides — on site only when an
//      open punch was clocked in inside the ring; off site / no location (held for review) when
//      either end was `outside` / `unavailable` (geo.OFF_SITE_RESULTS), and still after the
//      clock-out (the approval is still to come); nothing for a config-off ring, an
//      un-geocoded location or a punch still waiting to sync
//   §2 the card: My Day draws the chip from that rule, from a map of literal catalog keys, with
//      the held state in the warning colours — never an unconditional "On site"
//   §3 the toast: no location is its own sentence, at either end of the punch
//
// REGRESSION (THE LAW II.3): on the pre-fix tree `punchSiteState` / `OFF_SITE_SENTENCE_KEYS`
// do not exist and the card shows "On site" on any open punch.
//
//   node scripts/test-punch-site-chip.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const geo = await import(pathToFileURL(path.join(APP, 'src/lib/geo.js')).href).catch(() => ({}));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── §1 the rule ─────────────────────────────────────────────────────────────────────────
const state = typeof geo.punchSiteState === 'function' ? geo.punchSiteState : () => undefined;
// Sentinels when the rule is missing (the pre-fix tree), so no check can pass on undefined === undefined.
const S = geo.PUNCH_SITE || { ON_SITE: '(no rule: on)', OFF_SITE: '(no rule: off)', NO_LOCATION: '(no rule: none)' };
const [OUTSIDE, UNAVAILABLE] = geo.OFF_SITE_RESULTS || ['outside', 'unavailable'];
const open = (v) => ({ id: 'te', clock_in_at: '2026-10-13T10:00:00Z', clock_out_at: null, geofence_result: v });
const closed = (vin, vout) => ({ ...open(vin), clock_out_at: '2026-10-13T12:00:00Z', geofence_result_out: vout });
ok('§1 the three states are named', S.ON_SITE === 'onSite' && S.OFF_SITE === 'offSite' && S.NO_LOCATION === 'noLocation');
eq('§1 clocked in inside the ring → on site', state(open('inside')), S.ON_SITE);
eq('§1 clocked in measurably away → off site, held for review (was "On site" all shift)', state(open(OUTSIDE)), S.OFF_SITE);
eq('§1 clocked in with no location → no location, held for review (was "On site")', state(open(UNAVAILABLE)), S.NO_LOCATION);
eq('§1 the ring off by the office (config) → nothing to say', state(open('override')), null);
eq('§1 the location has no centre (our data gap) → nothing to say', state(open('no_site_coords')), null);
eq('§1 a punch still on the phone (verdict comes with the replay) → nothing to say', state({ ...open('unknown'), pending_sync: true }), null);
eq('§1 no punch → nothing', state(null), null);
eq('§1 clocked out on site at both ends → nothing (the Done chip says it)', state(closed('inside', 'inside')), null);
eq('§1 held at clock-in stays visible after the clock-out (approval still to come)', state(closed(OUTSIDE, 'inside')), S.OFF_SITE);
eq('§1 on site in, away at clock-out → off site, held', state(closed('inside', OUTSIDE)), S.OFF_SITE);
eq('§1 on site in, no location at clock-out → no location, held', state(closed('inside', UNAVAILABLE)), S.NO_LOCATION);
eq('§1 away beats no location when both ends are held', state(closed(UNAVAILABLE, OUTSIDE)), S.OFF_SITE);
eq('§1 an open punch reads only its clock-in end (a stale out verdict means nothing)', state({ ...open('inside'), geofence_result_out: OUTSIDE }), S.ON_SITE);
ok('§1 the held states are exactly the off-site verdicts (one definition with PAY-17)', typeof geo.isOffSiteVerdict === 'function'
  && [OUTSIDE, UNAVAILABLE].every((v) => geo.isOffSiteVerdict(v) && state(open(v)) !== S.ON_SITE && state(open(v)) !== null));

// ── §2 the card ──────────────────────────────────────────────────────────────────────────
const en = read('src/i18n/catalog/en.js');
// The Cleaner Hub (brief A, 2026-10-13): the card's "where" line is lib/crewHome siteLine — the
// server's verdict once punched (this rule), the phone's live read before — drawn on Home's hero and
// on My Stops Today.
const crewHome = read('src/lib/crewHome.js');
const myDay = `${read('src/pages/MyDay.jsx')}\n${read('src/pages/crew/CrewStops.jsx')}`;
const css = read('src/index.css');
ok('§2 My Day reads the rule for the chip', /punchSiteState\(entry\)/.test(crewHome) && /siteLine\(/.test(myDay));
ok('§2 …no "On site" on just any open punch any more', !/isOpen \? \(\s*<span className="myday-chip myday-chip-onsite">/.test(myDay));
ok('§2 the chip words come from a map of literal catalog keys', /'crewStops\.line\.onSite'/.test(crewHome) && /'myDay\.chip\.offSiteHeld'/.test(crewHome) && /'myDay\.chip\.noLocationHeld'/.test(crewHome));
ok('§2 the catalog has the held lines', /'myDay\.chip\.offSiteHeld':/.test(en) && /'myDay\.chip\.noLocationHeld':/.test(en));
ok('§2 the held chip is drawn in the warning colours, from tokens', /\.crew-stop-line\.is-held \{[^}]*var\(--color-semantic-warning-/.test(css)
  && /\.crew-home-hero-chip\.is-held \{[^}]*var\(--color-semantic-warning-/.test(css));

// ── §3 the toast ─────────────────────────────────────────────────────────────────────────
const K = geo.OFF_SITE_SENTENCE_KEYS || {};
eq('§3 measurably away → "outside the building\'s area"', K[OUTSIDE], 'clock.offSite');
eq('§3 no location → its own sentence', K[UNAVAILABLE], 'clock.noLocation');
ok('§3 the no-location sentence is in the catalog and asks for Location, not "outside"', /'clock\.noLocation':\s*'[^']*Location[^']*'/.test(en) && !/'clock\.noLocation':\s*'[^']*outside/i.test(en));
// The ONE clock (the Cleaner Hub, brief A): what a punch does lives in hooks/useClockActions; ClockControl draws it.
const clock = `${read('src/components/ClockControl.jsx')}\n${read('src/hooks/useClockActions.js')}`;
ok('§3 the clock picks the sentence by the server\'s verdict, at clock-in AND clock-out', /OFF_SITE_SENTENCE_KEYS/.test(clock)
  && /offSiteWarning\(t, entry\.geofence_result, /.test(clock) && /offSiteWarning\(t, closed\.geofence_result_out, /.test(clock));

if (fails.length) {
  console.error(`\ntest-punch-site-chip: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ntest-punch-site-chip: ${pass}/${pass} passed`);
}
