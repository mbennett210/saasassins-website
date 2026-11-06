// ONE PRINTED CODE, A VIEW PER PERSON (QR Wave 1, 2026-10-16; Matt: "the QR code opens a different
// view depending on who is logged in"; UI_RULES §172).
//
// Every label is the same link, `/scan/<token>`. What it opens depends on who is signed in on this
// browser; the decision is ONE pure module, src/lib/scanLanding.js, and the pages read it.
//
// What it holds:
//   S. the router (scanLanding): every session kind — signed out, the session still loading, a
//      customer login, every staff role, the login-free demo — plus `?view=public` and a malformed token
//   I. the one Sign-in line: shown only where sign-in exists and nobody is signed in, and its
//      `from` brings the person straight back to this code (Login lands on `state.from.pathname`)
//   D. where a signed-in staff member's scan lands (staffScanDestination): a cleaner at today's
//      checklist there or — no checklist there, or not on today's clean — the server's answer (EP-420,
//      test-qr-fill-in.mjs), an office login at the area's page (QR-17 / QR-20, Wave 2;
//      test-qr-office-scan.mjs holds every office tier and the Supply Manager) or — without
//      `clients.view` — the public page; the owner's View-as a cleaner lands on that cleaner's checklist
//   R. the resolvers' answers composed with the rule, through the REAL EP-386 / EP-387 handlers over
//      fake-supabase.mjs (no network, no credentials, no live project — BUILD_INTEGRITY §6b)
//   W. the wiring the pages need: the public page reads the session (never the store), sends a
//      signed-in person on with `replace` and costs them no public read; both scan pages take
//      `?code=`, resolve it once, drop it from the address and replace the page; the refusal
//      links to the public page; nothing marks an area on the customer's page any more
//
// REGRESSION (THE LAW II.3): on the tree before this change (91805d09) the module does not exist
// and neither page reads `?code=`, so every check reports what it wanted. Since 2026-11-02 (Open
// customer opened the customer's page at Overview; the button itself went 2026-11-03, task 467,
// held by test-qr-office-scan.mjs W13), D5 and W13 hold the Notes tab's area mark gone: D5 and the
// first two W13 checks fail on 03e08170.
//
//   node app/scripts/test-qr-scan-landing.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\{\/\*[\s\S]*?\*\/\}/g, ''))).join('\n');

const ORG = '00000000-0000-0000-0000-000000000172';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld } = await import('./fake-supabase.mjs');
installFakeSupabase();

