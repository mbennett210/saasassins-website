// The manager's day for the PRODUCTION SANDBOX (app/scripts/seed-backend.mjs) — PURE: the live book
// in, table rows and the shared record's changes out. Nothing here reads or writes a database; the
// script reads the book, and its write path (scripts/_lib/seedWrite.mjs) writes what this returns.
//
// THE SAME DAY AS THE DEMO: src/data/demoManagerDay.js places it (every visit relative to the run's
// now, on the org's clock). Here it is laid over the live book:
//   1. assignManagers — a seed building nobody supervises (a customer with a location, never a
//      vendor) goes to the seed's manager, Renata (u_seed_mgr1), so her view holds a full book;
//   2. planManagerDays — HER day in the plan's seven building slots over her buildings, and the
//      plan's `extra` visits (x1…x8) over every other manager's buildings, taken round-robin by
//      manager so each one's view holds a done and an upcoming visit; the roster in the crew slots;
//   3. managerDayRows — jobs, punches (two on site now), a checklist filed under each visited
//      building and saved on its visits, the customer's requests on every managed building with
//      their threads, the customer's messages in each building's hub thread (two still waiting for
//      the office's first reply), supplies, the call-out, and a cleaner's 42½-hour last week;
//   4. blobChanges — the shared record's part: the supervisors from 1, each cleaner's checklist at
//      the buildings they visit (never overwriting a pick the office made), and a supply budget on
//      the building the plan puts over it when it has none. Only seed customers (`cl_seed_*`) are
//      touched, and never a user or a permission.
//
// THE CUSTOMER IS WRITTEN IN THE PORTAL SHAPE: a request and a message carry the building's contact
// NAME with no client-hub user id (`raised_by_client_user_id` / `author_client_user_id` null), as a
// portal request raised before the hub logins did. No customer login is created, so nothing can
// invite or email anyone, and the hub preview ("Preview as customer") shows them by name.
//
// EVERY ID IS DETERMINISTIC, and enumerable over the seed customers × the plan's keys
// (managerDayIdUniverse), so the next run deletes exactly what any earlier run wrote — whichever
// building a key landed on — and never a row it did not write.
import { computeDueAt } from '../../src/lib/workOrders.js';
import { countChecklistSubmission } from '../../src/lib/checklistCount.js';
import { messageSnippet, HUB_THREAD_SNIPPET_MAX, HUB_MESSAGE_AUTHOR_ROLES as ROLE } from '../../src/lib/hubMessages.js';
import { DEFAULT_ORG_TIMEZONE, addDaysKey } from '../../src/lib/dates.js';
import { SUPERVISOR_ROLES } from '../../src/lib/roles.js';
import { catalogRowFromApp, itemRowFromApp, requestRowFromBlob, supplyBackfillCatalogId } from '../../api/_lib/supplies/store.js';
import { demoSupplyCatalogItem } from '../../src/data/demoSupplyCatalog.js';
import { supplyToCents } from '../../src/lib/supplies.js';
import {
  buildManagerDay, MANAGER_DAY_SLOTS, MANAGER_DAY_REQUESTS, MANAGER_DAY_OTHER_REQUESTS, MANAGER_DAY_SUPPLIES,
  MANAGER_DAY_MESSAGES, MANAGER_DAY_MESSAGE_ANSWERED, MANAGER_DAY_EXTRA_KEYS, MANAGER_DAY_JOB_KEYS, MD_ON_SITE,
  managerDayText, managerDayDeliveredMs, managerDaySupplyTimes, managerDaySupplyFulfillment,
} from '../../src/data/demoManagerDay.js';

