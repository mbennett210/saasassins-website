// The SERVER half of "a checklist belongs to one customer" (R2), driven through the REAL
// handler — `app/api/qc/[...path].js` — against the loopback Supabase fake. No network, no
// credentials, no live project (BUILD_INTEGRITY §6b forbids proving a server claim any
// other way while there is no sandbox rig, CS-033).
//
// A rule is only proven by a request going through it. Unit-testing the decision function
// misses the wiring — which key a branch passes, whether it validates the id at all, what
// the store does with the answer — and `test-qc-template-delete-route.mjs` exists because a
// reviewer deleted a whole `requirePermission` line and every non-route suite stayed green.
//
// What it pins:
//   · templates/list scoping — ?clientId, ?starters=1, neither, and the two together;
//   · templates/create — a checklist REQUIRES a customer, an inspection REFUSES one, and an
//     unknown customer is a 400 (the id is checked against org_state.clients, since
//     customers live in the blob and there is no FK to enforce it);
//   · templates/copy — the published schema carried, published vs draft, the default name,
//     a non-checklist source refused, permission and customer checked;
//   · templates/summary — narrow, ordered, COMPLETE past db-max-rows, with item counts;
//   · every one of them org-scoped, and gated.
//
// Failing-first by construction: pre-fix the route has no copy or summary action (404), the
// list ignores ?clientId (returns every row) and create accepts a checklist with no customer.
//
//   node app/scripts/test-checklist-location-route.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { countSchemaItems } from '../src/lib/inspections.js';

const ORG = '00000000-0000-0000-0000-000000000042';
const OTHER_ORG = '00000000-0000-0000-0000-000000000099';
// Set BEFORE anything under api/ loads; the URL is a closed local port and fetch is stubbed.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const qc = (await import('../api/qc/[...path].js')).default;
const {
  CHECKLIST_NEEDS_CUSTOMER, INSPECTION_TAKES_NO_CUSTOMER, TEMPLATE_FILTER_CONFLICT,
  COPY_SOURCE_MUST_BE_CHECKLIST, TEMPLATE_KIND_MESSAGE,
} = await import('../src/lib/inspections.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) { pass += 1; } else { fails.push(detail ? `${label} — ${detail}` : label); } };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── roster + logins ──────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner' },
  mgr: { id: 'u_mgr', role: 'manager' },
  crew: { id: 'u_crew', role: 'crew' },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: { role: p.role, org_user_id: p.id, org_id: ORG },
}]));

const BAY = 'cl_seed_mtbaker';
const OLAS = 'cl_seed_lasolas';
const CLIENTS = [{ id: BAY, name: 'Coral Bay HOA' }, { id: OLAS, name: 'Las Olas Dental' }];

const ONE_ITEM = { areas: [{ id: 'a', label: 'Floors', items: [{ id: 'i1', label: 'Sweep' }] }] };
const TWO_ITEMS = { areas: [{ id: 'a', label: 'Floors', items: [{ id: 'i1', label: 'Sweep' }, { id: 'i2', label: 'Mop' }] }] };
const NO_ITEMS = { areas: [{ id: 'a', label: 'Floors', items: [] }] };

const tpl = (id, over = {}) => ({
  id, organization_id: ORG, kind: 'checklist', name: id, client_id: null,
  rating_scale: { type: 'passfail', passThreshold: 100 }, slug: `s_${id}`,
  is_published: false, published_version_id: null, item_count: null,
  updated_at: '2026-09-20T00:00:00.000Z', ...over,
});
const ver = (id, templateId, schema, status = 'draft') => ({
  id, template_id: templateId, version_number: 1, schema, status,
  published_at: status === 'published' ? '2026-09-20T00:00:00.000Z' : null,
});

