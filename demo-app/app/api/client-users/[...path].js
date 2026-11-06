// CLIENT LOGINS — the OFFICE side of the customer hub (HUB-1/3/4/14/17, GO-10).
//
//   GET  /api/client-users/list                     -> { users, groups, groupMembers, assignments }
//   GET  /api/client-users/for-client?clientId=cl_x -> { direct[], viaGroup[] } — who can see one building
//   POST /api/client-users/save      { id?, name, email, phone }      -> { user }
//   POST /api/client-users/assign    { id, clientIds[], groupIds[], base: { clientIds[], groupIds[] } } -> { assignments }
//   POST /api/client-users/invite    { id }                           -> { user, invited, adopted, why?, link? }
//   POST /api/client-users/status    { id, status }                   -> { user, loginBanned, loginKept? }
//   POST /api/client-users/remove    { id }                           -> { ok, loginRemoved, loginKept? }
//   POST /api/client-users/group-save   { id?, name, kind, clientIds[], baseClientIds[] (an existing group) } -> { group, members }
//   POST /api/client-users/group-remove { id }                        -> { ok }
//
// AUTH: `hub.users.view` to read, `hub.users.manage` to write — the same keys the screens
// gate on, read from the committed matrix (requirePermission). Both default to
// owner/admin/manager and NEVER crew: a cleaner must not be able to hand someone a login.
// Every one of these calls also refuses a CLIENT login, because requirePermission runs
// requireAuthority, which refuses role 'client' outright (_lib/authz.js) — a client user can
// never administer client users, their own row included.
//
// 🔴 THE INVITE'S `link` IS A CAPABILITY. /invite answers with the one-time set-password URL
// when nothing was emailed, so the office can send it themselves while no system sender is
// connected (GO-10). It is gated on hub.users.manage, the response is no-store, and it is never
// logged or stored.
//
// 🔴 A LOGIN IS TOUCHED ONLY WHEN ITS CLAIMS PROVE IT IS THIS CONTACT'S (CS-660 / CS-706, S128).
// Remove and Disable used to find "the login" by the contact's ADDRESS and ban and delete it — so
// a contact saved with a staff address banned and deleted that staff login, and the live app has
// one, shared, office login. Now: Save refuses an address on the team roster or held by any login
// that is not a customer's; Remove and Disable act only on a login whose claims say role client
// and THIS row (users.js customerLoginOf), touch nothing else and say so; the invite adopts a
// login only when it is already this contact's, or claim-less on no roster (resolveClientAdoption).
//
// 🔴 EVERY READ IS COMPLETE AND A SAVE NEVER REPLACES WHAT THE SCREEN DIDN'T LOAD (CS-662). The
// lists are read whole (store.js allRows); `assign` and an existing group's `group-save` replace a
// set only when the request names the set the screen loaded (`base` / `baseClientIds`) and it is
// still the stored one — else 409 `stale` (someone changed it) or `reload` (an old screen).
import { requirePermission } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import {
  createClientUserAccount, findAuthUserByEmail, emailOnRoster, customerLoginOf, setCustomerLoginBanned,
  setLoginBannedById, ROSTER_UNREADABLE,
} from '../_lib/users.js';
import { getSupabase } from '../_lib/supabase.js';
import { appPublicUrl } from '../_lib/appUrl.js';
import {
  listClientUsers, getClientUserById, getClientUserByEmail, insertClientUser, updateClientUser,
  deleteClientUser, listGroups, insertGroup, updateGroup, deleteGroup, listGroupMembers,
  setGroupMembers, listAssignments, setAssignments, buildingAudience,
} from '../_lib/clientHub/store.js';
import {
  CLIENT_USER_STATUSES, CLIENT_ROLE, isClientGroupKind, clientUserHasAccess, isPreviewStandIn,
} from '../../src/lib/clientHub.js';
import { isHubPreviewEmail } from '../../src/lib/hubPreview.js';

