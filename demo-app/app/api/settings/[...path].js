// Catch-all for the Integrations/Webhooks area (one serverless function → 12 total).
// Admin (JSON):  GET/POST /webhooks, PATCH/DELETE /webhooks/:id,
//                GET/POST /outbound, PATCH/DELETE /outbound/:id,
//                GET /snapshot
// Public inbound: POST /inbound/:slug  (HMAC-verified; financial_snapshot → upsert)
// bodyParser disabled so the inbound HMAC verifies the raw body; admin routes
// read + JSON.parse the raw body manually.
import {
  listEndpoints, createEndpoint, updateEndpoint, deleteEndpoint, getEndpointBySlug, touchEndpoint, rotateToken,
  listOutbound, createOutbound, updateOutbound, deleteOutbound,
  recordDelivery, getSnapshot, upsertSnapshot,
} from '../_lib/integrations/store.js';
import { verifyInbound } from '../_lib/integrations/hmac.js';
import {
  createUserAccount, deleteUserAccount, setUserDisabled, getAuthoritativeRoleByEmail, sendPasswordResetLink,
  syncUserClaims, listOrphanLogins, hasOtherActiveOwnerLogin, ROSTER_UNREADABLE,
  listAllLogins, pickSignIns, loginTarget,
} from '../_lib/users.js';
import { systemSenderReady } from '../_lib/email.js';
import { VALID_ROLES, isOrgUserId } from '../_lib/claims.js';
import { resolveAuthority, permissionChecker, requireAuthority } from '../_lib/authz.js';
import { readOrgState, writeOrgState, readProtectedSlices } from '../_lib/orgState.js';
import { reconcileSelfDecision } from '../_lib/reconcile.js';
import { loginRefusal, linkHandoverRefusal, matrixAuthority, owedPayFor } from '../_lib/teamAuthority.js';
import { removalPayFacts } from '../_lib/memberRemoval.js';
import { removeFromRoster } from '../_lib/rosterRemoval.js';
import { smsStatus } from '../_lib/sms/twilio.js';
import { reportError } from '../_lib/monitor.js';
import { appPublicUrl } from '../_lib/appUrl.js';

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(''));
  });
}
const json = (raw) => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };

// What a reader WITHOUT integrations.manage gets of each webhook row. An allowlist, not a
// denylist: the credential columns (signing_secret, a lead's bearer_token, an outbound
// secret) let their holder sign a delivery or authorize one, and a column added later stays
// out until someone decides it is safe to show. These are the fields the Integrations page
// renders.
const VIEW_FIELDS = {
  endpoints: ['id', 'organization_id', 'name', 'slug', 'purpose', 'is_active', 'lead_config', 'last_received_at', 'created_by', 'created_at', 'updated_at'],
  outbound: ['id', 'organization_id', 'url', 'event_types', 'is_active', 'created_by', 'created_at', 'updated_at'],
};
const viewable = (rows, fields) => (rows || []).map((row) => Object.fromEntries(
  fields.filter((k) => Object.prototype.hasOwnProperty.call(row, k)).map((k) => [k, row[k]]),
));

