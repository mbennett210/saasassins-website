// THE OFFICE'S SCAN (QR Wave 2, builder O, 2026-10-17; Matt's answers of 2026-10-16):
//   QR-17  an Account Manager or Operations Manager scans → "A page for that area: the last clean with
//          the cleaner's name and checklist, the photo, open requests at the building, who's on site
//          now, and buttons for Start inspection, New request and Open customer."
//   QR-20  an Admin or the Super Admin → "The same page as managers (QR-17)."
//   QR-19  a Supply Manager → "That building's supply orders and deliveries."
//   QR-21  a Scan button for managers and the office → "Yes."
//   QR-18  a manager's scan saved as a site visit → "No." (nothing is logged about a scan)
//
// What it holds:
//   S. the camera road (lib/scanLanding scanLanding): the session CLAIM decides — every office tier
//      (lib/roles isOfficeRole) → the office's scanner with ?code=, crew and a claim-less login → the
//      cleaner's /my-day/scan as before, a customer → the hub
//   D. where a signed-in office scan lands (staffScanDestination), for EVERY office tier as the pages
//      compute their inputs (the default matrix through lib/roles can): owner, admin, Account Manager,
//      Operations Manager → the area's page; without clients.view → the public page; the Supply
//      Manager → that building's supply orders (the Order Queue on their own first tab), without
//      supplies.view → the public page; the owner's View-as a cleaner is still a cleaner
//   A. the area page's sections from a fixture (lib/areaPage, pure): the last clean with its cleaner
//      and items (through the REAL siteAreaStatus rule), no clean yet, open requests (only unresolved,
//      only this location, newest first, each with lib/clientRequests' own clock), on site now (only
//      this location, only open punches, never a deleted one, one row a person, the read's window),
//      the New request prefill (location and area), and the photo only beside a recorded clean
//   U. the Supply Manager's landing is the Supplies page's building filter, carried in the URL
//   N. nothing is logged: the office's resolve through the REAL EP-386 handler writes no row
//   W. the wiring: the routes, the office scanner's ?code= road, the pages' inputs, the Scan buttons,
//      the area page's reads and buttons, the New request's area, the words
//
// REGRESSION (THE LAW II.3): on the tree before this change (90d7ca9e) the area page, its module, the
// office scanner and every new branch are missing, so the checks report what they wanted.
// Since 2026-11-02 (Matt asked what Open Customer is for), D7 holds the Notes tab's landing gone: it
// fails on 03e08170. Since 2026-11-03 (task 467, Open customer removed), the last two W13 checks hold
// the button, its link and its catalog line gone and the row drawn only with a button: both fail on
// bce5b43d.
//
//   node app/scripts/test-qr-office-scan.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\{\/\*[\s\S]*?\*\/\}/g, ''))).join('\n');

