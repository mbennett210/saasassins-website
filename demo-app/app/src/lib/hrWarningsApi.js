// HR warnings API adapter (Matt's HR-1..HR-5). Real backend by default — Vercel serves
// /api/hr-warnings/* over the `hr_warnings` table (its own table, never org_state).
//
// The localStorage stub engages ONLY in a DEMO build, on the STATIC `import.meta.env.MODE`
// Vite inlines at build time, exactly as lib/contractsApi.js does (the CS-010 lesson). In
// `npm run build` STUB folds to a literal `false`, every `if (!STUB)` takes the real path, and
// the stub bodies plus the 'cs-stub:hrWarnings' sentinel are dead code esbuild removes —
// check-bundle-stubs.mjs asserts it.
//
// The stub runs the SAME pure rules the server does (lib/hrWarnings.js): the draft refusals,
// the bounded signature, the locked-once-issued moves. It cannot enforce who may call what
// (there is no server in the demo); the screens gate on the same permissions they do live.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { HR_WARNINGS_STUB_KEY } from '../data/stubKeys';
import {
  WARNING_STATUS, WARNING_REASON, WARNING_TEXT_MAX,
  warningDraftRefusal, signatureRefusal, normalizeReasons,
} from './hrWarnings';
import { todayKey } from './dates';

const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_HR_WARNINGS_STUB === '1' || import.meta.env.VITE_HR_WARNINGS_STUB === 'true'));
if (STUB) markStub('cs-stub:hrWarnings');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isHrWarningsStub() { return STUB; }

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

