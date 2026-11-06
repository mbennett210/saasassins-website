// Service-role data layer for HR INCIDENT REPORTS (task #258 from Clean Corner's queue,
// 2026-10-27: Matt's "ACCIDENT / INCIDENT REPORT", in HR, set up like warnings).
//
// One table, `hr_incidents` (migration 20261027120000_hr_incidents.sql explains why it is not in
// org_state). Nothing but this module touches it, and only app/api/hr-incidents/* calls it.
//
// 🔴 THE RULES THIS MODULE KEEPS, SO NO CALLER HAS TO REMEMBER THEM
//  1. LOCKED ONCE FILED. There is no edit path and no delete path. A report changes only by
//     the three guarded moves below — Mark reviewed, void, files added — and each is a
//     CONDITIONAL update, so two people reviewing at once cannot both win (the loser gets a 409
//     naming what happened), and two people adding files at once cannot lose one (the files
//     write names the version it read). The table's own trigger refuses the rest.
//  2. NAMES ARE STAMPED AT WRITE from the committed roster and customers, so a departed
//     employee's report still reads with their name, and a renamed building keeps the name it
//     had when the report was filed.
//  3. DATES: `reported_on`, `signed_on` and `received_on` are the org's DAY KEYS; the caller
//     supplies `today` in the org zone — this module never asks a clock for a day.
//  4. READS ARE COMPLETE (selectAll: count-first, ordered, paged), and the list NEVER selects the
//     signature; only the one-report read carries it.
//  5. A FILE BELONGS TO ITS REPORT: a file's storage path must sit under the report's own
//     folder in the hr-files bucket (`<org>/hr/incident-<id>/`), so a caller cannot attach
//     another person's document by naming its path.
//
// `db` is the LAST argument everywhere and defaults to the real client, so the offline suite
// injects a PostgREST stand-in.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { selectAll } from '../pagedSelect.js';
import { ownerPrefix } from '../hrFiles/store.js';
import { english } from '../../../src/i18n/core.js';
import { SUPERVISOR_ROLES } from '../../../src/lib/roles.js';
import {
  INCIDENT_STATUS, INCIDENT_TEXT_MAX, INCIDENT_REFUSAL_KEYS, PERSON_KIND,
  incidentDraftRefusal, incidentAnswers, filesRefusal, filesNotOn, normalizeFile, normalizePeople,
  incidentFileOwner, isDayKey, isIncidentId, isIncidentProperty,
} from '../../../src/lib/hrIncidents.js';

const T = 'hr_incidents';

export { isIncidentId };

// A caller-visible refusal: the route turns it into a 4xx with this message (English — API
// bodies stay English, LANG-8) and the code the screen words in the reader's language.
export class IncidentRefusal extends Error {
  constructor(code, { status = 400, message } = {}) {
    super(message || (INCIDENT_REFUSAL_KEYS[code] ? english(INCIDENT_REFUSAL_KEYS[code]) : code));
    this.name = 'IncidentRefusal';
    this.code = code;
    this.status = status;
  }
}

const throwIf = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };
const text = (v, max) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const rid = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i += 1) s += a[Math.floor(Math.random() * a.length)];
  return `irf_${s}`;
};

// Every column but the signature — what the list reads.
export const LIST_COLUMNS = [
  'id', 'number', 'reported_on', 'reported_by_user_id', 'reported_by_name', 'reporter_title',
  'incident_date', 'incident_time', 'client_id', 'property_name', 'exact_location', 'city_state',
  'types', 'type_other', 'what_happened', 'people', 'involved_user_ids', 'injured',
  'injury_description', 'treatment', 'treatment_provider', 'witnesses', 'witness_names',
  'witness_contact', 'police', 'police_details', 'notified', 'notified_other', 'actions_taken',
  'files', 'submitted_by_user_id', 'submitted_by_name', 'signed_on', 'submitter_contact',
  'filed_at', 'filed_by_user_id', 'status', 'reviewed_by_user_id', 'reviewed_by_name',
  'received_on', 'reviewed_at', 'voided_at', 'voided_by_user_id', 'voided_by_name', 'void_reason',
  'version', 'created_at', 'updated_at',
].join(', ');

const list = (v) => (Array.isArray(v) ? v : []);

