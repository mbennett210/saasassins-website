// HR WARNINGS API (Matt's ask + HR-1..HR-5, 2026-10-05). A catch-all domain — its
// `vercel.json` rewrite is `/api/hr-warnings/:rest* -> /api/hr-warnings/_?subpath=:rest*`,
// and without it every pretty URL here 404s while the file path works (BUILD_INTEGRITY §2).
//
//   GET  /api/hr-warnings/list[?employeeId=]     -> { warnings, today }        hr.view
//   GET  /api/hr-warnings/mine                   -> { warnings, today }        any staff login: ONLY their own
//   GET  /api/hr-warnings/<id>                   -> { warning }                hr.view, or the employee it is about
//   POST /api/hr-warnings/create                 -> { warning, created }       hr.edit
//   POST /api/hr-warnings/<id>/acknowledge       -> { warning }                the employee (own phone), or hr.edit (in person)
//   POST /api/hr-warnings/<id>/refuse            -> { warning }                hr.edit (HR-3: the HR manager signs)
//   POST /api/hr-warnings/<id>/void              -> { warning }                the OWNER only
//   POST /api/hr-warnings/<id>/translate         -> { lang, texts }            hr.view, or the employee it is about
//
// ── AUTH STANCE (declared at creation, by capability — BUILD_INTEGRITY §2) ───────────────
// Every branch resolves the caller through `requireAuthority` (claims-first; a disabled member
// and a customer-hub login hold nothing). Then, per branch, against the COMMITTED matrix +
// overrides through the same `can()` the screens run:
//   · the office reads with `hr.view` and issues / marks refused / takes an in-person
//     signature with `hr.edit` (owner + manager by default, admin excluded — Q24's HR rule);
//   · VOID is held by ROLE — the owner, never a grant: a void takes a disciplinary record
//     out of the count, and `can()` puts no key out of a grant's reach;
//   · 🔴 a CREW member (who holds no `hr.*`) reaches ONLY the warnings whose
//     `employee_user_id` is their own `u_*` id FROM THE CLAIM — never a body or query field —
//     to read, sign and translate. Anyone else's warning answers 404, so a cleaner cannot
//     even learn that a colleague has one.
// RLS on the table is enabled with no policies and the browser roles are revoked, so this
// route IS the boundary.
//
// The supervisor and the HR manager are PICKED on the form (the team shares one login), and
// the server proves each is an active office member on the committed roster before stamping
// their name. Dates are the ORG's day (THE LAW II.8; this function runs TZ=UTC).
//
// NOT in the activity log, on purpose: the log is read by admins, and a warning is HR — the
// row itself is the audit (issued_by, the signatures and their times, voided_by and why).
import { requireAuthority, requirePermission, holdsPermission, readRosterUsers } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readOrgState, writeOrgState, readProtectedSlices } from '../_lib/orgState.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { allow } from '../_lib/rateLimit.js';
import { reportError } from '../_lib/monitor.js';
import { machineConfigured, machineTranslate, MachineTranslateError, MACHINE_LANGUAGES } from '../_lib/machineTranslate.js';
import { dayKey } from '../../src/lib/dates.js';
import { SUPERVISOR_ROLES } from '../../src/lib/roles.js';
import { fanOutToUserIds } from '../../src/lib/notifications.js';
import { msg } from '../../src/i18n/core.js';
import { HR_WARNING_SIGN_EVENT, warningSignUrl } from '../../src/lib/hrWarningReminders.js';
import {
  WarningRefusal, isWarningId,
  listWarnings, getWarning, createWarning, acknowledgeWarning, refuseWarning, voidWarning,
} from '../_lib/hrWarnings/store.js';

// Per person: reading one's own warning in another language a few times, never a loop. It
// spends a paid API, so it is bounded like the template drafts (api/i18n).
export const TRANSLATE_RATE = { limit: 20, windowMs: 10 * 60 * 1000 };

// The org's calendar day (a falsy zone resolves to the org default inside lib/dates).
async function orgToday(now = Date.now()) {
  try {
    const data = await readProtectedSlices('company:state->company');
    return dayKey(new Date(now), (data && data.company && data.company.timezone) || null);
  } catch {
    return dayKey(new Date(now), null);
  }
}

// An active office member on the committed roster, or null.
const activeOfficeMember = (roster, id) => {
  const u = (Array.isArray(roster) ? roster : []).find((x) => x && x.id === id);
  return u && u.status === 'active' && SUPERVISOR_ROLES.includes(u.role) ? u : null;
};

// The employee's bell when a warning is issued — written server-side, so they hear even with
// no tab open (the every-minute push cron delivers it to their phone). CAS-guarded and fully
// best-effort: a failure here must never fail the warning already on file. Skipped when the
// supervisor is about to take the signature in person on their own device.
async function notifyEmployee(warning, actorUserId, tries = 4) {
  try {
    for (let i = 0; i < tries; i += 1) {
      const { state, version } = await readOrgState();
      const base = { ...state, notifications: state.notifications || [] };
      const notifications = fanOutToUserIds(base, {
        userIds: [warning.employeeUserId],
        eventKey: HR_WARNING_SIGN_EVENT,
        title: msg('alerts.hrWarning.issuedTitle'),
        body: msg('alerts.hrWarning.issuedBody'),
        url: warningSignUrl(warning.id),
        actorUserId: actorUserId || null,
      });
      if (notifications === base.notifications) return { sent: false };
      if (await writeOrgState({ ...state, notifications }, version)) return { sent: true };
    }
    return { sent: false, reason: 'cas-exhausted' };
  } catch (err) {
    reportError('hr-warnings.notify', err);
    return { sent: false, reason: 'error' };
  }
}

export default function handler(req, res) {
  return withRequestCache(() => hrWarningsHandler(req, res));
}

