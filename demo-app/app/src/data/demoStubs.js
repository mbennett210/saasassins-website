// Demo seed for the localStorage-STUB features — Quotes and Quality
// (inspections / templates / problems / checklists). These run off their own
// storage keys, NOT the main INITIAL_STATE store, so demoBootstrap writes them on
// reseed to keep those surfaces populated. IDs are stable (idempotent reseed) and
// entity FKs resolve against INITIAL_STATE by name so they stay linked to the same
// clients / sites / people the rest of the demo shows.
import { INITIAL_STATE } from './seed';
import { scoreInspection } from '../lib/inspections';
import { computeDueAt } from '../lib/workOrders';
import { IDENTITY } from '../brand/identity.generated.js';
import { QC_CHECKLISTS_STUB_KEY } from './stubKeys';

// Storage keys (must match the adapters: quotesApi / qcApi).
export const QUOTES_STUB_KEY = 'cleanspace_quotes_stub_v2';
export const QC_TEMPLATES_STUB_KEY = 'cleanspace_qc_templates_stub_v1';
export const QC_INSPECTIONS_STUB_KEY = 'cleanspace_qc_inspections_stub_v1';
export const QC_PROBLEMS_STUB_KEY = 'cleanspace_qc_problems_stub_v1';
// The checklist stub's key is shared with lib/qcApi (its reader/writer) and carries the
// row shape's version — see data/stubKeys.js.
export { QC_CHECKLISTS_STUB_KEY } from './stubKeys';

export const DEMO_STUB_KEYS = [
  QUOTES_STUB_KEY, QC_TEMPLATES_STUB_KEY,
  QC_INSPECTIONS_STUB_KEY, QC_PROBLEMS_STUB_KEY, QC_CHECKLISTS_STUB_KEY,
];

const iso = (daysAgo, hour = 14) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const clientBy = (frag) => (INITIAL_STATE.clients || []).find((c) => (c.name || '').includes(frag)) || null;
const firstSiteOf = (client) => (INITIAL_STATE.sites || []).find((s) => s.clientId === client?.id) || null;
const userBy = (frag) => (INITIAL_STATE.users || []).find((u) => (u.name || '').includes(frag)) || null;

// ── Quotes ───────────────────────────────────────────────────────────────────
function buildQuotes() {
  const aventura = clientBy('Aventura');
  const northside = clientBy('Northside');
  const coral = clientBy('Coral Gables');
  const q = (id, client, contactName, contactEmail, fields, status, extra = {}) => ({
    id, public_token: `tok${id}`, template_key: 'cleanspace_quote_v1',
    contact_id: client?.primaryContactId ?? null, contact_name: contactName, contact_email: contactEmail,
    title: `Quote for ${client?.name || contactName}`,
    fields: { clientName: contactName, companyName: client?.name || '', frequency: '', restrooms: '', area: '', ...fields },
    status, created_at: iso(extra._created ?? 6), updated_at: iso(extra._updated ?? 1), ...extra,
  });
  return {
    quotes: [
      q('quote_northside', northside, 'Morgan Hayes', 'morgan.hayes@nsauto.com',
        { fee: '$2,450/month - 3-location nightly janitorial', frequency: '5 nights/week', restrooms: '6', area: '26,000 sq ft' },
        'signed', { _created: 14, _updated: 2, sent_at: iso(12), admin_signer_name: IDENTITY.company.signatory.name, admin_signed_at: iso(11), client_signer_name: 'Morgan Hayes', client_signed_at: iso(9) }),
      q('quote_aventura', aventura, 'Jamie Park', 'jamie@aventuradental.com',
        { fee: '$1,160/month - weekly janitorial', frequency: 'Weekly', restrooms: '2', area: '4,200 sq ft' },
        'sent', { _created: 5, _updated: 3, sent_at: iso(3) }),
      q('quote_coral', coral, 'Taylor Brooks', 'taylor@coralgablesarch.com',
        { fee: '$3,200 - post-construction final clean', frequency: 'One-time', restrooms: '4', area: '12,000 sq ft' },
        'draft', { _created: 2, _updated: 1 }),
    ],
  };
}

