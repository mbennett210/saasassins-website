// The New Inspection form as Matt drew it (Daniel, 2026-10-09: "do what he did for the
// inspection form"; plan docs/plans/2026-10-09-manager-view-redesign.md §2.4).
//
//   §1 THE TICK RULE. A pass/fail template is a tick list: ticked = pass, left unticked =
//      fail at Submit, N/A (only where the template allows it — lib/checklistCount
//      itemAllowsNa) leaves the count. A 1–5 template keeps its picker: unpicked = unrated,
//      out of the count. lib/inspections inspectionFillItems builds what is POSTED and
//      inspectionFillScore the card's "N of M" and percent.
//   §2 THE SCREEN'S NUMBER IS THE SERVER'S. Each case is submitted through the REAL qc route
//      (api/qc/[...path].js → store.submitInspection → scoreInspection) against a local fake
//      Supabase, and the stored overall_score / result must equal the card's.
//   §3 BEFORE / AFTER ON THE REPORT. The one report document (lib/inspectionReportTemplate —
//      the in-app modal, the public link, the PDF and the hub's page all render it) shows a
//      new inspection's photos as a Before / After pair, while an OLDER inspection's photos
//      stay under their area (history never drifts).
//   §4 THE FORM, read mechanically: two photo tiles (scope inspection, area before / after)
//      and no per-area gallery, the score from the shared rule, the office-only note.
//
// The new functions are read off a namespace import, so on the tree before them every check
// reports a failure instead of the file dying on its first import.
//   node app/scripts/test-inspection-fill.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000024';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const insp = await import('../src/lib/inspections.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { buildInspectionReportHtml } = await import('../src/lib/inspectionReportTemplate.js');
const { projectHubInspection } = await import('../src/lib/clientHubView.js');
const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
// ok(label, condition) — this file's own order.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const fillItems = typeof insp.inspectionFillItems === 'function' ? insp.inspectionFillItems : () => null;
const fillScore = typeof insp.inspectionFillScore === 'function' ? insp.inspectionFillScore : () => null;
const PHASES = insp.INSPECTION_PHOTO_PHASES || {};

