// MATT'S ROUTING RULE FOR A CUSTOMER'S MESSAGE (client hub redesign, plan §3.4; D4).
//
// Matt, relayed by Daniel 2026-10-08: "messages should be routed to the assigned manager to that
// customer/site, however, if there is no manager, it needs to be sent to a fallback Admin role."
// Daniel's D4 made it exact: the building's manager is `client.supervisorId` while that person is
// active and still Super Admin, Admin or Manager (resolveAccountSupervisor); otherwise — or when
// they muted customer messages — EVERY active Admin; with no active Admin, the Super Admin(s), so a
// customer's message is never sent to nobody. Crew never. The actor is never told about their own
// message. One bell row per recipient.
//
// ONE pure function, `fanOutManagerOrAdmins` (src/lib/notifications.js), beside
// fanOutSupervisorFirst. This suite drives it over hand-built states, every case the plan lists,
// plus the catalog entry it rides (`customerMessage`) and the M2 switch (HUB-21) that routes a
// PORTAL ticket the same way: Matt picked (a) on 2026-10-08, built with CS-639 (sections 6 and 7).
//
// REGRESSION (THE LAW II.3): on the pre-change tree there is no fanOutManagerOrAdmins, no
// `customerMessage` event and no switch, so every check below fails.
//
//   node app/scripts/test-hub-message-routing.mjs
const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const notif = await tryImport('../src/lib/notifications.js');
const meta = await tryImport('../src/lib/notificationMeta.js');
const roles = await tryImport('../src/lib/roles.js');
const hubMessages = await tryImport('../src/lib/hubMessages.js');
const ticketAlerts = await tryImport('../src/lib/ticketAlerts.js');
const opsApply = await tryImport('../src/lib/opsAlertApply.js');
const { english } = await import('../src/i18n/core.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail) — the order test-client-hub-routes.mjs uses.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

const EVENT = notif.CUSTOMER_MESSAGE_EVENT;
// On a tree without the function every case answers null, so each check FAILS on its own line
// (a throw here would stop the suite at the first case and hide the rest).
const route = (state, args = {}) => {
  if (typeof notif.fanOutManagerOrAdmins !== 'function') return null;
  return notif.fanOutManagerOrAdmins({ notifications: [], ...state }, {
    clientId: 'cl_a', eventKey: EVENT, title: 'Coral Bay HOA: message from Pat M.', body: 'The lobby door sticks.', url: '/messaging?inbox=customers&b=cl_a', actorUserId: null, ...args,
  });
};
const who = (rows) => (rows || []).map((r) => r.userId).sort().join(',');

const user = (id, role, extra = {}) => ({ id, role, name: id, status: 'active', email: `${id}@x.test`, notificationPrefs: {}, ...extra });
const muted = { notificationPrefs: { customerMessage: false } };
// A team with every tier, two of each office tier so "every" is tested against "the first".
const team = (over = {}) => [
  user('u_owner', 'owner', over.u_owner),
  user('u_owner2', 'owner', over.u_owner2),
  user('u_admin', 'admin', over.u_admin),
  user('u_admin2', 'admin', over.u_admin2),
  user('u_mgr', 'manager', over.u_mgr),
  user('u_mgr2', 'manager', over.u_mgr2),
  user('u_crew', 'crew', over.u_crew),
].filter((u) => !over[u.id]?.gone);
const state = ({ supervisorId = 'u_mgr', users = team(), permissions = roles.seedPermissions?.() || [], overrides = [] } = {}) => ({
  users,
  clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId }],
  permissions,
  userPermissionOverrides: overrides,
});

