// CS-671 — a cleaner's save can no longer push the shared record past its size limit.
//
// THE BUG. The org-state route measures a save by what was POSTED (api/state/org-state.js: the
// content-length against MAX_STATE_BYTES). A cleaner posts a PROJECTION; the server merges their
// changes into the FULL record — plus the bell rows those changes ring — and committed it through
// writeOrgStateFromClient, which checks no size (api/_lib/orgState.js). Near the limit one
// ordinary message, or one 2 KB note, committed past 3.5 MB with a 200; from then on every office
// save answered 413 and every server writer threw. And nothing capped what a crew save may write:
// a single crafted message could carry 600 KB (api/_lib/crewMerge.js).
//
// THE FIX. The crew branch measures the MERGED record as the office's next save will carry it, and
// refuses (413, the stable code `state-too-large`, which the phone already treats as "kept on this
// device, told once") a save that would grow it past the limit; one that does not grow it still
// lands. Crew-written text is capped (CREW_LIMITS): a longer text is clipped to its limit and
// reported, so the phone converges; a record still too big after that is dropped.
//
// HOW. The REAL POST /api/state/org-state handler and the real Supabase client against
// scripts/fake-supabase-http.mjs (the audit's repro shapes: F10-01 and its near-limit variant).
//
//   node app/scripts/test-crew-save-size.mjs
import { startFakeSupabase } from './fake-supabase-http.mjs';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { projectCrewView } from '../api/_lib/crewView.js';
import { MAX_STATE_BYTES } from '../src/lib/stateBudget.js';
import * as budget from '../api/_lib/blobBudget.js';
import * as merge from '../api/_lib/crewMerge.js';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — this repo's suites disagree, so it is stated.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} (${detail})` : label); };
const clone = (x) => JSON.parse(JSON.stringify(x));

// The source of truth for the codes and limits (fallbacks only let the pre-fix tree run to its failures).
const CODE = budget.STATE_TOO_LARGE_CODE ?? 'state-too-large';
const LIMITS = merge.CREW_LIMITS ?? { textChars: 5000, nameChars: 120, phoneChars: 40, noteGrowthChars: 5400, recordBytes: 16000 };

const ORG = '00000000-0000-0000-0000-000000000001';
const USERS = {
  't-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner' } },
  't-crew': { id: 'a-crew', email: 'crew@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_crew' } },
};
const fake = await startFakeSupabase({ authUsers: USERS });
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
const alerts = [];
const consoleError = console.error;
console.error = (...a) => { if (a[0] === '[ALERT]') { alerts.push(String(a[1] || '')); return; } consoleError(...a); };
const { default: handler } = await import('../api/state/org-state.js');

