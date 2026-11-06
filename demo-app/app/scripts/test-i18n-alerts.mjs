// CS-193 / Matt's LANG-4 — "notifications, alerts and texts in the cleaner's language."
//
// An alert is rendered for its READER when it is written, on whichever side writes it, so
// this suite drives the REAL writers with a roster of mixed languages and reads what each
// person got:
//   C. the ops-alert cron (api/cron/ops-alerts.js `run`, every dependency injected): the
//      missed-shift bell rows for a Spanish supervisor and an English owner, the pre-shift
//      push-only banners for a cleaner whose PHONE is Spanish and one set to Creole (no
//      Creole lines yet: English, never a key); times in the ORG's zone; the activity log
//      in English whoever the alert went to;
//   D. the push dispatcher's burst digest (api/_lib/push/dispatch.js `dispatchDue`), the one
//      sentence the push channel composes itself;
//   F. the browser-side fan-outs in lib/notifications (an account's notes changed, a key
//      checked out), and a plain English string still passing through unchanged;
//   R. the failed-inspection redo notice through the real QC route (fake Supabase): each
//      cleaner on site told in their own language, the area list joined with that
//      language's own "and";
//   S. the server registers every catalog at the write chokepoints.
//
// The Spanish here is a TEST catalog registered in memory (so the checks do not move when the
// shipped wording is corrected), and the Creole an empty one — every expectation is built from
// them and from the English catalog module, never restated.
//
// Offline. Run: node scripts/test-i18n-alerts.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000193';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// Dynamic: on the pre-change tree there is no src/i18n, and every check must report.
let core = null; let en = null;
try { core = await import('../src/i18n/core.js'); } catch { /* pre-change tree */ }
try { en = (await import('../src/i18n/catalog/en.js')).default; } catch { /* pre-change tree */ }
const have = !!(core && en);
const E = (key, form) => {
  const v = en?.[key];
  return typeof v === 'string' ? v : (v && (v[form] || v.other)) || `(no English for ${key})`;
};

