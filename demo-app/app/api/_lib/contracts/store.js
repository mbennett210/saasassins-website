// Service-role data layer for CONTRACT TRACKING (CS-194, Matt's CON-1..CON-14).
//
// The five tables (`contracts`, `contract_buildings`, `contract_years`, `contract_lines`,
// `contract_reminders`) carry hundreds of growing records, so they live OUTSIDE `org_state`
// — migration 20261003130000_contracts.sql explains why. Nothing but this module touches
// them, and only app/api/contracts/* and the ops-alert cron call this module.
//
// 🔴 THREE RULES THIS MODULE KEEPS, SO NO CALLER HAS TO REMEMBER THEM
//  1. MONEY IS INTEGER CENTS, and a null money field means HIDDEN, never free. `project()`
//     strips every price for a caller without `invoices.view` (CS-019) and `applyMoney()`
//     IGNORES money a caller without it tried to write — so reading a stripped contract and
//     pressing Save can never blank a price. That pair is the whole defect this guards.
//  2. DATES ARE CALENDAR DAYS. `date` columns in, 'YYYY-MM-DD' strings out, compared with
//     `<=`. The caller supplies `today` in the ORG's zone; this module never asks a clock
//     (the cron runs TZ=UTC — THE LAW II.8).
//  3. READS ARE COMPLETE. Every list goes through `selectAll` (count-first, ordered, paged),
//     because PostgREST caps a response at db-max-rows and a book of 750 contracts with
//     their year rows is past that — a silently truncated book total is a wrong number
//     nobody would question (playbook II.7).
//
// `db` is the LAST argument everywhere and defaults to the real client, so the offline suite
// injects a PostgREST stand-in and drives every path with no Supabase.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment } from '../storagePaths.js';
import { selectAll } from '../pagedSelect.js';
import {
  CONTRACT_STATUS, CONTRACT_STATUSES, TERM_TYPE, TERM_TYPES,
  REMINDER_STATUS, REMINDER_STATUSES,
  contractReminderPlan, normalizeYearRows, buildingConflicts,
  toCents, toCount, isDayKey, MAX_CONTRACT_YEARS,
} from '../../../src/lib/contracts.js';

const T_CONTRACTS = 'contracts';
const T_BUILDINGS = 'contract_buildings';
const T_YEARS = 'contract_years';
const T_LINES = 'contract_lines';
const T_REMINDERS = 'contract_reminders';

export const BUCKET = 'contract-documents';
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — a scanned multi-page agreement
const EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// A caller-visible refusal: the route turns it into a 400/409 with this message, never a
// raw Postgres error (which would leak the schema and read as a 500 to the office).
export class ContractRefusal extends Error {
  constructor(message, { status = 400, code = 'contract_refused', clientIds } = {}) {
    super(message);
    this.name = 'ContractRefusal';
    this.status = status;
    this.code = code;
    if (clientIds) this.clientIds = clientIds;
  }
}

const throwIf = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isContractId = (v) => typeof v === 'string' && UUID_RE.test(v);
const text = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));

// ── row <-> object ──────────────────────────────────────────────────────────

function toContract(row, { buildings = [], years = [], lines = [], reminders = [] } = {}) {
  return {
    id: row.id,
    name: row.name || null,
    status: row.status,
    isMaster: !!row.is_master,
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    termType: row.term_type,
    termMonths: row.term_months ?? null,
    renewalTermMonths: row.renewal_term_months ?? null,
    cancellationNoticeDays: row.cancellation_notice_days ?? null,
    serviceFrequency: row.service_frequency || null,
    squareFootage: row.square_footage ?? null,
    specialTerms: row.special_terms || null,
    baseMonthlyCents: row.base_monthly_cents ?? 0,
    document: row.document_path
      ? { name: row.document_name || 'Signed contract', size: row.document_size ?? null, storagePath: row.document_path }
      : null,
    notes: row.notes || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    createdByUserId: row.created_by_user_id || null,
    clientIds: buildings.map((b) => b.client_id),
    years: years
      .slice()
      .sort((a, b) => a.year_number - b.year_number)
      .map((y) => ({ id: y.id, yearNumber: y.year_number, startsOn: y.starts_on, monthlyCents: y.monthly_cents })),
    lines: lines
      .slice()
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id)))
      .map((l) => ({ id: l.id, description: l.description, monthlyCents: l.monthly_cents, sortOrder: l.sort_order })),
    reminders: reminders
      .slice()
      .sort((a, b) => String(a.next_due_on).localeCompare(String(b.next_due_on)))
      .map(toReminder),
  };
}