// ── Quality: templates, inspections, problems, checklists ──────────────────────
const JANITORIAL_SCHEMA = {
  areas: [
    { id: 'a_entry', label: 'Entrance & Lobby', items: [
      { id: 'i_entry_floor', label: 'Floors swept & mopped' },
      { id: 'i_entry_glass', label: 'Glass & entry doors clean' },
      { id: 'i_entry_trash', label: 'Trash emptied' },
    ] },
    { id: 'a_rest', label: 'Restrooms', items: [
      { id: 'i_rest_fix', label: 'Fixtures sanitized' },
      { id: 'i_rest_floor', label: 'Floors mopped' },
      { id: 'i_rest_supply', label: 'Supplies restocked' },
      { id: 'i_rest_mirror', label: 'Mirrors streak-free' },
    ] },
    { id: 'a_office', label: 'Offices & Common Areas', items: [
      { id: 'i_off_surf', label: 'Surfaces dusted' },
      { id: 'i_off_vac', label: 'Carpets vacuumed' },
      { id: 'i_off_trash', label: 'Trash & recycling emptied' },
    ] },
    { id: 'a_break', label: 'Break Room', items: [
      { id: 'i_brk_counter', label: 'Counters wiped down' },
      { id: 'i_brk_sink', label: 'Sink cleaned' },
      { id: 'i_brk_floor', label: 'Floor mopped' },
    ] },
  ],
};
const RESTROOM_SCHEMA = {
  areas: [
    { id: 'a_fix', label: 'Fixtures', items: [
      { id: 'i_fix_toilet', label: 'Toilets descaled & sanitized' },
      { id: 'i_fix_urinal', label: 'Urinals sanitized' },
      { id: 'i_fix_sink', label: 'Sinks & faucets polished' },
    ] },
    { id: 'a_surf', label: 'Surfaces', items: [
      { id: 'i_surf_tile', label: 'Tile & grout scrubbed' },
      { id: 'i_surf_mirror', label: 'Mirrors polished' },
      { id: 'i_surf_partition', label: 'Partitions wiped' },
    ] },
    { id: 'a_supply', label: 'Supplies', items: [
      { id: 'i_sup_soap', label: 'Soap dispensers filled' },
      { id: 'i_sup_paper', label: 'Paper products stocked' },
    ] },
  ],
};
const CLOSEOUT_SCHEMA = {
  areas: [
    { id: 'a_close', label: 'Close-Out', items: [
      { id: 'c_lights', label: 'Lights off' },
      { id: 'c_lock', label: 'All doors locked' },
      { id: 'c_alarm', label: 'Alarm set' },
      { id: 'c_cart', label: 'Cart cleaned & restocked' },
      { id: 'c_trash', label: 'Trash taken to dumpster' },
    ] },
  ],
};
// A second published CHECKLIST (kind='checklist') so per-cleaner assignment has a real
// choice — one cleaner on a site can be assigned this instead of the account default.
const FLOORCARE_SCHEMA = {
  areas: [
    { id: 'a_floors', label: 'Floor Care', items: [
      { id: 'f_sweep', label: 'Hard floors swept & dust-mopped' },
      { id: 'f_mop', label: 'Hard floors mopped' },
      { id: 'f_vac', label: 'Carpets & entry mats vacuumed' },
      { id: 'f_spot', label: 'Spots & spills spot-treated' },
      { id: 'f_edges', label: 'Edges, corners & baseboards detailed' },
    ] },
  ],
};