// A caller-minted id (a v4 uuid), so a retried issue is a no-op server-side.
export function newWarningId() {
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
//   { users, currentUserId }

export async function listWarnings({ employeeId = null } = {}) {
  if (!STUB) return api(`/hr-warnings/list${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ''}`);
  const all = stubDb().warnings.map(listShape);
  return { warnings: employeeId ? all.filter((w) => w.employeeUserId === employeeId) : all, today: todayKey() };
}

// The signed-in person's OWN warnings (the server takes the id from the login, never from here).
export async function listMine(ctx = {}) {
  if (!STUB) return api('/hr-warnings/mine');
  return { warnings: stubDb().warnings.filter((w) => w.employeeUserId === ctx.currentUserId).map(listShape), today: todayKey() };
}

export async function getWarning(id) {
  if (!STUB) return (await api(`/hr-warnings/${encodeURIComponent(id)}`)).warning;
  return stubDb().warnings.find((w) => w.id === id) || null;
}

export async function createWarning(payload, ctx = {}) {
  if (!STUB) return api('/hr-warnings/create', { method: 'POST', body: payload });
  return stubCreate(payload, ctx);
}

export async function acknowledgeWarning(id, { signature, comment }, ctx = {}) {
  if (!STUB) return (await api(`/hr-warnings/${encodeURIComponent(id)}/acknowledge`, { method: 'POST', body: { signature, comment } })).warning;
  const sig = signatureRefusal(signature);
  if (sig) throw refusal(sig);
  return stubMove(id, [WARNING_STATUS.awaiting], (w) => ({
    ...w,
    status: WARNING_STATUS.acknowledged,
    employeeSignature: signature,
    employeeSignedAt: new Date().toISOString(),
    employeeComment: trimTo(comment, WARNING_TEXT_MAX.comment),
    signedInPerson: ctx.currentUserId !== w.employeeUserId,
  }));
}

export async function refuseWarning(id, { hrManagerUserId, signature }, ctx = {}) {
  if (!STUB) return (await api(`/hr-warnings/${encodeURIComponent(id)}/refuse`, { method: 'POST', body: { hrManagerUserId, signature } })).warning;
  const mgr = (ctx.users || []).find((u) => u.id === hrManagerUserId);
  if (!mgr) throw refusal('hr-manager-missing');
  const sig = signatureRefusal(signature);
  if (sig) throw refusal(sig);
  const at = new Date().toISOString();
  return stubMove(id, [WARNING_STATUS.awaiting], (w) => ({
    ...w,
    status: WARNING_STATUS.refused,
    refusedAt: at,
    hrManagerUserId: mgr.id,
    hrManagerName: mgr.name || null,
    hrManagerSignature: signature,
    hrManagerSignedAt: at,
  }));
}

export async function voidWarning(id, { reason }, ctx = {}) {
  if (!STUB) return (await api(`/hr-warnings/${encodeURIComponent(id)}/void`, { method: 'POST', body: { reason } })).warning;
  const why = trimTo(reason, WARNING_TEXT_MAX.voidReason);
  if (!why) throw refusal('void-reason-missing');
  const me = (ctx.users || []).find((u) => u.id === ctx.currentUserId);
  return stubMove(id, [WARNING_STATUS.awaiting, WARNING_STATUS.acknowledged, WARNING_STATUS.refused], (w) => ({
    ...w,
    status: WARNING_STATUS.voided,
    voidedAt: new Date().toISOString(),
    voidedByUserId: ctx.currentUserId || null,
    voidedByName: (me && me.name) || null,
    voidReason: why,
  }));
}

// The warning's own words in `lang` (Google, on demand, nothing stored). The demo has no key,
// so it answers exactly as a server without one does — never an invented translation.
export async function translateWarning(id, lang) {
  if (!STUB) return api(`/hr-warnings/${encodeURIComponent(id)}/translate`, { method: 'POST', body: { lang } });
  const err = new Error('Translation is not available yet.');
  err.status = 503;
  err.code = 'machine-translation-off';
  throw err;
}

// ── stub store (demo only; dead-code-eliminated from a production build) ─────
const trimTo = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const refusal = (code) => { const e = new Error(code); e.status = 400; e.code = code; return e; };
const stubDb = () => {
  try { return JSON.parse(localStorage.getItem(HR_WARNINGS_STUB_KEY)) || { warnings: [] }; }
  catch { return { warnings: [] }; }
};
const saveStub = (db) => { try { localStorage.setItem(HR_WARNINGS_STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };
// The list shape never carries the signatures (the server's LIST_COLUMNS).
const listShape = (w) => {
  const { employeeSignature: _e, hrManagerSignature: _h, ...rest } = w;
  return rest;
};

function stubCreate(p, ctx) {
  const db = stubDb();
  const had = db.warnings.find((w) => w.id === p.id);
  if (had) return { warning: had, created: false };
  const today = todayKey();
  const code = warningDraftRefusal(p, today);
  if (code) throw refusal(code);
  const user = (id) => (ctx.users || []).find((u) => u.id === id) || null;
  const at = new Date().toISOString();
  const w = {
    id: p.id,
    employeeUserId: p.employeeUserId,
    employeeName: user(p.employeeUserId)?.name || null,
    supervisorUserId: p.supervisorUserId,
    supervisorName: user(p.supervisorUserId)?.name || null,
    level: p.level,
    reasons: normalizeReasons(p.reasons),
    reasonOther: p.reasons.includes(WARNING_REASON.other) ? trimTo(p.reasonOther, WARNING_TEXT_MAX.reasonOther) : null,
    previousMeetingDate: p.previousMeetingDate || null,
    whatHappened: trimTo(p.whatHappened, WARNING_TEXT_MAX.whatHappened),
    whatMustChange: trimTo(p.whatMustChange, WARNING_TEXT_MAX.whatMustChange),
    issuedAt: at,
    issuedOn: today,
    issuedByUserId: ctx.currentUserId || null,
    status: WARNING_STATUS.awaiting,
    employeeSignature: null, employeeSignedAt: null, employeeComment: null, signedInPerson: false,
    refusedAt: null, hrManagerUserId: null, hrManagerName: null, hrManagerSignature: null, hrManagerSignedAt: null,
    voidedAt: null, voidedByUserId: null, voidedByName: null, voidReason: null, remindedAt: null,
  };
  db.warnings.unshift(w);
  saveStub(db);
  return { warning: w, created: true };
}

function stubMove(id, from, change) {
  const db = stubDb();
  const i = db.warnings.findIndex((w) => w.id === id);
  if (i < 0) { const e = new Error('That warning does not exist.'); e.status = 404; throw e; }
  if (!from.includes(db.warnings[i].status)) {
    const e = new Error('That warning was already signed, refused or voided.'); e.status = 409; e.code = 'already-closed';
    throw e;
  }
  db.warnings[i] = change(db.warnings[i]);
  saveStub(db);
  return db.warnings[i];
}
