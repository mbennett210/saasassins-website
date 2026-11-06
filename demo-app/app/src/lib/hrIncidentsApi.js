// HR incident reports API adapter (task #258 from Clean Corner's queue). Real backend by default
// — Vercel serves /api/hr-incidents/* over the `hr_incidents` table (its own table, never
// org_state).
//
// The localStorage stub engages ONLY in a DEMO build, on the STATIC `import.meta.env.MODE` Vite
// inlines at build time, exactly as lib/hrWarningsApi.js does (the CS-010 lesson). In
// `npm run build` STUB folds to a literal `false`, every `if (!STUB)` takes the real path, and the
// stub bodies plus the 'cs-stub:hrIncidents' sentinel are dead code esbuild removes —
// check-bundle-stubs.mjs asserts it.
//
// The stub runs the SAME pure rules the server does (lib/hrIncidents.js): the draft refusals, the
// kept answers, the bounded signature, the locked-once-filed moves, files only added. It cannot
// enforce who may call what (there is no server in the demo); the screens gate on the same
// permissions they do live.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { HR_INCIDENTS_STUB_KEY } from '../data/stubKeys';
import {
  INCIDENT_STATUS, INCIDENT_TEXT_MAX, PERSON_KIND,
  incidentDraftRefusal, incidentAnswers, filesRefusal, filesNotOn, normalizeFile, isIncidentProperty,
} from './hrIncidents';
import { todayKey } from './dates';