// A LONG, multi-section checklist (10 areas, ~46 items) so an expanded checklist can be
// eyeballed for scroll + formatting (long labels, many sections) in the fill modal.
const FULLCLEAN_SCHEMA = {
  areas: [
    { id: 'fa_entry', label: 'Entrance & Lobby', items: [
      { id: 'fi_entry_glass', label: 'Entry glass, doors & frames cleaned inside and out' },
      { id: 'fi_entry_mats', label: 'Walk-off mats vacuumed and straightened' },
      { id: 'fi_entry_floor', label: 'Lobby floor swept, mopped & buffed' },
      { id: 'fi_entry_seating', label: 'Seating, side tables & reception counter wiped' },
      { id: 'fi_entry_trash', label: 'Trash & recycling emptied, liners replaced' },
    ] },
    { id: 'fa_rest', label: 'Restrooms', items: [
      { id: 'fi_rest_toilet', label: 'Toilets & urinals descaled and sanitized inside and out' },
      { id: 'fi_rest_sink', label: 'Sinks, faucets & countertops disinfected' },
      { id: 'fi_rest_mirror', label: 'Mirrors & stainless polished streak-free' },
      { id: 'fi_rest_floor', label: 'Floors swept and mopped with disinfectant' },
      { id: 'fi_rest_partition', label: 'Stall partitions & doors wiped down' },
      { id: 'fi_rest_supply', label: 'Soap, paper towels & toilet paper restocked' },
    ] },
    { id: 'fa_office', label: 'Offices & Workstations', items: [
      { id: 'fi_off_surf', label: 'Desks & horizontal surfaces dusted around belongings' },
      { id: 'fi_off_touch', label: 'High-touch points sanitized — handles, switches, phones' },
      { id: 'fi_off_trash', label: 'Under-desk trash & recycling emptied' },
      { id: 'fi_off_vac', label: 'Carpets vacuumed, hard floors dust-mopped' },
      { id: 'fi_off_glass', label: 'Interior glass partitions spot-cleaned' },
    ] },
    { id: 'fa_break', label: 'Break Room & Kitchen', items: [
      { id: 'fi_brk_counter', label: 'Counters, backsplash & tables wiped and sanitized' },
      { id: 'fi_brk_sink', label: 'Sink scrubbed and faucet polished' },
      { id: 'fi_brk_appl', label: 'Microwave, fridge exterior & appliance fronts cleaned' },
      { id: 'fi_brk_cabinet', label: 'Cabinet fronts & handles wiped' },
      { id: 'fi_brk_floor', label: 'Floor swept and mopped' },
      { id: 'fi_brk_trash', label: 'Trash, recycling & compost emptied, liners replaced' },
    ] },
    { id: 'fa_conf', label: 'Conference Rooms', items: [
      { id: 'fi_conf_table', label: 'Conference tables wiped and chairs pushed in' },
      { id: 'fi_conf_glass', label: 'Glass walls & doors cleaned' },
      { id: 'fi_conf_av', label: 'AV surfaces & remotes dusted (nothing unplugged)' },
      { id: 'fi_conf_floor', label: 'Floors vacuumed or mopped' },
    ] },
    { id: 'fa_hall', label: 'Hallways & Stairwells', items: [
      { id: 'fi_hall_floor', label: 'Floors swept, mopped & edges detailed' },
      { id: 'fi_hall_rail', label: 'Handrails & door hardware sanitized' },
      { id: 'fi_hall_sign', label: 'Directory glass & wall signage wiped' },
      { id: 'fi_hall_scuff', label: 'Scuffs & marks spot-cleaned from walls' },
    ] },
    { id: 'fa_floor', label: 'Floor Care', items: [
      { id: 'fi_floor_sweep', label: 'All hard floors swept & dust-mopped' },
      { id: 'fi_floor_mop', label: 'Hard floors mopped with correct dilution' },
      { id: 'fi_floor_carpet', label: 'All carpets & entry mats vacuumed' },
      { id: 'fi_floor_spot', label: 'Spots & spills spot-treated' },
      { id: 'fi_floor_edge', label: 'Edges, corners & baseboards detailed' },
    ] },
    { id: 'fa_glass', label: 'Windows & Glass', items: [
      { id: 'fi_glass_interior', label: 'Interior windows & sills cleaned' },
      { id: 'fi_glass_partition', label: 'Glass partitions & doors polished' },
      { id: 'fi_glass_smudge', label: 'Fingerprints & smudges removed from glass surfaces' },
    ] },
    { id: 'fa_supply', label: 'Supplies & Restock', items: [
      { id: 'fi_sup_paper', label: 'Paper products restocked at all dispensers' },
      { id: 'fi_sup_soap', label: 'Hand soap & sanitizer refilled' },
      { id: 'fi_sup_liner', label: 'Spare liners staged at each station' },
      { id: 'fi_sup_report', label: 'Low-stock items noted for the supply request' },
    ] },
    { id: 'fa_final', label: 'Final Walkthrough', items: [
      { id: 'fi_fin_lights', label: 'Lights off in unoccupied areas' },
      { id: 'fi_fin_lock', label: 'All entry doors & windows secured' },
      { id: 'fi_fin_alarm', label: 'Alarm armed per site instructions' },
      { id: 'fi_fin_cart', label: 'Cart cleaned, restocked & stored' },
      { id: 'fi_fin_trash', label: 'All trash taken to the dumpster' },
    ] },
  ],
};

