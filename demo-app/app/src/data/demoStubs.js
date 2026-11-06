// Demo seed for the localStorage-STUB features — Quotes and Quality
// (inspections / templates / problems / checklists). These run off their own
// storage keys, NOT the main INITIAL_STATE store, so demoBootstrap writes them on
// reseed to keep those surfaces populated. IDs are stable (idempotent reseed) and
// entity FKs resolve against INITIAL_STATE by name so they stay linked to the same
// clients / sites / people the rest of the demo shows.
import { INITIAL_STATE } from './seed';
import { scoreInspection, countSchemaItems } from '../lib/inspections';
import { draftItemsFromAnswers } from '../lib/inspectionDrafts';
import { countChecklistSubmission } from '../lib/checklistCount';
import { areaCompletionTimes } from '../lib/checklistAreas';
import { computeDueAt } from '../lib/workOrders';
import { IDENTITY } from '../brand/identity.generated.js';
import {
  CONTRACT_STATUS, TERM_TYPE, REMINDER_STATUS,
  contractReminderPlan, defaultYearRows,
} from '../lib/contracts';
import { todayKey, addDaysKey } from '../lib/dates';
import {
  MD_TEMPLATE_OFFICE, MD_TEMPLATE_MEDICAL, MANAGER_DAY_PREFIX, MANAGER_DAY_REQUESTS, MANAGER_DAY_SUPPLIES,
  MANAGER_DAY_MESSAGES, managerDayText, managerDayDeliveredMs, managerDaySupplyTimes, managerDaySupplyFulfillment,
} from './demoManagerDay';
import { WARNING_LEVEL, WARNING_REASON, WARNING_STATUS } from '../lib/hrWarnings';
import { INCIDENT_TYPE, INCIDENT_STATUS, ANSWER, TREATMENT, NOTIFIED, PERSON_KIND, involvedUserIds } from '../lib/hrIncidents';
import { TERMINATION_REASON, TERMINATION_STATUS, ACCESS_STATE } from '../lib/hrTerminations';
import { seedId } from '../lib/ids';
import { DEMO_SUPPLY_CATALOG, demoSupplyCatalogId, demoSupplyCatalogItem } from './demoSupplyCatalog';
import { withDemoTranslations, demoNameTranslations } from './demoTranslations';
import { QC_CHECKLISTS_STUB_KEY, QC_TEMPLATES_STUB_KEY, QC_INSPECTIONS_STUB_KEY, QC_PROBLEMS_STUB_KEY, QBO_STUB_KEY, CONTRACTS_STUB_KEY, SCAN_CODES_STUB_KEY, SCAN_RATINGS_STUB_KEY, AVATAR_STUB_KEY, HR_WARNINGS_STUB_KEY, HR_INCIDENTS_STUB_KEY, HR_TERMINATIONS_STUB_KEY, SUPPLIES_STUB_KEY, CUSTOMER_DOCUMENTS_STUB_KEY } from './stubKeys';
import { CLIENT_MESSAGES_STUB_KEY } from './stubKeys';

// Storage keys (must match the adapters: quotesApi / qcApi / qboApi).
export const QUOTES_STUB_KEY = 'cleanspace_quotes_stub_v2';
// The checklist, template, inspection and work-order stub keys are shared with lib/qcApi
// (their reader/writer) and carry their row shape's version — see data/stubKeys.js.
export { QC_CHECKLISTS_STUB_KEY, QC_TEMPLATES_STUB_KEY, QC_INSPECTIONS_STUB_KEY, QC_PROBLEMS_STUB_KEY } from './stubKeys';

// The QuickBooks Online demo stub key (declared in data/stubKeys.js) is in this list so
// ?demo=reset WIPES it — but it has NO buildDemoStubs() payload, so a reset removes it and
// leaves it absent, which qboApi reads as DISCONNECTED. That is the intended fresh state:
// the demo opens on "not connected" and the client connects a sandbox company by hand.
// The QR codes' key (QR-6) works the same way: wiped by a reset and NOT seeded here, because
// its seed (data/demoScanCodes.js) is read only by lib/scanCodesApi's demo branch, which a
// production build drops; absent, that branch starts from it again.
// The team photos' key (UI_RULES §141) is wiped and not seeded too: the seeded roster has no
// photos, so a reset puts everyone back on their initials.
export const DEMO_STUB_KEYS = [
  QUOTES_STUB_KEY, QC_TEMPLATES_STUB_KEY,
  QC_INSPECTIONS_STUB_KEY, QC_PROBLEMS_STUB_KEY, QC_CHECKLISTS_STUB_KEY,
  QBO_STUB_KEY, CONTRACTS_STUB_KEY, SCAN_CODES_STUB_KEY, SCAN_RATINGS_STUB_KEY, AVATAR_STUB_KEY, HR_WARNINGS_STUB_KEY,
  HR_INCIDENTS_STUB_KEY,
  HR_TERMINATIONS_STUB_KEY,
  SUPPLIES_STUB_KEY,
  CLIENT_MESSAGES_STUB_KEY,
  CUSTOMER_DOCUMENTS_STUB_KEY,
];

// THE CLIENT HUB's demo customer contact (Phase 2 Wave 2 Round 2): Coral Bay HOA's property
// manager, already the customer voice of the seeded Coral Bay tickets below. The hub preview
// (lib/hubDemo.js — reachable only in a demo build) signs in as this person, and the rows here
// name them BY ID exactly as the server stamps `raised_by_client_user_id` / `author_client_user_id`
// from a real login's claim. A second contact raises a Bayshore ticket, so the hub shows a
// ticket "raised by" somebody else too.
export const DEMO_CLIENT_USER = Object.freeze({ id: 'dec0de00-0000-4000-8000-000000000001', name: 'Sasha Lin', email: 'sasha@coralbayhoa.org', phone: '(754) 555-0204' });
const DEMO_OTHER_CLIENT_USER = Object.freeze({ id: 'dec0de00-0000-4000-8000-000000000002', name: 'Lee Thompson' });

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
// `naAllowed` is spelled out on every item here, as InspectionTemplateEditor writes it, so
// the demo shows a real published checklist: ONE item the office flagged "N/A ok" (spot
// treatment — there may be nothing to treat tonight) and four that must be done. That one
// flag is what makes the fill's N/A control reachable in the demo at all (CS-546); every
// other demo checklist has none, which is also what production looks like today.
//
// It is also the demo's QR-1 and CS-547 example: its one section is LINKED to Coral Bay
// HOA's "Hall & stair floors" cleaning area (`siteAreaId`, so finishing it records that
// area's last-cleaned time), and `f_mop` carries the office's `photoRequired` flag — the
// one item in the demo a cleaner cannot tick without taking a photo. Every other demo
// checklist has neither, which is also what production looks like today.
const FLOORCARE_SCHEMA = {
  areas: [
    { id: 'a_floors', label: 'Floor Care', siteAreaId: 'area_floors', items: [
      { id: 'f_sweep', label: 'Hard floors swept & dust-mopped', naAllowed: false },
      { id: 'f_mop', label: 'Hard floors mopped', photoRequired: true, naAllowed: false },
      { id: 'f_vac', label: 'Carpets & entry mats vacuumed', naAllowed: false },
      { id: 'f_spot', label: 'Spots & spills spot-treated', naAllowed: true },
      { id: 'f_edges', label: 'Edges, corners & baseboards detailed', naAllowed: false },
    ] },
  ],
};