// 🔴 THE OFFICE PREVIEW'S STAND-INS ARE NOT CUSTOMER LOGINS (2026-10-09). The hub route keeps one
// client_users row per previewed building (status 'preview', store.js ensurePreviewStandIn) so the
// office's preview can act as a customer. This family never shows one (listClientUsers leaves them
// out), never touches one (every write below reads its row through officeRow, which answers as if
// it isn't there), and never creates a login at the reserved preview address.
async function officeRow(id) {
  const row = await getClientUserById(id);
  return row && !isPreviewStandIn(row) ? row : null;
}

const VIEW = 'hub.users.view';
const MANAGE = 'hub.users.manage';
const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_PHONE = 40;
const MAX_IDS = 2000; // 750 buildings today; a group may name every one of them

const text = (v, max) => {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
};
// A customer id from the shared record. Validated because it goes into a WHERE and into a
// grant — never raw text handed to PostgREST, and never an id shape the book cannot hold.
const isClientId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const idList = (v, check) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_IDS) return null;
  return v.every(check) ? [...new Set(v)] : null;
};
// The same shape the browser's own validation uses; deliberately loose (an address with a
// plus, a subdomain, a long TLD all pass) and only there to refuse something that is plainly
// not an address before it becomes a GoTrue account.
const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const sameSet = (a, b) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

// Each refusal in words, with its code: the screen says the sentence, and acts on the code.
const SAVE_REFUSALS = Object.freeze({
  duplicate: 'That email already has a customer login.',
  'team-email': "That email belongs to someone on your team. Use the customer contact's own address.",
  'login-email': "That email already signs in to the office app. Use the customer contact's own address.",
  'check-failed': "That address couldn't be checked against the team and its logins, so the contact wasn't added. Try again.",
});
const STALE = Object.freeze({
  stale: 'Someone changed this since you opened it. Open it again and make your change.',
  reload: 'This page is out of date. Reload it and make your change again.',
});

export default function handler(req, res) {
  return withRequestCache(() => clientUsersHandler(req, res));
}

