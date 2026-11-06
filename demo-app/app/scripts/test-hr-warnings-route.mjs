// /api/hr-warnings/[...path] + the HR-5 reminder on the ops-alert cron, driven END TO END
// through the REAL handlers against fake-supabase.mjs (no network, no credentials, no live
// project — BUILD_INTEGRITY §6b). Matt's HR-1..HR-5, 2026-10-05.
//
// What it proves, in the order it matters:
//   1. the gates: anonymous → 401; the office reads with hr.view and issues with hr.edit;
//      an admin (no hr.* by default) and a cleaner are refused the office branches
//   2. 🔴 A CLEANER READS AND SIGNS ONLY THEIR OWN WARNINGS — the id from the CLAIM; anyone
//      else's answers 404, so they cannot even learn a colleague has one
//   3. issuing: names stamped from the committed roster, the supervisor PICKED (not the
//      login), the org's day as `issued_on`, a retried id is a no-op, the employee's bell
//      (skipped when the signature is about to be taken in person), and Matt's own form
//      (HR-1 b): several reasons stored as a list, "Other" with its words, the previous
//      discipline meeting date, and the form's refusals; nothing about a building, an
//      incident date or a consequence is accepted or stored any more
//   4. LOCKED ONCE ISSUED: no edit route, no delete route, and every move is conditional —
//      a second signature, a refusal after a signature and a second void are all 409
//   5. HR-3: refused → the picked HR manager's name and signature go on file
//   6. VOID is the OWNER's alone; the voided warning stays in the list
//   7. the list never carries signatures; the one-warning read does
//   8. Translate: the employee's own warning only, off until the key is set, never stored
//   9. HR-5 on the cron: a day-old unsigned warning reminds the supervisor AND nudges the
//      employee, once — stamped after the bell lands — and stays out of the activity log
//
//   node app/scripts/test-hr-warnings-route.mjs
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
delete process.env.GOOGLE_TRANSLATE_API_KEY;
const blockedFetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };
globalThis.fetch = blockedFetch;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { dayKey } = await import('../src/lib/dates.js');
let handler = null;
let cron = null;
let W = {};
let R = {};
try { handler = (await import('../api/hr-warnings/[...path].js')).default; } catch (e) { fails.push(`the route loads (${e.code || e.message})`); }
try { cron = await import('../api/cron/ops-alerts.js'); } catch (e) { fails.push(`the cron loads (${e.message})`); }
try { W = await import('../src/lib/hrWarnings.js'); } catch { fails.push('lib/hrWarnings.js loads'); }
try { R = await import('../src/lib/hrWarningReminders.js'); } catch { fails.push('lib/hrWarningReminders.js loads'); }
const { WARNING_STATUS = {}, WARNING_LEVEL = {}, WARNING_REASON = {}, WARNING_REMINDER_HOURS = 24 } = W;
const { HR_WARNING_SIGN_EVENT, HR_WARNING_UNSIGNED_EVENT, warningSignUrl, warningOfficeUrl } = R;

// ── the world ───────────────────────────────────────────────────────────────
// 23:30 in New York on Oct 5 is Oct 6 in UTC: `issued_on` must be the ORG's day (Oct 5).
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
const CLIENTS = [{ id: 'cl_1', name: 'Ball Harbor Village', supervisorId: 'u_mgr' }];

function build() {
  const state = {
    users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
    clients: CLIENTS, company: { timezone: TZ },
    notifications: [], opsAlertEvents: [], opsSettings: {}, invoices: [], supplyRequests: [],
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 4 }],
      hr_warnings: [],
      activity_log: [], activity_log_baseline: [],
    },
    logins,
  });
  return state;
}

