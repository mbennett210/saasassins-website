// Does the marketing send-window resolve in the ORG's timezone, or in whatever
// timezone the process happens to run in?
//
// WHY THIS MATTERS: `marketingSettings.sendTimezone` is null on live prod, and
// marketingScheduler.js treats null as "device timezone". Vercel functions run
// TZ=UTC in every region, and the drip engine is CRON-owned in deployed mode —
// so the operator's "send 9am-5pm" window is evaluated against UTC hours. For a
// Pacific business that maps to roughly 2am-10am local: prospect-facing email in
// the middle of the night.
//
// This test pins the behaviour by running the SAME state through the SAME walker
// at the same instant, under two different process timezones. If the window is
// resolved correctly (org timezone), the outcome is identical in both. If it is
// resolved against the process timezone, they diverge — which is the bug.
//
// Re-executes itself in a child process with TZ set, because TZ must be set
// before the first Intl/Date call to take effect.
//
//   node scripts/test-marketing-send-window-tz.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MODE = process.argv[2];

// 16:00 UTC = 09:00 America/Los_Angeles (PDT).
// Operator's window is the default 9-17. In PACIFIC terms 09:00 is INSIDE it, so
// a correctly-implemented window sends. In UTC terms the hour is 16, also inside
// 9-17 — so this instant alone cannot discriminate. The discriminating instant is
// below.
const INSIDE_PACIFIC_OUTSIDE_UTC = '2026-07-12T01:00:00.000Z'; // 18:00 PDT (outside 9-17) / 01:00 UTC (outside) -> both skip
// 17:00 UTC = 10:00 PDT. UTC hour 17 is OUTSIDE [9,17); Pacific hour 10 is INSIDE.
// A correct implementation SENDS here. A device-tz implementation running under
// TZ=UTC does NOT. This is the discriminator.
const DISCRIMINATOR = '2026-07-12T17:00:00.000Z';

function state() {
  return {
    // No delayMinutes -> an hour-cadence step, so the business-hours window
    // genuinely applies (a sub-hour delay bypasses it as a fast test cadence).
    marketingSequences: [{
      id: 'seq1', status: 'active', nextInboxIndex: 0,
      steps: [{ id: 'st0', order: 0, delayHours: 24, subject: 'Hi', body: 'Body' }],
    }],
    marketingEnrollments: [{
      id: 'enr1', sequenceId: 'seq1', contactId: 'ct1', status: 'active',
      currentStepIndex: 0, lastSentAt: null, repliedAt: null, source: 'manual',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    }],
    marketingSends: [],
    contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@corp.com' }],
    users: [],
    marketingInboxes: [{ id: 'ib1', enabled: true, status: 'active', rotationOrder: 0, dailySendLimit: 10, connectedByUserId: null }],
    // EXACTLY the live prod shape: no explicit sendTimezone, default 9-17 window.
    marketingSettings: { sendTimezone: null, defaultSendWindow: { start: 9, end: 17 } },
    marketingSuppressions: [],
  };
}

if (MODE === '--child') {
  const { getDueSends } = await import('../src/lib/marketingScheduler.js');
  const due = getDueSends(state(), new Date(DISCRIMINATOR));
  process.stdout.write(JSON.stringify({
    tz: process.env.TZ || '(unset)',
    localHour: new Date(DISCRIMINATOR).getHours(),
    sends: due.length,
  }));
  process.exit(0);
}

const run = (tz) => {
  const out = execFileSync(process.execPath, [SELF, '--child'], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  });
  return JSON.parse(out);
};

let pass = 0;
const fails = [];
const ok = (label, cond) => {
  if (cond) pass += 1; else fails.push(label);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

console.log('\nMarketing send-window timezone resolution');
console.log(`instant: ${DISCRIMINATOR}  =  17:00 UTC  =  10:00 America/Los_Angeles`);
console.log('operator window: 9-17  ->  10:00 Pacific is INSIDE, 17:00 UTC is OUTSIDE\n');

const utc = run('UTC');                    // what the Vercel cron actually is
const pacific = run('America/Los_Angeles'); // what the business means

console.log(`  under TZ=UTC                  -> localHour ${utc.localHour}, due sends: ${utc.sends}`);
console.log(`  under TZ=America/Los_Angeles  -> localHour ${pacific.localHour}, due sends: ${pacific.sends}\n`);

// THE INVARIANT: the org's send window must not depend on where the process runs.
ok('send decision is identical regardless of process timezone', utc.sends === pacific.sends);
ok('at 10:00 Pacific (inside the 9-17 window) a send is due', pacific.sends === 1 && utc.sends === 1);

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log('\n  These failures are the BUG, not a broken test:');
  console.log('  the send window resolves against the PROCESS timezone (device), not the org.');
  console.log('  On Vercel every cron runs TZ=UTC, so a Pacific business\'s 9-5 window');
  console.log('  actually fires ~2am-10am local. Fix: fall back to the org timezone, never device.\n');
}
process.exit(fails.length ? 1 : 0);