// A LONG, multi-section checklist (10 areas, ~46 items) so an expanded checklist can be
// eyeballed for scroll + formatting (long labels, many sections) in the fill modal.
const FULLCLEAN_SCHEMA = {
  areas: [
    // QR-1: two of these sections are LINKED to Coral Bay HOA's own cleaning areas, so
    // finishing them records when those areas were last cleaned. The other eight are
    // unlinked, which is the ordinary state — a section only needs a link where a QR code
    // is actually going on the wall.
    { id: 'fa_entry', label: 'Entrance & Lobby', siteAreaId: 'area_lobby', items: [
      { id: 'fi_entry_glass', label: 'Entry glass, doors & frames cleaned inside and out' },
      { id: 'fi_entry_mats', label: 'Walk-off mats vacuumed and straightened' },
      { id: 'fi_entry_floor', label: 'Lobby floor swept, mopped & buffed' },
      { id: 'fi_entry_seating', label: 'Seating, side tables & reception counter wiped' },
      { id: 'fi_entry_trash', label: 'Trash & recycling emptied, liners replaced' },
    ] },
    { id: 'fa_rest', label: 'Restrooms', siteAreaId: 'area_rest', items: [
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

// `clientId` is the customer a CHECKLIST is filed under (R2, plan step 5) — exactly the
// backend's `inspection_templates.client_id`. NULL is a STARTER: offered under "Start
// from…" and never assigned directly. INSPECTION templates stay company-wide and always
// pass null.
function tmpl(id, verId, name, kind, baseSchema, passThreshold, daysAgo, clientId = null) {
  // The NAME's Spanish and Creole lines, as the server keeps them (CS-850): on the version, and the
  // published version's copy on the row (data/demoTranslations).
  const nameI18n = demoNameTranslations(name);
  const schema = nameI18n ? { ...baseSchema, nameI18n } : baseSchema;
  return {
    id, name, kind, name_i18n: nameI18n,
    client_id: kind === 'checklist' ? (clientId || null) : null,
    rating_scale: { type: 'passfail', passThreshold },
    slug: `s_${id}`, is_published: true, published_version_id: verId,
    // The denormalized count of the PUBLISHED version's items, exactly as the backend row
    // carries it — the summary reads this column and no schema.
    item_count: countSchemaItems(schema),
    created_at: iso(daysAgo), updated_at: iso(daysAgo),
    versions: [{ id: verId, version_number: 1, schema, status: 'published', published_at: iso(daysAgo) }],
  };
}

function buildQcTemplates() {
  // Coral Bay HOA is the per-cleaner-checklist account: Andre holds Floor Care and Tomas
  // the long Full Facility list, so both are FILED under it. The Close-Out list is held by
  // nobody, which is what makes it the demo's starter.
  const coralBay = clientBy('Coral Bay');
  return {
    templates: [
      tmpl(JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, 80, 45),
      tmpl(REST_TEMPLATE_ID, REST_VERSION_ID, 'Restroom Deep-Clean QC', 'inspection', RESTROOM_SCHEMA, 85, 40),
      // The checklists carry the Spanish and Creole lines the server writes on save (CS-850; the
      // demo has no server, data/demoTranslations).
      tmpl(CLOSE_TEMPLATE_ID, CLOSE_VERSION_ID, 'Nightly Close-Out Checklist', 'checklist', withDemoTranslations(CLOSEOUT_SCHEMA), 100, 38, null),
      tmpl(FLOOR_TEMPLATE_ID, FLOOR_VERSION_ID, 'Floor Care Checklist', 'checklist', withDemoTranslations(FLOORCARE_SCHEMA), 100, 30, coralBay?.id),
      tmpl(FULL_TEMPLATE_ID, FULL_VERSION_ID, 'Full Facility Deep-Clean Checklist', 'checklist', withDemoTranslations(FULLCLEAN_SCHEMA), 100, 25, coralBay?.id),
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
      // The client hub's Inspections tile draws the last four scores (the redesign, 2026-10-08):
      // a fourth Coral Bay visit, two weeks back, one item short.
      inspection('ir_coralbay_3', JAN_TEMPLATE_ID, JAN_VERSION_ID, 'Nightly Janitorial QC', 'inspection', JANITORIAL_SCHEMA, janScale,
        coralBay, firstSiteOf(coralBay), priya, ['i_brk_counter'], {}, 15),
      // The client hub's FAILED inspection (HUB-6/7): failing items in two areas, so the
      // cleaners on site were sent back to redo "Fixtures and Supplies" — what the hub shows the
      // customer as "what we're doing about it". The office-only note (HUB-16) rides on the
      // record and is never shown to the customer.
      {
        ...inspection('ir_coralbay_fail', REST_TEMPLATE_ID, REST_VERSION_ID, 'Restroom Deep-Clean QC', 'inspection', RESTROOM_SCHEMA, restScale,
          coralBay, firstSiteOf(coralBay), priya, ['i_fix_toilet', 'i_fix_sink', 'i_sup_soap'],
          { i_fix_toilet: 'Scale under the rims in both stalls.', i_sup_soap: 'Two dispensers empty in the pool restroom.' }, 1),
        internal_note: 'The regular crew lead was out; the floater skipped the pool-house restroom. Coaching on the checklist tonight.',
      },
      // An inspection LEFT OPEN to finish later (Matt, 2026-10-06; lib/inspectionDrafts): started
      // 40 minutes before the seed at Coral Bay by the demo's signed-in user, a little over half
      // of it ticked, a comment and a note saved, so the Inspections list shows it In progress
      // with Continue / Discard, and a new inspection at Coral Bay offers "Continue the one you
      // started". Never on the customer hub, never scored (D8).
      inspectionDraftRow('ir_coralbay_draft', coralBay, firstSiteOf(coralBay), INITIAL_STATE.users?.[0] || null),
    ],
  };
}

function inspectionDraftRow(id, client, site, inspector) {
  const schema = JANITORIAL_SCHEMA;
  const snapshot = { name: 'Nightly Janitorial QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, schema };
  const ticked = ['i_entry_floor', 'i_entry_glass', 'i_entry_trash', 'i_rest_fix', 'i_rest_floor', 'i_rest_supply', 'i_off_surf'];
  const answers = Object.fromEntries(ticked.map((k) => [k, { ticked: true }]));
  answers.i_rest_mirror = { comment: 'Streaks on the left mirror; recheck after the crew wipes it.' };
  const started = new Date(Date.now() - 40 * 60000).toISOString();
  return {
    id, public_token: `tok_${id}`, template_id: JAN_TEMPLATE_ID, template_version_id: JAN_VERSION_ID,
    template_snapshot: snapshot,
    client_id: client?.id ?? null, site_id: site?.id ?? null, job_id: null,
    client_name: client?.name ?? null, site_name: site?.name ?? null,
    inspector_user_id: inspector?.id ?? null, inspector_name: inspector?.name ?? null,
    overall_score: null, result: null, status: 'draft',
    performed_at: started, updated_at: new Date(Date.now() - 12 * 60000).toISOString(),
    internal_note: 'Lobby done; Offices and Break Room still to walk.',
    _items: draftItemsFromAnswers(snapshot, answers).map((it) => ({
      item_key: it.item_key, label: it.label, rating: it.rating != null ? String(it.rating) : null, comment: it.comment || null, photo_count: 0,
    })),
  };
}

// Work Orders (the evolved problem_reports): client- and staff-raised tickets with
// type / priority / origin / assignee / SLA / escalation, spread across a few
// managers' queues (client.supervisorId) so the queue view has something to scope.
// createdHrs (not days) keeps the SLA clock live — some breached, some due-soon.
// One work order (a problem_reports row, its thread inside it as the stub keeps it), dated in
// hours before `nowMs`.
function workOrderRow(id, client, o, nowMs = Date.now()) {
  const isoHrs = (h) => new Date(nowMs - h * 3600 * 1000).toISOString();
  const site = firstSiteOf(client);
  const createdHrs = o.createdHrs != null ? o.createdHrs : 24;
  const created_at = isoHrs(createdHrs);
  const priority = o.priority || 'medium';
  const messages = (o.messages || []).map((m, i) => ({
    id: `${id}_m${i}`, problem_id: id, author_user_id: null,
    author_role: m.role, author_name: m.who, body: m.body,
    translated_body: m.trans || null, from_lang: m.from || null,
    // WO-9: an office note the customer never sees; HUB-13: which customer contact wrote it.
    internal: m.internal === true,
    author_client_user_id: m.role === 'client' ? (m.cu?.id || null) : null,
    created_at: isoHrs(m.hrs != null ? m.hrs : Math.max(0, createdHrs - i)),
  }));
  return {
    id, client_id: client?.id ?? null, site_id: site?.id ?? null, job_id: null,
    client_name: client?.name ?? null, site_name: site?.name ?? null,
    reported_by_user_id: null, assignee_user_id: o.assignee || null,
    title: o.title, description: o.description || null,
    type: o.type || 'issue', origin: o.origin || 'internal', priority,
    category: o.category || null,
    // HUB-13: the customer contact who raised a hub ticket (null for the office's own).
    raised_by_client_user_id: o.raisedBy?.id || null, raised_by_client_name: o.raisedBy?.name || null,
    status: o.status || 'open', photo_paths: [],
    // The Cleaner Hub (brief C): the cleaners the office routed it to (WO-19's column), by user id.
    crew_user_ids: Array.isArray(o.crew) ? o.crew.filter(Boolean) : [],
    due_at: computeDueAt(created_at, priority),
    escalated_at: o.escalated ? isoHrs(Math.max(0, createdHrs - 1)) : null,
    created_at,
    resolved_at: o.status === 'resolved' ? isoHrs(o.resolvedHrs != null ? o.resolvedHrs : 2) : null,
    messages,
  };
}

// The seeded book, placed relative to `now` (the moment the browser is seeded, or re-placed).
function buildQcProblems(now = Date.now()) {
  const lasOlas = clientBy('Las Olas');
  const coralBay = clientBy('Coral Bay');
  const palmetto = clientBy('Palmetto');
  const bayshore = clientBy('Bayshore');
  const uid = (frag) => userBy(frag)?.id || null;
  const wo = (id, client, o) => workOrderRow(id, client, o, now);
  return {
    problems: [
      wo('pr_lasolas_exam', lasOlas, { title: 'Exam room 3 not serviced overnight', description: 'Trash and the biohazard bin left full before the morning clinic. Client flagged it from the portal.', type: 'complaint', priority: 'urgent', origin: 'portal', status: 'in_progress', assignee: uid('Yolanda'), escalated: true, createdHrs: 3, messages: [
        { role: 'client', who: 'Pat Ramirez', body: "Exam room 3 wasn't serviced overnight — trash and the biohazard bin were full before the morning clinic.", hrs: 3 },
        { role: 'office', who: 'Renata Cruz', body: 'Thanks Pat — escalating now and sending Yolanda over this morning. Apologies for the miss.', hrs: 2 },
        { role: 'crew', who: 'Yolanda Reyes', body: 'Voy en camino, llego en 15 minutos.', trans: "On my way, I'll be there in 15 minutes.", from: 'Spanish', hrs: 0.5 },
      ] }),
      wo('pr_palmetto_soap', palmetto, { title: 'Restroom soap dispensers found empty', description: 'Two dispensers in the east wing were empty at open. Restocked; crew to verify nightly.', type: 'complaint', priority: 'medium', origin: 'portal', status: 'in_progress', assignee: uid('Priya'), escalated: false, createdHrs: 7, messages: [
        { role: 'client', who: 'Kim Nelson', body: 'Two soap dispensers in the east-wing restroom were empty at open this morning.', hrs: 7 },
        { role: 'office', who: 'Priya Nair', body: 'Restocked, and I added a nightly dispenser check to the crew checklist. Thanks for the heads up.', hrs: 6 },
      ] }),
      // The Cleaner Hub (brief C): routed to Demo Crew, who cleans Las Olas — past its 2-hour
      // deadline, so their Client Requests shows it Overdue.
      wo('pr_lasolas_lobby', lasOlas, { title: 'Streaks on the lobby floor by the elevators', description: 'Third time this week per the client. Sending the crew back to re-buff today.', type: 'complaint', priority: 'medium', origin: 'portal', status: 'in_progress', assignee: uid('Yolanda'), escalated: false, createdHrs: 9, crew: [seedId('u', 'crewdemo')] }),
      wo('pr_bayshore_scrub', bayshore, { title: 'West corridor needs a deep scrub', description: 'Scuffing and buildup along the resident wing — flagged internally on the last walk.', type: 'issue', priority: 'medium', origin: 'internal', status: 'open', assignee: null, escalated: false, createdHrs: 5 }),
      // A staff-logged complaint (origin:internal) — the old standalone Complaints log
      // folded into Work Orders here, so a phone-in gripe is captured the same way.
      wo('pr_bayshore_recycling', bayshore, { title: 'Recycling bins missed on the Tuesday route', description: 'Front desk phoned in a repeat gripe — recycling not pulled on Tuesdays. Logged internally from the call.', type: 'complaint', priority: 'medium', origin: 'internal', status: 'open', assignee: uid('Renata'), escalated: false, createdHrs: 14 }),
      // The client hub's open thread (HUB-13): the customer asked, the office wrote itself an
      // INTERNAL note (WO-9, never shown in the hub), then asked the customer a question — so
      // the hub shows "We need more information from you".
      wo('pr_coralbay_windows', coralBay, { title: 'Add interior window cleaning to the next visit', description: 'Could you add interior window cleaning to our recurring scope? The lobby glass especially.', type: 'request', category: 'extra_service', priority: 'low', origin: 'portal', status: 'awaiting_client', assignee: uid('Renata'), escalated: false, createdHrs: 26, raisedBy: DEMO_CLIENT_USER, messages: [
        { role: 'client', who: 'Sasha Lin', cu: DEMO_CLIENT_USER, body: 'Could you add interior window cleaning to our recurring scope? The lobby glass especially.', hrs: 26 },
        { role: 'office', who: 'Renata Cruz', internal: true, body: 'Outside the HOA scope — quote it as an add-on before we promise a date.', hrs: 25 },
        { role: 'office', who: 'Renata Cruz', body: 'Happy to add it. Besides the lobby, do you want the fitness room and the clubhouse glass done too?', hrs: 24 },
      ] }),
      wo('pr_palmetto_signoff', palmetto, { title: 'Awaiting client sign-off on carpet re-clean', description: 'Re-clean is done; waiting on the facilities lead to confirm before we close it out.', type: 'request', priority: 'medium', origin: 'portal', status: 'awaiting_client', assignee: uid('Priya'), escalated: false, createdHrs: 30 }),
      // Completed yesterday, so the customer can still reopen it (WO-11: seven days).
      wo('pr_coralbay_carpet', coralBay, { title: 'Coffee stain on the clubhouse carpet', description: "Big coffee stain on the clubhouse carpet before Thursday's board meeting — can it be treated?", type: 'complaint', category: 'spill', priority: 'low', origin: 'portal', status: 'resolved', assignee: uid('Priya'), escalated: false, createdHrs: 28, resolvedHrs: 21, raisedBy: DEMO_CLIENT_USER, messages: [
        { role: 'client', who: 'Sasha Lin', cu: DEMO_CLIENT_USER, body: "Big coffee stain on the clubhouse carpet before Thursday's board meeting — can it be treated?", hrs: 28 },
        { role: 'crew', who: 'Priya Nair', body: 'Treated and hot-water extracted — came out clean. Before/after photos attached.', hrs: 22 },
        { role: 'client', who: 'Sasha Lin', cu: DEMO_CLIENT_USER, body: 'Perfect, thank you!', hrs: 21 },
      ] }),
      // Completed ten days ago: past the reopen window, so the hub offers "raise a new ticket".
      wo('pr_coralbay_pool', coralBay, { title: 'Pool deck chairs left stacked by the gate', description: 'The pool deck chairs were left stacked by the gate after the clean, so residents could not use them.', type: 'complaint', category: 'missed_area', priority: 'medium', origin: 'portal', status: 'resolved', assignee: uid('Renata'), escalated: false, createdHrs: 260, resolvedHrs: 240, raisedBy: DEMO_CLIENT_USER, messages: [
        { role: 'client', who: 'Sasha Lin', cu: DEMO_CLIENT_USER, body: 'The pool deck chairs were left stacked by the gate after the clean, so residents could not use them.', hrs: 260 },
        { role: 'office', who: 'Renata Cruz', body: 'Sorry about that. The crew put them back this morning and it is on the close-out list now.', hrs: 241 },
      ] }),
      // Time to resolve (Matt's KPI, the Oct 6 call): two more closed tickets so Reports → Time to
      // resolve has a request closed inside its 24-hour standard and an urgent issue inside two hours
      // beside Coral Bay's two late complaints. The Bayshore one is the office's OWN (origin
      // internal): the report counts it, and Bayshore's hub tile says "No requests closed" — the
      // customer's figure is their requests from the hub only (plan 2026-10-11 D11).
      // …and Demo Crew's request done this week (the list's "Done this week").
      wo('pr_lasolas_towels', lasOlas, { title: 'Extra paper towels for the health fair', description: 'The clinic is hosting a health fair on Saturday and needs two extra cases of paper towels in the lobby restrooms.', type: 'request', category: 'restock', priority: 'medium', origin: 'portal', status: 'resolved', assignee: uid('Yolanda'), escalated: false, createdHrs: 52, resolvedHrs: 48, crew: [seedId('u', 'crewdemo')], messages: [
        { role: 'client', who: 'Pat Ramirez', body: 'We are hosting a health fair on Saturday. Could we get two extra cases of paper towels in the lobby restrooms?', hrs: 52 },
        { role: 'office', who: 'Renata Cruz', body: 'Done. Yolanda dropped two cases in the lobby restroom closet this afternoon.', hrs: 48 },
      ] }),
      wo('pr_bayshore_mopsink', bayshore, { title: 'Mop sink draining slowly in the east closet', description: 'Logged on the walk: the mop sink in the east janitor closet backs up. Cleared the trap.', type: 'issue', category: 'other', priority: 'urgent', origin: 'internal', status: 'resolved', assignee: uid('Priya'), escalated: false, createdHrs: 6, resolvedHrs: 5.4 }),
      // A Bayshore ticket raised by the OTHER customer contact — the demo contact sees Bayshore
      // through a group, so the hub shows it as raised by someone else.
      wo('pr_bayshore_lights', bayshore, { title: 'Hallway lights left on overnight in the west wing', description: 'The west-wing hallway lights were on all night after the clean.', type: 'complaint', category: 'other', priority: 'medium', origin: 'portal', status: 'in_progress', assignee: uid('Priya'), escalated: false, createdHrs: 20, raisedBy: DEMO_OTHER_CLIENT_USER, messages: [
        { role: 'client', who: 'Lee Thompson', cu: DEMO_OTHER_CLIENT_USER, body: 'The west-wing hallway lights were on all night after the clean.', hrs: 20 },
        { role: 'office', who: 'Priya Nair', body: 'Thanks Lee, adding a lights check to the close-out tonight.', hrs: 18 },
      ] }),
    ],
  };
}

// The seeded book's CLOSED tickets as a fresh seed would place them at `nowMs` — what
// lib/demoBootstrap re-places them to whenever it places the manager's day (lib/demoSandbox
// replaceClosedRows), so the customer hub's "Average time to resolve" and Reports → Time to resolve
// never age out of their 30-day window in a long-lived demo browser (they were stamped once, at
// the first seed, and three weeks later read "No requests closed").
export function seededClosedTickets(nowMs = Date.now()) {
  return buildQcProblems(nowMs).problems.filter((r) => r.status === 'resolved');
}

// A seeded checklist row, shaped EXACTLY like a backend `checklist_results` row: the
// completer is a user ID, never a name (CS-403 — the table has no name column, and the
// stub storing one is what hid the defect from demo mode). `completedBy` is a roster
// name fragment, resolved to that person's id here.
function checklist(id, client, completedBy, checkedCount, daysAgo, { schema = CLOSEOUT_SCHEMA, name = 'Nightly Close-Out Checklist', templateId = CLOSE_TEMPLATE_ID, versionId = CLOSE_VERSION_ID, photoKeys = [], hoursAgo = null, notes = {}, performedAt: at = null, jobId = null } = {}) {
  const site = firstSiteOf(client);
  // A row whose story turns on HOW LONG AGO (QR-5's 24-hour warning on the scan page) is
  // seeded in hours before the seed; the rest sit at 11 PM on their day, as before. A day
  // boundary would put "last night" on either side of 24 hours depending on the hour the
  // demo was opened. The manager's day passes the instant itself (`performedAt`) and the
  // clean the save is bound to (`jobId`), as its plan placed them.
  const performedAt = at || (hoursAgo != null ? new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString() : iso(daysAgo, 23));
  // Each mark carries WHEN it was made, as ChecklistFill now posts it (QR-1) — a few
  // minutes apart, so a seeded area's completion time is its last item's and not a row of
  // identical stamps.
  const flat = schema.areas.flatMap((a) => a.items);
  const items = flat.map((it, i) => ({
    item_key: it.id,
    label: it.label,
    checked: i < checkedCount,
    completedAt: i < checkedCount ? new Date(Date.parse(performedAt) - (flat.length - i) * 4 * 60000).toISOString() : null,
    // The cleaner's note on an item (HUB-8: the client hub shows it under the item).
    ...(notes[it.id] ? { note: notes[it.id] } : {}),
  }));
  return {
    id, template_id: templateId, template_version_id: versionId,
    template_snapshot: { name, kind: 'checklist', schema },
    client_id: client?.id ?? null, site_id: site?.id ?? null, job_id: jobId,
    completed_by_user_id: userBy(completedBy)?.id ?? null,
    // Counted against the schema, as every writer does (CS-494/CS-547, lib/checklistCount);
    // `photoKeys` is which items this seeded clean actually photographed.
    items, ...countChecklistSubmission(schema, items, { photoKeys }),
    // QR-1, derived exactly as the server derives it — so the demo's "Last cleaned" line
    // comes from the same rule production's does.
    area_completions: areaCompletionTimes(schema, items, { performedAt, photoKeys }),
    // CS-547: the id a submission's photos are filed under. Stable, so a reseed is
    // idempotent and any demo photo stays attached.
    client_submit_id: `cs_${id}`,
    performed_at: performedAt,
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
      // QR-1 / CS-547: Andre's Floor Care checklist at Coral Bay HOA, whose one section is
      // linked to that building's "Hall & stair floors" area — so the location's Cleaning
      // instructions card shows a real "Last cleaned" line there. The photo-required item
      // (`f_mop`) is listed as photographed; the demo stub counts photos out of the media
      // store, which a reseeded browser has none of, so the row is seeded 4 of 5 and the
      // fifth is visibly waiting on its photo — which is the state the feature exists to
      // make visible.
      checklist('cr_coralbay_floors', coralBay, 'Andre Baptiste', 5, 1, {
        schema: FLOORCARE_SCHEMA, name: 'Floor Care Checklist',
        templateId: FLOOR_TEMPLATE_ID, versionId: FLOOR_VERSION_ID,
      }),
      // …and Tomas's Full Clean, whose Entrance and Restrooms sections ARE linked and carry
      // no photo requirement. Seeded as the three states a QR code on those walls can answer
      // with (QR-5, Round 2's scan page — /scan/<code> on the demo, data/demoScanCodes.js):
      //   · the LATEST (submitted 3 hours before the seed) finished the entrance and stopped
      //     one item short in the restrooms — so the LOBBY reads freshly cleaned, with the
      //     photo he took of its floor (data/demoSiteMedia.js, HUB-15)…
      //   · …and the RESTROOMS fall back to the clean before, 30 hours before the seed, so
      //     their code warns "more than 24 hours" — a newer clean that did not finish an area
      //     never counts for it (lib/checklistAreas);
      //   · the hall floors (above) have never been recorded.
      // Seeded in hours, not days, so the story holds whatever hour the demo is opened; it
      // ages with the browser, and ?demo=reset puts it back.
      checklist('cr_coralbay_full', coralBay, 'Tomas Rivera', 10, 0, {
        schema: FULLCLEAN_SCHEMA, name: 'Full Clean Checklist',
        templateId: FULL_TEMPLATE_ID, versionId: FULL_VERSION_ID, hoursAgo: 3,
      }),
      checklist('cr_coralbay_full_prev', coralBay, 'Tomas Rivera', 999, 1, {
        schema: FULLCLEAN_SCHEMA, name: 'Full Clean Checklist',
        templateId: FULL_TEMPLATE_ID, versionId: FULL_VERSION_ID, hoursAgo: 30,
      }),
      // The client hub's example checklist (HUB-8, HUB-15): Andre's Floor Care two nights ago,
      // FOUR of five done — the edges left undone, with his note saying why — plus the required
      // mop photo filed under it (data/demoSiteMedia.js), so the hub shows a done item, an
      // undone one, a note and a photo ("every item, checked or not"). Unfinished on purpose for
      // the QR demo too: an area with an item still owed records no finish time
      // (lib/checklistAreas), so the hall floors keep the scan page's "never cleaned" state.
      checklist('cr_coralbay_floors_2', coralBay, 'Andre Baptiste', 4, 2, {
        schema: FLOORCARE_SCHEMA, name: 'Floor Care Checklist',
        templateId: FLOOR_TEMPLATE_ID, versionId: FLOOR_VERSION_ID,
        photoKeys: ['f_mop'],
        notes: { f_sweep: 'Extra pass by the mailroom: sand tracked in from the pool deck.', f_edges: 'Baseboards in the fitness room scuffed; flagged for a scrub.' },
      }),
    ],
  };
}

// ── Contracts (CS-194, CON-1..CON-14) ────────────────────────────────────────
// Three agreements that show the three TERM SHAPES Matt named (CON-4) and the three things
// a reminder can be about. Their schedules are built by the SAME pure rules the server runs
// (lib/contracts), so the demo's year prices, annual value and sixty-day reminder dates are
// the real arithmetic — a demo that computed its own would be a second implementation to
// drift. Dates are relative to today, so the demo always has a renewal coming up.
function buildContracts() {
  const today = todayKey();
  const yearsBack = (n) => addDaysKey(today, -365 * n);
  const daysOut = (n) => addDaysKey(today, n);
  const make = (id, { client, name, status, startDate, endDate, termType, termMonths, monthly, notice, freq, sqft, lines = [], isMaster = false, clients, document = null }) => {
    const clientIds = clients || [client?.id].filter(Boolean);
    const years = defaultYearRows({ startDate, termMonths, baseMonthlyCents: monthly })
      // CON-5: a real book rises ~3% a year, so year 2 onward is not flat.
      .map((y, i) => ({ id: `${id}_y${i + 1}`, ...y, monthlyCents: Math.round(monthly * (1.03 ** i)) }));
    const c = {
      id,
      name: name || null,
      status,
      isMaster,
      startDate,
      endDate,
      termType,
      termMonths,
      renewalTermMonths: termType === TERM_TYPE.auto_renew ? 12 : null,
      cancellationNoticeDays: notice,
      serviceFrequency: freq,
      squareFootage: sqft,
      specialTerms: null,
      baseMonthlyCents: monthly,
      document,
      notes: null,
      clientIds,
      years,
      lines: lines.map((l, i) => ({ id: `${id}_l${i + 1}`, ...l, sortOrder: i })),
      createdAt: iso(120),
      updatedAt: iso(2),
      moneyVisible: true,
    };
    c.reminders = contractReminderPlan(c, { years }, today).map((p, i) => ({
      id: `${id}_r${i + 1}`, contractId: id, kind: p.kind, targetDate: p.targetDate, dueOn: p.dueOn,
      nextDueOn: p.dueOn, status: REMINDER_STATUS.pending, note: null, notifiedAt: null,
      doneAt: null, doneByUserId: null,
    }));
    return c;
  };
  const lasOlas = clientBy('Las Olas');
  const palmetto = clientBy('Palmetto');
  const northside = clientBy('Northside');
  const aventura = clientBy('Aventura');
  const coralBay = clientBy('Coral Bay');
  const bayshore = clientBy('Bayshore');
  return {
    contracts: [
      // A fixed three-year agreement already in its second year, with a price rise ahead.
      make('ct_demo_lasolas', {
        client: lasOlas, status: CONTRACT_STATUS.active, startDate: yearsBack(1), endDate: daysOut(730),
        termType: TERM_TYPE.fixed, termMonths: 36, monthly: 412500, notice: 90,
        freq: '5x per week, nights', sqft: 38000,
        lines: [{ description: 'Quarterly floor care', monthlyCents: 48000 }],
      }),
      // Auto-renewing, with the renewal inside the sixty-day window — the demo's live reminder.
      make('ct_demo_palmetto', {
        client: palmetto, status: CONTRACT_STATUS.active, startDate: addDaysKey(daysOut(40), -365),
        endDate: daysOut(40), termType: TERM_TYPE.auto_renew, termMonths: 12, monthly: 268000, notice: 30,
        freq: '3x per week', sqft: 21500,
      }),
      // A master agreement over two buildings, month-to-month after its first term.
      make('ct_demo_master', {
        name: 'Northside + Aventura — master agreement', isMaster: true,
        clients: [northside?.id, aventura?.id].filter(Boolean),
        status: CONTRACT_STATUS.active, startDate: yearsBack(2), endDate: daysOut(120),
        termType: TERM_TYPE.month_to_month, termMonths: 24, monthly: 595000, notice: 60,
        freq: '7x per week', sqft: 64000,
        lines: [
          { description: 'Window washing (exterior, monthly)', monthlyCents: 62500 },
          { description: 'Day porter, Northside', monthlyCents: 180000 },
        ],
      }),
      // The client hub redesign (2026-10-08): a master agreement over the two buildings the hub
      // demo's customer contact sees, with its signed copy on file, so the hub's Documents page
      // shows a service agreement from either building (Matt's M3 ★a).
      make('ct_demo_coralbay', {
        name: 'Coral Bay + Bayshore master agreement', isMaster: true,
        clients: [coralBay?.id, bayshore?.id].filter(Boolean),
        status: CONTRACT_STATUS.active, startDate: addDaysKey(today, -275), endDate: daysOut(455),
        termType: TERM_TYPE.fixed, termMonths: 24, monthly: 342000, notice: 60,
        freq: '5x per week, evenings', sqft: 41000,
        document: { name: 'Coral Bay + Bayshore signed agreement.pdf', size: 245760, storagePath: null },
      }),
    ].filter((c) => c.clientIds.length),
  };
}

// ── HR warnings (Matt's HR-1..HR-5, on his own form — HR-1 b) ────────────────
// Two warnings that show the two ends of the flow: one already acknowledged on file (Andre,
// three months ago, signed in person), and one AWAITING the signature (Tomas — the seeded
// Spanish reader — issued yesterday), so My Day shows the crew card and HR shows "Awaiting".
// Tomas's ticks two of the form's reasons and "Other", so the list, the detail and the
// printed form all show a multi-reason warning.
// The signature is a tiny transparent PNG: the demo shows WHERE a signature sits, not one.
const DEMO_SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function buildHrWarnings() {
  const today = todayKey();
  const sup = userBy('Renata');
  const andre = userBy('Andre');
  const tomas = userBy('Tomas');
  const blank = {
    employeeSignature: null, employeeSignedAt: null, employeeComment: null, signedInPerson: false,
    refusedAt: null, hrManagerUserId: null, hrManagerName: null, hrManagerSignature: null, hrManagerSignedAt: null,
    voidedAt: null, voidedByUserId: null, voidedByName: null, voidReason: null, remindedAt: null,
  };
  const w = (id, who, { daysAgo, level, reasons, reasonOther = null, previousMeetingDate = null, happened, change, ...rest }) => ({
    ...blank,
    id,
    employeeUserId: who?.id,
    employeeName: who?.name || null,
    supervisorUserId: sup?.id,
    supervisorName: sup?.name || null,
    level,
    reasons,
    reasonOther,
    previousMeetingDate,
    whatHappened: happened,
    whatMustChange: change,
    issuedAt: iso(daysAgo, 15),
    issuedOn: addDaysKey(today, -daysAgo),
    issuedByUserId: sup?.id || null,
    ...rest,
  });
  return {
    warnings: [
      w('dec0de01-0000-4000-8000-00000000a002', tomas, {
        daysAgo: 1, level: WARNING_LEVEL.first,
        reasons: [WARNING_REASON.procedure, WARNING_REASON.tardiness, WARNING_REASON.other],
        reasonOther: 'Left the building unlocked',
        happened: 'Clocked in 50 minutes after the scheduled start at Northside, with no call ahead, and left the side door unlocked at clock-out.',
        change: 'Arrive by the scheduled start, or call your supervisor before the shift if you will be late. Check every door before clocking out.',
        status: WARNING_STATUS.awaiting,
      }),
      w('dec0de01-0000-4000-8000-00000000a001', andre, {
        daysAgo: 92, level: WARNING_LEVEL.first, reasons: [WARNING_REASON.performance],
        happened: 'The second-floor restrooms were left unfinished on two nights the same week.',
        change: 'Finish every area on the checklist before clocking out.',
        status: WARNING_STATUS.acknowledged,
        employeeSignature: DEMO_SIGNATURE,
        employeeSignedAt: iso(92, 16),
        employeeComment: 'Understood. The supply closet was locked that week.',
        signedInPerson: true,
      }),
    ].filter((x) => x.employeeUserId && x.supervisorUserId),
  };
}

// ── HR terminations (Super Clippy's idea #513 — Matt's termination form) ─────────────
// Two, so the list, the HR cards and the read view show both kinds without turning anyone in the
// seeded roster off:
//   · Renata Cruz, an Account Manager, accepted another job and is moving: her last day is ten
//     days out, filed yesterday, her Direct Account Manager Nadia Brooks. Her login turns off on
//     that day (the demo's store keeps her Active until then), and the read view's "Still on"
//     lists the customers she manages and her cleans from that day;
//   · Luis Ferrer, filed four days ago for three missed shifts ("Other:" with its words), voided
//     the next day by the Super Admin (filed for the wrong cleaner), so his login came back on.
function buildHrTerminations() {
  const today = todayKey();
  const renata = userBy('Renata');
  const nadia = userBy('Nadia');
  const luis = userBy('Luis');
  const owner = (INITIAL_STATE.users || []).find((u) => u.role === 'owner') || null;
  const blank = { voidedAt: null, voidedByUserId: null, voidedByName: null, voidReason: null, accessEndedAt: null, statusBefore: null, accessRestoredAt: null };
  return {
    terminations: [
      {
        ...blank,
        id: 'dec0de03-0000-4000-8000-00000000c001',
        employeeUserId: renata?.id || null,
        employeeName: renata?.name || null,
        terminationDate: addDaysKey(today, 10),
        managerUserId: nadia?.id || null,
        managerName: nadia?.name || null,
        reasons: [TERMINATION_REASON.anotherJob, TERMINATION_REASON.movedOutOfState],
        reasonOther: null,
        filedAt: iso(1, 16),
        filedByUserId: owner?.id || null,
        filedByName: owner?.name || null,
        status: TERMINATION_STATUS.filed,
        accessState: ACCESS_STATE.scheduled,
      },
      {
        ...blank,
        id: 'dec0de03-0000-4000-8000-00000000c002',
        employeeUserId: luis?.id || null,
        employeeName: luis?.name || null,
        terminationDate: addDaysKey(today, -4),
        managerUserId: renata?.id || null,
        managerName: renata?.name || null,
        reasons: [TERMINATION_REASON.absenteeism, TERMINATION_REASON.other],
        reasonOther: 'No call, no show for three shifts in a row',
        filedAt: iso(4, 10),
        filedByUserId: owner?.id || null,
        filedByName: owner?.name || null,
        status: TERMINATION_STATUS.voided,
        voidedAt: iso(3, 9),
        voidedByUserId: owner?.id || null,
        voidedByName: owner?.name || null,
        voidReason: 'Filed for the wrong cleaner',
        accessState: ACCESS_STATE.restored,
        accessEndedAt: iso(4, 10),
        statusBefore: 'active',
        accessRestoredAt: iso(3, 9),
      },
    ].filter((x) => x.employeeUserId && x.managerUserId),
  };
}

// ── HR incident reports (task #258 — Matt's "ACCIDENT / INCIDENT REPORT") ─────────────
// Two reports that show both ends of the flow: one AWAITING review (Keisha slipped on a wet
// floor at Las Olas two days ago — an injury with first aid, a witness, two people told) and one
// already REVIEWED (property damage at Lakeside a month ago, with a visitor involved and no one
// hurt), so the list, the HR card, the read view and the printed form all show filled answers.
// The signature is the same tiny transparent PNG the warnings use.
function buildHrIncidents() {
  const today = todayKey();
  const sup = userBy('Renata');
  const keisha = userBy('Keisha');
  const andre = userBy('Andre');
  const lasOlas = clientBy('Las Olas');
  const lakeside = clientBy('Lakeside');
  const place = (c) => (c ? `${c.city || ''}${c.city && c.state ? ', ' : ''}${c.state || ''}` : null);
  const blank = {
    reviewedByUserId: null, reviewedByName: null, receivedOn: null, reviewedAt: null,
    voidedAt: null, voidedByUserId: null, voidedByName: null, voidReason: null,
    files: [], version: 1,
  };
  const r = (id, number, { daysAgo, client, people, ...rest }) => ({
    ...blank,
    id,
    number,
    reportedOn: addDaysKey(today, -daysAgo),
    clientId: client?.id || null,
    propertyName: client?.name || null,
    cityState: place(client),
    people,
    involvedUserIds: involvedUserIds(people),
    submittedByUserId: sup?.id || null,
    submittedByName: sup?.name || null,
    submitterSignature: DEMO_SIGNATURE,
    submitterContact: sup?.phone || null,
    signedOn: addDaysKey(today, -daysAgo),
    filedAt: iso(daysAgo, 17),
    filedByUserId: sup?.id || null,
    ...rest,
  });
  return {
    incidents: [
      r('dec0de02-0000-4000-8000-00000000b002', 2, {
        daysAgo: 2,
        client: lasOlas,
        reportedByUserId: keisha?.id || null,
        reportedByName: keisha?.name || null,
        reporterTitle: 'Crew',
        incidentDate: addDaysKey(today, -2),
        incidentTime: '21:40',
        exactLocation: 'Second floor, east restroom',
        types: [INCIDENT_TYPE.injury, INCIDENT_TYPE.slip],
        typeOther: null,
        whatHappened: 'Slipped on a freshly mopped floor while carrying the trash liners. The wet-floor sign was still on the cart. Fell on her left side.',
        people: keisha ? [{ kind: PERSON_KIND.employee, userId: keisha.id, name: keisha.name }] : [],
        injured: ANSWER.yes,
        injuryDescription: 'Bruised left wrist and hip.',
        treatment: TREATMENT.firstAid,
        treatmentProvider: null,
        witnesses: ANSWER.yes,
        witnessNames: 'Front desk night guard',
        witnessContact: 'Building security desk, (954) 555-0170',
        police: ANSWER.no,
        policeDetails: null,
        notified: [NOTIFIED.supervisor, NOTIFIED.hr],
        notifiedOther: null,
        actionsTaken: 'Ice pack from the first aid kit. Wet-floor signs put out on both entrances. She finished the shift on light duty.',
        status: INCIDENT_STATUS.awaiting,
      }),
      r('dec0de02-0000-4000-8000-00000000b001', 1, {
        daysAgo: 31,
        client: lakeside,
        reportedByUserId: andre?.id || null,
        reportedByName: andre?.name || null,
        reporterTitle: 'Crew',
        incidentDate: addDaysKey(today, -31),
        incidentTime: '19:15',
        exactLocation: 'Lobby, by the elevators',
        types: [INCIDENT_TYPE.damage, INCIDENT_TYPE.nearMiss],
        typeOther: null,
        whatHappened: 'The floor machine’s cord caught a planter, which fell and cracked. A visitor walking past stepped back in time.',
        people: [
          ...(andre ? [{ kind: PERSON_KIND.employee, userId: andre.id, name: andre.name }] : []),
          { kind: PERSON_KIND.visitor, userId: null, name: 'Tenant visitor (name not given)' },
        ],
        injured: ANSWER.no,
        injuryDescription: null,
        treatment: null,
        treatmentProvider: null,
        witnesses: ANSWER.unknown,
        witnessNames: null,
        witnessContact: null,
        police: ANSWER.no,
        policeDetails: null,
        notified: [NOTIFIED.supervisor, NOTIFIED.accountManager, NOTIFIED.client],
        notifiedOther: null,
        actionsTaken: 'Swept up the soil and pieces, roped off the spot, told the property manager the next morning.',
        status: INCIDENT_STATUS.reviewed,
        reviewedByUserId: sup?.id || null,
        reviewedByName: sup?.name || null,
        receivedOn: addDaysKey(today, -30),
        reviewedAt: iso(30, 10),
      }),
    ].filter((x) => x.submittedByUserId && x.clientId),
  };
}

// SUPPLIES (S58; SUP-13 moved them out of the shared record, 2026-10-05; the master supply list,
// 2026-10-11). The org's CATALOG (data/demoSupplyCatalog.js: Matt's two groups, a dozen items),
// each building's SWITCHES over it, and the request queue — in the SAME shape /api/supplies
// serves, the dollar shape (the tables hold cents). A switch row is the link alone (D5): the stub
// reads its name, SKU, unit and price from the catalog, as the route does. Seeded for three
// buildings on Renata's book (Las Olas, Palmetto Ridge and Coral Bay HOA — the demo cleaner Keisha's
// stop on the clock, where her own orders are; the manager's day below adds Lakeside's), with one
// request in every state, so the queue, the Catalog tab and each
// customer's Supplies tab render populated on a fresh load / ?demo=reset. A request's lines are
// frozen from the catalog with the catalog item and its SKU; the names stamped on a request are
// the roster's, the way the route snapshots them at the time of the act.
const SUPPLY_SWITCHES = {
  // Las Olas Medical Group (supervisor: Renata Cruz) — the cloths are on its list and never ordered
  evergreen: { prefix: 'lomg', at: 200, on: ['glass', 'disin', 'liner', 'towel', 'tp', 'glove', 'cloth', 'floor', 'soap'] },
  // Palmetto Ridge Corp (supervisor: Renata Cruz) — with the bulbs, which carry no price (SUP-4)
  pacridge: { prefix: 'prc', at: 160, on: ['glass', 'liner', 'towel', 'glove', 'urinal', 'floor', 'soap', 'bulb'] },
  // Coral Bay HOA (supervisor: Renata Cruz) — the demo cleaner's stop on the clock (data/demoManagerDay.js,
  // the visit she is on), so her Request Supplies opens on a list and her orders (below) are there (S131)
  mtbaker: { prefix: 'cbay', at: 120, on: ['glass', 'liner', 'towel', 'tp', 'glove', 'urinal', 'floor', 'soap'] },
};
// A building's switch row id: the same `si_seed_<prefix>-<key>` ids the demo has always used, so a
// browser's past requests still name them.
const switchId = (building, key) => seedId('si', `${SUPPLY_SWITCHES[building].prefix}-${key}`);
// A request line, frozen from the catalog as the route freezes it: the building's row, the catalog
// item it is, its SKU, name and price, and the quantity asked for.
function supplyLine(itemId, catalogKey, qty) {
  const c = demoSupplyCatalogItem(catalogKey);
  return { itemId, catalogItemId: demoSupplyCatalogId(catalogKey), sku: c.sku, name: c.name, qty, unitPrice: c.unitPrice };
}
const supplyCatalogRows = () => DEMO_SUPPLY_CATALOG.map((c) => ({
  id: demoSupplyCatalogId(c.key), sku: c.sku, name: c.name, category: c.category, unit: c.unit, unitPrice: c.unitPrice,
  createdAt: iso(220, 9),
}));

// THE SUPPLY ORDERS' DEMO STORY (S131, brief S §5): time-relative, numbered from SO-1041, on the
// demo's own buildings and people — Keisha Bryant orders at Coral Bay HOA (her stop on the clock in the
// demo's day, so her Home tile, Request Supplies, last order and history all tell it there), Renata Cruz
// (every building's account manager) approves, the office (Kyler) works the order with the
// supplier. One order PARTIALLY FULFILLED (paper towels delivered yesterday with a photo, the trash
// liners backordered a week out, a comment on it), one WAITING for approval at Palmetto, one NEW
// (approved, not yet with the supplier), one COMPLETED last week with its invoice — the demo keeps
// no file for it, and its button says so — beside the older rows (a decline, two monthly restocks
// delivered before the per-line record, one delivered before approvals existed).
const DAY_MS = 24 * 3600 * 1000;
// A moment `days` ago (fractions allowed) — for the order's per-line acts.
const agoMs = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
// One delivery on a line, as the per-line record stores it.
const supplyDelivery = (qty, at, byUserId, via = 'office') => ({ qty, at, byUserId, byName: (INITIAL_STATE.users || []).find((u) => u.id === byUserId)?.name || null, via });
// The per-line record for an order's lines: `acts[i]` = { deliveries?, backorder?, cancelled? }.
function supplyFulfillment(lines, acts = []) {
  return lines.map((l, i) => ({
    itemId: l.itemId || null, catalogItemId: l.catalogItemId || null,
    deliveries: (acts[i] && acts[i].deliveries) || [], backorder: (acts[i] && acts[i].backorder) || null, cancelled: (acts[i] && acts[i].cancelled) || null,
  }));
}
// The demo's seeded order ids, for the delivery photo and the invoice filed under them.
export const DEMO_SUPPLY_PARTIAL_ID = seedId('sr', 'prc-partial');
export const DEMO_SUPPLY_INVOICED_ID = seedId('sr', 'lomg-week');

function buildSupplies() {
  const supplyItems = Object.entries(SUPPLY_SWITCHES).flatMap(([building, s]) => s.on.map((key) => ({
    id: switchId(building, key), clientId: seedId('cl', building), catalogItemId: demoSupplyCatalogId(key), createdAt: iso(s.at, 9),
  })));
  const LO = (key, qty) => supplyLine(switchId('evergreen', key), key, qty);
  const PR = (key, qty) => supplyLine(switchId('pacridge', key), key, qty);
  const CB = (key, qty) => supplyLine(switchId('mtbaker', key), key, qty);
  const keisha = seedId('u', 'crew3');
  const renata = seedId('u', 'mgr1');
  const office = seedId('u', 'kyler');
  const partialLines = [CB('towel', 3), CB('liner', 2)];
  const weekLines = [CB('glass', 4), CB('tp', 2), CB('soap', 6)];
  const supplyRequests = [
    // SO-1041 / SO-1042 — Las Olas's past monthly orders, delivered (before the per-line record: they
    // count what went out at `completedAt`), so its Supplies tab shows a real "Last delivered" and
    // "Last 3 months"; one item it has never had (Microfiber cloths) reads "Not yet". Their lines
    // name the catalog item, so switching an item off and back on keeps this history (D6).
    {
      id: seedId('sr', 'lomg-done2'), number: 1041, clientId: seedId('cl', 'evergreen'),
      requestedByUserId: renata, status: 'completed', note: '',
      lines: [LO('glass', 5), LO('liner', 1), LO('tp', 2), LO('soap', 8)],
      createdAt: iso(66, 9),
      approvedAt: iso(65, 10), approvedByUserId: renata,
      completedAt: iso(64, 11), completedByUserId: office,
    },
    {
      id: seedId('sr', 'lomg-done1'), number: 1042, clientId: seedId('cl', 'evergreen'),
      requestedByUserId: renata, status: 'completed', note: 'Monthly restock.',
      lines: [LO('glass', 6), LO('disin', 1), LO('towel', 2), LO('tp', 2), LO('glove', 3), LO('floor', 2)],
      createdAt: iso(36, 9),
      approvedAt: iso(35, 10), approvedByUserId: renata,
      completedAt: iso(34, 11), completedByUserId: office,
    },
    // SO-1043 — declined, with its reason.
    {
      id: seedId('sr', 'lomg-rej'), number: 1043, clientId: seedId('cl', 'evergreen'),
      requestedByUserId: renata, status: 'rejected',
      note: 'Extra floor cleaner.',
      lines: [LO('floor', 6)],
      createdAt: iso(12, 9),
      rejectedAt: iso(11, 9), rejectedByUserId: office,
      rejectionReason: 'Six gallons is a quarter’s worth — two is plenty for a month.',
    },
    // SO-1044 — COMPLETED last week at Coral Bay, Keisha's: every line delivered, its invoice kept (in the demo the file
    // itself was never kept: the button says so).
    {
      id: DEMO_SUPPLY_INVOICED_ID, number: 1044, clientId: seedId('cl', 'mtbaker'),
      requestedByUserId: keisha, status: 'completed', note: 'Restock for the pool house.',
      lines: weekLines,
      createdAt: iso(10, 9),
      approvedAt: iso(10, 11), approvedByUserId: renata,
      sentAt: iso(9, 10), sentByUserId: office,
      fulfillment: supplyFulfillment(weekLines, [
        { deliveries: [supplyDelivery(4, iso(7, 9), office)] },
        { deliveries: [supplyDelivery(2, iso(7, 9), office)] },
        { deliveries: [supplyDelivery(6, iso(7, 9), office)] },
      ]),
      fulfillmentState: 'ready',
      completedAt: iso(7, 10), completedByUserId: office,
    },
    // SO-1045 — delivered before SUP-1 existed, so it carries no approval stamps: exactly what a
    // committed request looked like on the day approvals shipped.
    {
      id: seedId('sr', 'prc-done'), number: 1045, clientId: seedId('cl', 'pacridge'),
      requestedByUserId: seedId('u', 'heather'), status: 'completed',
      note: '',
      lines: [PR('floor', 2), PR('towel', 2)],
      createdAt: iso(6, 9), completedAt: iso(5, 9), completedByUserId: office,
    },
    // SO-1046 — PARTIALLY FULFILLED (Matt's board): Keisha asked, Renata approved, the office ordered
    // it; the paper towels arrived yesterday (a photo filed with them, data/demoSiteMedia.js), the
    // trash liners are backordered a week out; a comment says so.
    {
      id: DEMO_SUPPLY_PARTIAL_ID, number: 1046, clientId: seedId('cl', 'mtbaker'),
      requestedByUserId: keisha, status: 'sent', note: 'Out of towels in both restrooms.',
      lines: partialLines,
      createdAt: iso(4, 18),
      approvedAt: iso(4, 19), approvedByUserId: renata,
      sentAt: iso(3, 10), sentByUserId: office,
      fulfillment: supplyFulfillment(partialLines, [
        { deliveries: [supplyDelivery(3, iso(1, 9), office)] },
        { backorder: { at: iso(1, 9), byUserId: office, byName: (INITIAL_STATE.users || []).find((u) => u.id === office)?.name || null, eta: addDaysKey(todayKey(), 7) } },
      ]),
      fulfillmentState: 'partial',
    },
    // SO-1047 — NEW: approved, waiting for the office to order it.
    {
      id: seedId('sr', 'prc-appr'), number: 1047, clientId: seedId('cl', 'mtbaker'),
      requestedByUserId: keisha, status: 'approved',
      note: 'Monthly restock.',
      lines: [CB('towel', 2), CB('glove', 3)],
      createdAt: iso(2, 9),
      approvedAt: iso(1, 9), approvedByUserId: renata,
    },
    // SO-1048 — waiting for Renata, at Las Olas.
    {
      id: seedId('sr', 'lomg-open'), number: 1048, clientId: seedId('cl', 'evergreen'),
      requestedByUserId: renata, status: 'open',
      note: 'Out of glass cleaner by Friday.',
      lines: [LO('glass', 4), LO('liner', 2), LO('towel', 1)],
      createdAt: iso(1, 9),
    },
    // SO-1049 — WAITING for approval at Coral Bay HOA: Keisha's, asked a few hours ago.
    {
      id: seedId('sr', 'prc-wait'), number: 1049, clientId: seedId('cl', 'mtbaker'),
      requestedByUserId: keisha, status: 'open',
      note: 'Hand soap is almost out on the second floor.',
      lines: [CB('soap', 4), CB('urinal', 1)],
      createdAt: agoMs(0.15),
    },
  ];

  return {
    catalog: supplyCatalogRows().map((c) => ({ ...c, updatedAt: c.createdAt, version: 1 })),
    ...supplyRows(supplyItems, supplyRequests),
    comments: [{
      id: seedId('src', 'prc-partial-1'), requestId: DEMO_SUPPLY_PARTIAL_ID, authorUserId: office, authorRole: 'owner',
      authorName: (INITIAL_STATE.users || []).find((u) => u.id === office)?.name || null,
      body: 'Trash liners are on backorder with the supplier — the paper towels came yesterday.', createdAt: iso(1, 10),
    }],
    invoices: [{
      id: seedId('sdoc', 'lomg-week'), requestId: DEMO_SUPPLY_INVOICED_ID, kind: 'invoice', fileName: 'Invoice 20471.pdf',
      mimeType: 'application/pdf', sizeBytes: 182400, uploadedByUserId: office,
      uploaderName: (INITIAL_STATE.users || []).find((u) => u.id === office)?.name || null, createdAt: iso(7, 11),
    }],
  };
}

// The route's row shape for the switches and the orders: every order carries all its stamps (null
// when not done), the roster names snapshotted at the time of each act, its NUMBER, and the per-line
// record (S131) as /api/supplies writes them. An older row's sent record (the delivery step) keeps
// its money in cents, as that step wrote it.
function supplyRows(supplyItems, supplyRequests) {
  const nameOf = (id) => (INITIAL_STATE.users || []).find((u) => u.id === id)?.name || null;
  const cents = (dollars) => (Number(dollars) > 0 ? Math.round(Number(dollars) * 100) : 0);
  return {
    items: supplyItems.map((it) => ({ ...it, updatedAt: it.createdAt, version: 1 })),
    requests: supplyRequests.map((r) => ({
      approvedAt: null, approvedByUserId: null, rejectedAt: null, rejectedByUserId: null, rejectionReason: null,
      sentAt: null, sentByUserId: null, sentLines: null, fulfillment: null, fulfillmentState: null,
      completedAt: null, completedByUserId: null,
      ...r,
      requestedByName: nameOf(r.requestedByUserId),
      approvedByName: nameOf(r.approvedByUserId),
      rejectedByName: nameOf(r.rejectedByUserId),
      sentByName: nameOf(r.sentByUserId),
      sentTotalCents: Array.isArray(r.sentLines)
        ? (r.lines || []).reduce((a, l, i) => a + (Number(r.sentLines[i]?.qtySent) || 0) * cents(l.unitPrice), 0) : null,
      completedByName: nameOf(r.completedByUserId),
      updatedAt: r.createdAt, version: 1,
    })),
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
    [CONTRACTS_STUB_KEY]: buildContracts(),
    [HR_WARNINGS_STUB_KEY]: buildHrWarnings(),
    [HR_INCIDENTS_STUB_KEY]: buildHrIncidents(),
    [HR_TERMINATIONS_STUB_KEY]: buildHrTerminations(),
    [SUPPLIES_STUB_KEY]: buildSupplies(),
    [CLIENT_MESSAGES_STUB_KEY]: buildClientMessages(),
    [CUSTOMER_DOCUMENTS_STUB_KEY]: buildCustomerDocuments(),
  };
}

// ── Builder C: invoices + documents (client hub redesign, plan 2026-10-08 §3.5 / §3.6) ──────
// The documents a customer downloads from the hub, in the customer_documents TABLE's own
// snake_case shape (lib/customerDocumentsApi's demo db; lib/hubDemo.js reads the same rows), so
// the office tab, Settings → Company and the hub preview all run the server's pure projections.
// One of every state the screens draw: a COI valid for months (Coral Bay, the hub contact's own
// building), an EXPIRED one (Bayshore, her second building — the "Expired" badge), another
// building's (never shown to her), a HIDDEN office copy (never shown to any customer), and the
// company's W-9 for every customer. The service agreement is the master contract above.
// (The demo's INVOICES are not here: they are QuickBooks's, in lib/qboStubData.js — this module
// ships in every bundle and the QuickBooks fixtures must not, CS-066 C1.)
function buildCustomerDocuments() {
  const today = todayKey();
  const coralBay = clientBy('Coral Bay');
  const bayshore = clientBy('Bayshore');
  const lasOlas = clientBy('Las Olas');
  const owner = userBy('Kyler') || (INITIAL_STATE.users || [])[0] || null;
  const d = (n, client, kind, title, { validUntil = null, visible = true, fileName, mime = 'application/pdf', size = 184320, daysAgo = 20 } = {}) => ({
    id: `dec0de02-0000-4000-8000-0000000000d${n}`,
    client_id: client === null ? null : client?.id || null,
    kind,
    title,
    valid_until: validUntil,
    file_name: fileName || `${title}.pdf`,
    file_size: size,
    mime_type: mime,
    visible_to_client: visible,
    revision: 1,
    created_at: iso(daysAgo, 10),
    updated_at: iso(daysAgo, 10),
    created_by_user_id: owner?.id || null,
  });
  return {
    documents: [
      d(1, coralBay, 'coi', 'Certificate of Insurance', { validUntil: addDaysKey(today, 174), fileName: 'Coral Bay HOA COI 2026-27.pdf', daysAgo: 12 }),
      d(2, coralBay, 'other', 'Insurance endorsement (office copy)', { visible: false, fileName: 'Endorsement.pdf', daysAgo: 12 }),
      d(3, bayshore, 'coi', 'Certificate of Insurance', { validUntil: addDaysKey(today, -12), fileName: 'Bayshore COI 2025-26.pdf', daysAgo: 330 }),
      d(4, lasOlas, 'coi', 'Certificate of Insurance', { validUntil: addDaysKey(today, 300), fileName: 'Las Olas COI.pdf', daysAgo: 60 }),
      d(5, null, 'w9', 'W-9', { fileName: 'W-9.pdf', size: 96256, daysAgo: 90 }),
    ].filter((x) => x.client_id !== undefined && (x.kind === 'w9' || x.client_id)),
  };
}

// ── Builder B: customer messages (client hub redesign, plan §3.4) ─────────────────────────────
// Each building's thread with the office, in the SAME snake_case rows `public.client_messages`
// holds, so the office's demo (lib/clientMessagesApi → lib/clientMessagesDemo) and the customer's
// (lib/hubDemo) read one store. Coral Bay HOA — the demo customer contact's own building — has a
// short conversation whose last line is the customer's, so the office's Customers tab opens on an
// unread thread and the hub's bell shows the manager's earlier reply; Bayshore (the contact's
// group building) has one line from the office; Las Olas a customer line nobody has answered.
// Times are hours before the seed, so the bell's 30 days always cover them.
function buildClientMessages() {
  const coralBay = clientBy('Coral Bay');
  const bayshore = clientBy('Bayshore');
  const lasOlas = clientBy('Las Olas');
  const isoHrs = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const staff = (frag) => userBy(frag) || null;
  const line = (n, client, o) => ({
    id: `dec0de10-0000-4000-8000-${String(n).padStart(12, '0')}`,
    client_id: client?.id || null,
    author_role: o.cu || o.customerName ? 'client' : 'staff',
    author_client_user_id: o.cu?.id || null,
    author_user_id: o.staff?.id || null,
    author_name: o.cu?.name || o.customerName || o.staff?.name || null,
    body: o.body,
    created_at: isoHrs(o.hrs),
  });
  const renata = staff('Renata');
  const priya = staff('Priya');
  const messages = [
    line(1, coralBay, { cu: DEMO_CLIENT_USER, hrs: 76, body: 'Hi Renata, could the crew also wipe down the mailroom counters on Thursdays?' }),
    line(2, coralBay, { staff: renata, hrs: 74, body: 'Hi Sasha, yes. I have added the mailroom counters to the Thursday visit, starting this week.' }),
    line(3, coralBay, { cu: DEMO_CLIENT_USER, hrs: 20, body: 'Thank you! One more thing: the side gate code changes on Monday. Who should I send it to?' }),
    line(4, bayshore, { staff: priya, hrs: 50, body: 'Hi Lee, your window cleaning is booked for Friday morning. The crew will start on the west wing.' }),
    line(5, lasOlas, { customerName: 'Pat Ramirez', hrs: 5, body: 'Can the crew start thirty minutes later on Friday? We have a late clinic that evening.' }),
  ].filter((m) => m.client_id);
  return { messages, reads: [], updatesSeen: {}, emailPrefs: {} };
}

// ── The manager's day (data/demoManagerDay.js) ────────────────────────────────────────────────
// What a manager's screens read from the stubs on the day the plan placed: the checklist saves
// on today's visits, the requests the customer raised in the hub on the manager's buildings,
// two checklists filed under a building, and the supply rows that put one building over its
// budget and one order with the office. lib/demoBootstrap merges them (lib/demoSandbox's rules):
// the saves are replaced on every placing, the requests are moved with the clock (a reply the
// viewer added stays), and the templates and supply rows are written only where absent — except
// the delivery that makes the budget story, which moves into the current month.

// Two nine-item checklists, each FILED under its building (R2) and assigned per cleaner there
// (data/seed.js crewChecklists): Keisha's and Demo Crew's at Palmetto Ridge, Luis's and Demo Crew's
// at Las Olas.
const MD_OFFICE_SCHEMA = {
  areas: [
    { id: 'mo_lobby', label: 'Lobby & Elevators', items: [
      { id: 'mo_lobby_glass', label: 'Entry glass and elevator doors wiped', naAllowed: false },
      { id: 'mo_lobby_floor', label: 'Lobby floor swept and mopped', naAllowed: false },
      { id: 'mo_lobby_trash', label: 'Trash and recycling emptied', naAllowed: false },
    ] },
    { id: 'mo_rest', label: 'Restrooms', items: [
      { id: 'mo_rest_fix', label: 'Toilets, urinals and sinks sanitized', naAllowed: false },
      { id: 'mo_rest_supply', label: 'Soap, towels and paper restocked', naAllowed: false },
      { id: 'mo_rest_floor', label: 'Floors mopped with disinfectant', naAllowed: false },
    ] },
    { id: 'mo_office', label: 'Offices & Conference Rooms', items: [
      { id: 'mo_off_surf', label: 'Desks and tables dusted around belongings', naAllowed: false },
      { id: 'mo_off_vac', label: 'Carpets vacuumed', naAllowed: false },
      { id: 'mo_off_conf', label: 'Conference rooms reset, whiteboards wiped', naAllowed: false },
    ] },
  ],
};
const MD_MEDICAL_SCHEMA = {
  areas: [
    { id: 'mm_wait', label: 'Waiting Room & Reception', items: [
      { id: 'mm_wait_seats', label: 'Seating and armrests disinfected', naAllowed: false },
      { id: 'mm_wait_counter', label: 'Reception counter and check-in pens wiped', naAllowed: false },
      { id: 'mm_wait_floor', label: 'Floor swept and mopped', naAllowed: false },
    ] },
    { id: 'mm_exam', label: 'Exam Rooms', items: [
      { id: 'mm_exam_table', label: 'Exam tables and stools disinfected', naAllowed: false },
      { id: 'mm_exam_bio', label: 'Biohazard bins checked and swapped when full', naAllowed: false },
      { id: 'mm_exam_trash', label: 'Trash emptied and liners replaced', naAllowed: false },
    ] },
    { id: 'mm_rest', label: 'Restrooms', items: [
      { id: 'mm_rest_fix', label: 'Fixtures sanitized', naAllowed: false },
      { id: 'mm_rest_supply', label: 'Supplies restocked', naAllowed: false },
      { id: 'mm_rest_floor', label: 'Floors mopped with disinfectant', naAllowed: false },
    ] },
  ],
};
const MD_OFFICE_VERSION_ID = 'iv_md_office_1';
const MD_MEDICAL_VERSION_ID = 'iv_md_medical_1';
const MD_CHECKLISTS = {
  [MD_TEMPLATE_OFFICE]: { schema: MD_OFFICE_SCHEMA, name: 'Office Nightly Clean', versionId: MD_OFFICE_VERSION_ID },
  [MD_TEMPLATE_MEDICAL]: { schema: MD_MEDICAL_SCHEMA, name: 'Medical Office Clean', versionId: MD_MEDICAL_VERSION_ID },
  [CLOSE_TEMPLATE_ID]: { schema: CLOSEOUT_SCHEMA, name: 'Nightly Close-Out Checklist', versionId: CLOSE_VERSION_ID },
};

export function buildManagerDayStubs(day) {
  const N = day.nowMs;
  const client = (key) => (INITIAL_STATE.clients || []).find((c) => c.id === seedId('cl', key)) || null;
  const nameOfUser = (key) => (INITIAL_STATE.users || []).find((u) => u.id === seedId('u', key))?.name || null;
  const renata = seedId('u', 'mgr1');
  const isoAt = (ms) => new Date(ms).toISOString();
  const palmetto = client('pacridge');
  const lasOlas = client('evergreen');

  const templates = [
    tmpl(MD_TEMPLATE_OFFICE, MD_OFFICE_VERSION_ID, 'Office Nightly Clean', 'checklist', MD_OFFICE_SCHEMA, 100, 20, palmetto?.id),
    tmpl(MD_TEMPLATE_MEDICAL, MD_MEDICAL_VERSION_ID, 'Medical Office Clean', 'checklist', MD_MEDICAL_SCHEMA, 100, 20, lasOlas?.id),
  ];

  // The day's saves, each bound to its visit (the clock-out gate's match) and stamped when the
  // plan says the cleaner saved it.
  const checklists = (day.checklists || []).map((c) => {
    const t = MD_CHECKLISTS[c.template];
    if (!t) return null;
    return checklist(c.id, client(c.client), nameOfUser(c.user), c.done, 0, {
      schema: t.schema, name: t.name, templateId: c.template, versionId: t.versionId,
      performedAt: isoAt(c.atMs), jobId: c.jobId,
    });
  }).filter(Boolean);

  // The customer's own requests from the hub (data/demoManagerDay.js MANAGER_DAY_REQUESTS), raised
  // by the demo contact on Renata's buildings, with their threads. The seeded book already carries
  // one waiting on her (pr_coralbay_windows), one completed (pr_coralbay_carpet) and the office's
  // own logged issue (pr_bayshore_scrub).
  const names = { client: DEMO_CLIENT_USER.name, ...Object.fromEntries(['crew1', 'crew2', 'crew3', 'crew4', 'crewdemo'].map((k) => [k, nameOfUser(k)])) };
  const problems = MANAGER_DAY_REQUESTS.map((r) => workOrderRow(`${MANAGER_DAY_PREFIX.ticket}${r.key}`, client(r.building), {
    title: r.title, description: r.description, type: r.type, category: r.category, priority: r.priority,
    origin: 'portal', status: r.status, assignee: r.assigned ? renata : null, escalated: r.escalated,
    createdHrs: r.createdHrs, raisedBy: DEMO_CLIENT_USER, crew: (r.crew || []).map((k) => seedId('u', k)),
    messages: r.messages.map((m) => ({
      role: m.role,
      who: m.role === 'client' ? DEMO_CLIENT_USER.name : m.role === 'office' ? nameOfUser('mgr1') : nameOfUser(m.by),
      cu: m.role === 'client' ? DEMO_CLIENT_USER : null,
      body: managerDayText(m.body, names), trans: m.trans || null, from: m.from || null, hrs: m.hrs,
    })),
  }, N));

  // Supplies (MANAGER_DAY_SUPPLIES): Lakeside's switches and its approved order, the delivery that
  // keeps Palmetto Ridge over budget this month, and the delivery step's two daily rows — an order
  // with the supplier for Las Olas and one delivered to Lakeside today (Demo Crew cleans both today)
  // — every item one of the demo catalog's. The office (the owner) orders and delivers in the demo.
  // S131: numbered after the seeded story (SO-1050 on), each with its per-line record from the one
  // rule (managerDaySupplyFulfillment).
  const HR = 3600 * 1000;
  const itemId = (key) => seedId('si', `md-${key}`);
  const catalogOf = (itemKey) => MANAGER_DAY_SUPPLIES.items.find((it) => it.key === itemKey)?.catalog || null;
  const items = MANAGER_DAY_SUPPLIES.items.map((it) => ({
    id: itemId(it.key), clientId: client(it.building)?.id, catalogItemId: demoSupplyCatalogId(it.catalog),
    createdAt: isoAt(N - 90 * 24 * HR),
  }));
  const deliveredMs = managerDayDeliveredMs(day);
  const times = managerDaySupplyTimes(day);
  const office = seedId('u', 'kyler');
  const officeBy = { id: office, name: nameOfUser('kyler') };
  const etaKey = addDaysKey(day.dayKey || todayKey(), 3);
  const requests = MANAGER_DAY_SUPPLIES.requests.map((r, i) => {
    // A line by the day's own item is that Lakeside switch; one by catalog key is the building's own
    // row for it (Palmetto's and Las Olas's lists, SUPPLY_SWITCHES).
    const lines = r.lines.map((l) => (l.item
      ? supplyLine(itemId(l.item), catalogOf(l.item), l.qty)
      : supplyLine(SUPPLY_SWITCHES[r.building] ? switchId(r.building, l.catalog) : null, l.catalog, l.qty)));
    const base = { id: seedId('sr', `md-${r.key}`), number: 1050 + i, clientId: client(r.building)?.id, requestedByUserId: renata, status: r.status, note: r.note, lines };
    if (r.status === 'sent') {
      const t = times.sent;
      const fulfillment = managerDaySupplyFulfillment(r, lines, { at: t.sentMs + 30 * 60 * 1000 < N ? t.sentMs + 30 * 60 * 1000 : t.sentMs, by: officeBy, etaKey });
      return { ...base, createdAt: isoAt(t.createdMs), approvedAt: isoAt(t.approvedMs), approvedByUserId: renata,
        sentAt: isoAt(t.sentMs), sentByUserId: office, fulfillment, fulfillmentState: 'pending', completedAt: null, completedByUserId: null };
    }
    if (r.status === 'completed' && r.deliveredToday) {
      const t = times.delivered;
      return { ...base, createdAt: isoAt(t.createdMs), approvedAt: isoAt(t.approvedMs), approvedByUserId: renata,
        sentAt: isoAt(t.sentMs), sentByUserId: office,
        fulfillment: managerDaySupplyFulfillment(r, lines, { at: t.completedMs, by: officeBy }), fulfillmentState: 'ready',
        completedAt: isoAt(t.completedMs), completedByUserId: office };
    }
    if (r.status === 'completed') {
      return { ...base, createdAt: isoAt(deliveredMs - 30 * HR), approvedAt: isoAt(deliveredMs - 26 * HR), approvedByUserId: renata,
        sentAt: isoAt(deliveredMs - 20 * HR), sentByUserId: office,
        fulfillment: managerDaySupplyFulfillment(r, lines, { at: deliveredMs, by: officeBy }), fulfillmentState: 'ready',
        completedAt: isoAt(deliveredMs), completedByUserId: office };
    }
    return { ...base, createdAt: isoAt(N - r.createdHrs * HR), approvedAt: r.approvedHrs != null ? isoAt(N - r.approvedHrs * HR) : null, approvedByUserId: r.approvedHrs != null ? renata : null, completedAt: null, completedByUserId: null };
  }).filter((r) => r.clientId);
  const supplies = supplyRows(items.filter((it) => it.clientId), requests);

  // The customer's messages in the building's hub thread (MANAGER_DAY_MESSAGES): two waiting for the
  // office's first reply (12 and 50 minutes) and one answered, by the demo contact, on buildings in
  // her group. The other managers' buildings (x…) are the production sandbox's only.
  const messages = MANAGER_DAY_MESSAGES.filter((m) => client(m.building)).flatMap((m, mi) => m.lines.map((l, li) => ({
    id: `${MANAGER_DAY_PREFIX.message}0000-4000-8000-${String(mi * 10 + li + 1).padStart(12, '0')}`,
    client_id: client(m.building).id,
    author_role: l.role === 'client' ? 'client' : 'staff',
    author_client_user_id: l.role === 'client' ? DEMO_CLIENT_USER.id : null,
    author_user_id: l.role === 'client' ? null : renata,
    author_name: l.role === 'client' ? DEMO_CLIENT_USER.name : nameOfUser('mgr1'),
    body: managerDayText(l.body, names),
    created_at: isoAt(N - l.mins * 60 * 1000),
  })));

  return { templates, checklists, problems, supplyItems: supplies.items, supplyRequests: supplies.requests, messages };
}
