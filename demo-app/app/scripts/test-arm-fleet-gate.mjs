// The fleet-reload gate script — `app/scripts/arm-fleet-gate.mjs`. `min_client_build` is
// the floor below which a tab must reload before it may write, and setting it above the
// newest deployed build is a fleet-wide write outage with no client-side recovery. So the
// script's refusals are the product, and this suite pins every one of them.
//
// It also pins the Postgres transport the script grew for machines whose only production
// credential is `SUPABASE_DB_URL` (a Postgres connection string — `apply-migration.mjs`
// already runs on it) rather than the service-role pair.
//
// This suite is OFFLINE. The script's live section is behind an
// `import.meta.url === argv[1]` main guard, so importing it here opens nothing, and every
// assertion drives a FAKE transport or a fake `client.query(text, params)`.
//
// Failing-first by construction: pre-fix the script has no main guard and no exports, so
// the import runs the live section and throws.
//
// Run: node app/scripts/test-arm-fleet-gate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OBSERVED_LIMIT, pgTransport, runFleetGate } from './arm-fleet-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'arm-fleet-gate.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

const ORG = '00000000-0000-0000-0000-0000000000ab';
// Build ids are `String(Date.now())` baked in at build time (vite.config.js), so they are
// millisecond timestamps. 4177 as a version for the same reason the data-op suite uses it:
// it cannot be mistaken for a `$1` placeholder when the SQL text is scanned for values.
const B_OLD = 1757000000000;
const B_NEW = 1758000000000;
const orgRow = (over = {}) => ({
  organization_id: ORG, version: 4177, min_client_build: null, freeze_strip: null,
  updated_by_build: B_NEW, updated_via: 'browser', updated_at: '2026-09-27T12:00:00.000Z', ...over,
});

function recorder() {
  const lines = [];
  const write = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, write, text: () => lines.join('\n') };
}

// A fake transport: the same four reads and two writes the pg and service-role
// transports expose, recording every call so a refusal can be proven to write nothing.
function fakeGate({ org = orgRow(), sink = [], jobs = [], armRows, gateAfter = null } = {}) {
  const calls = [];
  return {
    calls,
    readOrg: async () => { calls.push({ op: 'readOrg' }); return org; },
    observedSink: async (limit) => { calls.push({ op: 'observedSink', limit }); return sink; },
    observedJobs: async (limit) => { calls.push({ op: 'observedJobs', limit }); return jobs; },
    arm: async (a) => { calls.push({ op: 'arm', ...a }); return armRows ?? [{ min_client_build: a.value }]; },
    disarm: async (o) => { calls.push({ op: 'disarm', org: o }); },
    readGate: async (o) => { calls.push({ op: 'readGate', org: o }); return gateAfter; },
  };
}
const run = async (argv, over) => {
  const t = fakeGate(over);
  const r = recorder();
  const code = await runFleetGate({ t, argv, log: r.write, err: r.write });
  return { code, out: r.text(), calls: t.calls };
};
const wrote = (calls) => calls.filter((c) => c.op === 'arm' || c.op === 'disarm');

// ── inspection is the default ────────────────────────────────────────────────
{
  const { code, out, calls } = await run([], { jobs: [{ updated_by_build: B_OLD, updated_at: '2026-09-20T00:00:00.000Z' }] });
  eq('no --build is inspection only, and it succeeds', code, 0);
  eq('inspection writes nothing', wrote(calls), []);
  ok(/inspection only/i.test(out), 'it says it inspected only');
  ok(out.includes(String(B_NEW)), 'it names the highest observed build');
  ok(/NULL/.test(out) && /INERT/i.test(out), 'it says the gate is inert while min_client_build is NULL');
  eq('the observed reads are bounded', calls.filter((c) => c.limit === OBSERVED_LIMIT).length, 2);
}