const JAN_TEMPLATE_ID = 'it_janitorial';
const JAN_VERSION_ID = 'iv_janitorial_1';
const REST_TEMPLATE_ID = 'it_restroom';
const REST_VERSION_ID = 'iv_restroom_1';
const CLOSE_TEMPLATE_ID = 'it_closeout';
const CLOSE_VERSION_ID = 'iv_closeout_1';
const FLOOR_TEMPLATE_ID = 'it_floorcare';
const FLOOR_VERSION_ID = 'iv_floorcare_1';
const FULL_TEMPLATE_ID = 'it_fullclean';
const FULL_VERSION_ID = 'iv_fullclean_1';

function tmpl(id, verId, name, kind, schema, passThreshold, daysAgo) {
  return {
    id, name, kind,
    rating_scale: { type: 'passfail', passThreshold },
    slug: `s_${id}`, is_published: true, published_version_id: verId,
    created_at: iso(daysAgo), updated_at: iso(daysAgo),
    versions: [{ id: verId, version_number: 1, schema, status: 'published', published_at: iso(daysAgo) }],
  };
}

function buildQcTemplates() {
  return {
    templates: [
      tmpl(JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, 80, 45),
      tmpl(REST_TEMPLATE_ID, REST_VERSION_ID, 'Restroom Deep-Clean QC', 'inspection', RESTROOM_SCHEMA, 85, 40),
      tmpl(CLOSE_TEMPLATE_ID, CLOSE_VERSION_ID, 'Nightly Close-Out Checklist', 'checklist', CLOSEOUT_SCHEMA, 100, 38),
      tmpl(FLOOR_TEMPLATE_ID, FLOOR_VERSION_ID, 'Floor Care Checklist', 'checklist', FLOORCARE_SCHEMA, 100, 30),
      tmpl(FULL_TEMPLATE_ID, FULL_VERSION_ID, 'Full Facility Deep-Clean Checklist', 'checklist', FULLCLEAN_SCHEMA, 100, 25),
    ],
  };
}

// Flatten a template schema into inspection items, marking `failKeys` as fail.
function inspectionItems(schema, failKeys = [], commentByKey = {}) {
  const items = [];
  for (const area of schema.areas) {
    for (const it of area.items) {
      items.push({
        item_key: it.id,
        label: `${area.label}. ${it.label}`,
        rating: failKeys.includes(it.id) ? 'fail' : 'pass',
        comment: commentByKey[it.id] || null,
      });
    }
  }
  return items;
}

function inspection(id, templateId, versionId, name, kind, schema, scale, client, site, inspectorName, failKeys, commentByKey, daysAgo) {
  const rawItems = inspectionItems(schema, failKeys, commentByKey).map((it) => ({ ...it, photo_count: 0 }));
  const { overallScore, result } = scoreInspection(rawItems, scale);
  return {
    id, public_token: `tok_${id}`, template_id: templateId, template_version_id: versionId,
    template_snapshot: { name, kind, rating_scale: scale, schema },
    client_id: client?.id ?? null, site_id: site?.id ?? null, job_id: null,
    client_name: client?.name ?? null, site_name: site?.name ?? null, inspector_name: inspectorName,
    overall_score: overallScore, result, status: 'submitted', performed_at: iso(daysAgo, 22), _items: rawItems,
  };
}