export const MD_SEED_MANAGER = 'u_seed_mgr1';
export const MD_JOB_PREFIX = 'j_bkseed_md_';
export const MD_SUPPLY_ITEM_PREFIX = 'si_bkseed_md_';
export const MD_SUPPLY_REQUEST_PREFIX = 'sr_bkseed_md_';
export const MD_CALLOUT_ID = 'to_bkseed_md_callout';
// The five-item checklist every visited building gets filed under it (the backend seed's own
// Close-Out list, the same schema as its starter).
export const MD_BUDGET = 90;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const isSeedClient = (c) => !!c && typeof c.id === 'string' && c.id.startsWith('cl_seed_');
const siteOf = (sites, clientId) => (sites || []).find((s) => s && s.clientId === clientId) || null;
// A building: a customer with a location, not a vendor, not inactive.
export function isBuilding(c, sites) {
  return !!c && c.type !== 'vendor' && c.status !== 'inactive' && c.statusOverride !== 'inactive'
    && c.statusOverride !== 'lead' && !!siteOf(sites, c.id);
}
// The tiers that may supervise a building (lib/roles SUPERVISOR_ROLES — never the supply manager).
const OFFICE_ROLES = new Set(SUPERVISOR_ROLES);

// ── 1. who supervises what ───────────────────────────────────────────────────────────────────
// Every seed building nobody supervises goes to the seed's manager. → { clients, assignments }
export function assignManagers({ clients = [], sites = [], users = [], to = MD_SEED_MANAGER } = {}) {
  const mgr = users.find((u) => u && u.id === to && u.status === 'active' && OFFICE_ROLES.has(u.role));
  if (!mgr) return { clients, assignments: [] };
  const assignments = [];
  const next = clients.map((c) => {
    if (!isSeedClient(c) || c.supervisorId || !isBuilding(c, sites)) return c;
    assignments.push({ clientId: c.id, name: c.name || c.id, from: null, to: mgr.id, toName: mgr.name });
    return { ...c, supervisorId: mgr.id };
  });
  return { clients: next, assignments };
}