export const toReminder = (r) => ({
  id: r.id,
  contractId: r.contract_id,
  kind: r.kind,
  targetDate: r.target_date,
  dueOn: r.due_on,
  nextDueOn: r.next_due_on,
  status: r.status,
  note: r.note || null,
  notifiedAt: r.notified_at || null,
  doneAt: r.done_at || null,
  doneByUserId: r.done_by_user_id || null,
});

// 🔴 CS-019: a contract's prices and its value are REVENUE. A caller without `invoices.view`
// gets the SAME contract with every money field NULL — not zero, not absent, so every reader
// can tell "hidden" from "free" and the screens say so. `moneyVisible` rides along, because a
// screen must not infer the difference from a null (a genuinely unpriced draft is also null).
export function project(contract, { money }) {
  if (money) return { ...contract, moneyVisible: true };
  return {
    ...contract,
    moneyVisible: false,
    baseMonthlyCents: null,
    years: contract.years.map((y) => ({ ...y, monthlyCents: null })),
    lines: contract.lines.map((l) => ({ ...l, monthlyCents: null })),
  };
}

// ── validation ──────────────────────────────────────────────────────────────

// Everything the route will accept from a body, coerced and bounded. Returns the DB column
// patch; throws a ContractRefusal on anything the vocabulary does not cover.
//
// `money` decides whether the price fields are read AT ALL: a caller without `invoices.view`
// is not refused (they may legitimately fix a date or a building), their money is simply not
// applied. A silent ignore, because refusing would make the dates uneditable for them too.
function fieldPatch(body, { money }) {
  const patch = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('name')) patch.name = text(body.name, 200);
  if (has('isMaster')) patch.is_master = !!body.isMaster;
  if (has('status')) {
    if (!CONTRACT_STATUSES.includes(body.status)) throw new ContractRefusal(`Unknown contract status "${body.status}".`);
    patch.status = body.status;
  }
  if (has('startDate')) {
    if (!isDayKey(body.startDate)) throw new ContractRefusal('A contract needs a start date.');
    patch.start_date = body.startDate;
  }
  if (has('endDate')) {
    if (body.endDate && !isDayKey(body.endDate)) throw new ContractRefusal('The end date is not a date.');
    patch.end_date = body.endDate || null;
  }
  if (has('termType')) {
    if (!TERM_TYPES.includes(body.termType)) throw new ContractRefusal(`Unknown term type "${body.termType}".`);
    patch.term_type = body.termType;
  }
  if (has('termMonths')) patch.term_months = toCount(body.termMonths);
  if (has('renewalTermMonths')) patch.renewal_term_months = toCount(body.renewalTermMonths);
  if (has('cancellationNoticeDays')) {
    const n = body.cancellationNoticeDays;
    patch.cancellation_notice_days = (n === null || n === undefined || n === '') ? null : Math.max(0, Math.floor(Number(n) || 0));
  }
  if (has('serviceFrequency')) patch.service_frequency = text(body.serviceFrequency, 120);
  if (has('squareFootage')) patch.square_footage = toCount(body.squareFootage);
  if (has('specialTerms')) patch.special_terms = text(body.specialTerms, 8000);
  if (has('notes')) patch.notes = text(body.notes, 8000);
  if (money && has('baseMonthlyCents')) patch.base_monthly_cents = toCents(body.baseMonthlyCents) ?? 0;

  // Both halves of the term must make sense together, whoever is saving.
  const start = patch.start_date;
  const end = patch.end_date;
  if (isDayKey(start) && isDayKey(end) && end < start) {
    throw new ContractRefusal('The end date is before the start date.');
  }
  return patch;
}

