// QR-9 — one label, to replace a damaged one, on the position of a partly used sheet.
//
// Matt (2026-10-16): "…But also, just one location on one site, if needed, if something gets damaged."
// Each area's row in the QR codes panel gets Print label: a sheet with only that area's label, at the
// position the office picks on the sheet's grid (1 … N), so a partly used Avery sheet is not wasted.
// ONE document builder (lib/scanCodes buildScanSheetHtml: the codes and a `position`), ONE door (EP-262
// `POST /api/scan-codes/sheet` gains `areaId` and `position`), the same gate (sites.edit plus the office
// floor: crew never).
//
// WHAT IT HOLDS
//   §P  the builder: the rectangles of one label at every position, a print that runs past the sheet's
//       last label onto a new sheet, the strict position rule, the one label's place in the document
//   §R  the door, driven END TO END through the REAL handler against fake-supabase.mjs (no network, no
//       credentials; Chromium faked): the one label at its position, its own code, the file named for
//       the area; every refusal; the gate per role; the print allowance shared with the full sheet
//   §U  the panel and the adapter (mechanical over the source: plain node cannot import a .jsx)
//
// REGRESSION (THE LAW II.3): on 90d7ca9e the sheet route prints every area and reads no position, the
// builder has no position, and the panel has no Print label — the checks below report each.
//
//   node app/scripts/test-qr-label-print.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
delete process.env.APP_PUBLIC_URL;
delete process.env.APP_BASE_URL;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