// ── 2. whose day, in which buildings, by whom ────────────────────────────────────────────────
export function planManagerDays({ clients = [], sites = [], users = [], services = [], state = {}, now = new Date() } = {}) {
  const crew = users.filter((u) => u && u.role === 'crew' && u.status !== 'disabled');
  const owner = users.find((u) => u && u.role === 'owner' && u.status === 'active') || null;
  const managed = clients.filter((c) => isBuilding(c, sites) && c.supervisorId);
  const managers = [...new Set(managed.map((c) => c.supervisorId))]
    .map((id) => ({ u: users.find((u) => u.id === id), book: managed.filter((c) => c.supervisorId === id) }))
    .filter((m) => m.u && m.u.status === 'active' && OFFICE_ROLES.has(m.u.role))
    .sort((a, b) => ((b.u.role === 'manager') - (a.u.role === 'manager')) || (b.book.length - a.book.length) || String(a.u.name).localeCompare(String(b.u.name)));
  const primary = managers.find((m) => m.u.id === MD_SEED_MANAGER) || managers[0] || null;
  if (!primary || !crew.length) return null;

  // Her buildings in the plan's seven slots: a seed id still in her book keeps its own slot.
  const slotKeys = Object.keys(MANAGER_DAY_SLOTS.buildings);
  const assigned = {};
  const used = new Set();
  for (const k of slotKeys) {
    const c = primary.book.find((b) => b.id === `cl_seed_${k}`);
    if (c) { assigned[k] = c; used.add(c.id); }
  }
  const rest = primary.book.filter((c) => !used.has(c.id));
  let bi = 0;
  for (const k of slotKeys) if (!assigned[k]) assigned[k] = rest.length ? rest[bi++ % rest.length] : primary.book[bi++ % primary.book.length];

  // Every other manager's buildings in the extra slots, round-robin by manager (each one's first
  // building, then each one's second…), cycled when there are fewer buildings than slots.
  const others = [];
  const queues = managers.filter((m) => m !== primary).map((m) => [...m.book]);
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) others.push(q.shift());
  const xAssigned = {};
  if (others.length) MANAGER_DAY_EXTRA_KEYS.forEach((k, i) => { xAssigned[k] = others[i % others.length]; });

  // The roster in the crew slots: a seed cleaner keeps their slot, the rest fill.
  const crewMap = {};
  const taken = new Set();
  for (const k of MANAGER_DAY_SLOTS.crew) {
    const u = crew.find((c) => c.id === `u_seed_${k}`);
    if (u) { crewMap[k] = u; taken.add(u.id); }
  }
  const spare = crew.filter((u) => !taken.has(u.id));
  let ci = 0;
  for (const k of MANAGER_DAY_SLOTS.crew) if (!crewMap[k]) crewMap[k] = spare.length ? spare[ci++ % spare.length] : crew[ci++ % crew.length];

  const svcFor = (key) => {
    const seeded = services.find((s) => s.id === `svc_seed_${key}`);
    if (seeded) return seeded.id;
    const kw = { jan: 'jan', flr: 'floor', pw: 'pressure', rst: 'restroom' }[key] || key;
    return (services.find((s) => (s.name || s.code || '').toLowerCase().includes(kw)) || services[0])?.id ?? null;
  };
  const ownerUser = users.find((u) => u.id === `u_seed_${MANAGER_DAY_SLOTS.owner}`) || owner;
  const userFor = (k) => (k === MANAGER_DAY_SLOTS.owner ? ownerUser : k === 'mgr1' ? primary.u : crewMap[k]);
  const buildingOfSite = Object.fromEntries(Object.entries(MANAGER_DAY_SLOTS.buildings).map(([b, siteKey]) => [siteKey, b]));
  const clientOfSlot = (k) => assigned[k] || xAssigned[k] || null;
  const resolve = {
    client: (k) => clientOfSlot(k)?.id ?? null,
    site: (siteKey) => siteOf(sites, clientOfSlot(buildingOfSite[siteKey] || siteKey)?.id)?.id ?? null,
    user: (k) => userFor(k)?.id ?? null,
    service: svcFor,
    job: (k) => `${MD_JOB_PREFIX}${k}`,
  };
  const tz = state.company?.timezone || DEFAULT_ORG_TIMEZONE;
  const weekStartDay = Number.isInteger(state.opsSettings?.payWeekStartDay) ? state.opsSettings.payWeekStartDay : 0;
  const day = buildManagerDay(now, { tz, weekStartDay, resolve, extra: others.length ? MANAGER_DAY_EXTRA_KEYS.length : 0 });
  const visited = new Set(day.jobs.map((j) => j.clientId));
  return {
    primary: primary.u, managers, assigned, xAssigned, crewMap, userFor, resolve, tz, day, others,
    clientById: new Map(clients.map((c) => [c.id, c])),
    siteById: new Map(sites.map((s) => [s.id, s])),
    userById: new Map(users.map((u) => [u.id, u])),
    managedIds: managed.map((c) => c.id),
    bookSiteIds: new Set(sites.filter((s) => visited.has(s.clientId)).map((s) => s.id)),
    crewIds: new Set(Object.values(crewMap).map((u) => u.id)),
    thinRoster: crew.length < MANAGER_DAY_SLOTS.crew.length,
  };
}

// ── every id a run can write (so the next run deletes exactly those) ─────────────────────────
export function managerDayIdUniverse({ uuid5, seedClientIds = [] }) {
  const requestKeys = [...MANAGER_DAY_REQUESTS.map((r) => r.key), ...MANAGER_DAY_OTHER_REQUESTS.map((r) => r.key)];
  const messageSets = [...MANAGER_DAY_MESSAGES, MANAGER_DAY_MESSAGE_ANSWERED];
  const problemIds = [];
  const messageIds = [];
  for (const cid of seedClientIds) {
    for (const k of requestKeys) problemIds.push(uuid5(`wo:md:${cid}:${k}`));
    for (const m of messageSets) m.lines.forEach((_, li) => messageIds.push(uuid5(`cmsg:md:${cid}:${m.key}:${li}`)));
  }
  const visitKeys = [...MANAGER_DAY_JOB_KEYS, ...MANAGER_DAY_EXTRA_KEYS.map((k) => `md-${k}`)];
  const checklistIds = visitKeys.map((k) => uuid5(`chk:md:cr_md_${k.replace(/-/g, '_')}`));
  return { problemIds: [...new Set(problemIds)], messageIds: [...new Set(messageIds)], checklistIds };
}

const CLOSEOUT_ITEMS = (schema) => schema.areas[0].items;

