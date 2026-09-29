// Handler-level authorization gate for the media caption ROUTE
// (POST /api/account-media/caption in api/account-media/[...path].js). CS-040: the client
// (accountMediaApi.js updateMediaCaption → MediaGallery saveCaption) POSTs this route, but
// it did not exist, so every caption save 404'd in production ("Unknown route"). This drives
// the REAL handler through the loopback Supabase fake (fake-supabase.mjs — no network, no
// credentials), so the gate and the store write are under test, not a decision function.
//
//   node scripts/test-account-media-caption-route.mjs
//
// Proves: no session → 401 (nothing stored); a crew member NOT assigned to the media's site
// → 403 (nothing stored); a holder — an office role (owner/admin/manager) at any site, or a
// crew member standing at the site — → 200 with the caption stored; a media id owned by
// another org → refused (403), the other org's row untouched (organization pinning). Plus
// input validation: a missing id and an over-cap caption → 400; an empty caption clears the
// note.
//
// REGRESSION (BUILD_INTEGRITY §6a): delete the `action === 'caption'` branch from the handler
// and every 401/403/200 case falls to the tail 404 → this suite goes red. Restore it → green.
// The caption cap is asserted against the source-of-truth constant MAX_CAPTION_LEN, never a
// restated literal (THE LAW II.3).
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
// NB: store.js pulls in the supabase module graph, so it (and MAX_CAPTION_LEN) is imported
// DYNAMICALLY below, AFTER installFakeSupabase() — a static import here would load a real
// client before the hook takes, and the roster read would hang on the network.

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

const media = (await import('../api/account-media/[...path].js')).default;
const { MAX_CAPTION_LEN } = await import('../api/_lib/accountMedia/store.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) { pass += 1; } else { fails.push(detail ? `${label} — ${detail}` : label); } };

// ── roster + logins (the manager-tier-gates shape) ──
const SITE = 'st_media';    // site A — crewA is standing crew here
const SITE_B = 'st_other';  // site B — crewA is NOT assigned here (site-spoof case)
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner' },
  admin: { id: 'u_admin', role: 'admin' },
  mgr: { id: 'u_mgr', role: 'manager' },
  crewA: { id: 'u_crew_a', role: 'crew' }, // standing crew AT the media's site
  crewU: { id: 'u_crew_u', role: 'crew' }, // crew NOT assigned to the site
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: { role: p.role, org_user_id: p.id, org_id: ORG },
}]));

// A fresh media row before each case, so "stored / not stored" is unambiguous. `am_1` lives
// in THIS org at SITE (crewA is standing there); `am_at_b` lives in THIS org at SITE_B (crewA
// is NOT assigned there — the site-spoof case); `am_other` lives in ANOTHER org — the caption
// route must never touch it. `startCaption` seeds an existing note (the clear case).
function seed(startCaption = null) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: {
        users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
        sites: [
          { id: SITE, clientId: 'cl_1', standingCrewIds: [PEOPLE.crewA.id] },
          { id: SITE_B, clientId: 'cl_2', standingCrewIds: [] },
        ],
        clients: [{ id: 'cl_1', standingCrewIds: [] }, { id: 'cl_2', standingCrewIds: [] }],
      } }],
      account_media: [
        { id: 'am_1', organization_id: ORG, site_id: SITE, scope: 'cleaning_instruction', kind: 'image', mime_type: 'image/jpeg', storage_path: `${ORG}/${SITE}/abcdef0123456789.jpg`, caption: startCaption },
        { id: 'am_at_b', organization_id: ORG, site_id: SITE_B, scope: 'cleaning_instruction', kind: 'image', mime_type: 'image/jpeg', storage_path: `${ORG}/${SITE_B}/abcdef0123456789.jpg`, caption: null },
        { id: 'am_other', organization_id: OTHER_ORG, site_id: 'st_elsewhere', scope: 'cleaning_instruction', kind: 'image', mime_type: 'image/jpeg', storage_path: `${OTHER_ORG}/st_elsewhere/abcdef0123456789.jpg`, caption: 'other-org note' },
      ],
    },
    logins,
  });
}
const captionOf = (id) => world.tables.account_media.find((m) => m.id === id)?.caption;

