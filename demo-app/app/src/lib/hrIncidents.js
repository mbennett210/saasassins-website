// HR INCIDENT REPORTS — the one place the report's QUESTIONS and RULES live (task #258 from
// Clean Corner's queue, 2026-10-27: incident reports in HR, set up like warnings).
//
// Matt, on the Oct 27 call: "So when people get injured in the HR section, the same way that
// you guys created the one for warnings, we should do one for incident report." He then sent
// Clean Space's own form, "ACCIDENT / INCIDENT REPORT" (two pages, seven sections). As with his
// Warning Form (lib/hrWarnings.js), the app asks HIS questions in HIS order and HIS words:
// every line is a catalog key (INCIDENT_FORM_KEYS and the option lists below), and
// scripts/test-hr-incidents.mjs holds them to the form itself
// (scripts/fixtures/hr-incident-form.json, its text pulled out of his PDF).
//
// Daniel's picks (2026-10-27): the office files a report in HR (`hr.edit`); a filed report is
// LOCKED (no edit, no delete — the Super Admin voids a mistake with a reason, and it stays on
// file); section 07 "Office use only / follow-up" is a Mark reviewed step after filing, and the
// case number is given on filing; files may be added at any time and are never removed; a
// report shows on the HR card of each employee involved; no alerts.
//
// The lists, the required fields and their limits are declared HERE and nowhere else: the
// form, the server's validation, the demo stub, the list's filters and the printed form all
// read this module.
//
// PURE + node-safe (explicit .js imports): the browser, the API route and the offline suite
// run the identical rule. It never reads a clock or a zone — `today` comes in.
import { signatureRefusal } from './hrWarnings.js';
import { isArchivedCustomer } from './customerStatus.js';

export { signatureRefusal };

// ── his form, line by line, as catalog keys ─────────────────────────────────
// The section headings and the title are in his capitals; the questions in his words (the
// paper form's blank lines and boxes are the inputs). `{company}` is the brand's name
// (IDENTITY.name), never typed into a line.
export const INCIDENT_FORM_KEYS = Object.freeze({
  title: 'hrInc.form.title',                   // "ACCIDENT / INCIDENT REPORT"
  subtitle: 'hrInc.form.subtitle',             // "{company} | Internal Safety & Operations"
  lead: 'hrInc.form.lead',                     // "Complete as soon as possible, preferably within 24 hours. …"
  page: 'hrInc.form.page',                     // "PAGE {page} OF {pages}"
  footer: 'hrInc.form.footer',                 // "CONFIDENTIAL | For authorized company use"
  s01: 'hrInc.form.s01',                       // "REPORT DETAILS"
  reportedOn: 'hrInc.form.reportedOn',         // "Date report completed"
  reportedBy: 'hrInc.form.reportedBy',         // "Reported by (full name)"
  reporterTitle: 'hrInc.form.reporterTitle',   // "Job title / role"
  s02: 'hrInc.form.s02',                       // "INCIDENT INFORMATION"
  incidentDate: 'hrInc.form.incidentDate',     // "Incident date"
  incidentTime: 'hrInc.form.incidentTime',     // "Time (AM / PM)"
  property: 'hrInc.form.property',             // "Property / client name"
  exactLocation: 'hrInc.form.exactLocation',   // "Exact location (building, room, area)"
  cityState: 'hrInc.form.cityState',           // "City / state"
  types: 'hrInc.form.types',                   // "Type of incident (check all that apply)"
  whatHappened: 'hrInc.form.whatHappened',     // "Describe what happened (facts only: …)"
  s03: 'hrInc.form.s03',                       // "PEOPLE INVOLVED & INJURIES"
  people: 'hrInc.form.people',                 // "Name(s) of person(s) involved"
  personKind: 'hrInc.form.personKind',         // "Employee / visitor / other"
  injured: 'hrInc.form.injured',               // "Was anyone injured?"
  injury: 'hrInc.form.injury',                 // "Describe injury / body part affected (if applicable)"
  treatment: 'hrInc.form.treatment',           // "Medical treatment"
  provider: 'hrInc.form.provider',             // "Treatment provider / facility (if applicable)"
  s04: 'hrInc.form.s04',                       // "WITNESSES & NOTIFICATIONS"
  witnesses: 'hrInc.form.witnesses',           // "Were there witnesses?"
  witnessNames: 'hrInc.form.witnessNames',     // "Witness name(s)"
  witnessContact: 'hrInc.form.witnessContact', // "Contact information"
  police: 'hrInc.form.police',                 // "Police / emergency services contacted?"
  policeDetails: 'hrInc.form.policeDetails',   // "Agency, report number, and responding officer (if applicable)"
  notified: 'hrInc.form.notified',             // "Who was notified? (check all that apply)"
  s05: 'hrInc.form.s05',                       // "IMMEDIATE RESPONSE & DOCUMENTATION"
  actions: 'hrInc.form.actions',               // "Actions taken immediately (first aid, …)"
  docs: 'hrInc.form.docs',                     // "Supporting documentation attached"
  s06: 'hrInc.form.s06',                       // "SUBMITTED BY"
  printedName: 'hrInc.form.printedName',       // "Printed name"
  signature: 'hrInc.form.signature',           // "Signature"
  signedOn: 'hrInc.form.signedOn',             // "Date signed"
  contact: 'hrInc.form.contact',               // "Phone / email"
  s07: 'hrInc.form.s07',                       // "OFFICE USE ONLY / FOLLOW-UP"
  reviewedBy: 'hrInc.form.reviewedBy',         // "Received / reviewed by"
  receivedOn: 'hrInc.form.receivedOn',         // "Date received"
  caseNo: 'hrInc.form.caseNo',                 // "Case / reference no."
});