async function clientUsersHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const bad = (error, code) => res.status(400).json({ error, ...(code ? { code } : {}) });
  const refuse = (status, code, words) => res.status(status).json({ error: words, code });

  try {
    // ── reads ────────────────────────────────────────────────────────────────
    if (action === 'list' && req.method === 'GET') {
      const g = await requirePermission(req, res, VIEW);
      if (!g) return;
      res.setHeader('Cache-Control', 'no-store');
      const [users, groups, groupMembers, assignments] = await Promise.all([
        listClientUsers(), listGroups(), listGroupMembers(), listAssignments(),
      ]);
      return res.status(200).json({
        users: users.map(publicUser),
        groups: groups.map(publicGroup),
        groupMembers: groupMembers.map((m) => ({ groupId: m.group_id, clientId: m.client_id })),
        assignments: assignments.map((a) => ({ clientUserId: a.client_user_id, clientId: a.client_id, groupId: a.group_id })),
      });
    }

    // "Who can see this building?" — the panel on a customer page. Answers DIRECT grants and
    // grants that arrive through a group separately, because the office needs to know which
    // to edit: taking a person off a building they hold through a city group does nothing.
    // Narrowed IN THE QUERY to this building (store.js buildingAudience), complete at any size.
    if (action === 'for-client' && req.method === 'GET') {
      const g = await requirePermission(req, res, VIEW);
      if (!g) return;
      const clientId = req.query.clientId;
      if (!isClientId(clientId)) return bad('clientId is malformed');
      res.setHeader('Cache-Control', 'no-store');
      const { users, direct: directRows, viaGroup: groupRows, groups } = await buildingAudience(clientId);
      const byId = new Map(users.map((u) => [u.id, u]));
      const groupName = new Map(groups.map((gr) => [gr.id, gr.name || '']));
      const byName = (a, b) => String(a.name).localeCompare(String(b.name));
      const direct = directRows.map((a) => byId.get(a.client_user_id)).filter(Boolean).map(publicUser).sort(byName);
      const viaGroup = groupRows
        .filter((a) => byId.has(a.client_user_id))
        .map((a) => ({ ...publicUser(byId.get(a.client_user_id)), groupId: a.group_id, groupName: groupName.get(a.group_id) || '' }))
        .sort(byName);
      return res.status(200).json({ direct, viaGroup, groups: groups.map(publicGroup) });
    }

    // ── writes ───────────────────────────────────────────────────────────────
    if (action === 'save' && req.method === 'POST') {
      const g = await requirePermission(req, res, MANAGE);
      if (!g) return;
      const { id } = req.body || {};
      const name = text(req.body?.name, MAX_NAME);
      const phone = text(req.body?.phone, MAX_PHONE);
      if (!name) return bad('A name is required');
      if (id) {
        if (!isUuid(id)) return bad('id is malformed');
        const row = await officeRow(id);
        if (!row) return res.status(404).json({ error: 'That customer contact no longer exists.' });
        // The EMAIL is the sign-in identity and is deliberately NOT editable here: changing
        // it would leave the GoTrue account on the old address, i.e. a login nobody can see
        // in this list. Remove the person and invite the new address instead.
        return res.status(200).json({ user: publicUser(await updateClientUser(id, { name, phone: phone || null })) });
      }
      const email = text(req.body?.email, MAX_EMAIL).toLowerCase();
      if (!isEmail(email)) return bad('A valid email address is required');
      // The office preview's stand-ins live at this reserved domain; nobody else may.
      if (isHubPreviewEmail(email)) return bad('That address is reserved for the customer hub preview. Use the contact\'s own email.', 'reserved-email');
      if (await getClientUserByEmail(email)) return refuse(409, 'duplicate', SAVE_REFUSALS.duplicate);
      // A customer contact's address is never a TEAM member's, nor one any login other than a
      // customer's already signs in with (CS-660): Remove would once delete that login, and the
      // live office login is on no roster row, so the login check is the one that holds. Read
      // strictly — an address that can't be checked is not saved.
      let teamAddress = false;
      let login = null;
      try {
        teamAddress = await emailOnRoster(email);
        if (!teamAddress) login = await findAuthUserByEmail(email);
      } catch {
        return refuse(503, 'check-failed', SAVE_REFUSALS['check-failed']);
      }
      if (teamAddress) return refuse(409, 'team-email', SAVE_REFUSALS['team-email']);
      if (login && login.app_metadata?.role !== CLIENT_ROLE) return refuse(409, 'login-email', SAVE_REFUSALS['login-email']);
      let created;
      try {
        created = await insertClientUser({ name, email, phone, status: 'invited', invitedBy: g.orgUserId || null });
      } catch (e) {
        // A duplicate the targeted lookup missed (a row written outside the app) meets the unique
        // index: the same answer, in words, never the database's.
        if (e?.code === '23505') return refuse(409, 'duplicate', SAVE_REFUSALS.duplicate);
        throw e;
      }
      return res.status(200).json({ user: publicUser(created) });
    }

    if (action === 'assign' && req.method === 'POST') {
      const g = await requirePermission(req, res, MANAGE);
      if (!g) return;
      const { id } = req.body || {};
      if (!isUuid(id)) return bad('id is malformed');
      const clientIds = idList(req.body?.clientIds, isClientId);
      const groupIds = idList(req.body?.groupIds, isUuid);
      if (clientIds === null || groupIds === null) return bad('clientIds / groupIds are malformed');
      if (!(await officeRow(id))) return res.status(404).json({ error: 'That customer contact no longer exists.' });
      // 🔴 The set the screen LOADED must still be the stored one before it is replaced (CS-662):
      // a screen that held part of a person's grants — the old 1,000-row list — or a set someone
      // changed since would otherwise delete every grant it never saw.
      const base = req.body?.base;
      const baseClientIds = base && typeof base === 'object' ? idList(base.clientIds, isClientId) : null;
      const baseGroupIds = base && typeof base === 'object' ? idList(base.groupIds, isUuid) : null;
      if (baseClientIds === null || baseGroupIds === null) return refuse(409, 'reload', STALE.reload);
      const stored = await listAssignments(id);
      if (!sameSet(stored.map((a) => a.client_id).filter(Boolean), baseClientIds)
        || !sameSet(stored.map((a) => a.group_id).filter(Boolean), baseGroupIds)) {
        return refuse(409, 'stale', STALE.stale);
      }
      const rows = await setAssignments(id, { clientIds, groupIds });
      return res.status(200).json({ assignments: rows.map((a) => ({ clientUserId: a.client_user_id, clientId: a.client_id, groupId: a.group_id })) });
    }

    // Create (or re-create) the login and send the set-password link. Safe to run twice: the
    // account is adopted and re-stamped rather than duplicated, and the link is always fresh —
    // which VOIDS the link sent before (one recovery token per login; the screens say so first).
    if (action === 'invite' && req.method === 'POST') {
      const g = await requirePermission(req, res, MANAGE);
      if (!g) return;
      const { id } = req.body || {};
      if (!isUuid(id)) return bad('id is malformed');
      const row = await officeRow(id);
      if (!row) return res.status(404).json({ error: 'That customer contact no longer exists.' });
      if (!clientUserHasAccess(row.status)) {
        return res.status(409).json({ error: 'Re-enable this contact before inviting them.', code: 'disabled' });
      }
      // Where the link lands: the app's own login screen, which shows the set-password form
      // for a recovery hash. The app's address from configuration (_lib/appUrl.js: the deploy's
      // APP_PUBLIC_URL, else the brand pack's appUrl), never this request's Host (DEV_PLAYBOOK
      // 3.4.18): an office user on an old alias would otherwise invite the customer there.
      const redirectTo = `${appPublicUrl()}/login`;
      let out;
      try {
        // The invite goes by email only (2026-10-28: a sign-in link is never texted).
        out = await createClientUserAccount(row.email, redirectTo, { clientUserId: row.id });
      } catch (e) {
        // A roster that couldn't be read changed nothing: try again (503), not "no".
        if (e?.code === ROSTER_UNREADABLE) return refuse(503, 'check-failed', e.message);
        return res.status(409).json({ error: e?.message || 'The login could not be created.', code: 'invite-failed' });
      }
      const user = await updateClientUser(row.id, {
        auth_user_id: out.authUserId,
        invited_at: new Date().toISOString(),
        invited_by: g.orgUserId || row.invited_by || null,
        status: row.status === 'active' ? 'active' : 'invited',
      });
      // 🔴 no-store: when nothing was emailed the body carries the one-time set-password link —
      // and only then (users.js handOverLink): an emailed invite answers no link.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        user: publicUser(user), invited: out.invited, adopted: out.adopted,
        ...(out.why ? { why: out.why } : {}), ...(out.link ? { link: out.link } : {}),
      });
    }

    // Disable / re-enable. BOTH halves move together: the row's status (which every server
    // gate reads on the next request) and the GoTrue ban (which stops the token itself).
    // Status first — it is the one that is instant. The ban touches ONLY a login whose claims
    // prove it is this contact's (CS-660): `loginKept` says one held the address and was left alone.
    if (action === 'status' && req.method === 'POST') {
      const g = await requirePermission(req, res, MANAGE);
      if (!g) return;
      const { id, status } = req.body || {};
      if (!isUuid(id)) return bad('id is malformed');
      if (!CLIENT_USER_STATUSES.includes(status)) return bad(`status must be one of ${CLIENT_USER_STATUSES.join(', ')}`);
      const row = await officeRow(id);
      if (!row) return res.status(404).json({ error: 'That customer contact no longer exists.' });
      const user = await updateClientUser(id, { status });
      // true / false = banned / unbanned · null = no login · 'failed' = it didn't land (the status
      // already holds every server gate; the office retries) · 'kept' = not theirs, untouched.
      const ban = await setCustomerLoginBanned(row, !clientUserHasAccess(status));
      return res.status(200).json({
        user: publicUser(user),
        loginBanned: ban === 'kept' ? null : ban,
        ...(ban === 'kept' ? { loginKept: true } : {}),
      });
    }

    // Remove the person outright (HUB-4). Their OWN login goes with the row — leaving the GoTrue
    // account behind is exactly the "orphan login" class the staff side had to build a repair
    // for, and here it would be an orphan that still carries a client claim. A login that merely
    // holds the same address is not theirs and is never touched (CS-660); the answer says so.
    if (action === 'remove' && req.method === 'POST') {
      const g = await requirePermission(req, res, MANAGE);
      if (!g) return;
      const { id } = req.body || {};
      if (!isUuid(id)) return bad('id is malformed');
      const row = await officeRow(id);
      if (!row) return res.status(200).json({ ok: true, missing: true });
      let found;
      try {
        found = await customerLoginOf(row);
      } catch {
        // Can't tell whose login it is: change nothing, keep the contact, try again.
        return refuse(503, 'login-check-failed', "The customer's login couldn't be checked, so nothing was removed. Try again.");
      }
      if (found.verdict === 'theirs') {
        // Ban BEFORE deleting, so a delete that fails still leaves a login that cannot sign
        // in. The reverse order leaves a live login with no row — reachable, and invisible.
        try { await setLoginBannedById(found.authUserId, true); } catch { /* the delete below is the real end */ }
        const { error } = await getSupabase().auth.admin.deleteUser(found.authUserId);
        if (error) {
          return res.status(502).json({ error: 'The login could not be removed, so the contact was kept. It is disabled; try again.', code: 'login-delete-failed' });
        }
      }
      await deleteClientUser(id); // assignments cascade
      return res.status(200).json({
        ok: true,
        loginRemoved: found.verdict === 'theirs',
        ...(found.verdict === 'other' ? { loginKept: true } : {}),
      });
    }

    // ── groups (HUB-3 / HUB-17) ──────────────────────────────────────────────
    if (action === 'group-save' && req.method === 'POST') {
      const g = await requirePermission(req, res, MANAGE);
      if (!g) return;
      const { id } = req.body || {};
      const name = text(req.body?.name, MAX_NAME);
      const kind = req.body?.kind ?? 'other';
      if (!name) return bad('A name is required');
      if (!isClientGroupKind(kind)) return bad('kind is not one this app knows');
      const clientIds = idList(req.body?.clientIds, isClientId);
      if (clientIds === null) return bad('clientIds are malformed');
      let group;
      if (id) {
        if (!isUuid(id)) return bad('id is malformed');
        // 🔴 The buildings the editor LOADED must still be the group's before they replace it
        // (CS-662): a group of 750 opened from a list cut at 1,000 rows lost 500 on Save.
        const baseClientIds = Array.isArray(req.body?.baseClientIds) ? idList(req.body.baseClientIds, isClientId) : null;
        if (baseClientIds === null) return refuse(409, 'reload', STALE.reload);
        const stored = await listGroupMembers(id);
        if (!sameSet(stored.map((m) => m.client_id).filter(Boolean), baseClientIds)) return refuse(409, 'stale', STALE.stale);
        group = await updateGroup(id, { name, kind });
        if (!group) return res.status(404).json({ error: 'That group no longer exists.' });
      } else {
        group = await insertGroup({ name, kind });
      }
      const members = await setGroupMembers(group.id, clientIds);
      return res.status(200).json({
        group: publicGroup(group),
        members: members.map((m) => ({ groupId: m.group_id, clientId: m.client_id })),
      });
    }

    if (action === 'group-remove' && req.method === 'POST') {
      const g = await requirePermission(req, res, MANAGE);
      if (!g) return;
      const { id } = req.body || {};
      if (!isUuid(id)) return bad('id is malformed');
      await deleteGroup(id); // memberships + the assignments naming it cascade
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    // A complete read that came up short is a retry (503), one too wide a 413 (pagedSelect).
    return res.status(readErrorStatus(e)).json({ error: e?.message || 'Server error' });
  }
}

// The office's view of a row. `auth_user_id` is deliberately NOT served: it is a GoTrue id,
// of no use to a screen, and one more identifier to keep out of a browser.
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name || '',
    email: u.email || '',
    phone: u.phone || '',
    status: u.status || 'invited',
    hasLogin: !!u.auth_user_id,
    invitedAt: u.invited_at || null,
    invitedBy: u.invited_by || null,
    createdAt: u.created_at || null,
  };
}

function publicGroup(g) {
  if (!g) return null;
  return { id: g.id, name: g.name || '', kind: g.kind || 'other', createdAt: g.created_at || null };
}
