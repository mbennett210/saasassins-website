// /api/hr-incidents/[...path] driven END TO END through the REAL handler against
// fake-supabase.mjs (no network, no credentials, no live project — BUILD_INTEGRITY §6b). Task #258
// from Clean Corner's queue, 2026-10-27: Matt's incident report form in HR, set up like warnings.
//
// What it proves, in the order it matters:
//   1. the gates: anonymous → 401; the office reads with hr.view and files with hr.edit; an admin
//      (no hr.* by default) and a cleaner are refused, and a report's one read answers a cleaner
//      404, so they cannot even learn one exists
//   2. filing: the reporter, the customer, the employees involved and the submitter are PICKED and
//      proved against the committed roster and customers, their names stamped; a typed reporter
//      and a typed place ("Somewhere else") do too; the org's day; the case number from the
//      database; a retried id is a no-op; the form's refusals; a follow-up answer kept only on Yes
//   3. the list is complete, newest first, never carries the signature, and finds the reports that
//      name one employee (the HR card); the one-report read carries it
//   4. section 07, once: Mark reviewed stamps the PICKED reviewer and the org's day; a second is 409
//   5. files: only under the report's own folder, only ever more (a clash between two adds lands
//      both), never on a voided report, and hr-files refuses to delete one
//   6. VOID is the OWNER's alone, with a reason; the voided report stays in the list, and nothing
//      moves it after
//   7. LOCKED: no edit route, no delete route; no bell and nothing in the activity log
//
//   node app/scripts/test-hr-incidents-route.mjs
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
let handler = null;
let filesHandler = null;
let I = {};
try { handler = (await import('../api/hr-incidents/[...path].js')).default; } catch (e) { fails.push(`the route loads (${e.code || e.message})`); }
try { filesHandler = (await import('../api/hr-files/[...path].js')).default; } catch (e) { fails.push(`the hr-files route loads (${e.code || e.message})`); }
try { I = await import('../src/lib/hrIncidents.js'); } catch { fails.push('lib/hrIncidents.js loads'); }
const { INCIDENT_STATUS = {}, INCIDENT_TYPE = {}, ANSWER = {}, TREATMENT = {}, PERSON_KIND = {}, NOTIFIED = {}, DOC_KIND = {}, MAX_FILES = 40, incidentFileOwner = (id) => `incident-${id}` } = I;

// ── the world ───────────────────────────────────────────────────────────────
// 23:30 in New York on Oct 26 is Oct 27 in UTC: `reported_on` must be the ORG's day (Oct 26).
const TZ = 'America/New_York';
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },   // claim-less, as live
  mgr2: { id: 'u_mgr2', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crew2: { id: 'u_crew2', role: 'crew', claim: true },
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const NAMES = { owner: 'Olivia Owner', admin: 'Adam Admin', mgr: 'Mia Manager', mgr2: 'Max Manager', crew: 'Tomas Rivera', crew2: 'Rosa Diaz' };
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: 'active', name: NAMES[k], notificationPrefs: {},
}));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [
  `tok-${k}`,
  { id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {} },
]));
const CLIENTS = [
  { id: 'cl_1', name: 'Las Olas Tower', city: 'Fort Lauderdale', state: 'FL' },
  { id: 'cl_vendor', name: 'Sunshine Supply', type: 'vendor' },
  { id: 'cl_gone', name: 'Old Harbor Plaza', statusOverride: 'archived' },
];

let seq = 0;
function build() {
  const state = {
    users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
    clients: CLIENTS, company: { timezone: TZ }, notifications: [],
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 4 }],
      hr_incidents: [],
      activity_log: [], activity_log_baseline: [],
    },
    logins,
  });
  // The table's sequence (hr_incident_number_seq) and its unique (org, number).
  seq = 0;
  world.columnDefaults = { hr_incidents: { number: () => { seq += 1; return seq; } } };
  world.uniqueKeys = { hr_incidents: [(r) => `${r.organization_id}|${r.number}`] };
  return state;
}