const CREW_JOBS = [{ id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1' }];
const PEOPLE = [
  { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co', pay: { type: 'none' }, notificationPrefs: {}, signaturePrefs: {} },
  { id: 'u_adm', role: 'admin', status: 'active', name: 'Adm', email: 'adm@cs.co', pay: { type: 'none' }, notificationPrefs: {}, signaturePrefs: {} },
  { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mgr', email: 'mgr@cs.co', pay: { type: 'none' }, notificationPrefs: {}, signaturePrefs: {} },
  { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: 'crew@cs.co', phone: '555-0100', pay: { type: 'hourly', hourlyRate: 20 }, notificationPrefs: { newInternalMessage: true }, signaturePrefs: { text: 'sig' } },
];
const baseState = () => ({
  version: 5,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: clone(PEOPLE),
  services: [], frequencies: [], tags: [], snippets: [],
  clients: [{ id: 'c1', name: 'Acme', notes: '', standingCrewIds: [] }],
  sites: [{ id: 's1', clientId: 'c1' }], contacts: [], clientActivities: [], invoices: [], reimbursements: [],
  payrollLines: [],
  permissions: [
    { id: 'messaging.use', roles: ['owner', 'admin', 'manager', 'crew'] },
    { id: 'clients.view', roles: ['owner', 'admin', 'manager', 'crew'] },
  ],
  userPermissionOverrides: [], timeOff: [],
  keys: [{ id: 'k1', clientId: 'c1', clientName: 'Acme', masterCode: 'M1', label: 'K1', status: 'in', heldByUserId: null, heldByName: null }],
  keyEvents: [],
  conversations: [{ id: 'cv-int', channel: 'internal', participantUserIds: ['u_crew', 'u_owner', 'u_adm', 'u_mgr'], createdByUserId: 'u_owner', title: 'Ops', lastMessageAt: '2026-09-01T00:00:00.000Z', starredByUserIds: [], mutedByUserIds: [] }],
  messages: [],
  notifications: [{ id: 'n_crew', userId: 'u_crew', title: 'Yours', body: '', createdAt: '2026-09-01T00:00:00.000Z', readAt: null }],
  opsSettings: {}, opportunities: [], pipelines: [], clientReview: { sections: {}, drafts: {}, picks: {} }, jobs: [],
});
// What the office's save of `state` weighs: the route measures exactly this body.
const envelope = (state, v) => `{"state":${canonicalJson(state)},"baseVersion":${v},"build":0,"tab":"t"}`;
const envBytes = (state, v) => Buffer.byteLength(envelope(state, v));
// A record padded with office-only data (pay lines the crew projection never carries) so the
// office's envelope sits `under` bytes below the limit; or, with a negative `under`, ABOVE it.
function padded(under) {
  const s = baseState();
  const target = MAX_STATE_BYTES - under;
  s.payrollLines = [{ id: 'pl0', userId: 'u_owner', periodKey: '2026-09-01', kind: 'earning', category: 'bonus', amount: 1, taxable: true, note: '' }];
  s.payrollLines[0].note = 'x'.repeat(Math.max(0, target - envBytes(s, 5)));
  return s;
}
function seed(state) {
  fake.tables.org_state.splice(0, fake.tables.org_state.length, {
    organization_id: ORG, state, version: 5, protected_fingerprint: null, min_client_build: null, freeze_strip: [],
  });
  // A clean tomorrow: a cleaner's scope is the cleans in the jobs window (CS-677), so the row carries its start.
  fake.tables.jobs = [{ id: 'j1', organization_id: ORG, start_at: new Date(Date.now() + 86400000).toISOString(), data: { id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1', startAt: new Date(Date.now() + 86400000).toISOString() } }];
}
const row = () => fake.tables.org_state[0];
const served = () => clone(projectCrewView(row().state, { userId: 'u_crew', crewJobs: CREW_JOBS }));
async function save(token, state, baseVersion) {
  const text = envelope(state, baseVersion);
  const req = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() { return res; } };
  await handler(req, res);
  return out;
}
const message = (id, text) => ({ id, conversationId: 'cv-int', authorUserId: 'u_crew', text, sentAt: new Date().toISOString(), readByUserIds: ['u_crew'] });
const committedFits = () => envBytes(row().state, row().version) <= MAX_STATE_BYTES;

// ── 1. 🔴 the near-limit case: ONE ordinary message (the audit's v-crew-near-limit A) ─────
seed(padded(300));
{
  const before = JSON.stringify(row().state);
  ok('(setup) the office\'s envelope sits just under the limit', envBytes(row().state, 5) <= MAX_STATE_BYTES && envBytes(row().state, 5) > MAX_STATE_BYTES - 400,
    `${envBytes(row().state, 5)} of ${MAX_STATE_BYTES}`);
  const p = served();
  p.messages.push(message('m-1', 'Front door lock is broken at the east entrance, please send someone tomorrow morning before 7am. Thanks!'.padEnd(120, '.')));
  const r = await save('t-crew', p, 5);
  ok('1.1 🔴 a crew message that would take the merged record past the limit is REFUSED with 413', r.status === 413, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  ok('1.2 … with the stable code the phone treats as "too large" and plain words', r.body?.code === CODE && /limit/i.test(r.body?.error || ''), JSON.stringify(r.body));
  ok('1.3 🔴 … and NOTHING is committed (no version bump, no message, no bell rows)', row().version === 5 && JSON.stringify(row().state) === before,
    `version ${row().version}`);
  ok('1.4 the full record is reported (an alert names the size), never silently refused', alerts.some((a) => /over_size_limit|size limit/i.test(a)), alerts.slice(-2).join(' | '));
  const o = clone(row().state);
  const r2 = await save('t-owner', o, row().version);
  ok('1.5 🔴 the owner\'s next save still SUCCEEDS (it used to be 413 from here on)', r2.status === 200, `status ${r2.status} ${JSON.stringify(r2.body).slice(0, 160)}`);
}

// ── 2. 🔴 the near-limit case: a 2 KB customer note (v-crew-near-limit B) ───────────────────
seed(padded(300));
{
  const p = served();
  p.clients = p.clients.map((c) => (c.id === 'c1' ? { ...c, notes: 'n'.repeat(2048) } : c));
  const r = await save('t-crew', p, 5);
  ok('2.1 🔴 a 2 KB note that would overfill the record is refused (413)', r.status === 413 && r.body?.code === CODE, `status ${r.status}`);
  ok('2.2 … the note is not committed', (row().state.clients[0].notes || '') === '' && row().version === 5);
  const r2 = await save('t-owner', clone(row().state), row().version);
  ok('2.3 … and the office can still save', r2.status === 200, `status ${r2.status}`);
}

// ── 3. a crew save that does NOT grow the record still lands, even past the limit ─────────
// (The record may already be over — from before this fix, or a data-op. A cleaner dismissing
// their own bell row shrinks it; refusing that would wedge them for nothing.)
seed(padded(-500));
{
  ok('(setup) the committed record is already over the limit', !committedFits());
  const p = served();
  p.notifications = p.notifications.filter((n) => n.id !== 'n_crew');
  const r = await save('t-crew', p, 5);
  ok('3.1 a crew save that SHRINKS the record lands (200)', r.status === 200 && !row().state.notifications.some((n) => n.id === 'n_crew'), `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const p2 = served();
  p2.messages.push(message('m-2', 'hello'));
  const r2 = await save('t-crew', p2, row().version);
  ok('3.2 🔴 … but one that GROWS an over-limit record is refused', r2.status === 413 && !row().state.messages.some((m) => m.id === 'm-2'), `status ${r2.status}`);
}

// ── 4. 🔴 the audit's first repro: ONE crafted 600 KB message (F10-01) ─────────────────────
{
  const s = baseState();
  s.payrollLines = Array.from({ length: 3000 }, (_, i) => ({ id: `pl${i}`, userId: 'u_owner', periodKey: '2026-09-01', kind: 'earning', category: 'bonus', amount: 1, taxable: true, note: 'x'.repeat(1000) }));
  seed(s);
  const p = served();
  p.messages.push(message('m-big', 'y'.repeat(600000)));
  const r = await save('t-crew', p, 5);
  const big = row().state.messages.find((m) => m.id === 'm-big');
  ok('4.1 🔴 a 600 KB message never reaches the record: its text is clipped to the crew limit', !!big && typeof big.text === 'string' && big.text.length === LIMITS.textChars,
    `status ${r.status}, committed text ${big ? big.text.length : 'none'} chars`);
  ok('4.2 … the clip is reported back (the phone re-reads and shows what was kept)', r.status === 200 && r.body?.dropped?.count >= 1 && (r.body?.dropped?.slices || []).includes('messages'),
    JSON.stringify(r.body));
  ok('4.3 🔴 … the committed record still fits (it used to be ~4 MB)', committedFits(), `${envBytes(row().state, row().version)} bytes`);
  const r2 = await save('t-owner', clone(row().state), row().version);
  ok('4.4 🔴 … and the owner\'s next save succeeds (it used to be 413)', r2.status === 200, `status ${r2.status}`);
}

// ── 5. the crew's other writes are capped too ─────────────────────────────────────────────
seed(baseState());
{
  const now = new Date().toISOString();
  const p = served();
  const me = p.users.find((u) => u.id === 'u_crew');
  me.name = 'N'.repeat(500);
  me.phone = '5'.repeat(200);
  p.clientActivities.push({ id: 'ca1', clientId: 'c1', kind: 'note', authorUserId: 'u_crew', body: 'b'.repeat(20000), occurredAt: now, createdAt: now });
  p.keyEvents.push({ id: 'ke-junk', keyId: 'k1', kind: 'checkout', byUserId: 'u_crew', occurredAt: now, junk: 'j'.repeat(50000) });
  p.messages.push({ ...message('m-junk', 'fine'), junk: 'j'.repeat(50000) });
  p.notifications = p.notifications.map((n) => (n.id === 'n_crew' ? { ...n, readAt: 'r'.repeat(50000) } : n));
  const r = await save('t-crew', p, 5);
  const s = row().state;
  const self = s.users.find((u) => u.id === 'u_crew');
  ok('5.1 the save lands (a merge never refuses over a clip)', r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  ok('5.2 🔴 own name clipped to CREW_LIMITS.nameChars', self.name.length === LIMITS.nameChars, `${self.name.length} chars`);
  ok('5.3 🔴 own phone clipped to CREW_LIMITS.phoneChars', self.phone.length === LIMITS.phoneChars, `${self.phone.length} chars`);
  const act = s.clientActivities.find((a) => a.id === 'ca1');
  ok('5.4 🔴 a note\'s body clipped to CREW_LIMITS.textChars', !!act && act.body.length === LIMITS.textChars, `${act ? act.body.length : 'none'}`);
  ok('5.5 🔴 a key event carrying 50 KB is dropped, never committed', !s.keyEvents.some((e) => e.id === 'ke-junk'));
  ok('5.6 🔴 a message carrying 50 KB beside its text is dropped', !s.messages.some((m) => m.id === 'm-junk'));
  const n = s.notifications.find((x) => x.id === 'n_crew');
  ok('5.7 🔴 a read receipt is a time, not 50 KB', !!n && typeof n.readAt === 'string' && n.readAt.length <= 40 && Number.isFinite(Date.parse(n.readAt)), `${n ? String(n.readAt).length : 'none'} chars`);
  ok('5.8 every clip and drop is reported', r.body?.dropped?.count >= 6, JSON.stringify(r.body?.dropped));
}
seed(baseState());
{
  const p = served();
  p.clients = p.clients.map((c) => (c.id === 'c1' ? { ...c, notes: `[Oct 12] Crew: ${'z'.repeat(LIMITS.noteGrowthChars + 1)}` } : c));
  const me = p.users.find((u) => u.id === 'u_crew');
  me.notificationPrefs = { ...me.notificationPrefs, junk: 'j'.repeat(50000) };
  me.signaturePrefs = { text: 's'.repeat(50000) };
  const r = await save('t-crew', p, 5);
  const s = row().state;
  const self = s.users.find((u) => u.id === 'u_crew');
  ok('5.9 🔴 a customer note that grows by more than CREW_LIMITS.noteGrowthChars in one save is dropped', s.clients[0].notes === '' && r.status === 200, `notes ${s.clients[0].notes.length} chars`);
  ok('5.10 🔴 notification settings carrying 50 KB are dropped (the committed ones kept)', !('junk' in (self.notificationPrefs || {})) && self.notificationPrefs.newInternalMessage === true);
  ok('5.11 🔴 a signature carrying 50 KB is dropped', (self.signaturePrefs || {}).text === 'sig');
}
seed(baseState());
{
  const p = served();
  p.users.find((u) => u.id === 'u_crew').name = { evil: 'o'.repeat(1000) };
  p.messages.push(message('m-ok', 'On my way'));
  const r = await save('t-crew', p, 5);
  const s = row().state;
  ok('5.12 a name that is not text is dropped (the name stays), the rest of the save lands', r.status === 200
    && s.users.find((u) => u.id === 'u_crew').name === 'Crew' && s.messages.some((m) => m.id === 'm-ok' && m.text === 'On my way'), `status ${r.status}`);
  ok('5.13 an ordinary message is untouched by the caps', s.messages.find((m) => m.id === 'm-ok')?.text === 'On my way');
}

// ── 6. the office path's 413 carries the same stable code ─────────────────────────────────
seed(padded(300));
{
  const o = clone(row().state);
  o.payrollLines[0].note += 'x'.repeat(1000);
  const r = await save('t-owner', o, 5);
  ok('6.1 an office save over the limit is 413 with the same stable code', r.status === 413 && r.body?.code === CODE, `status ${r.status} ${JSON.stringify(r.body)}`);
}

await fake.close();
console.log(`\ntest-crew-save-size: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
