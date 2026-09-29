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
// (gmb_reviews is intentionally NOT seeded — the Reviews surface is hidden for now.)
//
// WINDOW: seeds PAST_WEEKS of history + FUTURE_WEEKS of upcoming work (default 8+8)
// so the demo covers the whole dev period and future-dated testing without needing
// a refresh. Dates are runtime-relative to when it runs.
//
// SAFE BY DEFAULT: dry-run unless --commit. Idempotent — a --commit first DELETES
// the prior seed set (jobs id 'j_bkseed_*', their time_entries, inspections by
// 'tok_bkseed_*', templates by created_by='seed') then re-inserts, so re-running at
// any window never duplicates and never orphans. Non-seed rows are left untouched.
//
//   node scripts/seed-backend.mjs            # DRY RUN — prints the plan, writes nothing
//   node scripts/seed-backend.mjs --commit   # writes to the live backend
//
// Creds from app/.env.local: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLEANSPACE_ORG_ID (optional).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { scoreInspection } from '../src/lib/inspections.js';
import { IDENTITY } from '../src/brand/identity.generated.js';

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
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  if (line.trim().startsWith('#')) continue;
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2];
}
const SUPABASE_URL = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error('✖ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in app/.env.local'); process.exit(1); }
const sb = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

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
  console.log(`window: ${PAST_WEEKS}w back + ${FUTURE_WEEKS}w forward | target: ${SUPABASE_URL}\n`);

  // ── resolve entities from the live org_state blob (READ-ONLY) ─────────────────
  const { data: orgs, error: orgErr } = await sb.from('org_state').select('organization_id, version');
  if (orgErr) { console.error('✖ org_state read failed:', orgErr.message); process.exit(1); }
  const org = env.CLEANSPACE_ORG_ID || orgs?.[0]?.organization_id;
  if (!org) { console.error('✖ Could not resolve org id'); process.exit(1); }
  const { data: row, error: stErr } = await sb.from('org_state').select('state, version').eq('organization_id', org).maybeSingle();
  if (stErr || !row) { console.error('✖ org_state blob read failed:', stErr?.message); process.exit(1); }
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
  if (!sites.length || !crew.length || !inspectors.length) { console.error('✖ Not enough entities to seed against'); process.exit(1); }

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
      checkRows.push({ id, organization_id: org, template_id: closeout.id, template_version_id: closeout.verId, template_snapshot: { name: closeout.name, kind: 'checklist', schema: CLOSEOUT_SCHEMA }, client_id: site.clientId, site_id: site.id, job_id: null, completed_by_user_id: worker.id, items, completed_count: items.filter((i) => i.checked).length, total_count: items.length, performed_at: iso(at(-(1 + k * chkStepDays + (si % 2)), 23)) });
    }
  });

  // ── WORK ORDERS (problem_reports + threads) — the client-raised ticket queue ──
  // Increment 3 folded Complaints in here: a work order is type complaint|request|
  // issue, origin portal|internal, priority urgent|high|medium|low (drives the SLA
  // clock — urgent 2h … low 72h), status open|in_progress|awaiting_client|resolved.
  // Portal-raised (client) items carry a message thread; a few overdue-and-open ones
  // set escalated_at. Deterministic uuid5(`wo:i`) ids so a re-run replaces cleanly.
  const SLA_HOURS = { urgent: 2, high: 8, medium: 24, low: 72 };
  const WORK_ORDERS = [
    { type: 'complaint', origin: 'portal',   priority: 'urgent', status: 'open',            title: 'Crew arrived 40 minutes late for the Friday close', desc: 'Client asks that we confirm arrival windows going forward.' },
    { type: 'complaint', origin: 'portal',   priority: 'high',   status: 'in_progress',     title: 'Restroom soap dispensers found empty', desc: 'Two dispensers in the east wing were empty at open.' },
    { type: 'complaint', origin: 'portal',   priority: 'high',   status: 'resolved',        title: 'Trash not emptied in the 3rd-floor break room', desc: 'Reported Tuesday morning by the office manager.' },
    { type: 'complaint', origin: 'portal',   priority: 'medium', status: 'awaiting_client', title: 'Recycling combined with trash at pickup', desc: 'Client sustainability program requires separation — confirming the new pickup plan.' },
    { type: 'complaint', origin: 'portal',   priority: 'medium', status: 'resolved',        title: 'Lobby glass streaked at Monday open', desc: 'Streaking visible in the morning light; re-cleaned same day.' },
    { type: 'complaint', origin: 'portal',   priority: 'low',    status: 'resolved',        title: 'Vacuum missed under the conference table', desc: 'Noted after the board meeting.' },
    { type: 'request',   origin: 'portal',   priority: 'high',   status: 'awaiting_client', title: 'Quote for post-event cleanup', desc: 'Annual gala on the 14th — needs a one-time deep clean the morning after.' },
    { type: 'request',   origin: 'portal',   priority: 'medium', status: 'open',            title: 'Add a mid-week restroom deep-clean', desc: 'Requesting Wednesdays in addition to the nightly service.' },
    { type: 'request',   origin: 'portal',   priority: 'low',    status: 'resolved',        title: 'Swap to unscented restroom air fresheners', desc: 'A tenant reported a fragrance sensitivity.' },
    { type: 'request',   origin: 'internal', priority: 'low',    status: 'in_progress',     title: 'Replace worn entry mats', desc: 'Crew flagged frayed mats at the main entrance.' },
    { type: 'issue',     origin: 'internal', priority: 'urgent', status: 'in_progress',     title: 'Wrong floor finish used in the north corridor', desc: 'Being corrected on the next scheduled visit.' },
    { type: 'issue',     origin: 'internal', priority: 'high',   status: 'open',            title: 'Loading dock floor still greasy after clean', desc: 'Needs a degreaser pass before the next shift.' },
    { type: 'issue',     origin: 'internal', priority: 'high',   status: 'resolved',        title: 'Alarm not set on Thursday close', desc: 'Crew retrained on the close-out checklist.' },
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
    emit(0, 'in_progress');
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
      geofence_result: geo, override_reason: geo === 'override' ? 'crew_override_offsite' : null,
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

  // ═══════════ BROAD PASS: quotes, reviews, financials + blob slices ═══════
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
    google_reviews_actual: 87, google_reviews_goal: 100,
    indeed_reviews_actual: 12, indeed_reviews_goal: 50,
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
  console.log(`  jobs ${jobRows.length} (${pastJobs.length} done, ${sites.length} today, ${upcoming} upcoming, ${missed} missed, ${cancelled} cancelled) | time_entries ${teRows.length} (${pendingTE} pending, ${openTE} on-the-clock) | drive-route stops ${routeStops}`);
  const hrs = {};
  for (const te of teRows) hrs[te.user_name] = (hrs[te.user_name] || 0) + (te.duration_minutes || 0) / 60;
  console.log('  payroll hours/crew:', Object.entries(hrs).map(([n, h]) => `${n.split(' ')[0]}=${h.toFixed(0)}h`).join(' '));
  console.log(`  date span: jobs ${iso(at(-PAST_WEEKS * 7, 0)).slice(0, 10)} → ${iso(at(FUTURE_WEEKS * 7, 0)).slice(0, 10)}`);
  console.log(`  quotes ${quoteRows.length} (${quotePayRows.length} paid) | site photos ${mediaRows.length} | financial_snapshot 1`);
  console.log(`  BLOB slices: opportunities +${oppSlice.length} (won/lost) | notifications ${notifSlice.length} | payrollLines ${payrollLineSlice.length} | clientActivities ${clientActSlice.length} | contactActivities ${contactActSlice.length} | timeOff ${timeOffSlice.length} | reimbursements ${reimbSlice.length} | employeeDocuments ${edocSlice.length}`);

  if (!COMMIT) { console.log('\n✅ DRY RUN — nothing written. Re-run with --commit to write.\n'); return; }

  // ── COMMIT: clean prior seed set, then insert ─────────────────────────────────
  console.log('\n── Cleaning prior seed set (non-seed rows untouched) ──');
  const clean = async (label, q) => { const { error } = await q; if (error) throw new Error(`${label} cleanup failed: ${error.message}`); console.log(`  ✓ cleaned ${label}`); };
  await clean('time_entries', sb.from('time_entries').delete().eq('organization_id', org).like('job_id', 'j_bkseed_%'));
  await clean('jobs',         sb.from('jobs').delete().eq('organization_id', org).like('id', 'j_bkseed_%'));
  await clean('inspections',  sb.from('inspection_records').delete().eq('organization_id', org).like('public_token', 'tok_bkseed_%')); // cascades items
  await clean('templates',    sb.from('inspection_templates').delete().eq('organization_id', org).eq('created_by', 'seed'));           // cascades versions
  await clean('quotes',       sb.from('quotes').delete().eq('organization_id', org).like('public_token', 'qt_bkseed_%'));              // cascades quote_payments
  await clean('forms',        sb.from('forms').delete().eq('organization_id', org).like('slug', 'bkseed-%'));                          // prior seeded rows only (Forms retired 2026-09-19; cascades versions + submissions)
  await clean('gmb_reviews',  sb.from('gmb_reviews').delete().eq('organization_id', org).like('review_name', 'bkseed/%')); // remove prior seeded reviews (Reviews hidden)
  await clean('account_media', sb.from('account_media').delete().eq('organization_id', org).like('storage_path', 'seed/%'));
  await clean('work_order_messages', sb.from('work_order_messages').delete().eq('organization_id', org)); // before problem_reports (FK problem_id)
  await clean('problem_reports', sb.from('problem_reports').delete().eq('organization_id', org));          // Work Orders queue is demo-only — replace whole

  console.log('── Writing relational ──');
  const insert = async (table, rows, conflict = 'id') => {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict: conflict });
      if (error) throw new Error(`${table} write failed: ${error.message}`);
    }
    console.log(`  ✓ ${table}: ${rows.length}`);
  };
  await insert('inspection_templates', tmplRows);
  await insert('inspection_template_versions', tmplVerRows);
  await insert('inspection_records', inspRows);
  await insert('inspection_items', itemRows);
  await insert('checklist_results', checkRows);
  await insert('problem_reports', probRows);
  await insert('work_order_messages', woMsgRows);   // after problem_reports (FK problem_id)
  await insert('jobs', jobRows);                 // before time_entries (FK)
  await insert('time_entries', teRows);
  await insert('quotes', quoteRows);             // before quote_payments (FK)
  await insert('quote_payments', quotePayRows);
  await insert('financial_snapshot', [snapshotRow], 'organization_id');

  // ── Site photos: upload SVG files to Storage (ops-media), then insert rows ──
  console.log('── Uploading site photos to ops-media Storage ──');
  try { await sb.storage.createBucket('ops-media', { public: false }); } catch { /* bucket already exists */ }
  let uploaded = 0;
  for (const [path, svg] of mediaBlobs) {
    const { error } = await sb.storage.from('ops-media').upload(path, Buffer.from(svg, 'utf8'), { contentType: 'image/svg+xml', upsert: true });
    if (error) throw new Error(`storage upload failed (${path}): ${error.message}`);
    uploaded += 1;
  }
  console.log(`  ✓ uploaded ${uploaded} images to ops-media`);
  await insert('account_media', mediaRows);

  // ── COMMIT: blob slices via CAS (append only our 'bkseed' rows; never authority) ─
  console.log('── Writing org_state blob (CAS; non-authority slices only) ──');
  let blobDone = false;
  for (let attempt = 1; attempt <= 3 && !blobDone; attempt++) {
    const { data: cur, error: rerr } = await sb.from('org_state').select('state, version').eq('organization_id', org).maybeSingle();
    if (rerr || !cur) throw new Error(`blob read failed: ${rerr?.message}`);
    const nextState = { ...cur.state };
    for (const [key, seedRows] of Object.entries(BLOB_SLICES)) {
      const existing = Array.isArray(cur.state?.[key]) ? cur.state[key] : [];
      const kept = existing.filter((r) => !String(r?.id || '').startsWith(BLOB_PREFIX[key]));
      nextState[key] = [...kept, ...seedRows];
    }
    // Complaints were folded into Work Orders (relational problem_reports); drop the
    // now-dead blob slice so it can't resurface as a stale surface.
    delete nextState.complaints;
    const bytes = Buffer.byteLength(JSON.stringify(nextState), 'utf8');
    if (bytes > 3_400_000) throw new Error(`blob too large after seed: ${Math.round(bytes / 1024)} KB`);
    const { data, error } = await sb.from('org_state')
      .update({ state: nextState, version: cur.version + 1, updated_via: 'server', updated_at: new Date().toISOString() })
      .eq('organization_id', org).eq('version', cur.version).select('version');
    if (error) throw new Error(`blob write failed: ${error.message}`);
    if (Array.isArray(data) && data.length === 1) { console.log(`  ✓ org_state blob v${cur.version}→${cur.version + 1} (${Math.round(bytes / 1024)} KB)`); blobDone = true; }
    else console.log(`  … CAS conflict, re-reading (attempt ${attempt}/3)`);
  }
  if (!blobDone) throw new Error('blob CAS failed after 3 attempts — re-run.');
  console.log('\n✅ COMMIT complete.\n');
}

main().catch((e) => { console.error('\n✖ Seed failed:', e.message, '\n'); process.exit(1); });
