// THE CLIENT HUB'S TABLES (migration 20261003110000). Service-role only — never import
// client-side.
//
// Four tables, all RLS-on with NO policies, so this module is the only way in:
//   client_users               one customer-side login (HUB-1)
//   client_user_groups         a management company, a city, or something else (HUB-3/17)
//   client_user_group_members  which buildings are in a group
//   client_user_assignments    what ONE person may see: a building, or a whole group
//
// The customer ids here (`client_id`) are org_state ids (`cl_*`), text, with no foreign key —
// customers live in the shared JSON record. The rule for turning rows into a scope is PURE and
// lives in src/lib/clientHub.js (resolveAllowedClientIds), so the office's preview and the
// hub's gate can never give different answers.
import { createHash } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { cached } from '../requestCache.js';
import { exactCount, selectAll } from '../pagedSelect.js';
import { resolveAllowedClientIds, CLIENT_USER_PREVIEW_STATUS, isPreviewStandIn } from '../../../src/lib/clientHub.js';
import { HUB_PREVIEW_STAND_IN_NAME, hubPreviewStandInEmail } from '../../../src/lib/hubPreview.js';

const ORG = CLEANSPACE_ORG_ID;

// Every read/write names the org. Single-company today, but the column is there and a query
// that forgets it is the bug that is impossible to see later.
const scoped = (q) => q.eq('organization_id', ORG);

// The provider's words go to the server log through the message; the database's own code rides
// along (`23505`: a unique index refused the row) so a route can answer it in words.
function unwrap(res, what) {
  if (res.error) throw Object.assign(new Error(`${what}: ${res.error.message}`), { code: res.error.code || null });
  return res.data;
}

const nowIso = () => new Date().toISOString();

// ── complete reads (CS-662 / CS-675, S128) ───────────────────────────────────
// PostgREST answers at most 1,000 rows (db-max-rows) whatever a read asked for, and says nothing
// when it cuts. At Matt's scale (750 buildings, a login or two each, groups for management
// companies and cities) every table here passes that: the office's list held 1,000 of each, the
// Access dialog and a group's Edit then REPLACED a person's grants or a group's buildings with
// the part they held (deleting the rest), the hub gate refused group buildings, and the emails
// skipped people. So every read here is COMPLETE — count first, ordered pages (pagedSelect
// selectAll, which fails loudly rather than return part of a set) — and narrowed IN THE QUERY to
// what its caller needs: a person's grants, a building's, the members of named groups.
const TABLE_MAX = 100000;   // every row this org could hold in one of these tables, with room to spare
const IN_CHUNK = 200;       // ids per `in` filter, so a request's URL stays well inside its limit

// Each table's KEY, which orders its pages (after the caller's own column) and dedupes them.
// 🔴 client_user_group_members has NO `id` column: its primary key is (group_id, client_id)
// (migration 20261003110000). Ordering, counting or deduping it by `id` fails in PostgREST
// (42703) or folds every row into one.
const TABLE_KEYS = Object.freeze({
  client_users: { cols: ['id'], keyOf: (r) => r.id },
  client_user_groups: { cols: ['id'], keyOf: (r) => r.id },
  client_user_assignments: { cols: ['id'], keyOf: (r) => r.id },
  client_user_group_members: { cols: ['group_id', 'client_id'], keyOf: (r) => `${r.group_id}|${r.client_id}` },
});

async function allRows(table, { order = null, extra = (q) => q } = {}) {
  const sb = getSupabase();
  const { cols: keyCols, keyOf } = TABLE_KEYS[table];
  const orderBy = [...new Set([...(order ? [order] : []), ...keyCols])];
  const filtered = (cols, opts) => extra(scoped(sb.from(table).select(cols, opts)));
  return selectAll({
    count: async () => {
      const res = await filtered(keyCols[0], { count: 'exact', head: true });
      if (res.error) throw Object.assign(new Error(`${table} count failed: ${res.error.message}`), { code: res.error.code || null });
      return exactCount(res.count);
    },
    // Ordered by the caller's column, then the key (lint:paging): page membership is never the
    // planner's choice.
    page: async (from, to) => {
      let q = filtered('*');
      for (const col of orderBy) q = q.order(col, { ascending: true });
      return unwrap(await q.range(from, to), `${table} read failed`) || [];
    },
    keyOf,
    maxRows: TABLE_MAX,
  });
}

// Every row whose `column` is one of `values`, complete, the list split across requests.
async function rowsWhereIn(table, column, values, { order = null, extra = (q) => q } = {}) {
  const ids = [...new Set((Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v))];
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    out.push(...await allRows(table, { order, extra: (q) => extra(q).in(column, chunk) }));
  }
  return out;
}