// The buildings a save asks for: a de-duplicated list of customer ids.
function wantedClientIds(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'clientIds')) return null;   // not being changed
  const ids = Array.isArray(body.clientIds) ? body.clientIds : [];
  const clean = [...new Set(ids.filter((v) => typeof v === 'string' && v && v.length <= 128))];
  if (!clean.length) throw new ContractRefusal('A contract has to cover at least one building.');
  return clean;
}

// CON-3: the extra-service lines. Money is dropped for a caller without invoices.view, so
// their save keeps the descriptions and leaves the prices exactly as stored.
function wantedLines(body, { money }, existing) {
  if (!Object.prototype.hasOwnProperty.call(body, 'lines')) return null;
  const priceById = new Map((existing || []).map((l) => [l.id, l.monthly_cents]));
  return (Array.isArray(body.lines) ? body.lines : [])
    .filter((l) => l && typeof l.description === 'string' && l.description.trim())
    .slice(0, 50)
    .map((l, i) => ({
      description: l.description.trim().slice(0, 200),
      monthly_cents: money ? (toCents(l.monthlyCents) ?? 0) : (priceById.get(l.id) ?? 0),
      sort_order: i,
    }));
}

// ── reads ───────────────────────────────────────────────────────────────────

// Every row of one table for this org, COMPLETE (count-first, ordered, paged). `extra`
// applies the table's own filter to both the count and the page, so they can never diverge.
async function allRows(table, { db, order = 'id', extra = (q) => q, columns = '*' }) {
  return selectAll({
    count: async () => {
      const { count, error } = await extra(db.from(table).select('id', { count: 'exact', head: true })
        .eq('organization_id', CLEANSPACE_ORG_ID));
      throwIf(error, `count ${table}`);
      return count;
    },
    page: async (from, to) => {
      // Deterministic order, then id, before .range() — lint:paging, and without it page
      // membership is the planner's choice and rows skip or repeat across boundaries.
      const { data, error } = await extra(db.from(table).select(columns)
        .eq('organization_id', CLEANSPACE_ORG_ID))
        .order(order).order('id').range(from, to);
      throwIf(error, `read ${table}`);
      return data || [];
    },
  });
}