async function call({ method = 'GET', path, token, body, query = {}, route = handler }) {
  if (!route) return { status: 0, body: {} };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 8000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        setHeader() { return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(route(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const tok = (w) => `tok-${w}`;
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 260)}`;
const SIG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(600, 'A')}`;
const pathFor = (id, name = 'a.jpg') => `${ORG}/hr/${incidentFileOwner(id)}/${name}`;
const fileFor = (id, extra = {}) => ({ kind: DOC_KIND.photos, name: 'wrist.jpg', mimeType: 'image/jpeg', sizeBytes: 2048, storagePath: pathFor(id, `${randomUUID()}.jpg`), ...extra });
const draft = (extra = {}) => ({
  id: randomUUID(),
  reportedByUserId: 'u_crew', reportedByName: 'typed over', reporterTitle: 'Crew',
  incidentDate: '2026-10-26', incidentTime: '21:40', clientId: 'cl_1', propertyName: 'typed over',
  exactLocation: 'Lobby, by the elevators', cityState: 'Fort Lauderdale, FL',
  types: [INCIDENT_TYPE.slip, INCIDENT_TYPE.injury], typeOther: '', whatHappened: 'Slipped on a wet floor.',
  people: [{ kind: PERSON_KIND.employee, userId: 'u_crew', name: 'typed over' }, { kind: PERSON_KIND.visitor, name: 'Jane Visitor' }],
  injured: ANSWER.yes, injuryDescription: 'Left wrist', treatment: TREATMENT.firstAid, treatmentProvider: 'On site',
  witnesses: ANSWER.yes, witnessNames: 'Rosa Diaz', witnessContact: '555-0101',
  police: ANSWER.no, policeDetails: '', notified: [NOTIFIED.hr, NOTIFIED.supervisor], notifiedOther: '',
  actionsTaken: 'Area secured, floor dried.', submittedByUserId: 'u_mgr2', submitterContact: '555-0100', signature: SIG,
  ...extra,
});
const file = (extra = {}, who = 'mgr') => {
  const body = draft(extra);
  return call({ method: 'POST', path: 'create', token: tok(who), body }).then((r) => ({ ...r, id: body.id }));
};
const row = (id) => (world.tables.hr_incidents || []).find((r) => r.id === id) || {};

// ── 1. the gates ────────────────────────────────────────────────────────────
console.log('\n── 1. gates ──');
{
  build();
  for (const [m, p] of [['GET', 'list'], ['POST', 'create']]) {
    const r = await call({ method: m, path: p, body: m === 'POST' ? draft() : undefined });
    ok(`anonymous ${m} ${p} → 401`, r.status === 401, show(r));
  }
  let r = await call({ path: 'list', token: tok('crew') });
  ok('a cleaner cannot read the list (403)', r.status === 403, show(r));
  r = await call({ path: 'list', token: tok('admin') });
  ok('an admin (no hr.view by default) cannot read the list (403)', r.status === 403, show(r));
  r = await call({ path: 'list', token: tok('mgr') });
  ok('a manager (claim-less) reads the list with hr.view', r.status === 200 && Array.isArray(r.body.incidents), show(r));
  r = await file({}, 'crew');
  ok('a cleaner cannot file (403)', r.status === 403, show(r));
  r = await file({}, 'admin');
  ok('an admin cannot file (403)', r.status === 403, show(r));
  ok('…and nothing was written', (world.tables.hr_incidents || []).length === 0);
  const made = await file();
  ok('a manager files a report', made.status === 200, show(made));
  r = await call({ path: made.id, token: tok('crew') });
  ok('🔴 a cleaner asking for a report that NAMES them gets 404, not 403', r.status === 404 && !r.body.incident, show(r));
  r = await call({ path: made.id, token: tok('admin') });
  ok('an admin asking for one gets 404 too', r.status === 404, show(r));
  r = await call({ path: randomUUID(), token: tok('mgr') });
  ok('a report that does not exist is 404', r.status === 404, show(r));
  r = await call({ path: 'nope', token: tok('mgr') });
  ok('an unknown route is 404', r.status === 404, show(r));
}

// ── 2. filing ───────────────────────────────────────────────────────────────
console.log('── 2. file ──');
let A = null;
{
  build();
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-27T03:30:00.000Z');   // 23:30 Oct 26 in New York
  let r;
  try { r = await file({ incidentDate: '2026-10-26' }); }
  finally { Date.now = realNow; }
  A = r.id;
  ok('a manager files a report', r.status === 200 && r.body.created === true, show(r));
  const inc = r.body.incident || {};
  ok('…awaiting review', inc.status === INCIDENT_STATUS.awaiting, inc.status);
  ok('…the case number from the database (IR-0001)', inc.number === 1, String(inc.number));
  ok('…"Date report completed" and "Date signed" are the ORG\'s day', inc.reportedOn === '2026-10-26' && inc.signedOn === '2026-10-26', `${inc.reportedOn} ${inc.signedOn}`);
  ok('…the reporter\'s name stamped from the roster, not the typed one', inc.reportedByName === 'Tomas Rivera' && inc.reportedByUserId === 'u_crew', inc.reportedByName);
  ok('…the property\'s name stamped from the customer', inc.propertyName === 'Las Olas Tower' && inc.clientId === 'cl_1', inc.propertyName);
  ok('…the employee involved by their roster name, the visitor as typed',
    JSON.stringify(inc.people) === JSON.stringify([{ kind: 'employee', userId: 'u_crew', name: 'Tomas Rivera' }, { kind: 'visitor', userId: null, name: 'Jane Visitor' }]), JSON.stringify(inc.people));
  ok('…the employees involved, for their HR card', JSON.stringify(inc.involvedUserIds) === '["u_crew"]', JSON.stringify(inc.involvedUserIds));
  ok('…the PICKED submitter (not the login)', inc.submittedByUserId === 'u_mgr2' && inc.submittedByName === 'Max Manager' && inc.filedByUserId === 'u_mgr', `${inc.submittedByUserId} ${inc.filedByUserId}`);
  ok('…the ticks in his order', JSON.stringify(inc.types) === '["injury","slip"]' && JSON.stringify(inc.notified) === '["supervisor","hr"]');
  ok('…every answer kept', inc.injuryDescription === 'Left wrist' && inc.treatment === TREATMENT.firstAid && inc.witnessNames === 'Rosa Diaz'
    && inc.exactLocation === 'Lobby, by the elevators' && inc.cityState === 'Fort Lauderdale, FL' && inc.incidentTime === '21:40'
    && inc.actionsTaken === 'Area secured, floor dried.' && inc.submitterContact === '555-0100' && inc.reporterTitle === 'Crew');
  ok('…the signature on file', inc.submitterSignature === SIG);
  r = await call({ method: 'POST', path: 'create', token: tok('mgr'), body: { ...draft(), id: A } });
  ok('a retried id is a no-op (created: false, still one report)', r.status === 200 && r.body.created === false && world.tables.hr_incidents.length === 1, show(r));

  r = await file({ reportedByUserId: '', reportedByName: 'A passer-by', clientId: '', propertyName: 'NE 2nd Ave, by the bus stop', people: [] });
  ok('someone not on the team, somewhere else (Matt: "in the streets")', r.status === 200 && r.body.incident.reportedByName === 'A passer-by'
    && r.body.incident.reportedByUserId === null && r.body.incident.propertyName === 'NE 2nd Ave, by the bus stop' && r.body.incident.clientId === null, show(r));
  ok('…and it is IR-0002', r.body.incident && r.body.incident.number === 2);
  r = await file({ injured: ANSWER.no, witnesses: ANSWER.unknown, police: ANSWER.no, policeDetails: 'left over' });
  ok('injured No keeps no injury or treatment; witnesses Unknown keeps no names', r.status === 200 && r.body.incident.injuryDescription === null
    && r.body.incident.treatment === null && r.body.incident.treatmentProvider === null && r.body.incident.witnessNames === null && r.body.incident.policeDetails === null, show(r));

  const before = world.tables.hr_incidents.length;
  const refusals = [
    ['a person named as an employee who is not on the team', { people: [{ kind: PERSON_KIND.employee, userId: 'u_ghost' }] }, 'person-bad'],
    ['a reporter not on the team', { reportedByUserId: 'u_ghost' }, 'reporter-missing'],
    ['a customer not on file', { clientId: 'cl_ghost' }, 'property-missing'],
    ['a supplier as the property (the form never offers one)', { clientId: 'cl_vendor' }, 'property-missing'],
    ['an archived customer as the property', { clientId: 'cl_gone' }, 'property-missing'],
    ['a cleaner as the submitter (an office member signs)', { submittedByUserId: 'u_crew' }, 'submitter-missing'],
    ['no signature', { signature: '' }, 'signature-missing'],
    ['an incident in the future', { incidentDate: '2027-01-01' }, 'incident-date-in-future'],
    ['no type ticked', { types: [] }, 'types-missing'],
    ['injured Yes with no injury', { injuryDescription: '' }, 'injury-missing'],
    ['Other with no words', { types: [INCIDENT_TYPE.other] }, 'type-other-missing'],
    ['a file outside the report\'s folder', { files: [fileFor(randomUUID())] }, 'file-bad'],
    ['a file climbing out of its folder', { files: [{ ...fileFor(randomUUID()), storagePath: `${ORG}/hr/incident-x/../u_crew/a.jpg` }] }, 'file-bad'],
    ['a file with no place in the bucket', { files: [{ kind: DOC_KIND.photos, name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1, fileId: 'hrf_1' }] }, 'file-bad'],
  ];
  for (const [what, extra, code] of refusals) {
    const res = await file(extra);
    ok(`refused: ${what} (400 ${code})`, res.status === 400 && res.body.code === code, show(res));
  }
  ok('…and none of them was written', world.tables.hr_incidents.length === before);
  r = await call({ method: 'POST', path: 'create', token: tok('mgr'), body: { ...draft(), id: 'not-a-uuid' } });
  ok('a report needs a caller-minted uuid', r.status === 400, show(r));
  const id = randomUUID();
  r = await call({ method: 'POST', path: 'create', token: tok('mgr'), body: draft({ id, files: [fileFor(id), fileFor(id, { kind: DOC_KIND.policeReport, name: 'police.pdf', mimeType: 'application/pdf' })] }) });
  ok('files picked on the form go on with the report, under its own folder', r.status === 200 && r.body.incident.files.length === 2
    && r.body.incident.files.every((f) => f.storagePath.startsWith(`${ORG}/hr/incident-${id}/`) && f.addedByUserId === 'u_mgr' && f.id), show(r));

  // 🔴 His whole form, every box ticked and every question answered: each answer comes back as given.
  const fullId = randomUUID();
  const full = draft({
    id: fullId, types: [...(I.INCIDENT_TYPES || [])], typeOther: 'Chemical spill',
    police: ANSWER.yes, policeDetails: 'FLPD, report 24-1031, Officer Diaz',
    notified: [...(I.NOTIFIED_LIST || [])], notifiedOther: 'Building engineer',
    files: [fileFor(fullId), fileFor(fullId, { kind: DOC_KIND.witnessStatement, name: 's.pdf', mimeType: 'application/pdf' }),
      fileFor(fullId, { kind: DOC_KIND.policeReport, name: 'p.pdf', mimeType: 'application/pdf' }), fileFor(fullId, { kind: DOC_KIND.other, name: 'o.pdf', mimeType: 'application/pdf' })],
  });
  r = await call({ method: 'POST', path: 'create', token: tok('mgr'), body: full });
  const g = r.body.incident || {};
  const asGiven = ['reporterTitle', 'incidentDate', 'incidentTime', 'exactLocation', 'cityState', 'types', 'typeOther', 'whatHappened',
    'injured', 'injuryDescription', 'treatment', 'treatmentProvider', 'witnesses', 'witnessNames', 'witnessContact', 'police',
    'policeDetails', 'notified', 'notifiedOther', 'actionsTaken', 'submitterContact'];
  const wrong = asGiven.filter((k) => JSON.stringify(g[k]) !== JSON.stringify(full[k]));
  ok(`🔴 every answer on his form is stored as given${wrong.length ? ` (not: ${wrong.join(', ')})` : ''}`, r.status === 200 && wrong.length === 0, show(r));
  ok('…all four kinds of his documentation, each on file', JSON.stringify((g.files || []).map((f) => f.kind)) === JSON.stringify(full.files.map((f) => f.kind)), JSON.stringify(g.files));
  ok('…and the row holds them in its columns', row(fullId).type_other === 'Chemical spill' && row(fullId).notified_other === 'Building engineer'
    && row(fullId).police_details === full.policeDetails && row(fullId).witness_contact === full.witnessContact && row(fullId).what_happened === full.whatHappened);
}

// ── 3. the list ─────────────────────────────────────────────────────────────
console.log('── 3. list ──');
{
  let r = await call({ path: 'list', token: tok('mgr') });
  const list = r.body.incidents || [];
  ok('the list holds every report', r.status === 200 && list.length === world.tables.hr_incidents.length, show(r));
  ok('🔴 the list never carries a signature', list.every((x) => !('submitterSignature' in x)) && !JSON.stringify(list).includes('base64'));
  ok('the list answers its reports alone (no unused second read of the shared record)', Object.keys(r.body).join() === 'incidents', Object.keys(r.body).join());
  r = await call({ path: 'list', token: tok('mgr'), query: { employeeId: 'u_crew' } });
  const mine = r.body.incidents || [];
  ok('the HR card\'s read: only the reports naming that employee', mine.length > 0 && mine.every((x) => x.involvedUserIds.includes('u_crew'))
    && mine.length === world.tables.hr_incidents.filter((x) => x.involved_user_ids.includes('u_crew')).length, show(r));
  r = await call({ path: 'list', token: tok('mgr'), query: { employeeId: 'u_crew2' } });
  ok('…and nothing for someone named in none (a witness is not "involved")', r.status === 200 && r.body.incidents.length === 0, show(r));
  r = await call({ path: A, token: tok('mgr') });
  ok('the one-report read carries the signature', r.status === 200 && r.body.incident.submitterSignature === SIG, show(r));
}

// ── 4. section 07: Mark reviewed, once ──────────────────────────────────────
console.log('── 4. review ──');
{
  let r = await call({ method: 'POST', path: `${A}/review`, token: tok('crew'), body: { reviewerUserId: 'u_mgr' } });
  ok('a cleaner cannot mark one reviewed (403)', r.status === 403, show(r));
  r = await call({ method: 'POST', path: `${A}/review`, token: tok('mgr'), body: { reviewerUserId: 'u_crew' } });
  ok('the reviewer must be an office member (400 reviewer-missing)', r.status === 400 && r.body.code === 'reviewer-missing', show(r));
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-28T03:30:00.000Z');   // 23:30 Oct 27 in New York
  try { r = await call({ method: 'POST', path: `${A}/review`, token: tok('mgr'), body: { reviewerUserId: 'u_mgr2' } }); }
  finally { Date.now = realNow; }
  ok('a manager marks it reviewed, naming who reviewed it', r.status === 200 && r.body.incident.status === INCIDENT_STATUS.reviewed
    && r.body.incident.reviewedByName === 'Max Manager' && r.body.incident.reviewedByUserId === 'u_mgr2', show(r));
  ok('…"Date received" is the org\'s day', r.body.incident && r.body.incident.receivedOn === '2026-10-27', r.body.incident && r.body.incident.receivedOn);
  r = await call({ method: 'POST', path: `${A}/review`, token: tok('mgr'), body: { reviewerUserId: 'u_mgr' } });
  ok('🔴 a second Mark reviewed is 409, and the first stands', r.status === 409 && row(A).reviewed_by_user_id === 'u_mgr2', show(r));
}

// ── 5. files: only ever more ────────────────────────────────────────────────
console.log('── 5. files ──');
{
  const had = row(A).files.length;
  let r = await call({ method: 'POST', path: `${A}/files`, token: tok('crew'), body: { files: [fileFor(A)] } });
  ok('a cleaner cannot add files (403)', r.status === 403, show(r));
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [fileFor(A, { kind: DOC_KIND.witnessStatement, name: 'statement.pdf', mimeType: 'application/pdf' })] } });
  ok('files are added to a REVIEWED report', r.status === 200 && r.body.incident.files.length === had + 1, show(r));
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [fileFor(randomUUID())] } });
  ok('a file from another report\'s folder is refused', r.status === 400 && r.body.code === 'file-bad', show(r));
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [] } });
  ok('no files is refused (files-missing)', r.status === 400 && r.body.code === 'files-missing', show(r));
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: Array.from({ length: MAX_FILES }, () => fileFor(A)) } });
  ok(`more than ${MAX_FILES} on one report is refused`, r.status === 400 && r.body.code === 'files-too-many', show(r));

  // Two people adding at once: the second write finds the version moved, reads again, and lands.
  const before = row(A).files.length;
  let raced = false;
  world.beforeQuery = async (q) => {
    if (!raced && q.table === 'hr_incidents' && q.op === 'update') {
      raced = true;
      const cur = row(A);
      cur.files = [...cur.files, { id: 'irf_other', kind: DOC_KIND.photos, name: 'other.jpg', mimeType: 'image/jpeg', sizeBytes: 9, storagePath: pathFor(A, 'other.jpg'), fileId: null, addedAt: new Date().toISOString(), addedByUserId: 'u_mgr2' }];
      cur.version += 1;
    }
  };
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [fileFor(A, { name: 'mine.jpg' })] } });
  world.beforeQuery = null;
  const names = row(A).files.map((f) => f.name);
  ok('🔴 two adds at once both land (none lost to the other)', r.status === 200 && raced && row(A).files.length === before + 2
    && names.includes('other.jpg') && names.includes('mine.jpg'), `${show(r)} ${names.join(',')}`);

  // A retried add whose first try landed (its answer lost) attaches nothing twice.
  const again = fileFor(A, { name: 'retried.jpg' });
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [again] } });
  const once = row(A).files.length;
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [again] } });
  ok('🔴 the same file sent again is not attached twice (200, still once)', r.status === 200 && row(A).files.length === once
    && row(A).files.filter((f) => f.storagePath === again.storagePath).length === 1, show(r));
  ok('…the files answer never carries the signature', r.body.incident && !('submitterSignature' in r.body.incident), show(r));
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [again, again, fileFor(A, { name: 'new.jpg' })] } });
  ok('…and a list naming one twice adds only what is new', r.status === 200 && row(A).files.length === once + 1, show(r));

  const f0 = row(A).files[0];
  r = await call({ route: filesHandler, method: 'POST', path: 'delete', token: tok('owner'), body: { ownerId: incidentFileOwner(A), storagePath: f0.storagePath } });
  ok('🔴 hr-files refuses to delete a file on an incident report, even for the Super Admin (403)', r.status === 403, show(r));
  r = await call({ route: filesHandler, method: 'POST', path: 'delete', token: tok('mgr'), body: { ownerId: incidentFileOwner(A), storagePath: f0.storagePath } });
  ok('…and for a manager', r.status === 403, show(r));
  r = await call({ route: filesHandler, method: 'POST', path: 'upload-url', token: tok('mgr'), body: { ownerId: incidentFileOwner(A), mimeType: 'image/jpeg', sizeBytes: 100 } });
  ok('a file can be uploaded into a report\'s own folder', r.status === 200 && typeof r.body.path === 'string' && r.body.path.startsWith(`${ORG}/hr/incident-${A}/`), show(r));
  // An upload the report never took (a cancelled form, a row taken off) is not stranded.
  const stray = r.body.path;
  r = await call({ route: filesHandler, method: 'POST', path: 'delete', token: tok('mgr'), body: { ownerId: incidentFileOwner(A), storagePath: stray } });
  ok('an upload no report holds can be removed', r.status === 200 && world.storage.some((x) => x.op === 'remove' && x.path === stray), show(r));
  ok('…while every file the report holds is still there', !world.storage.some((x) => x.op === 'remove' && row(A).files.some((f) => f.storagePath === x.path)));
  const ghost = randomUUID();
  r = await call({ route: filesHandler, method: 'POST', path: 'delete', token: tok('mgr'), body: { ownerId: incidentFileOwner(ghost), storagePath: pathFor(ghost, 'left.jpg') } });
  ok('…an upload for a report never filed can be removed too', r.status === 200, show(r));
  r = await call({ route: filesHandler, method: 'POST', path: 'download-url', token: tok('admin'), body: { ownerId: incidentFileOwner(A), storagePath: f0.storagePath } });
  ok('🔴 an admin (no HR permission) cannot download an incident\'s file by role (403)', r.status === 403, show(r));
  r = await call({ route: filesHandler, method: 'POST', path: 'upload-url', token: tok('admin'), body: { ownerId: incidentFileOwner(A), mimeType: 'image/jpeg', sizeBytes: 100 } });
  ok('…nor upload into its folder', r.status === 403, show(r));
  r = await call({ route: filesHandler, method: 'POST', path: 'download-url', token: tok('mgr'), body: { ownerId: incidentFileOwner(A), storagePath: f0.storagePath } });
  ok('a manager (hr.view) downloads it', r.status === 200 && typeof r.body.url === 'string', show(r));
  r = await call({ route: filesHandler, method: 'POST', path: 'upload-url', token: tok('mgr'), body: { ownerId: 'incident-not-a-uuid', mimeType: 'image/jpeg', sizeBytes: 100 } });
  ok('an incident folder that names no report is refused (400)', r.status === 400, show(r));
}