function buildQcInspections() {
  const janScale = { type: 'passfail', passThreshold: 80 };
  const restScale = { type: 'passfail', passThreshold: 85 };
  const lasOlas = clientBy('Las Olas');
  const lakeside = clientBy('Lakeside');
  const palmetto = clientBy('Palmetto');
  const gulfstream = clientBy('Gulfstream');
  const coralBay = clientBy('Coral Bay');
  const bayshore = clientBy('Bayshore');
  const yolanda = userBy('Yolanda')?.name || 'Yolanda Reyes';
  const priya = userBy('Priya')?.name || 'Priya Nair';
  const owner = INITIAL_STATE.company?.owner || IDENTITY.company.signatory.name;

  return {
    inspections: [
      inspection('ir_lasolas', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        lasOlas, firstSiteOf(lasOlas), yolanda, [], {}, 2),
      inspection('ir_coralbay', REST_TEMPLATE_ID, REST_VERSION_ID, 'Restroom Deep-Clean QC', 'inspection', RESTROOM_SCHEMA, restScale,
        coralBay, firstSiteOf(coralBay), priya, [], {}, 3),
      inspection('ir_lakeside', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        lakeside, firstSiteOf(lakeside), priya, ['i_off_vac'], { i_off_vac: 'Two offices skipped, crew notified.' }, 4),
      inspection('ir_palmetto', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        palmetto, firstSiteOf(palmetto), yolanda, ['i_rest_supply'], { i_rest_supply: 'Soap dispensers empty, restocked on site.' }, 5),
      inspection('ir_gulfstream', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        gulfstream, firstSiteOf(gulfstream), owner, ['i_entry_floor', 'i_off_vac', 'i_brk_floor'],
        { i_entry_floor: 'Loading dock floor still greasy.', i_brk_floor: 'Break room floor sticky.' }, 6),
      inspection('ir_bayshore', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        bayshore, firstSiteOf(bayshore), yolanda, ['i_brk_counter'], {}, 20),
      // A second pass at a few accounts so "Inspections per site" shows real counts
      // (not one-per-site) and the date-range filter has something to bite on.
      inspection('ir_lasolas_2', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        lasOlas, firstSiteOf(lasOlas), priya, ['i_rest_mirror'], {}, 15),
      inspection('ir_lakeside_2', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        lakeside, firstSiteOf(lakeside), yolanda, [], {}, 12),
      inspection('ir_palmetto_2', REST_TEMPLATE_ID, REST_VERSION_ID, 'Restroom Deep-Clean QC', 'inspection', RESTROOM_SCHEMA, restScale,
        palmetto, firstSiteOf(palmetto), priya, ['i_sup_paper'], { i_sup_paper: 'Paper towels out in the west restroom.' }, 10),
      inspection('ir_coralbay_2', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        coralBay, firstSiteOf(coralBay), yolanda, [], {}, 8),
    ],
  };
}