async function hrWarningsHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const body = req.body || {};
  const [head, tail] = path;

  try {
    // ── reads ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (head === 'list') {
        const g = await requirePermission(req, res, 'hr.view');
        if (!g) return;
        const employeeUserId = typeof req.query.employeeId === 'string' && req.query.employeeId ? req.query.employeeId : null;
        return res.status(200).json({ warnings: await listWarnings({ employeeUserId }), today: await orgToday() });
      }
      if (head === 'mine') {
        const a = await requireAuthority(req, res);
        if (!a) return;
        // A login with no team identity has no warnings — never "everyone's".
        if (!a.orgUserId) return res.status(200).json({ warnings: [], today: await orgToday() });
        return res.status(200).json({ warnings: await listWarnings({ employeeUserId: a.orgUserId }), today: await orgToday() });
      }
      if (isWarningId(head) && !tail) {
        const a = await requireAuthority(req, res);
        if (!a) return;
        const w = await getWarning(head);
        const mayRead = w && (w.employeeUserId === a.orgUserId || await holdsPermission(a, 'hr.view'));
        if (!mayRead) return res.status(404).json({ error: 'Warning not found' });
        return res.status(200).json({ warning: w });
      }
      return res.status(404).json({ error: 'Unknown route' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── issue ───────────────────────────────────────────────────────────────
    if (head === 'create') {
      const g = await requirePermission(req, res, 'hr.edit');
      if (!g) return;
      const now = Date.now();
      const roster = await readRosterUsers();
      const { warning, created } = await createWarning(body, {
        actor: g.orgUserId, roster, today: await orgToday(now), now,
      });
      // The employee hears now unless the supervisor is about to take the signature in
      // person (then the one-day reminder is still the safety net).
      const notified = created && body.notifyEmployee !== false ? await notifyEmployee(warning, g.orgUserId) : { sent: false };
      return res.status(200).json({ warning, created, notified: !!notified.sent });
    }

    if (!isWarningId(head)) return res.status(404).json({ error: 'Unknown route' });

    // ── the employee's signature: their own, or taken in person ──────────────
    if (tail === 'acknowledge') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      const w = await getWarning(head);
      const own = !!w && !!a.orgUserId && w.employeeUserId === a.orgUserId;
      // In person = an hr.edit holder's device, with the employee beside them.
      const inPerson = !own && !!w && await holdsPermission(a, 'hr.edit');
      if (!own && !inPerson) return res.status(404).json({ error: 'Warning not found' });
      const warning = await acknowledgeWarning(head, { signature: body.signature, comment: body.comment, inPerson });
      return res.status(200).json({ warning });
    }

    // ── HR-3: refused to sign → the HR manager signs ─────────────────────────
    if (tail === 'refuse') {
      const g = await requirePermission(req, res, 'hr.edit');
      if (!g) return;
      const hrManager = activeOfficeMember(await readRosterUsers(), body.hrManagerUserId);
      if (!hrManager) throw new WarningRefusal('hr-manager-missing');
      const warning = await refuseWarning(head, { hrManager, signature: body.signature });
      return res.status(200).json({ warning });
    }

    // ── void: the owner only ─────────────────────────────────────────────────
    if (tail === 'void') {
      // Held by ROLE (claims-first, from requireAuthority), never by a grant.
      const g = await requireAuthority(req, res);
      if (!g) return;
      if (g.role !== 'owner') return res.status(403).json({ error: 'Only the Super Admin can void a warning.' });
      const roster = await readRosterUsers();
      const me = (Array.isArray(roster) ? roster : []).find((u) => u && u.id === g.orgUserId) || { id: g.orgUserId, name: null };
      const warning = await voidWarning(head, { reason: body.reason, voidedBy: me });
      return res.status(200).json({ warning });
    }

    // ── Translate, for the employee reading it (Google, on demand, nothing stored) ──
    if (tail === 'translate') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      const lang = body.lang;
      if (!MACHINE_LANGUAGES.includes(lang)) return res.status(400).json({ error: `lang must be one of ${MACHINE_LANGUAGES.join(', ')}` });
      const w = await getWarning(head);
      const mayRead = w && (w.employeeUserId === a.orgUserId || await holdsPermission(a, 'hr.view'));
      if (!mayRead) return res.status(404).json({ error: 'Warning not found' });
      // Off is said BEFORE the rate limit is spent: asking while it is off costs nothing.
      if (!machineConfigured()) {
        return res.status(503).json({ error: 'Translation is not available yet.', code: 'machine-translation-off' });
      }
      if (!allow(req, res, { bucket: 'hr-warning-translate', id: a.orgUserId || a.email, ...TRANSLATE_RATE })) return;
      // Only the warning's OWN words — never caller text — so this is no free translation proxy.
      const fields = ['whatHappened', 'whatMustChange', 'reasonOther'].filter((k) => typeof w[k] === 'string' && w[k].trim());
      try {
        const out = fields.length ? await machineTranslate(fields.map((k) => w[k].trim()), lang) : [];
        return res.status(200).json({ lang, texts: Object.fromEntries(fields.map((k, i) => [k, out[i]])) });
      } catch (err) {
        const code = err instanceof MachineTranslateError ? err.code : 'machine-translation-failed';
        if (code === 'machine-translation-off') return res.status(503).json({ error: 'Translation is not available yet.', code });
        reportError('hr-warnings.translate', new Error(code), { lang });
        return res.status(502).json({ error: 'The translation did not come back. Try again in a moment.', code });
      }
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    if (e instanceof WarningRefusal) return res.status(e.status).json({ error: e.message, code: e.code });
    const status = readErrorStatus(e);
    if (status !== 500) return res.status(status).json({ error: e.message });
    console.error('[api/hr-warnings]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