// ── 0. the pieces exist ───────────────────────────────────────────────────────
ok('Z0 notifications.js exports fanOutManagerOrAdmins', typeof notif.fanOutManagerOrAdmins === 'function', notif.__error || '');
ok('Z1 …and the event key as a constant (customerMessage)', EVENT === 'customerMessage', String(EVENT));
const item = (notif.NOTIFICATION_GROUPS || []).flatMap((g) => g.items.map((i) => ({ ...i, group: g.id }))).find((i) => i.key === EVENT);
ok('Z2 the event is in the catalog, in the QUALITY group', item?.group === 'quality', JSON.stringify(item || null));
ok('Z3 …office tiers only (owner/admin/manager), never crew', () => [...(item.roleAllowlist || [])].sort().join() === 'admin,manager,owner');
ok('Z4 …gated on the permission that opens the Customers tab (hub.messages.view)', () => item.requiresPermission === 'hub.messages.view');
ok('Z5 …its words are catalog lines that exist in English', () => !!english(item.labelKey) && !!english(item.descKey) && item.labelKey !== english(item.labelKey));
ok('Z6 the bell list knows the event (icon + Messages chip)', () => meta.EVENT_META?.[EVENT]?.filter === 'messages', JSON.stringify(meta.EVENT_META?.[EVENT] || null));
ok('Z7 the two permission keys exist, owner/admin/manager by default, never crew',
  () => ['hub.messages.view', 'hub.messages.reply'].every((k) => [...(roles.PERMISSIONS?.[k]?.defaultRoles || [])].sort().join() === 'admin,manager,owner'));
ok('Z8 …and each has a home in the Roles matrix (one group)',
  () => ['hub.messages.view', 'hub.messages.reply'].every((k) => (roles.PERM_GROUPS || []).filter((g) => g.keys.includes(k)).length === 1));

// ── 1. the building's manager, alone ──────────────────────────────────────────
{
  const rows = route(state());
  ok('🔴 R1 a valid manager gets it — and only the manager', () => who(rows) === 'u_mgr', who(rows));
  const r = rows?.[0] || {};
  ok('R2 the row: the event key, the deep link to the Customers tab, unread', () => r.eventKey === EVENT && r.url === '/messaging?inbox=customers&b=cl_a' && r.readAt === null);
  ok('R3 …the title and the customer\'s words, as written', () => r.title === 'Coral Bay HOA: message from Pat M.' && r.body === 'The lobby door sticks.');
  const supOwner = route(state({ supervisorId: 'u_owner' }));
  ok('R4 a Super Admin can be the building\'s manager too — then only they get it', () => who(supOwner) === 'u_owner', who(supOwner));
  const supAdmin = route(state({ supervisorId: 'u_admin' }));
  ok('R5 …and so can an Admin', () => who(supAdmin) === 'u_admin', who(supAdmin));
}

// ── 2. no usable manager → EVERY active Admin ─────────────────────────────────
{
  const ADMINS = 'u_admin,u_admin2';
  const inactive = route(state({ users: team({ u_mgr: { status: 'disabled' } }) }));
  ok('🔴 R6 the manager is INACTIVE → every active Admin', () => who(inactive) === ADMINS, who(inactive));
  const demoted = route(state({ users: team({ u_mgr: { role: 'crew' } }) }));
  ok('🔴 R7 the manager was DEMOTED to crew → the Admins (and the demoted cleaner gets nothing)', () => who(demoted) === ADMINS, who(demoted));
  const mute = route(state({ users: team({ u_mgr: muted }) }));
  ok('🔴 R8 the manager MUTED customer messages → the Admins', () => who(mute) === ADMINS, who(mute));
  const none = route(state({ supervisorId: null }));
  ok('R9 the building has no manager at all → the Admins', () => who(none) === ADMINS, who(none));
  const ghost = route(state({ supervisorId: 'u_gone' }));
  ok('R10 the manager left the team (no roster row) → the Admins', () => who(ghost) === ADMINS, who(ghost));
  const noView = route(state({ overrides: [{ userId: 'u_mgr', grants: [], revokes: ['hub.messages.view'] }] }));
  ok('R11 the manager cannot open customer messages (hub.messages.view revoked) → the Admins', () => who(noView) === ADMINS, who(noView));
  const oneAdminOff = route(state({ supervisorId: null, users: team({ u_admin2: { status: 'disabled' } }) }));
  ok('R12 a disabled Admin is skipped; the active one still gets it', () => who(oneAdminOff) === 'u_admin', who(oneAdminOff));
  const oneAdminMuted = route(state({ supervisorId: null, users: team({ u_admin2: muted }) }));
  ok('R13 an Admin who muted the event is skipped; the other still gets it', () => who(oneAdminMuted) === 'u_admin', who(oneAdminMuted));
  ok('R14 the fallback never adds the Super Admins or the other managers', () => !/u_owner|u_mgr2/.test(who(none)), who(none));
}