// row → the camelCase shape every screen reads (the demo stub writes the same shape).
export function toIncident(r) {
  if (!r) return null;
  const number = Number(r.number);
  const out = {
    id: r.id,
    number: Number.isInteger(number) && number > 0 ? number : null,
    // 01
    reportedOn: r.reported_on,
    reportedByUserId: r.reported_by_user_id || null,
    reportedByName: r.reported_by_name || null,
    reporterTitle: r.reporter_title || null,
    // 02
    incidentDate: r.incident_date,
    incidentTime: r.incident_time || null,
    clientId: r.client_id || null,
    propertyName: r.property_name || null,
    exactLocation: r.exact_location || null,
    cityState: r.city_state || null,
    types: list(r.types),
    typeOther: r.type_other || null,
    whatHappened: r.what_happened,
    // 03
    people: normalizePeople(r.people),
    involvedUserIds: list(r.involved_user_ids),
    injured: r.injured,
    injuryDescription: r.injury_description || null,
    treatment: r.treatment || null,
    treatmentProvider: r.treatment_provider || null,
    // 04
    witnesses: r.witnesses,
    witnessNames: r.witness_names || null,
    witnessContact: r.witness_contact || null,
    police: r.police,
    policeDetails: r.police_details || null,
    notified: list(r.notified),
    notifiedOther: r.notified_other || null,
    // 05
    actionsTaken: r.actions_taken || null,
    files: list(r.files),
    // 06
    submittedByUserId: r.submitted_by_user_id,
    submittedByName: r.submitted_by_name || null,
    signedOn: r.signed_on,
    submitterContact: r.submitter_contact || null,
    filedAt: r.filed_at,
    filedByUserId: r.filed_by_user_id || null,
    // status + 07
    status: r.status,
    reviewedByUserId: r.reviewed_by_user_id || null,
    reviewedByName: r.reviewed_by_name || null,
    receivedOn: r.received_on || null,
    reviewedAt: r.reviewed_at || null,
    voidedAt: r.voided_at || null,
    voidedByUserId: r.voided_by_user_id || null,
    voidedByName: r.voided_by_name || null,
    voidReason: r.void_reason || null,
    version: Number(r.version) || 1,
  };
  // Only the one-report read selects it, so only it carries it.
  if (Object.prototype.hasOwnProperty.call(r, 'submitter_signature')) out.submitterSignature = r.submitter_signature || null;
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────────

// Every report (or the ones naming one employee), newest first, COMPLETE, without the signature.
export async function listIncidents({ employeeUserId = null } = {}, db = getSupabase()) {
  const scope = (q) => {
    let x = q.eq('organization_id', CLEANSPACE_ORG_ID);
    if (employeeUserId) x = x.contains('involved_user_ids', [employeeUserId]);
    return x;
  };
  const rows = await selectAll({
    count: async () => {
      const { count, error } = await scope(db.from(T).select('id', { count: 'exact', head: true }));
      throwIf(error, 'count hr_incidents');
      return count;
    },
    page: async (from, to) => {
      const { data, error } = await scope(db.from(T).select(LIST_COLUMNS))
        .order('filed_at', { ascending: false }).order('id').range(from, to);
      throwIf(error, 'read hr_incidents');
      return data || [];
    },
  });
  return rows.map(toIncident);
}

async function readOne(id, columns, db) {
  if (!isIncidentId(id)) return null;
  const { data, error } = await db.from(T).select(columns)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  throwIf(error, 'read hr_incident');
  return data || null;
}

// One report, WITH its signature.
export async function getIncident(id, db = getSupabase()) {
  return toIncident(await readOne(id, '*', db));
}

// What adding a file needs to know (and the hr-files route, before it hands out an upload or
// removes one): the status, the files and the version — never the signature.
export async function incidentFileState(id, db = getSupabase()) {
  const r = await readOne(id, 'id, status, files, version', db);
  return r ? { id: r.id, status: r.status, files: list(r.files), version: Number(r.version) || 1 } : null;
}

// ── who a name belongs to ───────────────────────────────────────────────────
const findById = (rows, id) => (Array.isArray(rows) ? rows : []).find((u) => u && u.id === id) || null;
const isActive = (u) => !!u && (u.status === 'active' || u.status === undefined || u.status === null);
export const activeOfficeMember = (roster, id) => {
  const u = findById(roster, id);
  return u && isActive(u) && SUPERVISOR_ROLES.includes(u.role) ? u : null;
};

// A file's metadata as it goes on the report, or a refusal: its storage path (connected) must sit
// under THIS report's folder; the demo carries no path, only the stub's file id.
function fileForReport(f, incidentId, { now, actor, requirePath }) {
  const kept = normalizeFile(f);
  if (!kept) throw new IncidentRefusal('file-bad');
  if (requirePath || kept.storagePath) {
    const prefix = ownerPrefix(incidentFileOwner(incidentId));
    if (!kept.storagePath || !kept.storagePath.startsWith(prefix) || kept.storagePath.includes('..')) {
      throw new IncidentRefusal('file-bad', { message: 'That file does not belong to this report.' });
    }
  }
  return { id: rid(), ...kept, addedAt: new Date(now).toISOString(), addedByUserId: actor || null };
}

// ── file a report ───────────────────────────────────────────────────────────
// The id is CALLER-MINTED, so a retried filing inserts nothing the second time and the caller
// gets the report it already made (created: false) rather than a second one on file.
//
// `roster` is the committed `state.users` (for the names, and to prove each person picked is a
// real team member), `clients` the committed customers (the property's name). The questions are
// Matt's own form; `requirePath` is true on the real server (a file must carry its bucket path).
export async function createIncident(body, { actor, roster, clients, today, now = Date.now(), requirePath = true }, db = getSupabase()) {
  const b = body || {};
  if (!isIncidentId(b.id)) throw new IncidentRefusal('bad-id', { message: 'A report needs a caller-minted id.' });
  const existing = await getIncident(b.id, db);
  if (existing) return { incident: existing, created: false };

  const code = incidentDraftRefusal(b, today);
  if (code) throw new IncidentRefusal(code);
  if (!isDayKey(today)) throw new Error('createIncident needs the org day (today)');

  // 01 — a team member (any tier, active or not: a report can name someone just set inactive),
  // or a typed name for someone not on the team.
  let reporter = null;
  if (typeof b.reportedByUserId === 'string' && b.reportedByUserId) {
    reporter = findById(roster, b.reportedByUserId);
    if (!reporter) throw new IncidentRefusal('reporter-missing', { message: 'That person is not on the team.' });
  }
  const reportedByName = reporter ? (reporter.name || null) : text(b.reportedByName, INCIDENT_TEXT_MAX.reportedByName);
  if (!reportedByName) throw new IncidentRefusal('reported-by-missing');

  // 02 — a customer from the shared record (one the form offers: never a supplier, never an
  // archived customer), or a typed place.
  let client = null;
  if (typeof b.clientId === 'string' && b.clientId) {
    client = findById(clients, b.clientId);
    if (!isIncidentProperty(client)) throw new IncidentRefusal('property-missing', { message: 'That customer is not on file.' });
  }
  const propertyName = client ? (client.name || text(b.propertyName, INCIDENT_TEXT_MAX.propertyName)) : text(b.propertyName, INCIDENT_TEXT_MAX.propertyName);
  if (!propertyName) throw new IncidentRefusal('property-missing');

  // 03 — every employee named is on the team; their names are stamped from the roster.
  const answers = incidentAnswers(b);
  const people = answers.people.map((p) => {
    if (p.kind !== PERSON_KIND.employee) return p;
    const u = findById(roster, p.userId);
    if (!u) throw new IncidentRefusal('person-bad', { message: 'A person named as an employee is not on the team.' });
    return { ...p, name: u.name || p.name || null };
  });

  // 06 — the submitter is an ACTIVE office member (the people the form offers).
  const submitter = activeOfficeMember(roster, b.submittedByUserId);
  if (!submitter) throw new IncidentRefusal('submitter-missing', { message: 'The person submitting must be an active manager on the team.' });

  const files = Array.isArray(b.files) ? b.files.map((f) => fileForReport(f, b.id, { now, actor, requirePath })) : [];

  const at = new Date(now).toISOString();
  const row = {
    id: b.id,
    organization_id: CLEANSPACE_ORG_ID,
    reported_on: today,
    reported_by_user_id: reporter ? reporter.id : null,
    reported_by_name: reportedByName,
    reporter_title: answers.reporterTitle,
    incident_date: answers.incidentDate,
    incident_time: answers.incidentTime,
    client_id: client ? client.id : null,
    property_name: propertyName,
    exact_location: answers.exactLocation,
    city_state: answers.cityState,
    types: answers.types,
    type_other: answers.typeOther,
    what_happened: answers.whatHappened,
    people,
    involved_user_ids: answers.involvedUserIds,
    injured: answers.injured,
    injury_description: answers.injuryDescription,
    treatment: answers.treatment,
    treatment_provider: answers.treatmentProvider,
    witnesses: answers.witnesses,
    witness_names: answers.witnessNames,
    witness_contact: answers.witnessContact,
    police: answers.police,
    police_details: answers.policeDetails,
    notified: answers.notified,
    notified_other: answers.notifiedOther,
    actions_taken: answers.actionsTaken,
    files,
    submitted_by_user_id: submitter.id,
    submitted_by_name: submitter.name || null,
    submitter_signature: b.signature,
    signed_on: today,
    submitter_contact: answers.submitterContact,
    filed_at: at,
    filed_by_user_id: actor || null,
    status: INCIDENT_STATUS.awaiting,
    reviewed_by_user_id: null,
    reviewed_by_name: null,
    received_on: null,
    reviewed_at: null,
    voided_at: null,
    voided_by_user_id: null,
    voided_by_name: null,
    void_reason: null,
    version: 1,
    created_at: at,
    updated_at: at,
  };
  const { error } = await db.from(T).insert(row);
  throwIf(error, 'file hr_incident');
  return { incident: await getIncident(b.id, db), created: true };
}

// A conditional update: only a row still in `fromStatuses` (and, when given, at `version`) moves.
// When nothing moved, the caller is told WHY rather than a silent no-op.
async function guardedUpdate(id, fromStatuses, patch, db, { version = null, columns = '*' } = {}) {
  let q = db.from(T).update(patch)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).in('status', fromStatuses);
  if (version !== null) q = q.eq('version', version);
  const { data, error } = await q.select(columns).maybeSingle();
  throwIf(error, 'save hr_incident');
  if (data) return toIncident(data);
  const now = await getIncident(id, db);
  if (!now) throw new IncidentRefusal('not-found', { status: 404, message: 'That report does not exist.' });
  if (version !== null && fromStatuses.includes(now.status)) return null;   // the version moved: the caller retries
  throw new IncidentRefusal('already-closed', {
    status: 409,
    message: now.status === INCIDENT_STATUS.voided ? 'That report was voided.' : 'That report was already marked reviewed.',
  });
}