// Seven items in two areas, as the board's 5 of 7; one item the office lets be N/A.
const SCHEMA = {
  areas: [
    { id: 'a_lobby', label: 'Lobby', items: [
      { id: 'i1', label: 'Common areas clean' },
      { id: 'i2', label: 'Trash removed' },
      { id: 'i3', label: 'Floors mopped', naAllowed: true },
    ] },
    { id: 'a_rest', label: 'Restrooms', items: [
      { id: 'i4', label: 'Stocked & sanitized' },
      { id: 'i5', label: 'Mirrors' },
      { id: 'i6', label: 'Windows' },
      { id: 'i7', label: 'Supply closet' },
    ] },
  ],
};
const PF = { name: 'Nightly QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, schema: SCHEMA };
const NUM = { name: 'Scored QC', kind: 'inspection', rating_scale: { type: 'numeric', max: 5, passThreshold: 80 }, schema: SCHEMA };
const tick = (...ids) => Object.fromEntries(ids.map((id) => [id, { ticked: true }]));

// ── §1 the tick rule ─────────────────────────────────────────────────────────
ok('§1.0 inspectionFillItems and inspectionFillScore are exported', typeof insp.inspectionFillItems === 'function' && typeof insp.inspectionFillScore === 'function');
{
  const items = fillItems(PF, tick('i1', 'i2')) || [];
  eq('§1.1 every item is posted, in the template\'s order', items.map((i) => i.item_key), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7']);
  eq('§1.2 ticked = pass, left unticked = fail', items.map((i) => i.rating), ['pass', 'pass', 'fail', 'fail', 'fail', 'fail', 'fail']);
  eq('§1.3 each posts the office\'s English "<Area>. <Item>"', items[0]?.label, 'Lobby. Common areas clean');
}
{
  const all = fillScore(PF, tick('i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7')) || {};
  eq('§1.4 everything ticked → 7 of 7, 100%', [all.done, all.applies, all.overallScore], [7, 7, 100]);
  const none = fillScore(PF, {}) || {};
  eq('§1.5 nothing ticked → 0 of 7, 0% (unticked is a fail, not a blank)', [none.done, none.applies, none.overallScore, none.result], [0, 7, 0, 'fail']);
  const board = fillScore(PF, tick('i1', 'i2', 'i3', 'i4', 'i6')) || {};
  eq('§1.6 the board\'s 5 of 7 → 71%', [board.done, board.applies, board.overallScore], [5, 7, 71]);
  const na = fillScore(PF, { ...tick('i1', 'i2', 'i4', 'i5', 'i6', 'i7'), i3: { na: true } }) || {};
  eq('§1.7 N/A on an item the template allows leaves the count: 6 of 6, 100%', [na.done, na.applies, na.overallScore], [6, 6, 100]);
  eq('§1.7b …and is posted as the rating "na"', (fillItems(PF, { i3: { na: true } }) || [])[2]?.rating, 'na');
  const naRefused = fillScore(PF, { ...tick('i1'), i4: { na: true } }) || {};
  eq('§1.8 N/A on an item the template does NOT allow is ignored: it stays a fail, 1 of 7', [naRefused.done, naRefused.applies], [1, 7]);
  const naWins = fillItems(PF, { i3: { ticked: true, na: true } }) || [];
  eq('§1.9 N/A wins over a tick on the same item', naWins[2]?.rating, 'na');
  const comment = fillItems(PF, { i2: { ticked: true, comment: '  Lobby bin still full  ' } }) || [];
  eq('§1.10 a comment is posted trimmed (the client sees it, HUB-6)', comment[1]?.comment, 'Lobby bin still full');
  eq('§1.11 …and an empty one as null', comment[0]?.comment, null);
}
{
  const n = fillScore(NUM, { i1: { rating: 5 }, i2: { rating: 3 }, i3: { na: true } }) || {};
  eq('§1.12 a 1–5 template: rated items count, unrated ones are out, N/A is out', [n.done, n.applies, n.numeric], [2, 6, true]);
  eq('§1.13 …and the percent is the average of the rated, as a share of the max', n.overallScore, 80);
  const items = fillItems(NUM, { i1: { rating: 5 }, i2: { rating: 9 }, i4: { ticked: true } }) || [];
  eq('§1.14 an out-of-range rating and a stray tick are unrated, never a pass', [items[0]?.rating, items[1]?.rating, items[3]?.rating], [5, null, null]);
  const empty = fillScore(NUM, {}) || {};
  eq('§1.15 nothing rated → no score yet', [empty.done, empty.overallScore, empty.result], [0, null, 'needs_follow_up']);
}

// ── §2 the screen's number is the server's ──────────────────────────────────
const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
function seed(snapshot) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 57,
        state: {
          version: 57, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_m', 'manager')],
          clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_m' }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }],
          permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
        },
      }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      inspection_templates: [{ id: 'it_i', organization_id: ORG, name: snapshot.name, kind: 'inspection', is_published: true, published_version_id: 'v_i' }],
      inspection_template_versions: [{ id: 'v_i', template_id: 'it_i', version_number: 1, status: 'published', schema: SCHEMA }],
      inspection_records: [{
        id: 'ir_1', organization_id: ORG, public_token: 'tok_public_1', template_id: 'it_i', template_version_id: 'v_i',
        template_snapshot: snapshot, client_id: 'c1', site_id: 's1', job_id: null, inspector_user_id: 'u_m',
        client_name: 'Coral Bay HOA', site_name: 'Clubhouse', inspector_name: 'Renata', status: 'draft',
        overall_score: null, result: null, performed_at: '2026-10-09T22:00:00.000Z',
      }],
      inspection_items: [], account_media: [], problem_reports: [], activity_log: [], time_entries: [],
    },
    logins: { 'tok-mgr': { id: 'auth-m', email: 'm@example.test', app_metadata: { role: 'manager', org_user_id: 'u_m', org_id: ORG } } },
  });
}
async function submit(body) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer tok-mgr' };
  req.query = { subpath: 'inspections/submit' };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('submit: no response')), 10000);
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
const CASES = [
  ['everything ticked', PF, tick('i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7')],
  ['nothing ticked', PF, {}],
  ['N/A on the allowed item', PF, { ...tick('i1', 'i2', 'i4', 'i5', 'i6', 'i7'), i3: { na: true } }],
  ['mixed (the board\'s 5 of 7)', PF, tick('i1', 'i2', 'i3', 'i4', 'i6')],
  ['mixed with N/A', PF, { ...tick('i1', 'i5'), i3: { na: true } }],
  ['a 1–5 template, partly rated', NUM, { i1: { rating: 5 }, i2: { rating: 2 }, i3: { na: true } }],
];
for (const [name, snap, answers] of CASES) {
  seed(snap);
  const card = fillScore(snap, answers) || {};
  const r = await submit({ id: 'ir_1', items: fillItems(snap, answers) || [], internalNote: '' });
  const rec = world.tables.inspection_records[0];
  eq(`§2 ${name}: the route accepts it`, r.status, 200);
  ok(`§2 ${name}: the server stores the card's percent (${card.overallScore})`, card.overallScore !== undefined && rec.overall_score === card.overallScore, `stored ${rec.overall_score}`);
  ok(`§2 ${name}: …and the card's result (${card.result})`, card.result !== undefined && rec.result === card.result, `stored ${rec.result}`);
}

