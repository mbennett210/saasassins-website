// EACH CUSTOMER CHOOSES ITS OWN EMAILS (client hub redesign, plan §3.4 "Emails").
//
// Daniel, 2026-10-08: "we need to have this be on the customer to set up". Every customer login
// picks its own emails on the hub's Account page — three switches:
//   messages     "Replies from the office"   the office answered in the building's Messages (new)
//   requests     "Updates on my requests"    HUB-11's request emails: a stage change, a staff reply
//   inspections  "New inspection reports"    HUB-11's inspection email
// Stored in `client_users.email_prefs` ({ messages?, requests?, inspections? }); null or a missing
// key means ON (Matt's HUB-11 answer stays the default, so a login that never touches the switches
// gets exactly today's emails plus the new reply email). One pure reader,
// `hubEmailEnabled(prefs, kind)` (src/lib/hubEmailPrefs.js), used by the server and the demo.
//
// This suite holds:
//   1. the reader: null = all on; only an explicit `false` turns one off; each switch alone;
//   2. the input rule: booleans only, known keys only — anything else is refused;
//   3. EVERY sender checks it — the three HUB-11 senders and the new reply email — each switch
//      silencing only its own email (over fake-supabase + the notifier's fake-mailer seam);
//   4. the route: POST /api/hub/email-prefs writes the CALLER's own row, the id from the verified
//      claim — a body naming another login is refused and that login's row is untouched;
//      GET answers the resolved switches.
//
// REGRESSION (THE LAW II.3): on the pre-change tree there is no hubEmailPrefs.js, no route branch
// and no sender checks a preference, so every check below fails.
//
//   node app/scripts/test-hub-email-prefs.mjs
const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.APP_PUBLIC_URL = 'https://hub.example.test';
delete process.env.SYSTEM_SENDER_EMAIL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const prefs = await tryImport('../src/lib/hubEmailPrefs.js');
const notify = await tryImport('../api/_lib/clientHub/notify.js');
const hub = (await import('../api/hub/[...path].js')).default;
const { seedPermissions } = await import('../src/lib/roles.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 200)}`;
const on = (p, k) => { try { return prefs.hubEmailEnabled(p, k); } catch { return 'threw'; } };

// ── 1. the reader ─────────────────────────────────────────────────────────────
ok('P0 the module exports the reader and its three kinds', typeof prefs.hubEmailEnabled === 'function'
  && JSON.stringify(prefs.HUB_EMAIL_KINDS) === JSON.stringify(['messages', 'requests', 'inspections']), prefs.__error || '');
const KINDS = prefs.HUB_EMAIL_KINDS || ['messages', 'requests', 'inspections'];
ok('🔴 P1 null prefs = every email ON (Matt\'s HUB-11 default)', () => KINDS.every((k) => on(null, k) === true && on(undefined, k) === true && on({}, k) === true));
for (const k of KINDS) {
  const off = { [k]: false };
  ok(`🔴 P2 "${k}" off silences ${k} ONLY`, () => on(off, k) === false && KINDS.filter((x) => x !== k).every((x) => on(off, x) === true));
}
ok('P3 only an explicit false is off ("false", 0 and null read as on)', () => ['false', 0, null, 'no'].every((v) => on({ messages: v }, 'messages') === true));
ok('P4 an explicit true is on', () => on({ requests: true }, 'requests') === true);
ok('P5 the resolved switches are three booleans', () => JSON.stringify(prefs.resolveHubEmailPrefs({ messages: false, junk: 1 })) === JSON.stringify({ messages: false, requests: true, inspections: true }));

// ── 2. the input rule: booleans only, known keys only ─────────────────────────
const input = (b) => { try { return prefs.hubEmailPrefsInput(b); } catch (e) { return { threw: e?.message }; } };
ok('I1 one switch is accepted', () => JSON.stringify(input({ messages: false }).value) === JSON.stringify({ messages: false }));
ok('I2 all three at once are accepted', () => JSON.stringify(input({ messages: true, requests: false, inspections: true }).value) === JSON.stringify({ messages: true, requests: false, inspections: true }));
for (const [label, bad] of [
  ['an unknown key', { messages: false, marketing: false }],
  ['another login\'s id', { id: 'a0000000-0000-4000-8000-000000000004', messages: false }],
  ['a string "false"', { messages: 'false' }],
  ['a number', { requests: 0 }],
  ['a null', { inspections: null }],
  ['nothing at all', {}],
  ['an array', [false]],
  ['a string body', 'messages=false'],
  ['no body', null],
]) {
  ok(`🔴 I3 ${label} is refused, with a code`, () => !!input(bad).refused && input(bad).code === 'email-prefs' && !input(bad).value, JSON.stringify(input(bad)));
}

// ── 3. every sender checks it ─────────────────────────────────────────────────
const CU1 = 'a0000000-0000-4000-8000-000000000001';
const CU2 = 'a0000000-0000-4000-8000-000000000002';
const CU3 = 'a0000000-0000-4000-8000-000000000003';
const CU4 = 'a0000000-0000-4000-8000-000000000004';
const G1 = 'b0000000-0000-4000-8000-000000000001';
const clientUser = (id, email, emailPrefs, status = 'active') => ({ id, organization_id: ORG, name: email.split('@')[0], email, phone: null, status, auth_user_id: `auth-${id.slice(-1)}`, email_prefs: emailPrefs, updated_at: '2026-10-01T00:00:00.000Z' });
function seed({ p1 = null, p3 = null } = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 1, state: {
        company: { name: 'Clean Space', timezone: 'America/New_York' },
        users: [{ id: 'u_owner', role: 'owner', name: 'Dana Owner', status: 'active', email: 'o@x.test' }],
        clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_owner' }, { id: 'cl_x', name: 'Harbor Tower' }],
        sites: [], permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
      } }],
      client_users: [
        clientUser(CU1, 'pat@coralbay.test', p1),
        clientUser(CU2, 'old@coralbay.test', null, 'disabled'),
        clientUser(CU3, 'jordan@royalpalm.test', p3),
        clientUser(CU4, 'h@harbor.test', null),
      ],
      client_user_groups: [{ id: G1, organization_id: ORG, name: 'Boca', kind: 'city' }],
      client_user_group_members: [{ organization_id: ORG, group_id: G1, client_id: 'cl_a' }],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null },
        { id: 'as2', organization_id: ORG, client_user_id: CU2, client_id: 'cl_a', group_id: null },
        { id: 'as3', organization_id: ORG, client_user_id: CU3, client_id: null, group_id: G1 },
        { id: 'as4', organization_id: ORG, client_user_id: CU4, client_id: 'cl_x', group_id: null },
      ],
      crew_assignments: [],
    },
    logins: {
      'tok-client': { id: 'auth-1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client4': { id: 'auth-4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU4, org_id: ORG } },
      'tok-owner': { id: 'auth-o', email: 'o@x.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
    },
  });
}
const ticket = { id: 'e0000000-0000-4000-8000-000000000001', origin: 'portal', client_id: 'cl_a', client_name: 'Coral Bay HOA', title: 'Coffee stain', status: 'in_progress', raised_by_client_user_id: CU1 };
const reply = { id: 'w1', author_role: 'office', author_name: 'Renata Cruz', body: 'We will treat it tonight.', internal: false };
const inspection = { id: 'c0000000-0000-4000-8000-000000000001', status: 'submitted', client_id: 'cl_a', client_name: 'Coral Bay HOA', template_snapshot: { name: 'Restroom QC' }, result: 'pass', overall_score: 92 };
const staffMessage = { id: 'f0000000-0000-4000-8000-000000000001', client_id: 'cl_a', author_role: 'staff', author_name: 'Renata Cruz', body: 'The door is fixed.' };

