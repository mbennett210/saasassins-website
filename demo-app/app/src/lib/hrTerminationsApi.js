// HR terminations API adapter (Super Clippy's idea #513 from Clean Corner's queue). Real backend
// by default — Vercel serves /api/hr-terminations/* over the `hr_terminations` table (its own
// table, never org_state), and the server turns the login off (api/_lib/hrTerminations/access.js).
//
// The localStorage stub engages ONLY in a DEMO build, on the STATIC `import.meta.env.MODE` Vite
// inlines at build time, exactly as lib/hrIncidentsApi.js does (the CS-010 lesson). In
// `npm run build` STUB folds to a literal `false`, every `if (!STUB)` takes the real path, and the
// stub bodies plus the 'cs-stub:hrTerminations' sentinel are dead code esbuild removes —
// check-bundle-stubs.mjs asserts it.
//
// The stub runs the SAME pure rules the server does (lib/hrTerminations.js): the draft refusals,
// the kept answers, one live termination per person, the void. It has no login to ban, so it
// turns the member Disabled (and back) in the demo's own store through `ctx.setMemberStatus`;
// it cannot enforce who may call what (there is no server in the demo), and the screens gate on
// the same permissions they do live.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { HR_TERMINATIONS_STUB_KEY } from '../data/stubKeys';
import {
  TERMINATION_STATUS, ACCESS_STATE, TERMINATION_TEXT_MAX,
  terminationDraftRefusal, terminationAnswers, isDirectManagerChoice, terminationTargetRefusal,
} from './hrTerminations';
import { todayKey } from './dates';

const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_HR_TERMINATIONS_STUB === '1' || import.meta.env.VITE_HR_TERMINATIONS_STUB === 'true'));
if (STUB) markStub('cs-stub:hrTerminations');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isHrTerminationsStub() { return STUB; }

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

// A caller-minted id (a v4 uuid), so a retried filing is a no-op server-side. Minted when the
// form opens.
export function newTerminationId() {
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
// `ctx` is used ONLY by the demo stub, which has no server:
//   { users, currentUserId, currentUserRole, setMemberStatus(userId, status) }

export async function listTerminations({ employeeId = null } = {}) {
  if (!STUB) return api(`/hr-terminations/list${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ''}`);
  const all = stubDb().terminations;
  return { terminations: employeeId ? all.filter((r) => r.employeeUserId === employeeId) : all };
}

export async function getTermination(id) {
  if (!STUB) return (await api(`/hr-terminations/${encodeURIComponent(id)}`)).termination;
  const r = stubDb().terminations.find((x) => x.id === id);
  if (!r) throw stubError('That termination does not exist.', 404);
  return r;
}

// → { termination, created, access } — `access` is what happened to the login: 'ended',
// 'already_off', 'scheduled' (the date is ahead) or 'pending' (the server will finish it).
export async function createTermination(payload, ctx = {}) {
  if (!STUB) return api('/hr-terminations/create', { method: 'POST', body: payload });
  return stubCreate(payload, ctx);
}

// → { termination, access } — `access` is 'restored', 'kept', 'scheduled' (it never turned off)
// or 'pending'.
export async function voidTermination(id, { reason }, ctx = {}) {
  if (!STUB) return api(`/hr-terminations/${encodeURIComponent(id)}/void`, { method: 'POST', body: { reason } });
  return stubVoid(id, reason, ctx);
}

// ── stub store (demo only; dead-code-eliminated from a production build) ─────
const refusal = (code, status = 400) => { const e = new Error(code); e.status = status; e.code = code; return e; };
const stubError = (message, status, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const stubDb = () => {
  try { return JSON.parse(localStorage.getItem(HR_TERMINATIONS_STUB_KEY)) || { terminations: [] }; }
  catch { return { terminations: [] }; }
};
const saveStub = (db) => { try { localStorage.setItem(HR_TERMINATIONS_STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };

function stubCreate(p, ctx) {
  const db = stubDb();
  const had = db.terminations.find((r) => r.id === p.id);
  if (had) return { termination: had, created: false, access: had.accessState };
  const today = todayKey();
  const code = terminationDraftRefusal(p, today);
  if (code) throw refusal(code);
  const user = (id) => (ctx.users || []).find((u) => u.id === id) || null;
  const employee = user(p.employeeUserId);
  if (!employee) throw refusal('employee-not-on-team');
  const own = terminationTargetRefusal({ id: ctx.currentUserId, role: ctx.currentUserRole }, employee);
  if (own) throw refusal(own, 403);
  const manager = user(p.managerUserId);
  if (!isDirectManagerChoice(manager, employee.id)) throw refusal('manager-not-account-manager');
  if (db.terminations.some((r) => r.employeeUserId === employee.id && r.status === TERMINATION_STATUS.filed)) throw refusal('already-terminated', 409);
  const a = terminationAnswers(p);
  const at = new Date().toISOString();
  const due = a.terminationDate <= today;
  const hadAccess = employee.status !== 'disabled' && employee.status !== 'inactive';
  const r = {
    id: p.id,
    employeeUserId: employee.id,
    employeeName: employee.name || employee.email || employee.id,
    terminationDate: a.terminationDate,
    managerUserId: manager.id,
    managerName: manager.name || null,
    reasons: a.reasons,
    reasonOther: a.reasonOther,
    filedAt: at,
    filedByUserId: ctx.currentUserId || null,
    filedByName: user(ctx.currentUserId)?.name || null,
    status: TERMINATION_STATUS.filed,
    voidedAt: null, voidedByUserId: null, voidedByName: null, voidReason: null,
    accessState: !due ? ACCESS_STATE.scheduled : hadAccess ? ACCESS_STATE.ended : ACCESS_STATE.alreadyOff,
    accessEndedAt: due && hadAccess ? at : null,
    statusBefore: due && hadAccess ? (employee.status === 'invited' ? 'invited' : 'active') : null,
    accessRestoredAt: null,
  };
  db.terminations.unshift(r);
  saveStub(db);
  if (r.accessState === ACCESS_STATE.ended && ctx.setMemberStatus) ctx.setMemberStatus(employee.id, 'disabled');
  return { termination: r, created: true, access: r.accessState };
}

function stubVoid(id, reason, ctx) {
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, TERMINATION_TEXT_MAX.voidReason) : null;
  if (!why) throw refusal('void-reason-missing');
  const db = stubDb();
  const i = db.terminations.findIndex((r) => r.id === id);
  if (i < 0) throw stubError('That termination does not exist.', 404);
  const cur = db.terminations[i];
  if (cur.status !== TERMINATION_STATUS.filed) throw refusal('already-voided', 409);
  const me = (ctx.users || []).find((u) => u.id === ctx.currentUserId);
  const at = new Date().toISOString();
  const giveBack = cur.accessState === ACCESS_STATE.ended;
  db.terminations[i] = {
    ...cur,
    status: TERMINATION_STATUS.voided,
    voidedAt: at,
    voidedByUserId: ctx.currentUserId || null,
    voidedByName: (me && me.name) || null,
    voidReason: why,
    ...(giveBack ? { accessState: ACCESS_STATE.restored, accessRestoredAt: at } : {}),
  };
  saveStub(db);
  if (giveBack && ctx.setMemberStatus) ctx.setMemberStatus(cur.employeeUserId, cur.statusBefore === 'invited' ? 'invited' : 'active');
  return { termination: db.terminations[i], access: db.terminations[i].accessState };
}