const { run } = await import('../api/cron/ops-alerts.js');
const { dispatchDue } = await import('../api/_lib/push/dispatch.js');
const N = await import('../src/lib/notifications.js');
const { opsAlertId } = await import('../src/lib/opsAlerts.js');
const { preShiftReminderId } = await import('../src/lib/preShiftReminders.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { fmtTime } = await import('../src/lib/dates.js');
const { IDENTITY } = await import('../src/brand/identity.generated.js');
const qc = (await import('../api/qc/[...path].js')).default;

// Importing the cron loaded the server's real catalogs; Spanish is replaced IN MEMORY with
// recognisable test lines, and Creole with an empty one (below): it must fall back to English.
const ES = {
  'common.listAnd': '{first} y {last}',
  'alerts.shiftMissed.title': 'Turno perdido: {customer}',
  'alerts.shiftMissed.body': 'Programado {start, time}; nadie ha marcado entrada.',
  'alerts.shiftReminder.title': 'Tu turno empieza {start, time}',
  'alerts.shiftReminder.body': '{customer}: toca para abrir tu día.',
  'push.digest.title': { one: '{count} notificación nueva', other: '{count} notificaciones nuevas' },
  'push.digest.body': 'Abre {brand} para ponerte al día.',
  'alerts.ops.updatedBy': '{name} actualizó {customer}',
  'alerts.ops.notesUpdated': 'Se actualizaron las notas de la cuenta para el equipo.',
  'alerts.key.checkedOut': 'Se te entregó la llave {key}',
  'alerts.key.byWhom': 'por {name}',
  'alerts.redo.title': 'Por favor, rehaga: {areas, list}',
  'alerts.ticketReplied.title': 'El cliente respondió — {place}',
  'alerts.redo.body': { one: '{place}: {count} punto no pasó la inspección.', other: '{place}: {count} puntos no pasaron la inspección.' },
};
ok('the test can register a Spanish catalog', have && core.registerCatalog('es', ES) === true);
// Creole is replaced IN MEMORY by an EMPTY catalog: since S129 the shipped ht.js holds the
// app's own words, and the fallback these checks pin is "a language that lacks a line shows
// its English, never a key".
ok('the test can register an empty Creole catalog', have && core.registerCatalog('ht', {}) === true);

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-10-04T02:00:00.000Z');
const START = new Date(NOW - 30 * 60_000).toISOString();       // the clean nobody turned up for
const SOON = new Date(NOW + 30 * 60_000).toISOString();        // a shift starting soon
const tEn = (iso) => fmtTime(iso, TZ, 'en-US');
const tEs = (iso) => fmtTime(iso, TZ, 'es-US');
ok('the fixture\'s times differ by zone, so the zone is really checked', tEn(START) !== fmtTime(START, 'UTC', 'en-US'));

const person = (id, role, extra = {}) => ({ id, name: id, role, status: 'active', email: `${id}@x.test`, notificationPrefs: {}, ...extra });
const roster = () => [
  person('u_sup', 'manager', { language: 'es' }),                         // chose Spanish
  person('u_own', 'owner'),                                               // nothing set: English
  person('u_c1', 'crew', { language: 'auto', phoneLanguage: 'es' }),      // follows a Spanish phone
  person('u_c2', 'crew', { language: 'ht' }),                             // chose Creole (no lines yet)
];

// ── C. the ops-alert cron ─────────────────────────────────────────────────────────────────
{
  const state = {
    version: 57,
    company: { id: 'co', name: 'Clean Space', timezone: TZ },
    users: roster(),
    clients: [{ id: 'cl_real', name: 'Real Co', supervisorId: 'u_sup' }],
    permissions: seedPermissions(), userPermissionOverrides: [],
    notifications: [], opsAlertEvents: [], opsSettings: {},
  };
  const due = [
    { id: opsAlertId('shiftMissed', 'j1'), kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_real', jobId: 'j1', crewIds: [], scheduledStart: START },
    ...['u_c1', 'u_c2'].map((userId) => ({
      id: preShiftReminderId('j2', userId), kind: 'shiftReminder', pushOnly: true, recipientScope: 'crew',
      jobId: 'j2', clientId: 'cl_real', siteId: null, userId, crewIds: [userId], scheduledStart: SOON,
    })),
  ];
  let written = null;
  const logged = [];
  const pushed = [];
  const out = await run(false, {
    now: NOW,
    readState: async () => ({ state: JSON.parse(JSON.stringify(state)), version: 7 }),
    writeState: async (next) => { written = next; return true; },
    compute: async () => due,
    dispatch: async () => ({ claimed: 0, sent: 0 }),
    pushToUser: async (userId, payload) => { pushed.push({ userId, ...payload }); return { delivered: 1 }; },
    pushReady: () => true,
    logAuto: async (rows) => { logged.push(...rows); return rows; },
    report: () => {},
    stampContractReminders: async () => 0,
    regenerateContractReminders: async () => 0,
  });
  const row = (uid) => (written?.notifications || []).find((n) => n.userId === uid && n.eventKey === 'shiftMissed');
  ok('C0: the cron raised the alerts', out?.raised === 3, JSON.stringify(out));
  eq('C1: the Spanish supervisor\'s missed-shift row is in Spanish', row('u_sup')?.title, ES['alerts.shiftMissed.title'].replace('{customer}', 'Real Co'));
  eq('C2: …with the time in Spanish, in the ORG\'s zone', row('u_sup')?.body, ES['alerts.shiftMissed.body'].replace('{start, time}', tEs(START)));
  eq('C3: the owner (nothing chosen) gets English', row('u_own')?.title, E('alerts.shiftMissed.title').replace('{customer}', 'Real Co'));
  eq('C4: …with the time in English, in the org\'s zone', row('u_own')?.body, E('alerts.shiftMissed.body').replace('{start, time}', tEn(START)));
  const push = (uid) => pushed.find((p) => p.userId === uid);
  eq('C5: a cleaner whose PHONE is Spanish gets the pre-shift banner in Spanish', push('u_c1')?.title,
    ES['alerts.shiftReminder.title'].replace('{start, time}', tEs(SOON)));
  eq('C6: …body too', push('u_c1')?.body, ES['alerts.shiftReminder.body'].replace('{customer}', 'Real Co'));
  eq('C7: a cleaner set to Creole, with no Creole lines yet, gets ENGLISH (never a key)', push('u_c2')?.title,
    E('alerts.shiftReminder.title').replace('{start, time}', tEn(SOON)));
  const log = logged.find((r) => r.after?.kind === 'shiftMissed');
  ok('C8: the activity log is ENGLISH even though the supervisor reads Spanish',
    !!log && log.summary.includes(E('alerts.shiftMissed.title').replace('{customer}', 'Real Co'))
    && log.summary.includes(tEn(START)) && !log.summary.includes(ES['alerts.shiftMissed.title'].split(':')[0]),
    JSON.stringify(log?.summary));
  ok('C9: no row anywhere carries a raw catalog key or a placeholder',
    (written?.notifications || []).every((n) => !/\b(alerts|push|common)\.[a-zA-Z.]+\b|\{[a-z]/.test(`${n.title} ${n.body}`))
    && pushed.every((p) => !/\b(alerts|push|common)\.[a-zA-Z.]+\b|\{[a-z]/.test(`${p.title} ${p.body}`)));
}

// ── D. the push digest ────────────────────────────────────────────────────────────────────
{
  const users = roster();
  const rows = (uid) => [1, 2, 3, 4].map((i) => ({ id: `n_${uid}_${i}`, userId: uid, eventKey: 'messageDirect', title: `t${i}`, body: '', url: '/' }));
  const sent = [];
  await dispatchDue({
    now: NOW,
    claim: async () => ({ toSend: [...rows('u_sup'), ...rows('u_own')], users, claimed: 8, opsSettings: {}, timeZone: TZ }),
    subscriptionsFor: async (uid) => [{ endpoint: `https://push.example/${uid}` }],
    pushTo: async (subs, payload) => { sent.push({ to: subs[0].endpoint, ...payload }); return { delivered: 1 }; },
    textConfigured: () => false,
    text: async () => ({ ok: false }),
    markOptedOut: async () => 0,
  });
  const to = (uid) => sent.find((s) => s.to.endsWith(`/${uid}`));
  eq('D1: a burst digest for the Spanish supervisor is in Spanish', to('u_sup')?.title, ES['push.digest.title'].other.replace('{count}', '4'));
  // a push names the SOFTWARE (IDENTITY.product: the company's when the pack names no product, UI_RULES §129)
  eq('D2: …body too, with the app\'s name', to('u_sup')?.body, ES['push.digest.body'].replace('{brand}', IDENTITY.product.wordmark));
  eq('D3: the English owner\'s digest is English', to('u_own')?.title, E('push.digest.title', 'other').replace('{count}', '4'));
}

// ── F. the browser-side fan-outs ──────────────────────────────────────────────────────────
{
  const state = {
    company: { timezone: TZ },
    users: roster(),
    clients: [{ id: 'cl_real', name: 'Real Co' }],
    sites: [],
    jobs: [{ id: 'j9', clientId: 'cl_real', status: 'upcoming', crewIds: ['u_c1', 'u_c2'], startAt: SOON, endAt: new Date(Date.now() + 3600e3).toISOString() }],
    permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
    currentUserId: 'u_own',
  };
  const ops = have ? N.fanOutOpsNotification(state, { clientId: 'cl_real', actorName: 'Matt', summary: core.msg('alerts.ops.notesUpdated') }) : [];
  const opsRow = (uid) => ops.find((n) => n.userId === uid);
  eq('F1: an account-notes change reaches a Spanish cleaner in Spanish (title)', opsRow('u_c1')?.title,
    ES['alerts.ops.updatedBy'].replace('{name}', 'Matt').replace('{customer}', 'Real Co'));
  eq('F2: …and body', opsRow('u_c1')?.body, ES['alerts.ops.notesUpdated']);
  eq('F3: the Creole cleaner gets the English line', opsRow('u_c2')?.body, E('alerts.ops.notesUpdated'));

  const keyRows = N.fanOutKeyNotification({ ...state, currentUserId: 'u_sup' }, { key: { id: 'k1', label: 'Front door', clientName: 'Real Co' }, holderUserId: 'u_c1' });
  const keyRow = keyRows.find((n) => n.userId === 'u_c1');
  eq('F4: a key handed to a Spanish cleaner says so in Spanish', keyRow?.title, ES['alerts.key.checkedOut'].replace('{key}', 'Front door'));
  ok('F5: …and the "by whom" part too', !!keyRow && keyRow.body.includes(ES['alerts.key.byWhom'].replace('{name}', 'u_sup')), JSON.stringify(keyRow?.body));

  const plain = N.fanOutToUserIds(state, { userIds: ['u_c1', 'u_c2'], eventKey: 'checklistDue', title: 'Already English', body: 'As written', url: '/' });
  ok('F6: a plain string (an older caller, or someone\'s own words) passes through unchanged for every reader',
    plain.length === 2 && plain.every((n) => n.title === 'Already English' && n.body === 'As written'));
}

// ── R. the redo notice through the real QC route ──────────────────────────────────────────
{
  const SCHEMA = { areas: [
    { id: 'a_rest', label: 'Restrooms', items: [{ id: 'r_sink', label: 'Sink' }] },
    { id: 'a_break', label: 'Break room', items: [{ id: 'b_counter', label: 'Counter' }] },
    { id: 'a_lobby', label: 'Lobby', items: [{ id: 'l_glass', label: 'Glass' }] },
  ] };
  const SNAP = { name: 'Nightly QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, schema: SCHEMA };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 57, state: {
        version: 57, company: { id: 'co', name: 'Clean Space', timezone: TZ },
        users: [person('u_m', 'manager'), ...roster()],
        clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_sup' }],
        sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }],
        permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
      } }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      inspection_templates: [{ id: 'it_i', organization_id: ORG, name: 'Nightly QC', kind: 'inspection', is_published: true, published_version_id: 'v_i' }],
      inspection_template_versions: [{ id: 'v_i', template_id: 'it_i', version_number: 1, status: 'published', schema: SCHEMA }],
      inspection_records: [{
        id: 'ir_1', organization_id: ORG, public_token: 'tok_1', template_id: 'it_i', template_version_id: 'v_i',
        template_snapshot: SNAP, client_id: 'c1', site_id: 's1', job_id: null,
        inspector_user_id: 'u_m', client_name: 'Coral Bay HOA', site_name: 'Clubhouse', inspector_name: 'u_m',
        status: 'draft', performed_at: '2026-10-02T22:00:00.000Z',
      }],
      inspection_items: [], problem_reports: [], activity_log: [],
      time_entries: ['u_c1', 'u_own'].map((uid, i) => ({
        id: `e_${uid}`, organization_id: ORG, job_id: `j${i}`, client_id: 'c1', site_id: 's1', user_id: uid,
        clock_in_at: '2026-10-02T20:00:00.000Z', clock_out_at: null, status: 'in_progress', row_version: 0,
      })),
    },
    logins: { 'tok-mgr': { id: 'auth-m', email: 'm@x.test', app_metadata: { role: 'manager', org_user_id: 'u_m', org_id: ORG } } },
  });
  const items = SCHEMA.areas.flatMap((a) => a.items.map((i) => ({ item_key: i.id, label: `${a.label}. ${i.label}`, rating: i.id === 'l_glass' ? 'pass' : 'fail', comment: null })));
  const body = { id: 'ir_1', items };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: 'POST', headers: { authorization: 'Bearer tok-mgr' }, query: { subpath: 'inspections/submit' }, body });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  let status = null;
  try {
    status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 10000);
      const done = (s) => { clearTimeout(timer); resolve(s); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json() { done(this.statusCode); return this; },
        send() { done(this.statusCode); return this; },
        end() { done(this.statusCode); return this; },
      };
      Promise.resolve(qc(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } catch { status = null; } finally { Object.assign(console, quiet); }
  const redo = (uid) => (world.tables.org_state[0].state.notifications || []).find((n) => n.userId === uid && n.eventKey === (N.REDO_EVENT_KEY || 'inspectionRedo'));
  ok('R0: the inspection submitted', status === 200, `status ${status}`);
  eq('R1: the Spanish cleaner on site is told to redo in Spanish, with Spanish "y"', redo('u_c1')?.title, 'Por favor, rehaga: Restrooms y Break room');
  eq('R2: …and the body', redo('u_c1')?.body, ES['alerts.redo.body'].other.replace('{place}', 'Clubhouse').replace('{count}', '2'));
  eq('R3: the English reader on site gets English', redo('u_own')?.title,
    E('alerts.redo.title').replace('{areas, list}', E('common.listAnd').replace('{first}', 'Restrooms').replace('{last}', 'Break room')));
}