// The whole book, assembled. ONE contract shape everywhere — the list row carries the SAME
// object the detail read does, with its whole year schedule and its lines.
//
// It would be cheaper to bound the year read to the elapsed rows (the only ones that can be
// the current price), and an earlier draft did: it made the list's `years` a PARTIAL schedule
// that looked exactly like the full one, which is the shape of defect that gets read as data.
// At this build's real scale — 750 buildings, most on three-year terms — the whole schedule
// is a few thousand rows through a paged, count-checked read, and one honest shape is worth
// more than the saving. The DONE reminders are the only thing held back (a list wants what is
// still outstanding), and `openReminders` is named for it.
export async function listContracts(_opts, db = getSupabase()) {
  const [rows, buildings, years, lines, reminders] = await Promise.all([
    allRows(T_CONTRACTS, { db, order: 'created_at' }),
    allRows(T_BUILDINGS, { db, order: 'client_id' }),
    allRows(T_YEARS, { db, order: 'starts_on' }),
    allRows(T_LINES, { db, order: 'sort_order' }),
    allRows(T_REMINDERS, { db, order: 'next_due_on', extra: (q) => q.neq('status', REMINDER_STATUS.done) }),
  ]);
  const by = (list, key) => {
    const m = new Map();
    for (const r of list) {
      const k = r[key];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const bB = by(buildings, 'contract_id');
  const bY = by(years, 'contract_id');
  const bL = by(lines, 'contract_id');
  const bR = by(reminders, 'contract_id');
  return rows.map((r) => toContract(r, {
    buildings: bB.get(r.id) || [], years: bY.get(r.id) || [],
    lines: bL.get(r.id) || [], reminders: bR.get(r.id) || [],
  }));
}

// One contract, with every child row (the full year schedule, not just the elapsed years).
export async function getContract(id, db = getSupabase()) {
  if (!isContractId(id)) return null;
  const { data: row, error } = await db.from(T_CONTRACTS).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  throwIf(error, 'read contract');
  if (!row) return null;
  const kid = async (table) => {
    const { data, error: e } = await db.from(table).select('*').eq('contract_id', id);
    throwIf(e, `read ${table}`);
    return data || [];
  };
  const [buildings, years, lines, reminders] = await Promise.all(
    [T_BUILDINGS, T_YEARS, T_LINES, T_REMINDERS].map(kid),
  );
  return toContract(row, { buildings, years, lines, reminders });
}

// The contracts covering one building (newest first) — the customer page's Contract tab.
export async function contractsForClient(clientId, db = getSupabase()) {
  const { data, error } = await db.from(T_BUILDINGS).select('contract_id')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_id', clientId);
  throwIf(error, 'read contract buildings');
  const ids = [...new Set((data || []).map((r) => r.contract_id))];
  if (!ids.length) return [];
  const full = await Promise.all(ids.map((id) => getContract(id, db)));
  return full.filter(Boolean).sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
}

// The narrow "what is this contract called and which buildings does it cover" read the
// reminder cron makes — and ONLY when a reminder is actually due, so a quiet run pays
// nothing for it. Bounded by the caller's id list (at most CONTRACT_REMINDER_MAX_PER_RUN
// contracts), so no paging is needed.
export async function contractSubjects(contractIds, db = getSupabase()) {
  const ids = [...new Set((Array.isArray(contractIds) ? contractIds : []).filter(isContractId))].slice(0, 200);
  if (!ids.length) return [];
  const [{ data: rows, error: e1 }, { data: buildings, error: e2 }] = await Promise.all([
    db.from(T_CONTRACTS).select('id, name, status').eq('organization_id', CLEANSPACE_ORG_ID).in('id', ids),
    db.from(T_BUILDINGS).select('contract_id, client_id').eq('organization_id', CLEANSPACE_ORG_ID).in('contract_id', ids),
  ]);
  throwIf(e1, 'read contract subjects');
  throwIf(e2, 'read contract subject buildings');
  const byContract = new Map();
  for (const b of buildings || []) {
    if (!byContract.has(b.contract_id)) byContract.set(b.contract_id, []);
    byContract.get(b.contract_id).push(b.client_id);
  }
  return (rows || []).map((r) => ({
    id: r.id, name: r.name || null, status: r.status, clientIds: byContract.get(r.id) || [],
  }));
}

// Every building row with its parent's status — the input to the one-active-per-building
// rule. A narrow projection joined in JS, so the check costs two small reads.
export async function buildingRowsWithStatus(db = getSupabase()) {
  const [buildings, contracts] = await Promise.all([
    allRows(T_BUILDINGS, { db, order: 'client_id', columns: 'id, contract_id, client_id' }),
    allRows(T_CONTRACTS, { db, order: 'created_at', columns: 'id, status' }),
  ]);
  const status = new Map(contracts.map((c) => [c.id, c.status]));
  return buildings.map((b) => ({ contractId: b.contract_id, clientId: b.client_id, status: status.get(b.contract_id) || null }));
}

// ── writes ──────────────────────────────────────────────────────────────────

// Refuse a save that would put a building on a second ACTIVE contract (CON-2 / CON-14). The
// database carries the matching partial unique index; this runs first so the office gets a
// sentence naming the buildings instead of a constraint violation.
async function assertBuildingsFree({ contractId, clientIds, status }, db) {
  if (status !== CONTRACT_STATUS.active || !clientIds || !clientIds.length) return;
  const taken = buildingConflicts({ contractId, clientIds, status }, await buildingRowsWithStatus(db));
  if (taken.length) {
    throw new ContractRefusal(
      `${taken.length === 1 ? 'That building is' : 'Those buildings are'} already on another active contract. End it first, or save this one as a draft.`,
      { status: 409, code: 'building_already_contracted', clientIds: taken },
    );
  }
}

async function replaceBuildings(contractId, clientIds, db) {
  const { data: existing, error } = await db.from(T_BUILDINGS).select('id, client_id').eq('contract_id', contractId);
  throwIf(error, 'read contract buildings');
  const have = new Set((existing || []).map((r) => r.client_id));
  const want = new Set(clientIds);
  const add = clientIds.filter((id) => !have.has(id));
  const drop = (existing || []).filter((r) => !want.has(r.client_id)).map((r) => r.id);
  if (drop.length) throwIf((await db.from(T_BUILDINGS).delete().in('id', drop)).error, 'drop contract buildings');
  if (add.length) {
    // `active` is deliberately NOT sent: the table's trigger derives it from the parent's
    // status, which is what makes the unique index a fact rather than a promise.
    throwIf((await db.from(T_BUILDINGS).insert(add.map((client_id) => ({
      organization_id: CLEANSPACE_ORG_ID, contract_id: contractId, client_id,
    })))).error, 'add contract buildings');
  }
}

// The year schedule is fully re-derived from the term on every save (lib/contracts
// normalizeYearRows keeps the prices the office typed), so delete-then-insert is the honest
// write: there is no partial state to reconcile and no stale row to leave behind.
async function replaceYears(contractId, rows, db) {
  throwIf((await db.from(T_YEARS).delete().eq('contract_id', contractId)).error, 'clear contract years');
  if (!rows.length) return;
  throwIf((await db.from(T_YEARS).insert(rows.slice(0, MAX_CONTRACT_YEARS).map((y) => ({
    organization_id: CLEANSPACE_ORG_ID, contract_id: contractId,
    year_number: y.yearNumber, starts_on: y.startsOn, monthly_cents: y.monthlyCents ?? 0,
  })))).error, 'write contract years');
}

async function replaceLines(contractId, rows, db) {
  throwIf((await db.from(T_LINES).delete().eq('contract_id', contractId)).error, 'clear contract lines');
  if (!rows.length) return;
  throwIf((await db.from(T_LINES).insert(rows.map((l) => ({
    organization_id: CLEANSPACE_ORG_ID, contract_id: contractId, ...l,
  })))).error, 'write contract lines');
}

// 🔴 CON-6..CON-10. Idempotent: the natural key (contract, kind, target date) means
// regenerating a schedule PRESERVES what the office already did to a row — a reminder marked
// done stays done, a snoozed one keeps its date, a note survives. Only FUTURE rows the new
// plan no longer contains are removed; anything whose date has passed is history and is left
// alone, so a renewal somebody handled last year does not vanish from the record.
//
// Exported because the ops-alert cron calls it too: after a reminder fires, the schedule is
// re-anchored on today, which is what tops an auto-renewing contract's chain back up to
// RENEWAL_HORIZON_YEARS without anyone re-saving the contract.
export async function regenerateReminders(contractId, { today }, db = getSupabase()) {
  const contract = await getContract(contractId, db);
  if (!contract) return { added: 0, removed: 0 };
  const plan = contractReminderPlan(contract, { years: contract.years }, today);
  const planKey = (r) => `${r.kind}|${r.targetDate}`;
  const wanted = new Map(plan.map((r) => [planKey(r), r]));

  const { data: existing, error } = await db.from(T_REMINDERS)
    .select('id, kind, target_date, due_on, next_due_on, status, notified_at').eq('contract_id', contractId);
  throwIf(error, 'read contract reminders');

  const have = new Set();
  const stale = [];
  for (const r of existing || []) {
    const key = `${r.kind}|${r.target_date}`;
    if (wanted.has(key)) { have.add(key); continue; }
    // Future and no longer planned -> the contract moved underneath it, so it is wrong.
    // Past -> history; keep it whatever its status.
    if (isDayKey(today) && r.target_date >= today) stale.push(r.id);
  }
  if (stale.length) throwIf((await db.from(T_REMINDERS).delete().in('id', stale)).error, 'drop stale contract reminders');

  const add = plan.filter((r) => !have.has(planKey(r)));
  if (add.length) {
    throwIf((await db.from(T_REMINDERS).insert(add.map((r) => ({
      organization_id: CLEANSPACE_ORG_ID, contract_id: contractId,
      kind: r.kind, target_date: r.targetDate, due_on: r.dueOn, next_due_on: r.dueOn,
      status: REMINDER_STATUS.pending,
    })))).error, 'write contract reminders');
  }
  return { added: add.length, removed: stale.length };
}

// CREATE. The id is CALLER-MINTED, so a retried create inserts nothing the second time
// (`.select()` comes back empty on the conflict) and the caller gets the contract it already
// made rather than a duplicate — the offline-queue idempotency rule applied to a form.
export async function createContract(body, { actor, money, today }, db = getSupabase()) {
  const id = body && body.id;
  if (!isContractId(id)) throw new ContractRefusal('A contract needs a caller-minted id.');
  const existing = await getContract(id, db);
  if (existing) return { contract: existing, created: false };

  const patch = fieldPatch({ status: CONTRACT_STATUS.draft, termType: TERM_TYPE.fixed, ...body }, { money });
  if (!patch.start_date) throw new ContractRefusal('A contract needs a start date.');
  const clientIds = wantedClientIds(body);
  if (!clientIds) throw new ContractRefusal('A contract has to cover at least one building.');
  await assertBuildingsFree({ contractId: id, clientIds, status: patch.status }, db);

  const { error } = await db.from(T_CONTRACTS).insert({
    id, organization_id: CLEANSPACE_ORG_ID, created_by_user_id: actor || null, ...patch,
  });
  throwIf(error, 'create contract');

  await replaceBuildings(id, clientIds, db);
  await writeSchedule(id, body, { money, existingLines: [] }, db);
  await regenerateReminders(id, { today }, db);
  return { contract: await getContract(id, db), created: true };
}

// SAVE. Only the fields the body carries are touched, so a screen that shows half a contract
// cannot blank the other half — and money from a caller without invoices.view is ignored
// rather than applied as zero.
export async function saveContract(id, body, { money, today }, db = getSupabase()) {
  const before = await getContract(id, db);
  if (!before) throw new ContractRefusal('That contract no longer exists.', { status: 404, code: 'not_found' });

  const patch = fieldPatch(body, { money });
  const clientIds = wantedClientIds(body);
  const nextStatus = patch.status || before.status;
  await assertBuildingsFree({ contractId: id, clientIds: clientIds || before.clientIds, status: nextStatus }, db);

  if (Object.keys(patch).length) {
    const { error } = await db.from(T_CONTRACTS).update(patch).eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id);
    throwIf(error, 'save contract');
  }
  if (clientIds) await replaceBuildings(id, clientIds, db);
  await writeSchedule(id, body, { money, existingLines: before.lines.map((l) => ({ id: l.id, monthly_cents: l.monthlyCents })) }, db);
  await regenerateReminders(id, { today }, db);
  return { before, contract: await getContract(id, db) };
}

// The year schedule + the lines, re-derived together because the term decides both how many
// year rows there are and what dates they start on.
async function writeSchedule(id, body, { money, existingLines }, db = getSupabase()) {
  const contract = await getContract(id, db);
  if (!contract) return;
  const typed = Object.prototype.hasOwnProperty.call(body, 'years') && Array.isArray(body.years)
    ? (money ? body.years : contract.years)   // no invoices.view -> keep the stored prices
    : contract.years;
  await replaceYears(id, normalizeYearRows(typed, {
    startDate: contract.startDate, termMonths: contract.termMonths, baseMonthlyCents: contract.baseMonthlyCents,
  }), db);
  const lines = wantedLines(body, { money }, existingLines);
  if (lines) await replaceLines(id, lines, db);
}

// DELETE. Replace means delete (BUILD_INTEGRITY §3): the signed PDF leaves Storage first — a
// deleted contract must not leave its agreement readable by object path — then every child
// row, then the contract. The children are swept EXPLICITLY even though the tables carry ON
// DELETE CASCADE: the cascade is the database's belt, this is the code saying what it means,
// and a sweep that depends on a constraint nobody can see is how an orphan survives a
// migration that drops it.
export async function deleteContract(id, db = getSupabase()) {
  const before = await getContract(id, db);
  if (!before) return { before: null };
  if (before.document && before.document.storagePath) {
    try { await db.storage.from(BUCKET).remove([before.document.storagePath]); }
    catch (e) { console.error('[contracts] could not remove the signed document:', e && e.message); }
  }
  for (const table of [T_REMINDERS, T_LINES, T_YEARS, T_BUILDINGS]) {
    throwIf((await db.from(table).delete().eq('contract_id', id)).error, `delete ${table}`);
  }
  const { error } = await db.from(T_CONTRACTS).delete().eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id);
  throwIf(error, 'delete contract');
  return { before };
}

