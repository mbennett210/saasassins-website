// THE CUSTOMER HUB'S MESSAGES, BELL AND EMAIL SWITCHES ARE WIRED END TO END (the client hub
// redesign, plan §3.4 "Hub screens", Wave B, 2026-10-08).
//
// The server half (api/hub's messages / message / messages-read / updates / updates-seen /
// email-prefs) is held by test-hub-messages-routes.mjs and test-hub-email-prefs.mjs. This suite
// holds the SCREENS to it:
//   1. Messages is a building section: ONE nav entry (a bottom item and the phone tab between Home
//      and Account), its route in App.jsx, its sweep path in app-routes.mjs, and its unread badge
//      read from the bell's answer (`messagesUnread`) for the building in view;
//   2. the page polls every 30 s (HUB_MESSAGES_POLL_MS), marks the thread read, pages back through
//      `before`, sends with a caller-minted id, and says the plan's words;
//   3. Home's Message button and the bell are slot entries (hubSlots.js), the bell posts
//      updates-seen on open and is a MobileSheet on a phone;
//   4. the Account page's Emails card: the three switches, saved through the hub's adapter, reverted
//      on a failed save, disabled in the office's READ-ONLY preview (the layout's one `readOnly`
//      flag, UI_RULES §151; a preview acting as the customer saves the stand-in's own switches);
//   5. the pure rules the screens use (lib/hubMessages.js): the badge count, the bell's relative
//      time, and the thread merge (no line twice, oldest first);
//   6. a customer email never says "Ticket" (decision D6: the customer's word is "request").
//
// REGRESSION (THE LAW II.3): on the tree before Wave B there is no HubMessages page, no slot entry,
// no Emails card, no screen helper, and notify.js falls back to 'Ticket', so every check fails.
//
//   node app/scripts/test-hub-messages-screens.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(APP, 'src', 'pages', 'hub');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const load = async (rel) => { try { return await import(pathToFileURL(path.join(APP, rel)).href); } catch { return {}; } };

const nav = await load('src/pages/hub/hubNav.js');
const lib = await load('src/lib/hubMessages.js');
const entries = Array.isArray(nav.HUB_NAV) ? nav.HUB_NAV : [];
const msgEntry = entries.find((e) => e.key === 'messages');
const app = code('src/App.jsx');
const routes = code('scripts/app-routes.mjs');

// ── 1. a building section ────────────────────────────────────────────────────
ok('M1 Messages is ONE nav entry: a bottom item on the section "messages"',
  () => msgEntry && msgEntry.place === 'bottom' && msgEntry.section === 'messages' && msgEntry.icon === 'messaging');
ok('M2 …and the phone tab between Home and Account (Home · Messages · Account)', () => {
  const tabs = typeof nav.hubNavTabs === 'function' ? nav.hubNavTabs().map((e) => e.key) : [];
  return tabs.join(',') === 'home,messages,account';
});
ok('M3 …above Account in the sidebar\'s bottom group', () => {
  const bottom = typeof nav.hubNavBottom === 'function' ? nav.hubNavBottom().map((e) => e.key) : [];
  return bottom.indexOf('messages') > -1 && bottom.indexOf('messages') < bottom.indexOf('account');
});
ok('M4 the route is in App.jsx, lazy-loaded', () => app.includes('path="/hub/b/:buildingId/messages" element={<HubMessages />}')
  && /const HubMessages = lazyRoute\(\(\) => import\('\.\/pages\/hub\/HubMessages'\)\)/.test(app));