// His seven section numbers, as printed beside each heading ("01 REPORT DETAILS").
export const INCIDENT_SECTIONS = Object.freeze([
  { n: '01', key: INCIDENT_FORM_KEYS.s01 },
  { n: '02', key: INCIDENT_FORM_KEYS.s02 },
  { n: '03', key: INCIDENT_FORM_KEYS.s03 },
  { n: '04', key: INCIDENT_FORM_KEYS.s04 },
  { n: '05', key: INCIDENT_FORM_KEYS.s05 },
  { n: '06', key: INCIDENT_FORM_KEYS.s06 },
  { n: '07', key: INCIDENT_FORM_KEYS.s07 },
]);

// ── his tick boxes, in the order his form lists them (row by row) ───────────
// Stored as codes; the words are catalog lines (literal keys: a key built at run time cannot be
// found or checked — the i18n card).
export const INCIDENT_TYPE = Object.freeze({
  injury: 'injury',         // Employee injury
  damage: 'damage',         // Property damage
  nearMiss: 'near_miss',    // Near miss
  vehicle: 'vehicle',       // Vehicle / traffic
  medical: 'medical',       // Medical emergency
  security: 'security',     // Security / theft
  slip: 'slip',             // Slip / trip / fall
  other: 'other',           // Other — needs words
});
export const INCIDENT_TYPES = Object.freeze(Object.values(INCIDENT_TYPE));
export const INCIDENT_TYPE_KEYS = Object.freeze({
  injury: 'hrInc.type.injury',
  damage: 'hrInc.type.damage',
  near_miss: 'hrInc.type.nearMiss',
  vehicle: 'hrInc.type.vehicle',
  medical: 'hrInc.type.medical',
  security: 'hrInc.type.security',
  slip: 'hrInc.type.slip',
  other: 'hrInc.type.other',
});

// "Was anyone injured?" and "Were there witnesses?": Yes / No / Unknown. The police question
// has Yes / No only (POLICE_ANSWERS).
export const ANSWER = Object.freeze({ yes: 'yes', no: 'no', unknown: 'unknown' });
export const ANSWERS = Object.freeze([ANSWER.yes, ANSWER.no, ANSWER.unknown]);
export const POLICE_ANSWERS = Object.freeze([ANSWER.yes, ANSWER.no]);
export const ANSWER_KEYS = Object.freeze({
  yes: 'hrInc.answer.yes',
  no: 'hrInc.answer.no',
  unknown: 'hrInc.answer.unknown',
});

export const TREATMENT = Object.freeze({ none: 'none', firstAid: 'first_aid', clinic: 'clinic', refused: 'refused' });
export const TREATMENTS = Object.freeze(Object.values(TREATMENT));
export const TREATMENT_KEYS = Object.freeze({
  none: 'hrInc.treatment.none',
  first_aid: 'hrInc.treatment.firstAid',
  clinic: 'hrInc.treatment.clinic',
  refused: 'hrInc.treatment.refused',
});