// ── client users ─────────────────────────────────────────────────────────────

// The row behind a client_user_id claim. Cached per REQUEST: the hub gate reads it and so
// does the view that follows, and outside a request context `cached` is a pass-through.
export async function getClientUserById(id) {
  if (!id) return null;
  return cached(`clientUser:${id}`, async () => {
    const rows = unwrap(
      await scoped(getSupabase().from('client_users').select('*').eq('id', id)).limit(1),
      'client user read failed',
    );
    return rows?.[0] || null;
  });
}

// The duplicate check: ONE targeted read, the address in the query (CS-662). It used to read the
// whole list, which stopped at 1,000 rows, so a duplicate past them reached the insert and came
// back as the database's own 500. The app writes every address lower-cased (insertClientUser),
// the same rule the unique index compares by (lower(email)); a row written otherwise outside the
// app still meets that index on insert, which the save route answers as the same 409.
export async function getClientUserByEmail(email) {
  const target = (email || '').trim().toLowerCase();
  if (!target) return null;
  const rows = unwrap(
    await scoped(getSupabase().from('client_users').select('*').eq('email', target))
      .neq('status', CLIENT_USER_PREVIEW_STATUS)
      .limit(1),
    'client user read failed',
  );
  return rows?.[0] || null;
}

// Every REAL customer login, complete. The office preview's stand-ins (status 'preview', below)
// are never listed: not on Settings → Customer logins, not on a customer page's "who can see this
// building", not in an email's audience (clientUsersWhoCanSee), not in the duplicate-email check.
export async function listClientUsers() {
  return allRows('client_users', { order: 'name', extra: (q) => q.neq('status', CLIENT_USER_PREVIEW_STATUS) });
}

// The real customer logins with these ids (an audience: the people a building's grants name).
export async function listClientUsersByIds(ids) {
  return rowsWhereIn('client_users', 'id', ids, { order: 'name', extra: (q) => q.neq('status', CLIENT_USER_PREVIEW_STATUS) });
}