// ── H. a customer's reply on a hub ticket rings the office in each reader's language ─────
// (Round 2's notifyClientReplied, merged with Round 3: the account's supervisor is u_sup, who
// chose Spanish. The customer's own words are quoted as written, LANG-7.)
{
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 12, state: {
        version: 12, company: { id: 'co', name: 'Clean Space', timezone: TZ },
        users: roster(),
        clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_sup' }],
        sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }],
        permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
      } }],
    },
  });
  const store = await import('../api/_lib/qc/store.js');
  const said = 'Thanks — any update on the lobby glass?';
  let out = null;
  try {
    out = await store.notifyClientReplied(
      { id: 'pr_1', client_id: 'c1', client_name: 'Coral Bay HOA', priority: 'medium', title: 'Lobby glass', assignee_user_id: null },
      { author_role: 'client', internal: false, body: said },
    );
  } catch (e) { out = { error: e.message }; }
  const row = (world.tables.org_state[0].state.notifications || []).find((n) => n.userId === 'u_sup');
  ok('H0: the reply rang the account’s supervisor', !!out?.sent && !!row, JSON.stringify(out));
  eq('H1: …in Spanish, the language they chose', row?.title, 'El cliente respondió — Coral Bay HOA');
  ok('H2: …with the customer’s own words quoted as written', typeof row?.body === 'string' && row.body.includes(said), JSON.stringify(row?.body));
}