// the append-only sink is the good source; its absence is survivable, not fatal
{
  const { code, out, calls } = await run([], { sink: null, jobs: [{ updated_by_build: B_OLD, updated_at: '2026-09-20T00:00:00.000Z' }] });
  eq('a missing sink still inspects', code, 0);
  ok(/sink absent/.test(out), 'it says the evidence came from org_state + jobs only');
  eq('…and still writes nothing', wrote(calls), []);
}

// ── the refusals ─────────────────────────────────────────────────────────────
{
  const { code, out, calls } = await run(['--build', String(B_NEW + 1), '--apply']);
  eq('a floor above the highest observed build exits 1', code, 1);
  eq('…and writes nothing', wrote(calls), []);
  ok(/REFUSING/.test(out), '…and says it is refusing');
  ok(out.includes(String(B_NEW)), '…naming the highest build it can actually see');
}
{
  const { code, out, calls } = await run(['--build', String(B_NEW), '--apply'], { org: orgRow({ updated_by_build: null }) });
  eq('no observed build at all exits 1', code, 1);
  eq('…and writes nothing', wrote(calls), []);
  ok(/never been observed|cannot verify/i.test(out), '…because nothing proves the target build exists');
}
{
  // A pre-1d sink row carries no build. Counting it as build 0 would make "no build has
  // ever been observed" unreachable and print a 1970 line in the evidence table.
  const { code, out, calls } = await run(['--build', String(B_NEW), '--apply'], {
    org: orgRow({ updated_by_build: null }),
    sink: [{ updated_by_build: null, observed_at: '2026-09-01T00:00:00.000Z' }],
  });
  eq('a sink row with no build is not build 0', code, 1);
  eq('…and writes nothing', wrote(calls), []);
  ok(/OBSERVED BUILD IDS \(0\)/.test(out), '…it is simply not evidence');
  ok(!/1970/.test(out), '…and no epoch row is printed');
}
{
  const bad = await run(['--build', 'tomorrow', '--apply']);
  eq('a non-numeric build exits 1', bad.code, 1);
  eq('…and writes nothing', wrote(bad.calls), []);
  const zero = await run(['--build', '0', '--apply']);
  eq('a zero build exits 1', zero.code, 1);
  eq('…and writes nothing', wrote(zero.calls), []);
  const negative = await run(['--build', '-1', '--apply']);
  eq('a negative build exits 1', negative.code, 1);
  eq('…and writes nothing', wrote(negative.calls), []);
}
{
  const { code, out, calls } = await run(['--build', String(B_OLD)]);
  eq('a valid floor without --apply exits 0', code, 0);
  eq('…and still writes nothing', wrote(calls), []);
  ok(/Dry run/.test(out), '…and says it is a dry run');
  ok(out.includes(String(B_OLD)), '…naming the floor it would set');
}

// ── arming ───────────────────────────────────────────────────────────────────
{
  const { code, out, calls } = await run(['--build', String(B_NEW), '--apply'], { gateAfter: B_NEW });
  eq('arming at the highest observed build succeeds', code, 0);
  eq('CAS: the predicate is the value it just read — NULL here',
    calls.filter((c) => c.op === 'arm').map((c) => [c.org, c.value, c.current]), [[ORG, B_NEW, null]]);
  ok(/✓ armed/.test(out), 'it confirms the arm');
  ok(out.includes(String(B_NEW)), '…with the value read back from the row');
  ok(/--disarm/.test(out), '…and names the rollback');
}
{
  const { code, out, calls } = await run(['--build', String(B_OLD), '--apply'], { org: orgRow({ min_client_build: B_NEW }), gateAfter: B_OLD });
  eq('lowering the floor is allowed', code, 0);
  eq('CAS: the predicate is the current non-null value',
    calls.filter((c) => c.op === 'arm').map((c) => c.current), [B_NEW]);
  ok(/LOWERING/.test(out), '…but it says so out loud, because it re-admits older tabs');
}
{
  const { code, out, calls } = await run(['--build', String(B_NEW), '--apply'], { armRows: [] });
  eq('0 rows updated exits 1', code, 1);
  ok(/CAS MISS/.test(out), 'a CAS miss says so');
  ok(!/✓ armed/.test(out), 'a CAS miss never prints the success line');
  eq('…and it does not pretend to read the value back', calls.filter((c) => c.op === 'readGate'), []);
}