// ── CON-10: done / snooze / note ────────────────────────────────────────────

export async function updateReminder(id, { status, snoozeUntil, note, actor }, db = getSupabase()) {
  const { data: row, error } = await db.from(T_REMINDERS).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  throwIf(error, 'read contract reminder');
  if (!row) throw new ContractRefusal('That reminder no longer exists.', { status: 404, code: 'not_found' });

  const patch = {};
  if (note !== undefined) patch.note = text(note, 2000);
  if (status !== undefined) {
    if (!REMINDER_STATUSES.includes(status)) throw new ContractRefusal(`Unknown reminder status "${status}".`);
    patch.status = status;
    if (status === REMINDER_STATUS.done) {
      patch.done_at = new Date().toISOString();
      patch.done_by_user_id = actor || null;
    } else {
      patch.done_at = null;
      patch.done_by_user_id = null;
    }
    if (status === REMINDER_STATUS.snoozed) {
      if (!isDayKey(snoozeUntil)) throw new ContractRefusal('A snooze needs a date to come back on.');
      patch.next_due_on = snoozeUntil;
      // Clearing the stamp is what lets a snoozed reminder ring again — the stamp IS the
      // dedup, so a snooze that left it in place would be a silent "never remind me".
      patch.notified_at = null;
    }
    if (status === REMINDER_STATUS.pending) {
      patch.next_due_on = row.due_on;
      patch.notified_at = null;
    }
  }
  if (!Object.keys(patch).length) return toReminder(row);
  const { data, error: e2 } = await db.from(T_REMINDERS).update(patch)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).select('*').maybeSingle();
  throwIf(e2, 'save contract reminder');
  return toReminder(data || { ...row, ...patch });
}

