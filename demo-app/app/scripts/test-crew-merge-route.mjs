// CS-002 — the CREW WRITE MERGE end to end, offline: the REAL POST /api/state/org-state
// handler + the real Supabase client against scripts/fake-supabase-http.mjs, driven with a
// CREW-claim JWT (as production would carry).
//
// PINS:
//   · each allowlisted change commits (message send, own read-state, own profile, key
//     checkout, client note) and message recipients' notifications are DERIVED server-side;
//   · disallowed changes are DROPPED (200 + dropped, never 403) and NEVER committed;
//   · 🔴 II.3 — a crew POST that edits an INVOICE or ANOTHER USER'S notification COMMITS those
//     on pre-fix code (crew went through the office path, which does not cover those slices),
//     and is DROPPED here. These assertions FAIL on origin/main.
//   · omission never deletes (payroll / invoices the projection omits survive);
//   · the mandatory-notification policy is re-applied server-side (a crew mute is stripped);
//   · a stale base is a 409;
//   · the owner path is unchanged.
//
//   node app/scripts/test-crew-merge-route.mjs
import { startFakeSupabase } from './fake-supabase-http.mjs';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { projectCrewView } from '../api/_lib/crewView.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} (${detail})` : label); };
const clone = (x) => JSON.parse(JSON.stringify(x));

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
// Swallow the [ALERT] dropped-change reports so the suite output stays clean.
const consoleError = console.error;
console.error = (...a) => { if (a[0] === '[ALERT]') return; consoleError(...a); };
const { default: handler } = await import('../api/state/org-state.js');