// ── section 07: Mark reviewed, once ─────────────────────────────────────────
// `reviewer` is the roster row of the office member PICKED as having received / reviewed it (the
// team shares one login, so it is never the login); the route has proved they are active office.
export async function reviewIncident(id, { reviewer, today, now = Date.now() }, db = getSupabase()) {
  if (!reviewer || !reviewer.id) throw new IncidentRefusal('reviewer-missing');
  if (!isDayKey(today)) throw new Error('reviewIncident needs the org day (today)');
  return guardedUpdate(id, [INCIDENT_STATUS.awaiting], {
    status: INCIDENT_STATUS.reviewed,
    reviewed_by_user_id: reviewer.id,
    reviewed_by_name: reviewer.name || null,
    received_on: today,
    reviewed_at: new Date(now).toISOString(),
  }, db);
}

// ── files added later: only ever more ──────────────────────────────────────
// Appended to the list as it was read, written only if nobody else changed the report in between
// (its version); on a clash it reads again and tries again, so two people adding files at once
// both land. A voided report takes no more. A file already on the report is skipped, so a retry
// whose first try landed attaches nothing twice. Reads and answers without the signature.
export async function addIncidentFiles(id, { files, actor, now = Date.now(), requirePath = true, tries = 4 }, db = getSupabase()) {
  if (!Array.isArray(files) || files.length === 0) throw new IncidentRefusal('files-missing');
  for (let i = 0; i < tries; i += 1) {
    const cur = await incidentFileState(id, db);
    if (!cur) throw new IncidentRefusal('not-found', { status: 404, message: 'That report does not exist.' });
    if (cur.status === INCIDENT_STATUS.voided) throw new IncidentRefusal('already-closed', { status: 409, message: 'That report was voided.' });
    const fresh = filesNotOn(files, cur.files);
    if (fresh.length === 0) return toIncident(await readOne(id, LIST_COLUMNS, db));
    const code = filesRefusal(fresh, cur.files.length);
    if (code) throw new IncidentRefusal(code);
    const added = fresh.map((f) => fileForReport(f, id, { now, actor, requirePath }));
    const next = await guardedUpdate(id, [INCIDENT_STATUS.awaiting, INCIDENT_STATUS.reviewed], {
      files: [...cur.files, ...added],
      version: cur.version + 1,
    }, db, { version: cur.version, columns: LIST_COLUMNS });
    if (next) return next;
  }
  throw new IncidentRefusal('busy', { status: 409, message: 'The report changed while the files were being added. Try again.' });
}

// ── a mistake: voided by the Super Admin, kept on file ─────────────────────
export async function voidIncident(id, { reason, voidedBy, now = Date.now() }, db = getSupabase()) {
  const why = text(reason, INCIDENT_TEXT_MAX.voidReason);
  if (!why) throw new IncidentRefusal('void-reason-missing');
  return guardedUpdate(id, [INCIDENT_STATUS.awaiting, INCIDENT_STATUS.reviewed], {
    status: INCIDENT_STATUS.voided,
    voided_at: new Date(now).toISOString(),
    voided_by_user_id: (voidedBy && voidedBy.id) || null,
    voided_by_name: (voidedBy && voidedBy.name) || null,
    void_reason: why,
  }, db);
}