const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_HR_INCIDENTS_STUB === '1' || import.meta.env.VITE_HR_INCIDENTS_STUB === 'true'));
if (STUB) markStub('cs-stub:hrIncidents');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isHrIncidentsStub() { return STUB; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let payload = null;
    try { payload = await res.json(); msg = payload.error || msg; } catch { /* non-JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    if (payload) err.code = payload.code;
    throw err;
  }
  return res.json();
}

// A caller-minted id (a v4 uuid), so a retried filing is a no-op server-side. It is minted when
// the form opens: the files picked on the form are uploaded under this report's own folder.
export function newIncidentId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i += 1) {
    s += (i === 8 || i === 13 || i === 18 || i === 23) ? '-'
      : i === 14 ? '4'
        : i === 19 ? h[(Math.random() * 4 | 0) + 8]
          : h[Math.random() * 16 | 0];
  }
  return s;
}

// ── the calls ───────────────────────────────────────────────────────────────
// `ctx` is used ONLY by the demo stub, which has no server to read the roster from:
//   { users, clients, currentUserId }

export async function listIncidents({ employeeId = null } = {}) {
  if (!STUB) return api(`/hr-incidents/list${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ''}`);
  const all = stubDb().incidents.map(listShape);
  return { incidents: employeeId ? all.filter((r) => (r.involvedUserIds || []).includes(employeeId)) : all };
}

export async function getIncident(id) {
  if (!STUB) return (await api(`/hr-incidents/${encodeURIComponent(id)}`)).incident;
  const r = stubDb().incidents.find((x) => x.id === id);
  if (!r) throw stubError('That report does not exist.', 404);
  return r;
}

export async function createIncident(payload, ctx = {}) {
  if (!STUB) return api('/hr-incidents/create', { method: 'POST', body: payload });
  return stubCreate(payload, ctx);
}

export async function addIncidentFiles(id, files, ctx = {}) {
  if (!STUB) return (await api(`/hr-incidents/${encodeURIComponent(id)}/files`, { method: 'POST', body: { files } })).incident;
  const cur = stubDb().incidents.find((r) => r.id === id);
  if (!cur) throw stubError('That report does not exist.', 404);
  if (cur.status === INCIDENT_STATUS.voided) throw stubError('That report was voided.', 409, 'already-closed');
  if (!Array.isArray(files) || !files.length) throw refusal('files-missing');
  const fresh = filesNotOn(files, cur.files);
  if (!fresh.length) return listShape(cur);   // a retry whose first try landed
  const code = filesRefusal(fresh, (cur.files || []).length);
  if (code) throw refusal(code);
  const at = new Date().toISOString();
  return stubMove(id, [INCIDENT_STATUS.awaiting, INCIDENT_STATUS.reviewed], (r) => ({
    ...r,
    files: [...(r.files || []), ...fresh.map((f) => ({ id: stubFileId(), ...normalizeFile(f), addedAt: at, addedByUserId: ctx.currentUserId || null }))],
    version: (r.version || 1) + 1,
  }));
}

export async function reviewIncident(id, { reviewerUserId }, ctx = {}) {
  if (!STUB) return (await api(`/hr-incidents/${encodeURIComponent(id)}/review`, { method: 'POST', body: { reviewerUserId } })).incident;
  const who = (ctx.users || []).find((u) => u.id === reviewerUserId);
  if (!who) throw refusal('reviewer-missing');
  return stubMove(id, [INCIDENT_STATUS.awaiting], (r) => ({
    ...r,
    status: INCIDENT_STATUS.reviewed,
    reviewedByUserId: who.id,
    reviewedByName: who.name || null,
    receivedOn: todayKey(),
    reviewedAt: new Date().toISOString(),
  }));
}

export async function voidIncident(id, { reason }, ctx = {}) {
  if (!STUB) return (await api(`/hr-incidents/${encodeURIComponent(id)}/void`, { method: 'POST', body: { reason } })).incident;
  const why = trimTo(reason, INCIDENT_TEXT_MAX.voidReason);
  if (!why) throw refusal('void-reason-missing');
  const me = (ctx.users || []).find((u) => u.id === ctx.currentUserId);
  return stubMove(id, [INCIDENT_STATUS.awaiting, INCIDENT_STATUS.reviewed], (r) => ({
    ...r,
    status: INCIDENT_STATUS.voided,
    voidedAt: new Date().toISOString(),
    voidedByUserId: ctx.currentUserId || null,
    voidedByName: (me && me.name) || null,
    voidReason: why,
  }));
}

// ── stub store (demo only; dead-code-eliminated from a production build) ─────
const trimTo = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const refusal = (code) => { const e = new Error(code); e.status = 400; e.code = code; return e; };
const stubError = (message, status, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const stubFileId = () => `irf_${Math.random().toString(36).slice(2, 14)}`;
const stubDb = () => {
  try { return JSON.parse(localStorage.getItem(HR_INCIDENTS_STUB_KEY)) || { incidents: [] }; }
  catch { return { incidents: [] }; }
};
const saveStub = (db) => { try { localStorage.setItem(HR_INCIDENTS_STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };
// The list shape never carries the signature (the server's LIST_COLUMNS).
const listShape = (r) => {
  const { submitterSignature: _s, ...rest } = r;
  return rest;
};

function stubCreate(p, ctx) {
  const db = stubDb();
  const had = db.incidents.find((r) => r.id === p.id);
  if (had) return { incident: had, created: false };
  const today = todayKey();
  const code = incidentDraftRefusal(p, today);
  if (code) throw refusal(code);
  const user = (id) => (ctx.users || []).find((u) => u.id === id) || null;
  const client = p.clientId ? (ctx.clients || []).find((c) => c.id === p.clientId) || null : null;
  if (p.clientId && !isIncidentProperty(client)) throw refusal('property-missing');
  const submitter = user(p.submittedByUserId);
  if (!submitter) throw refusal('submitter-missing');
  const a = incidentAnswers(p);
  const at = new Date().toISOString();
  const numbers = db.incidents.map((r) => Number(r.number) || 0);
  const r = {
    id: p.id,
    number: (numbers.length ? Math.max(...numbers) : 0) + 1,
    reportedOn: today,
    reportedByUserId: p.reportedByUserId || null,
    reportedByName: (p.reportedByUserId && user(p.reportedByUserId)?.name) || trimTo(p.reportedByName, INCIDENT_TEXT_MAX.reportedByName),
    reporterTitle: a.reporterTitle,
    incidentDate: a.incidentDate,
    incidentTime: a.incidentTime,
    clientId: client ? client.id : null,
    propertyName: (client && client.name) || trimTo(p.propertyName, INCIDENT_TEXT_MAX.propertyName),
    exactLocation: a.exactLocation,
    cityState: a.cityState,
    types: a.types,
    typeOther: a.typeOther,
    whatHappened: a.whatHappened,
    people: a.people.map((x) => (x.kind === PERSON_KIND.employee ? { ...x, name: user(x.userId)?.name || x.name || null } : x)),
    involvedUserIds: a.involvedUserIds,
    injured: a.injured,
    injuryDescription: a.injuryDescription,
    treatment: a.treatment,
    treatmentProvider: a.treatmentProvider,
    witnesses: a.witnesses,
    witnessNames: a.witnessNames,
    witnessContact: a.witnessContact,
    police: a.police,
    policeDetails: a.policeDetails,
    notified: a.notified,
    notifiedOther: a.notifiedOther,
    actionsTaken: a.actionsTaken,
    files: (Array.isArray(p.files) ? p.files : []).map((f) => ({ id: stubFileId(), ...normalizeFile(f), addedAt: at, addedByUserId: ctx.currentUserId || null })),
    submittedByUserId: submitter.id,
    submittedByName: submitter.name || null,
    submitterSignature: p.signature,
    signedOn: today,
    submitterContact: a.submitterContact,
    filedAt: at,
    filedByUserId: ctx.currentUserId || null,
    status: INCIDENT_STATUS.awaiting,
    reviewedByUserId: null, reviewedByName: null, receivedOn: null, reviewedAt: null,
    voidedAt: null, voidedByUserId: null, voidedByName: null, voidReason: null,
    version: 1,
  };
  db.incidents.unshift(r);
  saveStub(db);
  return { incident: r, created: true };
}

function stubMove(id, from, change) {
  const db = stubDb();
  const i = db.incidents.findIndex((r) => r.id === id);
  if (i < 0) throw stubError('That report does not exist.', 404);
  if (!from.includes(db.incidents[i].status)) {
    throw stubError(db.incidents[i].status === INCIDENT_STATUS.voided ? 'That report was voided.' : 'That report was already marked reviewed.', 409, 'already-closed');
  }
  db.incidents[i] = change(db.incidents[i]);
  saveStub(db);
  return db.incidents[i];
}