// ── the cron's two calls ────────────────────────────────────────────────────

// Everything due on or before `today` that has not rung yet, soonest first, bounded.
// This is THE cheap early exit: one probe of the partial index, no rows on almost every run.
export async function dueReminders({ today, limit }, db = getSupabase()) {
  if (!isDayKey(today)) return [];
  const { data, error } = await db.from(T_REMINDERS)
    .select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .is('notified_at', null)
    .neq('status', REMINDER_STATUS.done)
    .lte('next_due_on', today)
    .gte('target_date', today)        // a date already past is stale — see reminderIsDue
    .order('next_due_on').order('id')
    .limit(Math.max(1, Math.min(Number(limit) || 25, 200)));
  throwIf(error, 'read due contract reminders');
  return (data || []).map(toReminder);
}

// Stamp the reminders a run actually rang. Called AFTER the bell rows are durably in
// org_state: a crash between the two re-rings a reminder on the next run, which is the right
// way round — a duplicate nudge about a renewal is noise, a missed one is the defect.
export async function markRemindersNotified(ids, { at } = {}, db = getSupabase()) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!list.length) return 0;
  const { data, error } = await db.from(T_REMINDERS)
    .update({ notified_at: at || new Date().toISOString() })
    .eq('organization_id', CLEANSPACE_ORG_ID).in('id', list).is('notified_at', null).select('id');
  throwIf(error, 'stamp contract reminders');
  return (data || []).length;
}

