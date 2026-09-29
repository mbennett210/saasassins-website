// Clock ↔ schedule status (Sept 3): a job someone clocked into must not read as
// 'Missed' on the Schedule. selectEffectiveJobStatus synthesizes 'missed' for any
// past-start 'upcoming' job, and the clock was DECOUPLED from status — so a clean
// being actively worked (open punch) showed Missed. Fix: clocking in advances the
// job to in_progress; clocking out marks it done. This pins that wiring AND the
// invariant it leans on (crew may write job.status; it is not a protected field).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── the synthesis this fix addresses (documented contract) ───────────────────
const sel = read('src/store/selectors.js');
ok('selectEffectiveJobStatus returns a stored in_progress/done/cancelled/missed as-is',
  /export function selectEffectiveJobStatus[\s\S]{0,300}job\.status === 'in_progress'[\s\S]{0,120}return job\.status/.test(sel));
ok('🔴 an UPCOMING job past its start synthesizes to missed (why an un-transitioned clean showed Missed)',
  /new Date\(job\.startAt\)\.getTime\(\) < now \? 'missed' : 'upcoming'/.test(sel));

// ── the fix: clock-in → in_progress, clock-out → done ────────────────────────
const cc = read('src/components/ClockControl.jsx');
ok('ClockControl can dispatch (imports useDispatch + ACTIONS)',
  /import \{ useDispatch \} from '\.\.\/store'/.test(cc) && /import \{ ACTIONS \} from '\.\.\/store\/reducer'/.test(cc) && /const dispatch = useDispatch\(\)/.test(cc));
ok('🔴 clock-IN advances an upcoming/missed job to in_progress',
  /job\.status === 'upcoming' \|\| job\.status === 'missed'[\s\S]{0,140}SET_JOB_STATUS, id: job\.id, status: 'in_progress'/.test(cc));
ok('🔴 clock-OUT marks the job done (unless already done/cancelled)',
  /job\.status !== 'done' && job\.status !== 'cancelled'[\s\S]{0,140}SET_JOB_STATUS, id: job\.id, status: 'done'/.test(cc));
ok('🔴 the 409 already-clocked-in path also heals status → in_progress (lost-response re-tap)',
  /e\.status === 409[\s\S]{0,600}job\.status === 'upcoming' \|\| job\.status === 'missed'[\s\S]{0,160}SET_JOB_STATUS, id: job\.id, status: 'in_progress'/.test(cc));
ok('both transitions are guarded on `job` being present (carryover card can pass null)',
  /if \(job && \(job\.status === 'upcoming'/.test(cc) && /if \(job && job\.status !== 'done'/.test(cc));

// ── the invariant the fix relies on: crew may write status (not protected) ────
const guard = read('api/_lib/jobsGuard.js');
ok('🔴 job status is NOT a protected field — a crew clock-in status write survives the sanitizer',
  /PROTECTED_JOB_FIELDS = \[[^\]]*\]/.test(guard) && !/PROTECTED_JOB_FIELDS = \[[^\]]*'status'[^\]]*\]/.test(guard));
ok('  jobsGuard documents status as crew-writable by design',
  /status\b[\s\S]{0,120}crew may change it BY DESIGN/.test(guard));

console.log(`\nclock↔status coupling: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