// ── the office preview's stand-in customer (2026-10-09, plan §3.7) ───────────
// When the office previews a building with HUB_PREVIEW_ACTS_AS_CUSTOMER on, the hub route acts as
// ONE stand-in customer login for that building, so every write it makes is a customer's write
// (lib/hubPreview.js). The row: status CLIENT_USER_PREVIEW_STATUS (no access: it can never sign in,
// is never emailed, resolves no scope, and the office's routes never show or touch it), named
// HUB_PREVIEW_STAND_IN_NAME, at hubPreviewStandInEmail(building), with no login and no assignment.
// Nothing but ensurePreviewStandIn creates one, and nothing edits one but the hub's own writes on
// its own row (the bell's "seen", its email switches).
//
// Its id is DERIVED from the org and the building (a name-based uuid), so every caller names the
// same row before it exists: read it first; insert it if missing; and if a parallel first preview
// won the insert (23505 on the primary key or the email), read the winner back. One row per
// building, however many previews at once.
export function previewStandInId(clientId) {
  const h = createHash('sha256').update(`hub-preview-stand-in:${ORG}:${clientId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function ensurePreviewStandIn(clientId) {
  if (typeof clientId !== 'string' || !clientId) throw new Error('preview stand-in: no building');
  const id = previewStandInId(clientId);
  const email = hubPreviewStandInEmail(clientId);
  const sb = getSupabase();
  const read = async () => {
    const rows = unwrap(await scoped(sb.from('client_users').select('*').eq('id', id)).limit(1), 'preview stand-in read failed');
    const row = rows?.[0] || null;
    // The id is this building's by construction; a row there that is not its stand-in is refused,
    // never adopted (an identity must never be borrowed).
    if (row && (!isPreviewStandIn(row) || row.email !== email)) throw new Error('preview stand-in: the derived id names another row');
    return row;
  };
  const found = await read();
  if (found) return found;
  const now = nowIso();
  const res = await sb.from('client_users').insert({
    id,
    organization_id: ORG,
    name: HUB_PREVIEW_STAND_IN_NAME,
    email,
    phone: null,
    status: CLIENT_USER_PREVIEW_STATUS,
    auth_user_id: null,
    invited_at: null,
    invited_by: null,
    created_at: now,
    updated_at: now,
  }).select('*');
  if (!res.error) return res.data?.[0] || read();
  if (res.error.code === '23505') {
    const winner = await read();
    if (winner) return winner;
  }
  throw new Error(`preview stand-in create failed: ${res.error.message || res.error.code}`);
}

export async function insertClientUser({ name, email, phone, status, invitedBy }) {
  const rows = unwrap(
    await getSupabase().from('client_users').insert({
      organization_id: ORG,
      name,
      email: (email || '').trim().toLowerCase(),
      phone: phone || null,
      status,
      invited_by: invitedBy || null,
    }).select('*'),
    'client user create failed',
  );
  return rows?.[0] || null;
}

// Patch a client user. `patch` is already whitelisted by the caller; `updated_at` is stamped
// here so no route can forget it.
export async function updateClientUser(id, patch) {
  const rows = unwrap(
    await scoped(getSupabase().from('client_users').update({ ...patch, updated_at: nowIso() }).eq('id', id)).select('*'),
    'client user update failed',
  );
  return rows?.[0] || null;
}

export async function deleteClientUser(id) {
  unwrap(await scoped(getSupabase().from('client_users').delete().eq('id', id)), 'client user delete failed');
  return { ok: true };
}

// ── groups ───────────────────────────────────────────────────────────────────

export async function listGroups() {
  return allRows('client_user_groups', { order: 'name' });
}

export async function listGroupsByIds(ids) {
  return rowsWhereIn('client_user_groups', 'id', ids, { order: 'name' });
}

export async function insertGroup({ name, kind }) {
  const rows = unwrap(
    await getSupabase().from('client_user_groups').insert({ organization_id: ORG, name, kind }).select('*'),
    'group create failed',
  );
  return rows?.[0] || null;
}

export async function updateGroup(id, patch) {
  const rows = unwrap(
    await scoped(getSupabase().from('client_user_groups').update({ ...patch, updated_at: nowIso() }).eq('id', id)).select('*'),
    'group update failed',
  );
  return rows?.[0] || null;
}

export async function deleteGroup(id) {
  // The assignments and memberships that name it go with it (on delete cascade), so removing
  // a group never leaves a person holding a grant to nothing.
  unwrap(await scoped(getSupabase().from('client_user_groups').delete().eq('id', id)), 'group delete failed');
  return { ok: true };
}

// A group's buildings (or, for the office's list, every group's), complete.
export async function listGroupMembers(groupId = null) {
  return allRows('client_user_group_members', { order: 'group_id', extra: (q) => (groupId ? q.eq('group_id', groupId) : q) });
}

// The buildings of these groups only — what the hub gate needs for ONE login (CS-675).
export async function listGroupMembersOf(groupIds) {
  return rowsWhereIn('client_user_group_members', 'group_id', groupIds, { order: 'group_id' });
}

// The groups' rows naming ONE building.
export async function listGroupMembersForClient(clientId) {
  return allRows('client_user_group_members', { order: 'group_id', extra: (q) => q.eq('client_id', clientId) });
}

// Replace a group's membership with exactly `clientIds`. One statement each way, so a
// half-applied save cannot leave a group granting a building the office just took out.
export async function setGroupMembers(groupId, clientIds) {
  const want = [...new Set((clientIds || []).filter(Boolean))];
  const sb = getSupabase();
  unwrap(await scoped(sb.from('client_user_group_members').delete().eq('group_id', groupId)), 'group members clear failed');
  if (!want.length) return [];
  return unwrap(
    await sb.from('client_user_group_members')
      .insert(want.map((clientId) => ({ organization_id: ORG, group_id: groupId, client_id: clientId })))
      .select('*'),
    'group members write failed',
  ) || [];
}

// ── assignments ──────────────────────────────────────────────────────────────

// One person's grants (or, for the office's list, everyone's), complete.
export async function listAssignments(clientUserId = null) {
  return allRows('client_user_assignments', { order: 'client_user_id', extra: (q) => (clientUserId ? q.eq('client_user_id', clientUserId) : q) });
}

// Every assignment naming ONE building directly.
export async function listAssignmentsForClient(clientId) {
  return allRows('client_user_assignments', { order: 'client_user_id', extra: (q) => q.eq('client_id', clientId) });
}

// Every assignment of a whole group, for these groups.
export async function listAssignmentsForGroups(groupIds) {
  return rowsWhereIn('client_user_assignments', 'group_id', groupIds, { order: 'client_user_id' });
}

// Replace ONE person's grants with exactly these buildings + groups. Delete-then-insert for
// the same reason as setGroupMembers: the office's editor sends the whole set, and a
// partial apply is a person still holding access they were just taken off.
export async function setAssignments(clientUserId, { clientIds = [], groupIds = [] } = {}) {
  const sb = getSupabase();
  unwrap(
    await scoped(sb.from('client_user_assignments').delete().eq('client_user_id', clientUserId)),
    'assignments clear failed',
  );
  const rows = [
    ...[...new Set(clientIds.filter(Boolean))].map((clientId) => ({
      organization_id: ORG, client_user_id: clientUserId, client_id: clientId, group_id: null,
    })),
    ...[...new Set(groupIds.filter(Boolean))].map((groupId) => ({
      organization_id: ORG, client_user_id: clientUserId, client_id: null, group_id: groupId,
    })),
  ];
  if (!rows.length) return [];
  return unwrap(await sb.from('client_user_assignments').insert(rows).select('*'), 'assignments write failed') || [];
}

// ── the scope ────────────────────────────────────────────────────────────────

// WHICH BUILDINGS THIS PERSON MAY SEE, resolved server-side from the tables and the live
// customer book. The decision itself is the pure rule in src/lib/clientHub.js; this function
// is only the reads around it.
//
// `clientIds` is the live customer book (`state.clients` ids). Pass it and a stale assignment
// to a deleted customer grants nothing. Omit it ONLY where the caller has already bounded the
// answer some other way.
// The HUB GATE runs this on every request (api/hub hubContext). It reads THIS login's grants and
// the members of the groups those grants name — never the org's whole membership table, which
// past 1,000 rows came back cut and refused customers buildings they hold through a group
// (CS-675). Both reads complete; the decision is the pure rule.
export async function resolveScopeForClientUser(clientUser, { clientIds = null } = {}) {
  if (!clientUser?.id) return [];
  const assignments = await listAssignments(clientUser.id);
  const groupIds = [...new Set(assignments.map((a) => a.group_id).filter(Boolean))];
  const groupMembers = groupIds.length ? await listGroupMembersOf(groupIds) : [];
  return resolveAllowedClientIds({
    status: clientUser.status,
    assignments: assignments.map((a) => ({ clientId: a.client_id, groupId: a.group_id })),
    groupMembers: groupMembers.map((m) => ({ clientId: m.client_id, groupId: m.group_id })),
    clientIds,
  });
}

// WHO A BUILDING'S ACCESS NAMES, narrowed IN THE QUERY to that building: its direct grants, the
// groups holding it and those groups' grants, then only the people they name (real customer
// logins: never a preview stand-in). The office's "who can see this building?" panel reads it,
// and so does the email audience below.
export async function buildingAudience(clientId) {
  if (!clientId) return { users: [], direct: [], viaGroup: [], groups: [], members: [] };
  const [direct, members] = await Promise.all([listAssignmentsForClient(clientId), listGroupMembersForClient(clientId)]);
  const groupIds = [...new Set(members.map((m) => m.group_id).filter(Boolean))];
  const [viaGroup, groups] = groupIds.length
    ? await Promise.all([listAssignmentsForGroups(groupIds), listGroupsByIds(groupIds)])
    : [[], []];
  const userIds = [...new Set([...direct, ...viaGroup].map((a) => a.client_user_id).filter(Boolean))];
  const users = userIds.length ? await listClientUsersByIds(userIds) : [];
  return { users, direct, viaGroup, groups, members };
}

// THE PEOPLE WHO MAY SEE ONE BUILDING — the inverse of the scope above, for the hub's
// "a new inspection was posted" email (HUB-11) and the office-reply email. Answered by running
// THE SAME pure rule (resolveAllowedClientIds) for each person the building's grants name, so the
// email's audience is exactly the set of logins the hub would let read what it links to: a
// direct assignment, a group that holds the building, and never a disabled login. Complete at
// any size (CS-675: three unpaged reads skipped people past the 1,000th row).
export async function clientUsersWhoCanSee(clientId) {
  if (!clientId) return [];
  const { users, direct, viaGroup, members } = await buildingAudience(clientId);
  const groupMembers = members.map((m) => ({ clientId: m.client_id, groupId: m.group_id }));
  const byUser = new Map();
  for (const a of [...direct, ...viaGroup]) {
    if (!byUser.has(a.client_user_id)) byUser.set(a.client_user_id, []);
    byUser.get(a.client_user_id).push({ clientId: a.client_id, groupId: a.group_id });
  }
  return users.filter((u) => resolveAllowedClientIds({
    status: u.status,
    assignments: byUser.get(u.id) || [],
    groupMembers,
    clientIds: [clientId],
  }).includes(clientId));
}