const sent = [];
notify.__setHubMailerForTests?.(async (m) => { sent.push(m); return { ok: true }; });
const quiet = async (fn) => { const { warn, error } = console; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = warn; console.error = error; } };
const runAll = async () => {
  sent.length = 0;
  await quiet(async () => {
    await notify.emailTicketStageChanged?.(ticket, 'open');
    await notify.emailTicketReplied?.(ticket, reply);
    await notify.emailInspectionPosted?.(inspection);
    await notify.emailMessageReplied?.({ clientId: 'cl_a', clientName: 'Coral Bay HOA', message: staffMessage });
  });
  const to = (pred) => sent.filter(pred).map((m) => m.to).sort().join(',');
  return {
    stage: to((m) => /an update on your request|an update on your ticket/i.test(m.subject)),
    reply: to((m) => /a reply on your request|a reply on your ticket/i.test(m.subject)),
    inspection: to((m) => /new inspection/i.test(m.subject)),
    message: to((m) => /replied to your message|new message/i.test(m.subject)),
  };
};

ok('S0 the notifier has the new reply email (emailMessageReplied)', typeof notify.emailMessageReplied === 'function', notify.__error || '');
seed();
{
  const r = await runAll();
  ok('🔴 S1 null prefs: the raiser gets the stage and reply emails', () => r.stage === 'pat@coralbay.test' && r.reply === 'pat@coralbay.test', JSON.stringify(r));
  ok('🔴 S2 …everyone who can see the building gets the inspection email (direct and through a group; never a disabled login)', () => r.inspection === 'jordan@royalpalm.test,pat@coralbay.test', JSON.stringify(r));
  ok('🔴 S3 …and the NEW reply email reaches everyone who can see the building', () => r.message === 'jordan@royalpalm.test,pat@coralbay.test', JSON.stringify(r));
  const m = sent.find((x) => /replied to your message|new message/i.test(x.subject));
  ok('S4 the reply email names the building, quotes the office\'s words and links to the building\'s Messages', () => /Coral Bay HOA/.test(m?.subject || '')
    && (m?.body || '').includes('The door is fixed.') && (m?.body || '').includes('https://hub.example.test/hub/b/cl_a/messages'), JSON.stringify(m || null));
  ok('S5 …and names the person as first name + last initial, never in full', () => /Renata C\./.test(m?.body || '') && !/Renata Cruz/.test(m?.body || ''), m?.body);
}
seed({ p1: { requests: false } });
{
  const r = await runAll();
  ok('🔴 S6 "requests" off: no stage email and no reply email for that login…', () => r.stage === '' && r.reply === '', JSON.stringify(r));
  ok('🔴 S7 …while its inspection and message emails still go', () => r.inspection.includes('pat@coralbay.test') && r.message.includes('pat@coralbay.test'), JSON.stringify(r));
}
seed({ p1: { inspections: false } });
{
  const r = await runAll();
  ok('🔴 S8 "inspections" off: that login gets no inspection email, the other login still does', () => r.inspection === 'jordan@royalpalm.test', JSON.stringify(r));
  ok('S9 …and its request emails still go', () => r.stage === 'pat@coralbay.test' && r.reply === 'pat@coralbay.test', JSON.stringify(r));
}
seed({ p1: { messages: false }, p3: { messages: false } });
{
  const r = await runAll();
  ok('🔴 S10 "messages" off: no reply-to-your-message email for either login', () => r.message === '', JSON.stringify(r));
  ok('S11 …and every other email still goes', () => r.stage === 'pat@coralbay.test' && r.reply === 'pat@coralbay.test' && r.inspection === 'jordan@royalpalm.test,pat@coralbay.test', JSON.stringify(r));
}
seed();
{
  sent.length = 0;
  await quiet(() => notify.emailMessageReplied?.({ clientId: 'cl_a', clientName: 'Coral Bay HOA', message: { ...staffMessage, author_role: 'client' } }));
  ok('S12 a CUSTOMER\'s own message emails nobody (only the office\'s replies do)', () => sent.length === 0, JSON.stringify(sent.map((m) => m.to)));
}