// ── 3. no active Admin → the Super Admin(s), never nobody ─────────────────────
{
  const OWNERS = 'u_owner,u_owner2';
  const noAdmins = route(state({ supervisorId: null, users: team({ u_admin: { status: 'disabled' }, u_admin2: { gone: true } }) }));
  ok('🔴 R15 no active Admin → every active Super Admin', () => who(noAdmins) === OWNERS, who(noAdmins));
  const allMuted = route(state({ supervisorId: null, users: team({ u_admin: muted, u_admin2: muted }) }));
  ok('🔴 R16 every Admin muted it → the Super Admins', () => who(allMuted) === OWNERS, who(allMuted));
  const ownerMuted = route(state({ supervisorId: null, users: team({ u_admin: muted, u_admin2: muted, u_owner: muted }) }));
  ok('🔴 R17 the Super Admins are the backstop: told even if they muted it, so it is never sent to nobody', () => who(ownerMuted) === OWNERS, who(ownerMuted));
  const ownerOff = route(state({ supervisorId: null, users: team({ u_admin: { gone: true }, u_admin2: { gone: true }, u_owner2: { status: 'disabled' } }) }));
  ok('R18 …an inactive Super Admin is not', () => who(ownerOff) === 'u_owner', who(ownerOff));
  const mgrNoAdmins = route(state({ users: team({ u_mgr: muted, u_admin: { gone: true }, u_admin2: { gone: true } }) }));
  ok('R19 a muted manager with no Admins → the Super Admins', () => who(mgrNoAdmins) === OWNERS, who(mgrNoAdmins));
}

// ── 4. crew never; the actor never; one row each ──────────────────────────────
{
  const everyCase = [
    route(state()), route(state({ supervisorId: null })), route(state({ supervisorId: 'u_crew' })),
    route(state({ supervisorId: null, users: team({ u_admin: { gone: true }, u_admin2: { gone: true } }) })),
  ];
  ok('🔴 R20 crew never receive it, in any branch (a cleaner set as the "manager" included)', () => everyCase.every((rows) => !(rows || []).some((r) => r.userId === 'u_crew')), everyCase.map(who).join(' | '));
  const crewSup = route(state({ supervisorId: 'u_crew' }));
  ok('R21 a cleaner named as the building\'s manager is not a manager: the Admins get it', () => who(crewSup) === 'u_admin,u_admin2', who(crewSup));
  const actorMgr = route(state(), { actorUserId: 'u_mgr' });
  ok('🔴 R22 the ACTOR is never told about their own message (the manager wrote it)', () => !(actorMgr || []).some((r) => r.userId === 'u_mgr'), who(actorMgr));
  const actorAdmin = route(state({ supervisorId: null }), { actorUserId: 'u_admin' });
  ok('R23 …nor an Admin who wrote it: the other Admins still are', () => who(actorAdmin) === 'u_admin2', who(actorAdmin));
  const actorOwner = route(state({ supervisorId: null, users: team({ u_admin: { gone: true }, u_admin2: { gone: true } }) }), { actorUserId: 'u_owner' });
  ok('R24 …nor a Super Admin on the backstop branch', () => who(actorOwner) === 'u_owner2', who(actorOwner));
  const dupUsers = [...team(), user('u_mgr', 'manager')];
  const once = route(state({ users: dupUsers }));
  ok('🔴 R25 ONE bell row per recipient (a duplicated roster row rings once)', () => (once || []).filter((r) => r.userId === 'u_mgr').length === 1, who(once));
  const fallbackOnce = route(state({ supervisorId: null }));
  ok('R26 …and every Admin gets exactly one', () => ['u_admin', 'u_admin2'].every((id) => (fallbackOnce || []).filter((r) => r.userId === id).length === 1), who(fallbackOnce));
  const prior = [{ id: 'nt_old', userId: 'u_mgr', createdAt: new Date().toISOString(), readAt: null, eventKey: 'newDM', title: 'x', body: '', url: '/' }];
  const kept = notif.fanOutManagerOrAdmins?.({ ...state(), notifications: prior }, { clientId: 'cl_a', eventKey: EVENT, title: 't', body: 'b', url: '/u', actorUserId: null });
  ok('R27 the earlier rows are kept (the fan-out inserts through capInsert)', () => (kept || []).some((r) => r.id === 'nt_old') && (kept || []).length === 2);
}