// ── 3. the day as table rows ─────────────────────────────────────────────────────────────────
// `schema` is the backend seed's Close-Out schema; `existingMessages` the building threads' rows
// already in the table that this seed did not write (a thread summary counts them too).
export function managerDayRows(md, { org, uuid5, nowIso, schema, existingMessages = [], seedMessageIds = new Set() }) {
  const { day, siteById, clientById, userById, resolve } = md;
  const N = day.nowMs;
  const iso = (ms) => new Date(ms).toISOString();
  const hrsAgo = (h) => iso(N - h * HOUR);
  const jobRows = [];
  const teRows = [];
  const jobRow = (job) => ({ id: job.id, organization_id: org, data: job, start_at: job.startAt, status: job.status, client_id: job.clientId, site_id: job.siteId, series_id: null, updated_at: nowIso, updated_by: null, updated_by_build: 0, updated_by_tab: null });
  const jobs = new Map();
  for (const j of day.jobs) {
    if (!j.clientId || !j.siteId) continue;
    const { oneOff, ...rest } = j;
    void oneOff;
    const job = { ...rest, seriesId: null };
    jobs.set(job.id, job);
    jobRows.push(jobRow(job));
  }
  const te = ({ id, job, user, inMs, outMs, geo, dist, pending }) => {
    const site = siteById.get(job.siteId);
    const client = clientById.get(job.clientId);
    const fix = Number.isFinite(site?.lat) && Number.isFinite(site?.lng) && geo !== 'unavailable';
    const open = outMs == null;
    return {
      id: uuid5(`te:md:${id}`), organization_id: org, job_id: job.id, series_id: null, shift_id: null,
      client_id: job.clientId, site_id: job.siteId, user_id: user.id, client_name: client?.name ?? null, site_name: site?.name ?? null, user_name: user.name,
      scheduled_start: job.startAt, scheduled_end: job.endAt, expected_minutes_snapshot: Math.round((Date.parse(job.endAt) - Date.parse(job.startAt)) / MIN),
      clock_in_at: iso(inMs), clock_out_at: open ? null : iso(outMs), duration_minutes: open ? null : Math.round((outMs - inMs) / MIN),
      clock_in_lat: fix ? site.lat : null, clock_in_lng: fix ? site.lng : null,
      clock_in_accuracy_m: fix ? 8 : null, clock_in_distance_m: fix ? dist : null,
      clock_out_lat: !open && fix ? site.lat : null, clock_out_lng: !open && fix ? site.lng : null,
      geofence_result: geo, override_reason: null,
      source: 'crew_mobile', status: open ? 'in_progress' : 'completed', approval_status: pending ? 'pending' : 'approved',
    };
  };
  const dropped = [];
  const spans = new Map();   // userId → [[in, out]]: nobody is in two places
  const take = (userId, inMs, outMs, label) => {
    const list = spans.get(userId) || [];
    const end = outMs == null ? N : outMs;
    if (list.some(([a, b]) => inMs < b && a < end)) { dropped.push(label); return false; }
    list.push([inMs, end]);
    spans.set(userId, list);
    return true;
  };
  for (const e of day.entries) {
    const user = userById.get(resolve.user(e.user));
    if (!user) continue;
    let job = jobs.get(e.job);
    if (e.ot) {
      const clientId = resolve.client(e.client);
      const siteId = resolve.site(e.site);
      if (!clientId || !siteId) continue;
      job = { id: resolve.job(e.jobKey), clientId, siteId, serviceId: day.jobs[0]?.serviceId ?? null, crewIds: [user.id], startAt: iso(e.inAt), endAt: iso(e.inAt + e.dur * MIN), status: 'done', notes: 'Day porter.', seriesId: null, recurrence: null, createdAt: iso(e.inAt - 7 * 24 * HOUR) };
      jobRows.push(jobRow(job));
    }
    if (!job) continue;
    const outMs = e.inAt + e.dur * MIN;
    if (!take(user.id, e.inAt, outMs, e.id)) continue;
    teRows.push(te({ id: e.id, job, user, inMs: e.inAt, outMs, geo: e.geo, dist: e.dist, pending: e.appr === 'pending' }));
  }
  const onSite = jobs.get(resolve.job('cbay-w1'));
  if (onSite) {
    [['crew2', MD_ON_SITE.firstInMinsAgo, 'inside'], ['crew3', MD_ON_SITE.secondInMinsAgo, 'unavailable']].forEach(([slot, ago, geo]) => {
      const user = userById.get(resolve.user(slot));
      const inMs = N - ago * MIN;
      if (user && take(user.id, inMs, null, `on site ${slot}`)) teRows.push(te({ id: `onsite_${slot}`, job: onSite, user, inMs, outMs: null, geo, dist: 11, pending: true }));
    });
  }

  // A checklist filed under each visited building (R2), the Close-Out schema, and each cleaner on
  // its visits assigned it (the covered cleaner too, so a cover inherits it, R8).
  const templateRows = [];
  const versionRows = [];
  const picks = {};   // clientId → { userId: templateId }
  const templateOf = new Map();
  const itemCount = CLOSEOUT_ITEMS(schema).length;
  for (const job of jobs.values()) {
    const client = clientById.get(job.clientId);
    if (!isSeedClient(client)) continue;
    if (!templateOf.has(client.id)) {
      const id = uuid5(`tmpl:md:${client.id}`);
      const verId = uuid5(`tmplver:md:${client.id}`);
      templateOf.set(client.id, { id, verId });
      templateRows.push({ id, organization_id: org, slug: `s_md_${client.id}`, name: `Nightly Close-Out — ${client.name || 'building'}`, kind: 'checklist', rating_scale: { type: 'passfail', passThreshold: 100 }, is_published: true, published_version_id: verId, default_for_account: false, created_by: 'seed', client_id: client.id, item_count: itemCount });
      versionRows.push({ id: verId, template_id: id, version_number: 1, schema, status: 'published', published_at: hrsAgo(24 * 30) });
    }
    const t = templateOf.get(client.id).id;
    picks[client.id] = picks[client.id] || {};
    for (const uid of job.crewIds || []) picks[client.id][uid] = t;
    for (const covered of Object.values(job.coverFor || {})) picks[client.id][covered] = t;
  }
  const checkRows = [];
  for (const c of day.checklists) {
    const job = jobs.get(c.jobId);
    const t = job && templateOf.get(job.clientId);
    if (!job || !t || !c.userId) continue;
    const n = c.complete ? itemCount : Math.min(itemCount - 1, 3);
    const items = CLOSEOUT_ITEMS(schema).map((it, i) => ({ item_key: it.id, label: it.label, checked: i < n }));
    const name = templateRows.find((r) => r.id === t.id)?.name || 'Nightly Close-Out Checklist';
    checkRows.push({ id: uuid5(`chk:md:${c.id}`), organization_id: org, template_id: t.id, template_version_id: t.verId, template_snapshot: { name, kind: 'checklist', schema }, client_id: job.clientId, site_id: job.siteId, job_id: job.id, completed_by_user_id: c.userId, items, ...countChecklistSubmission(schema, items), performed_at: iso(c.atMs) });
  }

  // The customer's requests: the plan's three on her slot buildings, and one of the rotating ones
  // on every other managed building. Raised in the portal shape (see the header).
  const names = Object.fromEntries(MANAGER_DAY_SLOTS.crew.map((k) => [k, md.userFor(k)?.name || '']));
  const managerOf = (client) => (client?.supervisorId ? userById.get(client.supervisorId) || null : null);
  const contactOf = (client) => String(client?.primaryContact || '').trim() || null;
  const probRows = [];
  const msgRows = [];
  const requested = new Set();
  const addRequest = (client, r) => {
    const site = siteOf([...siteById.values()], client.id);
    const id = uuid5(`wo:md:${client.id}:${r.key}`);
    const created = hrsAgo(r.createdHrs);
    const mgr = managerOf(client);
    const contact = contactOf(client);
    probRows.push({
      id, organization_id: org, client_id: client.id, site_id: site?.id ?? null, job_id: null,
      reported_by_user_id: null, client_name: client.name ?? null, site_name: site?.name ?? null,
      title: r.title, description: r.description, type: r.type, origin: 'portal', priority: r.priority, status: r.status,
      category: r.category, assignee_user_id: r.assigned ? (mgr?.id ?? null) : null, photo_paths: [],
      raised_by_client_user_id: null, raised_by_client_name: contact,
      created_at: created, due_at: computeDueAt(created, r.priority),
      escalated_at: r.escalated ? hrsAgo(Math.max(0, r.createdHrs - 1)) : null,
      resolved_at: r.status === 'resolved' ? hrsAgo(r.resolvedHrs ?? 2) : null,
    });
    r.messages.forEach((m, mi) => {
      const author = m.role === 'office' ? mgr : m.role === 'crew' ? md.userFor(m.by) : null;
      msgRows.push({
        id: uuid5(`womsg:md:${client.id}:${r.key}:${mi}`), organization_id: org, problem_id: id,
        author_user_id: author?.id ?? null, author_role: m.role,
        author_name: m.role === 'client' ? (contact || client.name || 'Customer') : (author?.name || 'Office'),
        body: managerDayText(m.body, { client: contact || '', ...names }),
        translated_body: m.trans || null, from_lang: m.from || null, internal: false,
        author_client_user_id: null,
        created_at: hrsAgo(m.hrs),
      });
    });
    requested.add(client.id);
  };
  for (const r of MANAGER_DAY_REQUESTS) { const c = md.assigned[r.building]; if (c && !requested.has(c.id)) addRequest(c, r); }
  let oi = 0;
  for (const cid of md.managedIds) {
    if (requested.has(cid)) continue;
    addRequest(clientById.get(cid), MANAGER_DAY_OTHER_REQUESTS[oi++ % MANAGER_DAY_OTHER_REQUESTS.length]);
  }

  // The customer's messages in each building's hub thread: the plan's sets on their buildings, and
  // the answered exchange on every other managed building.
  const cmsgRows = [];
  const messaged = new Set();
  const addMessages = (client, set) => {
    if (!client || messaged.has(client.id)) return;
    const mgr = managerOf(client);
    const contact = contactOf(client);
    set.lines.forEach((l, li) => {
      const staff = l.role !== 'client';
      cmsgRows.push({
        id: uuid5(`cmsg:md:${client.id}:${set.key}:${li}`), organization_id: org, client_id: client.id,
        author_role: staff ? ROLE.staff : ROLE.client,
        author_client_user_id: null,
        author_user_id: staff ? (mgr?.id ?? null) : null,
        author_name: staff ? (mgr?.name || 'Office') : (contact || client.name || 'Customer'),
        body: managerDayText(l.body, { client: contact || '', ...names }),
        created_at: iso(N - l.mins * MIN),
      });
    });
    messaged.add(client.id);
  };
  for (const set of MANAGER_DAY_MESSAGES) addMessages(md.assigned[set.building] || md.xAssigned[set.building], set);
  for (const cid of md.managedIds) addMessages(clientById.get(cid), MANAGER_DAY_MESSAGE_ANSWERED);
  // The thread summaries (client_message_threads), from every line of each building we wrote to.
  const threadRows = threadSummaries({
    org, nowIso,
    messages: [...existingMessages.filter((m) => messaged.has(m.client_id) && !seedMessageIds.has(m.id)), ...cmsgRows],
  });

  // Supplies: the slot buildings' switches, approved order and the delivery past the budget this
  // month — over the master supply list (2026-10-11). The catalog rows are the demo catalog's items
  // these use, under the id the migration's backfill gives them (supplyBackfillCatalogId), so a
  // re-seed lands on the rows the backfill made from the seed's own earlier items. They are written
  // WITHOUT a SKU, a version or a date (an upsert then leaves the office's SKU, its edit counter and
  // the row's age alone, and a seed SKU could collide with a real one), and never deleted: a
  // catalog row is the org's, and other buildings may have it on.
  const nameOf = (id) => userById.get(id)?.name || null;
  const itemId = (key) => `${MD_SUPPLY_ITEM_PREFIX}${key}`;
  const catalogIdOf = (key) => {
    const c = demoSupplyCatalogItem(key);
    return supplyBackfillCatalogId(org, { name: c.name, unit: c.unit, unitPriceCents: supplyToCents(c.unitPrice) });
  };
  const catalogKeyOfItem = (key) => MANAGER_DAY_SUPPLIES.items.find((it) => it.key === key)?.catalog || null;
  const usedItems = MANAGER_DAY_SUPPLIES.items.filter((it) => md.assigned[it.building]);
  const usedRequests = MANAGER_DAY_SUPPLIES.requests.filter((r) => md.assigned[r.building]);
  const catalogKeys = [...new Set([
    ...usedItems.map((it) => it.catalog),
    ...usedRequests.flatMap((r) => r.lines.map((l) => (l.item ? catalogKeyOfItem(l.item) : l.catalog))),
  ].filter(Boolean))];
  const supplyCatalogRows = catalogKeys.map((key) => {
    const c = demoSupplyCatalogItem(key);
    const { id, name, category, unit, unit_price_cents } = catalogRowFromApp({ id: catalogIdOf(key), name: c.name, category: c.category, unit: c.unit, unitPrice: c.unitPrice });
    return { id, organization_id: org, name, category, unit, unit_price_cents };
  });
  const supplyItemRows = usedItems
    .map((it) => ({ ...itemRowFromApp({ id: itemId(it.key), clientId: md.assigned[it.building].id, catalogItemId: catalogIdOf(it.catalog), createdAt: hrsAgo(90 * 24) }), organization_id: org }));
  const deliveredMs = managerDayDeliveredMs(day);
  const supplyTimes = managerDaySupplyTimes(day);
  const budgetClientIds = [];
  const supplyRequestRows = usedRequests.map((r) => {
    const client = md.assigned[r.building];
    // Each line frozen from the catalog: a Lakeside line names its switch; a Palmetto line names only
    // the catalog item (the sandbox's Palmetto has no switch rows of the seed's).
    const lines = r.lines.map((l) => {
      const key = l.item ? catalogKeyOfItem(l.item) : l.catalog;
      const c = demoSupplyCatalogItem(key);
      return { itemId: l.item ? itemId(l.item) : null, catalogItemId: catalogIdOf(key), sku: null, name: c.name, qty: l.qty, unitPrice: c.unitPrice };
    });
    const base = { id: `${MD_SUPPLY_REQUEST_PREFIX}${r.key}`, clientId: client.id, requestedByUserId: md.primary.id, status: r.status, note: r.note, lines };
    if (r.deliveredInMonth) budgetClientIds.push(client.id);
    // The delivery step (2026-10-12; per line since S131): the order with the supplier and the one
    // delivered today, at the demo's own times (managerDaySupplyTimes), ordered and delivered by the
    // owner slot, each with its per-line record from the ONE rule the demo uses
    // (managerDaySupplyFulfillment). No sent quantities, and no order number: the table's sequence
    // numbers each row. ⚠️ These rows carry the per-line columns: seed only after migration
    // 20261014120000 is applied (and 20261012100000 before it).
    const officeUser = md.userFor(MANAGER_DAY_SLOTS.owner) || null;
    const office = officeUser?.id ?? null;
    const by = { id: office, name: officeUser?.name || null };
    let app;
    if (r.status === 'sent') {
      const t = supplyTimes.sent;
      app = { ...base, createdAt: iso(t.createdMs), approvedAt: iso(t.approvedMs), approvedByUserId: md.primary.id, sentAt: iso(t.sentMs), sentByUserId: office,
        fulfillment: managerDaySupplyFulfillment(r, lines, { at: t.sentMs, by, etaKey: addDaysKey(day.dayKey, r.etaDays || 3) }) };
    } else if (r.status === 'completed' && r.deliveredToday) {
      const t = supplyTimes.delivered;
      app = { ...base, createdAt: iso(t.createdMs), approvedAt: iso(t.approvedMs), approvedByUserId: md.primary.id, sentAt: iso(t.sentMs), sentByUserId: office,
        fulfillment: managerDaySupplyFulfillment(r, lines, { at: t.completedMs, by }), completedAt: iso(t.completedMs), completedByUserId: office };
    } else if (r.status === 'completed') {
      app = { ...base, createdAt: iso(deliveredMs - 30 * HOUR), approvedAt: iso(deliveredMs - 26 * HOUR), approvedByUserId: md.primary.id,
        sentAt: iso(deliveredMs - 20 * HOUR), sentByUserId: office,
        fulfillment: managerDaySupplyFulfillment(r, lines, { at: deliveredMs, by }), completedAt: iso(deliveredMs), completedByUserId: office };
    } else {
      app = { ...base, createdAt: hrsAgo(r.createdHrs), approvedAt: r.approvedHrs != null ? hrsAgo(r.approvedHrs) : null, approvedByUserId: r.approvedHrs != null ? md.primary.id : null };
    }
    return { ...requestRowFromBlob(app, { nameOf }), organization_id: org };
  });

  const timeOff = day.timeOff.filter((t) => t.userId).map((t) => ({ ...t, id: MD_CALLOUT_ID }));
  return {
    jobRows, teRows, templateRows, versionRows, checkRows, probRows, msgRows, cmsgRows, threadRows,
    supplyCatalogRows, supplyItemRows, supplyRequestRows, picks, budgetClientIds, timeOff, dropped,
  };
}

