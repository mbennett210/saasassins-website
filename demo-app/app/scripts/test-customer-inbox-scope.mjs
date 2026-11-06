// Messaging → Customers opens on the right manager's buildings (CS-705, CS-702).
//
// CS-705: a manager's Home said "3 messages waiting" for their own buildings, and the Waiting
// view it opened listed every manager's threads (4 there; at 750 buildings, everyone's): the view
// kept its Manager filter in component state, empty = All managers, and asked the server with no
// manager at all. Now it opens on the manager's OWN buildings ("Renata Cruz (me)"), as Client
// Requests does, with the filter to widen — one rule for both pages, lib/managerFilter.
// CS-702: the owner's Manager view with one manager picked opened every page on All managers;
// the Waiting view had no manager parameter to carry the pick. It reads `?mgr=` now.
//
// The REAL components/CustomerMessagesInbox.jsx, bundled with a small hooks runtime
// (scripts/hooks-harness.mjs); its reads (lib/clientMessagesApi), the router and the store are
// stubbed, and every child component records what it was drawn with.
//   S1 a manager lands on Waiting (no ?mgr): the read asks for their buildings, the filter says "(me)"
//   S2 …widening to All managers writes ?mgr=all and reads everyone's
//   S3 the owner, from the Manager view with a manager picked (?mgr=<id>): that manager's
//   S4 the owner with no ?mgr: All managers (nothing changes for the shared login)
//   S5 a manager who supervises nothing: All managers (an empty "(me)" would show nothing)
//   S6 the rule itself (lib/managerFilter), and Client Requests reads it too
//
// REGRESSION (THE LAW II.3): on the tree before the fix S1, S3 and S6 fail.
//
//   node app/scripts/test-customer-inbox-scope.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { R, bundle, recorder, mount, settle, unmount, view } from './hooks-harness.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = (rel) => JSON.stringify(pathToFileURL(path.join(APP, rel)).href);
const core = await import('../src/i18n/core.js');
const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const MF = await tryImport('../src/lib/managerFilter.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

// ── the fixture: two managers, their buildings, and the threads waiting at each ─────────────
const USERS = [
  { id: 'u_owner', role: 'owner', status: 'active', name: 'Matt Owner' },
  { id: 'u_mgr', role: 'manager', status: 'active', name: 'Renata Cruz' },
  { id: 'u_lee', role: 'manager', status: 'active', name: 'Yolanda Lee' },
  { id: 'u_new', role: 'manager', status: 'active', name: 'Nora New' },
];
const CLIENTS = [
  { id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr' },
  { id: 'cl_b', name: 'Lakeside Towers', supervisorId: 'u_mgr' },
  { id: 'cl_c', name: 'Olympic Plaza', supervisorId: 'u_lee' },
];
const WAITING = [
  { clientId: 'cl_a', clientName: 'Coral Bay HOA', managerId: 'u_mgr', lastBody: 'Hello', lastAt: '2026-10-12T10:00:00Z', waitingSince: '2026-10-12T10:00:00Z' },
  { clientId: 'cl_b', clientName: 'Lakeside Towers', managerId: 'u_mgr', lastBody: 'Hi', lastAt: '2026-10-12T11:00:00Z', waitingSince: '2026-10-12T11:00:00Z' },
  { clientId: 'cl_c', clientName: 'Olympic Plaza', managerId: 'u_lee', lastBody: 'Hey', lastAt: '2026-10-12T12:00:00Z', waitingSince: '2026-10-12T12:00:00Z' },
];
// The stubbed server: the same narrowing the route applies (`managerId` → the building's manager).
globalThis.__CMI = {
  waiting(q) {
    const rows = WAITING.filter((w) => !q.managerId || w.managerId === q.managerId);
    return { threads: rows, total: rows.length };
  },
  list(q) {
    const rows = WAITING.filter((w) => !q.managerId || w.managerId === q.managerId);
    return { threads: rows, total: rows.length, offset: 0, limit: 20, unreadThreads: 0 };
  },
};

const SHIMS = [
  { test: /^react-router-dom$/, code: `const R = globalThis.__HR;
export function useSearchParams() {
  const params = new URLSearchParams(R.search || '');
  const set = (next) => { const v = typeof next === 'function' ? next(new URLSearchParams(R.search || '')) : next; const s = new URLSearchParams(v).toString(); if (s !== (R.search || '')) { R.search = s; R.dirty = true; } };
  return [params, set];
}
export function Link(p) { return { type: 'a', props: p }; }` },
  { test: /(^|\/)store$/, code: 'export function useStore() { return globalThis.__HR.state; }' },
  { test: /hooks\/useAuth$/, code: 'export function useAuth() { return { currentUser: globalThis.__HR.user }; }' },
  { test: /hooks\/useFromHere$/, code: 'export function useFromHere() { return {}; }' },
  // One `t` for the whole run, as the real hook hands back one per language.
  { test: /i18n\/react$/, code: `import { english } from ${abs('src/i18n/core.js')};
const t = (k, p) => english(k, p); t.rich = t;
export function useT() { return t; }` },
  { test: /i18n\/errors$/, code: 'export function errorText(t, e, key) { return (e && e.message) || t(key); }' },
  { test: /i18n\/relative$/, code: "export function timeShort() { return 'now'; }" },
  { test: /lib\/clientMessagesApi$/, code: `const R = globalThis.__HR;
export async function listCustomerThreads(q) { R.calls.push(['list', q]); return globalThis.__CMI.list(q); }
export async function listWaitingCustomerThreads(q) { R.calls.push(['waiting', q]); return globalThis.__CMI.waiting(q); }` },
  { test: /\/Avatar$/, code: recorder('Avatar', { draw: 'none' }) },
  { test: /\/Icon$/, code: recorder('Icon', { draw: 'none' }) },
  { test: /\/EmptyState$/, code: recorder('EmptyState', { draw: 'none' }) },
  { test: /\/ListPager$/, code: recorder('ListPager', { draw: 'none' }) },
  { test: /\/FilterSelect$/, code: recorder('FilterSelect', { draw: 'none' }) },
  { test: /\/CustomerThread$/, code: `${recorder('CustomerThread', { draw: 'none' })}
export function WaitedFor(p) { (globalThis.__HR.seen.WaitedFor ||= []).push(p); return null; }` },
];

let Inbox = null;
try {
  Inbox = (await bundle('src/components/CustomerMessagesInbox.jsx', SHIMS, { tag: 'cmi' })).default;
} catch (e) {
  fails.push(`the inbox bundles and loads (${String(e?.message || e).split('\n')[0]})`);
}

const PANES = { sizes: { left: 340, right: 320 }, dragging: null, onDragStart: () => () => {} };
const props = { panes: PANES, paneRef: { current: null }, onActivity: () => {} };
// Mount as `userId` on `search`; → what the screen shows and asked for.
async function open(userId, search) {
  Object.assign(R, { state: { users: USERS, clients: CLIENTS }, user: USERS.find((u) => u.id === userId), search });
  const tree = await mount(Inbox, props);
  return look(tree);
}
function look(tree) {
  const v = view(tree);
  const managerSelect = (R.seen.FilterSelect || []).find((p) => p.ariaLabel === core.english('custMsg.filter.manager'));
  const waitingCalls = R.calls.filter(([k]) => k === 'waiting').map(([, q]) => q);
  const rows = v.byClass('thread-row-name').map((n) => [].concat(n.props.children).join(''));
  return { v, managerSelect, waitingCalls, lastWaiting: waitingCalls[waitingCalls.length - 1] || null, rows };
}
const labelOf = (sel, value) => (sel?.options || []).find((o) => o.value === value)?.label;
const ME = (name) => core.english('reportKit.me', { name });

if (Inbox) {
  // S1 — a manager lands on Waiting (the Home tile's link carries no ?mgr for a manager).
  const s1 = await open('u_mgr', 'inbox=customers&view=waiting');
  ok('🔴 S1a a manager\'s Waiting view asks the server for THEIR buildings', () => s1.lastWaiting?.managerId === 'u_mgr', JSON.stringify(s1.waitingCalls));
  ok('🔴 S1b …and lists only their waiting threads (2, not every manager\'s 3)', () => s1.rows.length === 2 && s1.rows.every((r) => /Coral Bay|Lakeside/.test(r)), JSON.stringify(s1.rows));
  ok('🔴 S1c the Manager filter says so: it opens on "(me)"', () => s1.managerSelect?.value === 'u_mgr' && labelOf(s1.managerSelect, 'u_mgr') === ME('Renata Cruz'),
    `${s1.managerSelect?.value} / ${labelOf(s1.managerSelect, s1.managerSelect?.value)}`);

  // S2 — widening to All managers.
  if (s1.managerSelect?.onChange) {
    s1.managerSelect.onChange('');
    const s2 = look(await settle(Inbox, props));
    ok('S2a widening to All managers keeps the choice in the URL (?mgr=all, never an empty value that snaps back to "me")',
      () => new URLSearchParams(R.search).get('mgr') === 'all', R.search);
    ok('S2b …and reads every manager\'s waiting threads', () => !s2.lastWaiting?.managerId && s2.rows.length === 3, `${JSON.stringify(s2.lastWaiting)} ${JSON.stringify(s2.rows)}`);
    ok('S2c …the filter now reads All managers', () => s2.managerSelect?.value === '', s2.managerSelect?.value);
  } else ok('S2 the Manager filter can be changed', false);

  // S3 — the owner, from the Manager view's Customer messages tile with Yolanda picked.
  const s3 = await open('u_owner', 'inbox=customers&view=waiting&mgr=u_lee');
  ok('🔴 S3a the owner\'s pick rides into the Waiting view: it asks for that manager\'s buildings', () => s3.lastWaiting?.managerId === 'u_lee', JSON.stringify(s3.waitingCalls));
  ok('🔴 S3b …lists that manager\'s waiting thread only', () => s3.rows.length === 1 && /Olympic/.test(s3.rows[0]), JSON.stringify(s3.rows));
  ok('🔴 S3c …and the filter shows the pick', () => s3.managerSelect?.value === 'u_lee', s3.managerSelect?.value);

  // S4 — the owner with no pick: every manager's, as before.
  const s4 = await open('u_owner', 'inbox=customers&view=waiting');
  ok('S4 the owner with no ?mgr reads All managers (the shared login is unchanged)', () => !s4.lastWaiting?.managerId && s4.rows.length === 3 && s4.managerSelect?.value === '',
    `${JSON.stringify(s4.lastWaiting)} ${s4.rows.length}`);

  // S5 — a manager who supervises nothing would see nothing under "(me)".
  const s5 = await open('u_new', 'inbox=customers&view=waiting');
  ok('S5 a manager who supervises no building opens on All managers', () => !s5.lastWaiting?.managerId && s5.managerSelect?.value === '', `${JSON.stringify(s5.lastWaiting)} ${s5.managerSelect?.value}`);
}

// S6 — the rule, once, and both pages read it.
{
  const value = typeof MF.managerFilterValue === 'function' ? MF.managerFilterValue : () => undefined;
  const param = typeof MF.managerFilterParam === 'function' ? MF.managerFilterParam : () => undefined;
  const mgr = USERS[1];
  const owner = USERS[0];
  ok('🔴 S6a lib/managerFilter: no ?mgr → a supervising manager is their own default', () => value({ viewer: mgr, clients: CLIENTS, mgrParam: null }) === 'u_mgr');
  ok('S6b …?mgr=all → All managers; ?mgr=<id> → that manager', () => value({ viewer: mgr, clients: CLIENTS, mgrParam: MF.ALL_MANAGERS_PARAM }) === ''
    && value({ viewer: mgr, clients: CLIENTS, mgrParam: 'u_lee' }) === 'u_lee');
  ok('S6c …the owner and a manager with no buildings default to All managers', () => value({ viewer: owner, clients: CLIENTS, mgrParam: null }) === ''
    && value({ viewer: USERS[3], clients: CLIENTS, mgrParam: null }) === '');
  ok('S6d …a pick writes the manager, `all` over a default of "me", or nothing', () => param('u_lee', 'u_mgr') === 'u_lee' && param('', 'u_mgr') === MF.ALL_MANAGERS_PARAM && param('', '') === null);
  const src = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
  for (const f of ['src/pages/ClientRequests.jsx', 'src/components/CustomerMessagesInbox.jsx']) {
    ok(`🔴 S6e ${f} reads the one rule (lib/managerFilter), never its own copy`, () => /from '\.\.\/lib\/managerFilter'/.test(src(f)) && /managerFilterValue\(/.test(src(f)) && !/mgrParam === 'all'/.test(src(f)));
  }
}

unmount();
console.log(`\ntest-customer-inbox-scope: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