// Work Orders (the evolved problem_reports): client- and staff-raised tickets with
// type / priority / origin / assignee / SLA / escalation, spread across a few
// managers' queues (client.supervisorId) so the queue view has something to scope.
// createdHrs (not days) keeps the SLA clock live — some breached, some due-soon.
function buildQcProblems() {
  const lasOlas = clientBy('Las Olas');
  const coralBay = clientBy('Coral Bay');
  const palmetto = clientBy('Palmetto');
  const bayshore = clientBy('Bayshore');
  const uid = (frag) => userBy(frag)?.id || null;
  const isoHrs = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const wo = (id, client, o) => {
    const site = firstSiteOf(client);
    const createdHrs = o.createdHrs != null ? o.createdHrs : 24;
    const created_at = isoHrs(createdHrs);
    const priority = o.priority || 'medium';
    const messages = (o.messages || []).map((m, i) => ({
      id: `${id}_m${i}`, problem_id: id, author_user_id: null,
      author_role: m.role, author_name: m.who, body: m.body,
      translated_body: m.trans || null, from_lang: m.from || null,
      created_at: isoHrs(m.hrs != null ? m.hrs : Math.max(0, createdHrs - i)),
    }));
    return {
      id, client_id: client?.id ?? null, site_id: site?.id ?? null, job_id: null,
      client_name: client?.name ?? null, site_name: site?.name ?? null,
      reported_by_user_id: null, assignee_user_id: o.assignee || null,
      title: o.title, description: o.description || null,
      type: o.type || 'issue', origin: o.origin || 'internal', priority,
      status: o.status || 'open', photo_paths: [],
      due_at: computeDueAt(created_at, priority),
      escalated_at: o.escalated ? isoHrs(Math.max(0, createdHrs - 1)) : null,
      created_at,
      resolved_at: o.status === 'resolved' ? isoHrs(o.resolvedHrs != null ? o.resolvedHrs : 2) : null,
      messages,
    };
  };
  return {
    problems: [
      wo('pr_lasolas_exam', lasOlas, { title: 'Exam room 3 not serviced overnight', description: 'Trash and the biohazard bin left full before the morning clinic. Client flagged it from the portal.', type: 'complaint', priority: 'urgent', origin: 'portal', status: 'in_progress', assignee: uid('Yolanda'), escalated: true, createdHrs: 3, messages: [
        { role: 'client', who: 'Pat Ramirez', body: "Exam room 3 wasn't serviced overnight — trash and the biohazard bin were full before the morning clinic.", hrs: 3 },
        { role: 'office', who: 'Renata Cruz', body: 'Thanks Pat — escalating now and sending Yolanda over this morning. Apologies for the miss.', hrs: 2 },
        { role: 'crew', who: 'Yolanda Reyes', body: 'Voy en camino, llego en 15 minutos.', trans: "On my way, I'll be there in 15 minutes.", from: 'Spanish', hrs: 0.5 },
      ] }),
      wo('pr_palmetto_soap', palmetto, { title: 'Restroom soap dispensers found empty', description: 'Two dispensers in the east wing were empty at open. Restocked; crew to verify nightly.', type: 'complaint', priority: 'high', origin: 'portal', status: 'in_progress', assignee: uid('Priya'), escalated: false, createdHrs: 7, messages: [
        { role: 'client', who: 'Kim Nelson', body: 'Two soap dispensers in the east-wing restroom were empty at open this morning.', hrs: 7 },
        { role: 'office', who: 'Priya Nair', body: 'Restocked, and I added a nightly dispenser check to the crew checklist. Thanks for the heads up.', hrs: 6 },
      ] }),
      wo('pr_lasolas_lobby', lasOlas, { title: 'Streaks on the lobby floor by the elevators', description: 'Third time this week per the client. Sending the crew back to re-buff today.', type: 'complaint', priority: 'high', origin: 'portal', status: 'in_progress', assignee: uid('Yolanda'), escalated: false, createdHrs: 9 }),
      wo('pr_bayshore_scrub', bayshore, { title: 'West corridor needs a deep scrub', description: 'Scuffing and buildup along the resident wing — flagged internally on the last walk.', type: 'issue', priority: 'medium', origin: 'internal', status: 'open', assignee: null, escalated: false, createdHrs: 5 }),
      // A staff-logged complaint (origin:internal) — the old standalone Complaints log
      // folded into Work Orders here, so a phone-in gripe is captured the same way.
      wo('pr_bayshore_recycling', bayshore, { title: 'Recycling bins missed on the Tuesday route', description: 'Front desk phoned in a repeat gripe — recycling not pulled on Tuesdays. Logged internally from the call.', type: 'complaint', priority: 'medium', origin: 'internal', status: 'open', assignee: uid('Renata'), escalated: false, createdHrs: 14 }),
      wo('pr_coralbay_windows', coralBay, { title: 'Add interior window cleaning to the next visit', description: 'Client asked to add interior windows to the recurring scope.', type: 'request', priority: 'low', origin: 'portal', status: 'open', assignee: null, escalated: false, createdHrs: 26, messages: [
        { role: 'client', who: 'Sasha Lin', body: 'Could you add interior window cleaning to our recurring scope? The lobby glass especially.', hrs: 26 },
      ] }),
      wo('pr_palmetto_signoff', palmetto, { title: 'Awaiting client sign-off on carpet re-clean', description: 'Re-clean is done; waiting on the facilities lead to confirm before we close it out.', type: 'request', priority: 'medium', origin: 'portal', status: 'awaiting_client', assignee: uid('Priya'), escalated: false, createdHrs: 30 }),
      wo('pr_coralbay_carpet', coralBay, { title: 'Coffee stain on the clubhouse carpet', description: 'Treated and hot-water extracted — came out clean.', type: 'complaint', priority: 'high', origin: 'portal', status: 'resolved', assignee: uid('Priya'), escalated: false, createdHrs: 28, resolvedHrs: 21, messages: [
        { role: 'client', who: 'Sasha Lin', body: "Big coffee stain on the clubhouse carpet before Thursday's board meeting — can it be treated?", hrs: 28 },
        { role: 'crew', who: 'Priya Nair', body: 'Treated and hot-water extracted — came out clean. Before/after photos attached.', hrs: 22 },
        { role: 'client', who: 'Sasha Lin', body: 'Perfect, thank you!', hrs: 21 },
      ] }),
    ],
  };
}