// ── §3 Before / After on the report; older inspections by area ──────────────
const photo = (id, areaId) => ({ id, kind: 'image', url: `https://media.example/${id}.jpg`, caption: null, areaId });
const reportOf = (photos) => ({
  inspection: { templateName: 'Nightly QC', schema: SCHEMA, ratingScale: PF.rating_scale, clientName: 'Coral Bay HOA', overallScore: 71, result: 'fail', performedAt: '2026-10-09T22:00:00.000Z' },
  items: (fillItems(PF, tick('i1')) || []).map((i) => ({ itemKey: i.item_key, label: i.label, rating: i.rating, comment: i.comment })),
  photos,
});
ok('§3.0 the photo phases are named in lib/inspections', PHASES.BEFORE === 'before' && PHASES.AFTER === 'after');
{
  const html = buildInspectionReportHtml(reportOf([photo('b1', PHASES.BEFORE || 'before'), photo('a1', PHASES.AFTER || 'after'), photo('a2', PHASES.AFTER || 'after')]));
  const ba = /<section class="ir-sec ir-ba">[\s\S]*?<\/section>/.exec(html)?.[0] || '';
  ok('§3.1 a new inspection\'s photos render as a Before / After pair', ba.length > 0 && />Before</.test(ba) && />After</.test(ba));
  const beforeCol = /<div class="ir-ba-col"><h3 class="ir-ba-h">Before<\/h3>[\s\S]*?<\/div><\/div>/.exec(ba)?.[0] || '';
  const afterCol = /<div class="ir-ba-col"><h3 class="ir-ba-h">After<\/h3>[\s\S]*?<\/div><\/div>/.exec(ba)?.[0] || '';
  ok('§3.2 …the before photo in the Before column', beforeCol.includes('b1.jpg') && !beforeCol.includes('a1.jpg'));
  ok('§3.3 …both after photos in the After column', afterCol.includes('a1.jpg') && afterCol.includes('a2.jpg') && !afterCol.includes('b1.jpg'));
  ok('§3.4 …and none lands in "Additional photos"', !html.includes('Additional photos'));
  const onlyBefore = buildInspectionReportHtml(reportOf([photo('b1', 'before')]));
  ok('§3.5 a pair with one side empty still says so', /<section class="ir-sec ir-ba">[\s\S]*?No photo[\s\S]*?<\/section>/.test(onlyBefore));
  const pdf = buildInspectionReportHtml(reportOf([photo('b1', 'before'), photo('a1', 'after')]), { forPdf: true });
  ok('§3.6 the PDF (forPdf) carries the same pair', /<section class="ir-sec ir-ba">/.test(pdf) && pdf.includes('b1.jpg') && pdf.includes('a1.jpg'));
}
{
  const older = buildInspectionReportHtml(reportOf([photo('p_lobby', 'a_lobby'), photo('p_rest', 'a_rest')]));
  ok('§3.7 an OLDER inspection keeps its photos under their areas', /<h2>Lobby<\/h2>[\s\S]*?p_lobby\.jpg[\s\S]*?<h2>Restrooms<\/h2>[\s\S]*?p_rest\.jpg/.test(older));
  ok('§3.8 …and shows no Before / After section', !/ir-ba/.test(older.replace(/<style>[\s\S]*?<\/style>/, '')));
  const stray = buildInspectionReportHtml(reportOf([photo('p_x', 'somewhere_else')]));
  ok('§3.9 a photo filed under neither still shows, under "Additional photos"', stray.includes('Additional photos') && stray.includes('p_x.jpg'));
}
{
  // The hub's page renders the same document from its projection, which must keep areaId.
  const hub = projectHubInspection({ id: 'ir_1', report: reportOf([photo('b1', 'before'), photo('a1', 'after')]) });
  eq('§3.10 the hub\'s projection keeps each photo\'s phase', hub.report.photos.map((p) => p.areaId), ['before', 'after']);
  ok('§3.11 …so the hub\'s page shows the pair', /<section class="ir-sec ir-ba">/.test(buildInspectionReportHtml(hub.report)));
}

// ── §4 the form, read mechanically ──────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const read = (p) => { try { return readFileSync(path.join(APP, p), 'utf8'); } catch { return ''; } };
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
{
  const FILL = code('src/components/InspectionFill.jsx');
  ok('§4.1 the form scores through the shared rule', /inspectionFillScore\(/.test(FILL));
  ok('§4.2 …and posts what the shared rule builds', /inspectionFillItems\(/.test(FILL));
  ok('§4.3 two photo tiles, before and after (scope inspection)', /scope="inspection"/.test(FILL) && /INSPECTION_PHOTO_PHASES\.BEFORE/.test(FILL) && /INSPECTION_PHOTO_PHASES\.AFTER/.test(FILL));
  ok('§4.4 …and no per-area gallery any more (replace means delete)', !/areaId=\{area\.id\}/.test(FILL));
  ok('§4.5 N/A is offered through the shared rule', /itemAllowsNa\(/.test(FILL));
  ok('§4.6 the office-only note is still sent', /internalNote/.test(FILL));
  ok('§4.7 one published template (or a named one) opens straight onto its list', /presetTemplateId/.test(FILL));
  const PDF = code('api/_lib/qc/reportPdf.js');
  ok('§4.8 the PDF renderer hands the document each photo\'s area', /areaId: r\.area_id/.test(PDF));
}

console.log(`test-inspection-fill: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