ok('M5 the sweep has a real path for it (app-routes.mjs PARAMS)', () => routes.includes("'/hub/b/:buildingId/messages': ['/hub/b/cl_seed_mtbaker/messages']"));
ok('M6 the badge is the building in view\'s unread count, from the bell\'s answer', () => {
  const updates = { messagesUnread: [{ buildingId: 'b1', count: 3 }, { buildingId: 'b2', count: 1 }] };
  const a = msgEntry.badge({ building: { id: 'b1' }, updates });
  const off = msgEntry.badge({ building: null, currentId: 'b2', updates });
  return a?.text === '3' && off?.text === '1'
    && msgEntry.badge({ building: { id: 'b3' }, updates }) === null
    && msgEntry.badge({ building: { id: 'b1' }, updates: null }) === null;
});
const layout = code('src/layouts/HubLayout.jsx');
ok('M7 the layout reads the bell\'s answer once and hands it to the nav and the pages (ctx.updates)',
  () => /useHubUpdates\(/.test(layout) && /updates: /.test(layout));
ok('M8 the phone tab shows the badge too (a customer\'s phone has no sidebar)', () => /cls === 'hub-tab' && <span className="hub-tab-badge"/.test(layout));

// ── 2. the page ──────────────────────────────────────────────────────────────
const page = code('src/pages/hub/HubMessages.jsx');
ok('P1 HubMessages.jsx exists and draws its own <BackLink> under the section heading',
  () => existsSync(path.join(HUB, 'HubMessages.jsx')) && /<BackLink\b/.test(page) && /<HubSectionHead\b/.test(page));
ok('P2 it polls every 30 s while visible (plan §3.4)', () => lib.HUB_MESSAGES_POLL_MS === 30000 && /useHubRefresh\([^)]*HUB_MESSAGES_POLL_MS\)/.test(page));
ok('P3 it marks the thread read (on open and when new lines arrive) and refreshes the badge',
  () => /markHubMessagesRead\(/.test(page) && /reloadHubUpdates\(/.test(page));
ok('P4 "Load earlier" pages back through `before`', () => /Load earlier/.test(page) && /fetchHubMessages\([^)]*before/.test(page));
ok('P5 Send posts with a caller-minted id (a retried Send is one line)', () => /postHubMessage\(\{[^}]*\bid\b/.test(page) && /randomUUID/.test(page));
ok('P6 the composer grows with its text (AutoGrowTextarea) and is bounded by HUB_MESSAGE_BODY_MAX',
  () => /<AutoGrowTextarea\b/.test(page) && /maxLength=\{HUB_MESSAGE_BODY_MAX\}/.test(page));
ok('P7 the plan\'s words: the manager line, the team fallback, the empty state',
  () => page.includes('Your account manager: ') && page.includes('Your account team') && page.includes('Send your account manager a message.'));
ok('P8 the hub stays English: no catalog on the page (LANG-8)', () => page.length > 0 && !/useT\(|from '\.\.\/\.\.\/i18n/.test(page));

// ── 3. the slots ─────────────────────────────────────────────────────────────
const slots = code('src/pages/hub/hubSlots.js');
const button = code('src/pages/hub/HubMessageButton.jsx');
const bell = code('src/pages/hub/HubBell.jsx');
ok('S1 Message is a HUB_ACTIONS entry, before Call', () => /\{ key: 'message', order: 10, Component: HubMessageButton \}/.test(slots));
ok('S2 the Message button opens …/messages with its referrer, named for a screen reader',
  () => /sectionPath\([^)]*'messages'\)/.test(button) && /aria-label="Message account manager"/.test(button) && /state=\{nav\}/.test(button));
ok('S3 the bell is the HUB_BELL entry', () => /HUB_BELL = Object\.freeze\(\[\s*\{ key: 'bell', Component: HubBell \}/.test(slots));
ok('S4 the bell: a popover on a desktop, a MobileSheet on a phone, "Nothing new" when empty',
  () => /<MobileSheet\b/.test(bell) && /useIsMobile\(\)/.test(bell) && /useDismissTap\(/.test(bell) && bell.includes('Nothing new'));
ok('S5 opening the bell posts updates-seen (through the shared store)', () => /markHubUpdatesOpened\(/.test(bell)
  && /markSeen: markHubUpdatesSeen/.test(code('src/pages/hub/hubUpdates.js')));
ok('S6 each update links to its url with a referrer, and names its building and when',
  () => /to=\{u\.url\}/.test(bell) && /state=\{nav\}/.test(bell) && /u\.buildingName/.test(bell) && /hubAgo\(/.test(bell));

// ── 4. the Emails card ───────────────────────────────────────────────────────
const account = code('src/pages/hub/HubAccount.jsx');
const card = code('src/pages/hub/HubEmailsCard.jsx');
ok('E1 the Account page lists the Emails card', () => /\{ key: 'emails', Card: HubEmailsCard \}/.test(account));
ok('E2 the three switches, in the plan\'s words', () => ['Replies from the office', 'Updates on my requests', 'New inspection reports'].every((w) => card.includes(w)));
ok('E3 one switch per HUB_EMAIL_KINDS kind, saved on change through the hub adapter',
  () => /HUB_EMAIL_KINDS/.test(card) && /saveHubEmailPrefs\(/.test(card) && /fetchHubEmailPrefs\(/.test(card) && /toast\.success\(/.test(card));
ok('E4 a failed save puts the switch back and says so', () => /catch/.test(card) && /toast\.error\(/.test(card) && /wasn't saved|was not saved/.test(card));
ok('E5 disabled in the read-only preview (the layout\'s readOnly flag, never `preview` itself)', () => /disabled=\{[^}]*readOnly/.test(card) && !/disabled=\{[^}]*\bpreview\b/.test(card));

// ── 5. the pure screen rules ─────────────────────────────────────────────────
ok('R1 hubUnreadFor: the building\'s own count, 0 for anything else', () => typeof lib.hubUnreadFor === 'function'
  && lib.hubUnreadFor({ messagesUnread: [{ buildingId: 'a', count: 2 }] }, 'a') === 2
  && lib.hubUnreadFor({ messagesUnread: [{ buildingId: 'a', count: 2 }] }, 'b') === 0
  && lib.hubUnreadFor(null, 'a') === 0 && lib.hubUnreadFor({ messagesUnread: 'x' }, 'a') === 0);
ok('R2 hubAgo: just now, minutes, hours, yesterday, days, then the day', () => {
  if (typeof lib.hubAgo !== 'function') return false;
  const now = Date.parse('2026-10-08T15:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  return lib.hubAgo(at(20e3), now) === 'Just now'
    && lib.hubAgo(at(5 * 60e3), now) === '5 min ago'
    && lib.hubAgo(at(3 * 3600e3), now) === '3 h ago'
    && lib.hubAgo(at(26 * 3600e3), now) === 'Yesterday'
    && lib.hubAgo(at(3 * 86400e3), now) === '3 days ago'
    && /^[A-Z][a-z]{2} \d{1,2}$/.test(lib.hubAgo(at(9 * 86400e3), now))
    && lib.hubAgo(null, now) === '' && lib.hubAgo('nope', now) === '';
});
ok('R3 mergeHubLines: no line twice, oldest first, the newer copy of a line wins', () => {
  if (typeof lib.mergeHubLines !== 'function') return false;
  const a = [{ id: 'x', createdAt: '2026-10-08T10:00:00Z', body: 'old' }, { id: 'y', createdAt: '2026-10-08T11:00:00Z', body: 'y' }];
  const b = [{ id: 'x', createdAt: '2026-10-08T10:00:00Z', body: 'new' }, { id: 'w', createdAt: '2026-10-08T09:00:00Z', body: 'w' }];
  const m = lib.mergeHubLines(a, b);
  return m.map((l) => l.id).join(',') === 'w,x,y' && m[1].body === 'new' && lib.mergeHubLines(null, undefined).length === 0;
});

// ── 5b. the bell's one store (lib/hubUpdatesStore.js) ─────────────────────────
// Driven with reads the test resolves by hand. U1 is the bug the demo drive found in the first
// version: React mounts effects twice in development (subscribe, unsubscribe, subscribe), and the
// second subscribe was handed the first, dropped read, so the bell and the badge stayed empty
// until the next minute.
const storeLib = await load('src/lib/hubUpdatesStore.js');
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const harness = () => {
  const reads = [];
  const marks = [];
  const store = storeLib.createHubUpdatesStore({
    fetchUpdates: () => { const d = deferred(); reads.push(d); return d.promise; },
    markSeen: () => { const d = deferred(); marks.push(d); return d.promise; },
    doc: null,
  });
  return { store, reads, marks };
};
const answer = (unseen, extra = {}) => ({ updates: [{ kind: 'message', text: 't', at: '2026-10-08T10:00:00Z', url: '/hub/b/x/messages', unread: unseen > 0 }], unseen, seenAt: null, messagesUnread: [], ...extra });
if (typeof storeLib.createHubUpdatesStore !== 'function') {
  for (const l of ['U1', 'U2', 'U3', 'U4', 'U5', 'U6']) ok(`${l} the bell's store exists (lib/hubUpdatesStore.js createHubUpdatesStore)`, false);
} else {
  {
    const { store, reads } = harness();
    const off = store.subscribe(() => {});
    off();
    store.subscribe(() => {});
    await tick();
    reads[0]?.resolve(answer(5, { tag: 'first' }));
    reads[1]?.resolve(answer(3, { tag: 'second' }));
    await tick(); await tick();
    ok('U1 subscribe, unsubscribe, subscribe (React\'s development double mount): a fresh read lands, the dropped one does not',
      () => reads.length === 2 && store.getSnapshot().data?.tag === 'second', `reads=${reads.length} data=${JSON.stringify(store.getSnapshot().data)}`);
  }
  {
    const { store, reads } = harness();
    const off = store.subscribe(() => {});
    await tick();
    reads[0]?.resolve(answer(2));
    await tick(); await tick();
    const had = store.getSnapshot().data?.unseen === 2;
    off();
    ok('U2 the last unsubscribe forgets the answer (a sign-out never shows the next login the old bell)', () => had && store.getSnapshot().data === null);
  }
  {
    const { store, reads, marks } = harness();
    store.subscribe(() => {});
    await tick();
    reads[0]?.resolve(answer(4));
    await tick(); await tick();
    const opening = store.opened();
    await tick();
    reads[1]?.resolve(answer(4));
    await tick(); await tick();
    marks[0]?.resolve({ seenAt: '2026-10-08T12:00:00Z' });
    await opening;
    const d = store.getSnapshot().data;
    ok('U3 opening re-reads, then marks seen: the count clears and each row keeps its "new" dot until the next read',
      () => reads.length === 2 && marks.length === 1 && d.unseen === 0 && d.seenAt === '2026-10-08T12:00:00Z' && d.updates[0].unread === true);
  }
  {
    const { store, reads, marks } = harness();
    store.subscribe(() => {});
    await tick();
    reads[0]?.resolve(answer(4));
    await tick(); await tick();
    const opening = store.opened();
    await tick();
    reads[1]?.resolve(answer(4));
    await tick(); await tick();
    marks[0]?.reject(Object.assign(new Error('Preview: nothing here is sent.'), { status: 403 }));
    let threw = false;
    try { await opening; } catch { threw = true; }
    ok('U4 a refused mark (a preview) is quiet: the count stays, nothing throws', () => !threw && store.getSnapshot().data?.unseen === 4);
  }
  {
    const { store, reads } = harness();
    store.subscribe(() => {});
    store.setViewer('alice');
    await tick();
    reads[0]?.resolve(answer(1, { who: 'alice' }));
    await tick(); await tick();
    store.setViewer('bob');
    const cleared = store.getSnapshot().data === null;
    await tick();
    reads[1]?.resolve(answer(7, { who: 'bob' }));
    await tick(); await tick();
    ok('U5 a different viewer starts clean and reads again', () => cleared && reads.length === 2 && store.getSnapshot().data?.who === 'bob');
  }
  {
    const { store, reads } = harness();
    store.subscribe(() => {});
    store.reload();
    store.reload();
    await tick();
    ok('U6 reads in flight are shared: one request, however many ask', () => reads.length === 1);
  }
}

// ── 6. D6: the customer's word is "request" ──────────────────────────────────
const notify = code('api/_lib/clientHub/notify.js');
ok('D6 a customer email\'s untitled request falls back to "Request", never "Ticket"',
  () => notify.length > 0 && !/\|\| 'Ticket'/.test(notify) && (notify.match(/ticketTitle: problem\.title \|\| 'Request'/g) || []).length === 2);

console.log(`\nhub messages screens: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