// ── disarming is always safe ─────────────────────────────────────────────────
{
  const { code, out, calls } = await run(['--disarm'], { org: orgRow({ min_client_build: B_NEW }) });
  eq('--disarm without --apply exits 0', code, 0);
  eq('…and writes nothing', wrote(calls), []);
  ok(/Dry run/.test(out), '…and says it is a dry run');
}
{
  const { code, out, calls } = await run(['--disarm', '--apply'], { org: orgRow({ min_client_build: B_NEW }), gateAfter: null });
  eq('--disarm --apply exits 0', code, 0);
  eq('…and clears the floor', calls.filter((c) => c.op === 'disarm').map((c) => c.org), [ORG]);
  eq('…never arming on the way', calls.filter((c) => c.op === 'arm'), []);
  ok(/NULL/.test(out) && /disarmed/.test(out), '…and reports the row now reads NULL');
}
{
  const { code, out } = await run(['--disarm', '--apply', '--build', String(B_NEW + 99)]);
  eq('--disarm wins over a --build that would otherwise be refused', code, 0);
  ok(!/REFUSING/.test(out), '…because clearing the floor can never lock anyone out');
}

// a row that cannot be read is a refusal, not a crash
{
  const { code, out, calls } = await run(['--build', String(B_NEW), '--apply'], { org: null });
  eq('no org_state row exits 1', code, 1);
  eq('…and writes nothing', wrote(calls), []);
  ok(/read failed/.test(out), '…and says the read failed');
}

// ── the Postgres transport ───────────────────────────────────────────────────
// Every statement parameterized, ordered and bounded; the bigint columns normalized,
// because node-postgres hands int8 back as a STRING while PostgREST hands back a number —
// left as strings, `wantBuild > maxBuild` and the printed timestamps both go wrong.
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => { calls.push({ text, params }); return answer(text, params); },
  };
}
const paramsOnly = (calls) => calls.every(({ text, params }) => (params || []).every((v, i) => {
  const asText = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  return text.includes(`$${i + 1}`) && !text.includes(asText);
}));

{
  // `org_state_writes_seen` is matched FIRST: `from public.org_state` is a prefix of it.
  const c = fakeClient((text) => {
    if (/org_state_writes_seen/.test(text)) return { rows: [{ updated_by_build: String(B_NEW), observed_at: new Date('2026-09-27T12:00:00.000Z') }] };
    if (/from public\.org_state\b/.test(text)) {
      return { rows: [{ organization_id: ORG, version: '4177', min_client_build: String(B_OLD), freeze_strip: null, updated_by_build: String(B_NEW), updated_via: 'browser', updated_at: new Date('2026-09-27T12:00:00.000Z') }] };
    }
    if (/from public\.jobs/.test(text)) return { rows: [{ updated_by_build: String(B_OLD), updated_at: new Date('2026-09-20T00:00:00.000Z') }] };
    throw new Error(`the fake saw an unexpected statement: ${text}`);
  });
  const t = pgTransport(c);

  const org = await t.readOrg();
  eq('readOrg normalizes the bigints to numbers', [org.version, org.min_client_build, org.updated_by_build], [4177, B_OLD, B_NEW]);
  eq('…and the timestamp to an ISO string', org.updated_at, '2026-09-27T12:00:00.000Z');
  ok(/order by organization_id/.test(c.calls[0].text) && /limit 1/.test(c.calls[0].text),
    'the org read is ordered and bounded, so "the row" is deterministic');

  const sink = await t.observedSink(OBSERVED_LIMIT);
  eq('the sink rows are normalized the same way', sink, [{ updated_by_build: B_NEW, observed_at: '2026-09-27T12:00:00.000Z' }]);
  const sinkSql = c.calls[1];
  ok(/order by observed_at desc/.test(sinkSql.text), 'the sink is read newest-first');
  ok(/limit \$1/.test(sinkSql.text), '…bounded by a parameter');
  eq('…at the declared limit', sinkSql.params, [OBSERVED_LIMIT]);

  await t.observedJobs(OBSERVED_LIMIT);
  const jobSql = c.calls[2];
  ok(/updated_by_build is not null/.test(jobSql.text), 'the jobs read skips rows with no build');
  ok(/order by updated_at desc/.test(jobSql.text) && /limit \$1/.test(jobSql.text), '…newest-first and bounded');
  ok(paramsOnly(c.calls), 'every read keeps its values in params, never in the SQL text');
}

