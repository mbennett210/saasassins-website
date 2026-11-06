// Backend demo seed — QC (inspections/checklists/problems/templates), jobs, and
// time_entries (Payroll/Variance) into the relational backend tables.
//
// The authenticated live site reads these surfaces from the real backend (not the
// localStorage demo stubs), and the tables are empty, so Quality/Payroll/Schedule/
// Quotes/Reviews/Dashboard open blank. This loads ABUNDANT, realistic demo
// data linked to the clients/sites/users already in the org_state blob.
//
// Writes: relational per-row tables (qc*, jobs, time_entries, quotes,
// financial_snapshot, account_media) + real SVG placeholder files uploaded to the
// 'ops-media' Storage bucket (so site photos actually render), AND a GUARDED, CAS'd
// write to the org_state blob for the blob-only slices (won/lost opportunities, bell
// notifications, reimbursement payroll lines, client/contact activities, PTO,
// reimbursements, employee docs). Complaints are NO LONGER a blob slice — they were
// folded into Work Orders (relational problem_reports), and the dead `complaints` key
// is deleted from the blob. The blob write appends ONLY non-authority demo rows (never
// users/permissions), is size-checked, retries on CAS.
//
// WINDOW: seeds PAST_WEEKS of history + FUTURE_WEEKS of upcoming work (default 8+8)
// so the demo covers the whole dev period and future-dated testing without needing
// a refresh. Dates are runtime-relative to when it runs.
//
// THE MANAGER'S DAY (2026-10-09): the same day the login-free demo shows (src/data/
// demoManagerDay.js), placed around the run's NOW on the org's clock, over the LIVE book: the
// manager with the most buildings (role manager first), her buildings in the day's building slots,
// the roster's cleaners in its crew slots (a seed id the live book still has keeps its own slot).
// It writes today's visits (jobs 'j_bkseed_md_*') with their punches — done, two on site now, late,
// no check-in, upcoming, called out — the checklist saves on them, the requests the customer raised
// in the hub on her buildings (problem_reports origin 'portal', raised by the building's client-hub
// user when it has one) WITH their threads, supply requests (an order placed, a delivery past a
// budget), and a cleaner's 42½-hour last pay week (overtime to approve). Today's cadence visit is
// left out at her buildings and for her cleaners, so nobody is booked or on the clock twice. It
// never changes a customer or a user: a checklist save shows on the manager's Checklists page only
// where the building assigns that cleaner a checklist (Customers → the location's checklists).
//
// SAFE BY DEFAULT: dry-run unless --commit. Idempotent — a --commit first DELETES
// the prior seed set (jobs id 'j_bkseed_*', their time_entries, inspections by
// 'tok_bkseed_*', templates by created_by='seed', the seed's own work orders by their
// deterministic ids, the manager's day's checklist saves and supply rows) then re-inserts, so
// re-running at any window never duplicates and never orphans. Non-seed rows are left untouched
// (a work order a customer raised in the hub is never deleted).
//
//   node scripts/seed-backend.mjs            # DRY RUN — prints the plan, writes nothing
//   node scripts/seed-backend.mjs --commit   # writes to the live backend
//
// Creds from app/.env.local: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLEANSPACE_ORG_ID (optional).
// A worktree has no env file: CS_ENV_FILE=<path to the main checkout's app/.env.local> reads that
// one instead (read here, never printed).
//
// TWO TRANSPORTS (scripts/_lib/seedWrite.mjs). With the service-role pair it reads and writes
// through supabase-js. With only SUPABASE_DB_URL (the main checkout's case) it goes through
// Postgres: the dry run reads inside a READ ONLY transaction it rolls back; --commit runs EVERY
// write in ONE transaction, the shared record's write a version-checked UPDATE inside it, and
// refuses any project but the production sandbox (nvsbknowpkmhrzbkcwxs). It prints the project
// ref, never the connection string. Site photos need Storage, so the Postgres path leaves them
// exactly as they are (it neither deletes nor writes account_media).
//
// The dry run prints the whole plan: per table, the rows it would delete (counted in the live
// database) and write; the shared record's fields it would change; and which alerts the rows it
// writes will set off, when, and for whom.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { scoreInspection } from '../src/lib/inspections.js';
import { countChecklistSubmission } from '../src/lib/checklistCount.js';
import { IDENTITY } from '../src/brand/identity.generated.js';
import { MAX_STATE_BYTES } from '../src/lib/stateBudget.js';
import { missedAfterStartMins, shiftLookbackHours } from '../src/lib/opsAlerts.js';
import { dayKey as orgDayKey, startOfDayKey, addDaysKey } from '../src/lib/dates.js';
import {
  assignManagers, planManagerDays, managerDayRows, managerDayIdUniverse, blobClientChanges,
  MD_JOB_PREFIX, MD_SUPPLY_ITEM_PREFIX, MD_SUPPLY_REQUEST_PREFIX,
} from './_lib/managerDaySeed.mjs';
import {
  pgTarget, checkPgPlan, explainPgPlan, countPgDeletes, runPgPlan, countRestDeletes, runRestPlan,
} from './_lib/seedWrite.mjs';

const COMMIT = process.argv.includes('--commit');
const MODE = COMMIT ? 'COMMIT (writing)' : 'DRY RUN (no writes)';

// ── seed window (tunable) ──────────────────────────────────────────────────────
const PAST_WEEKS = 8;
const FUTURE_WEEKS = 8;
const JOB_CADENCE_DAYS = 4;          // a clean per site every ~4 days
const INSPECTIONS_PER_SITE = 6;
const CHECKLISTS_PER_SITE = 5;

// ── env ────────────────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(process.env.CS_ENV_FILE || new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  if (line.trim().startsWith('#')) continue;
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SUPABASE_URL = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const REST = !!(SUPABASE_URL && KEY);
const PG = !REST && !!env.SUPABASE_DB_URL;
if (!REST && !PG) {
  console.error('✖ Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_DB_URL, in the env file.');
  process.exit(1);
}
// The Postgres path's target is checked before a socket opens (the production sandbox only).
const PG_TARGET = PG ? pgTarget(env.SUPABASE_DB_URL) : null;
if (PG_TARGET?.refusal) { console.error(PG_TARGET.refusal); process.exit(1); }
const sb = REST ? createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } }) : null;
const TARGET = REST
  ? `supabase-js, project ${(SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || '(unknown)'}`
  : `postgres, project ${PG_TARGET.ref} (${COMMIT ? 'ONE transaction' : 'READ ONLY, rolled back'})`;
// The shared record's size limit, with headroom (src/lib/stateBudget).
const BLOB_LIMIT = MAX_STATE_BYTES - 100_000;

// The reads the plan needs, through whichever transport this run has. Table and column names are
// this file's constants, never input; the org id is a bound parameter.
let pgClient = null;
async function pgRead() {
  if (pgClient) return pgClient;
  const { default: pg } = await import('pg');
  pgClient = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query('begin transaction read only');
  return pgClient;
}
let pgQueue = Promise.resolve();
function readRows(table, cols, org = null) {
  if (REST) return readRowsNow(table, cols, org);
  const next = pgQueue.then(() => readRowsNow(table, cols, org));
  pgQueue = next.catch(() => {});
  return next;
}
async function readRowsNow(table, cols, org) {
  if (REST) {
    let q = sb.from(table).select(cols);
    if (org) q = q.eq('organization_id', org);
    const { data, error } = await q;
    return { rows: data || [], error: error ? error.message : null };
  }
  try {
    const c = await pgRead();
    const r = await c.query(`select ${cols} from public.${table}${org ? ' where organization_id = $1' : ''}`, org ? [org] : []);
    return { rows: r.rows, error: null };
  } catch (e) {
    // A failed statement aborts the transaction; start a fresh read-only one for the next read.
    try { await pgClient.query('rollback'); await pgClient.query('begin transaction read only'); } catch { /* closed */ }
    return { rows: [], error: e.message };
  }
}
// End the read-only transaction (the reads are rolled back); `close` also ends the connection.
async function endReads({ close = true } = {}) {
  if (!pgClient) return;
  await pgQueue.catch(() => {});
  try { await pgClient.query('rollback'); } catch { /* ignore */ }
  if (close) { await pgClient.end().catch(() => {}); pgClient = null; }
}
const closeReads = () => endReads({ close: true });

// ── deterministic uuid v5 (stable ids → idempotent) ─────────────────────────────
const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
function uuid5(name) {
  const ns = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(String(name)).digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ── time helpers (runtime-relative) ─────────────────────────────────────────────
const NOW = new Date();
const at = (dayOffset, h, m = 0) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset, h, m, 0, 0);
const iso = (d) => d.toISOString();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