const L = await import('../src/lib/scanLanding.js').catch(() => ({}));
const { crewPaths } = await import('../src/lib/crewPaths.js');
const { isClientSession } = await import('../src/lib/clientHub.js');
const { isOfficeRole, ROLES, seedPermissions } = await import('../src/lib/roles.js');
const codesLib = await import('../src/lib/scanCodes.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const officeHandler = (await import('../api/scan-codes/[...path].js')).default;
const hubHandler = (await import('../api/hub/[...path].js')).default;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (name) => (typeof L[name] === 'function' ? L[name] : () => undefined);
async function section(name, f) {
  try { await f(); } catch (e) { fails.push(`§${name} stopped: ${String((e && e.message) || e).split('\n')[0]}`); }
}

const TOKEN = 'L'.repeat(32);
// Sessions as supabase-js hands them over: the role rides app_metadata (the CLAIM, II.11).
const staffSession = (role) => ({ user: { id: `auth-${role}`, app_metadata: role ? { role, org_user_id: `u_${role}` } : {} } });
const customerSession = { user: { id: 'auth-client', app_metadata: { role: 'client', client_user_id: 'cu_1' } } };

// ── S. the router ────────────────────────────────────────────────────────────
await section('S', async () => {
  const land = fn('scanLanding');
  // The module's own constant, else (pre-fix, when it does not exist) the words it must use — so
  // nothing here can pass by comparing undefined with undefined.
  const K = L.SCAN_LANDING || { LOADING: 'loading', PUBLIC: 'public', REDIRECT: 'redirect' };
  const at = (session, extra = {}) => land({ token: TOKEN, configured: true, loading: false, signedIn: !!session, customer: isClientSession(session), role: (L.scanClaimRole || (() => null))(session), ...extra });
  eq('S1 signed out → the public page', at(null)?.kind, K.PUBLIC);
  eq('S2 the session still being read → the page\'s loading state (no flash of the public card, no wrong redirect)', at(null, { loading: true })?.kind, K.LOADING);
  const cust = at(customerSession);
  ok('S3 🔴 a CUSTOMER login → /hub/scan?code=<token> (replace)', cust?.kind === K.REDIRECT && cust?.to === `/hub/scan?code=${TOKEN}`, JSON.stringify(cust));
  // QR Wave 2 (QR-21): an OFFICE claim goes to the office's own scanner; crew and a claim-less login
  // keep the cleaner's page, which decides by the person on screen.
  for (const role of [...ROLES, null]) {
    const r = at(staffSession(role));
    const want = isOfficeRole(role) ? `/areas/scan?code=${TOKEN}` : `/my-day/scan?code=${TOKEN}`;
    ok(`S4 🔴 a staff login (${role || 'claim-less'}) → ${want.split('?')[0]}?code=<token>`, r?.kind === K.REDIRECT && r?.to === want, JSON.stringify(r));
  }
  eq('S5 the public view is ?view=public', L.SCAN_VIEW_PUBLIC, 'public');
  eq('S5 ?view=public keeps a signed-in staff member on the public page', at(staffSession('owner'), { view: 'public' })?.kind, K.PUBLIC);
  eq('S5 …and a customer', at(customerSession, { view: 'public' })?.kind, K.PUBLIC);
  eq('S5 …any other ?view= does not', at(staffSession('owner'), { view: 'office' })?.kind, K.REDIRECT);
  eq('S6 the login-free demo (sign-in not configured) → the public page, whatever is on the device', land({ token: TOKEN, configured: false, signedIn: true, customer: false })?.kind, K.PUBLIC);
  eq('S6 …even while "loading"', land({ token: TOKEN, configured: false, loading: true })?.kind, K.PUBLIC);
  for (const bad of ['not-a-token', `${TOKEN}A`, '', null]) {
    eq(`S7 a malformed token (${JSON.stringify(bad)}) never redirects: the page says "no longer active"`, land({ token: bad, configured: true, signedIn: true })?.kind, K.PUBLIC);
  }
  eq('S8 the hub\'s scan path is spelled once (hubNav re-exports it)', (await import('../src/pages/hub/hubNav.js')).HUB_SCAN_PATH, L.HUB_SCAN_PATH);
  eq('S8 …and crewPaths.scan(code) is the cleaner app\'s', crewPaths.scan('a/b'), '/my-day/scan?code=a%2Fb');
  eq('S8 …with no code, the plain scan page as before', crewPaths.scan(), '/my-day/scan');
});

// ── I. the one Sign-in line ──────────────────────────────────────────────────
await section('I', async () => {
  const shows = fn('scanShowsSignIn');
  eq('I1 shown on the public card when sign-in exists and nobody is signed in', shows({ configured: true, loading: false, signedIn: false }), true);
  eq('I1 …never in the demo (no sign-in)', shows({ configured: false, signedIn: false }), false);
  eq('I1 …never while the session loads', shows({ configured: true, loading: true, signedIn: false }), false);
  eq('I1 …never to someone signed in (they asked for ?view=public)', shows({ configured: true, signedIn: true }), false);
  const st = fn('scanSignInState')(TOKEN);
  eq('I2 🔴 Sign in leaves with state.from.pathname = this code, so the person comes straight back to it', st?.from?.pathname, `/scan/${TOKEN}`);
  ok('I2 …which is what Login lands on after signing in', /location\.state\?\.from\?\.pathname/.test(read('src/pages/Login.jsx')) && /navigate\(from, \{ replace: true \}\)/.test(read('src/pages/Login.jsx')));
  eq('I3 the public page for a signed-in person is ?view=public', fn('publicScanPath')(TOKEN, { view: 'public' }), `/scan/${TOKEN}?view=public`);
  eq('I3 …and the plain one has no query', fn('publicScanPath')(TOKEN), `/scan/${TOKEN}`);
});

// ── D. where a staff member's scan lands ─────────────────────────────────────
await section('D', async () => {
  const dest = fn('staffScanDestination');
  const loc = { siteId: 's_club', clientId: 'cl_coral', areaId: 'area_rest', siteName: 'Clubhouse', building: 'Coral Bay HOA', area: 'Restrooms' };
  const clean = { id: 'j 1', siteId: 's_club', clientId: 'cl_coral', status: 'in_progress' };
  const cleaner = dest({ loc, token: TOKEN, office: false, canSeeCustomer: false, clean });
  ok('D1 a cleaner with a clean there today → their checklist, at the scanned area (as the Scan button does)', cleaner?.kind === 'checklist' && cleaner?.to === crewPaths.checklist('j 1', 'area_rest'), JSON.stringify(cleaner));
  const none = dest({ loc, token: TOKEN, office: false, clean: null });
  ok('D2 a cleaner with nothing there today → ask the server what they find there (the fill-in, QR Wave 2), naming the building', none?.kind === 'crewArea' && none?.place === 'Coral Bay HOA', JSON.stringify(none));
  const office = dest({ loc, token: TOKEN, office: true, canSeeCustomer: true, clean: null });
  ok('D3 🔴 an office login → the area\'s page (QR-17; the provisional customer page went in Wave 2)', office?.kind === 'area'
    && office?.to === '/areas/s_club/area_rest', JSON.stringify(office));
  const officeEvenWithoutClean = dest({ loc, token: TOKEN, office: true, canSeeCustomer: true, clean: null });
  ok('D3 …so the office never reads "You\'re not scheduled": no clean is asked of it', officeEvenWithoutClean?.kind === 'area', JSON.stringify(officeEvenWithoutClean));
  const noView = dest({ loc, token: TOKEN, office: true, canSeeCustomer: false });
  ok('D4 🔴 an office login WITHOUT clients.view → this area\'s public page', noView?.kind === 'public' && noView?.to === `/scan/${TOKEN}?view=public`, JSON.stringify(noView));
  // The area page needs the location and the area, not a customer.
  const loose = dest({ loc: { ...loc, clientId: null }, token: TOKEN, office: true, canSeeCustomer: true });
  eq('D4 …a location with no customer still has its area page', loose?.kind, 'area');
  const noArea = dest({ loc: { ...loc, areaId: null }, token: TOKEN, office: true, canSeeCustomer: true });
  eq('D4 …while a code naming no area opens the public page', noArea?.kind, 'public');
  ok('D5 🔴 the scan module names no customer-page address: nothing a scan opens lands on the customer\'s page (2026-11-02; II.5)', !('officeAreaPath' in L) && !/\/clients\//.test(strip(read('src/lib/scanLanding.js'))));
  // The owner's View-as a cleaner: the EFFECTIVE user is the cleaner (store/selectors selectCurrentUser),
  // so the page's `office` is false and the viewed cleaner's clean decides — the cleaner's checklist.
  const viewAs = dest({ loc, token: TOKEN, office: isOfficeRole('crew'), canSeeCustomer: true, clean });
  ok('D6 🔴 the owner\'s View-as a cleaner lands on that cleaner\'s checklist, never the office\'s page', viewAs?.kind === 'checklist' && viewAs?.to === crewPaths.checklist('j 1', 'area_rest'), JSON.stringify(viewAs));
  ok('D7 every office role is an office login here (lib/roles isOfficeRole), crew is not', ROLES.filter((r) => r !== 'crew').every(isOfficeRole) && !isOfficeRole('crew'));
});

// ── R. the resolvers composed with the rule (the real handlers) ──────────────
await section('R', async () => {
  const CU = 'c0000000-0000-4000-8000-0000000000aa';
  __resetRateLimit();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 2,
        state: {
          company: { name: 'Clean Space', timezone: 'America/New_York' },
          users: [
            { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mgr', email: 'mgr@example.test' },
            { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: 'crew@example.test' },
          ],
          permissions: seedPermissions(), userPermissionOverrides: [],
          clients: [{ id: 'cl_coral', name: 'Coral Bay HOA' }, { id: 'cl_far', name: 'Far Away' }],
          sites: [
            { id: 's_club', clientId: 'cl_coral', name: 'Clubhouse', cleaningAreas: [{ id: 'area_rest', label: 'Restrooms' }] },
            { id: 's_far', clientId: 'cl_far', name: 'Far Away', cleaningAreas: [{ id: 'area_far', label: 'Hall' }] },
          ],
          opsSettings: {}, notifications: [],
        },
      }],
      area_scan_codes: [
        { id: 'c1', organization_id: ORG, site_id: 's_club', area_id: 'area_rest', token: TOKEN, created_at: new Date().toISOString(), created_by: 'u_mgr', revoked_at: null, revoked_by: null },
        { id: 'c2', organization_id: ORG, site_id: 's_far', area_id: 'area_far', token: 'F'.repeat(32), created_at: new Date().toISOString(), created_by: 'u_mgr', revoked_at: null, revoked_by: null },
      ],
      jobs: [], crew_assignments: [],
      client_users: [{ id: CU, organization_id: ORG, name: 'Pat', email: 'pat@coral.test', phone: null, status: 'active', auth_user_id: 'auth-client' }],
      client_user_groups: [], client_user_group_members: [],
      client_user_assignments: [{ id: 'as1', organization_id: ORG, client_user_id: CU, client_id: 'cl_coral', group_id: null }],
      activity_log: [], activity_log_baseline: [],
    },
    logins: {
      'tok-mgr': { id: 'auth-mgr', email: 'mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
      'tok-client': { id: 'auth-client', email: 'pat@coral.test', app_metadata: { role: 'client', client_user_id: CU, org_id: ORG } },
    },
  });
  const call = (handler, p, token, query) => new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { resolve({ status: this.statusCode, body: b ?? null }); return this; },
    };
    const quiet = console.error;
    console.error = () => {};
    Promise.resolve(handler({ method: 'GET', headers: { authorization: `Bearer ${token}` }, query: { subpath: p, ...query }, body: {} }, res))
      .finally(() => { console.error = quiet; });
  });
  const office = await call(officeHandler, 'resolve', 'tok-mgr', { token: TOKEN });
  const dest = fn('staffScanDestination')({ loc: office.body, token: TOKEN, office: isOfficeRole('manager'), canSeeCustomer: true });
  ok('R1 🔴 the office\'s EP-386 answer + the rule → the area\'s page', office.status === 200
    && dest?.to === '/areas/s_club/area_rest', `${office.status} ${JSON.stringify(office.body)} → ${JSON.stringify(dest)}`);
  const notOn = await call(officeHandler, 'resolve', 'tok-crew', { token: TOKEN });
  const crewDest = fn('staffScanDestination')({ loc: notOn.body, token: TOKEN, office: false, clean: null });
  ok('R2 a cleaner on no clean there resolves the code (QR Wave 2) and the rule asks the server for the fill-in', notOn.status === 200
    && notOn.body?.siteId === 's_club' && crewDest?.kind === 'crewArea', `${notOn.status} ${JSON.stringify(notOn.body)} → ${JSON.stringify(crewDest)}`);
  const theirs = await call(hubHandler, 'scan', 'tok-client', { token: TOKEN });
  ok('R3 a customer\'s own building resolves (→ that area\'s page)', theirs.status === 200 && theirs.body?.buildingId === 'cl_coral' && theirs.body?.areaId === 'area_rest', JSON.stringify(theirs));
  const notTheirs = await call(hubHandler, 'scan', 'tok-client', { token: 'F'.repeat(32) });
  ok('R4 another building is refused with the code the hub page offers the public page on', notTheirs.status === 403 && notTheirs.body?.code === codesLib.HUB_SCAN_NOT_YOURS_CODE, JSON.stringify(notTheirs));
});