// Self-heal for the orphan-login lockout (2026-08-03). A session whose IDENTITY
// AND ROLE both resolve from the tamper-proof JWT claim may materialize its OWN
// roster row when the browser-writable roster lost it (a CAS-race on member-add,
// a stale-tab clobber). This makes member creation eventually-atomic: the
// fragile second write (the blob roster row) can no longer strand a login.
// STRICTLY ADD-ONLY + CLAIM-GATED:
//   • claim-sourced identity AND role only — a blob-derived session can't launder
//     itself a roster row (that was the original self-escalation surface);
//   • no-op if the id is already present, or the email is bound to a DIFFERENT id
//     (a split/dangling case — left for an owner + the audit canary, never a
//     second duplicate row);
//   • never edits an existing row, so it can't downgrade or overwrite anyone;
//   • single-shot CAS on org_state.version — a lost race returns reconciled:false
//     and simply retries on the next authenticated load (no blind retry).
// Reachable by ANY claim-backed session (crew included) — it is exactly the case
// where the roster is broken, so it must not sit behind the owner/admin gate.
async function reconcileSelf(req, res) {
  const a = await resolveAuthority(req);
  if (!a) return res.status(401).json({ error: 'Authentication required' });
  if (a.idSource !== 'claim' || a.roleSource !== 'claim' || !VALID_ROLES.includes(a.role) || !isOrgUserId(a.orgUserId)) {
    return res.status(200).json({ ok: true, reconciled: false, reason: 'no-claim' });
  }
  const { state, version } = await readOrgState();
  const decision = reconcileSelfDecision({ users: state.users, orgUserId: a.orgUserId, email: a.email, role: a.role });
  if (!decision.reconciled) return res.status(200).json({ ok: true, reconciled: false, reason: decision.reason });
  const row = { ...decision.row, createdAt: new Date().toISOString() };
  // `prev`: this adds a roster row (a protected change), so writeOrgState needs the read it
  // was made from to keep the org_state digest current instead of raising a baseline alarm.
  const wrote = await writeOrgState({ ...state, users: [...(state.users || []), row] }, version, { prev: state });
  return res.status(200).json({ ok: true, reconciled: !!wrote });
}

// The committed slices the login routes decide from: the roster (who the target is, their
// role, the Super Admins) and the matrix + overrides (what the caller holds). One read.
const TEAM_SELECT = 'users:state->users,permissions:state->permissions,'
  + 'userPermissionOverrides:state->userPermissionOverrides,company:state->company';

const emailKey = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

// The member a login route acts on is users.js loginTarget (shared with a termination turning a
// login off, api/_lib/hrTerminations/access.js).

// Whether the roster keeps a Super Admin row that is not the target's.
function otherOwnerRow(roster, target) {
  const ids = new Set(target.rows.map((r) => r.id));
  return (Array.isArray(roster) ? roster : []).some((u) => u && u.role === 'owner'
    && !ids.has(u.id) && emailKey(u.email) !== emailKey(target.email));
}