const CREW_JOBS = [{ id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1' }];

const seedState = () => ({
  version: 5,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co', pay: { type: 'none' }, notificationPrefs: {}, signaturePrefs: {} },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: 'crew@cs.co', phone: '222', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'E2' }, notificationPrefs: { jobCancelled: true, mobilePushEnabled: true, newInternalMessage: true }, signaturePrefs: { text: 'sig' } },
  ],
  services: [], frequencies: [], tags: [], snippets: [], inspectionTemplates: [], checklistTemplates: [],
  clients: [{ id: 'c1', name: 'Acme', notes: 'orig', standingCrewIds: [] }, { id: 'c2', name: 'Other', notes: 'secret', standingCrewIds: [] }],
  sites: [{ id: 's1', clientId: 'c1' }, { id: 's2', clientId: 'c2' }],
  contacts: [{ id: 'ct1', companyId: 'c1' }],
  clientActivities: [],
  invoices: [{ id: 'inv1', total: 12345 }],
  payrollLines: [{ id: 'pl1', userId: 'u_crew', periodKey: '2026-09-01', kind: 'earning', category: 'bonus', amount: 999, taxable: true }],
  reimbursements: [],
  permissions: [
    { id: 'clients.view', roles: ['owner', 'admin', 'manager', 'crew'] },
    { id: 'messaging.use', roles: ['owner', 'admin', 'manager', 'crew'] },
  ],
  userPermissionOverrides: [],
  timeOff: [],
  keys: [{ id: 'k1', clientId: 'c1', clientName: 'Acme', masterCode: 'SECRET1', label: 'K1', status: 'in', heldByUserId: null, heldByName: null }],
  keyEvents: [],
  conversations: [{ id: 'cv-int', channel: 'internal', participantUserIds: ['u_crew', 'u_owner'], createdByUserId: 'u_owner', title: 'Ops', lastMessageAt: '2026-09-01T00:00:00.000Z', starredByUserIds: [], mutedByUserIds: [] }],
  messages: [{ id: 'm0', conversationId: 'cv-int', authorUserId: 'u_owner', text: 'hello team', sentAt: '2026-09-01T00:00:00.000Z', readByUserIds: ['u_owner'] }],
  notifications: [
    { id: 'n_crew', userId: 'u_crew', title: 'yours', createdAt: '2026-09-01T00:00:00.000Z', readAt: null },
    { id: 'n_owner', userId: 'u_owner', title: 'theirs', createdAt: '2026-09-01T00:00:00.000Z', readAt: null },
  ],
  opsSettings: { defaultGeofenceRadiusM: 250, otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0, payDriveTime: true },
  accountMedia: [],
  quotes: [], syncedPayments: [], financialSnapshot: null, employeeDocuments: [], pipelines: [], opportunities: [], activePipelineId: null,
  marketingInboxes: [], marketingSequences: [], marketingEnrollments: [], marketingSends: [], marketingReplies: [], marketingSuppressions: [], marketingSettings: {},
  reviews: { indeedActual: 0 }, inspectionFollowUps: [], opsAlertEvents: [], supplyItems: [], supplyRequests: [], contactActivities: [],
  clientReview: { sections: {}, drafts: {}, picks: {} }, reminderTemplates: [], reminderEvents: [], oauthWorkspaces: [], connectedInboxes: [], invitations: [], jobs: [],
});

function freshOrg() {
  fake.tables.org_state.splice(0, fake.tables.org_state.length, {
    organization_id: ORG, state: seedState(), version: 5, protected_fingerprint: null, min_client_build: null, freeze_strip: [],
  });
  fake.tables.jobs = [{ id: 'j1', organization_id: ORG, data: { id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1' } }];
}
const st = () => fake.tables.org_state[0].state;
const served = () => clone(projectCrewView(seedState(), { userId: 'u_crew', crewJobs: CREW_JOBS }));

async function save(token, state, baseVersion) {
  const text = `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":0,"tab":"tab-1"}`;
  const req = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() { return res; } };
  await handler(req, res);
  return out;
}

// ── 1. ALLOWED crew changes commit; recipient notification derived ────────────
freshOrg();
{
  const p = served();
  const now = new Date().toISOString();
  p.messages.push({ id: 'm1', conversationId: 'cv-int', authorUserId: 'u_crew', text: 'on my way', sentAt: now, readByUserIds: ['u_crew'] });
  p.notifications.find((n) => n.id === 'n_crew').readAt = now;
  p.users.find((u) => u.id === 'u_crew').name = 'Crew Renamed';
  const k = p.keys.find((x) => x.id === 'k1'); k.status = 'out'; k.heldByUserId = 'u_crew'; k.heldByName = 'Crew'; k.updatedAt = now;
  p.keyEvents.push({ id: 'ke1', keyId: 'k1', kind: 'checkout', byUserId: 'u_crew', occurredAt: now });
  p.clientActivities.push({ id: 'ca1', clientId: 'c1', kind: 'note', authorUserId: 'u_crew', body: 'arrived', occurredAt: now, createdAt: now });
  p.clients.find((c) => c.id === 'c1').notes = 'arrived\n\norig';

  const r = await save('t-crew', p, 5);
  ok('allowed: 200', r.status === 200, `status ${r.status} body ${JSON.stringify(r.body)}`);
  const s = st();
  ok('allowed: message committed (authored by crew)', s.messages.some((m) => m.id === 'm1' && m.authorUserId === 'u_crew'));
  ok('allowed: own notification marked read', !!s.notifications.find((n) => n.id === 'n_crew').readAt);
  ok('allowed: own name changed', s.users.find((u) => u.id === 'u_crew').name === 'Crew Renamed');
  ok('allowed: key checked out', s.keys.find((k2) => k2.id === 'k1').status === 'out' && s.keys.find((k2) => k2.id === 'k1').heldByUserId === 'u_crew');
  ok('allowed: key masterCode PRESERVED from full', s.keys.find((k2) => k2.id === 'k1').masterCode === 'SECRET1');
  ok('allowed: keyEvent appended (byUserId=crew)', s.keyEvents.some((e) => e.id === 'ke1' && e.byUserId === 'u_crew'));
  ok('allowed: client note activity added', s.clientActivities.some((a) => a.id === 'ca1' && a.authorUserId === 'u_crew'));
  ok('allowed: client.notes updated', s.clients.find((c) => c.id === 'c1').notes.startsWith('arrived'));
  ok('server-derived: owner got newInternalMessage notification', s.notifications.some((n) => n.userId === 'u_owner' && n.eventKey === 'newInternalMessage'));
  // omission-never-deletes riders
  ok('allowed: invoices intact', s.invoices.length === 1 && s.invoices[0].total === 12345);
  ok('allowed: payrollLines intact', s.payrollLines.length === 1 && s.payrollLines[0].amount === 999);
}

// ── 2. 🔴 II.3 — disallowed edits DROPPED, not committed (FAILS on origin/main) ─
freshOrg();
{
  // A full-shaped blob (what a pre-fix crew tab held) with an invoice edit + another user's
  // notification edit + a forged own pay raise + a forged payroll line. On pre-fix the office
  // path committed the invoice/notification edits (not in the field-guard's fingerprint).
  const p = clone(seedState());
  p.invoices[0].total = 1;                                   // edit an invoice
  p.notifications.find((n) => n.id === 'n_owner').title = 'HACKED'; // edit another user's bell row
  p.notifications.find((n) => n.id === 'n_crew').readAt = new Date().toISOString(); // one legit edit
  const r = await save('t-crew', p, 5);
  ok('II.3: 200 (merge, never 403)', r.status === 200, `status ${r.status} body ${JSON.stringify(r.body)}`);
  const s = st();
  ok('🔴 II.3: invoice edit NOT committed', s.invoices[0].total === 12345, `total ${s.invoices[0].total}`);
  ok("🔴 II.3: another user's notification NOT changed", s.notifications.find((n) => n.id === 'n_owner').title === 'theirs');
  ok('II.3: the one legit edit (own read-state) DID commit', !!s.notifications.find((n) => n.id === 'n_crew').readAt);
}

// ── 3. 🔴 II.3 — a forged payroll line / own pay raise is DROPPED, not committed ─
freshOrg();
{
  const p = served();
  p.payrollLines = [{ id: 'evil_pl', userId: 'u_crew', periodKey: '2026-09-01', kind: 'earning', category: 'bonus', amount: 5000, taxable: true }];
  p.users.find((u) => u.id === 'u_crew').pay = { type: 'hourly', hourlyRate: 500 };
  const r = await save('t-crew', p, 5);
  ok('II.3 money: 200 (merge, never 403)', r.status === 200, `status ${r.status} body ${JSON.stringify(r.body)}`);
  const s = st();
  ok('🔴 II.3: forged payroll line NOT committed', !s.payrollLines.some((l) => l.id === 'evil_pl'));
  ok('🔴 II.3: real payroll line preserved (999)', s.payrollLines.length === 1 && s.payrollLines[0].amount === 999);
  ok('🔴 II.3: crew pay NOT raised', s.users.find((u) => u.id === 'u_crew').pay.hourlyRate === 20);
}

// ── 4. mandatory-notification policy re-applied server-side ───────────────────
freshOrg();
{
  const p = clone(seedState());
  p.users.find((u) => u.id === 'u_crew').notificationPrefs = { jobCancelled: false, mobilePushEnabled: false, newInternalMessage: true };
  const r = await save('t-crew', p, 5);
  ok('mandatory: 200', r.status === 200, `status ${r.status}`);
  const prefs = st().users.find((u) => u.id === 'u_crew').notificationPrefs;
  ok('mandatory: event mute STRIPPED (jobCancelled stays on)', prefs.jobCancelled === true);
  ok('mandatory: channel pref allowed (mobilePushEnabled off)', prefs.mobilePushEnabled === false);
}

// ── 5. stale base → 409 ───────────────────────────────────────────────────────
freshOrg();
{
  const r = await save('t-crew', served(), 4); // committed is version 5
  ok('stale base: 409', r.status === 409, `status ${r.status}`);
}

// ── 6. owner (office) path unchanged ──────────────────────────────────────────
freshOrg();
{
  const p = clone(seedState());
  p.contacts.push({ id: 'ct2', companyId: 'c1', firstName: 'New' });
  const r = await save('t-owner', p, 5);
  ok('owner: 200', r.status === 200, `status ${r.status} body ${JSON.stringify(r.body)}`);
  ok('owner: version bumped to 6', r.body?.version === 6, `version ${r.body?.version}`);
  ok('owner: full blob committed (contact added)', st().contacts.some((c) => c.id === 'ct2'));
  ok('owner: no crew "dropped" field', r.body?.dropped === undefined);
}

// ── 7. 🔴 F1 (CS-002 L3): an ORPHANED thread stays office-only — a crew save can neither
//    POST INTO it nor MARK-READ its messages. DELETE_USER scrubs offboarded members from
//    participantUserIds, so a thread can end up []; the read projection must hide it and the
//    write merge must refuse writes to it. Pre-fix `conversationVisibleToCrew`'s
//    `parts.length === 0` clause made the orphan visible → servedConvIds carried it → the
//    appended message committed AND the read-state loop (ungated) flipped the caller's own
//    read membership. Both assertions FAIL on origin/main. ─────────────────────────────────
freshOrg();
{
  // Give the committed blob an orphaned internal thread (participantUserIds []) + a message.
  const committed = st();
  committed.conversations.push({ id: 'cv-orphan', channel: 'internal', participantUserIds: [], createdByUserId: null, createdByName: 'Departed', title: 'Orphan', lastMessageAt: '2026-09-01T00:00:00.000Z', starredByUserIds: [], mutedByUserIds: [] });
  committed.messages.push({ id: 'm-orphan', conversationId: 'cv-orphan', authorUserId: null, authorName: 'Departed', text: 'orphaned secret', sentAt: '2026-09-01T00:00:00.000Z', readByUserIds: [] });

  // A crafted crew post: the legit projection (which must NOT serve the orphan) PLUS a mark-read
  // flip on the orphan's existing message and a new message injected into the orphan thread.
  const p = served();
  const now = new Date().toISOString();
  p.messages.push({ id: 'm-orphan', conversationId: 'cv-orphan', authorUserId: null, authorName: 'Departed', text: 'orphaned secret', sentAt: '2026-09-01T00:00:00.000Z', readByUserIds: ['u_crew'] });
  p.messages.push({ id: 'm-inject', conversationId: 'cv-orphan', authorUserId: 'u_crew', text: 'injected', sentAt: now, readByUserIds: ['u_crew'] });

  const r = await save('t-crew', p, 5);
  ok('F1 merge: 200 (merge, never 403)', r.status === 200, `status ${r.status} body ${JSON.stringify(r.body)}`);
  const s = st();
  const morph = s.messages.find((m) => m.id === 'm-orphan');
  ok('🔴 F1: crew mark-read on orphan thread NOT committed', morph && !(morph.readByUserIds || []).includes('u_crew'), `readBy ${JSON.stringify(morph && morph.readByUserIds)}`);
  ok('🔴 F1: message injected into orphan thread NOT committed', !s.messages.some((m) => m.id === 'm-inject'));
  ok('F1: orphan thread + its message survive untouched (omission never deletes)', s.conversations.some((c) => c.id === 'cv-orphan') && !!morph);
}

await fake.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1); }