function seed(extra = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: {
        users: roster, clients: CLIENTS, permissions: seedPermissions(), userPermissionOverrides: [],
      } }],
      inspection_templates: [
        // `item_count` is the denormalized count of the PUBLISHED version's items (F4), so
        // the summary never reads a schema. Null while unpublished.
        tpl('it_floorcare', { client_id: BAY, is_published: true, published_version_id: 'v_floor', item_count: 1, updated_at: '2026-09-24T00:00:00.000Z' }),
        tpl('it_fullclean', { client_id: BAY, is_published: true, published_version_id: 'v_full', item_count: 2, updated_at: '2026-09-23T00:00:00.000Z' }),
        tpl('it_lobby', { client_id: OLAS, updated_at: '2026-09-22T00:00:00.000Z' }),
        tpl('it_closeout', { client_id: null, is_published: true, published_version_id: 'v_close', item_count: 2, updated_at: '2026-09-21T00:00:00.000Z' }),
        tpl('it_janitorial', { kind: 'inspection', client_id: null, updated_at: '2026-09-25T00:00:00.000Z' }),
        // another org's rows — nothing may ever reach them
        tpl('it_other', { organization_id: OTHER_ORG, client_id: BAY, is_published: true, published_version_id: 'v_other', item_count: 2 }),
      ],
      inspection_template_versions: [
        ver('v_floor', 'it_floorcare', ONE_ITEM, 'published'),
        ver('v_full', 'it_fullclean', TWO_ITEMS, 'published'),
        ver('v_lobby_draft', 'it_lobby', ONE_ITEM, 'draft'),
        ver('v_close', 'it_closeout', TWO_ITEMS, 'published'),
        ver('v_other', 'it_other', TWO_ITEMS, 'published'),
      ],
      ...extra,
    },
    logins,
  });
}