// ── W. the wiring ────────────────────────────────────────────────────────────
await section('W', async () => {
  const page = strip(read('src/pages/PublicAreaScan.jsx'));
  ok('W1 the public page reads the SESSION (auth/AuthProvider) and the claim\'s customer test, never the store', /from '\.\.\/auth\/AuthProvider'/.test(page)
    && /useSession\(\)/.test(page) && /isClientSession\(session\)/.test(page) && !/from '\.\.\/store'|useStore|useDispatch|useAuth\(/.test(page));
  ok('W2 …decides with scanLanding and sends a signed-in person on with replace', /scanLanding\(\{/.test(page) && /<Navigate to=\{landing\.to\} replace \/>/.test(page));
  ok('W3 …and makes the public read only for the public card', /useEffect\(\(\) => \(showsPublic \? load\(\) : undefined\), \[load, showsPublic\]\)/.test(page));
  ok('W4 🔴 the ONE added line: "… team or customer? Sign in", only by the rule, to /login carrying this code', /\{IDENTITY\.name\} team or customer\?/.test(page)
    && /\{signIn && \(/.test(page) && /to="\/login" state=\{scanSignInState\(token\)\}/.test(page) && /scanShowsSignIn\(/.test(page));
  ok('W4 …a kit link (.btn.btn-link), on the ready card', /className="btn btn-link scan-signin-link"/.test(page) && /\.scan-signin\s*\{/.test(read('src/index.css')));
  const crew = strip(read('src/pages/crew/CrewScan.jsx'));
  ok('W5 /my-day/scan takes ?code= (SCAN_CODE_PARAM)', /useSearchParams\(\)/.test(crew) && /searchParams\.get\(SCAN_CODE_PARAM\)/.test(crew));
  ok('W6 🔴 …resolves it ONCE (a ref the second StrictMode run sees)', /handledCode\.current === codeParam/.test(crew) && /handledCode\.current = codeParam/.test(crew));
  ok('W6 …a cleaner\'s only once their cleans have loaded', /useJobsHydrated\(\)/.test(crew) && /\(!office && !jobsHydrated\)/.test(crew));
  ok('W6 …drops it from the address (replace)', /next\.delete\(SCAN_CODE_PARAM\)/.test(crew) && /setSearchParams\(next, \{ replace: true \}\)/.test(crew));
  ok('W7 …and the camera and the link take ONE road: resolveScanCode, then staffScanDestination', /resolveScanCode\(/.test(crew) && /staffScanDestination\(\{/.test(crew)
    && /resolveToken\(token, \{ link: true \}\)/.test(crew) && /await resolveToken\(token\)/.test(crew));
  ok('W8 🔴 a link replaces the page (Back never lands on the redirect), the camera keeps its referrer', /navigate\(dest\.to, link \? \{ replace: true \} : \{ state: nav \}\)/.test(crew));
  ok('W9 the office test is the EFFECTIVE user\'s role and the customer page\'s own key', /isOfficeRole\(me\?\.role\)/.test(crew) && /usePermission\('clients\.view'\)/.test(crew));
  ok('W10 a scan that leads nowhere for this cleaner offers the public page; a dead code says so alone', /setNotice\(\{ key: refusalKey\(err\) \}\)/.test(crew)
    && /notice\.publicFor && publicLink\(notice\.publicFor\)/.test(crew) && /publicScanPath\(token, \{ view: SCAN_VIEW_PUBLIC \}\)/.test(crew) && /t\('qrScan\.publicPage'\)/.test(crew)
    && /\{publicLink\(notice\.fillIn\.token\)\}/.test(crew));
  ok('W10 …and the camera never starts for a ?code= arrival: no scanner until "Scan again"', /useState\(\(\) => \(codeParam \? \{ busy: true \} : null\)\)/.test(crew)
    && /useState\(\(\) => !codeParam\)/.test(crew) && /\{cameraOn && <QrScanner /.test(crew) && /setCameraOn\(true\)/.test(crew));
  ok('W10 …nor on the hub\'s', /useState\(\(\) => !codeParam\)/.test(strip(read('src/pages/hub/HubScan.jsx'))) && /\{cameraOn && <QrScanner /.test(strip(read('src/pages/hub/HubScan.jsx'))));
  const hub = strip(read('src/pages/hub/HubScan.jsx'));
  ok('W11 /hub/scan takes ?code= the same way: once, dropped from the address, the page replaced', /searchParams\.get\(SCAN_CODE_PARAM\)/.test(hub)
    && /handledCode\.current === codeParam/.test(hub) && /next\.delete\(SCAN_CODE_PARAM\)/.test(hub) && /resolveToken\(token, \{ link: true \}\)/.test(hub)
    && /link \? \{ replace: true \} : \{ state: nav \}/.test(hub));
  ok('W12 …a building that isn\'t theirs offers the public page (English, LANG-8)', /publicFor: err\?\.code === HUB_SCAN_NOT_YOURS_CODE \? token : null/.test(hub)
    && /english\('hubScan\.publicPage'\)/.test(hub));
  // QR Wave 2 (Matt's QR-16, 2026-10-16): "That area's own page" — the provisional Checklists went.
  ok('W12 …that AREA\'s own page when it is theirs (QR-16), the provisional Checklists gone', /areaPath\(r\.buildingId, r\.areaId\)/.test(hub)
    && !/sectionPath\(r\.buildingId, 'checklists'\)/.test(hub));
  const card = strip(read('src/components/CleaningInstructionsCard.jsx'));
  const editor = strip(read('src/components/CleaningAreasEditor.jsx'));
  // Matt (2026-11-02): "When I select "Open Customer," could you explain what the goal is for that
  // session?" Open customer opened the customer's page at Overview from then (the button went on
  // 2026-11-03, task 467), so nothing opens the Notes tab at an area, and the mark that answered
  // `?area=` there went with it (THE LAW II.5).
  const css = read('src/index.css');
  ok('W13 🔴 nothing marks an area on the customer\'s page: the card reads no ?area= and the read-only list takes no focusId', !/useSearchParams|searchParams\.get\('area'\)/.test(card)
    && !/focusId|focusArea/.test(card + editor) && !/scrollIntoView|FOCUS_MS|setFocusOn|cleaning-area-focus/.test(editor));
  ok('W13 🔴 …nor does the stylesheet keep the mark or what only it needed (the outline, its offset, the scroll margin, the fade)', !/cleaning-area-focus/.test(css)
    && /\n\.cleaning-area \{ border: 1px solid var\(--card-border\); border-radius: var\(--card-radius\); padding: 10px 12px; \}\n/.test(css));
  ok('W13 …and the customer\'s page opens at Overview when no ?tab= is given (ClientDetail\'s own default)', /searchParams\.get\('tab'\)\) \? searchParams\.get\('tab'\) : 'overview'/.test(strip(read('src/pages/ClientDetail.jsx'))));
  const en = read('src/i18n/catalog/en.js');
  ok('W14 the cleaner app\'s new line is a catalog line; the hub\'s is English-only (hubScan.*)', /'qrScan\.publicPage':/.test(en) && /'hubScan\.publicPage':/.test(en) && /'hubScan\.'/.test(read('src/i18n/terms.js')));
  // Wave 2: lib/roles too — ONE list of office tiers for the camera road (never a hand copy); the public
  // page already loads it (scanCodesApi → qcApi → timeApi → roles), so a stranger's phone loads nothing more.
  ok('W15 the module stays light for a stranger\'s phone (areaScan, crewPaths and roles only)', (read('src/lib/scanLanding.js').match(/^import .*$/gm) || []).every((l) => /'\.\/areaScan\.js'|'\.\/crewPaths\.js'|'\.\/roles\.js'/.test(l)), (read('src/lib/scanLanding.js').match(/^import .*$/gm) || []).join(' | '));
});

if (fails.length) { console.error('\nqr-scan-landing FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nqr-scan-landing: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