// the sink may simply not exist yet — that is survivable, and must not poison the run
{
  const c = fakeClient((text) => {
    if (/org_state_writes_seen/.test(text)) throw new Error('relation "public.org_state_writes_seen" does not exist');
    return { rows: [] };
  });
  eq('an absent sink reads as null, not a throw', await pgTransport(c).observedSink(OBSERVED_LIMIT), null);
}

// the CAS predicate is the value the run read, in both shapes
{
  const c = fakeClient(() => ({ rows: [{ min_client_build: String(B_NEW) }] }));
  const t = pgTransport(c);

  await t.arm({ org: ORG, value: B_NEW, current: null });
  const fromNull = c.calls[0];
  ok(/min_client_build is null/.test(fromNull.text), 'CAS from NULL is `min_client_build is null`');
  ok(!/min_client_build = \$3/.test(fromNull.text), '…with no third parameter to bind');
  eq('…and binds only the value and the org', fromNull.params, [B_NEW, ORG]);

  await t.arm({ org: ORG, value: B_NEW, current: B_OLD });
  const fromValue = c.calls[1];
  ok(/min_client_build = \$3/.test(fromValue.text), 'CAS from a value is `min_client_build = $3`');
  eq('…binding the value it just read', fromValue.params, [B_NEW, ORG, B_OLD]);
  ok(/returning min_client_build/.test(fromValue.text), 'both return the row, so 0 rows is a detectable miss');
  ok(/where organization_id = \$2/.test(fromValue.text), 'both are org-scoped on a parameter');

  eq('readGate reads the value back as a number', await t.readGate(ORG), B_NEW);
  ok(/select min_client_build from public\.org_state where organization_id = \$1/.test(c.calls[2].text),
    '…org-scoped on a parameter');

  await t.disarm(ORG);
  const off = c.calls[3];
  ok(/set min_client_build = null/.test(off.text), '--disarm writes NULL');
  ok(/where organization_id = \$1/.test(off.text) && !/and min_client_build/.test(off.text),
    '…unconditionally, because clearing the floor is always safe');
  eq('…binding only the org', off.params, [ORG]);
  ok(paramsOnly(c.calls), 'every write keeps its values in params, never in the SQL text');
}

// ── the shape of the script itself ───────────────────────────────────────────
{
  // Comment lines are stripped: the header explains both hazards by name, and a warning
  // about a hazard must not read as the hazard.
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(/import\.meta\.url/.test(SRC) && /process\.argv\[1\]/.test(SRC),
    'the live section is behind a main-module guard, so importing it is inert');
  ok(!/process\.exit\(/.test(CODE),
    'exit codes are set, the process is never ended outright — after network I/O that can crash node on Windows');
  ok(/client\.end\(\)/.test(CODE), 'the pg client is closed on every exit');
  eq('the pg path connects exactly once — a retry loop gets the address banned',
    (CODE.match(/client\.connect\(\)/g) || []).length, 1);
  ok(!/Date\.now\(\)/.test(CODE),
    'the floor is never derived from the clock — a "now" floor is above every build that exists');
  ok(/SUPABASE_DB_URL/.test(SRC), 'the Postgres credential is a documented way in');
  const usage = SRC.slice(0, SRC.indexOf('══'));
  ok(/--disarm/.test(usage), 'the usage block documents the rollback');
}

console.log(`\narm-fleet-gate: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