const ORG = '00000000-0000-0000-0000-000000000175';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const L = await import('../src/lib/scanLanding.js').catch(() => ({}));
const A = await import('../src/lib/areaPage.js').catch(() => ({}));
const { crewPaths } = await import('../src/lib/crewPaths.js');
const { ROLES, OFFICE_ROLES, isOfficeRole, seedPermissions, can } = await import('../src/lib/roles.js');
const { isSupplyRole } = await import('../src/lib/navData.js');
const { SUPPLY_MANAGER_TABS, SUPPLY_QUEUE_TABS } = await import('../src/lib/supplies.js');
const { requestClock } = await import('../src/lib/clientRequests.js');
const { siteAreaStatus } = await import('../src/lib/checklistAreas.js');
const { projectAreaScan } = await import('../src/lib/areaScan.js');
const ATT = await import('../src/lib/attendanceReport.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const officeHandler = (await import('../api/scan-codes/[...path].js')).default;

// The suite's own console.error, kept apart: a handler call below silences it while it runs.
const REAL_ERROR = console.error;
let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fnOf = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
async function section(name, f) {
  try { await f(); } catch (e) { fails.push(`§${name} stopped: ${String((e && e.message) || e).split('\n')[0]}`); }
}

const TOKEN = 'O'.repeat(32);
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-17T22:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const staffSession = (role) => ({ user: { id: `auth-${role || 'none'}`, app_metadata: role ? { role, org_user_id: `u_${role}` } : {} } });
const customerSession = { user: { id: 'auth-client', app_metadata: { role: 'client', client_user_id: 'cu_1' } } };

// ── S. the camera road ───────────────────────────────────────────────────────
await section('S', async () => {
  const land = fnOf(L, 'scanLanding');
  const claim = fnOf(L, 'scanClaimRole');
  const K = L.SCAN_LANDING || { LOADING: 'loading', PUBLIC: 'public', REDIRECT: 'redirect' };
  const at = (session, extra = {}) => land({
    token: TOKEN, configured: true, loading: false, signedIn: !!session,
    customer: session?.user?.app_metadata?.role === 'client', role: claim(session), ...extra,
  });
  eq('S1 the office scanner is /areas/scan', L.OFFICE_SCAN_PATH, '/areas/scan');
  eq('S1 …and a camera link carries the code', fnOf(L, 'officeScanPath')('a/b'), '/areas/scan?code=a%2Fb');
  eq('S1 …with no code, the plain scanner', fnOf(L, 'officeScanPath')(), '/areas/scan');
  eq('S2 the claim\'s role is read off the session (app_metadata, II.11)', claim(staffSession('manager')), 'manager');
  eq('S2 …a claim-less login has none', claim(staffSession(null)), null);
  eq('S2 …and no session has none', claim(null), null);
  for (const role of ROLES) {
    const r = at(staffSession(role));
    const want = isOfficeRole(role) ? `/areas/scan?code=${TOKEN}` : `/my-day/scan?code=${TOKEN}`;
    ok(`S3 🔴 a ${role} claim → ${isOfficeRole(role) ? 'the office\'s scanner' : 'the cleaner\'s scan page'} with ?code=`, r?.kind === K.REDIRECT && r?.to === want, JSON.stringify(r));
  }
  ok('S3 …every office tier the scanner takes is lib/roles\' own list (no hand copy)', OFFICE_ROLES.length >= 4 && OFFICE_ROLES.every((r) => at(staffSession(r))?.to === `/areas/scan?code=${TOKEN}`));
  const none = at(staffSession(null));
  ok('S4 a claim-less staff login keeps the cleaner\'s road (that page decides by the person on screen)', none?.kind === K.REDIRECT && none?.to === `/my-day/scan?code=${TOKEN}`, JSON.stringify(none));
  const cust = at(customerSession);
  ok('S5 a customer still goes to the hub', cust?.kind === K.REDIRECT && cust?.to === `/hub/scan?code=${TOKEN}`, JSON.stringify(cust));
  eq('S6 ?view=public keeps an office login on the public page', at(staffSession('owner'), { view: 'public' })?.kind, K.PUBLIC);
  eq('S6 …and the demo (no sign-in) shows the public page', land({ token: TOKEN, configured: false, signedIn: true, role: 'owner' })?.kind, K.PUBLIC);
});

// ── D. where an office scan lands ────────────────────────────────────────────
const LOC = { siteId: 's_club', clientId: 'cl_coral', areaId: 'area_rest', siteName: 'Clubhouse', building: 'Coral Bay HOA', area: 'Restrooms' };
const PERMS = seedPermissions();
// What the scan pages hand the rule, for a person: the EFFECTIVE user's role and keys.
const inputsFor = (user, perms = PERMS) => ({
  office: isOfficeRole(user.role),
  supply: isSupplyRole(user),
  canSeeCustomer: can(user, 'clients.view', perms, []),
  canSeeSupplies: can(user, 'supplies.view', perms, []),
});
await section('D', async () => {
  const dest = fnOf(L, 'staffScanDestination');
  eq('D0 the area page\'s path', fnOf(L, 'areaPagePath')('s/1', 'a&b'), '/areas/s%2F1/a%26b');
  const tiers = [
    ['the Super Admin', { id: 'u_o', role: 'owner' }],
    ['an Admin', { id: 'u_a', role: 'admin' }],
    ['an Account Manager', { id: 'u_am', role: 'manager', managerLevel: 'account' }],
    ['an Operations Manager', { id: 'u_om', role: 'manager', managerLevel: 'operations' }],
  ];
  for (const [who, user] of tiers) {
    const r = dest({ loc: LOC, token: TOKEN, clean: null, ...inputsFor(user) });
    ok(`D1 🔴 ${who} → the area's page (QR-17 / QR-20)`, r?.kind === 'area' && r?.to === '/areas/s_club/area_rest', JSON.stringify(r));
  }
  // Without the customer page's key, as today: the public page.
  const noView = PERMS.map((p) => (p.id === 'clients.view' ? { ...p, roles: (p.roles || []).filter((x) => x !== 'manager') } : p));
  const am = { id: 'u_am', role: 'manager', managerLevel: 'account' };
  const pub = dest({ loc: LOC, token: TOKEN, clean: null, ...inputsFor(am, noView) });
  ok('D2 🔴 an office login WITHOUT clients.view → this area\'s public page', pub?.kind === 'public' && pub?.to === `/scan/${TOKEN}?view=public`, JSON.stringify(pub));
  const loose = dest({ loc: { ...LOC, areaId: null }, token: TOKEN, ...inputsFor({ role: 'owner' }) });
  eq('D2 …and a code with no area to open, too', loose?.kind, 'public');
  const sm = { id: 'u_sm', role: 'supply_manager' };
  const smIn = inputsFor(sm);
  ok('D3 the Supply Manager is an office tier and holds supplies.view, not clients.view, by default', smIn.office && smIn.supply && smIn.canSeeSupplies && !smIn.canSeeCustomer, JSON.stringify(smIn));
  const smDest = dest({ loc: LOC, token: TOKEN, clean: null, ...smIn });
  ok('D4 🔴 the Supply Manager → that building\'s supply orders (QR-19)', smDest?.kind === 'supplies' && smDest?.to === fnOf(L, 'supplyScanPath')('cl_coral'), JSON.stringify(smDest));
  const smGranted = dest({ loc: LOC, token: TOKEN, clean: null, ...smIn, canSeeCustomer: true });
  eq('D4 …by role: a Supply Manager granted clients.view still gets the supply orders', smGranted?.kind, 'supplies');
  const smNoKey = dest({ loc: LOC, token: TOKEN, clean: null, ...smIn, canSeeSupplies: false });
  ok('D5 a Supply Manager without supplies.view → the public page', smNoKey?.kind === 'public' && smNoKey?.to === `/scan/${TOKEN}?view=public`, JSON.stringify(smNoKey));
  const smLoose = dest({ loc: { ...LOC, clientId: null }, token: TOKEN, ...smIn });
  eq('D5 …and at a location with no customer (no building to filter)', smLoose?.kind, 'public');
  const clean = { id: 'j1', siteId: 's_club', clientId: 'cl_coral', status: 'in_progress' };
  const viewAs = dest({ loc: LOC, token: TOKEN, clean, ...inputsFor({ id: 'u_c', role: 'crew' }) });
  ok('D6 🔴 the owner\'s View-as a cleaner is still a cleaner (their checklist, never the area page)', viewAs?.kind === 'checklist' && viewAs?.to === crewPaths.checklist('j1', 'area_rest'), JSON.stringify(viewAs));
  ok('D7 the provisional customer-page destination is gone (II.5): no office answer opens /clients', [...tiers.map(([, u]) => u)].every((u) => !String(dest({ loc: LOC, token: TOKEN, ...inputsFor(u) })?.to || '').startsWith('/clients/')));
  ok('D7 🔴 …nor does the scan module keep the Notes tab with the area marked (Wave 1\'s landing, gone 2026-11-02; II.5)', !('officeAreaPath' in L));
});

// ── A. the area page's sections (lib/areaPage) ───────────────────────────────
const SITES = [
  { id: 's_club', clientId: 'cl_coral', name: 'Clubhouse', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }] },
  { id: 's_pool', clientId: 'cl_coral', name: 'Pool house', cleaningAreas: [{ id: 'area_deck', label: 'Deck' }] },
];
const CLIENTS = [{ id: 'cl_coral', name: 'Coral Bay HOA' }];
const USERS = [
  { id: 'u_ana', name: 'Ana Silva', role: 'crew', status: 'active' },
  { id: 'u_bo', name: 'Bo Chen', role: 'crew', status: 'active' },
  { id: 'u_cy', name: 'Cy Park', role: 'crew', status: 'active' },
];
await section('A', async () => {
  const where = fnOf(A, 'areaPageWhere');
  const w = where({ siteId: 's_club', areaId: 'area_rest', sites: SITES, clients: CLIENTS });
  ok('A1 the page names the area, the building and the customer', w?.area?.label === 'Restrooms' && w?.site?.name === 'Clubhouse' && w?.client?.name === 'Coral Bay HOA', JSON.stringify(w));
  eq('A1 …an area no longer on the location is not a page', where({ siteId: 's_club', areaId: 'area_gone', sites: SITES, clients: CLIENTS }), null);
  eq('A1 …nor a location that is gone', where({ siteId: 's_gone', areaId: 'area_rest', sites: SITES, clients: CLIENTS }), null);

  // The last clean, through the REAL rule EP-200 runs (lib/checklistAreas siteAreaStatus).
  const schema = { areas: [
    { id: 'sec_rest', label: 'Restrooms', siteAreaId: 'area_rest', items: [{ id: 'i_toilets', label: 'Toilets sanitized' }, { id: 'i_spots', label: 'Spots treated', naAllowed: true }] },
    { id: 'sec_lobby', label: 'Lobby', siteAreaId: 'area_lobby', items: [{ id: 'i_glass', label: 'Glass' }] },
  ] };
  const done = iso(NOW - 3 * HOUR);
  const result = {
    id: 'cr_1', client_submit_id: 'cs_1', job_id: 'j_tonight', site_id: 's_club', client_id: 'cl_coral',
    completed_by_user_id: 'u_ana', performed_at: done, template_snapshot: { name: 'Nightly clean', schema },
    items: [{ key: 'i_toilets', checked: true }, { key: 'i_spots', na: true }, { key: 'i_glass', notCompleted: true, notCompletedReason: 'Door locked' }],
    area_completions: { sec_rest: done },
  };
  const answer = { siteId: 's_club', areas: siteAreaStatus({ cleaningAreas: SITES[0].cleaningAreas, results: [result], media: [] }) };
  const last = fnOf(A, 'areaLastClean')(answer, 'area_rest');
  ok('A2 🔴 the last clean: when, by whom (the cleaner\'s id for the roster) and which checklist', last?.lastCleanedAt === done && last?.lastCleanedByUserId === 'u_ana' && last?.checklistName === 'Nightly clean' && last?.resultId === 'cr_1', JSON.stringify(last));
  ok('A2 …and the clean it belongs to, so "Open the full checklist" reads that clean\'s rows', last?.jobId === 'j_tonight', JSON.stringify(last));
  const items = fnOf(A, 'areaItemsView')(last) || [];
  ok('A3 that area\'s items as done and N/A', items.length === 2 && items[0]?.state === 'done' && items[1]?.state === 'na', JSON.stringify(items));
  const lobbyRow = answer.areas.find((a) => a.areaId === 'area_lobby');
  ok('A3 …an area whose task was marked NOT COMPLETED records no clean (the area rule), so the page shows none for it', lobbyRow?.lastCleanedAt === null
    && fnOf(A, 'areaLastClean')(answer, 'area_lobby') === null, JSON.stringify(lobbyRow));
  const ncView = fnOf(A, 'areaItemsView')({ items: [{ key: 'k', label: 'Glass', state: 'notcompleted', reason: 'Door locked' }, { key: 'k2', label: 'Mats', state: 'notdone' }] }) || [];
  ok('A3 …the page shows not completed WITH the reason, and not done as not done', ncView[0]?.state === 'notcompleted' && ncView[0]?.reason === 'Door locked' && ncView[1]?.state === 'notdone' && ncView[1]?.reason == null, JSON.stringify(ncView));
  const pub = projectAreaScan({ building: 'B', area: { ...last, items: [...(last?.items || []), { key: 'x', label: 'Glass', state: 'notcompleted', reason: 'Door locked' }] }, nowMs: NOW });
  ok('A3 🔴 …and the PUBLIC projection never carries the clean\'s id or a reason', !/j_tonight|Door locked|jobId|reason/.test(JSON.stringify(pub)), JSON.stringify(pub));
  eq('A4 no clean yet → no last clean (the page says "No clean recorded yet")', fnOf(A, 'areaLastClean')({ areas: siteAreaStatus({ cleaningAreas: SITES[0].cleaningAreas, results: [], media: [] }) }, 'area_rest'), null);
  eq('A4 …nor for an area the answer does not hold', fnOf(A, 'areaLastClean')(answer, 'area_nope'), null);
  const photoRow = { ...last, photo: { id: 'm1', url: 'https://x/a.jpg', thumbUrl: 'https://x/a.t.jpg', createdAt: done, kind: 'image' } };
  eq('A5 the photo shows beside a recorded clean', fnOf(A, 'areaPhoto')(photoRow)?.id, 'm1');
  eq('A5 …never with no clean on record', fnOf(A, 'areaPhoto')({ ...photoRow, lastCleanedAt: null }), null);

  // Open requests at this location.
  const P = (id, o) => ({ id, client_id: 'cl_coral', site_id: 's_club', title: id, type: 'request', priority: 'medium', status: 'open', created_at: iso(NOW - 2 * HOUR), first_reply_at: null, ...o });
  const problems = [
    P('pr_old', { created_at: iso(NOW - 30 * HOUR), type: 'complaint', priority: 'urgent' }),
    P('pr_new', { created_at: iso(NOW - 20 * MIN) }),
    P('pr_done', { status: 'resolved', resolved_at: iso(NOW - HOUR) }),
    P('pr_pool', { site_id: 's_pool' }),
    P('pr_mid', { created_at: iso(NOW - 5 * HOUR), type: 'issue', status: 'in_progress' }),
  ];
  const reqs = fnOf(A, 'areaPageRequests')({ problems, siteId: 's_club', now: NOW, settings: {} }) || [];
  eq('A6 🔴 open requests: only unresolved, only this location, NEWEST first', reqs.map((r) => r.id).join(','), 'pr_new,pr_mid,pr_old');
  ok('A6 …each with its type and priority', reqs.find((r) => r.id === 'pr_old')?.type === 'complaint' && reqs.find((r) => r.id === 'pr_old')?.priority === 'urgent');
  const want = requestClock({ ...problems[0] }, { now: NOW, settings: {} });
  const got = reqs.find((r) => r.id === 'pr_old')?.left;
  ok('A6 …and its clock from lib/clientRequests (the queue\'s own rule, never a second one)', !!got && got.phase === want.phase && got.state === want.state && got.minutes === want.minutes, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  eq('A6 …none open → an empty list', (fnOf(A, 'areaPageRequests')({ problems: [problems[2], problems[3]], siteId: 's_club', now: NOW }) || []).length, 0);

  // On site now.
  const E = (id, o) => ({ id, user_id: 'u_ana', user_name: 'Ana Silva', site_id: 's_club', clock_in_at: iso(NOW - 2 * HOUR), clock_out_at: null, status: 'active', ...o });
  const entries = [
    E('e_ana'),
    E('e_ana_again', { clock_in_at: iso(NOW - 4 * HOUR) }),
    E('e_bo_out', { user_id: 'u_bo', clock_out_at: iso(NOW - HOUR), status: 'completed' }),
    E('e_cy_pool', { user_id: 'u_cy', site_id: 's_pool' }),
    E('e_bo_deleted', { user_id: 'u_bo', status: 'voided' }),
    E('e_bo_noshow', { user_id: 'u_bo', status: 'no_show' }),
    E('e_cy_old', { user_id: 'u_cy', clock_in_at: iso(NOW - 30 * HOUR) }),
    E('e_cy_new', { user_id: 'u_cy', clock_in_at: iso(NOW - 10 * MIN) }),
    E('e_ghost', { user_id: null }),
  ];
  const here = fnOf(A, 'onSiteNow')({ entries, siteId: 's_club', users: USERS, now: NOW }) || [];
  eq('A7 🔴 on site now: only this location, only open punches, one row a person, who arrived last first', here.map((h) => h.userId).join(','), 'u_cy,u_ana');
  ok('A7 …named from the roster, since their first open clock-in here', here.find((h) => h.userId === 'u_ana')?.name === 'Ana Silva' && here.find((h) => h.userId === 'u_ana')?.since === iso(NOW - 4 * HOUR), JSON.stringify(here));
  ok('A7 …a DELETED or no-show punch is not a clock-in (the attendance report\'s own set)', ATT.NOT_A_PUNCH instanceof Set && ATT.NOT_A_PUNCH.has('voided') && ATT.NOT_A_PUNCH.has('no_show') && !here.some((h) => h.userId === 'u_bo'));
  ok('A7 …a punch left open longer than the window is a forgotten clock-out, not someone here', !here.some((h) => h.since === iso(NOW - 30 * HOUR)));
  eq('A7 …nobody clocked in → an empty list', (fnOf(A, 'onSiteNow')({ entries: [entries[2]], siteId: 's_club', users: USERS, now: NOW }) || []).length, 0);
  const win = fnOf(A, 'onSiteReadWindow')(NOW);
  ok('A8 the read covers the window the rule judges (from now − ON_SITE_WINDOW_HOURS to now)', Number.isFinite(A.ON_SITE_WINDOW_HOURS) && A.ON_SITE_WINDOW_HOURS > 0
    && win?.fromIso === iso(NOW - A.ON_SITE_WINDOW_HOURS * HOUR) && Date.parse(win?.toIso) >= NOW, JSON.stringify(win));

  const pre = fnOf(A, 'areaRequestPrefill')({ siteId: 's_club', area: { id: 'area_rest', label: 'Restrooms' } });
  ok('A9 🔴 New request opens on this location and this area, its title the area', pre?.presetSiteId === 's_club' && pre?.presetSiteAreaId === 'area_rest' && pre?.presetTitle === 'Restrooms', JSON.stringify(pre));
  const rows = [{ id: 'cr_0' }, { id: 'cr_1', items: [] }];
  eq('A10 "Open the full checklist" finds the clean\'s row by its id', fnOf(A, 'checklistRowFor')(rows, 'cr_1')?.id, 'cr_1');
  eq('A10 …and nothing when it is not there', fnOf(A, 'checklistRowFor')(rows, 'cr_9'), null);
});

// ── U. the Supply Manager's landing ──────────────────────────────────────────
await section('U', async () => {
  const to = fnOf(L, 'supplyScanPath')('cl/1');
  const u = new URL(to || '/', 'https://x.example');
  eq('U1 the Supplies page', u.pathname, '/supplies');
  eq('U1 …filtered to the building (the Customer filter\'s ?cust=)', u.searchParams.get('cust'), 'cl/1');
  eq('U1 …on the Supply Manager\'s own first tab, the one their Home opens on', u.searchParams.get('status'), SUPPLY_MANAGER_TABS[0]);
  ok('U1 …a tab the queue knows', SUPPLY_QUEUE_TABS.includes(u.searchParams.get('status')));
  // Read whole: a '/*' inside one of the page's strings would make strip() swallow code.
  const page = read('src/pages/Supplies.jsx');
  ok('U2 the page carries the building in its URL (useSearchParams, replace) and hands it to the queue', /params\.get\('cust'\)/.test(page) && /\{ replace: true \}/.test(page)
    && /<SupplyQueue[\s\S]*?custFilter=\{custFilter\}/.test(page));
  ok('U2 …as a FilterSelect in the .filter-bar (reportKit CustomerFilter)', /<div className="filter-bar">[\s\S]*?<CustomerFilter /.test(page)
    && /<FilterSelect /.test(read('src/pages/reports/reportKit.jsx').split('export function CustomerFilter')[1] || ''));
  const q = strip(read('src/components/SupplyQueue.jsx'));
  ok('U3 the queue opens on the ?status= tab the link names', /tabs\.includes\(params\.get\('status'\)\) \? params\.get\('status'\)/.test(q));
});

// ── N. nothing is logged (QR-18) ─────────────────────────────────────────────
await section('N', async () => {
  __resetRateLimit();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 2,
        state: {
          company: { name: 'Clean Space', timezone: 'America/New_York' },
          users: [
            { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mgr', email: 'mgr@example.test' },
            { id: 'u_sm', role: 'supply_manager', status: 'active', name: 'Sam', email: 'sm@example.test' },
          ],
          permissions: seedPermissions(), userPermissionOverrides: [],
          clients: CLIENTS, sites: SITES, opsSettings: {}, notifications: [],
        },
      }],
      area_scan_codes: [{ id: 'c1', organization_id: ORG, site_id: 's_club', area_id: 'area_rest', token: TOKEN, created_at: iso(NOW - 48 * HOUR), created_by: 'u_mgr', revoked_at: null, revoked_by: null }],
      jobs: [], crew_assignments: [], activity_log: [], activity_log_baseline: [],
    },
    logins: {
      'tok-mgr': { id: 'auth-mgr', email: 'mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      'tok-sm': { id: 'auth-sm', email: 'sm@example.test', app_metadata: { role: 'supply_manager', org_user_id: 'u_sm', org_id: ORG } },
    },
  });
  const call = (token) => new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { resolve({ status: this.statusCode, body: b ?? null }); return this; },
    };
    console.error = () => {};
    Promise.resolve(officeHandler({ method: 'GET', headers: { authorization: `Bearer ${token}` }, query: { subpath: 'resolve', token: TOKEN }, body: {} }, res))
      .finally(() => { console.error = REAL_ERROR; });
  });
  const before = world.log.length;
  const mgr = await call('tok-mgr');
  const dest = fnOf(L, 'staffScanDestination')({ loc: mgr.body, token: TOKEN, ...inputsFor({ id: 'u_mgr', role: 'manager' }) });
  ok('N1 the office\'s EP-386 answer + the rule → the area page', mgr.status === 200 && dest?.to === '/areas/s_club/area_rest', `${mgr.status} ${JSON.stringify(mgr.body)} → ${JSON.stringify(dest)}`);
  const sm = await call('tok-sm');
  const smDest = fnOf(L, 'staffScanDestination')({ loc: sm.body, token: TOKEN, ...inputsFor({ id: 'u_sm', role: 'supply_manager' }) });
  ok('N2 a Supply Manager resolves any building\'s code (an office tier) → its supply orders', sm.status === 200 && smDest?.kind === 'supplies', `${sm.status} ${JSON.stringify(sm.body)} → ${JSON.stringify(smDest)}`);
  const writes = world.log.slice(before).filter((q) => ['insert', 'update', 'upsert', 'delete'].includes(q.op));
  ok('N3 🔴 a scan writes NOTHING: no site visit, no activity row, no row of any kind (QR-18)', writes.length === 0, JSON.stringify(writes.map((w) => `${w.op} ${w.table}`)));
  const scanner = strip(read('src/pages/OfficeScan.jsx'));
  ok('N4 …and the office\'s scanner page calls no write: it resolves and navigates', scanner.length > 0 && !/qcApi\.|timeApi\.|createProblem|updateProblem|logActivity|activityApi|dispatch\(/.test(scanner));
});

