// Contracts API adapter (CS-194). Real backend by default — Vercel serves /api/contracts/*
// over the five relational tables (contracts live in their OWN tables, never org_state).
//
// The localStorage stub engages ONLY in a DEMO build, on the STATIC `import.meta.env.MODE`
// Vite inlines at build time, exactly as lib/quotesApi.js does. That is the CS-010 lesson:
// production once ran the Quotes flow on a browser stub for weeks because the switch was a
// runtime env read, so every staff quote saved to one browser and no customer link resolved.
// In `npm run build` (MODE === 'production') STUB folds to a literal `false`, every
// `if (!STUB)` takes the real path, and the stub bodies plus the 'cs-stub:contracts'
// sentinel are dead code esbuild removes — check-bundle-stubs.mjs asserts it.
//
// The stub runs the SAME pure rules the server does (lib/contracts.js), so the demo's year
// schedule, annual value and reminder dates are the real ones — a demo that computed its own
// numbers would be a second implementation to drift.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { CONTRACTS_STUB_KEY } from '../data/stubKeys';
import {
  CONTRACT_STATUS, REMINDER_STATUS,
  annualValueCents, bookValueCents, contractReminderPlan, normalizeYearRows, buildingConflicts,
  toCents, contractLeftTheBook,
} from './contracts';
import { todayKey } from './dates';
import { archivedClientIds } from './customerStatus';
import { loadState } from '../store/persist';

// PLAIN member reads so Vite inlines them and STUB folds to a literal (see the header).
const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_CONTRACTS_STUB === '1' || import.meta.env.VITE_CONTRACTS_STUB === 'true'));
if (STUB) markStub('cs-stub:contracts');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isContractsStub() { return STUB; }

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
    if (payload) { err.code = payload.code; err.clientIds = payload.clientIds; }
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// A caller-minted id, so a retried create is a no-op server-side rather than a second
// contract (the offline-queue idempotency rule applied to a form).
export function newContractId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // A browser old enough to lack randomUUID still gets a v4-shaped id.
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

// ── the eight calls ─────────────────────────────────────────────────────────

export async function listContracts() {
  if (!STUB) return api('/contracts/list');
  return stubList();
}
export async function getContract(id) {
  if (!STUB) return (await api(`/contracts/${id}`)).contract;
  return stubDb().contracts.find((c) => c.id === id) || null;
}
export async function contractsForClient(clientId) {
  if (!STUB) return (await api(`/contracts/for-client?clientId=${encodeURIComponent(clientId)}`)).contracts;
  return stubList().contracts.filter((c) => (c.clientIds || []).includes(clientId));
}
export async function createContract(payload) {
  if (!STUB) return (await api('/contracts/create', { method: 'POST', body: payload })).contract;
  return stubCreate(payload);
}
export async function saveContract(id, patch) {
  if (!STUB) return (await api(`/contracts/${id}/save`, { method: 'POST', body: patch })).contract;
  return stubSave(id, patch);
}
export async function deleteContract(id) {
  if (!STUB) return api(`/contracts/${id}/delete`, { method: 'POST' });
  const db = stubDb();
  db.contracts = db.contracts.filter((c) => c.id !== id);
  saveStub(db);
  return { ok: true };
}
export async function updateReminder(id, patch) {
  if (!STUB) return (await api(`/contracts/reminders/${id}`, { method: 'POST', body: patch })).reminder;
  return stubReminder(id, patch);
}

// CON-11 — the signed PDF. Three calls in one helper, because the browser must not be left
// holding a chip that names a file nobody has (the CS-043 defect): the bytes go up FIRST and
// the metadata is recorded only once they landed.
export async function uploadContractDocument(contractId, file) {
  if (STUB) {
    const db = stubDb();
    const c = db.contracts.find((x) => x.id === contractId);
    if (c) { c.document = { name: file.name, size: file.size, storagePath: null }; saveStub(db); }
    return c ? c.document : null;
  }
  const { signedUrl, path } = await api(`/contracts/${contractId}/upload-url`, {
    method: 'POST', body: { mimeType: file.type, sizeBytes: file.size },
  });
  const put = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!put.ok) throw new Error('The file could not be uploaded.');
  await api(`/contracts/${contractId}/document`, {
    method: 'POST', body: { name: file.name, size: file.size, storagePath: path },
  });
  return { name: file.name, size: file.size, storagePath: path };
}

export async function contractDocumentUrl(contractId, storagePath) {
  if (STUB) return null;
  return (await api(`/contracts/${contractId}/download-url`, { method: 'POST', body: { storagePath } })).url;
}

export async function deleteContractDocument(contractId, storagePath) {
  if (STUB) {
    const db = stubDb();
    const c = db.contracts.find((x) => x.id === contractId);
    if (c) { c.document = null; saveStub(db); }
    return { ok: true };
  }
  return api(`/contracts/${contractId}/document-delete`, { method: 'POST', body: { storagePath } });
}

