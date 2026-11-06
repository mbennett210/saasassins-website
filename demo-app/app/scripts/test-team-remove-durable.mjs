// CS-969 — a team member's removal sticks, login and roster row together.
//
// THE BUG (production, 2026-11-03, task 469). Settings → Team → Remove: POST
// /api/settings/users/delete answered 200 and deleted the login, and the page was left about 3.5 s
// later by a full page load. The roster row was the tab's to remove (TeamDetail dispatched
// DELETE_USER after the route answered), and that reached org_state only with the tab's next save:
// 600 ms later at the earliest, after a re-read and a replay when the record had moved, 5 to 60 s
// later while saves were failing. No save went out before the page was left, so the login was gone
// and `org_state.users` still listed the member as active.
//
// THE FIX. The remove route takes the member off the shared record itself, in the same request,
// after the login is deleted (api/_lib/rosterRemoval.js): the app's own cascade
// (lib/deleteCascade removeUserFromRecord, which DELETE_USER spreads) on the committed record,
// CAS-written with a re-read on conflict. The tab's DELETE_USER stays (the cleans' crew lists, which
// public.jobs holds, are still its to sweep); replayed on the newer record it changes nothing there.
//
// HOW. Offline, end to end: the REAL settings route over the in-process fake Supabase (GoTrue's
// admin API faked by `world.authUsers`), the REAL sync engine and save routes (sync-harness.mjs).
//
//   node app/scripts/test-team-remove-durable.mjs
import { Readable } from 'node:stream';
import { createSyncHarness } from './sync-harness.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// console.log only: the harness keeps console.error / console.warn for VERBOSE runs.
const watchdog = setTimeout(() => { console.log('test-team-remove-durable: timed out'); process.exit(1); }, 60000);
watchdog.unref();

const h = await createSyncHarness();
const { seedPermissions } = await import('../src/lib/roles.js');
const { productionInitialState } = await import('../src/data/seed.js');
const { ACTIONS } = await import('../src/store/reducer.js');
const settings = (await import('../api/settings/[...path].js')).default;

const ORG = '00000000-0000-0000-0000-000000000001';
const claim = (id, email, role, orgUserId) => ({ id, email, app_metadata: { provider: 'email', role, org_user_id: orgUserId, org_id: ORG }, user_metadata: {}, banned_until: null });
const OWNER = claim('a-owner', 'owner@cs.co', 'owner', 'u_owner');
const LEAVER = claim('a-leaver', 'office@cs.co', 'admin', 'u_leaver');   // "Daniel Test (office)"
const CREW = claim('a-crew', 'crew@cs.co', 'crew', 'u_crew');
const LOGINS = { 'tok-owner': OWNER };
const JOB = { id: 'j1', clientId: 'cl1', siteId: 's1', title: 'Office clean', startAt: '2026-11-10T14:00:00.000Z', endAt: '2026-11-10T16:00:00.000Z', status: 'scheduled', crewIds: ['u_crew', 'u_owner'] };