// ── 5. the alert's words and link (src/lib/hubMessages.js) ────────────────────
{
  const alert = hubMessages.customerMessageAlert?.({ clientId: 'cl_a', placeName: 'Coral Bay HOA', authorName: 'Pat Manager', body: `  ${'x'.repeat(300)}  ` });
  ok('A1 the alert links to the building\'s thread in Messaging → Customers', () => alert.url === '/messaging?inbox=customers&b=cl_a' && alert.url === hubMessages.customerThreadUrl('cl_a'), JSON.stringify(alert || hubMessages.__error || null));
  ok('A2 the title is a catalog MESSAGE (rendered in each reader\'s language)', () => alert.title?.$t === 'alerts.customerMessage.title' && english(alert.title.$t, alert.title.p) === 'Coral Bay HOA: message from Pat Manager');
  ok('A3 the body is the customer\'s own words, trimmed to 140 characters', () => typeof alert.body === 'string' && alert.body.length <= 140 && alert.body.startsWith('xxx'));
  const noName = hubMessages.customerMessageAlert?.({ clientId: 'cl_a', placeName: 'Coral Bay HOA', authorName: '', body: 'Hi' });
  ok('A4 a customer with no name on file still reads as a sentence', () => noName.title?.$t === 'alerts.customerMessage.titleNoName' && /Coral Bay HOA/.test(english(noName.title.$t, noName.title.p)));
}

// ── 6. HUB-21 (Matt, 2026-10-08: "(a) The Admins, the same as messages") ──────
// A customer's request from the Client Hub, at a building with no manager, rings the Admins (the
// customer-message rule above); a cleaner's or a visitor's ticket keeps WO-6's whole office bench.
// REGRESSION: before his answer was built the switch read 'office' and there was no chooser by
// origin, so M1 and M4 fail there.
{
  const s = state({ supervisorId: null });
  const args = { clientId: 'cl_a', eventKey: 'problemReported', title: 'Work order', body: 'x', url: '/inspections?tab=workorders', actorUserId: null };
  const portal = notif.fanOutPortalTicket?.({ ...s, notifications: [] }, args);
  ok('M1 the switch is set to Matt\'s answer (a): with no manager, a customer\'s request rings the Admins',
    () => notif.PORTAL_TICKET_NO_MANAGER_ROUTE === 'admins' && who(portal) === 'u_admin,u_admin2', who(portal));
  const office = notif.fanOutPortalTicket?.({ ...s, notifications: [] }, args, 'office');
  ok('M2 …the other setting is still WO-6\'s whole office bench', () => who(office) === 'u_admin,u_admin2,u_mgr,u_mgr2,u_owner,u_owner2', who(office));
  const withMgr = notif.fanOutPortalTicket?.({ ...state(), notifications: [] }, args);
  ok('M3 …the building\'s manager still comes first', () => who(withMgr) === 'u_mgr', who(withMgr));
  ok('M4 one chooser by origin: only a customer\'s ticket takes the hub route; a cleaner\'s or a visitor\'s keeps WO-6',
    () => notif.ticketFanOut('portal') === notif.fanOutPortalTicket
      && ['internal', 'visitor', undefined, null].every((o) => notif.ticketFanOut(o) === notif.fanOutSupervisorFirst));
}