// ── 4. the route: the caller's own row, the id from the claim ─────────────────
async function call({ method = 'GET', path: p, token, body }) {
  const [sub, qs] = p.split('?');
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body ?? {} };
  return quiet(() => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader() { return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    Promise.resolve(hub(req, res)).catch((e) => resolve({ status: 'threw', body: { error: e?.message } }));
  }));
}
const row = (id) => world.tables.client_users.find((u) => u.id === id);
seed();
{
  const g = await call({ path: 'email-prefs', token: 'tok-client' });
  ok('🔴 R1 GET email-prefs answers the resolved switches (null = all on)', () => g.status === 200 && JSON.stringify(g.body?.prefs) === JSON.stringify({ messages: true, requests: true, inspections: true }), show(g));
  const p = await call({ method: 'POST', path: 'email-prefs', token: 'tok-client', body: { requests: false } });
  ok('🔴 R2 POST one switch: saved on the caller\'s OWN row, answered resolved', () => p.status === 200 && row(CU1).email_prefs?.requests === false
    && JSON.stringify(p.body?.prefs) === JSON.stringify({ messages: true, requests: false, inspections: true }), show(p));
  const p2 = await call({ method: 'POST', path: 'email-prefs', token: 'tok-client', body: { inspections: false } });
  ok('R3 a second switch MERGES (the first one stays off)', () => p2.status === 200 && row(CU1).email_prefs?.requests === false && row(CU1).email_prefs?.inspections === false, show(p2));
  const upd = world.log.filter((q) => q.table === 'client_users' && q.op === 'update');
  ok('🔴 R4 every write is filtered by the CLAIM\'s id (never a body id)', () => upd.length >= 2 && upd.every((q) => q.eq.id === CU1), JSON.stringify(upd));
  const before = JSON.stringify(row(CU4).email_prefs);
  const other = await call({ method: 'POST', path: 'email-prefs', token: 'tok-client', body: { id: CU4, messages: false } });
  ok('🔴 R5 a body naming ANOTHER login is refused (400), and that login\'s row is untouched', () => other.status === 400 && other.body?.code === 'email-prefs' && JSON.stringify(row(CU4).email_prefs) === before, show(other));
  for (const [label, bad] of [['an unknown key', { marketing: false }], ['a non-boolean', { messages: 'off' }], ['an empty body', {}]]) {
    const r = await call({ method: 'POST', path: 'email-prefs', token: 'tok-client', body: bad });
    ok(`🔴 R6 ${label} is a 400 with a sentence and a code`, () => r.status === 400 && r.body?.code === 'email-prefs' && typeof r.body?.error === 'string', show(r));
  }
  ok('R7 …and none of the refused calls wrote anything', () => world.log.filter((q) => q.table === 'client_users' && q.op === 'update').length === upd.length);
  const staff = await call({ method: 'POST', path: 'email-prefs', token: 'tok-owner', body: { messages: false } });
  ok('🔴 R8 a STAFF login is refused (403 office-login)', () => staff.status === 403 && staff.body?.code === 'office-login', show(staff));
  const anon = await call({ method: 'POST', path: 'email-prefs', body: { messages: false } });
  ok('R9 no login is a 401', () => anon.status === 401, show(anon));
  const g2 = await call({ path: 'email-prefs', token: 'tok-client4' });
  ok('R10 another login still reads its own defaults', () => g2.status === 200 && g2.body?.prefs?.messages === true, show(g2));
}

console.log(`\nhub email prefs: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