// ── W. the wiring ────────────────────────────────────────────────────────────
await section('W', async () => {
  const app = read('src/App.jsx');
  ok('W1 /areas/scan is the office\'s scanner route (inside the office shell, every login; the page hands a cleaner on)', /<Route path="areas\/scan" element=\{<RequirePerm perm="time\.clock"><OfficeScan \/><\/RequirePerm>\} \/>/.test(app)
    && /const OfficeScan = lazyRoute\(\(\) => import\('\.\/pages\/OfficeScan'\)\)/.test(app));
  ok('W2 /areas/:siteId/:areaId is the area page (clients.view), a fresh page per location and area', /<Route path="areas\/:siteId\/:areaId" element=\{<RequirePerm perm="clients\.view"><KeyedByParam name="siteId"><KeyedByParam name="areaId"><AreaPage \/><\/KeyedByParam><\/KeyedByParam><\/RequirePerm>\} \/>/.test(app)
    && /const AreaPage = lazyRoute\(\(\) => import\('\.\/pages\/AreaPage'\)\)/.test(app));
  const scanner = strip(read('src/pages/OfficeScan.jsx'));
  ok('W3 the office\'s scanner takes ?code= ONCE (a ref), drops it from the address and REPLACES the page', /searchParams\.get\(SCAN_CODE_PARAM\)/.test(scanner) && /handledCode\.current === codeParam/.test(scanner)
    && /next\.delete\(SCAN_CODE_PARAM\)/.test(scanner) && /setSearchParams\(next, \{ replace: true \}\)/.test(scanner) && /navigate\(dest\.to, link \? \{ replace: true \} : \{ state: nav \}\)/.test(scanner));
  ok('W3 …the camera and the link take ONE road: resolveScanCode, then staffScanDestination', /resolveScanCode\(/.test(scanner) && /staffScanDestination\(\{/.test(scanner) && /resolveToken\(token, \{ link: true \}\)/.test(scanner));
  ok('W3 …with the ONE scanner and the camera never started for a ?code= arrival', /\{cameraOn && <QrScanner /.test(scanner) && /useState\(\(\) => !codeParam\)/.test(scanner));
  ok('W4 🔴 …and a cleaner on screen (the owner\'s View-as) is handed to the cleaner\'s scan page with the code', /isOfficeRole\(me\?\.role\)/.test(scanner) && /<Navigate to=\{crewPaths\.scan\(codeParam\)\} replace \/>/.test(scanner));
  ok('W4 …the Supply Manager and the two keys are the effective user\'s', /isSupplyRole\(me\)/.test(scanner) && /usePermission\('clients\.view'\)/.test(scanner) && /usePermission\('supplies\.view'\)/.test(scanner));
  ok('W5 the office\'s words are catalog lines (officeScan.*)', /t\('officeScan\.hint'\)/.test(scanner) && /'officeScan\.hint':/.test(read('src/i18n/catalog/en.js')));
  const pubPage = strip(read('src/pages/PublicAreaScan.jsx'));
  ok('W6 🔴 the public page hands the router the session\'s CLAIM role, never the store', /role: scanClaimRole\(session\)/.test(pubPage) && !/from '\.\.\/store'|useStore/.test(pubPage));
  const crew = strip(read('src/pages/crew/CrewScan.jsx'));
  ok('W7 the cleaner\'s scan page hands the rule the same inputs (one rule for both pages)', /supply: isSupplyRole\(me\)/.test(crew) && /canSeeSupplies/.test(crew));
  const home = strip(read('src/pages/ManagerHome.jsx'));
  ok('W8 🔴 the manager\'s Home has the dashed Scan button (the kit\'s add tile, like the cleaner\'s and the customer\'s), with its referrer', /className="add-tile mgrh-scan"/.test(home) && /to=\{OFFICE_SCAN_PATH\}/.test(home) && /state=\{nav\}/.test(home));
  const fnav = strip(read('src/components/FloatingNav.jsx'));
  ok('W9 …the office\'s phone menu leads with Scan, beside Search (every office role, every page)', /navigate\(OFFICE_SCAN_PATH, \{ state: nav \}\)/.test(fnav) && /tr\('officeScan\.menu'\)/.test(fnav));
  const side = strip(read('src/components/Sidebar.jsx'));
  ok('W10 …and the desktop sidebar\'s footer (a webcam, or "Take a photo of the code")', /navigate\(OFFICE_SCAN_PATH, \{ state: nav \}\)/.test(side) && /t\('officeScan\.menu'\)/.test(side));
  const pg = strip(read('src/pages/AreaPage.jsx'));
  ok('W11 the area page reads EP-200 for the last clean and its photo', /qcApi\.areaStatus\(\{ siteId/.test(pg) && /areaLastClean\(/.test(pg) && /areaPhoto\(/.test(pg));
  ok('W11 …the location\'s open requests (a complete read, narrowed to it) with the queue\'s clocks', /qcApi\.listOpenProblems\(\{ siteIds: \[siteId\] \}\)/.test(pg) && /areaPageRequests\(/.test(pg));
  ok('W11 …who is on site from the punch read Shift Check-in uses, narrowed to the location', /timeApi\.entriesAll\(\{[^}]*siteIds: \[siteId\][^}]*lite: true/.test(pg) && /onSiteNow\(/.test(pg) && /onSiteReadWindow\(/.test(pg));
  ok('W12 the cleaner by the roster (Avatar user=), the full checklist in ChecklistResultModal', /<Avatar user=\{/.test(pg) && /<ChecklistResultModal /.test(pg) && /checklistRowFor\(/.test(pg));
  ok('W13 the two buttons: Start inspection (this location), New request (this location and area)', /`\/inspections\?fill=1&siteId=\$\{encodeURIComponent\(siteId\)\}`/.test(pg)
    && /<WorkOrderModal[\s\S]*?\{\.\.\.prefill\}/.test(pg) && /areaRequestPrefill\(/.test(pg));
  // Task 467 (Clean Corner's queue, the 2026-11-03 call; Matt: "I don't need the open customer there").
  ok('W13 🔴 …and no Open customer: the page links to no customer page and the catalog keeps no line for it (II.5)', !/areaPage\.openCustomer/.test(pg) && !/\/clients\//.test(pg)
    && !/'areaPage\.openCustomer':/.test(read('src/i18n/catalog/en.js')));
  ok('W13 🔴 …the button row draws only when one of them shows (no empty row, no stray gap above the cards)', /\{\(canInspect \|\| canProblems\) && \(\s*<div className="areapg-actions">/.test(pg));
  ok('W13 …a ticket opens in the ONE work-order drawer, in place', /<WorkOrderDrawer\s/.test(pg));
  ok('W14 its Back is the referrer (BackLink), and every word a catalog line', /<BackLink /.test(pg) && /t\('areaPage\.lastClean\.title'\)/.test(pg) && /'areaPage\.lastClean\.title':/.test(read('src/i18n/catalog/en.js')));
  const modal = strip(read('src/components/WorkOrderModal.jsx'));
  ok('W15 🔴 the office\'s create sends the area (siteAreaId) only while the preset location stands', /presetTitle/.test(modal) && /presetSiteAreaId/.test(modal)
    && /presetSiteAreaId && form\.siteId === presetSiteId \? \{ siteAreaId: presetSiteAreaId \} : \{\}/.test(modal));
  const from = read('src/hooks/useFromHere.js');
  ok('W16 a page opened from the area page or the scanner names it on its back pill', /\^\\\/areas\\\/\[\^\/\]\+\\\/\[\^\/\]\+\$/.test(from) && /'\/areas\/scan'|OFFICE_SCAN_PATH/.test(from));
  const routes = read('scripts/app-routes.mjs');
  ok('W17 the route sweeps open a seeded area page', /'\/areas\/:siteId\/:areaId': \['\/areas\/st_seed_mtb-clbhs\/area_lobby'/.test(routes));
  const rules = read('../UI_RULES.md');
  ok('W18 UI_RULES §175 is the area page, and §172 names the office\'s destinations and Scan button', /^## 175\. /m.test(rules) && /\/areas\/scan/.test(rules.split('## 172.')[1] || ''));
  ok('W19 nothing in the page or the scanner writes a site visit (QR-18)', !/siteVisit|site_visit|scanLog|scan_log/i.test(pg + scanner));
  ok('W20 the files exist', ['src/lib/areaPage.js', 'src/pages/AreaPage.jsx', 'src/pages/OfficeScan.jsx'].every((f) => existsSync(path.join(APP, f))));
});

console.error = REAL_ERROR;
if (fails.length) { console.error('\nqr-office-scan FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nqr-office-scan: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