async function callCaption(token, body) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: 'caption' };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('caption: no response')), 5000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(media(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}

// ── no session → 401, nothing stored ──
seed();
let r = await callCaption(null, { id: 'am_1', caption: 'sneaky' });
ok('no session → 401', r.status === 401, `got ${r.status}`);
ok('no session stores nothing', captionOf('am_1') === null, `caption is ${JSON.stringify(captionOf('am_1'))}`);

// ── holders (office roles + assigned crew) → 200, caption stored ──
for (const who of ['owner', 'admin', 'mgr', 'crewA']) {
  seed();
  const note = `note from ${who}`;
  r = await callCaption(`tok-${who}`, { id: 'am_1', caption: note });
  ok(`${who} → 200`, r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  ok(`${who} stored the caption`, captionOf('am_1') === note, `caption is ${JSON.stringify(captionOf('am_1'))}`);
}

// ── crew NOT assigned to the site → 403, nothing stored ──
seed();
r = await callCaption('tok-crewU', { id: 'am_1', caption: 'not mine' });
ok('unassigned crew → 403', r.status === 403, `got ${r.status}`);
ok('unassigned crew stores nothing', captionOf('am_1') === null, `caption is ${JSON.stringify(captionOf('am_1'))}`);

// ── cross-org id → refused, the other org's row untouched (organization pinning) ──
seed();
r = await callCaption('tok-owner', { id: 'am_other', caption: 'reach across orgs' });
ok('cross-org id → refused (403)', r.status === 403, `got ${r.status}`);
ok('cross-org row untouched', captionOf('am_other') === 'other-org note', `caption is ${JSON.stringify(captionOf('am_other'))}`);

// ── (L3 F1) spoofed body.siteId → 403; the gate follows the ROW's OWN site, not the body ──
// crewA IS standing at SITE (A) but the media (am_at_b) lives at SITE_B where crewA is NOT
// assigned. A caller who passes siteId: SITE must still be refused, and nothing stored.
// RED under the mutation "requireSiteAssignment(req, res, body.siteId, …)" — crewA would then
// gate against the site they claimed and pass.
seed();
r = await callCaption('tok-crewA', { id: 'am_at_b', caption: 'spoofed', siteId: SITE });
ok('spoofed body.siteId → 403 (gate on the row\'s own site)', r.status === 403, `got ${r.status} ${JSON.stringify(r.body)}`);
ok('spoofed site stores nothing', captionOf('am_at_b') === null, `caption is ${JSON.stringify(captionOf('am_at_b'))}`);

// ── (L3 F2) an unauthenticated call makes NO database read — auth precedes any read ──
// The fake logs every query; a no-session caption call must read no account_media row
// (mediaOwnerSite is never reached). RED when the leading requireAuthority is removed:
// the site gate's own auth check still yields 401, but a mediaOwnerSite SELECT runs first.
seed();
r = await callCaption(null, { id: 'am_1', caption: 'x' });
const dbReads = world.log.filter((q) => q.table === 'account_media');
ok('no session → 401 (auth-before-read)', r.status === 401, `got ${r.status}`);
ok('no session makes NO account_media read', dbReads.length === 0, `${dbReads.length} query(ies): ${JSON.stringify(dbReads.map((q) => q.op))}`);

// ── input validation ──
seed();
r = await callCaption('tok-owner', { caption: 'no id' });
ok('missing id → 400', r.status === 400, `got ${r.status}`);

seed();
r = await callCaption('tok-owner', { id: 'am_1', caption: 'x'.repeat(MAX_CAPTION_LEN + 1) });
ok('over-cap caption → 400', r.status === 400, `got ${r.status}`);
ok('over-cap caption stores nothing', captionOf('am_1') === null, `caption is ${JSON.stringify(captionOf('am_1'))}`);

seed();
r = await callCaption('tok-owner', { id: 'am_1', caption: 'y'.repeat(MAX_CAPTION_LEN) });
ok('caption at the cap → 200', r.status === 200, `got ${r.status}`);

// ── empty caption clears an existing note → 200, caption null ──
seed('an old note');
r = await callCaption('tok-owner', { id: 'am_1', caption: '' });
ok('empty caption → 200', r.status === 200, `got ${r.status}`);
ok('empty caption clears the note', captionOf('am_1') === null, `caption is ${JSON.stringify(captionOf('am_1'))}`);

if (fails.length) { console.error('\naccount-media-caption-route FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\naccount-media-caption-route: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