// The pay rule for a removal: every id the member's records can be keyed by (their roster
// rows, and their claimed id, which a lost roster row leaves behind). A check that can't
// run refuses ('unchecked', a 409) and is reported: a ledger that stays unreadable would
// otherwise refuse every removal with nobody told why.
async function owedPayOnRemoval(committed, target) {
  const ids = [...new Set([...target.rows.map((r) => r.id), target.claimOrgUserId].filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return null;
  try {
    const facts = await removalPayFacts(committed, ids);
    for (const id of ids) {
      const code = owedPayFor(committed, facts, id);
      if (code) return code;
    }
    return null;
  } catch (e) {
    reportError('team.removal_pay_check_failed', e, { ids: ids.length });
    return 'unchecked';
  }
}

// 🔴 THE BRANCH ABOVE THE LOGIN (CS-648's family, the CS-077 class): `inbound/:slug` answers
// callers with no session, so a failure there is a sentence and a stable code, never the
// provider's words (a table name) — the detail is logged, as the public scan page does
// (api/public/scan). Every branch below the login keeps this file's catch-all. (The other public
// branch, the Places rating card, left with Google reviews on 2026-10-20.)
export const PUBLIC_SETTINGS_ERRORS = Object.freeze({
  // 5xx so a sender (a Google Sheet's script, Zapier) retries, as api/webhooks does.
  inbound: Object.freeze({ status: 500, code: 'inbound-failed', error: 'This delivery could not be processed just now. Please retry.' }),
});

export default async function handler(req, res) {
  // Vercel doesn't match multi-segment catch-alls on this project, so vercel.json
  // rewrites multi-seg paths in via ?subpath=. Single-seg still hits the catch-all
  // directly (req.query.path). Handle both.
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
    : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [seg0, seg1] = path;
  try {
    // ── public inbound receiver ──────────────────────────────────────────
    if (seg0 === 'inbound') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      try {
        const slug = seg1;
        const ep = await getEndpointBySlug(slug);
        if (!ep || !ep.is_active) return res.status(404).json({ error: 'Endpoint not found' });
        const raw = await readRaw(req);
        const sig = req.headers['x-cleanspace-signature'] || req.headers['x-webhook-signature'];
        if (!verifyInbound(raw, sig, ep.signing_secret)) {
          await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: false, statusCode: 401, error: 'bad signature' });
          return res.status(401).json({ error: 'Invalid signature' });
        }
        const body = json(raw);
        if (ep.purpose === 'financial_snapshot') {
          // Pass the whole payload through; upsertSnapshot writes only the known
          // dashboard metric keys (financial + goals + operational), so a partial
          // push doesn't clobber the others.
          await upsertSnapshot({ ...body, source: body.source || 'google_sheet' });
        }
        await touchEndpoint(ep.id);
        await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: true, statusCode: 200 });
        return res.status(200).json({ ok: true });
      } catch (e) {
        // No login on this branch: the detail is logged, the sender gets a sentence and a code.
        console.error('[api/settings] inbound', e?.code || e?.name || 'error', e?.message || '');
        const { status, code, error } = PUBLIC_SETTINGS_ERRORS.inbound;
        return res.status(status).json({ error, code });
      }
    }

    // Everything below is admin configuration → require a team member's session (a
    // Disabled member is refused here too: authz.js ROSTER STATUS).
    if (!(await requireAuthority(req, res))) return;

    // Self-heal (claim-gated, add-only) — MUST precede the `users` section below,
    // whose per-action gates would refuse it, so a crew orphan can repair its own
    // missing roster row.
    if (seg0 === 'users' && seg1 === 'reconcile-self' && req.method === 'POST') {
      return await reconcileSelf(req, res);
    }

    // ── team logins — the real Supabase account behind a team member: its JWT claims
    //    (role, u_* id), its ban, its existence, its reset link. WHO MAY DO WHAT is
    //    _lib/teamAuthority.js loginRefusal, the rules the org_state guard applies to
    //    the roster (owner's decisions, 2026-09-23). Each action passes for the role
    //    list that always could, or for whoever holds the key the app gates it on in
    //    the COMMITTED matrix + overrides, within limits held by role and identity:
    //      invite  owner+admin | settings.team.edit    role  owner | staff.assignRoles
    //      disable owner | settings.team.edit          remove owner | settings.team.edit
    //      reset   owner+admin | staff.resetPassword   orphans owner+admin | settings.team.edit
    //      sign-ins owner+admin | settings.team.edit (GET: who never signed in, who has no login)
    //    Only a Super Admin makes, re-roles, disables, removes or re-invites a Super
    //    Admin; nobody changes their own role (a Super Admin neither); nobody removes
    //    themselves but a Super Admin who leaves another; a role is given only by
    //    someone who holds everything it carries (lib/roles canGiveRole); nobody is
    //    removed while they may be owed pay; and a Super Admin can't leave the org
    //    without one. requirePermission alone is NOT this: can() puts no key out of
    //    a grant's reach (authz.js). ───────────────────────────────────────────────
    if (seg0 === 'users') {
      // Authority from the JWT claim (service-role-only), not the browser-
      // writable blob — see _lib/authz.js resolveAuthority.
      const caller = await resolveAuthority(req);
      if (!caller?.role) return res.status(403).json({ error: "Your access level doesn't allow you to manage logins." });
      // CLAIM-BACKED AUTHORITY REQUIRED FOR THIS WHOLE SECTION. Every route here
      // either mints a claim (create), rewrites one (claims), or destroys access
      // (delete/disable/reset-link). If blob-derived authority were accepted, a
      // crew user who edits the browser-writable roster to make themselves owner
      // could launder that into a permanent, service-role-signed owner claim —
      // one that survives the blob being restored AND the coming RLS lockdown.
      // Bootstrap is the service-role backfill script, never this endpoint.
      // A login still without a role claim (a manager stamped before claims.js knew
      // the role) is refused here until the backfill stamps it.
      if (caller.roleSource !== 'claim') {
        return res.status(403).json({ error: 'Managing logins requires a claim-backed session. Run the JWT claim backfill first.' });
      }
      const committed = (await readProtectedSlices(TEAM_SELECT)) || {};
      // The matrix path keys overrides and "yourself" on the caller's u_* id, so it counts
      // only when that id is a claim too; a blob-derived id (the writable email → id map)
      // reads as no id, i.e. the role's defaults with no overrides.
      const claimId = caller.idSource === 'claim' && isOrgUserId(caller.orgUserId) ? caller.orgUserId : null;
      const who = { role: caller.role, orgUserId: claimId, email: caller.email, claimIdentity: !!claimId };
      const authority = matrixAuthority(committed, caller.role, claimId);
      const refused = (no) => res.status(no.status).json({ error: no.error, ...(no.code ? { code: no.code } : {}) });

      // Logins with no roster row. Read-only; it returns member email addresses, which
      // is not a public list, so it follows who may invite (the Team page shows the
      // banner to settings.team.edit). The repair is an ordinary invite:
      // createUserAccount adopts an orphan instead of failing.
      if (req.method === 'GET' && seg1 === 'orphans') {
        const no = loginRefusal('orphans', { caller: who, authority });
        if (no) return refused(no);
        try {
          return res.status(200).json({ orphans: await listOrphanLogins() });
        } catch (e) {
          return res.status(500).json({ error: e.message || 'Could not read logins.' });
        }
      }
      // Who on the team has never signed in, and who has no login at all (CS-661, S128): a member
      // invited while email is off holds a login nobody used, and the roster says Active. The same
      // reach as the orphan list (member addresses, not a public list); no-store.
      if (req.method === 'GET' && seg1 === 'sign-ins') {
        const no = loginRefusal('signIns', { caller: who, authority });
        if (no) return refused(no);
        try {
          res.setHeader('Cache-Control', 'no-store');
          return res.status(200).json(pickSignIns(await listAllLogins(), committed.users));
        } catch (e) {
          return res.status(500).json({ error: e.message || 'Could not read logins.' });
        }
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const action = !seg1 ? 'invite' : { claims: 'role', disable: 'status', delete: 'remove', 'reset-link': 'reset' }[seg1];
      if (!action) return res.status(405).json({ error: 'Method not allowed' });
      const b = json(await readRaw(req));
      const email = (b.email || '').trim();
      if (!email) return res.status(400).json({ error: 'email is required' });
      // Validate BEFORE any gate: an unrecognized role (e.g. "Owner") used to slip past
      // the === 'owner' comparison and then get silently dropped from the claims,
      // minting a claim-less login stuck on the tamperable blob fallback.
      const newRole = action === 'invite' ? (b.role == null ? 'crew' : b.role) : action === 'role' ? (b.role ?? null) : null;
      if (newRole != null && !VALID_ROLES.includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
      if ((action === 'invite' || action === 'role') && b.orgUserId != null && !isOrgUserId(b.orgUserId)) {
        return res.status(400).json({ error: 'Invalid org user id' });
      }

      const target = await loginTarget(email, committed.users);
      const facts = {
        caller: who, authority, target, newRole,
        orgUserId: action === 'role' ? (b.orgUserId ?? null) : null,
        disabled: b.disabled !== false,
      };
      // A reset link is refused on the target's AUTHORITATIVE role: the claim, else the
      // roster's (an Admin could always reset anyone but a Super Admin).
      if (action === 'reset') facts.target = { ...target, authoritativeRole: await getAuthoritativeRoleByEmail(email) };
      // A Super Admin never leaves the org without one: the roster keeps a Super Admin row
      // (role, remove), and one who can still sign in remains (disable, remove).
      if (caller.role === 'owner' && (action === 'role' || action === 'remove')) facts.otherOwnerRow = otherOwnerRow(committed.users, target);
      if (caller.role === 'owner' && (action === 'status' || action === 'remove')) facts.otherOwnerLogin = await hasOtherActiveOwnerLogin(target.authUserId);
      let no = loginRefusal(action, facts);
      if (no) return refused(no);
      // Removal: the pay check reads the pay slices and the time ledger, so it runs only
      // once the caller is allowed, then decides again (a 409 when pay may be owed).
      if (action === 'remove') {
        no = loginRefusal(action, { ...facts, owedPay: await owedPayOnRemoval(committed, target) });
        if (no) return refused(no);
      }

      // Where the member lands from the emailed link (an invite's or a reset's): the app's /login, which
      // detects the recovery session and shows a set-new-password form. The app's own address from
      // configuration (_lib/appUrl.js), never this request's Host (DEV_PLAYBOOK 3.4.18), so it can't be
      // redirected to an arbitrary origin and an office user on an old alias doesn't send people there.
      const loginUrl = `${appPublicUrl()}/login`;
      // 🔴 WHEN THE SET-PASSWORD EMAIL CAN'T GO (CS-661, S128): no sending mailbox is connected in
      // the live app, so an invite or a reset answers the one-time link to the caller, who sends it
      // to the member themselves (GO-10's shape, staff's too now; a link is never texted, since
      // 2026-10-28). The link signs in AS the member, so it is handed over
      // only to someone who already holds everything the member holds (teamAuthority
      // linkHandoverRefusal); the answer that carries it is no-store and it is never logged.
      const memberAs = (role, ids) => ({ role: role ?? null, ids: [...new Set(ids.filter((id) => typeof id === 'string' && id))] });
      const handOverRefusal = (member) => linkHandoverRefusal({ authority, callerRole: caller.role, member });
      if (action === 'invite') {
        let out;
        try {
          out = await createUserAccount(email, loginUrl, { role: newRole, orgUserId: b.orgUserId });
        } catch (e) {
          // Identity-collision rejections are a conflict, not a server fault; a roster the
          // adoption couldn't read is a retry (nothing was changed).
          return res.status(e?.code === ROSTER_UNREADABLE ? 503 : 409).json({ error: e.message || 'Could not create the login.' });
        }
        if (out.link) {
          // The login exists either way; only the link is withheld from someone who may not hold it.
          if (handOverRefusal(memberAs(newRole, [out.orgUserId]))) {
            const rest = { ...out };
            delete rest.link;
            return res.status(200).json({ ...rest, linkWithheld: true });
          }
          res.setHeader('Cache-Control', 'no-store');
        }
        return res.status(200).json(out);
      }
      // Re-stamp the JWT trust-root claims (role / org user id) for an existing member:
      // the server-side mirror of a Settings → Team role change. Rebinding `org_user_id`
      // repoints a login at another member's CRM identity, and every gate keys off that
      // claim, so only a Super Admin may re-link one (loginRefusal 'rebind').
      if (action === 'role') {
        try {
          return res.status(200).json(await syncUserClaims(email, { role: b.role, orgUserId: b.orgUserId }));
        } catch (e) {
          return res.status(409).json({ error: e.message || 'Could not update the access level.' });
        }
      }
      // Removal also deletes the member's photo folder and signature image (UI_RULES §141,
      // CS-627), under every id they were known by: the same id set the pay check used.
      // 🔴 And takes them off the shared record in this same request (CS-969): the roster row used
      // to wait for the tab's next save, which a page left in time never sent. The login goes
      // FIRST: a roster row removed while the login lived would be put back by reconcile-self.
      // A record write that can't land is reported and answered `roster.pending`; the tab's own
      // DELETE_USER still carries it, as before, and Remove can be pressed again.
      if (action === 'remove') {
        const orgUserIds = [...target.rows.map((r) => r.id), target.claimOrgUserId].filter((id) => typeof id === 'string' && id);
        const out = await deleteUserAccount(email, { orgUserIds });
        let roster;
        try {
          roster = await removeFromRoster(target.rows.map((r) => r.id));
        } catch (e) {
          reportError('team.remove_roster_failed', e, { note: 'the login is deleted but the member is still on the roster until the tab saves or Remove is pressed again', caller: who.orgUserId || who.email || null });
          roster = { pending: true };
        }
        return res.status(200).json({ ...out, roster });
      }
      if (action === 'status') return res.status(200).json(await setUserDisabled(email, b.disabled !== false));
      // reset: emailed when a mailbox can send it; otherwise handed to this caller if they may hold
      // it. A new link VOIDS the member's last one, so none is made when it could only be thrown away.
      // The same users.js step as the sign-in page's "Forgot password?" (api/public/auth); only this
      // office call asks for the hand-over.
      const withheld = handOverRefusal(memberAs(facts.target.authoritativeRole, [target.claimOrgUserId, ...target.rows.map((r) => r.id)]));
      if (withheld && !(await systemSenderReady())) return refused(withheld);
      const sent = await sendPasswordResetLink(email, loginUrl, { handOver: true });
      if (sent.emailed === false) {
        if (withheld) return refused(withheld);
        res.setHeader('Cache-Control', 'no-store');
      }
      return res.status(200).json(sent);
    }

    // ── integrations config — integrations.view reads, integrations.manage changes ──
    // These three were requireAuth-only, so all 37 crew accounts could read
    // them. Verified live against prod with a crew session: GET
    // /api/settings/webhooks returned 200 including `signing_secret`
    // ("whsec_..."). That secret is NOT in the org_state blob, so unlike most
    // data here it was NOT already reachable via the open RLS — this route was
    // its only exposure, and holding it lets anyone forge signed inbound
    // webhook payloads (e.g. push fabricated revenue into the dashboard via the
    // financial_snapshot endpoint below).
    //
    // So the gate follows the app's Integrations page, read from the committed matrix +
    // per-user overrides (owner's call, 2026-09-23): reading the lists needs
    // integrations.view (the page's own gate); every change needs integrations.manage;
    // and the secrets and lead tokens go only to integrations.manage (anyone else reads the
    // VIEW_FIELDS of each row, and the page offers Copy only for a secret it was sent). The
    // Super Admin passes all of it by role, as before (never tightened). It was Super Admin
    // only until then, which refused the 4th-tier manager (integrations.* default to
    // owner + manager). Client callers are src/lib/integrationsApi.js from the
    // Integrations settings page — no crew flow touches these.
    //
    // 🔴 `snapshot` IS GATED NOW (CS-019). It used to be deliberately excluded, on the
    // grounds that SnapshotSync was mounted for every authenticated user and the figures
    // were readable in the blob anyway — so gating it "would break every client to hide
    // nothing". Both halves of that have moved: the figures are company REVENUE, MRR,
    // outstanding-quote value and ACCOUNTS RECEIVABLE, which Q24 hides from Admin and from
    // crew entirely, and the blob is no longer the crew's to read (CS-002 serves them a
    // projection via /api/state/view). Leaving a second, ungated door to the same numbers
    // is the whole finding. The client half rides with it — App.jsx mounts SnapshotSync
    // only for holders of `invoices.view` — so no tab 403s every 60 s.
    //
    // The key is the one the invoice surfaces already use, so server and UI agree by
    // construction: Super Admin by role, anyone holding `invoices.view` under the
    // COMMITTED matrix + per-user overrides (so a per-person grant works here too).
    const FINANCIAL_KEY = 'invoices.view';
    let showSecrets = false;
    if (seg0 === 'snapshot') {
      const a = await resolveAuthority(req);
      if (!a) return res.status(401).json({ error: 'Unauthorized' });
      let holds = () => false;
      if (a.role !== 'owner') {
        try {
          holds = await permissionChecker(a);
        } catch {
          // A gate that cannot read its inputs fails closed.
          return res.status(500).json({ error: 'Authorization check failed' });
        }
      }
      if (!(a.role === 'owner' || holds(FINANCIAL_KEY))) {
        return res.status(403).json({ error: 'Viewing company financials needs the View Invoices permission.' });
      }
    }
    // ── the ALERT-TEXT channel's real state (NTF-1 / CS-069 / CS-038) ─────
    // 🔴 The Twilio card used to be able to say "Connected" off a browser-writable blob field a
    // stub had set (CS-038). This is the server's OWN answer: is a Twilio account, token and
    // sender actually provisioned in the environment? PRESENCE ONLY — env NAMES and the kind of
    // sender, never a value, not even masked (THE LAW II.9). Read-only, so it follows the same
    // `integrations.view` gate as the rest of this page, owner by role.
    if (seg0 === 'sms-status') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const a = await resolveAuthority(req);
      if (a?.role !== 'owner') {
        let holds;
        try { holds = await permissionChecker(a); } catch { return res.status(500).json({ error: 'Authorization check failed' }); }
        if (!holds('integrations.view')) {
          return res.status(403).json({ error: 'Viewing integrations needs the View integrations permission.' });
        }
      }
      return res.status(200).json(smsStatus());
    }

    if (seg0 === 'webhooks' || seg0 === 'outbound') {
      const a = await resolveAuthority(req);
      const isOwner = a?.role === 'owner';
      let holds = () => false;
      if (!isOwner) {
        try {
          holds = await permissionChecker(a);
        } catch {
          // A gate that cannot read its inputs fails closed.
          return res.status(500).json({ error: 'Authorization check failed' });
        }
      }
      const mayManage = isOwner || holds('integrations.manage');
      if (req.method === 'GET' ? !(isOwner || holds('integrations.view')) : !mayManage) {
        return res.status(403).json({
          error: req.method === 'GET'
            ? 'Viewing integrations needs the View integrations permission.'
            : 'Changing integrations needs the Connect / manage integrations permission.',
        });
      }
      showSecrets = mayManage;
    }

    // ── admin: inbound endpoint config ───────────────────────────────────
    if (seg0 === 'webhooks') {
      if (!seg1) {
        if (req.method === 'GET') {
          const endpoints = await listEndpoints();
          return res.status(200).json({ endpoints: showSecrets ? endpoints : viewable(endpoints, VIEW_FIELDS.endpoints) });
        }
        if (req.method === 'POST') {
          const b = json(await readRaw(req));
          return res.status(200).json({ endpoint: await createEndpoint({ name: b.name, purpose: b.purpose, leadConfig: b.lead_config }) });
        }
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (req.method === 'PATCH') {
        const b = json(await readRaw(req));
        // Rotate the lead-webhook bearer token (returns the new token to show + copy).
        if (b.rotate === true) {
          const { token } = await rotateToken(seg1);
          return res.status(200).json({ ok: true, bearer_token: token });
        }
        const patch = {};
        if (typeof b.is_active === 'boolean') patch.is_active = b.is_active;
        if (typeof b.name === 'string') patch.name = b.name;
        if (b.lead_config && typeof b.lead_config === 'object') patch.lead_config = b.lead_config;
        await updateEndpoint(seg1, patch);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') { await deleteEndpoint(seg1); return res.status(200).json({ ok: true }); }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── admin: outbound webhooks ─────────────────────────────────────────
    if (seg0 === 'outbound') {
      if (!seg1) {
        if (req.method === 'GET') {
          const outbound = await listOutbound();
          return res.status(200).json({ outbound: showSecrets ? outbound : viewable(outbound, VIEW_FIELDS.outbound) });
        }
        if (req.method === 'POST') {
          const b = json(await readRaw(req));
          const url = typeof b.url === 'string' ? b.url.trim() : '';
          if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'A valid http(s) URL is required' });
          return res.status(200).json({ webhook: await createOutbound({ url, eventTypes: b.eventTypes }) });
        }
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (req.method === 'PATCH') {
        const b = json(await readRaw(req));
        const patch = {};
        if (typeof b.is_active === 'boolean') patch.is_active = b.is_active;
        if (typeof b.url === 'string') patch.url = b.url.trim();
        await updateOutbound(seg1, patch);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') { await deleteOutbound(seg1); return res.status(200).json({ ok: true }); }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (seg0 === 'snapshot' && req.method === 'GET') {
      return res.status(200).json({ snapshot: await getSnapshot() });
    }
    // GET /deliveries was DELETED (CS-220, 2026-09-29): nothing in the app ever called it.
    // The delivery log is still WRITTEN (recordDelivery, below) - it is the audit trail a
    // webhook's own retry logic needs; only the unused read is gone.

    res.status(404).json({ error: 'Unknown route' });
  } catch (err) {
    console.error('[api/settings]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