// ── one request through the real handler ─────────────────────────────────────
async function call({ subpath, method = 'GET', token = 'tok-owner', query = {}, body = null }) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from([Buffer.from(raw)]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath, ...query };
  req.body = body || {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${subpath}: no response`)), 15000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(qc(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const list = (query, token) => call({ subpath: 'templates/list', query, token });
const idsOf = (r) => (r.body?.templates || []).map((t) => t.id);

// ── templates/list: scoping ──────────────────────────────────────────────────
{
  seed();
  let r = await list({ kind: 'checklist' });
  eq('list: no customer and no starters flag → every checklist, as today',
    idsOf(r).sort(), ['it_closeout', 'it_floorcare', 'it_fullclean', 'it_lobby']);
  ok('list: another org never leaks in', !idsOf(r).includes('it_other'));

  r = await list({ kind: 'checklist', clientId: BAY });
  eq('list: ?clientId gives THAT customer\'s checklists only', idsOf(r).sort(), ['it_floorcare', 'it_fullclean']);
  ok('list: …and not the starter', !idsOf(r).includes('it_closeout'));

  r = await list({ kind: 'checklist', clientId: OLAS });
  eq('list: a different customer is a different set', idsOf(r), ['it_lobby']);

  r = await list({ kind: 'checklist', clientId: 'cl_nobody' });
  eq('list: a customer with none is empty, never everything', idsOf(r), []);

  r = await list({ kind: 'checklist', starters: '1' });
  eq('list: ?starters=1 gives only the rows with no customer', idsOf(r), ['it_closeout']);

  r = await list({ starters: '1' });
  eq('list: starters with no kind still excludes every filed row', idsOf(r).sort(), ['it_closeout', 'it_janitorial']);

  r = await list({ kind: 'checklist', clientId: BAY, starters: '1' });
  eq('list: a customer AND starters is a 400, not a silently empty list', r.status, 400);
  eq('list: …with the shared message', r.body?.error, TEMPLATE_FILTER_CONFLICT);

  r = await list({ kind: 'checklist', clientId: 'cl_bay),kind.eq.inspection' });
  eq('list: a malformed clientId is a 400 — it never reaches PostgREST', r.status, 400);

  r = await list({ kind: 'checklist' }, null);
  eq('list: no session → 401', r.status, 401);
  r = await list({ kind: 'checklist' }, 'tok-crew');
  eq('list: crew hold qc.view, so the list still answers them', r.status, 200);

  // ?kind is a VOCABULARY, not free text. Unvalidated it reached `.eq('kind', …)` as
  // whatever was typed, and a typo ("checklists") came back as an empty list that reads
  // like "there are none" — the same class of wrong answer the clientId/starters conflict is.
  r = await list({ kind: 'checklists' });
  eq('list: an unknown kind is a 400, not a silently empty list', r.status, 400);
  eq('list: …naming the kinds there are', r.body?.error, TEMPLATE_KIND_MESSAGE);
  r = await list({ kind: 'Checklist' });
  eq('list: the vocabulary is exact — no case-folding', r.status, 400);
  r = await list({ kind: '' });
  eq('list: an EMPTY kind is still "no filter", as it always was', r.status, 200);
  eq('list: …and returns every row', idsOf(r).length, 5);
  r = await list({ kind: 'inspection' });
  eq('list: the other real kind still works', idsOf(r), ['it_janitorial']);
}

// ── templates/create ─────────────────────────────────────────────────────────
const created = () => world.tables.inspection_templates.filter((t) => !t.id.startsWith('it_'));
{
  seed();
  let r = await call({ subpath: 'templates/create', method: 'POST', body: { name: 'New list', kind: 'checklist' } });
  eq('create: a checklist with NO customer is refused', r.status, 400);
  eq('create: …with the plain sentence the office reads', r.body?.error, CHECKLIST_NEEDS_CUSTOMER);
  eq('create: …and nothing is written', created().length, 0);

  seed();
  r = await call({ subpath: 'templates/create', method: 'POST', body: { name: 'New list', kind: 'checklist', clientId: 'cl_ghost' } });
  eq('create: a customer that does not exist is refused', r.status, 400);
  eq('create: …and nothing is written', created().length, 0);

  seed();
  r = await call({ subpath: 'templates/create', method: 'POST', body: { name: 'New list', kind: 'checklist', clientId: 'cl_bay),kind.eq.x' } });
  eq('create: a malformed customer id is refused', r.status, 400);

  seed();
  r = await call({ subpath: 'templates/create', method: 'POST', body: { name: 'Walk', kind: 'inspection', clientId: BAY } });
  eq('create: an INSPECTION with a customer is refused — inspections stay company-wide', r.status, 400);
  eq('create: …with its own message', r.body?.error, INSPECTION_TAKES_NO_CUSTOMER);
  eq('create: …and nothing is written', created().length, 0);

  seed();
  r = await call({ subpath: 'templates/create', method: 'POST', body: { name: 'Walk', kind: 'inspection' } });
  eq('create: an inspection with no customer still works', r.status, 200);
  eq('create: …and is filed under nobody', r.body?.template?.client_id ?? null, null);

  seed();
  r = await call({ subpath: 'templates/create', method: 'POST', body: { name: 'Coral Bay nightly', kind: 'checklist', clientId: BAY } });
  eq('create: a checklist with a real customer is written', r.status, 200);
  eq('create: …filed under that customer', r.body?.template?.client_id, BAY);
  eq('create: …in this org', r.body?.template?.organization_id, ORG);
  eq('create: …with a version 1 draft', r.body?.version?.version_number, 1);

  seed();
  r = await call({ subpath: 'templates/create', method: 'POST', token: 'tok-crew', body: { name: 'x', kind: 'checklist', clientId: BAY } });
  eq('create: crew lack qc.templates.edit → 403', r.status, 403);
  eq('create: …and nothing is written', created().length, 0);
  r = await call({ subpath: 'templates/create', method: 'POST', token: null, body: { name: 'x', kind: 'checklist', clientId: BAY } });
  eq('create: no session → 401', r.status, 401);
}

// ── templates/copy ───────────────────────────────────────────────────────────
const schemaOf = (versionId) => world.tables.inspection_template_versions.find((v) => v.id === versionId)?.schema;
{
  seed();
  let r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_closeout', clientId: OLAS } });
  eq('copy: a starter copies into a customer', r.status, 200);
  const copy = r.body?.template;
  eq('copy: …filed under that customer', copy?.client_id, OLAS);
  eq('copy: …as a checklist in this org', [copy?.kind, copy?.organization_id], ['checklist', ORG]);
  eq('copy: …named after the source by default', copy?.name, 'it_closeout');
  eq('copy: …carrying the source\'s PUBLISHED schema as version 1', schemaOf(r.body?.version?.id), TWO_ITEMS);
  eq('copy: …published at once, because the source was', [copy?.is_published, r.body?.version?.status], [true, 'published']);
  eq('copy: …and pointed at its own version', copy?.published_version_id, r.body?.version?.id);
  ok('copy: the SOURCE is untouched',
    world.tables.inspection_templates.find((t) => t.id === 'it_closeout')?.client_id === null);
  eq('copy: …and gets its own slug', copy?.slug === 's_it_closeout', false);

  seed();
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_closeout', clientId: OLAS, name: '  Las Olas nightly  ' } });
  eq('copy: a given name wins, trimmed', r.body?.template?.name, 'Las Olas nightly');

  seed();
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_lobby', clientId: BAY } });
  eq('copy: an UNPUBLISHED source copies its latest draft', schemaOf(r.body?.version?.id), ONE_ITEM);
  eq('copy: …and the copy stays a draft', [r.body?.template?.is_published, r.body?.version?.status], [false, 'draft']);

  // publishRefusal still rules: a copy of an item-less published checklist may not auto-publish.
  seed({ inspection_templates: [] });
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: { users: roster, clients: CLIENTS, permissions: seedPermissions(), userPermissionOverrides: [] } }],
      inspection_templates: [tpl('it_blank', { is_published: true, published_version_id: 'v_blank' })],
      inspection_template_versions: [ver('v_blank', 'it_blank', NO_ITEMS, 'published')],
    },
    logins,
  });
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_blank', clientId: BAY } });
  eq('copy: an item-less published source copies as a DRAFT (it can never be completed)', r.status, 200);
  eq('copy: …unpublished', [r.body?.template?.is_published, r.body?.version?.status], [false, 'draft']);

  seed();
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_janitorial', clientId: BAY } });
  eq('copy: an INSPECTION source is refused', r.status, 400);
  eq('copy: …with the shared message', r.body?.error, COPY_SOURCE_MUST_BE_CHECKLIST);

  seed();
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_other', clientId: BAY } });
  eq('copy: another org\'s template is not found — the read is org-scoped', r.status, 404);

  seed();
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_closeout' } });
  eq('copy: with no customer it is refused', r.status, 400);
  eq('copy: …with the same sentence create uses', r.body?.error, CHECKLIST_NEEDS_CUSTOMER);

  seed();
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_closeout', clientId: 'cl_ghost' } });
  eq('copy: an unknown customer is refused', r.status, 400);

  seed();
  r = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_nope', clientId: BAY } });
  eq('copy: an unknown source is a 404', r.status, 404);

  seed();
  const before = world.tables.inspection_templates.length;
  r = await call({ subpath: 'templates/copy', method: 'POST', token: 'tok-crew', body: { id: 'it_closeout', clientId: BAY } });
  eq('copy: crew lack qc.templates.edit → 403', r.status, 403);
  eq('copy: …and nothing is written', world.tables.inspection_templates.length, before);
  r = await call({ subpath: 'templates/copy', method: 'POST', token: null, body: { id: 'it_closeout', clientId: BAY } });
  eq('copy: no session → 401', r.status, 401);
  eq('copy: manager holds the key → 200',
    (await call({ subpath: 'templates/copy', method: 'POST', token: 'tok-mgr', body: { id: 'it_closeout', clientId: BAY } })).status, 200);
}

// ── templates/summary ────────────────────────────────────────────────────────
{
  seed();
  let r = await call({ subpath: 'templates/summary' });
  eq('summary: 200 for a qc.view holder', r.status, 200);
  const rows = r.body?.templates || [];
  eq('summary: every CHECKLIST, and only checklists',
    rows.map((t) => t.id), ['it_floorcare', 'it_fullclean', 'it_lobby', 'it_closeout']);
  eq('summary: ordered newest-edited first', rows.map((t) => t.updated_at),
    ['2026-09-24T00:00:00.000Z', '2026-09-23T00:00:00.000Z', '2026-09-22T00:00:00.000Z', '2026-09-21T00:00:00.000Z']);
  eq('summary: NARROW — no schema, no rating scale, no slug',
    Object.keys(rows[0] || {}).sort(),
    ['client_id', 'id', 'is_published', 'item_count', 'name', 'published_version_id', 'updated_at']);
  eq('summary: the published version\'s item count rides along',
    rows.filter((t) => t.is_published).map((t) => [t.id, t.item_count]),
    [['it_floorcare', countSchemaItems(ONE_ITEM)], ['it_fullclean', countSchemaItems(TWO_ITEMS)], ['it_closeout', countSchemaItems(TWO_ITEMS)]]);
  const row = (id) => rows.find((t) => t.id === id) || {};
  eq('summary: an unpublished checklist has a NULL count, never 0', row('it_lobby').item_count ?? null, null);
  eq('summary: a starter says so with a null customer', row('it_closeout').client_id ?? null, null);
  eq('summary: …and a filed one names its customer', row('it_floorcare').client_id, BAY);
  ok('summary: another org never appears', !rows.some((t) => t.id === 'it_other'));

  r = await call({ subpath: 'templates/summary', token: null });
  eq('summary: no session → 401', r.status, 401);

  // COMPLETE past db-max-rows. PostgREST caps EVERY response at 1000 rows whatever
  // .range() asked for; step 6 reads this across ~750 customers x up to 5 checklists, and a
  // summary that silently stops at 1000 would report "no problems" for everyone past it.
  const N = 2500;
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const many = [];
  const manyVers = [];
  for (let i = 0; i < N; i += 1) {
    const id = `it_m_${String(i).padStart(5, '0')}`;
    const vid = `v_m_${String(i).padStart(5, '0')}`;
    many.push(tpl(id, { client_id: `cl_c_${i % 750}`, is_published: true, published_version_id: vid, item_count: i % 2 ? 2 : 1, updated_at: new Date(base + i * 60000).toISOString() }));
    manyVers.push(ver(vid, id, i % 2 ? TWO_ITEMS : ONE_ITEM, 'published'));
  }
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: { users: roster, clients: CLIENTS, permissions: seedPermissions(), userPermissionOverrides: [] } }],
      inspection_templates: [...many, tpl('it_noise', { kind: 'inspection', updated_at: '2026-05-01T00:00:00.000Z' })],
      inspection_template_versions: manyVers,
    },
    logins,
  });
  world.maxRows = 1000;      // Supabase's db-max-rows, the cap this read has to survive
  r = await call({ subpath: 'templates/summary' });
  const big = r.body?.templates || [];
  eq(`summary: complete at ${N} rows past a 1000-row cap`, big.length, N);
  eq('summary: no row repeated across page boundaries', new Set(big.map((t) => t.id)).size, N);
  ok('summary: still newest-first',
    big.every((t, i) => i === 0 || big[i - 1].updated_at > t.updated_at || (big[i - 1].updated_at === t.updated_at && big[i - 1].id > t.id)));
  ok('summary: every row carries its item count, read off the template row itself',
    big.every((t) => t.item_count === countSchemaItems(ONE_ITEM) || t.item_count === countSchemaItems(TWO_ITEMS)));
  const perTemplateReads = world.log.filter((q) => q.table === 'inspection_template_versions').length;
  eq(`summary: NO version schema is read at ${N} templates — that was ~39 MB of jsonb for a column of integers (F4)`,
    perTemplateReads, 0);
  ok('summary: every query is org-scoped',
    world.log.filter((q) => q.table === 'inspection_templates').every((q) => q.eq.organization_id === ORG));
}

// ── F1: crew never get a map of the customer book ────────────────────────────
// `qc.view` is an all-roles key, so before this a crew login could page every customer's
// checklists WITH their client_id — exactly the customer map CS-002's crew read split
// exists to keep out of a crew session. Crew see the checklists of the customers they have
// cleans at, and nothing else: no other customer's, no starters (a starter is an office
// tool), and no company-wide inspection templates, which carry no customer at all.
function seedCrewScope(extra = {}) {
  seed(extra);
  world.tables.crew_assignments = [
    { organization_id: ORG, user_id: 'u_crew', site_id: null, client_id: BAY, source: 'standing_client' },
  ];
}
{
  seedCrewScope();
  let r = await list({ kind: 'checklist' }, 'tok-crew');
  eq('F1: crew get only the customers they have cleans at', idsOf(r).sort(), ['it_floorcare', 'it_fullclean']);
  ok('F1: …never another customer\'s', !idsOf(r).includes('it_lobby'));
  ok('F1: …and never a starter', !idsOf(r).includes('it_closeout'));

  r = await list({}, 'tok-crew');
  eq('F1: with no kind either — a company-wide inspection template carries no customer',
    idsOf(r).sort(), ['it_floorcare', 'it_fullclean']);

  r = await list({ kind: 'checklist', clientId: BAY }, 'tok-crew');
  eq('F1: crew may narrow INSIDE their scope', idsOf(r).sort(), ['it_floorcare', 'it_fullclean']);

  r = await list({ kind: 'checklist', clientId: OLAS }, 'tok-crew');
  eq('F1: a customer outside their scope is a 403, as problems/list answers', r.status, 403);
  eq('F1: …and hands back no rows', r.body?.templates, undefined);

  r = await list({ kind: 'checklist', starters: '1' }, 'tok-crew');
  eq('F1: starters are an office tool — crew asking for them is a 403', r.status, 403);

  // A crew member assigned to nothing reads nothing, never everything.
  seed();
  world.tables.crew_assignments = [
    { organization_id: ORG, user_id: 'u_other', site_id: null, client_id: BAY, source: 'standing_client' },
  ];
  r = await list({ kind: 'checklist' }, 'tok-crew');
  eq('F1: an unassigned crew member reads NO templates, not all of them', idsOf(r), []);

  // The office is untouched.
  seedCrewScope();
  r = await list({ kind: 'checklist' }, 'tok-owner');
  eq('F1: the office still sees every checklist', idsOf(r).sort(), ['it_closeout', 'it_floorcare', 'it_fullclean', 'it_lobby']);
  r = await list({ kind: 'checklist', starters: '1' }, 'tok-mgr');
  eq('F1: …and managers still get the starters', idsOf(r), ['it_closeout']);

  // summary is the office's map of every customer's checklists — the very thing F1 guards.
  seedCrewScope();
  r = await call({ subpath: 'templates/summary', token: 'tok-crew' });
  eq('F1: templates/summary is office-only — crew get 403', r.status, 403);
  eq('F1: …and no rows', r.body?.templates, undefined);
  for (const who of ['owner', 'mgr']) {
    r = await call({ subpath: 'templates/summary', token: `tok-${who}` });
    eq(`F1: ${who} still reads the summary`, r.status, 200);
  }
}

// ── S2: templates/summary opens to EITHER office key ─────────────────────────
// Step 6's Assignments screen is gated `ops.edit` (assign a checklist to a cleaner), and
// every name, item count and problem tile it draws comes from THIS read. Gated on
// `qc.templates.edit` alone, a viewer who may assign but not manage templates saw a screen
// of "Assigned checklist" and four zeroes — a silent, wrong answer rather than a refusal.
// So either office key opens it. Crew hold NEITHER, so F1's boundary is unmoved.
{
  seedCrewScope();
  const overrides = (revokes) => { world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_mgr', grants: [], revokes }]; };

  overrides(['qc.templates.edit']);          // may assign, may not manage templates
  let r = await call({ subpath: 'templates/summary', token: 'tok-mgr' });
  eq('S2: an ops.edit-only viewer reads the summary', r.status, 200);
  ok('S2: …and actually gets the rows', Array.isArray(r.body?.templates) && r.body.templates.length > 0);
  r = await call({ subpath: 'templates/create', method: 'POST', token: 'tok-mgr', body: { name: 'x', kind: 'checklist', clientId: BAY } });
  eq('S2: …and still cannot create one', r.status, 403);

  overrides(['ops.edit']);                   // may manage templates, may not assign
  r = await call({ subpath: 'templates/summary', token: 'tok-mgr' });
  eq('S2: a qc.templates.edit-only viewer reads it too', r.status, 200);

  overrides(['qc.templates.edit', 'ops.edit']);
  r = await call({ subpath: 'templates/summary', token: 'tok-mgr' });
  eq('S2: neither key → 403', r.status, 403);
  eq('S2: …and no rows', r.body?.templates, undefined);

  world.tables.org_state[0].state.userPermissionOverrides = [];
  r = await call({ subpath: 'templates/summary', token: 'tok-crew' });
  eq('S2: crew hold neither, so they are still refused', r.status, 403);
  r = await call({ subpath: 'templates/summary', token: null });
  eq('S2: no session is still a 401, never a 403', r.status, 401);
}

// ── F9: ?starters is a flag, not free text ───────────────────────────────────
{
  seed();
  for (const v of ['1', 'true']) {
    const r = await list({ kind: 'checklist', starters: v });
    eq(`F9: ?starters=${v} is the flag`, idsOf(r), ['it_closeout']);
  }
  for (const v of ['yes', '0', 'false', 'TRUE', '']) {
    const r = await list({ kind: 'checklist', starters: v });
    eq(`F9: ?starters=${v || '(empty)'} is a 400, never "every row"`, r.status, 400);
  }
}

// ── F2: a DB error never leaks provider text (CS-077 class) ──────────────────
{
  const leak = 'relation "inspection_templates" does not exist at character 42';
  for (const [name, subpath, method, body] of [
    ['list', 'templates/list', 'GET', null],
    ['summary', 'templates/summary', 'GET', null],
    ['copy', 'templates/copy', 'POST', { id: 'it_closeout', clientId: BAY }],
    ['create', 'templates/create', 'POST', { name: 'x', kind: 'checklist', clientId: BAY }],
  ]) {
    seed();
    // Only the TEMPLATES table fails: the caller is authenticated and authorized, so the
    // request reaches the branch under test and dies where a real outage would.
    world.failWhen = (q) => q.table === 'inspection_templates';
    world.failMessage = leak;
    const r = await call({ subpath, method, body });
    eq(`F2: ${name} answers 500 on a DB failure`, r.status, 500);
    ok(`F2: ${name} never returns the provider's text`, !JSON.stringify(r.body || {}).includes('relation'),
      `body was ${JSON.stringify(r.body)}`);
    ok(`F2: ${name} carries a stable code the client can branch on`, !!r.body?.code, `body was ${JSON.stringify(r.body)}`);
  }
  // A DELIBERATE refusal keeps its sentence — that is the whole point of writing one.
  seed();
  let r = await call({ subpath: 'templates/create', method: 'POST', body: { name: 'x', kind: 'checklist' } });
  eq('F2: a 400 still says what to do', r.body?.error, CHECKLIST_NEEDS_CUSTOMER);
  r = await list({ kind: 'nope' });
  eq('F2: …and so does a 400 on the list', r.body?.error, TEMPLATE_KIND_MESSAGE);
}

