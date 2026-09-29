// Increment 0.1 (second half) — the PROJECTED-LOAD MODEL.
//
// REMEDIATION_PLAN.md makes this a HARD GATE on the Broadcast cutover: the
// projection must land under quota at the 100+ user target BEFORE any dual-run
// starts. A dual-run temporarily DOUBLES a channel's billed traffic, so running
// one against an unmodelled meter is how you turn a scaling problem into an
// outage.
//
// WHY A MODEL AND NOT "watch the graph": the graph tells you about 43 users on
// today's architecture. It cannot tell you whether the TARGET architecture
// survives 100 users — and the answer is not linear, because the billed unit is
// (changes x SUBSCRIBERS). Doubling users roughly QUADRUPLES an org-wide
// channel: twice the changes, each fanned to twice the clients. That quadratic
// is the whole reason scoped topics exist.
//
//   node scripts/project-realtime-load.mjs                     # defaults
//   node scripts/project-realtime-load.mjs --users 100 --changes-per-user-hour 40
//   node scripts/project-realtime-load.mjs --measured-monthly 9538520 --measured-users 43
//
// `--measured-monthly` calibrates changes-per-user from a REAL meter reading
// (the honest input), instead of the estimate below.

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (n, d) => `${Math.round((n / d) * 1000) / 10}%`;

const QUOTA = arg('quota', 5_000_000);         // Supabase Pro monthly realtime messages
const USERS_NOW = arg('measured-users', 43);
const USERS_TARGET = arg('users', 100);
const HOURS_ACTIVE = arg('active-hours', 10);  // working hours per day per user
const DAYS = arg('days', 30);
const DEVICE_MULT = arg('device-multiplier', 1.4); // phone + desktop overlap

// Changes originated per ACTIVE user per hour (job edits, status flips, messages,
// notifications, invoice touches). Default is an estimate; --measured-monthly
// overrides it with the real thing.
let CHANGES_PER_USER_HOUR = arg('changes-per-user-hour', 12);

const measuredMonthly = arg('measured-monthly', 0);
if (measuredMonthly > 0) {
  // Reverse the org-wide fan-out to recover the underlying change rate:
  //   messages = changes x subscribers  ->  changes = messages / subscribers
  const subscribers = USERS_NOW * DEVICE_MULT;
  const changes = measuredMonthly / subscribers;
  CHANGES_PER_USER_HOUR = changes / (USERS_NOW * HOURS_ACTIVE * DAYS);
}

const changesPerMonth = (users) => users * CHANGES_PER_USER_HOUR * HOURS_ACTIVE * DAYS;

// ── the three architectures ────────────────────────────────────────────────
// 1. ORG-WIDE (today, and the naive Broadcast port): every change is delivered
//    to every connected client. Quadratic in users.
const orgWide = (users) => changesPerMonth(users) * users * DEVICE_MULT;

// 2. ORG-WIDE + BROADCAST: Broadcast adds its own +1 publish per event on top of
//    the same fan-out. This is why "just switch to Broadcast" is meter-NEGATIVE
//    and must never be shipped for a high-churn table.
const orgWideBroadcast = (users) => orgWide(users) + changesPerMonth(users);

// 3. AUDIENCE-SCOPED (the target): a change is delivered only to the clients
//    that care. `interested` is the average subscriber count per topic — a job
//    reaches its assignees plus dispatch, a notification reaches one user, a
//    message reaches the thread's participants. Linear in users, not quadratic,
//    because the audience per change does NOT grow with headcount.
const AVG_INTERESTED = arg('avg-interested', 3.5);
const scoped = (users) => changesPerMonth(users) * AVG_INTERESTED * DEVICE_MULT + changesPerMonth(users);

const row = (label, value) => {
  const over = value > QUOTA;
  console.log(
    `  ${label.padEnd(38)} ${fmt(value).padStart(13)}  ${pct(value, QUOTA).padStart(7)}  ${over ? 'OVER QUOTA' : 'ok'}`,
  );
  return !over;
};

console.log(`\nRealtime load projection — quota ${fmt(QUOTA)} msg/month`);
console.log(`inputs: ${CHANGES_PER_USER_HOUR.toFixed(2)} changes/user/hour · ${HOURS_ACTIVE}h/day · ${DAYS}d`
  + ` · device multiplier ${DEVICE_MULT} · avg interested/change ${AVG_INTERESTED}`
  + `${measuredMonthly > 0 ? `\n        (calibrated from a measured ${fmt(measuredMonthly)} msg/month at ${USERS_NOW} users)` : '  (ESTIMATED — pass --measured-monthly to calibrate)'}`);

console.log(`\nAt TODAY's ${USERS_NOW} users:`);
row('org-wide (current architecture)', orgWide(USERS_NOW));
row('org-wide + Broadcast (naive port)', orgWideBroadcast(USERS_NOW));
row('audience-scoped (target)', scoped(USERS_NOW));

console.log(`\nAt the ${USERS_TARGET}-user TARGET:`);
const okOrg = row('org-wide (current architecture)', orgWide(USERS_TARGET));
const okNaive = row('org-wide + Broadcast (naive port)', orgWideBroadcast(USERS_TARGET));
const okScoped = row('audience-scoped (target)', scoped(USERS_TARGET));

// The dual-run is the risky window: both transports live at once.
const dualRun = orgWide(USERS_NOW) + scoped(USERS_NOW);
console.log('\nDUAL-RUN window (both transports live, at today\'s user count):');
const okDual = row('org-wide + scoped, concurrently', dualRun);

console.log('\n── GATE ──');
console.log(`  Broadcast cutover allowed:      ${okScoped ? 'YES — scoped projection is under quota at target' : 'NO — scoped projection EXCEEDS quota at target'}`);
console.log(`  Dual-run affordable right now:  ${okDual ? 'YES' : 'NO — run off-peak and/or lift the spend cap first'}`);
if (!okOrg) console.log('  NOTE: the CURRENT architecture is already over quota at the target — decomposition is not optional.');
if (okNaive === false) console.log('  NOTE: a naive org-wide Broadcast port is meter-NEGATIVE. Scoped topics are the cut, not Broadcast itself.');
console.log('\n  Re-run with --measured-monthly <n> --measured-users <n> once the meter');
console.log('  has a full day of post-fix data. An UNCALIBRATED pass does NOT satisfy');
console.log('  the gate — the estimate below is a shape, not a measurement.\n');

process.exit(okScoped ? 0 : 1);