// ── 7. CS-639: every repeat of a customer's request follows its first alert ──────
// The 10-minute repeats, and the hourly ones after a reply, come from the cron's walker
// (lib/ticketAlerts) and are routed by lib/opsAlertApply. They carried no ticket origin and always
// took WO-6's route, so under (a) the first alert would ring the Admins and every repeat the whole
// office. REGRESSION: on the pre-fix tree the walker drops the origin (R1) and a customer's repeat
// rings all six office seats (R2, R5). R3 pins that the first alert and its repeats agree.
{
  const NOW = Date.parse('2026-10-14T14:00:00.000Z'); // Wednesday 10:00 in New York
  const MIN = 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  const clients = [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId: null }];
  const ticket = (id, origin, over = {}) => ({
    id, client_id: 'cl_a', origin, type: 'request', priority: 'urgent', status: 'open', title: 'Lobby door', created_at: iso(NOW - 15 * MIN), ...over,
  });
  const walk = (tickets, extra = {}) => ticketAlerts.getDueTicketAlerts?.({ tickets, now: NOW, timeZone: 'America/New_York', clients, ...extra }) || [];
  const due = walk([ticket('t_hub', 'portal'), ticket('t_crew', 'internal')]);
  const repeatOf = (id) => due.find((a) => a.refId === id && a.kind === 'ticketRepeat');
  ok('R1 the walker carries each ticket\'s origin onto its alerts', () => repeatOf('t_hub').origin === 'portal' && repeatOf('t_crew').origin === 'internal',
    JSON.stringify(due.map((a) => [a.refId, a.kind, a.origin]) || ticketAlerts.__error));
  const s = { ...state({ supervisorId: null }), notifications: [], opsAlertEvents: [], opsSettings: {} };
  const ring = (st, alert) => (alert ? opsApply.applyOpsAlert?.(st, alert, { now: NOW })?.notifications : null);
  const hubRepeat = ring(s, repeatOf('t_hub'));
  ok('R2 with no manager, a repeat of a customer\'s request rings the Admins', () => who(hubRepeat) === 'u_admin,u_admin2', who(hubRepeat));
  const first = notif.fanOutPortalTicket?.({ ...s }, { clientId: 'cl_a', eventKey: repeatOf('t_hub')?.eventKey, title: 't', body: 'b', url: '/u', actorUserId: null });
  ok('R3 …the same people its first alert rang', () => !!who(first) && who(hubRepeat) === who(first), `${who(hubRepeat)} vs ${who(first)}`);
  const crewRepeat = ring(s, repeatOf('t_crew'));
  ok('R4 a repeat of a cleaner\'s ticket still rings the whole office (WO-6, unchanged)', () => who(crewRepeat) === 'u_admin,u_admin2,u_mgr,u_mgr2,u_owner,u_owner2', who(crewRepeat));
  const replied = walk([ticket('t_hub', 'portal', { created_at: iso(NOW - 180 * MIN) })], { repliedAt: { t_hub: iso(NOW - 70 * MIN) } });
  const hourly = replied.find((a) => a.kind === 'ticketOpenRepeat');
  ok('R5 the hourly repeat after a reply follows it too', () => hourly.origin === 'portal' && who(ring(s, hourly)) === 'u_admin,u_admin2',
    JSON.stringify(replied.map((a) => [a.kind, a.origin])));
  const managed = { ...s, clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr' }] };
  ok('R6 with a manager, the repeat goes to the manager alone', () => who(ring(managed, repeatOf('t_hub'))) === 'u_mgr', who(ring(managed, repeatOf('t_hub'))));
  const late = walk([ticket('t_hub', 'portal', { created_at: iso(NOW - 35 * MIN) })]).find((a) => a.kind === 'ticketEscalate');
  ok('R7 the 30-minute "no reply yet" escalation still reaches the whole office (WO-5; HUB-21 does not change it)',
    () => who(ring(s, late)) === 'u_admin,u_admin2,u_mgr,u_mgr2,u_owner,u_owner2', who(ring(s, late)));
}

console.log(`\nhub message routing: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