// Chromium is not available offline: a stand-in records the HTML it is handed and returns fixed bytes.
globalThis.__pdfCalls = [];
const FAKE_PUPPETEER = `export default { async launch() { return {
  async newPage() { return {
    async setContent(html) { globalThis.__pdfCalls.push({ html }); },
    async pdf(opts) { globalThis.__pdfCalls[globalThis.__pdfCalls.length - 1].opts = opts; return new TextEncoder().encode('%PDF-1.4 fake'); },
  }; },
  async close() {},
}; } };`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'puppeteer-core' || spec === '@sparticuz/chromium') {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_PUPPETEER)}`, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const codes = await import('../src/lib/scanCodes.js').catch(() => ({}));
const { IDENTITY } = await import('../src/brand/identity.generated.js');
const APP_ADDRESS = new URL(IDENTITY.appUrl).origin;
const officeHandler = (await import('../api/scan-codes/[...path].js').catch(() => ({}))).default || null;
const QRCode = (await import('qrcode')).default;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (name) => (typeof codes[name] === 'function' ? codes[name] : () => undefined);
const close = (a, b) => Math.abs(a - b) < 1e-6;

const F = codes.LABEL_FORMATS || {};
const labelPages = fn('labelPages');
const labelPosition = fn('labelPosition');
const buildScanSheetHtml = fn('buildScanSheetHtml');
const scanSheetFilename = fn('scanSheetFilename');
// Where a 1-based position on a format's sheet is, from the format's own published geometry.
const slotOf = (f, position) => {
  const s = position - 1;
  return { xIn: f.x0In + (s % f.cols) * f.dxIn, yIn: f.y0In + Math.floor(s / f.cols) * f.dyIn };
};
const inchOf = (v) => `${Math.round(v * 10000) / 10000}in`;

// ── §P the builder ───────────────────────────────────────────────────────────
for (const f of Object.values(F)) {
  let all = true;
  for (let position = 1; position <= f.perSheet; position += 1) {
    const pages = labelPages(f.key, 1, { start: position - 1 }) || [];
    const r = pages[0]?.[0];
    const want = slotOf(f, position);
    if (!(pages.length === 1 && pages[0].length === 1 && r && close(r.xIn, want.xIn) && close(r.yIn, want.yIn))) all = false;
  }
  ok(`P1 ${f.key}: one label at each of the ${f.perSheet} positions lands on that position, one page`, all);
  const last = labelPages(f.key, 3, { start: f.perSheet - 1 }) || [];
  ok(`P2 ${f.key}: three labels from the last position fill it, then start a new sheet at its first`,
    last.length === 2 && last[0].length === 1 && close(last[0][0].yIn, slotOf(f, f.perSheet).yIn)
    && last[1].length === 2 && close(last[1][0].xIn, f.x0In) && close(last[1][0].yIn, f.y0In), JSON.stringify(last));
  ok(`P3 ${f.key}: a position is a whole number from 1 to ${f.perSheet}`,
    labelPosition(f.key, 1) === 1 && labelPosition(f.key, f.perSheet) === f.perSheet
    && [0, f.perSheet + 1, 2.5, '3', null, undefined, NaN, -1].every((v) => labelPosition(f.key, v) === null));
}
ok('P3 …and with no position at all the sheet starts at its first label', (labelPages('avery5163', 1) || [])[0]?.[0]?.yIn === F.avery5163?.y0In);
{
  const f = F.avery5163 || {};
  const url = `${APP_ADDRESS}/scan/${'R'.repeat(32)}`;
  const one = [{ label: 'Restrooms', url, qr: QRCode.create(url, { errorCorrectionLevel: 'M' }) }];
  const html = String(buildScanSheetHtml({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA', codes: one, position: 7 }) || '');
  const want = slotOf(f, 7);
  eq('P4 one label, at position 7: the document holds that ONE label', (html.match(/class="lbl /g) || []).length, 1);
  ok('P4 …on one page', (html.match(/class="pg /g) || []).length === 1);
  ok('P4 …placed on position 7 of the 2″ × 4″ sheet (row 4, left), from the sheet\'s own geometry',
    html.includes(`left:${inchOf(want.xIn)};top:${inchOf(want.yIn)};`), html.match(/left:[^;]+;top:[^;]+;/)?.[0]);
  ok('P4 …its code drawn from its own link', html.includes(codes.qrPathData?.(one[0].qr)?.d || 'missing'));
  const sheet = String(buildScanSheetHtml({ layout: 'sheet', building: 'Coral Bay HOA', codes: one, position: 7 }) || '');
  ok('P5 a position means nothing to the one-page sheet (the route refuses it; the builder ignores it)', (sheet.match(/class="cell /g) || []).length === 1);
  eq('P6 the single label\'s file names the building, the area and the sheet',
    scanSheetFilename({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA', area: 'Restrooms' }), 'qr-label-coral-bay-hoa-restrooms-avery5163.pdf');
  eq('P6 …the whole building\'s keeps its name', scanSheetFilename({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA' }), 'qr-labels-coral-bay-hoa-avery5163.pdf');
}

// ── §R the door ──────────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: `Name ${k}` }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [
  `tok-${k}`, { id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {} },
]));
const SITE = 'st_clubhouse';
const AREAS = [{ id: 'area_lobby', label: 'Lobby & entrance' }, { id: 'area_rest', label: 'Restrooms' }, { id: 'area_floors', label: 'Hall & stair floors' }];
const TOK = { lobby: 'L'.repeat(32), rest: 'R'.repeat(32), floors: 'F'.repeat(32) };
const NOW = Date.now();
function seed({ overrides = [], permissions = seedPermissions() } = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: {
        users: roster, permissions, userPermissionOverrides: overrides,
        company: { name: 'Clean Space', timezone: 'America/New_York' },
        clients: [{ id: 'cl_coral', name: 'Coral Bay HOA' }],
        sites: [{ id: SITE, clientId: 'cl_coral', name: 'Clubhouse', cleaningAreas: AREAS }],
        opsSettings: {},
      } }],
      area_scan_codes: Object.entries({ area_lobby: TOK.lobby, area_rest: TOK.rest, area_floors: TOK.floors }).map(([area, token], i) => ({
        id: `c${i}`, organization_id: ORG, site_id: SITE, area_id: area, token, created_at: new Date(NOW - 3600e3).toISOString(), created_by: 'u_owner', revoked_at: null, revoked_by: null,
      })),
    },
    logins,
  });
  world.rpc = (name, args) => {
    if (name !== 'area_scan_site') return { data: null, error: { code: 'PGRST202', message: `no function ${name}` } };
    const row = (world.tables.org_state || []).find((r) => r.organization_id === args.p_org);
    const site = (row?.state?.sites || []).find((s) => s && s.id === args.p_site_id);
    if (!site) return { data: null, error: null };
    const client = (row.state.clients || []).find((c) => c.id === site.clientId);
    return { data: { siteName: site.name ?? null, clientName: client?.name ?? null, areas: (site.cleaningAreas || []).map((a) => ({ id: a.id, label: a.label })), timeZone: row.state.company?.timezone ?? null }, error: null };
  };
  __resetRateLimit();
  globalThis.__pdfCalls = [];
}
async function call(handler, { method = 'POST', path: sub, token, body, headers = {} }) {
  if (typeof handler !== 'function') return { status: null, body: null, headers: {} };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), origin: 'https://office-host.example', ...headers };
  req.query = { subpath: sub };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${sub}: no response`)), 10000);
      const hdrs = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers: hdrs }); };
      const res = {
        statusCode: 200,
        setHeader(k, v) { hdrs[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const print = (who, body) => call(officeHandler, { path: 'sheet', token: who ? `tok-${who}` : null, body: { siteId: SITE, layout: 'labels', format: 'avery5163', ...body } });
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const qrOf = (token) => codes.qrPathData?.(QRCode.create(`${APP_ADDRESS}/scan/${token}`, { errorCorrectionLevel: 'M' }))?.d || 'x'.repeat(40);

{
  seed();
  const r = await print('mgr', { areaId: 'area_rest', position: 7 });
  eq('R1 the office prints ONE label for the restrooms at position 7: 200', r.status, 200);
  eq('R1 …as a PDF', r.headers['content-type'], 'application/pdf');
  const html = String(globalThis.__pdfCalls[0]?.html || '');
  eq('R1 Chromium was handed ONE document', globalThis.__pdfCalls.length, 1);
  eq('R1 …with exactly ONE label', (html.match(/class="lbl /g) || []).length, 1);
  const want = slotOf(F.avery5163 || {}, 7);
  ok('R1 …at position 7 of the sheet', html.includes(`left:${inchOf(want.xIn)};top:${inchOf(want.yIn)};`), html.match(/left:[^;]+;top:[^;]+;/)?.[0]);
  ok('R1 …carrying the restrooms\' own live code', html.includes(qrOf(TOK.rest)));
  ok('R1 …and no other area\'s', !html.includes(qrOf(TOK.lobby)) && !html.includes(qrOf(TOK.floors)));
  ok('R1 …with its name under the code', /<\/svg><div class="name"[^>]*>Restrooms<\/div>/.test(html));
  ok('R1 the file is named for the building and the area', /attachment; filename="qr-label-coral-bay-hoa-restrooms-avery5163\.pdf"/.test(r.headers['content-disposition'] || ''), r.headers['content-disposition']);
  const first = await print('owner', { areaId: 'area_rest' });
  const html1 = String(globalThis.__pdfCalls[1]?.html || '');
  const one = slotOf(F.avery5163 || {}, 1);
  ok('R2 with no position, the label goes on the sheet\'s first', first.status === 200 && html1.includes(`left:${inchOf(one.xIn)};top:${inchOf(one.yIn)};`), show(first));
  const all = await print('mgr', {});
  ok('R2 the whole building still prints every area (3 labels)', all.status === 200 && (String(globalThis.__pdfCalls[2]?.html || '').match(/class="lbl /g) || []).length === 3, show(all));
}
{
  seed();
  for (const [what, body, status] of [
    ['an area the location does not have', { areaId: 'area_gone' }, 404],
    ['a malformed area id', { areaId: 'x),site_id.eq.y' }, 400],
    ['position 0', { areaId: 'area_rest', position: 0 }, 400],
    ['position 11 on a 10-label sheet', { areaId: 'area_rest', position: 11 }, 400],
    ['position 2.5', { areaId: 'area_rest', position: 2.5 }, 400],
    ['position "7" (text)', { areaId: 'area_rest', position: '7' }, 400],
    ['position 7 on the 6-label sheet', { areaId: 'area_rest', position: 7, format: 'avery5164' }, 400],
    ['a position on the one-page sheet', { areaId: 'area_rest', position: 2, layout: 'sheet' }, 400],
  ]) {
    const r = await print('mgr', body);
    eq(`R3 ${what} is refused (${status})`, r.status, status);
    ok(`R3 …in a sentence with a code, and nothing printed (${what})`, typeof r.body?.error === 'string' && typeof r.body?.code === 'string', show(r));
  }
  eq('R3 nothing reached Chromium', globalThis.__pdfCalls.length, 0);
  const last = await print('mgr', { areaId: 'area_rest', position: 6, format: 'avery5164' });
  eq('R3 the 6-label sheet\'s own last position prints', last.status, 200);
}
{
  seed();
  eq('R4 no login is 401', (await print(null, { areaId: 'area_rest', position: 2 })).status, 401);
  eq('R4 crew are refused', (await print('crew', { areaId: 'area_rest', position: 2 })).status, 403);
  seed({ overrides: [{ userId: 'u_crew', grants: ['sites.edit'], revokes: [] }] });
  eq('R4 crew are refused EVEN holding sites.edit by a per-user grant (the office floor)', (await print('crew', { areaId: 'area_rest', position: 2 })).status, 403);
  seed({ permissions: seedPermissions().map((p) => (p.id === 'sites.edit' ? { ...p, roles: p.roles.filter((x) => x !== 'manager') } : p)) });
  eq('R4 a manager pared off sites.edit is refused', (await print('mgr', { areaId: 'area_rest', position: 2 })).status, 403);
  eq('R4 …and nothing was printed for any of them', globalThis.__pdfCalls.length, 0);
}
{
  seed();
  let last = null;
  for (let i = 0; i < 12; i += 1) last = await print('mgr', { areaId: 'area_rest', position: 1 + (i % 10) });
  eq('R5 twelve single labels in a minute are allowed (the print allowance)', last?.status, 200);
  eq('R5 …the thirteenth print of any kind waits (one allowance for every print)', (await print('mgr', {})).status, 429);
}

// ── §U the panel and the adapter ─────────────────────────────────────────────
{
  const PANEL = code('src/components/AreaScanCodes.jsx');
  const API = code('src/lib/scanCodesApi.js');
  const ROUTE = code('api/scan-codes/[...path].js');
  ok('U1 each area\'s row has Print label, its name saying which area', /t\('qrLabel\.print'\)/.test(PANEL) && /qrLabel\.printAria/.test(PANEL));
  ok('U2 it opens a dialog (the kit Modal) titled for the area', /<Modal[\s\S]*?title=\{[^}]*qrLabel\.title/.test(PANEL));
  ok('U2 …with "Position on the sheet" as the sheet\'s own grid: its columns, one pick per label', /qrLabel\.position'/.test(PANEL)
    && /LABEL_FORMATS\[format\]/.test(PANEL) && /gridTemplateColumns: `repeat\(\$\{sheet\.cols\}/.test(PANEL) && /Array\.from\(\{ length: sheet\.perSheet \}/.test(PANEL));
  ok('U2 …each pick a kit chip that says whether it is the one chosen', /className=\{`chip\$\{/.test(PANEL) && /aria-pressed=\{/.test(PANEL));
  ok('U3 Print sends ONE label at the chosen position, straight from the click',
    /printScanSheet\(\{ siteId, layout: SHEET_LAYOUTS\.LABELS, format, areaId: [\w.]+, position(?:: [\w.]+)? \}\)/.test(PANEL.replace(/\s+/g, ' ')));
  ok('U4 the adapter hands the area and the position to EP-262', /JSON\.stringify\(\{ siteId, layout, format, areaId, position \}\)/.test(API));
  ok('U4 …and the demo prints the same single label through the same builder',
    /stubPrint\(\{ siteId, layout, format, areaId, position \}\)/.test(API) && /position,? \}?\)?/.test(API) && /c\.areaId === areaId/.test(API));
  ok('U5 the route reads the area and the position from the body through the strict rules', /idParam\(body\.areaId\)/.test(ROUTE) && /labelPosition\(/.test(ROUTE));
  const EN = read('src/i18n/catalog/en.js');
  for (const k of ['qrLabel.print', 'qrLabel.printAria', 'qrLabel.title', 'qrLabel.sheet', 'qrLabel.position', 'qrLabel.positionHelp', 'qrLabel.positionAria', 'qrLabel.go', 'qrLabel.actualSize']) {
    ok(`U6 the catalog has ${k}`, EN.includes(`'${k}':`));
  }
}

if (fails.length) { console.error('\nqr-label-print FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nqr-label-print: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