// The summary row the server keeps per building thread (api/_lib/clientHub/messages touchThread):
// the newest line, and the newest line from each side.
export function threadSummaries({ org, nowIso, messages = [] }) {
  const by = new Map();
  for (const m of [...messages].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))) {
    const prev = by.get(m.client_id) || { organization_id: org, client_id: m.client_id, last_client_message_at: null, last_staff_message_at: null };
    const side = m.author_role === ROLE.client ? 'last_client_message_at' : 'last_staff_message_at';
    by.set(m.client_id, {
      ...prev,
      last_message_id: m.id, last_message_at: m.created_at, last_author_role: m.author_role,
      last_author_name: m.author_name ?? null, last_author_user_id: m.author_user_id ?? null,
      last_author_client_user_id: m.author_client_user_id ?? null,
      last_snippet: messageSnippet(m.body, HUB_THREAD_SNIPPET_MAX),
      [side]: m.created_at,
      updated_at: nowIso,
    });
  }
  return [...by.values()];
}

// ── 4. the shared record's part ──────────────────────────────────────────────────────────────
// Applied to the CURRENT blob at write time (the write is CAS'd). Only seed customers change: the
// supervisor (only while still unmanaged), a cleaner's checklist at a building they visit (only
// where they have none — the office's own pick stays), a supply budget where the plan puts the
// building over one and it has none. → { clients, changes: [{ clientId, name, field, from, to }] }
export function blobClientChanges(clients = [], { assignments = [], picks = {}, budgetClientIds = [], budget = MD_BUDGET } = {}) {
  const assign = new Map(assignments.map((a) => [a.clientId, a.to]));
  const budgets = new Set(budgetClientIds);
  const changes = [];
  const next = clients.map((c) => {
    if (!isSeedClient(c)) return c;
    let out = c;
    if (assign.has(c.id) && !c.supervisorId) {
      out = { ...out, supervisorId: assign.get(c.id) };
      changes.push({ clientId: c.id, name: c.name, field: 'supervisorId', from: null, to: assign.get(c.id) });
    }
    const add = Object.entries(picks[c.id] || {}).filter(([uid]) => !(c.crewChecklists || {})[uid]);
    if (add.length) {
      out = { ...out, crewChecklists: { ...(c.crewChecklists || {}), ...Object.fromEntries(add) } };
      changes.push({ clientId: c.id, name: c.name, field: 'crewChecklists', from: Object.keys(c.crewChecklists || {}).length, to: Object.keys(out.crewChecklists).length });
    }
    if (budgets.has(c.id) && !(Number(c.supplyBudgetMonthly) > 0)) {
      out = { ...out, supplyBudgetMonthly: budget };
      changes.push({ clientId: c.id, name: c.name, field: 'supplyBudgetMonthly', from: null, to: budget });
    }
    return out;
  });
  return { clients: next, changes };
}