// ── F3: every template read and write is org-scoped, and every id is validated ──
{
  seed();
  let r = await call({ subpath: 'templates/get', query: { id: 'it_other' } });
  eq('F3: another org\'s template is NOT readable by id', r.status, 404);

  seed();
  r = await call({ subpath: 'templates/save', method: 'POST', body: { id: 'it_other', name: 'renamed by another org' } });
  ok('F3: …and not renamable', r.status === 404 || r.status === 400, `got ${r.status}`);
  eq('F3: …the row keeps its name',
    world.tables.inspection_templates.find((t) => t.id === 'it_other')?.name, 'it_other');

  seed();
  r = await call({ subpath: 'templates/publish', method: 'POST', body: { id: 'it_other' } });
  ok('F3: …and not publishable', r.status === 404 || r.status === 400, `got ${r.status}`);

  // Malformed ids never reach the database on ANY template branch.
  const BAD = 'it_x),kind.eq.inspection';
  seed();
  eq('F3: get refuses a malformed id', (await call({ subpath: 'templates/get', query: { id: BAD } })).status, 400);
  eq('F3: save refuses a malformed id', (await call({ subpath: 'templates/save', method: 'POST', body: { id: BAD } })).status, 400);
  eq('F3: publish refuses a malformed id', (await call({ subpath: 'templates/publish', method: 'POST', body: { id: BAD } })).status, 400);
  eq('F3: delete refuses a malformed id', (await call({ subpath: 'templates/delete', method: 'POST', body: { id: BAD } })).status, 400);
  eq('F3: nothing was deleted', world.tables.inspection_templates.length, 6);

  // …and the happy paths still work.
  seed();
  eq('F3: get still reads this org\'s template', (await call({ subpath: 'templates/get', query: { id: 'it_floorcare' } })).status, 200);
  r = await call({ subpath: 'templates/save', method: 'POST', body: { id: 'it_lobby', name: 'Lobby nightly' } });
  eq('F3: save still renames this org\'s template', r.status, 200);
  eq('F3: …and the name landed',
    world.tables.inspection_templates.find((t) => t.id === 'it_lobby')?.name, 'Lobby nightly');
}