// A seeded checklist row, shaped EXACTLY like a backend `checklist_results` row: the
// completer is a user ID, never a name (CS-403 — the table has no name column, and the
// stub storing one is what hid the defect from demo mode). `completedBy` is a roster
// name fragment, resolved to that person's id here.
function checklist(id, client, completedBy, checkedCount, daysAgo) {
  const site = firstSiteOf(client);
  const items = CLOSEOUT_SCHEMA.areas[0].items.map((it, i) => ({ item_key: it.id, label: it.label, checked: i < checkedCount }));
  return {
    id, template_id: CLOSE_TEMPLATE_ID, template_version_id: CLOSE_VERSION_ID,
    template_snapshot: { name: 'Nightly Close-Out Checklist', kind: 'checklist', schema: CLOSEOUT_SCHEMA },
    client_id: client?.id ?? null, site_id: site?.id ?? null, job_id: null,
    completed_by_user_id: userBy(completedBy)?.id ?? null,
    items, completed_count: items.filter((i) => i.checked).length,
    total_count: items.length, performed_at: iso(daysAgo, 23),
  };
}

function buildQcChecklists() {
  const lasOlas = clientBy('Las Olas');
  const palmetto = clientBy('Palmetto');
  const lakeside = clientBy('Lakeside');
  const gulfstream = clientBy('Gulfstream');
  const coralBay = clientBy('Coral Bay');
  const bayshore = clientBy('Bayshore');
  // Nightly close-outs across the book so "Checklists per site" shows real volume,
  // completion variety, and a working date-range filter (checkedCount of 5 = full).
  return {
    checklists: [
      checklist('cr_lasolas_1', lasOlas, 'Luis Ferrer', 5, 1),
      checklist('cr_lasolas_2', lasOlas, 'Luis Ferrer', 5, 4),
      checklist('cr_palmetto_1', palmetto, 'Keisha Bryant', 4, 2),
      checklist('cr_palmetto_2', palmetto, 'Keisha Bryant', 5, 6),
      checklist('cr_lakeside_1', lakeside, 'Priya Nair', 5, 2),
      checklist('cr_lakeside_2', lakeside, 'Priya Nair', 3, 9),
      checklist('cr_gulfstream_1', gulfstream, 'Tomas Rivera', 5, 3),
      checklist('cr_coralbay_1', coralBay, 'Yolanda Reyes', 4, 5),
      checklist('cr_coralbay_2', coralBay, 'Yolanda Reyes', 5, 12),
      checklist('cr_bayshore_1', bayshore, 'Andre Baptiste', 5, 3),
    ],
  };
}

// One payload per stub key — demoBootstrap writes each on reseed.
export function buildDemoStubs() {
  return {
    [QUOTES_STUB_KEY]: buildQuotes(),
    [QC_TEMPLATES_STUB_KEY]: buildQcTemplates(),
    [QC_INSPECTIONS_STUB_KEY]: buildQcInspections(),
    [QC_PROBLEMS_STUB_KEY]: buildQcProblems(),
    [QC_CHECKLISTS_STUB_KEY]: buildQcChecklists(),
  };
}