// "Employee / visitor / other" — one row per person involved. An employee is a team member
// (picked, so the report reaches their HR card); a visitor or other is a typed name.
export const PERSON_KIND = Object.freeze({ employee: 'employee', visitor: 'visitor', other: 'other' });
export const PERSON_KINDS = Object.freeze(Object.values(PERSON_KIND));
export const PERSON_KIND_KEYS = Object.freeze({
  employee: 'hrInc.person.employee',
  visitor: 'hrInc.person.visitor',
  other: 'hrInc.person.other',
});

export const NOTIFIED = Object.freeze({
  supervisor: 'supervisor', accountManager: 'account_manager', hr: 'hr', client: 'client', other: 'other',
});
export const NOTIFIED_LIST = Object.freeze(Object.values(NOTIFIED));
export const NOTIFIED_KEYS = Object.freeze({
  supervisor: 'hrInc.notified.supervisor',
  account_manager: 'hrInc.notified.accountManager',
  hr: 'hrInc.notified.hr',
  client: 'hrInc.notified.client',
  other: 'hrInc.notified.other',
});

// "Supporting documentation attached": each uploaded file is marked as one of his four kinds,
// and the printed form ticks each kind that has a file.
export const DOC_KIND = Object.freeze({
  photos: 'photos', witnessStatement: 'witness_statement', policeReport: 'police_report', other: 'other',
});
export const DOC_KINDS = Object.freeze(Object.values(DOC_KIND));
export const DOC_KIND_KEYS = Object.freeze({
  photos: 'hrInc.doc.photos',
  witness_statement: 'hrInc.doc.witnessStatement',
  police_report: 'hrInc.doc.policeReport',
  other: 'hrInc.doc.other',
});

// THE FORM IN HIS ORDER: every line of both pages as it reads top to bottom (the header lines
// once — they repeat on page two), each a catalog key. The fixture test walks this list
// against the lines of his PDF.
export const INCIDENT_FORM_ORDER = Object.freeze([
  INCIDENT_FORM_KEYS.title, INCIDENT_FORM_KEYS.subtitle, INCIDENT_FORM_KEYS.lead, INCIDENT_FORM_KEYS.page,
  INCIDENT_FORM_KEYS.s01, INCIDENT_FORM_KEYS.reportedOn, INCIDENT_FORM_KEYS.reportedBy, INCIDENT_FORM_KEYS.reporterTitle,
  INCIDENT_FORM_KEYS.s02, INCIDENT_FORM_KEYS.incidentDate, INCIDENT_FORM_KEYS.incidentTime, INCIDENT_FORM_KEYS.property,
  INCIDENT_FORM_KEYS.exactLocation, INCIDENT_FORM_KEYS.cityState, INCIDENT_FORM_KEYS.types,
  ...INCIDENT_TYPES.map((x) => INCIDENT_TYPE_KEYS[x]),
  INCIDENT_FORM_KEYS.whatHappened,
  INCIDENT_FORM_KEYS.s03, INCIDENT_FORM_KEYS.people, INCIDENT_FORM_KEYS.personKind,
  INCIDENT_FORM_KEYS.injured, ...ANSWERS.map((x) => ANSWER_KEYS[x]),
  INCIDENT_FORM_KEYS.injury, INCIDENT_FORM_KEYS.treatment, ...TREATMENTS.map((x) => TREATMENT_KEYS[x]),
  INCIDENT_FORM_KEYS.provider,
  INCIDENT_FORM_KEYS.footer,
  INCIDENT_FORM_KEYS.s04, INCIDENT_FORM_KEYS.witnesses, ...ANSWERS.map((x) => ANSWER_KEYS[x]),
  INCIDENT_FORM_KEYS.witnessNames, INCIDENT_FORM_KEYS.witnessContact,
  INCIDENT_FORM_KEYS.police, ...POLICE_ANSWERS.map((x) => ANSWER_KEYS[x]),
  INCIDENT_FORM_KEYS.policeDetails, INCIDENT_FORM_KEYS.notified, ...NOTIFIED_LIST.map((x) => NOTIFIED_KEYS[x]),
  INCIDENT_FORM_KEYS.s05, INCIDENT_FORM_KEYS.actions, INCIDENT_FORM_KEYS.docs, ...DOC_KINDS.map((x) => DOC_KIND_KEYS[x]),
  INCIDENT_FORM_KEYS.s06, INCIDENT_FORM_KEYS.printedName, INCIDENT_FORM_KEYS.signature,
  INCIDENT_FORM_KEYS.signedOn, INCIDENT_FORM_KEYS.contact,
  INCIDENT_FORM_KEYS.s07, INCIDENT_FORM_KEYS.reviewedBy, INCIDENT_FORM_KEYS.receivedOn, INCIDENT_FORM_KEYS.caseNo,
]);