// ── S. the server loads every catalog where alerts are written ────────────────────────────
{
  const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8'); } catch { return ''; } };
  const lib = read('../api/_lib/i18n.js');
  ok('S1: api/_lib/i18n.js registers the Spanish and Creole catalogs',
    /registerCatalog\('es', es\)/.test(lib) && /registerCatalog\('ht', ht\)/.test(lib));
  ok('S2: every bell row the server commits passes through a module that loads them (orgState), and its read merges the stored lines first (CS-851)',
    /^import \{ ensureStoredLines \} from '\.\/i18n\.js';/m.test(read('../api/_lib/orgState.js'))
    && /const lines = ensureStoredLines\(\);[\s\S]*await lines;/.test(read('../api/_lib/orgState.js')));
  ok('S3: …and so does every push-only banner (push store)', /^import '\.\.\/i18n\.js';/m.test(read('../api/_lib/push/store.js')));
  ok('S4: an office tab loads its roster\'s languages before it raises an alert (OpsAlertScheduler)',
    /await Promise\.all\(\[\.\.\.new Set\(\(s\.users \|\| \[\]\)\.map\(userLanguage\)\)\]\.map\(\(lang\) => ensureCatalog\(lang\)\)\)/.test(read('../src/components/OpsAlertScheduler.jsx')));
}

console.log(`\ntest-i18n-alerts: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