// ── CON-11: the signed PDF ──────────────────────────────────────────────────

export function validateUpload({ mimeType, sizeBytes }) {
  if (!ALLOWED_MIME.includes(mimeType)) return { ok: false, error: 'Unsupported file type (use PDF, PNG, JPG, or WebP)' };
  if (Number.isFinite(sizeBytes) && sizeBytes > MAX_BYTES) return { ok: false, error: 'File is too large (max 20MB)' };
  return { ok: true };
}

// `<org>/<contractId>/` — the contract id is validated as ONE safe segment, so it can never
// walk out of this contract's (or the org's) prefix (storage-path law, _lib/storagePaths.js).
export function contractPrefix(contractId) {
  requireSafeSegment(contractId, 'contract id');
  return `${CLEANSPACE_ORG_ID}/${contractId}/`;
}

// A path that arrives in a body is honoured only if it sits under THIS contract's rebuilt
// prefix, so a caller can never read or delete another contract's agreement.
function assertOwnedPath(contractId, storagePath) {
  const prefix = contractPrefix(contractId);
  if (typeof storagePath !== 'string' || !storagePath.startsWith(prefix) || storagePath.includes('..')) {
    throw new ContractRefusal('That file does not belong to this contract.', { status: 400, code: 'bad_path' });
  }
}