const baseState = () => ({
  ...productionInitialState(),
  company: { ...(productionInitialState().company || {}), timezone: 'America/New_York' },
  permissions: seedPermissions(),
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner', email: OWNER.email, pay: { type: 'none' } },
    { id: 'u_leaver', role: 'admin', status: 'active', name: 'Daniel Test', email: LEAVER.email, pay: { type: 'none' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carla Crew', email: CREW.email, pay: { type: 'hourly', rate: 20 } },
  ],
  userPermissionOverrides: [{ userId: 'u_leaver', grants: ['variance.view'], revokes: [] }],
  clients: [{ id: 'cl1', name: 'Harbor Towers', status: 'active', supervisorId: 'u_leaver' }],
  contacts: [],
  conversations: [{ id: 'cv1', channel: 'internal', title: 'Keys', createdByUserId: 'u_leaver', participantUserIds: ['u_owner', 'u_leaver'], starredByUserIds: ['u_leaver'], mutedByUserIds: [] }],
  messages: [{ id: 'm1', conversationId: 'cv1', direction: 'out', text: 'Keys are in the box', sentAt: '2026-11-03T20:00:00.000Z', authorUserId: 'u_leaver', readByUserIds: ['u_owner', 'u_leaver'] }],
  notifications: [
    { id: 'n_leaver', userId: 'u_leaver', title: 'New message', read: false, createdAt: '2026-11-03T20:00:00.000Z' },
    { id: 'n_owner', userId: 'u_owner', title: 'New message', read: false, createdAt: '2026-11-03T20:00:00.000Z' },
  ],
  payrollLines: [],
  reimbursements: [],
});

function seedWorld(state = baseState()) {
  h.seedOrg(state, { logins: LOGINS, jobs: [JOB] });
  h.world.authUsers = structuredClone([OWNER, LEAVER, CREW]);
  h.world.tables.time_entries = [];
}
async function removeLogin(email) {
  const req = Readable.from([Buffer.from(JSON.stringify({ email }))]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer tok-owner', host: '127.0.0.1', 'content-type': 'application/json' };
  req.query = { subpath: 'users/delete' };
  const out = { status: 200, body: undefined };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
    setHeader() {}, getHeader() {}, end() { return this; },
  };
  try { await settings(req, res); } catch (e) { out.status = 500; out.body = { error: String(e?.message || e) }; }
  await h.settle();
  return out;
}
// What TeamDetail's Remove does: the route, then DELETE_USER in the tab.
async function teamRemove(tab, userId, email) {
  const r = await removeLogin(email);
  if (r.status === 200) tab.dispatchLocal({ type: ACTIONS.DELETE_USER, id: userId });
  return r;
}
const record = () => h.committed().state;
const onRoster = (s, id) => (s.users || []).some((u) => u.id === id);
const loginGone = (id) => !(h.world.authUsers || []).some((u) => u.id === id);
const jobRow = (id) => (h.world.tables.jobs || []).find((r) => r.id === id)?.data || null;

// ── 1. The incident: the page is left before the tab's save goes out ───────────────────────────
seedWorld();
{
  const tab = await h.bootTab('tok-owner');
  const before = h.committed().version;
  const r = await teamRemove(tab, 'u_leaver', LEAVER.email);
  tab.stop(); // a full page load: the debounced save never fires
  const s = record();
  ok('1.0 the remove route answers 200', r.status === 200, JSON.stringify(r.body));
  ok('1.1 the login is deleted', loginGone(LEAVER.id));
  ok('1.2 the shared record no longer lists the member (no tab save went out)', !onRoster(s, 'u_leaver'), JSON.stringify((s.users || []).map((u) => u.id)));
  ok('1.3 …in one write by the route', h.committed().version === before + 1, `version ${before} → ${h.committed().version}`);
  ok('1.4 the route says so', JSON.stringify(r.body?.roster?.removed) === JSON.stringify(['u_leaver']), JSON.stringify(r.body?.roster));
  ok('1.5 their permission override goes with them', !(s.userPermissionOverrides || []).some((o) => o.userId === 'u_leaver'));
  ok('1.6 their bell rows go, the owner\'s stay', (s.notifications || []).map((n) => n.id).join() === 'n_owner', JSON.stringify(s.notifications));
  const cv = (s.conversations || []).find((c) => c.id === 'cv1');
  ok('1.7 the thread outlives them, keeping their name', cv && cv.createdByUserId === null && cv.createdByName === 'Daniel Test'
    && !cv.participantUserIds.includes('u_leaver') && !cv.starredByUserIds.includes('u_leaver'), JSON.stringify(cv));
  const m = (s.messages || []).find((x) => x.id === 'm1');
  ok('1.8 their message keeps its byline, read receipt scrubbed', m && m.authorUserId === null && m.authorName === 'Daniel Test' && !m.readByUserIds.includes('u_leaver'), JSON.stringify(m));
  ok('1.9 the customer they supervised needs a manager again (sweepUserOrphans)', (s.clients || []).find((c) => c.id === 'cl1')?.supervisorId === null);
  ok('1.10 the other members stay', onRoster(s, 'u_owner') && onRoster(s, 'u_crew'));
  ok('1.11 the cleans stay off the shared record', Array.isArray(s.jobs) && s.jobs.length === 0, JSON.stringify(s.jobs));
}

// ── 2. A tab that stays: its own save meets the newer record and converges ─────────────────────
seedWorld();
{
  const tab = await h.bootTab('tok-owner');
  const r = await teamRemove(tab, 'u_crew', CREW.email);
  await h.advance(600);
  await h.advance(5000);
  const s = record();
  ok('2.0 the remove route answers 200', r.status === 200, JSON.stringify(r.body));
  ok('2.1 the shared record no longer lists the cleaner', !onRoster(s, 'u_crew'));
  ok('2.2 the tab has nothing left to save', tab.pending().length === 0, JSON.stringify(tab.pending().map((a) => a.type)));
  ok('2.3 …and no save was refused', !tab.problems.length && tab.status() !== 'error', JSON.stringify({ problems: tab.problems, status: tab.status() }));
  ok('2.4 the tab agrees with the record', !onRoster(tab.state(), 'u_crew') && tab.state().users.length === s.users.length);
  const j = jobRow('j1');
  ok('2.5 their clean no longer lists them (the tab\'s sweep, mirrored to public.jobs)', j && JSON.stringify(j.crewIds) === JSON.stringify(['u_owner']), JSON.stringify(j));
}

// ── 3. The record write can't land: the login is still deleted, the route says so ─────────────
seedWorld();
{
  const tab = await h.bootTab('tok-owner');
  h.world.failWhen = (q) => q.table === 'org_state' && q.op === 'update';
  const r = await teamRemove(tab, 'u_leaver', LEAVER.email);
  h.world.failWhen = null;
  ok('3.0 the route still answers 200 (the login is gone)', r.status === 200 && loginGone(LEAVER.id), JSON.stringify(r.body));
  ok('3.1 …and says the roster is pending', r.body?.roster?.pending === true, JSON.stringify(r.body?.roster));
  await h.advance(600);
  await h.advance(5000);
  ok('3.2 the tab\'s own DELETE_USER still carries it, as before', !onRoster(record(), 'u_leaver') && tab.pending().length === 0);
  tab.stop();
}

// ── 4. A save lands between the route's read and its write: it re-reads, both survive ──────────
seedWorld();
{
  const tab = await h.bootTab('tok-owner');
  tab.stop();
  let raced = false;
  h.world.beforeQuery = async (q) => {
    if (raced || q.table !== 'org_state' || q.op !== 'update') return;
    raced = true;
    const row = h.world.tables.org_state[0];
    row.state = { ...row.state, contacts: [...(row.state.contacts || []), { id: 'ct_new', firstName: 'Nina', lastName: 'New', email: 'nina@new.co' }] };
    row.version += 1;
  };
  const r = await removeLogin(LEAVER.email);
  h.world.beforeQuery = null;
  const s = record();
  ok('4.0 the route answers 200', r.status === 200, JSON.stringify(r.body));
  ok('4.1 the member is off the record', !onRoster(s, 'u_leaver') && JSON.stringify(r.body?.roster?.removed) === JSON.stringify(['u_leaver']), JSON.stringify(r.body?.roster));
  ok('4.2 the save that landed first is kept', (s.contacts || []).some((c) => c.id === 'ct_new'));
}

// ── 5. Controls: refusals still refuse, and nothing moves ──────────────────────────────────────
seedWorld();
{
  const before = structuredClone(h.committed());
  const r = await removeLogin(OWNER.email); // the caller themselves, the last Super Admin
  ok('5.0 removing the last Super Admin is refused', r.status !== 200 && !loginGone(OWNER.id), `${r.status} ${JSON.stringify(r.body)}`);
  ok('5.1 …and the record is untouched', h.committed().version === before.version && onRoster(record(), 'u_owner'));
}
seedWorld({ ...baseState(), payrollLines: [{ id: 'pl1', userId: 'u_crew', periodKey: '2099-01-01', amountCents: 8000 }] });
{
  const before = h.committed().version;
  const r = await removeLogin(CREW.email);
  ok('5.2 a member who may still be owed pay is refused', r.status === 409 && !loginGone(CREW.id), `${r.status} ${JSON.stringify(r.body)}`);
  ok('5.3 …and stays on the record', h.committed().version === before && onRoster(record(), 'u_crew'));
}

clearTimeout(watchdog);
if (fails.length) {
  console.log(`test-team-remove-durable: ${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-team-remove-durable: ${pass} passed`);
}
process.exit(process.exitCode || 0);