// ── stub store (demo only; dead-code-eliminated from a production build) ─────
const nowIso = () => new Date().toISOString();
const rid = () => `ctr_${Math.random().toString(36).slice(2, 12)}`;
const stubDb = () => {
  try { return JSON.parse(localStorage.getItem(CONTRACTS_STUB_KEY)) || { contracts: [] }; }
  catch { return { contracts: [] }; }
};
const saveStub = (db) => { try { localStorage.setItem(CONTRACTS_STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };

// The demo's archived customers, from the office's own store — the server reads its book (CS-663).
function stubArchivedIds() {
  try { return archivedClientIds(loadState()?.clients); } catch { return new Set(); }
}

function stubList() {
  const today = todayKey();
  const archived = stubArchivedIds();
  const contracts = stubDb().contracts.map((c) => ({
    ...c,
    annualValueCents: annualValueCents(c, { years: c.years, lines: c.lines }, today),
    buildingsArchived: contractLeftTheBook(c, archived),
  }));
  return {
    contracts,
    today,
    moneyVisible: true,
    bookValueCents: bookValueCents(contracts.map((c) => ({ contract: c, years: c.years, lines: c.lines })), today, archived),
  };
}

// The stub runs the SAME shaping the server store does, so a demo contract behaves like a
// real one: the year rows are normalized against the term, and the reminder schedule is the
// pure plan, merged so a done or snoozed row survives a re-save.
function shapeStub(c) {
  const today = todayKey();
  const years = normalizeYearRows(c.years, {
    startDate: c.startDate, termMonths: c.termMonths, baseMonthlyCents: c.baseMonthlyCents,
  }).map((y, i) => ({ id: (c.years && c.years[i] && c.years[i].id) || rid(), ...y }));
  const lines = (c.lines || []).filter((l) => l.description).map((l, i) => ({
    id: l.id || rid(), description: l.description, monthlyCents: toCents(l.monthlyCents) ?? 0, sortOrder: i,
  }));
  const plan = contractReminderPlan({ ...c, years }, { years }, today);
  const kept = (c.reminders || []).filter((r) => r.targetDate < today
    || plan.some((p) => p.kind === r.kind && p.targetDate === r.targetDate));
  const reminders = [
    ...kept,
    ...plan.filter((p) => !kept.some((r) => r.kind === p.kind && r.targetDate === p.targetDate)).map((p) => ({
      id: rid(), contractId: c.id, kind: p.kind, targetDate: p.targetDate, dueOn: p.dueOn,
      nextDueOn: p.dueOn, status: REMINDER_STATUS.pending, note: null, notifiedAt: null,
      doneAt: null, doneByUserId: null,
    })),
  ].sort((a, b) => String(a.nextDueOn).localeCompare(String(b.nextDueOn)));
  return { ...c, years, lines, reminders, moneyVisible: true, updatedAt: nowIso() };
}

function stubCreate(payload) {
  const db = stubDb();
  if (db.contracts.some((c) => c.id === payload.id)) return db.contracts.find((c) => c.id === payload.id);
  const taken = buildingConflicts(
    { contractId: payload.id, clientIds: payload.clientIds, status: payload.status },
    db.contracts.flatMap((c) => (c.clientIds || []).map((clientId) => ({ contractId: c.id, clientId, status: c.status }))),
  );
  if (taken.length) {
    const err = new Error('That building is already on another active contract. End it first, or save this one as a draft.');
    err.status = 409; err.code = 'building_already_contracted'; err.clientIds = taken;
    throw err;
  }
  const c = shapeStub({
    status: CONTRACT_STATUS.draft, isMaster: false, name: null, endDate: null, termMonths: null,
    renewalTermMonths: null, cancellationNoticeDays: null, serviceFrequency: null, squareFootage: null,
    specialTerms: null, notes: null, document: null, baseMonthlyCents: 0, years: [], lines: [], reminders: [],
    ...payload, createdAt: nowIso(),
  });
  db.contracts.push(c);
  saveStub(db);
  return c;
}

function stubSave(id, patch) {
  const db = stubDb();
  const i = db.contracts.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const next = { ...db.contracts[i], ...patch };
  const taken = buildingConflicts(
    { contractId: id, clientIds: next.clientIds, status: next.status },
    db.contracts.flatMap((c) => (c.clientIds || []).map((clientId) => ({ contractId: c.id, clientId, status: c.status }))),
  );
  if (taken.length) {
    const err = new Error('That building is already on another active contract. End it first, or save this one as a draft.');
    err.status = 409; err.code = 'building_already_contracted'; err.clientIds = taken;
    throw err;
  }
  db.contracts[i] = shapeStub(next);
  saveStub(db);
  return db.contracts[i];
}

function stubReminder(id, patch) {
  const db = stubDb();
  for (const c of db.contracts) {
    const r = (c.reminders || []).find((x) => x.id === id);
    if (!r) continue;
    if (patch.note !== undefined) r.note = patch.note;
    if (patch.status) {
      r.status = patch.status;
      r.doneAt = patch.status === REMINDER_STATUS.done ? nowIso() : null;
      if (patch.status === REMINDER_STATUS.snoozed) { r.nextDueOn = patch.snoozeUntil; r.notifiedAt = null; }
      if (patch.status === REMINDER_STATUS.pending) { r.nextDueOn = r.dueOn; r.notifiedAt = null; }
    }
    saveStub(db);
    return r;
  }
  return null;
}