const rid = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; for (let i = 0; i < 16; i += 1) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

export async function signedUploadUrl({ contractId, mimeType }, db = getSupabase()) {
  const path = `${contractPrefix(contractId)}${rid()}.${EXT[mimeType] || 'bin'}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  throwIf(error, 'sign the upload');
  return { path: (data && data.path) || path, token: data && data.token, signedUrl: data && data.signedUrl };
}

export async function signedDownloadUrl({ contractId, storagePath }, db = getSupabase()) {
  assertOwnedPath(contractId, storagePath);
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(storagePath, 600);
  throwIf(error, 'sign the download');
  return { url: (data && data.signedUrl) || null };
}

// Record (or clear) the signed document on the contract. The metadata is written here, after
// the bytes are in the bucket, so a failed upload never leaves a chip naming a file nobody
// has — the defect CS-043 fixed for site attachments.
export async function setDocument(contractId, { name, size, storagePath }, db = getSupabase()) {
  if (storagePath) assertOwnedPath(contractId, storagePath);
  const { error } = await db.from(T_CONTRACTS).update({
    document_name: storagePath ? text(name, 200) : null,
    document_size: storagePath ? (toCount(size) ?? null) : null,
    document_path: storagePath || null,
  }).eq('organization_id', CLEANSPACE_ORG_ID).eq('id', contractId);
  throwIf(error, 'save the contract document');
  return { ok: true };
}

export async function removeDocument({ contractId, storagePath }, db = getSupabase()) {
  assertOwnedPath(contractId, storagePath);
  const { error } = await db.storage.from(BUCKET).remove([storagePath]);
  throwIf(error, 'remove the contract document');
  await setDocument(contractId, { storagePath: null }, db);
  return { ok: true };
}