async function call({ method = 'GET', path, token, body, query = {} }) {
  // The pre-change tree has no route: every call reports as failed rather than throwing.
  if (!handler) return { status: 0, body: {} };
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
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const tok = (w) => `tok-${w}`;
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`;
const SIG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(600, 'A')}`;
const draft = (extra = {}) => ({
  id: randomUUID(), employeeUserId: 'u_crew', supervisorUserId: 'u_mgr2',
  level: WARNING_LEVEL.first, reasons: [WARNING_REASON.tardiness, WARNING_REASON.procedure], reasonOther: '',
  previousMeetingDate: '2026-06-02', whatHappened: 'Arrived 45 minutes late.', whatMustChange: 'Arrive on time.', ...extra,
});
const issue = (extra = {}, who = 'mgr') => call({ method: 'POST', path: 'create', token: tok(who), body: draft(extra) });
const row = (id) => (world.tables.hr_warnings || []).find((r) => r.id === id) || {};
const bells = () => world.tables.org_state[0].state.notifications || [];

// ── 1. the gates ────────────────────────────────────────────────────────────
console.log('\n── 1. gates ──');
{
  build();
  for (const [m, p] of [['GET', 'list'], ['GET', 'mine'], ['POST', 'create']]) {
    const r = await call({ method: m, path: p, body: m === 'POST' ? draft() : undefined });
    ok(`anonymous ${m} ${p} → 401`, r.status === 401, show(r));
  }
  let r = await call({ path: 'list', token: tok('crew') });
  ok('a cleaner cannot read the list (403)', r.status === 403, show(r));
  r = await call({ path: 'list', token: tok('admin') });
  ok('an admin (no hr.view by default) cannot read the list (403)', r.status === 403, show(r));
  r = await call({ path: 'list', token: tok('mgr') });
  ok('a manager (claim-less) reads the list with hr.view', r.status === 200 && Array.isArray(r.body.warnings), show(r));
  r = await issue({}, 'crew');
  ok('a cleaner cannot issue (403)', r.status === 403, show(r));
  r = await issue({}, 'admin');
  ok('an admin cannot issue (403)', r.status === 403, show(r));
  ok('…and nothing was written', (world.tables.hr_warnings || []).length === 0);
}

// ── 3. issuing ──────────────────────────────────────────────────────────────
console.log('── 3. issue ──');
let A = null;   // u_crew's warning
{
  build();
  // 23:30 New York — already the next day in UTC.
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-06T03:30:00.000Z');
  const body = draft();
  let r;
  try { r = await call({ method: 'POST', path: 'create', token: tok('mgr'), body }); }
  finally { Date.now = realNow; }
  A = body.id;
  ok('a manager issues a warning', r.status === 200 && r.body.created === true, show(r));
  const w = r.body.warning || {};
  ok('…awaiting the signature', w.status === WARNING_STATUS.awaiting, w.status);
  ok('…names stamped from the roster (employee, PICKED supervisor)',
    w.employeeName === 'Tomas Rivera' && w.supervisorName === 'Max Manager',
    JSON.stringify([w.employeeName, w.supervisorName]));
  ok('HR-1 (b): the ticked reasons are stored as a LIST, in the form\'s order',
    Array.isArray(row(A).reasons) && row(A).reasons.join() === [WARNING_REASON.procedure, WARNING_REASON.tardiness].join()
    && (w.reasons || []).join() === row(A).reasons.join(), JSON.stringify(row(A).reasons));
  ok('…the previous discipline meeting date is stored as a day', row(A).previous_meeting_date === '2026-06-02' && w.previousMeetingDate === '2026-06-02');
  ok('…and no building, incident date, consequence or single reason is written',
    !['client_id', 'client_name', 'incident_date', 'consequence', 'reason'].some((c) => c in row(A))
    && !['clientId', 'clientName', 'incidentDate', 'consequence', 'reason'].some((c) => c in w), JSON.stringify(Object.keys(row(A))));
  ok('…the supervisor is the one picked, the login is only the issuer',
    w.supervisorUserId === 'u_mgr2' && w.issuedByUserId === 'u_mgr', `${w.supervisorUserId} / ${w.issuedByUserId}`);
  ok("…issued_on is the ORG's day (Oct 5 in New York), not UTC's", w.issuedOn === '2026-10-05', w.issuedOn);
  const bell = bells().find((n) => n.userId === 'u_crew');
  ok('…the employee gets a bell row', !!bell, JSON.stringify(bells()));
  ok('…under the sign event, deep-linked to their own warning',
    !!bell && bell.eventKey === HR_WARNING_SIGN_EVENT && bell.url === warningSignUrl(A), JSON.stringify(bell));
  ok('…and nobody else is told', bells().every((n) => n.userId === 'u_crew'), JSON.stringify(bells().map((n) => n.userId)));

  r = await call({ method: 'POST', path: 'create', token: tok('mgr'), body });
  ok('a retried issue (same caller-minted id) is a no-op', r.status === 200 && r.body.created === false
    && world.tables.hr_warnings.length === 1, show(r));
  ok('…and rings nobody twice', bells().filter((n) => n.userId === 'u_crew').length === 1);

  r = await issue({ notifyEmployee: false });
  ok('issued for an in-person signature: no bell', r.status === 200 && bells().filter((n) => n.userId === 'u_crew').length === 1, show(r));

  r = await issue({ reasons: [WARNING_REASON.other], reasonOther: '' });
  ok('HR-1: "Other" with no words → 400 reason-other-missing', r.status === 400 && r.body.code === 'reason-other-missing', show(r));
  r = await issue({ reasons: [] });
  ok('no reason ticked → 400 reasons-missing', r.status === 400 && r.body.code === 'reasons-missing', show(r));
  r = await issue({ reasons: [WARNING_REASON.fighting, 'gossip'] });
  ok('a reason not on the form → 400 reason-bad', r.status === 400 && r.body.code === 'reason-bad', show(r));
  r = await issue({ previousMeetingDate: '2099-01-01' });
  ok('a previous meeting in the future → 400', r.status === 400 && r.body.code === 'previous-date-in-future', show(r));
  {
    const id = randomUUID();
    r = await issue({ id, reasons: [WARNING_REASON.rudeness, WARNING_REASON.other], reasonOther: '  Phone use on site  ', previousMeetingDate: '' });
    ok('"Other" stores its words; an empty previous meeting stores nothing',
      r.status === 200 && row(id).reason_other === 'Phone use on site' && row(id).previous_meeting_date === null, show(r));
    const id2 = randomUUID();
    r = await issue({ id: id2, reasons: [WARNING_REASON.rudeness], reasonOther: 'left over from an untick' });
    ok('words for "Other" are dropped when "Other" is not ticked', r.status === 200 && row(id2).reason_other === null, show(r));
    const id3 = randomUUID();
    r = await issue({ id: id3, reasons: [WARNING_REASON.language, WARNING_REASON.absenteeism] });
    ok('reasons are stored in the FORM\'s order, whatever order they were ticked in',
      r.status === 200 && (row(id3).reasons || []).join() === [WARNING_REASON.absenteeism, WARNING_REASON.language].join(), JSON.stringify(row(id3).reasons));
  }
  r = await issue({ supervisorUserId: 'u_crew2' });
  ok('a cleaner cannot be the supervisor → 400', r.status === 400 && r.body.code === 'supervisor-missing', show(r));
  r = await issue({ employeeUserId: 'u_nobody' });
  ok('an employee not on the team → 400', r.status === 400 && r.body.code === 'employee-missing', show(r));
  r = await issue({ level: 'final' });
  ok('an unknown level → 400 level-bad', r.status === 400 && r.body.code === 'level-bad', show(r));
  r = await issue({ id: 'not-a-uuid' });
  ok('an id that is not a caller-minted uuid → 400', r.status === 400, show(r));
}

// ── 2. a cleaner sees only their own ────────────────────────────────────────
console.log('── 2. own-only ──');
let B = null;   // u_crew2's warning
{
  const r1 = await issue({ employeeUserId: 'u_crew2' });
  B = r1.body.warning?.id;
  let r = await call({ path: 'mine', token: tok('crew') });
  ok('a cleaner\'s "mine" holds only their own warnings',
    r.status === 200 && (r.body.warnings || []).length >= 1 && r.body.warnings.every((w) => w.employeeUserId === 'u_crew'), show(r));
  ok('…and not the colleague\'s', !(r.body.warnings || []).some((w) => w.id === B));
  r = await call({ path: B, token: tok('crew') });
  ok("🔴 a colleague's warning by id → 404 (not even its existence)", r.status === 404, show(r));
  r = await call({ path: A, token: tok('crew') });
  ok('their own by id → 200', r.status === 200 && r.body.warning?.id === A, show(r));
  r = await call({ path: 'mine', token: tok('crew'), query: { employeeId: 'u_crew2' } });
  ok('"mine" ignores a query naming someone else', r.status === 200 && (r.body.warnings || []).every((w) => w.employeeUserId === 'u_crew'), show(r));
  r = await call({ path: A, token: tok('admin') });
  ok('an admin without hr.view cannot open one by id (404)', r.status === 404, show(r));
}

// ── acknowledge ─────────────────────────────────────────────────────────────
console.log('── acknowledge ──');
{
  let r = await call({ method: 'POST', path: `${B}/acknowledge`, token: tok('crew'), body: { signature: SIG } });
  ok("a cleaner cannot sign a colleague's warning (404)", r.status === 404 && row(B).status === WARNING_STATUS.awaiting, show(r));
  r = await call({ method: 'POST', path: `${A}/acknowledge`, token: tok('crew'), body: { signature: 'data:image/svg+xml;base64,PHN2Zz4=' } });
  ok('a signature that is not a PNG → 400 signature-bad', r.status === 400 && r.body.code === 'signature-bad', show(r));
  r = await call({ method: 'POST', path: `${A}/acknowledge`, token: tok('crew'), body: { signature: SIG, comment: 'I was stuck in traffic.' } });
  ok('the employee signs their own on their phone', r.status === 200 && r.body.warning?.status === WARNING_STATUS.acknowledged, show(r));
  ok('…not in person, with their comment and the time',
    row(A).signed_in_person === false && row(A).employee_comment === 'I was stuck in traffic.' && !!row(A).employee_signed_at,
    JSON.stringify(row(A)).slice(0, 200));
  r = await call({ method: 'POST', path: `${A}/acknowledge`, token: tok('crew'), body: { signature: SIG } });
  ok('signing twice → 409 (the move is conditional)', r.status === 409, show(r));

  r = await call({ method: 'POST', path: `${B}/acknowledge`, token: tok('admin'), body: { signature: SIG } });
  ok('an admin (no hr.edit) cannot take a signature in person (404)', r.status === 404, show(r));
  r = await call({ method: 'POST', path: `${B}/acknowledge`, token: tok('mgr'), body: { signature: SIG } });
  ok('a manager takes the signature IN PERSON', r.status === 200 && row(B).signed_in_person === true && row(B).status === WARNING_STATUS.acknowledged, show(r));

  r = await call({ path: 'list', token: tok('mgr') });
  ok('🔴 the list never carries signatures',
    r.status === 200 && (r.body.warnings || []).length > 0 && r.body.warnings.every((w) => !('employeeSignature' in w) && !('hrManagerSignature' in w)),
    JSON.stringify(Object.keys((r.body.warnings || [])[0] || {})));
  r = await call({ path: A, token: tok('mgr') });
  ok('…the one-warning read does', r.status === 200 && r.body.warning?.employeeSignature === SIG, show(r));
}

// ── 5. HR-3: refused ────────────────────────────────────────────────────────
console.log('── 5. refused ──');
let C = null;
{
  C = (await issue()).body.warning?.id;
  let r = await call({ method: 'POST', path: `${C}/refuse`, token: tok('crew'), body: { hrManagerUserId: 'u_owner', signature: SIG } });
  ok('a cleaner cannot mark refused (403)', r.status === 403, show(r));
  r = await call({ method: 'POST', path: `${C}/refuse`, token: tok('mgr'), body: { hrManagerUserId: 'u_crew2', signature: SIG } });
  ok('the HR manager must be an active office member → 400', r.status === 400 && r.body.code === 'hr-manager-missing', show(r));
  r = await call({ method: 'POST', path: `${C}/refuse`, token: tok('mgr'), body: { hrManagerUserId: 'u_owner', signature: '' } });
  ok('…and must sign → 400 signature-missing', r.status === 400 && r.body.code === 'signature-missing', show(r));
  r = await call({ method: 'POST', path: `${C}/refuse`, token: tok('mgr'), body: { hrManagerUserId: 'u_owner', signature: SIG } });
  ok('HR-3: refused → on file as refused', r.status === 200 && row(C).status === WARNING_STATUS.refused, show(r));
  ok("…with the PICKED HR manager's name, signature and time",
    row(C).hr_manager_name === 'Olivia Owner' && row(C).hr_manager_signature === SIG && !!row(C).hr_manager_signed_at && !!row(C).refused_at);
  r = await call({ method: 'POST', path: `${A}/refuse`, token: tok('mgr'), body: { hrManagerUserId: 'u_owner', signature: SIG } });
  ok('a signed warning cannot then be marked refused (409)', r.status === 409 && row(A).status === WARNING_STATUS.acknowledged, show(r));
}

// ── 6. void (owner only) and 4. locked ──────────────────────────────────────
console.log('── 6. void · 4. locked ──');
{
  let r = await call({ method: 'POST', path: `${C}/void`, token: tok('mgr'), body: { reason: 'Wrong person' } });
  ok('a manager cannot void (403)', r.status === 403 && row(C).status === WARNING_STATUS.refused, show(r));
  r = await call({ method: 'POST', path: `${C}/void`, token: tok('owner'), body: { reason: '  ' } });
  ok('the owner must say why → 400 void-reason-missing', r.status === 400 && r.body.code === 'void-reason-missing', show(r));
  r = await call({ method: 'POST', path: `${C}/void`, token: tok('owner'), body: { reason: 'Issued to the wrong employee.' } });
  ok('the owner voids it', r.status === 200 && row(C).status === WARNING_STATUS.voided, show(r));
  ok('…stamping who and why, and KEEPING the refusal on file',
    row(C).voided_by_name === 'Olivia Owner' && row(C).void_reason === 'Issued to the wrong employee.' && row(C).hr_manager_signature === SIG);
  r = await call({ path: 'list', token: tok('mgr') });
  ok('…and it stays in the list', (r.body.warnings || []).some((w) => w.id === C && w.status === WARNING_STATUS.voided), show(r));
  r = await call({ method: 'POST', path: `${C}/void`, token: tok('owner'), body: { reason: 'again' } });
  ok('voiding twice → 409', r.status === 409, show(r));

  const before = world.tables.hr_warnings.length;
  for (const p of ['save', 'delete', 'edit']) {
    r = await call({ method: 'POST', path: `${A}/${p}`, token: tok('owner'), body: { whatHappened: 'changed' } });
    ok(`LOCKED: there is no "${p}" route (404)`, r.status === 404, show(r));
  }
  ok('…nothing was removed or changed', world.tables.hr_warnings.length === before && row(A).what_happened === 'Arrived 45 minutes late.');
}

// ── 8. Translate ────────────────────────────────────────────────────────────
console.log('── 8. translate ──');
{
  let r = await call({ method: 'POST', path: `${A}/translate`, token: tok('crew'), body: { lang: 'es' } });
  ok('with no key set → 503 machine-translation-off', r.status === 503 && r.body.code === 'machine-translation-off', show(r));
  r = await call({ method: 'POST', path: `${B}/translate`, token: tok('crew'), body: { lang: 'es' } });
  ok("a colleague's warning → 404", r.status === 404, show(r));
  r = await call({ method: 'POST', path: `${A}/translate`, token: tok('crew'), body: { lang: 'fr' } });
  ok('an unknown language → 400', r.status === 400, show(r));

  process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    const q = JSON.parse(init.body).q;
    return { ok: true, status: 200, json: async () => ({ data: { translations: q.map((t) => ({ translatedText: `ES:${t}` })) } }) };
  };
  try {
    r = await call({ method: 'POST', path: `${A}/translate`, token: tok('crew'), body: { lang: 'es', texts: ['ignore me'] } });
  } finally { globalThis.fetch = blockedFetch; delete process.env.GOOGLE_TRANSLATE_API_KEY; }
  ok('the employee gets their own warning in Spanish', r.status === 200 && r.body.texts?.whatHappened === 'ES:Arrived 45 minutes late.', show(r));
  ok("…only the warning's OWN words were sent (never caller text)",
    sent.length === 1 && !JSON.parse(sent[0].init.body).q.includes('ignore me'), JSON.stringify(sent.map((s) => s.init.body)));
  ok('…the key rode a header, never the URL', sent.length === 1 && !String(sent[0].url).includes('test-key'));
  ok('…and nothing was stored', !JSON.stringify(row(A)).includes('ES:'));
}