// ── 6. void: the owner's alone ──────────────────────────────────────────────
console.log('── 6. void ──');
{
  let r = await call({ method: 'POST', path: `${A}/void`, token: tok('mgr'), body: { reason: 'Filed twice' } });
  ok('a manager cannot void (403)', r.status === 403 && row(A).status === INCIDENT_STATUS.reviewed, show(r));
  r = await call({ method: 'POST', path: `${A}/void`, token: tok('owner'), body: { reason: '  ' } });
  ok('a void needs a reason (400 void-reason-missing)', r.status === 400 && r.body.code === 'void-reason-missing', show(r));
  r = await call({ method: 'POST', path: `${A}/void`, token: tok('owner'), body: { reason: 'Filed twice' } });
  ok('the Super Admin voids it, saying why', r.status === 200 && r.body.incident.status === INCIDENT_STATUS.voided
    && r.body.incident.voidReason === 'Filed twice' && r.body.incident.voidedByName === 'Olivia Owner', show(r));
  ok('…the review stays on it', row(A).reviewed_by_user_id === 'u_mgr2' && row(A).received_on === '2026-10-27');
  r = await call({ method: 'POST', path: `${A}/void`, token: tok('owner'), body: { reason: 'again' } });
  ok('a second void is 409', r.status === 409 && row(A).void_reason === 'Filed twice', show(r));
  r = await call({ method: 'POST', path: `${A}/files`, token: tok('mgr'), body: { files: [fileFor(A)] } });
  ok('🔴 no files go on a voided report (409)', r.status === 409, show(r));
  r = await call({ route: filesHandler, method: 'POST', path: 'upload-url', token: tok('mgr'), body: { ownerId: incidentFileOwner(A), mimeType: 'image/jpeg', sizeBytes: 100 } });
  ok('…and nothing can even be uploaded into its folder (409)', r.status === 409 && r.body.code === 'already-closed', show(r));
  const other = (world.tables.hr_incidents || []).find((x) => x.id !== A && x.status === INCIDENT_STATUS.awaiting);
  r = await call({ method: 'POST', path: `${other.id}/void`, token: tok('owner'), body: { reason: 'Test' } });
  ok('an awaiting report can be voided too', r.status === 200 && row(other.id).status === INCIDENT_STATUS.voided, show(r));
  r = await call({ method: 'POST', path: `${other.id}/review`, token: tok('mgr'), body: { reviewerUserId: 'u_mgr' } });
  ok('…and then never marked reviewed (409)', r.status === 409, show(r));
  r = await call({ path: 'list', token: tok('mgr') });
  ok('a voided report stays in the list', (r.body.incidents || []).some((x) => x.id === A && x.status === INCIDENT_STATUS.voided), show(r));
}

// ── 7. locked; no bells; not in the activity log ────────────────────────────
console.log('── 7. locked ──');
{
  const before = JSON.stringify(row(A));
  for (const p of ['edit', 'update', 'delete']) {
    const r = await call({ method: 'POST', path: `${A}/${p}`, token: tok('owner'), body: { whatHappened: 'changed' } });
    ok(`there is no ${p} route (404)`, r.status === 404, show(r));
  }
  let r = await call({ method: 'DELETE', path: A, token: tok('owner') });
  ok('DELETE is not a method here (405)', r.status === 405, show(r));
  r = await call({ method: 'PATCH', path: A, token: tok('owner'), body: { whatHappened: 'changed' } });
  ok('PATCH is not a method here (405)', r.status === 405, show(r));
  ok('…and the report is exactly as it was', JSON.stringify(row(A)) === before);
  ok('no bell was rung for any of it (Daniel\'s pick: no alerts)', (world.tables.org_state[0].state.notifications || []).length === 0);
  ok('nothing went into the activity log', (world.tables.activity_log || []).length === 0);
}

console.log(`\ntest-hr-incidents-route: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exitCode = 1;