// Self-contained SVG placeholder scenes for site photos (uploaded as real files to
// the ops-media Storage bucket). Return RAW svg (not a data URL) — Storage serves bytes.
const FONT = 'font-family="system-ui,Segoe UI,Arial,sans-serif"';
const svgGrid = (x, y, cols, rows, w, h, gap, fill) => {
  let s = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) s += `<rect x="${x + c * (w + gap)}" y="${y + r * (h + gap)}" width="${w}" height="${h}" rx="2" fill="${fill}"/>`;
  return s;
};
const svgLabel = (t) => `<rect x="0" y="250" width="400" height="50" fill="rgba(15,23,42,0.5)"/><text x="16" y="283" ${FONT} font-size="19" font-weight="600" fill="#ffffff">${String(t).replace(/[<&>]/g, ' ')}</text>`;
const SCENES = {
  exterior: (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#93c5fd"/><stop offset="1" stop-color="#dbeafe"/></linearGradient></defs><rect width="400" height="300" fill="url(#sky)"/><circle cx="338" cy="52" r="28" fill="#fef08a"/><rect y="214" width="400" height="86" fill="#86efac"/><rect x="54" y="98" width="150" height="128" fill="#e2e8f0"/><rect x="54" y="98" width="150" height="16" fill="#64748b"/>${svgGrid(72, 126, 3, 3, 30, 22, 10, '#38bdf8')}<rect x="112" y="188" width="34" height="38" fill="#6d28d9"/><rect x="222" y="134" width="118" height="92" fill="#cbd5e1"/>${svgGrid(238, 158, 3, 2, 26, 22, 10, '#0ea5e9')}${svgLabel(t)}</svg>`,
  lobby: (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e7e5e4"/><rect y="200" width="400" height="100" fill="#d6d3d1"/><rect x="40" y="112" width="150" height="82" fill="#cbd5e1" stroke="#94a3b8" stroke-width="3"/><rect x="228" y="150" width="132" height="50" rx="6" fill="#0f766e"/><rect x="70" y="150" width="12" height="50" fill="#166534"/><circle cx="76" cy="146" r="22" fill="#22c55e"/>${svgLabel(t)}</svg>`,
  corridor: (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e2e8f0"/><polygon points="0,0 400,0 300,90 100,90" fill="#f1f5f9"/><polygon points="0,300 400,300 300,210 100,210" fill="#cbd5e1"/><polygon points="0,0 100,90 100,210 0,300" fill="#94a3b8"/><polygon points="400,0 300,90 300,210 400,300" fill="#94a3b8"/><rect x="132" y="112" width="136" height="88" fill="#dbeafe"/>${svgLabel(t)}</svg>`,
  pool: (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#bae6fd"/><rect y="110" width="400" height="60" fill="#e7e5e4"/><rect y="170" width="400" height="130" fill="#38bdf8"/><path d="M0 192 Q100 180 200 192 T400 192" stroke="#7dd3fc" stroke-width="4" fill="none"/><rect x="298" y="120" width="72" height="12" rx="6" fill="#f59e0b"/>${svgLabel(t)}</svg>`,
};

// ── QC template schemas (static — mirror the demo) ──────────────────────────────
const JANITORIAL_SCHEMA = { areas: [
  { id: 'a_entry', label: 'Entrance & Lobby', items: [ { id: 'i_entry_floor', label: 'Floors swept & mopped' }, { id: 'i_entry_glass', label: 'Glass & entry doors clean' }, { id: 'i_entry_trash', label: 'Trash emptied' } ] },
  { id: 'a_rest', label: 'Restrooms', items: [ { id: 'i_rest_fix', label: 'Fixtures sanitized' }, { id: 'i_rest_floor', label: 'Floors mopped' }, { id: 'i_rest_supply', label: 'Supplies restocked' }, { id: 'i_rest_mirror', label: 'Mirrors streak-free' } ] },
  { id: 'a_office', label: 'Offices & Common Areas', items: [ { id: 'i_off_surf', label: 'Surfaces dusted' }, { id: 'i_off_vac', label: 'Carpets vacuumed' }, { id: 'i_off_trash', label: 'Trash & recycling emptied' } ] },
  { id: 'a_break', label: 'Break Room', items: [ { id: 'i_brk_counter', label: 'Counters wiped down' }, { id: 'i_brk_sink', label: 'Sink cleaned' }, { id: 'i_brk_floor', label: 'Floor mopped' } ] },
] };
const RESTROOM_SCHEMA = { areas: [
  { id: 'a_fix', label: 'Fixtures', items: [ { id: 'i_fix_toilet', label: 'Toilets descaled & sanitized' }, { id: 'i_fix_urinal', label: 'Urinals sanitized' }, { id: 'i_fix_sink', label: 'Sinks & faucets polished' } ] },
  { id: 'a_surf', label: 'Surfaces', items: [ { id: 'i_surf_tile', label: 'Tile & grout scrubbed' }, { id: 'i_surf_mirror', label: 'Mirrors polished' }, { id: 'i_surf_partition', label: 'Partitions wiped' } ] },
  { id: 'a_supply', label: 'Supplies', items: [ { id: 'i_sup_soap', label: 'Soap dispensers filled' }, { id: 'i_sup_paper', label: 'Paper products stocked' } ] },
] };
const CLOSEOUT_SCHEMA = { areas: [
  { id: 'a_close', label: 'Close-Out', items: [ { id: 'c_lights', label: 'Lights off' }, { id: 'c_lock', label: 'All doors locked' }, { id: 'c_alarm', label: 'Alarm set' }, { id: 'c_cart', label: 'Cart cleaned & restocked' }, { id: 'c_trash', label: 'Trash taken to dumpster' } ] },
] };
const TEMPLATES = [
  { key: 'janitorial', name: 'Nightly Janitorial QC', kind: 'inspection', schema: JANITORIAL_SCHEMA, passThreshold: 80 },
  { key: 'restroom', name: 'Restroom Deep-Clean QC', kind: 'inspection', schema: RESTROOM_SCHEMA, passThreshold: 85 },
  { key: 'closeout', name: 'Nightly Close-Out Checklist', kind: 'checklist', schema: CLOSEOUT_SCHEMA, passThreshold: 100 },
  // A DRAFT template (unpublished, no published version) — the Quality → Templates
  // tab should show a work-in-progress alongside the live ones (edge case).
  { key: 'turnover', name: 'Move-Out / Turnover Inspection', kind: 'inspection', schema: RESTROOM_SCHEMA, passThreshold: 90, draft: true },
];
function flattenItems(schema, failKeys = [], commentByKey = {}) {
  const items = [];
  for (const area of schema.areas) for (const it of area.items) {
    items.push({ item_key: it.id, label: `${area.label}. ${it.label}`, rating: failKeys.includes(it.id) ? 'fail' : 'pass', comment: commentByKey[it.id] || null, photo_count: 0 });
  }
  return items;
}

async function main() {
  console.log(`\n=== ${IDENTITY.name} backend seed — ${MODE} ===`);
  console.log(`window: ${PAST_WEEKS}w back + ${FUTURE_WEEKS}w forward | target: ${TARGET}\n`);

  // ── resolve entities from the live org_state blob (READ-ONLY) ─────────────────
  const { rows: orgs, error: orgErr } = await readRows('org_state', 'organization_id, version');
  if (orgErr) throw new Error(`org_state read failed: ${orgErr}`);
  const org = env.CLEANSPACE_ORG_ID || orgs?.[0]?.organization_id;
  if (!org) throw new Error('Could not resolve org id');
  const { rows: stateRows, error: stErr } = await readRows('org_state', 'state, version', org);
  const row = stateRows[0] || null;
  if (stErr || !row) throw new Error(`org_state blob read failed: ${stErr || 'no row'}`);
  const state = row.state || {};
  const clients = state.clients || [];
  const sites = (state.sites || []).filter((s) => s.clientId);
  const users = state.users || [];
  const services = state.services || [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const crew = users.filter((u) => u.role === 'crew' && u.status !== 'disabled');
  const inspectors = users.filter((u) => ['owner', 'admin', 'manager'].includes(u.role) && u.status !== 'disabled');
  const managers = inspectors.filter((u) => u.role === 'manager' || u.role === 'admin');
  const owner = inspectors.find((u) => u.role === 'owner') || inspectors[0];
  const svcId = (kw) => (services.find((s) => (s.name || s.code || '').toLowerCase().includes(kw)) || services[0])?.id ?? null;
  const expOf = (site) => (Number.isFinite(site.expectedCleanMins) ? site.expectedCleanMins : 120);
  console.log(`org ${org} | blob v${row.version} (NOT modified) | clients:${clients.length} sites:${sites.length} crew:${crew.length} inspectors:${inspectors.length}`);
  if (!sites.length || !crew.length || !inspectors.length) throw new Error('Not enough entities to seed against');

  // ── THE MANAGER'S DAY (scripts/_lib/managerDaySeed.mjs): the unmanaged seed buildings get a
  // manager, then the day is laid over every managed building (READ-ONLY here) ──────────────
  const { clients: managedBook, assignments } = assignManagers({ clients, sites, users });
  const md = planManagerDays({ clients: managedBook, sites, users, services, state, now: NOW });
  const seedClientIds = clients.filter((c) => String(c.id).startsWith('cl_seed_')).map((c) => c.id);
  const mdIds = managerDayIdUniverse({ uuid5, seedClientIds });
  // The lines already in the threads this seed writes to (a thread summary counts them all).
  const { rows: existingMessages } = await readRows('client_messages', 'id, client_id, author_role, author_name, author_user_id, author_client_user_id, body, created_at', org);

  // ── TEMPLATES ─────────────────────────────────────────────────────────────────
  const tmplRows = [], tmplVerRows = [], tmplByKey = {};
  for (const t of TEMPLATES) {
    const id = uuid5(`tmpl:${t.key}`), verId = uuid5(`tmplver:${t.key}`);
    tmplByKey[t.key] = { id, verId, ...t };
    tmplRows.push({ id, organization_id: org, slug: `s_${t.key}`, name: t.name, kind: t.kind, rating_scale: { type: 'passfail', passThreshold: t.passThreshold }, is_published: !t.draft, published_version_id: t.draft ? null : verId, default_for_account: false, created_by: 'seed' });
    tmplVerRows.push({ id: verId, template_id: id, version_number: 1, schema: t.schema, status: t.draft ? 'draft' : 'published', published_at: t.draft ? null : iso(at(-PAST_WEEKS * 7 - 3, 9)) });
  }

  // ── INSPECTIONS (records + items) — spread across the past window ──────────────
  const inspRows = [], itemRows = [];
  const inspTemplates = ['janitorial', 'janitorial', 'restroom'];
  const COMMENTS = { i_off_vac: 'Two offices skipped, crew notified.', i_rest_supply: 'Soap dispensers empty, restocked on site.', i_entry_floor: 'Loading dock floor still greasy.', i_brk_floor: 'Break room floor sticky.', i_fix_toilet: 'One stall needs a re-scrub.', i_surf_tile: 'Grout line by the sink needs attention.', i_surf_mirror: 'Light streaking on the mirror.' };
  const inspStepDays = Math.max(3, Math.floor((PAST_WEEKS * 7 - 2) / INSPECTIONS_PER_SITE));
  sites.forEach((site, si) => {
    for (let k = 0; k < INSPECTIONS_PER_SITE; k++) {
      const t = tmplByKey[pick(inspTemplates, si + k)];
      const scale = { type: 'passfail', passThreshold: t.passThreshold };
      const heavy = (si * INSPECTIONS_PER_SITE + k) % 4 === 0;
      let failKeys;
      if (t.key === 'restroom') failKeys = heavy ? ['i_fix_toilet', 'i_surf_tile'] : ((si + k) % 2 ? ['i_surf_mirror'] : []);
      else failKeys = heavy ? ['i_entry_floor', 'i_off_vac', 'i_brk_floor'] : pick([[], ['i_off_vac'], ['i_rest_supply']], si + k);
      const relevantFails = failKeys.filter((fk) => JSON.stringify(t.schema).includes(`"${fk}"`));
      const commentByKey = Object.fromEntries(relevantFails.filter((fk) => COMMENTS[fk]).map((fk) => [fk, COMMENTS[fk]]));
      const items = flattenItems(t.schema, relevantFails, commentByKey);
      // A few inspections are opened but NOT yet scored (items left N/A) → result
      // 'needs_follow_up' with a null score. Exercises the Quality follow-up queue.
      const followUp = (si % 5 === 2) && k === INSPECTIONS_PER_SITE - 1;
      if (followUp) items.forEach((it, ii) => { it.rating = 'na'; it.comment = ii === 0 ? 'Inspection started — awaiting a re-visit to score.' : null; });
      const { overallScore, result } = scoreInspection(items, scale);
      const client = clientById.get(site.clientId);
      const inspector = pick(inspectors, si + k);
      const dayAgo = 2 + k * inspStepDays + (si % 3);
      const id = uuid5(`insp:${site.id}:${t.key}:${k}`);
      inspRows.push({ id, organization_id: org, public_token: `tok_bkseed_${id.slice(0, 10)}`, template_id: t.id, template_version_id: t.verId, template_snapshot: { name: t.name, kind: t.kind, rating_scale: scale, schema: t.schema }, client_id: site.clientId, site_id: site.id, job_id: null, inspector_user_id: inspector.id, client_name: client?.name ?? null, site_name: site.name, inspector_name: inspector.name, overall_score: overallScore, result, status: 'submitted', performed_at: iso(at(-dayAgo, 22)) });
      for (const it of items) itemRows.push({ id: uuid5(`item:${id}:${it.item_key}`), inspection_id: id, item_key: it.item_key, label: it.label, rating: it.rating, comment: it.comment, photo_count: 0 });
    }
  });

  // ── CHECKLISTS — spread across the past window ────────────────────────────────
  const checkRows = [];
  const closeout = tmplByKey.closeout;
  const chkStepDays = Math.max(2, Math.floor((PAST_WEEKS * 7 - 1) / CHECKLISTS_PER_SITE));
  sites.forEach((site, si) => {
    for (let k = 0; k < CHECKLISTS_PER_SITE; k++) {
      const checkedCount = 5 - ((si + k) % 3 === 0 ? 1 : 0);
      const items = CLOSEOUT_SCHEMA.areas[0].items.map((it, i) => ({ item_key: it.id, label: it.label, checked: i < checkedCount }));
      const worker = pick(crew, si + k);
      const id = uuid5(`chk:${site.id}:${k}`);
      // Counted against the schema, as the server does (CS-494, src/lib/checklistCount).
      checkRows.push({ id, organization_id: org, template_id: closeout.id, template_version_id: closeout.verId, template_snapshot: { name: closeout.name, kind: 'checklist', schema: CLOSEOUT_SCHEMA }, client_id: site.clientId, site_id: site.id, job_id: null, completed_by_user_id: worker.id, items, ...countChecklistSubmission(CLOSEOUT_SCHEMA, items), performed_at: iso(at(-(1 + k * chkStepDays + (si % 2)), 23)) });
    }
  });

  // ── WORK ORDERS (problem_reports + threads) — the client-raised ticket queue ──
  // Increment 3 folded Complaints in here: a work order is type complaint|request|
  // issue, origin portal|internal, priority urgent|medium|low (WO-18 — drives the SLA
  // clock: urgent 2h, medium 1 day, low 3 days), status open|in_progress|awaiting_client|resolved.
  // Portal-raised (client) items carry a message thread; a few overdue-and-open ones
  // set escalated_at. Deterministic uuid5(`wo:i`) ids so a re-run replaces cleanly.
  const SLA_HOURS = { urgent: 2, medium: 24, low: 72 };   // mirrors src/lib/workOrders.SLA_HOURS
  const WORK_ORDERS = [
    { type: 'complaint', origin: 'portal',   priority: 'urgent', status: 'open',            title: 'Crew arrived 40 minutes late for the Friday close', desc: 'Client asks that we confirm arrival windows going forward.' },
    { type: 'complaint', origin: 'portal',   priority: 'medium', status: 'in_progress',     title: 'Restroom soap dispensers found empty', desc: 'Two dispensers in the east wing were empty at open.' },
    { type: 'complaint', origin: 'portal',   priority: 'medium', status: 'resolved',        title: 'Trash not emptied in the 3rd-floor break room', desc: 'Reported Tuesday morning by the office manager.' },
    { type: 'complaint', origin: 'portal',   priority: 'medium', status: 'awaiting_client', title: 'Recycling combined with trash at pickup', desc: 'Client sustainability program requires separation — confirming the new pickup plan.' },
    { type: 'complaint', origin: 'portal',   priority: 'medium', status: 'resolved',        title: 'Lobby glass streaked at Monday open', desc: 'Streaking visible in the morning light; re-cleaned same day.' },
    { type: 'complaint', origin: 'portal',   priority: 'low',    status: 'resolved',        title: 'Vacuum missed under the conference table', desc: 'Noted after the board meeting.' },
    { type: 'request',   origin: 'portal',   priority: 'medium', status: 'awaiting_client', title: 'Quote for post-event cleanup', desc: 'Annual gala on the 14th — needs a one-time deep clean the morning after.' },
    { type: 'request',   origin: 'portal',   priority: 'medium', status: 'open',            title: 'Add a mid-week restroom deep-clean', desc: 'Requesting Wednesdays in addition to the nightly service.' },
    { type: 'request',   origin: 'portal',   priority: 'low',    status: 'resolved',        title: 'Swap to unscented restroom air fresheners', desc: 'A tenant reported a fragrance sensitivity.' },
    { type: 'request',   origin: 'internal', priority: 'low',    status: 'in_progress',     title: 'Replace worn entry mats', desc: 'Crew flagged frayed mats at the main entrance.' },
    { type: 'issue',     origin: 'internal', priority: 'urgent', status: 'in_progress',     title: 'Wrong floor finish used in the north corridor', desc: 'Being corrected on the next scheduled visit.' },
    { type: 'issue',     origin: 'internal', priority: 'urgent', status: 'open',            title: 'Loading dock floor still greasy after clean', desc: 'Needs a degreaser pass before the next shift.' },
    { type: 'issue',     origin: 'internal', priority: 'medium', status: 'resolved',        title: 'Alarm not set on Thursday close', desc: 'Crew retrained on the close-out checklist.' },
    { type: 'issue',     origin: 'internal', priority: 'medium', status: 'open',            title: 'Break room floor sticky by the sink', desc: 'Flagged on the nightly inspection.' },
  ];
  const probRows = [], woMsgRows = [];
  WORK_ORDERS.forEach((w, i) => {
    const site = pick(sites, i * 2);
    const client = clientById.get(site.clientId);
    const created = at(-(2 + i * 3), 8 + (i % 8));
    const id = uuid5(`wo:${i}`);
    const reporter = w.origin === 'internal' ? pick([...crew, ...inspectors], i) : null;
    const assignee = w.status === 'open' ? null : pick(managers.length ? managers : inspectors, i);
    const due = new Date(created.getTime() + SLA_HOURS[w.priority] * 3600000);
    const active = w.status !== 'resolved';
    const overdue = active && due.getTime() < NOW.getTime() && i % 3 === 0;
    const resolvedAt = w.status === 'resolved' ? new Date(created.getTime() + Math.min(SLA_HOURS[w.priority], 20) * 3600000) : null;
    probRows.push({
      id, organization_id: org, client_id: site.clientId, site_id: site.id, job_id: null,
      reported_by_user_id: reporter?.id ?? null, client_name: client?.name ?? null, site_name: site.name,
      title: w.title, description: w.desc, type: w.type, origin: w.origin, priority: w.priority, status: w.status,
      assignee_user_id: assignee?.id ?? null, photo_paths: [],
      created_at: iso(created), due_at: iso(due),
      escalated_at: overdue ? iso(new Date(due.getTime() + 3600000)) : null,
      resolved_at: resolvedAt ? iso(resolvedAt) : null,
    });
    // Message thread (Increment 2): portal items get a client↔office exchange; a few
    // internal issues get a crew↔office one. Resolved/awaiting_client add a closing line.
    if (w.origin === 'portal' || i % 3 === 0) {
      const thread = w.origin === 'portal'
        ? [{ role: 'client', uid: null, name: client?.name ?? 'Client', body: w.desc, at: created },
           { role: 'office', uid: owner?.id ?? null, name: owner?.name ?? 'Office', body: 'Thanks for flagging this — the crew is on it and we will confirm once it is done.', at: new Date(created.getTime() + 2 * 3600000) }]
        : [{ role: 'crew', uid: reporter?.id ?? null, name: reporter?.name ?? 'Crew', body: w.desc, at: created },
           { role: 'office', uid: owner?.id ?? null, name: owner?.name ?? 'Office', body: 'Logged — assigning a follow-up on the next visit.', at: new Date(created.getTime() + 3600000) }];
      if (w.status === 'awaiting_client') thread.push({ role: 'office', uid: owner?.id ?? null, name: owner?.name ?? 'Office', body: 'Could you confirm the preferred schedule so we can lock it in?', at: new Date(created.getTime() + 5 * 3600000) });
      if (resolvedAt) thread.push({ role: 'office', uid: owner?.id ?? null, name: owner?.name ?? 'Office', body: 'Resolved and verified on the morning walkthrough — thank you!', at: resolvedAt });
      thread.forEach((m, mi) => woMsgRows.push({ id: uuid5(`womsg:${i}:${mi}`), organization_id: org, problem_id: id, author_user_id: m.uid, author_role: m.role, author_name: m.name, body: m.body, translated_body: null, from_lang: null, created_at: iso(m.at) }));
    }
  });

  // ── JOBS (public.jobs) — past done + today + future upcoming, across the window ─
  const pastDays = [-1];                                    // always a "last night" clean
  for (let d = -JOB_CADENCE_DAYS; d >= -PAST_WEEKS * 7; d -= JOB_CADENCE_DAYS) pastDays.push(d);
  const futureDays = [];
  for (let d = 3; d <= FUTURE_WEEKS * 7; d += JOB_CADENCE_DAYS) futureDays.push(d);
  const svcJan = svcId('jan') || svcId('clean') || services[0]?.id || null;
  const nowIso = new Date().toISOString();
  const jobRows = [], pastJobs = [], todayJobs = [];
  sites.forEach((site, si) => {
    const primary = pick(crew, si);
    const exp = expOf(site);
    const startH = 17 + (si % 4);
    const seriesId = `ser_bkseed_${site.id}`;
    const emit = (day, status) => {
      const start = at(day, startH, 0);
      const end = new Date(start.getTime() + exp * 60000);
      const id = `j_bkseed_${site.id}_${day + PAST_WEEKS * 7 + 1}`;
      const job = { id, clientId: site.clientId, siteId: site.id, serviceId: svcJan, crewIds: [primary.id], startAt: iso(start), endAt: iso(end), status, notes: '', seriesId, recurrence: day === pastDays[pastDays.length - 1] ? { frequency: 'weekly', daysOfWeek: null, endType: 'count', endCount: 24, endDate: null } : null, createdAt: iso(at(-PAST_WEEKS * 7, 9)) };
      jobRows.push({ id, organization_id: org, data: job, start_at: iso(start), status, client_id: site.clientId, site_id: site.id, series_id: seriesId, updated_at: nowIso, updated_by: null, updated_by_build: 0, updated_by_tab: null });
      if (status === 'done') pastJobs.push({ job, site, exp, crewMember: primary, day });
      if (status === 'in_progress') todayJobs.push({ job, site, exp, crewMember: primary });
    };
    pastDays.forEach((d) => emit(d, 'done'));
    // Today at the manager's buildings, and for her cleaners, is the manager's day (below).
    if (!(md && (md.bookSiteIds.has(site.id) || md.crewIds.has(primary.id)))) emit(0, 'in_progress');
    futureDays.forEach((d) => emit(d, 'upcoming'));
    // Operational exceptions (edge cases): a missed clean (feeds the missed-clean KPI;
    // no time entry) and a client-cancelled visit (excluded from variance). Non-cadence
    // days so their ids never collide with the 'done' series above.
    if (si % 6 === 1) emit(-6, 'missed');
    if (si % 6 === 4) emit(-9, 'cancelled');
  });

  // ── TIME ENTRIES — one (sometimes two) per past job ──────────────────────────
  const teRows = [];
  const mkTE = (job, site, exp, user, dur, geo, dist, pending, suffix = '') => {
    const inAt = new Date(job.startAt);
    const outAt = new Date(inAt.getTime() + dur * 60000);
    const client = clientById.get(site.clientId);
    const hasCoords = Number.isFinite(site.lat) && Number.isFinite(site.lng);
    return {
      id: uuid5(`te:${job.id}:${user.id}${suffix}`), organization_id: org, job_id: job.id, series_id: job.seriesId, shift_id: null,
      client_id: site.clientId, site_id: site.id, user_id: user.id, client_name: client?.name ?? null, site_name: site.name, user_name: user.name,
      scheduled_start: job.startAt, scheduled_end: job.endAt, expected_minutes_snapshot: exp,
      clock_in_at: iso(inAt), clock_out_at: iso(outAt), duration_minutes: dur,
      clock_in_lat: hasCoords ? site.lat : null, clock_in_lng: hasCoords ? site.lng : null,
      clock_in_accuracy_m: hasCoords ? 8 : null, clock_in_distance_m: geo === 'override' ? dist : (hasCoords ? dist : null),
      clock_out_lat: hasCoords ? site.lat : null, clock_out_lng: hasCoords ? site.lng : null,
      geofence_result: geo, override_reason: geo === 'override' ? 'geofence_disabled' : null,
      source: 'crew_mobile', status: 'completed', approval_status: pending ? 'pending' : 'approved',
    };
  };
  pastJobs.forEach((pj, idx) => {
    const { job, site, exp, crewMember, day } = pj;
    const pending = day === -1;
    let swing, geo = 'inside', dist = 8 + (idx % 6);
    if (pending) {
      const kind = idx % 4;
      if (kind === 0) swing = 44; else if (kind === 1) swing = -26; else if (kind === 2) { swing = -4; geo = 'override'; dist = 130; } else swing = 6;
    } else {
      swing = (idx % 7 === 0) ? 40 : (idx % 5 === 0 ? -22 : ((idx % 3) - 1) * 9);
      if (idx % 11 === 0) { geo = 'outside'; dist = 610; }
    }
    const dur = Math.max(35, exp + swing);
    teRows.push(mkTE(job, site, exp, crewMember, dur, geo, dist, pending));
    if (idx % 6 === 0 && crew.length > 1) {
      const second = pick(crew, idx + 1) === crewMember ? pick(crew, idx + 2) : pick(crew, idx + 1);
      teRows.push(mkTE(job, site, exp, second, Math.max(30, Math.round(dur * 0.5)), 'inside', 10, pending, ':2'));
    }
  });

  // ── OPEN ENTRIES ("who's on the clock now") — a couple of today's in-progress jobs
  //    carry a running punch (clock_out_at null, status in_progress) so the live board,
  //    Variance "on the clock", and the open-entry index aren't empty. ──
  todayJobs.slice(0, 3).forEach((tj, i) => {
    const startedAgo = 60 + i * 25;                       // clocked in 60–110 min ago
    const inAt = new Date(NOW.getTime() - startedAgo * 60000);
    teRows.push({ ...mkTE(tj.job, tj.site, tj.exp, tj.crewMember, startedAgo, 'inside', 9, true),
      clock_in_at: iso(inAt), clock_out_at: null, clock_out_lat: null, clock_out_lng: null, duration_minutes: null, status: 'in_progress' });
  });

  // ── DRIVE ROUTES — multi-stop nights so Variance → Drive Time is populated. ─────
  // deriveDriveSegments pairs a user's consecutive entries when the clock-OUT→next
  // clock-IN gap is 1–180 min; the one-site-per-night cadence above never pairs. Here
  // a few drivers run a real 2-stop route on dedicated (non-cadence) nights: two done
  // jobs at two geocoded sites, entries laid end-to-end with a ~25–33 min drive between
  // them. On those nights the driver has no other punches, so each yields one clean
  // A→B segment (the stub estimate maps distance from the sites' lat/lng).
  const geoSites = sites.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const routeDrivers = crew.slice(0, 3);
  let routeStops = 0;
  if (geoSites.length >= 2) routeDrivers.forEach((driver, ri) => {
    for (let n = 0; n < 2; n++) {
      const day = -(3 + (ri * 2 + n) * 2);              // -3,-5 | -7,-9 | -11,-13
      const a = pick(geoSites, ri + n), b = pick(geoSites, ri + n + 1);
      if (a.id === b.id) continue;
      let cursor = at(day, 17, 0);
      [a, b].forEach((s, sIdx) => {
        const dur = Math.max(45, Math.round(expOf(s) * 0.9));
        const inAt = new Date(cursor);
        const outAt = new Date(inAt.getTime() + dur * 60000);
        const jid = `j_bkseed_route_${driver.id}_${Math.abs(day)}_${sIdx}`;
        const job = { id: jid, clientId: s.clientId, siteId: s.id, serviceId: svcJan, crewIds: [driver.id], startAt: iso(inAt), endAt: iso(outAt), status: 'done', notes: 'Route stop.', seriesId: null, recurrence: null, createdAt: iso(at(day - 1, 9)) };
        jobRows.push({ id: jid, organization_id: org, data: job, start_at: iso(inAt), status: 'done', client_id: s.clientId, site_id: s.id, series_id: null, updated_at: nowIso, updated_by: null, updated_by_build: 0, updated_by_tab: null });
        teRows.push(mkTE(job, s, expOf(s), driver, dur, 'inside', 10, false, ':route'));
        cursor = new Date(outAt.getTime() + (25 + sIdx * 8) * 60000);   // drive to the next stop
        routeStops += 1;
      });
    }
  });

  // ═══════════ THE MANAGER'S DAY (src/data/demoManagerDay.js) ═══════════════
  const mdOut = md ? managerDayRows(md, { org, uuid5, nowIso, schema: CLOSEOUT_SCHEMA, existingMessages, seedMessageIds: new Set(mdIds.messageIds) }) : null;
  if (mdOut) {
    jobRows.push(...mdOut.jobRows);
    teRows.push(...mdOut.teRows);
    probRows.push(...mdOut.probRows);
    woMsgRows.push(...mdOut.msgRows);
  }

  // ═══════════ BROAD PASS: quotes, financials + blob slices ═══════
  const contacts = state.contacts || [];
  const invoices = state.invoices || [];
  const company = state.company || {};
  const contactOf = (clientId) => contacts.find((c) => c.companyId === clientId) || null;
  const centsFrom = (n, def) => Math.round((Number.isFinite(n) ? n : def) * 100);

  // ── QUOTES (+ quote_payments) ──
  const QUOTE_STATUSES = ['signed', 'sent', 'paid', 'draft', 'sent', 'signed', 'paid', 'sent'];
  const quoteRows = [], quotePayRows = [];
  clients.slice(0, 10).forEach((client, ci) => {
    const status = pick(QUOTE_STATUSES, ci);
    const monthly = Number.isFinite(client.revenue) ? client.revenue : 1200;
    const amountCents = centsFrom(monthly, 1200);
    const id = uuid5(`quote:${client.id}`);
    const contact = contactOf(client.id);
    const q = {
      id, organization_id: org, public_token: `qt_bkseed_${id.slice(0, 12)}`,
      contact_id: client.primaryContactId ?? null, contact_name: contact?.name ?? client.primaryContact ?? client.name,
      contact_email: contact?.email ?? null, contact_phone: contact?.phone ?? null,
      title: `Service proposal — ${client.name}`, description: `Recurring janitorial services for ${client.name}.`,
      amount_cents: amountCents, currency: 'usd', status, template_key: 'cleanspace_quote_v1',
      fields: { clientName: contact?.name ?? client.name, companyName: client.name, frequency: '5 nights/week', restrooms: String(2 + (ci % 4)), area: `${8 + ci * 2},000 sq ft`, fee: `$${monthly.toLocaleString()}/month` },
      created_by: 'seed', created_at: iso(at(-(6 + ci * 3), 10)), updated_at: iso(at(-(2 + ci), 12)),
      sent_at: status === 'draft' ? null : iso(at(-(5 + ci * 3), 9)),
      paid_at: status === 'paid' ? iso(at(-(3 + ci), 15)) : null,
    };
    if (status === 'signed' || status === 'paid') {
      q.admin_signer_name = owner?.name ?? 'Owner'; q.admin_signed_at = iso(at(-(4 + ci), 11));
      q.client_signer_name = contact?.name ?? client.name; q.client_signed_at = iso(at(-(4 + ci), 14));
    }
    quoteRows.push(q);
    if (status === 'paid') quotePayRows.push({ id: uuid5(`qpay:${id}`), quote_id: id, organization_id: org, amount_cents: amountCents, currency: 'usd', method: 'card', status: 'paid', paid_at: q.paid_at });
  });

  // ── SITE PHOTOS (account_media rows + real SVG files uploaded to ops-media) ──
  // Reference photos per site (Photos tab, scope 'cleaning_instruction') + a
  // before/after pair on the most recent clean per a few sites (scope 'clean').
  const SCENE_KEYS = ['exterior', 'lobby', 'corridor', 'pool'];
  const CAPTIONS = ['Main entrance', 'Reception / lobby', 'Main corridor', 'Amenity / pool deck', 'Break room', 'Common area'];
  const mediaRows = [];
  const mediaBlobs = new Map(); // storage_path -> raw svg
  const addMedia = (id, scope, site, refId, scene, caption, path, areaId = null) => {
    mediaBlobs.set(path, SCENES[scene](`${site.name} — ${caption}`));
    mediaRows.push({ id, organization_id: org, scope, client_id: site.clientId, site_id: site.id, area_id: areaId, ref_id: refId, kind: 'image', mime_type: 'image/svg+xml', storage_path: path, thumb_path: path, size_bytes: 40000 + mediaRows.length * 900, duration_secs: null, caption, uploaded_by_user_id: owner?.id ?? null, client_media_id: null });
  };
  sites.forEach((site, si) => {
    const n = 2 + (si % 3); // 2–4 reference photos per site
    for (let k = 0; k < n; k++) addMedia(uuid5(`media:${site.id}:ref:${k}`), 'cleaning_instruction', site, null, pick(SCENE_KEYS, si + k), pick(CAPTIONS, si + k), `seed/${org}/${site.id}/ref_${k}.svg`);
  });
  // Before/After pair on last night's clean. JobDetail + CrewJobVisit query these by
  // areaId 'before'/'after' (the phase tag stored in account_media.area_id) — it MUST
  // be set or the job galleries render empty (the bug this seed pass fixes).
  pastJobs.filter((pj) => pj.day === -1).slice(0, 6).forEach((pj) => {
    [['before', 'Before', 'corridor'], ['after', 'After', 'lobby']].forEach(([area, phase, scene], p) => addMedia(uuid5(`media:${pj.job.id}:${phase}`), 'clean', pj.site, pj.job.id, scene, `${phase} — reception`, `seed/${org}/${pj.site.id}/clean_${pj.job.id}_${p}.svg`, area));
  });
  // Inspection evidence (scope 'inspection', ref_id = record) + Work Order photos
  // (scope 'problem_report', ref_id = work order) so those galleries aren't empty.
  const siteById = new Map(sites.map((s) => [s.id, s]));
  inspRows.filter((r) => r.result !== 'pass').slice(0, 6).forEach((r, i) => {
    const site = siteById.get(r.site_id) || sites[0];
    addMedia(uuid5(`media:insp:${r.id}`), 'inspection', site, r.id, pick(SCENE_KEYS, i), 'Inspection finding', `seed/${org}/${site.id}/insp_${r.id}.svg`);
  });
  probRows.slice(0, 6).forEach((p, i) => {
    const site = siteById.get(p.site_id) || sites[0];
    const path = `seed/${org}/${site.id}/wo_${p.id}.svg`;
    addMedia(uuid5(`media:wo:${p.id}`), 'problem_report', site, p.id, pick(SCENE_KEYS, i + 1), 'Reported issue', path);
    p.photo_paths = [path];   // mirror onto the work order row (photo_paths array)
  });

  // ── FINANCIAL SNAPSHOT (single upsert; drives Dashboard KPIs) ──
  const monthlyRevCents = clients.reduce((s, c) => s + centsFrom(c.revenue, 0), 0);
  const openInvoiceCents = invoices.filter((i) => i.status !== 'paid').reduce((s, i) => s + centsFrom(i.amount ?? i.total, 0), 0);
  const outstandingQuoteCents = quoteRows.filter((q) => q.status === 'sent').reduce((s, q) => s + q.amount_cents, 0);
  const snapshotRow = {
    organization_id: org,
    revenue_current_month_cents: monthlyRevCents,
    open_receivables_cents: openInvoiceCents,
    all_time_collected_cents: monthlyRevCents * 9,
    outstanding_quotes_cents: outstandingQuoteCents,
    past_due_30_cents: Math.round(openInvoiceCents * 0.35),
    ar_cents: openInvoiceCents,
    new_business_actual_cents: outstandingQuoteCents + quoteRows.filter((q) => q.status === 'signed' || q.status === 'paid').reduce((s, q) => s + q.amount_cents, 0),
    new_business_goal_cents: 100000000,
    mrr_cents: monthlyRevCents,
    source: 'seed', updated_at: iso(NOW),
  };

  // ── BLOB SLICES (org_state) — deals, notifications, activities, PTO, HR ──────────
  // Deterministic 'bkseed'-prefixed ids so the blob write can replace its own rows.
  // (Complaints are NO LONGER a blob slice — they were folded into Work Orders, which
  // are relational problem_reports seeded above; the dead `complaints` key is dropped
  // from the blob in the CAS write.)

  // Won/Lost opportunities — the seed already carries ~15 OPEN deals; add a few CLOSED
  // ones so the pipeline has won + lost history to explore. pipelineId/stage borrowed
  // from an existing open deal so they resolve to a real board.
  const existingOpps = Array.isArray(state.opportunities) ? state.opportunities : [];
  const borrowPl = existingOpps[0]?.pipelineId ?? null;
  const borrowStage = existingOpps[0]?.stage ?? null;
  const OPP_OUTCOMES = [
    { status: 'won',  title: 'Annual janitorial contract', value: 4800 },
    { status: 'won',  title: 'Floor-care add-on',          value: 1600 },
    { status: 'lost', title: 'One-time deep clean',        value: 900 },
    { status: 'lost', title: '3-location janitorial bid',  value: 5200 },
  ];
  const oppSlice = OPP_OUTCOMES.map((o, i) => {
    const client = pick(clients, i);
    const closed = at(-(8 + i * 5), 12);
    return { id: `opp_bkseed_${i}`, clientId: client.id, primaryContactId: client.primaryContactId ?? null, title: `${client.name}. ${o.title}`, value: o.value, pipelineId: borrowPl, stage: borrowStage, status: o.status, expectedCloseDate: iso(closed), stageChangedAt: iso(closed), createdAt: iso(at(-(30 + i * 5), 10)) };
  });

  const clientActSlice = clients.slice(0, 8).map((client, i) => ({ id: `clact_bkseed_${i}`, clientId: client.id, kind: 'note', authorUserId: pick(inspectors, i).id, body: pick(['Quarterly account review completed — client satisfied.', 'Walkthrough scheduled with the facilities manager.', 'Added a night-porter shift at the client’s request.', 'Renewed the annual service agreement.'], i), attachment: null, occurredAt: iso(at(-(5 + i * 3), 11)), createdAt: iso(at(-(5 + i * 3), 11)) }));
  const contactActSlice = contacts.slice(0, 8).map((c, i) => ({ id: `act_bkseed_${i}`, contactId: c.id, kind: 'note', authorUserId: pick(inspectors, i).id, body: pick(['Called to confirm the updated cleaning schedule.', 'Emailed the latest inspection report.', 'Discussed adding restroom deep-cleans.', 'Followed up on the last walkthrough action items.'], i), occurredAt: iso(at(-(4 + i * 3), 13)), createdAt: iso(at(-(4 + i * 3), 13)) }));
  const timeOffSlice = crew.slice(0, 4).map((u, i) => ({ id: `to_bkseed_${i}`, userId: u.id, startDate: ymd(at(3 + i * 9, 0)), endDate: ymd(at(5 + i * 9, 0)), reason: pick(['Vacation', 'Personal day', 'Medical appointment', 'Family'], i), kind: 'planned', createdBy: owner?.id ?? null, createdAt: iso(at(-(2 + i), 9)) }));

  // Reimbursements — approved ones carry decided-by/at + a payrollLineId, and each gets
  // a matching payroll EARNING line (category 'reimbursement', not taxable), mirroring
  // ReimbursementsTab.approve so Payroll shows the reimbursement instead of dangling.
  const reimbSlice = crew.slice(0, 5).map((u, i) => {
    const status = pick(['approved', 'pending', 'approved', 'pending', 'approved'], i);
    const amount = [24.5, 58, 15.75, 42, 31.2][i] ?? 20;
    const periodKey = ymd(at(-14, 0));
    const r = { id: `rmb_bkseed_${i}`, userId: u.id, amount, description: pick(['Cleaning supplies — restock', 'Fuel for site transfer', 'Parking at downtown site', 'Replacement mop heads', 'Gloves and trash liners'], i), receiptFileId: null, receiptName: `receipt-${i + 1}.jpg`, status, periodKey, submittedAt: iso(at(-(6 + i * 2), 10)), submittedBy: u.id, decidedBy: null, decidedAt: null, payrollLineId: null };
    if (status === 'approved') { r.decidedBy = owner?.id ?? null; r.decidedAt = iso(at(-(4 + i * 2), 15)); r.payrollLineId = `pl_bkseed_rmb_${i}`; }
    return r;
  });
  const payrollLineSlice = reimbSlice.filter((r) => r.status === 'approved').map((r) => ({ id: r.payrollLineId, userId: r.userId, periodKey: r.periodKey, kind: 'earning', category: 'reimbursement', label: r.description, amount: Math.abs(r.amount), taxable: false, createdBy: owner?.id ?? null, note: `reimbursement ${r.id}`, createdAt: r.decidedAt }));

  const edocMenu = ['W-4.pdf', 'Direct Deposit Authorization.pdf', 'OSHA Certification.pdf', 'I-9 Verification.pdf', 'Handbook Acknowledgement.pdf'];
  const edocSlice = users.filter((u) => u.status !== 'disabled').slice(0, 6).flatMap((u, i) => [
    { id: `edoc_bkseed_${i}a`, userId: u.id, name: pick(edocMenu, i), mimeType: 'application/pdf', sizeBytes: 84000 + i * 1200, fileId: null, uploadedAt: iso(at(-(20 + i), 9)), uploadedBy: owner?.id ?? null },
    { id: `edoc_bkseed_${i}b`, userId: u.id, name: pick(edocMenu, i + 2), mimeType: 'application/pdf', sizeBytes: 51000 + i * 900, fileId: null, uploadedAt: iso(at(-(12 + i), 9)), uploadedBy: owner?.id ?? null },
  ]);

  // In-app bell notifications — none are seeded by default, so the bell is empty. Give
  // the owner + a couple managers a mix of quality/sales/message pings (some read) and
  // crew a schedule ping, using role-visible eventKeys from the notification catalog.
  const NOTIF_MENU = [
    { eventKey: 'problemReported',  title: 'New work order reported', body: 'Loading dock floor still greasy after clean.', url: '/quality' },
    { eventKey: 'inspectionFailed', title: 'Inspection needs follow-up', body: 'A nightly janitorial inspection scored below its threshold.', url: '/quality' },
    { eventKey: 'quoteSigned',      title: 'A client signed a quote', body: 'A service agreement you sent was signed.', url: '/quotes' },
    { eventKey: 'newClientMessage', title: 'New email from a client', body: 'Re: this week’s cleaning schedule.', url: '/messaging' },
    { eventKey: 'invoicePaid',      title: 'An invoice was paid', body: 'A client paid their latest invoice.', url: '/invoices' },
  ];
  const notifManagers = [owner, ...managers].filter(Boolean).slice(0, 3);
  const mgrNotifs = notifManagers.flatMap((u, ui) => NOTIF_MENU.map((m, mi) => {
    const created = at(-(mi + ui * 2), 9 + mi);
    return { id: `ntf_bkseed_${ui}_${mi}`, userId: u.id, eventKey: m.eventKey, title: m.title, body: m.body, url: m.url, createdAt: iso(created), readAt: mi % 3 === 0 ? iso(at(-(mi + ui * 2), 12)) : null };
  }));
  const crewNotifs = crew.slice(0, 2).flatMap((u, ui) => [
    { id: `ntf_bkseed_c${ui}_0`, userId: u.id, eventKey: 'jobCreatedOrRescheduled', title: 'New job assigned to you', body: 'Tonight’s clean has been scheduled.', url: '/schedule', createdAt: iso(at(-(1 + ui), 8)), readAt: null },
    { id: `ntf_bkseed_c${ui}_1`, userId: u.id, eventKey: 'accountOpsUpdated', title: 'An account you work was updated', body: 'Cleaning instructions changed.', url: '/', createdAt: iso(at(-(3 + ui), 10)), readAt: iso(at(-(2 + ui), 11)) },
  ]);
  const notifSlice = [...mgrNotifs, ...crewNotifs];

  // The manager's day's call-out (today, sick), with the seed's own prefix so the next run replaces it.
  if (mdOut) timeOffSlice.push(...mdOut.timeOff);
  // The seed's bell rows are history, never news: marked delivered so the push dispatcher (which
  // pushes any undelivered row under six hours old) can never send one to a phone.
  for (const n of notifSlice) n.pushed = true;
  const BLOB_SLICES = { opportunities: oppSlice, notifications: notifSlice, payrollLines: payrollLineSlice, clientActivities: clientActSlice, contactActivities: contactActSlice, timeOff: timeOffSlice, reimbursements: reimbSlice, employeeDocuments: edocSlice };
  const BLOB_PREFIX = { opportunities: 'opp_bkseed_', notifications: 'ntf_bkseed_', payrollLines: 'pl_bkseed_', clientActivities: 'clact_bkseed_', contactActivities: 'act_bkseed_', timeOff: 'to_bkseed_', reimbursements: 'rmb_bkseed_', employeeDocuments: 'edoc_bkseed_' };

  // ── PLAN summary ──────────────────────────────────────────────────────────────
  const failCount = inspRows.filter((r) => r.result !== 'pass').length;
  const followUpCount = inspRows.filter((r) => r.result === 'needs_follow_up').length;
  const draftTmpl = tmplRows.filter((t) => !t.is_published).length;
  const pendingTE = teRows.filter((r) => r.approval_status === 'pending').length;
  const openTE = teRows.filter((r) => r.clock_out_at === null).length;
  const upcoming = jobRows.filter((r) => r.status === 'upcoming').length;
  const missed = jobRows.filter((r) => r.status === 'missed').length;
  const cancelled = jobRows.filter((r) => r.status === 'cancelled').length;
  const woByType = (t) => probRows.filter((r) => r.type === t).length;
  console.log('\n── Generated ──');
  console.log(`  templates ${tmplRows.length} (${draftTmpl} draft) | inspections ${inspRows.length} (${failCount} fail/follow-up, ${followUpCount} needs-follow-up) | items ${itemRows.length} | checklists ${checkRows.length}`);
  console.log(`  work orders ${probRows.length} (complaint ${woByType('complaint')} / request ${woByType('request')} / issue ${woByType('issue')}) + ${woMsgRows.length} messages`);
  console.log(`  jobs ${jobRows.length} (${pastJobs.length} done, ${jobRows.filter((r) => r.status === 'in_progress' && !r.id.startsWith('j_bkseed_md_')).length} cadence today, ${upcoming} upcoming, ${missed} missed, ${cancelled} cancelled) | time_entries ${teRows.length} (${pendingTE} pending, ${openTE} on-the-clock) | drive-route stops ${routeStops}`);
  const hrs = {};
  for (const te of teRows) hrs[te.user_name] = (hrs[te.user_name] || 0) + (te.duration_minutes || 0) / 60;
  console.log('  payroll hours/crew:', Object.entries(hrs).map(([n, h]) => `${n.split(' ')[0]}=${h.toFixed(0)}h`).join(' '));
  console.log(`  date span: jobs ${iso(at(-PAST_WEEKS * 7, 0)).slice(0, 10)} → ${iso(at(FUTURE_WEEKS * 7, 0)).slice(0, 10)}`);
  console.log(`  quotes ${quoteRows.length} (${quotePayRows.length} paid) | site photos ${mediaRows.length} | financial_snapshot 1`);
  console.log(`  BLOB slices: opportunities +${oppSlice.length} (won/lost) | notifications ${notifSlice.length} | payrollLines ${payrollLineSlice.length} | clientActivities ${clientActSlice.length} | contactActivities ${contactActSlice.length} | timeOff ${timeOffSlice.length} | reimbursements ${reimbSlice.length} | employeeDocuments ${edocSlice.length}`);

  printManagerDay(md, mdOut, assignments, jobRows.filter((r) => r.status === 'in_progress' && !r.id.startsWith(MD_JOB_PREFIX)).length);

  // ═══════════ THE PLAN: deletes (the seed's own rows only), then writes, then the shared record ═══
  // Work orders and their messages: the SEED's own, by their deterministic ids (the old 14 and every
  // id the manager's day can write) — never the whole table.
  const seedWoIds = [...new Set([...probRows.map((r) => r.id), ...mdIds.problemIds])];
  const D = (table, where, label = table, extra = {}) => ({ kind: 'delete', table, where: [{ col: 'organization_id', op: 'eq', value: org }, ...where], label, ...extra });
  const U = (table, rows, label = table, conflict = ['id'], extra = {}) => ({ kind: 'upsert', table, rows, conflict, label, ...extra });
  const steps = [
    D('time_entries', [{ col: 'job_id', op: 'like', value: 'j_bkseed_%' }]),
    // before the jobs: a checklist save's job reference is set null when its job goes
    D('checklist_results', [{ col: 'id', op: 'in', value: mdIds.checklistIds }], 'checklist_results (manager\'s day)'),
    D('jobs', [{ col: 'id', op: 'like', value: 'j_bkseed_%' }]),
    D('inspection_records', [{ col: 'public_token', op: 'like', value: 'tok_bkseed_%' }], 'inspection_records (+ their items)'),
    D('inspection_templates', [{ col: 'created_by', op: 'eq', value: 'seed' }], 'inspection_templates (+ their versions)'),
    D('quotes', [{ col: 'public_token', op: 'like', value: 'qt_bkseed_%' }], 'quotes (+ their payments)'),
    D('forms', [{ col: 'slug', op: 'like', value: 'bkseed-%' }]),
    D('account_media', [{ col: 'storage_path', op: 'like', value: 'seed/%' }], 'account_media', { restOnly: true }),
    D('work_order_messages', [{ col: 'problem_id', op: 'in', value: seedWoIds }]),
    D('problem_reports', [{ col: 'id', op: 'in', value: seedWoIds }]),
    D('client_messages', [{ col: 'id', op: 'in', value: mdIds.messageIds }], 'client_messages (manager\'s day)'),
    D('supply_requests', [{ col: 'id', op: 'like', value: `${MD_SUPPLY_REQUEST_PREFIX}%` }], 'supply_requests (manager\'s day)'),
    D('supply_items', [{ col: 'id', op: 'like', value: `${MD_SUPPLY_ITEM_PREFIX}%` }], 'supply_items (manager\'s day)'),
    U('inspection_templates', tmplRows),
    U('inspection_template_versions', tmplVerRows),
    U('inspection_templates', mdOut?.templateRows || [], 'inspection_templates (each visited building\'s checklist)'),
    U('inspection_template_versions', mdOut?.versionRows || [], 'inspection_template_versions (the buildings\' checklists)'),
    U('inspection_records', inspRows),
    U('inspection_items', itemRows),
    U('checklist_results', checkRows),
    U('problem_reports', probRows),
    U('work_order_messages', woMsgRows),                 // after problem_reports (FK problem_id)
    U('jobs', jobRows),                                  // before time_entries (FK)
    U('time_entries', teRows),
    U('checklist_results', mdOut?.checkRows || [], 'checklist_results (manager\'s day)'),   // after the jobs they name
    U('quotes', quoteRows),                              // before quote_payments (FK)
    U('quote_payments', quotePayRows),
    U('financial_snapshot', [snapshotRow], 'financial_snapshot', ['organization_id']),
    U('client_messages', mdOut?.cmsgRows || [], 'client_messages (the customer\'s hub threads)'),
    U('client_message_threads', mdOut?.threadRows || [], 'client_message_threads (the thread summaries)', ['organization_id', 'client_id']),
    // The master list's rows the day uses, before the switches that name them (FK). Upserted on
    // their backfill ids and never deleted: the catalog is the org's (managerDaySeed says why).
    U('supply_catalog', mdOut?.supplyCatalogRows || [], 'supply_catalog (the items the day uses)'),
    U('supply_items', mdOut?.supplyItemRows || []),
    U('supply_requests', mdOut?.supplyRequestRows || []),
    U('account_media', mediaRows, 'account_media', ['id'], { restOnly: true }),
  ];
  const runSteps = PG ? steps.filter((st) => !st.restOnly) : steps;
  // The shared record: the seed's own slices replaced, the dead complaints slice dropped, and the
  // seed customers' supervisors, checklists and budget (managerDaySeed blobClientChanges).
  const blob = {
    org,
    apply: (cur) => {
      const next = { ...cur };
      const changes = [];
      for (const [key, seedRows] of Object.entries(BLOB_SLICES)) {
        const existing = Array.isArray(cur?.[key]) ? cur[key] : [];
        const kept = existing.filter((r) => !String(r?.id || '').startsWith(BLOB_PREFIX[key]));
        next[key] = [...kept, ...seedRows];
        changes.push({ field: key, from: existing.length, to: next[key].length, note: `${existing.length - kept.length} seed rows replaced by ${seedRows.length}` });
      }
      if ('complaints' in next) { delete next.complaints; changes.push({ field: 'complaints', from: 'present', to: 'deleted' }); }
      const cc = blobClientChanges(Array.isArray(cur?.clients) ? cur.clients : [], {
        assignments, picks: mdOut?.picks || {}, budgetClientIds: mdOut?.budgetClientIds || [],
      });
      next.clients = cc.clients;
      for (const ch of cc.changes) changes.push({ field: `clients[${ch.clientId}].${ch.field}`, from: ch.from, to: ch.to, note: ch.name });
      return { state: next, changes };
    },
  };

  if (!COMMIT) {
    console.log('\n── The plan, table by table (the dry run counts what it would delete in the live database) ──');
    let counts;
    if (PG) {
      const c = await pgRead();
      const check = await checkPgPlan(c, runSteps);
      counts = await countPgDeletes(c, runSteps, check.types);
      if (check.skipped.length) console.log(`  skipped (the project has no such table): ${check.skipped.join(', ')}`);
      if (check.problems.length) console.log(`  ✖ THE PLAN DOES NOT FIT THE DATABASE: ${check.problems.join('; ')}`);
      else console.log('  ✓ every row\'s columns exist in its table');
      // Every statement the commit would send, planned by the live database and never run.
      const ex = await explainPgPlan(c, runSteps, check.types, { blob: { state: blob.apply(state).state, org, version: row.version } });
      console.log(ex.problems.length
        ? `  ✖ ${ex.problems.length} of ${ex.statements} statements were refused by the database's planner: ${ex.problems.join(' | ')}`
        : `  ✓ all ${ex.statements} statements the commit would send were parsed, type-checked and planned by the live database (EXPLAIN, nothing run)`);
      const restOnly = steps.filter((st) => st.restOnly).map((st) => st.label);
      if (restOnly.length) console.log(`  left as they are on the Postgres path (Storage needs the service-role key): ${[...new Set(restOnly)].join(', ')}`);
    } else counts = await countRestDeletes(sb, runSteps);
    for (const st of runSteps) {
      if (st.kind === 'delete') {
        const n = counts.find((x) => x.label === st.label)?.n;
        console.log(`  − ${st.label}: delete ${n ?? '(table absent)'}`);
      } else console.log(`  + ${st.label}: write ${st.rows.length}`);
    }
    const sim = blob.apply(state);
    const bytes = Buffer.byteLength(JSON.stringify(sim.state), 'utf8');
    console.log(`\n── The shared record (org_state v${row.version} → v${Number(row.version) + 1} on commit, CAS; ${Math.round(bytes / 1024)} KB of the ${Math.round(BLOB_LIMIT / 1024)} KB limit) ──`);
    for (const ch of sim.changes) console.log(`  ~ ${ch.field}: ${ch.from} → ${ch.to}${ch.note ? `  (${ch.note})` : ''}`);
    printAlertForecast({ md, mdOut, jobRows, teRows, state: { ...state, clients: sim.state.clients }, now: NOW });
    await closeReads();
    console.log('\n✅ DRY RUN — nothing written. Re-run with --commit to write.\n');
    return;
  }

  // ── COMMIT ─────────────────────────────────────────────────────────────────────
  if (PG) {
    console.log('\n── Writing (Postgres: ONE transaction; the shared record CAS inside it) ──');
    const c = await pgRead();
    await endReads({ close: false });
    try {
      const out = await runPgPlan(c, { steps: runSteps, blob, maxBlobBytes: BLOB_LIMIT, log: (l) => console.log(l) });
      if (out.skipped.length) console.log(`  skipped (no such table): ${out.skipped.join(', ')}`);
      console.log('  site photos (account_media + Storage): left as they are on the Postgres path');
    } finally { await c.end().catch(() => {}); pgClient = null; }
  } else {
    console.log('\n── Uploading site photos to ops-media Storage ──');
    try { await sb.storage.createBucket('ops-media', { public: false }); } catch { /* bucket already exists */ }
    let uploaded = 0;
    for (const [path, svg] of mediaBlobs) {
      const { error } = await sb.storage.from('ops-media').upload(path, Buffer.from(svg, 'utf8'), { contentType: 'image/svg+xml', upsert: true });
      if (error) throw new Error(`storage upload failed (${path}): ${error.message}`);
      uploaded += 1;
    }
    console.log(`  ✓ uploaded ${uploaded} images to ops-media`);
    console.log('── Writing (supabase-js) ──');
    await runRestPlan(sb, { steps: runSteps, blob, maxBlobBytes: BLOB_LIMIT, log: (l) => console.log(l) });
  }
  console.log('\n✅ COMMIT complete.\n');
}

// ── what the plan prints ─────────────────────────────────────────────────────────────────────
function printManagerDay(md, out, assignments, todayCadence) {
  console.log('\n── The manager\'s day (src/data/demoManagerDay.js, over the live book) ──');
  if (assignments.length) console.log(`  managers given: ${assignments.map((a) => `${a.name} → ${a.toName}`).join(' | ')}`);
  if (!md) { console.log('  SKIPPED: nobody supervises a building, so there is no manager whose day to place.'); return; }
  const fmt = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: md.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  console.log(`  placed ${fmt(md.day.nowMs)} ${md.tz} on ${md.day.dayKey} · her day: ${md.primary.name} (${md.primary.role})`);
  console.log(`  books: ${md.managers.map((m) => `${m.u.name} ${m.book.length} (${m.book.map((c) => c.name).join(', ')})`).join(' | ')}`);
  console.log(`  her slots: ${Object.entries(md.assigned).map(([k, c]) => `${k}→${c.name}`).join(' | ')}`);
  console.log(`  other managers' slots: ${Object.entries(md.xAssigned).map(([k, c]) => `${k}→${c.name}`).join(' | ') || '(none)'}`);
  console.log(`  crew slots: ${Object.entries(md.crewMap).map(([k, u]) => `${k}→${u.name}`).join(' | ')}${md.thinRoster ? '  (fewer cleaners than slots: one person holds two)' : ''}`);
  const N = md.day.nowMs;
  const openJobs = new Set(out.teRows.filter((t) => !t.clock_out_at).map((t) => t.job_id));
  const punched = new Set(out.teRows.map((t) => t.job_id));
  const offIds = new Set(md.day.timeOff.map((t) => t.userId));
  const supName = (c) => md.userById.get(c?.supervisorId)?.name || '—';
  for (const j of [...md.day.jobs].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))) {
    const start = Date.parse(j.startAt);
    const c = md.clientById.get(j.clientId);
    const state = j.crewIds.every((id) => offIds.has(id)) ? 'called out' : openJobs.has(j.id) ? 'on site' : punched.has(j.id) ? 'done'
      : start > N ? 'upcoming' : (N - start) > 30 * 60000 ? 'no check-in (past the 30-min mark)' : 'late';
    const save = out.checkRows.find((r) => r.job_id === j.id);
    console.log(`   · ${fmt(start)}  ${c?.name || j.clientId} [${supName(c)}] — ${j.crewIds.map((id) => md.userById.get(id)?.name || id).join(' + ')} — ${state}${save ? ` · checklist ${save.completed_count}/${save.total_count}` : ''}`);
  }
  console.log(`  today's cadence visits left in the plan (outside the day's buildings and cleaners): ${todayCadence}`);
  const ot = out.teRows.filter((t) => t.job_id.includes('_md-ot-')).reduce((n, t) => n + (t.duration_minutes || 0), 0);
  console.log(`  jobs ${out.jobRows.length} (incl. ${out.jobRows.filter((r) => r.id.includes('_md-ot-')).length} overtime-week visits) | punches ${out.teRows.length} (${out.teRows.filter((t) => t.approval_status === 'pending' && t.clock_out_at).length} pending, ${out.teRows.filter((t) => !t.clock_out_at).length} on the clock) | overtime week ${(ot / 60).toFixed(1)}h`);
  console.log(`  checklists filed under ${out.templateRows.length} buildings; saves ${out.checkRows.length} (${out.checkRows.map((r) => `${r.completed_count}/${r.total_count}`).join(', ')}); picks for ${Object.values(out.picks).reduce((n, p) => n + Object.keys(p).length, 0)} cleaner×building`);
  const stage = (p) => `${p.priority} ${p.status}`;
  console.log(`  requests ${out.probRows.length} + ${out.msgRows.length} thread lines (raised in the portal by the building's contact): ${out.probRows.map((p) => `${p.client_name}: ${stage(p)}`).join(' | ')}`);
  const waiting = out.threadRows.filter((t) => t.last_author_role === 'client');
  console.log(`  customer messages ${out.cmsgRows.length} in ${out.threadRows.length} building threads; waiting for the office's first reply: ${waiting.map((t) => `${md.clientById.get(t.client_id)?.name} (${Math.round((N - Date.parse(t.last_message_at)) / 60000)} min)`).join(', ')}`);
  console.log(`  supplies: ${out.supplyCatalogRows.length} catalog items (${out.supplyCatalogRows.map((c) => c.name).join(', ')}), ${out.supplyItemRows.length} switched on, ${out.supplyRequestRows.map((r) => `${r.status} $${(r.total_cents / 100).toFixed(2)} at ${md.clientById.get(r.client_id)?.name}`).join(' | ')}`);
  console.log(`  call-out today: ${md.day.timeOff.map((t) => md.userById.get(t.userId)?.name).join(', ')} (timeOff 'to_bkseed_md_callout')`);
  if (out.dropped.length) console.log(`  dropped (would overlap the same person's punch): ${out.dropped.join(', ')}`);
}

// Which alerts the rows this seed writes will set off, when, and for whom. Only ONE walker reacts to
// seed rows: the missed-shift alert (ALR-11, lib/opsAlerts getDueShiftAlerts), which fires on seed
// jobs by the owner's call (2026-09-26) for any visit nobody has clocked into by its start + the
// missed mark — the called-out ones included, since the walker does not read time off. Every other
// walker skips the seed's customers or jobs (lib/opsAlerts SEED-DATA SKIP; lib/ticketAlerts;
// lib/preShiftReminders), and a row written straight to a table raises nothing the API would have
// (a customer message's office bell, a request's customer email).
function printAlertForecast({ md, mdOut, jobRows, teRows, state, now }) {
  console.log('\n── What the written rows will set off ──');
  const settings = state.opsSettings || {};
  const mark = missedAfterStartMins(settings);
  const lookbackMs = shiftLookbackHours(settings) * 3600000;
  const N = now.getTime();
  const tz = md?.tz || state.company?.timezone || 'America/New_York';
  const fmt = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  const dayEnd = startOfDayKey(addDaysKey(orgDayKey(new Date(N), tz), 1), tz).getTime() - 1;   // the org day's end
  const covered = new Set(teRows.map((t) => t.job_id));
  const users = state.users || [];
  const owners = users.filter((u) => u.role === 'owner' && u.status === 'active');
  const nameOf = (id) => users.find((u) => u.id === id)?.name || id;
  const clientOf = (id) => (state.clients || []).find((c) => c.id === id);
  const TERMINAL = new Set(['done', 'completed', 'cancelled', 'canceled', 'in_progress']);   // the walker's own (TERMINAL_JOB + in_progress)
  const due = jobRows.map((r) => r.data).filter((j) => {
    const start = Date.parse(j.startAt);
    return !TERMINAL.has(j.status) && !covered.has(j.id) && start >= N - lookbackMs && start + mark * 60000 <= dayEnd;
  }).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  console.log(`  MISSED-SHIFT alerts (ALR-11) — one per visit nobody clocks into, ${mark} min after its start, today:`);
  for (const j of due) {
    const at = Date.parse(j.startAt) + mark * 60000;
    const c = clientOf(j.clientId);
    const spoc = c?.supervisorId ? nameOf(c.supervisorId) : null;
    const to = [...new Set([spoc, ...owners.map((o) => o.name)].filter(Boolean))];
    console.log(`   · ${at <= N ? 'on the next cron run' : fmt(at)} — ${c?.name || j.clientId} (${j.crewIds.map(nameOf).join(' + ')}${j.id.startsWith(MD_JOB_PREFIX) ? '' : ', cadence'}) → ${to.join(', ')}`);
  }
  const later = jobRows.filter((r) => r.status === 'upcoming' && Date.parse(r.start_at) > dayEnd).length;
  console.log(`    each as a bell row + a phone push (to every device subscribed on those logins; quiet hours hold a push, never this one), and as a TEXT to each recipient's profile phone if Twilio is configured on Vercel — the seed users' phones are fictional 555-01xx numbers (owner logins: ${owners.map((o) => o.name).join(', ')}).`);
  console.log(`    later days: the seed's ${later} upcoming cadence visits set off the same alert on their own days unless someone clocks in (unchanged from earlier runs).`);
  console.log('  Nothing else: checklist / inspection / supply / pre-shift / ticket alerts skip seed jobs and customers; the customer messages and requests are rows, not API posts, so no office bell or customer email goes out for them; no customer login is created (the portal shape); the seed\'s own bell rows are marked delivered, so none is pushed.');
  if (mdOut?.cmsgRows?.length) console.log(`  The office will SEE (no alert): ${mdOut.threadRows.filter((t) => t.last_author_role === 'client').length} customer messages waiting for a first reply in Client Requests, and ${mdOut.probRows.filter((p) => p.status !== 'resolved').length} open customer requests.`);
}

main().catch(async (e) => { await closeReads(); console.error('\n✖ Seed failed:', e.message, '\n'); process.exitCode = 1; });