// ── F4: the summary reads NO version schema ──────────────────────────────────
// The item counts used to be read from every published version's full schema — about
// 39 MB at 3,750 checklists, measured by the reviewer. `item_count` is denormalized on the
// template row, set at publish and at copy, so the summary is one narrow read.
{
  seed();
  let r = await call({ subpath: 'templates/summary' });
  const versionReads = world.log.filter((q) => q.table === 'inspection_template_versions' && q.op === 'select');
  eq('F4: the summary reads the versions table not at all', versionReads.length, 0);
  eq('F4: …and still carries every count',
    (r.body?.templates || []).map((t) => [t.id, t.item_count]),
    [['it_floorcare', 1], ['it_fullclean', 2], ['it_lobby', null], ['it_closeout', 2]]);

  // …and the count is maintained where the published schema is decided.
  seed();
  await call({ subpath: 'templates/save', method: 'POST', body: { id: 'it_lobby', schema: TWO_ITEMS } });
  await call({ subpath: 'templates/publish', method: 'POST', body: { id: 'it_lobby' } });
  r = await call({ subpath: 'templates/summary' });
  eq('F4: publishing sets the row\'s item_count',
    (r.body?.templates || []).find((t) => t.id === 'it_lobby')?.item_count, 2);

  seed();
  const copied = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_closeout', clientId: OLAS } });
  r = await call({ subpath: 'templates/summary' });
  eq('F4: a published copy carries its count too',
    (r.body?.templates || []).find((t) => t.id === copied.body?.template?.id)?.item_count, 2);
  seed();
  const draftCopy = await call({ subpath: 'templates/copy', method: 'POST', body: { id: 'it_lobby', clientId: BAY } });
  r = await call({ subpath: 'templates/summary' });
  eq('F4: an unpublished copy has no count, not zero',
    (r.body?.templates || []).find((t) => t.id === draftCopy.body?.template?.id)?.item_count, null);
}

if (fails.length) { console.error('\nchecklist-location-route FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-location-route: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