// ── statuses (locked once filed; a mistake is VOIDED, never edited or deleted) ──
export const INCIDENT_STATUS = Object.freeze({
  awaiting: 'awaiting',   // filed, waiting for section 07's review
  reviewed: 'reviewed',   // Mark reviewed: who received / reviewed it, and the day
  voided: 'voided',       // a mistake, voided by the Super Admin — stays on file
});
export const INCIDENT_STATUSES = Object.freeze(Object.values(INCIDENT_STATUS));
export const INCIDENT_STATUS_KEYS = Object.freeze({
  awaiting: 'hrInc.status.awaiting',
  reviewed: 'hrInc.status.reviewed',
  voided: 'hrInc.status.voided',
});
export const INCIDENT_STATUS_VARIANTS = Object.freeze({ awaiting: 'amber', reviewed: 'green', voided: 'slate' });

// ── limits ──────────────────────────────────────────────────────────────────
export const INCIDENT_TEXT_MAX = Object.freeze({
  reportedByName: 120,
  reporterTitle: 120,
  propertyName: 200,
  exactLocation: 300,
  cityState: 120,
  typeOther: 200,
  whatHappened: 4000,
  personName: 120,
  injuryDescription: 2000,
  treatmentProvider: 500,
  witnessNames: 1000,
  witnessContact: 1000,
  policeDetails: 1000,
  notifiedOther: 200,
  actionsTaken: 4000,
  submitterContact: 200,
  fileName: 200,
  voidReason: 1000,
});
export const MAX_PEOPLE = 30;
export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // the hr-files bucket's own bound (lib/hrFiles)
export const INCIDENT_FILE_MIME = Object.freeze(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDayKey = (v) => typeof v === 'string' && DAY_RE.test(v);
// "Time (AM / PM)": the browser's time box gives 24-hour "HH:MM"; it reads back as AM / PM.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTimeKey = (v) => typeof v === 'string' && TIME_RE.test(v);
const blank = (v) => typeof v !== 'string' || !v.trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isIncidentId = (v) => typeof v === 'string' && UUID_RE.test(v);

// A report's files live under their own owner in the private hr-files bucket
// (`<org>/hr/incident-<id>/`). The prefix names the report, so the server can prove a file
// belongs to it, and hr-files refuses to delete anything under it (never removed).
export const INCIDENT_FILE_OWNER_PREFIX = 'incident-';
export const incidentFileOwner = (id) => `${INCIDENT_FILE_OWNER_PREFIX}${id}`;
export const isIncidentFileOwner = (ownerId) => typeof ownerId === 'string' && ownerId.startsWith(INCIDENT_FILE_OWNER_PREFIX);
// The report an owner names, or null.
export const incidentIdOfOwner = (ownerId) => {
  const id = isIncidentFileOwner(ownerId) ? ownerId.slice(INCIDENT_FILE_OWNER_PREFIX.length) : null;
  return isIncidentId(id) ? id : null;
};

// ── the case number (section 07's "Case / reference no.") ───────────────────
// Given on filing, from a database sequence (never "highest + 1"), shown as IR-0001.
export function incidentCaseNo(incident) {
  const n = incident ? Number(incident.number) : NaN;
  return Number.isInteger(n) && n > 0 ? `IR-${String(n).padStart(4, '0')}` : null;
}

// "14:05" → "2:05 PM" (his question asks AM / PM). A bad value reads as written.
export function timeAmPm(hhmm) {
  if (!isTimeKey(hhmm)) return hhmm || '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Kept lists: known codes only, each once, in HIS order.
export const normalizeTypes = (v) => { const s = new Set(Array.isArray(v) ? v : []); return INCIDENT_TYPES.filter((x) => s.has(x)); };
export const normalizeNotified = (v) => { const s = new Set(Array.isArray(v) ? v : []); return NOTIFIED_LIST.filter((x) => s.has(x)); };

// The people involved, kept: an employee row keeps its id (and the name stamped beside it); a
// visitor or other keeps the typed name. Rows with nothing in them are dropped.
export function normalizePeople(v) {
  const out = [];
  for (const p of Array.isArray(v) ? v : []) {
    if (!p || !PERSON_KINDS.includes(p.kind)) continue;
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, INCIDENT_TEXT_MAX.personName) : '';
    if (p.kind === PERSON_KIND.employee) {
      if (typeof p.userId !== 'string' || !p.userId) continue;
      out.push({ kind: p.kind, userId: p.userId, name: name || null });
    } else {
      if (!name) continue;
      out.push({ kind: p.kind, userId: null, name });
    }
  }
  return out;
}

// The employees named — what the HR card looks a report up by. Each once, in the form's order.
export function involvedUserIds(people) {
  const seen = new Set();
  for (const p of normalizePeople(people)) if (p.kind === PERSON_KIND.employee && !seen.has(p.userId)) seen.add(p.userId);
  return [...seen];
}

// The kinds of documentation a report has, in his order — the printed form's ticks.
export function docKindsOf(files) {
  const s = new Set((Array.isArray(files) ? files : []).map((f) => f && f.kind));
  return DOC_KINDS.filter((k) => s.has(k));
}

// The customers a report can name as its property: one we clean for, never a supplier (the app's
// property rule, lib/managerHome) and never an archived one (archived customers leave the pickers,
// lib/customerStatus). The form offers only these, and the server refuses any other.
export const isIncidentProperty = (c) => !!(c && c.id && c.name && c.type !== 'vendor' && !isArchivedCustomer(c));

// A file's identity on a report: its place in the bucket (connected), else the demo's file id.
const fileKey = (f) => (f && typeof f === 'object' && (f.storagePath || f.fileId)) || null;
// The files not on the report yet, each once. A retried "Add files" whose first try landed (its
// answer lost) attaches nothing twice: a report's files can never be taken off again. A file with
// no identity is kept, so `filesRefusal` still refuses it.
export function filesNotOn(files, onReport) {
  const have = new Set((Array.isArray(onReport) ? onReport : []).map(fileKey).filter(Boolean));
  const seen = new Set();
  return (Array.isArray(files) ? files : []).filter((f) => {
    const k = fileKey(f);
    if (!k) return true;
    if (have.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── validation (the form AND the server: one list of what a report must say) ──
// The refusal codes, each with its sentence in the catalog. The server answers with the English
// (API error bodies stay English, LANG-8); the form shows the reader's language.
export const INCIDENT_REFUSAL_KEYS = Object.freeze({
  'reported-by-missing': 'hrInc.refusal.reportedByMissing',
  'reporter-missing': 'hrInc.refusal.reporterMissing',
  'incident-date-missing': 'hrInc.refusal.incidentDateMissing',
  'incident-date-in-future': 'hrInc.refusal.incidentDateInFuture',
  'incident-time-bad': 'hrInc.refusal.incidentTimeBad',
  'property-missing': 'hrInc.refusal.propertyMissing',
  'types-missing': 'hrInc.refusal.typesMissing',
  'type-bad': 'hrInc.refusal.typeBad',
  'type-other-missing': 'hrInc.refusal.typeOtherMissing',
  'what-happened-missing': 'hrInc.refusal.whatHappenedMissing',
  'person-bad': 'hrInc.refusal.personBad',
  'people-too-many': 'hrInc.refusal.peopleTooMany',
  'injured-missing': 'hrInc.refusal.injuredMissing',
  'injury-missing': 'hrInc.refusal.injuryMissing',
  'treatment-missing': 'hrInc.refusal.treatmentMissing',
  'witnesses-missing': 'hrInc.refusal.witnessesMissing',
  'witness-names-missing': 'hrInc.refusal.witnessNamesMissing',
  'police-missing': 'hrInc.refusal.policeMissing',
  'notified-bad': 'hrInc.refusal.notifiedBad',
  'notified-other-missing': 'hrInc.refusal.notifiedOtherMissing',
  'submitter-missing': 'hrInc.refusal.submitterMissing',
  'signature-missing': 'hrInc.refusal.signatureMissing',
  'signature-bad': 'hrInc.refusal.signatureBad',
  'signature-too-large': 'hrInc.refusal.signatureTooLarge',
  'file-bad': 'hrInc.refusal.fileBad',
  'files-too-many': 'hrInc.refusal.filesTooMany',
  'files-missing': 'hrInc.refusal.filesMissing',
  'reviewer-missing': 'hrInc.refusal.reviewerMissing',
  'void-reason-missing': 'hrInc.refusal.voidReasonMissing',
  'too-long': 'hrInc.refusal.tooLong',
});

// One file's metadata as a report keeps it, or null when it is not one. `storagePath` is the
// object's place in the private hr-files bucket (connected); the demo keeps `fileId` only.
export function normalizeFile(f) {
  if (!f || typeof f !== 'object') return null;
  if (!DOC_KINDS.includes(f.kind)) return null;
  if (typeof f.name !== 'string' || !f.name.trim()) return null;
  if (!INCIDENT_FILE_MIME.includes(f.mimeType)) return null;
  const size = Number(f.sizeBytes);
  if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) return null;
  const storagePath = typeof f.storagePath === 'string' && f.storagePath ? f.storagePath : null;
  const fileId = typeof f.fileId === 'string' && f.fileId ? f.fileId.slice(0, 64) : null;
  if (!storagePath && !fileId) return null;
  return {
    kind: f.kind,
    name: f.name.trim().slice(0, INCIDENT_TEXT_MAX.fileName),
    mimeType: f.mimeType,
    sizeBytes: Math.round(size),
    storagePath,
    fileId,
  };
}

// A list of files to add, as a refusal code or null.
export function filesRefusal(files, alreadyOnReport = 0) {
  if (!Array.isArray(files)) return 'file-bad';
  if (files.some((f) => !normalizeFile(f))) return 'file-bad';
  if (alreadyOnReport + files.length > MAX_FILES) return 'files-too-many';
  return null;
}

// The first thing wrong with a draft, as a code, or null when it can be filed. `today` is the
// org's day key: an incident cannot be dated in the future.
export function incidentDraftRefusal(d, today) {
  const x = d || {};
  // 01
  if (blank(x.reportedByUserId) && blank(x.reportedByName)) return 'reported-by-missing';
  // 02
  if (blank(x.incidentDate)) return 'incident-date-missing';
  if (!isDayKey(x.incidentDate)) return 'incident-date-missing';
  if (isDayKey(today) && x.incidentDate > today) return 'incident-date-in-future';
  if (!blank(x.incidentTime) && !isTimeKey(x.incidentTime)) return 'incident-time-bad';
  if (blank(x.clientId) && blank(x.propertyName)) return 'property-missing';
  if (!Array.isArray(x.types) || x.types.length === 0) return 'types-missing';
  if (x.types.some((t) => !INCIDENT_TYPES.includes(t)) || new Set(x.types).size !== x.types.length) return 'type-bad';
  if (x.types.includes(INCIDENT_TYPE.other) && blank(x.typeOther)) return 'type-other-missing';
  if (blank(x.whatHappened)) return 'what-happened-missing';
  // 03
  const people = Array.isArray(x.people) ? x.people : [];
  if (people.length > MAX_PEOPLE) return 'people-too-many';
  for (const p of people) {
    if (!p || !PERSON_KINDS.includes(p.kind)) return 'person-bad';
    if (p.kind === PERSON_KIND.employee ? blank(p.userId) : blank(p.name)) return 'person-bad';
  }
  if (!ANSWERS.includes(x.injured)) return 'injured-missing';
  if (x.injured === ANSWER.yes) {
    if (blank(x.injuryDescription)) return 'injury-missing';
    if (!TREATMENTS.includes(x.treatment)) return 'treatment-missing';
  }
  // 04
  if (!ANSWERS.includes(x.witnesses)) return 'witnesses-missing';
  if (x.witnesses === ANSWER.yes && blank(x.witnessNames)) return 'witness-names-missing';
  if (!POLICE_ANSWERS.includes(x.police)) return 'police-missing';
  const notified = Array.isArray(x.notified) ? x.notified : [];
  if (notified.some((n) => !NOTIFIED_LIST.includes(n)) || new Set(notified).size !== notified.length) return 'notified-bad';
  if (notified.includes(NOTIFIED.other) && blank(x.notifiedOther)) return 'notified-other-missing';
  // 05
  if (x.files !== undefined && x.files !== null) {
    const f = filesRefusal(x.files, 0);
    if (f) return f;
  }
  // 06
  if (blank(x.submittedByUserId)) return 'submitter-missing';
  const sig = signatureRefusal(x.signature);
  if (sig) return sig;
  // limits
  const long = [
    ['reportedByName', x.reportedByName], ['reporterTitle', x.reporterTitle], ['propertyName', x.propertyName],
    ['exactLocation', x.exactLocation], ['cityState', x.cityState], ['typeOther', x.typeOther],
    ['whatHappened', x.whatHappened], ['injuryDescription', x.injuryDescription],
    ['treatmentProvider', x.treatmentProvider], ['witnessNames', x.witnessNames], ['witnessContact', x.witnessContact],
    ['policeDetails', x.policeDetails], ['notifiedOther', x.notifiedOther], ['actionsTaken', x.actionsTaken],
    ['submitterContact', x.submitterContact],
  ].some(([k, v]) => typeof v === 'string' && v.trim().length > INCIDENT_TEXT_MAX[k]);
  if (long || people.some((p) => typeof p.name === 'string' && p.name.trim().length > INCIDENT_TEXT_MAX.personName)) return 'too-long';
  return null;
}

// What a filed report keeps of a draft: every answer trimmed and bounded, a follow-up question's
// answer only when its question was answered Yes (the form hides it otherwise), "Other"'s words
// only when Other is ticked. The server and the demo stub both write exactly this.
const keep = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
export function incidentAnswers(d) {
  const x = d || {};
  const types = normalizeTypes(x.types);
  const notified = normalizeNotified(x.notified);
  const people = normalizePeople(x.people);
  const injured = ANSWERS.includes(x.injured) ? x.injured : null;
  const witnesses = ANSWERS.includes(x.witnesses) ? x.witnesses : null;
  const police = POLICE_ANSWERS.includes(x.police) ? x.police : null;
  return {
    reporterTitle: keep(x.reporterTitle, INCIDENT_TEXT_MAX.reporterTitle),
    incidentDate: isDayKey(x.incidentDate) ? x.incidentDate : null,
    incidentTime: isTimeKey(x.incidentTime) ? x.incidentTime : null,
    exactLocation: keep(x.exactLocation, INCIDENT_TEXT_MAX.exactLocation),
    cityState: keep(x.cityState, INCIDENT_TEXT_MAX.cityState),
    types,
    typeOther: types.includes(INCIDENT_TYPE.other) ? keep(x.typeOther, INCIDENT_TEXT_MAX.typeOther) : null,
    whatHappened: keep(x.whatHappened, INCIDENT_TEXT_MAX.whatHappened),
    people,
    involvedUserIds: involvedUserIds(people),
    injured,
    injuryDescription: injured === ANSWER.yes ? keep(x.injuryDescription, INCIDENT_TEXT_MAX.injuryDescription) : null,
    treatment: injured === ANSWER.yes && TREATMENTS.includes(x.treatment) ? x.treatment : null,
    treatmentProvider: injured === ANSWER.yes ? keep(x.treatmentProvider, INCIDENT_TEXT_MAX.treatmentProvider) : null,
    witnesses,
    witnessNames: witnesses === ANSWER.yes ? keep(x.witnessNames, INCIDENT_TEXT_MAX.witnessNames) : null,
    witnessContact: witnesses === ANSWER.yes ? keep(x.witnessContact, INCIDENT_TEXT_MAX.witnessContact) : null,
    police,
    policeDetails: police === ANSWER.yes ? keep(x.policeDetails, INCIDENT_TEXT_MAX.policeDetails) : null,
    notified,
    notifiedOther: notified.includes(NOTIFIED.other) ? keep(x.notifiedOther, INCIDENT_TEXT_MAX.notifiedOther) : null,
    actionsTaken: keep(x.actionsTaken, INCIDENT_TEXT_MAX.actionsTaken),
    submitterContact: keep(x.submitterContact, INCIDENT_TEXT_MAX.submitterContact),
  };
}

// The words a list row and a card show for the types ticked, in his order, "Other" with its words.
export function typesText(t, inc) {
  return normalizeTypes(inc && inc.types)
    .map((x) => (x === INCIDENT_TYPE.other && inc.typeOther ? `${t(INCIDENT_TYPE_KEYS[x])}: ${inc.typeOther}` : t(INCIDENT_TYPE_KEYS[x])))
    .join(', ');
}

// The people involved as one line: "Tomas Rivera (Employee), Jane Doe (Visitor)".
export function peopleText(t, inc, nameOf = {}) {
  return normalizePeople(inc && inc.people)
    .map((p) => `${(p.userId && nameOf[p.userId]) || p.name || '—'} (${t(PERSON_KIND_KEYS[p.kind])})`)
    .join(', ');
}
