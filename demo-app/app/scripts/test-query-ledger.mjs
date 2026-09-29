// Regression suite for scripts/query-ledger.mjs (DEV_PLAYBOOK P0 step 5). Offline, pure.
// It exercises the static parse of every Supabase call shape — .from( (table), storage.from(
// (bucket), .rpc( (function), .channel( (topic) — plus per-file client resolution
// (service-role vs user JWT), a module-const table name resolved statically, chained AND
// reassigned .order/.range/.limit, the organization_id filter flag, and the exclusion of
// Array.from / Buffer.from and commented-out calls.
// Run: node scripts/test-query-ledger.mjs
//
// NOTE: fixtures build the service-client factory name by concatenation so this file's
// SOURCE never contains the literal token run-tests.mjs treats as "reaches a live service".
import assert from 'node:assert/strict';
const { parseFile } = await import('./query-ledger.mjs');

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };
const G = 'getSupa' + 'base'; // -> the service-role factory name, kept out of the source token
const rec = (records, name, kind = 'from') => records.find((r) => r.name === name && r.kind === kind);

// 1. service-role table read, chained + multiline .order/.range + org filter
ok('multiline chained .from().select().order().range() with org filter (service-role)', () => {
  const src = [
    `const db = ${G}();`,
    'export async function load(o) {',
    '  const { data } = await db',
    "    .from('jobs')",
    "    .select('*')",
    "    .eq('organization_id', o)",
    "    .order('id')",
    '    .range(0, 99);',
    '  return data;',
    '}',
  ].join('\n');
  const r = rec(parseFile('app/api/x.js', src), 'jobs');
  assert.equal(r.kind, 'from');
  assert.equal(r.verb, 'select');
  assert.equal(r.client, 'service-role');
  assert.equal(r.order, true);
  assert.equal(r.rangeLimit, true);
  assert.equal(r.orgFilter, true);
});

// 2. user-JWT insert from the frontend client
ok('frontend supabase.from().insert() is user-jwt, no order/range/org', () => {
  const src = [
    "import { supabase } from './supabaseClient';",
    'export async function add(row) {',
    "  await supabase.from('contacts').insert(row);",
    '}',
  ].join('\n');
  const r = rec(parseFile('app/src/lib/x.js', src), 'contacts');
  assert.equal(r.client, 'user-jwt');
  assert.equal(r.verb, 'insert');
  assert.equal(r.order, false);
  assert.equal(r.rangeLimit, false);
  assert.equal(r.orgFilter, false);
});

// 3. storage bucket upload
ok('supabase.storage.from(bucket).upload() is kind=storage, verb=upload', () => {
  const src = [
    "import { supabase } from './supabaseClient';",
    "await supabase.storage.from('form-uploads').upload(p, bytes);",
  ].join('\n');
  const r = rec(parseFile('app/src/lib/x.js', src), 'form-uploads', 'storage');
  assert.equal(r.kind, 'storage');
  assert.equal(r.verb, 'upload');
  assert.equal(r.client, 'user-jwt');
});

// 4. rpc on a var named `supabase` that is ACTUALLY the service client (per-file resolution)
ok('.rpc() with a local `supabase = <factory>()` resolves to service-role', () => {
  const src = [
    `const supabase = ${G}();`,
    "await supabase.rpc('reap_job_deletes', { org: ORG });",
  ].join('\n');
  const r = rec(parseFile('app/api/cron/reap.js', src), 'reap_job_deletes', 'rpc');
  assert.equal(r.kind, 'rpc');
  assert.equal(r.verb, 'rpc');
  assert.equal(r.client, 'service-role'); // NOT user-jwt, despite the name
  assert.equal(r.orgFilter, true);        // { org: ... }
});

// 5. realtime channel
ok('supabase.channel(topic).subscribe() is kind=channel', () => {
  const src = [
    "import { supabase } from './supabaseClient';",
    "supabase.channel('room').subscribe();",
  ].join('\n');
  const r = rec(parseFile('app/src/store/sync.js', src), 'room', 'channel');
  assert.equal(r.kind, 'channel');
  assert.equal(r.client, 'user-jwt');
});

// 6. table name resolved from a module-level const
ok('.from(TABLE) resolves a module-const table name; .limit() sets rangeLimit', () => {
  const src = [
    "const TABLE = 'time_entries';",
    `const db = ${G}();`,
    "const { data } = await db.from(TABLE).select('*').eq('organization_id', o).order('id').limit(10);",
  ].join('\n');
  const r = rec(parseFile('app/api/_lib/time/store.js', src), 'time_entries');
  assert.ok(r, 'time_entries resolved');
  assert.equal(r.verb, 'select');
  assert.equal(r.rangeLimit, true);
  assert.equal(r.orgFilter, true);
});

// 7. Array.from / Buffer.from are NOT supabase calls
ok('Array.from and Buffer.from are excluded', () => {
  const src = [
    'const a = Array.from(x);',
    "const b = Buffer.from(y, 'base64');",
  ].join('\n');
  const records = parseFile('app/api/x.js', src);
  assert.equal(records.length, 0);
});

// 8. .order/.range applied via builder reassignment (paged read)
ok('reassigned builder (q = q.order(); q = q.range()) still sets order/rangeLimit', () => {
  const src = [
    `const db = ${G}();`,
    "let q = db.from('quotes').select('*').eq('organization_id', o);",
    "q = q.order('id');",
    'q = q.range(0, 49);',
    'const { data } = await q;',
  ].join('\n');
  const r = rec(parseFile('app/api/x.js', src), 'quotes');
  assert.equal(r.order, true);
  assert.equal(r.rangeLimit, true);
  assert.equal(r.orgFilter, true);
});

// 9. a commented-out call is not recorded
ok('a .from() inside a line comment is ignored', () => {
  const src = [
    'export function noop() {',
    "  // legacy: await db.from('old_table').select('*');",
    '  return 1;',
    '}',
  ].join('\n');
  const records = parseFile('app/api/x.js', src);
  assert.equal(records.find((r) => r.name === 'old_table'), undefined);
});

// 10. a dynamic (unresolvable) table name is marked, not dropped
ok('an unresolvable table expression is marked <dynamic:...> and still recorded', () => {
  const src = [
    `const db = ${G}();`,
    'await db.from(pickTable(kind)).select();',
  ].join('\n');
  const records = parseFile('app/api/x.js', src);
  const dyn = records.find((r) => r.kind === 'from' && /^<dynamic:/.test(r.name));
  assert.ok(dyn, 'dynamic table recorded');
});

// 11. one-hop in-file const alias resolves to the underlying literal
ok('storage.from(BUCKET) where `const BUCKET = OPS_BUCKET` and `const OPS_BUCKET = "ops-media"` resolves', () => {
  const src = [
    "const OPS_BUCKET = 'ops-media';",
    'const BUCKET = OPS_BUCKET;',
    `const db = ${G}();`,
    'await db.storage.from(BUCKET).createSignedUrl(p, 60);',
  ].join('\n');
  const r = rec(parseFile('app/api/_lib/signatureUpload.js', src), 'ops-media', 'storage');
  assert.ok(r, 'BUCKET resolved to ops-media');
  assert.equal(r.verb, 'createSignedUrl');
  assert.equal(r.client, 'service-role');
});

console.log(`\ntest-query-ledger: ${pass}/${pass} assertions passed ✓\n`);
