// Every kind of notification has a look on the phone.
//
// ══ THE DEFECT (2026-10-03) ═══════════════════════════════════════════════════
// The bell's phone list chose each row's icon and colour from a table inside the component,
// keyed by eventKey. Events were added to the catalog (lib/notifications.js
// NOTIFICATION_GROUPS) without a row there: eight of them (contractReminder,
// supplyBudgetExceeded, supplyOrderDue, supplyOrderOverdue, supplyRequestApproved,
// supplyRequestRejected, ticketUnanswered, ticketUrgent) fell back to a grey bell. One was
// the URGENT WORK ORDER, so the most pressing row on the list looked like the least.
//
// The table now lives in lib/notificationMeta.js, and this pins it to the catalog both ways:
// every catalog event has a row, every row is a catalog event (replace means delete), every
// icon exists, every chip it names exists and has its words in the catalog.
import { readFileSync } from 'node:fs';
import { NOTIFICATION_GROUPS } from '../src/lib/notifications.js';
import { EVENT_META, NOTIFICATION_FILTERS, notificationMeta } from '../src/lib/notificationMeta.js';

let pass = 0;
let fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; } else { fail++; console.log(`FAIL  ${label}`); }
};

const catalogKeys = NOTIFICATION_GROUPS.flatMap((g) => g.items.map((i) => i.key));
const metaKeys = Object.keys(EVENT_META);

// 1. Every event the catalog can raise has a look.
const missing = catalogKeys.filter((k) => !EVENT_META[k]);
ok(`every catalog event has a row in EVENT_META (missing: ${missing.join(', ') || 'none'})`, missing.length === 0);
ok('the catalog is not empty (the import really read it)', catalogKeys.length >= 30);

// 2. No row for an event that no longer exists.
const stale = metaKeys.filter((k) => !catalogKeys.includes(k));
ok(`no EVENT_META row for a retired event (stale: ${stale.join(', ') || 'none'})`, stale.length === 0);

// 3. Every icon is one Icon.jsx draws (an unknown name renders nothing).
const iconSrc = readFileSync(new URL('../src/components/Icon.jsx', import.meta.url), 'utf8');
const pathsBlock = iconSrc.slice(iconSrc.indexOf('const paths = {'), iconSrc.indexOf('\n};', iconSrc.indexOf('const paths = {')));
const iconNames = new Set([...pathsBlock.matchAll(/^ {2}([A-Za-z0-9]+):/gm)].map((m) => m[1]));
ok('Icon.jsx paths were read', iconNames.size > 20 && iconNames.has('bell'));
for (const [k, m] of Object.entries(EVENT_META)) {
  ok(`${k}: icon "${m.icon}" exists in Icon.jsx`, iconNames.has(m.icon));
}
ok('the fallback icon exists', iconNames.has(notificationMeta('noSuchEvent').icon));

// 4. Every row sits under exactly one known chip, and each chip has its words.
const filterIds = new Set(NOTIFICATION_FILTERS.map((f) => f.id));
for (const [k, m] of Object.entries(EVENT_META)) {
  ok(`${k}: filter "${m.filter}" is a chip`, filterIds.has(m.filter));
  ok(`${k}: alert is a boolean or absent`, m.alert === undefined || typeof m.alert === 'boolean');
}
const en = readFileSync(new URL('../src/i18n/catalog/en.js', import.meta.url), 'utf8');
for (const f of NOTIFICATION_FILTERS) {
  ok(`chip ${f.id}: ${f.labelKey} is in the English catalog`, en.includes(`'${f.labelKey}':`));
  ok(`chip ${f.id} is used by at least one event`, Object.values(EVENT_META).some((m) => m.filter === f.id));
}
ok('an unknown event falls back to a plain bell under All only', notificationMeta('noSuchEvent').filter === null);

// 5. The ones that must read as urgent do.
for (const k of ['shiftMissed', 'ticketUrgent', 'offSitePunch', 'inspectionRedo', 'invoiceOverdue']) {
  ok(`${k} is an alert (red on the phone)`, EVENT_META[k]?.alert === true);
}

// 6. The list reads the shared table, not a private copy.
const list = readFileSync(new URL('../src/components/MobileNotificationList.jsx', import.meta.url), 'utf8');
ok('MobileNotificationList imports lib/notificationMeta', /from '\.\.\/lib\/notificationMeta'/.test(list));
ok('MobileNotificationList keeps no table of its own', !/const EVENT_META\s*=/.test(list));

console.log(`\ntest-notification-meta: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