// ── 9. HR-5 on the cron ─────────────────────────────────────────────────────
console.log('── 9. HR-5 cron ──');
if (!cron || typeof cron.hrWarningAlertsFor !== 'function') {
  fails.push('HR-5: the ops-alert cron carries the warning walker (hrWarningAlertsFor)');
} else {
  const state = build();
  const id = randomUUID();
  const issuedAt = '2026-10-06T14:00:00.000Z';
  (world.tables.hr_warnings = world.tables.hr_warnings || []).push({
    id, organization_id: ORG, employee_user_id: 'u_crew', employee_name: 'Tomas Rivera',
    supervisor_user_id: 'u_mgr2', supervisor_name: 'Max Manager',
    level: 'first', reasons: ['tardiness'], reason_other: null, previous_meeting_date: null,
    what_happened: 'x', what_must_change: 'y', issued_at: issuedAt, issued_on: '2026-10-06',
    issued_by_user_id: 'u_mgr', status: 'awaiting', employee_signature: null, employee_signed_at: null,
    employee_comment: null, signed_in_person: false, refused_at: null, hr_manager_user_id: null,
    hr_manager_name: null, hr_manager_signature: null, hr_manager_signed_at: null, voided_at: null,
    voided_by_user_id: null, voided_by_name: null, void_reason: null, reminded_at: null,
    created_at: issuedAt, updated_at: issuedAt,
  });
  const H = 3600 * 1000;
  const early = Date.parse(issuedAt) + (WARNING_REMINDER_HOURS - 1) * H;
  ok('less than a day: nothing due', (await cron.hrWarningAlertsFor(state, early, new Set())).length === 0);

  const NOW = Date.parse('2026-10-07T15:00:00.000Z');   // 11:00 New York, a Wednesday
  ok('the cron reads in the org zone (sanity)', dayKey(NOW, TZ) === '2026-10-07');
  let written = null;
  const logged = [];
  const deps = {
    now: NOW,
    readState: async () => ({ state: structuredClone(written || state), version: 4 }),
    writeState: async (next) => { written = next; return true; },
    compute: async (s, now) => cron.hrWarningAlertsFor(s, now, new Set((s.opsAlertEvents || []).map((e) => e.id))),
    dispatch: async () => ({ claimed: 1, sent: 1 }),
    pushToUser: async () => ({ delivered: 0 }),
    pushReady: () => true,
    logAuto: async (rows) => { logged.push(...rows); return rows; },
    report: () => {},
  };
  const out = await cron.run(false, deps);
  ok('HR-5: a day-old unsigned warning raises two alerts', out.raised === 2, JSON.stringify(out));
  const n = (written && written.notifications) || [];
  const sup = n.find((x) => x.userId === 'u_mgr2');
  const emp = n.find((x) => x.userId === 'u_crew');
  ok('…the PICKED supervisor is reminded', !!sup && sup.eventKey === HR_WARNING_UNSIGNED_EVENT && sup.url === warningOfficeUrl(id), JSON.stringify(sup));
  ok('…in words that name the employee', !!sup && sup.title.includes('Tomas Rivera'), sup && sup.title);
  ok('…and the employee gets a nudge', !!emp && emp.eventKey === HR_WARNING_SIGN_EVENT && emp.url === warningSignUrl(id), JSON.stringify(emp));
  ok('…nobody else', n.length === 2, JSON.stringify(n.map((x) => x.userId)));
  ok('the warning is stamped once the bells are durable', out && out.warnings && out.warnings.stamped === 1 && !!row(id).reminded_at, JSON.stringify(out.warnings));
  ok('…and the reminder is NOT copied into the activity log (HR stays out of the admin-read log)', logged.length === 0, JSON.stringify(logged));

  if (written) written.opsAlertEvents = [];   // even with the two-day marker gone…
  const second = await cron.run(false, deps);
  ok('…a second run reminds nobody — the stamp is the once-only', second.raised === 0, JSON.stringify(second));

  row(id).reminded_at = null;
  row(id).status = 'acknowledged';
  ok('a signed warning is never due', (await cron.hrWarningAlertsFor(state, NOW, new Set())).length === 0);
}

console.log(`\n${fails.length ? '✗' : '✓'} hr warnings route + cron: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error(`  ✗ ${f}`);
if (fails.length) process.exitCode = 1;
