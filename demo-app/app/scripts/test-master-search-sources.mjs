// Master-search record sources. Two halves:
//  1. The pure engine (src/lib/masterSearch/collect.js) driven over FAKE adapters — proves
//     per-source permission gating, type namespacing + tie-break order, invoice-number
//     aliasing, and that a deleted / forbidden / out-of-scope recent re-resolves to null.
//  2. A TEXT lockstep on sources.js (which imports the store selectors and so cannot be
//     imported under plain node) — proves each scoped adapter is wired to the page's own
//     scoped selector, so a crew member can never surface an unassigned record. This is the
//     same execute-the-pure-core + lockstep-the-wiring pattern as test-crew-resolve.mjs.
//
//   node scripts/test-master-search-sources.mjs
import { readFileSync } from 'node:fs';
import { collectCandidates, resolveFromSources } from '../src/lib/masterSearch/collect.js';
import { rankEntries } from '../src/lib/masterSearch/rank.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── fake state + adapters that mirror the real shapes (incl. a crew-scoping select) ──
const state = {
  clients: [
    { id: 'cl_a', name: 'Acme Cleaning', city: 'Miami', contactNumber: 1001 },
    { id: 'cl_b', name: 'Beta Corp', city: 'Tampa', contactNumber: 1002 },
  ],
  invoices: [{ id: 'CS-1001', clientId: 'cl_a', status: 'paid' }],
  // who the crew is assigned to (mirrors selectVisibleClientsFor's crew path)
  assignments: { u_crew: ['cl_a'] },
};

const clientSource = {
  type: 'client', groupLabel: 'Customers', groupIcon: 'clients', perm: 'clients.view',
  select: (s, user) => (user?.role === 'crew'
    ? s.clients.filter((c) => (s.assignments[user.id] || []).includes(c.id))
    : s.clients),
  primary: (c) => c.name,
  sublabel: (c) => c.city,
  keywords: (c) => [c.city, `#${c.contactNumber}`, String(c.contactNumber)],
  to: (c) => `/clients/${c.id}`,
  seeAll: (q) => `/clients?q=${encodeURIComponent(q)}`,
  seeAllLabel: 'Customers',
};
const invoiceSource = {
  type: 'invoice', groupLabel: 'Invoices', groupIcon: 'invoices', perm: 'invoices.view',
  select: (s) => s.invoices,
  primary: (inv) => inv.id,
  sublabel: (inv) => inv.status,
  keywords: (inv) => [String(inv.id).replace(/^\D+/, ''), inv.status],
  to: (inv) => `/invoices/${inv.id}`,
  seeAll: () => '/invoices',
  seeAllLabel: 'Invoices',
};
const SOURCES = [clientSource, invoiceSource];

const manager = { id: 'u_mgr', role: 'manager' };
const crew = { id: 'u_crew', role: 'crew' };
const allowAll = () => true;

// ── engine: gating + namespacing + tie-break order ───────────────────────────────
{
  const cand = collectCandidates(SOURCES, state, manager, allowAll);
  ok('manager sees both customers', cand.filter((c) => c.type === 'client').length === 2);
  ok('ids namespaced by type', cand.every((c) => c.id === `${c.type}:${c.refId}`));
  ok('client rankBucket 2, invoice rankBucket 3 (fixed order)',
    cand.find((c) => c.type === 'client').rankBucket === 2
    && cand.find((c) => c.type === 'invoice').rankBucket === 3);
}
{
  const onlyClients = (p) => p === 'clients.view';
  const cand = collectCandidates(SOURCES, state, manager, onlyClients);
  ok('permission gate drops disallowed sources', cand.every((c) => c.type === 'client'));
}

// ── engine: crew scoping flows from the adapter's select (engine never leaks) ─────
{
  const cand = collectCandidates(SOURCES, state, crew, allowAll);
  const clients = cand.filter((c) => c.type === 'client');
  ok('crew sees only their assigned customer', clients.length === 1 && clients[0].refId === 'cl_a');
  ok('engine passes user through to the adapter', !clients.some((c) => c.refId === 'cl_b'));
}

// ── engine: invoice number aliasing ───────────────────────────────────────────────
{
  const cand = collectCandidates(SOURCES, state, manager, allowAll);
  const inv = cand.filter((c) => c.type === 'invoice');
  ok('bare "1001" matches CS-1001', rankEntries(inv, '1001').some((e) => e.refId === 'CS-1001'));
  ok('"cs-1001" is an exact match', rankEntries(inv, 'cs-1001')[0]?.refId === 'CS-1001');
  ok('customer #1001 findable by contactNumber', rankEntries(cand.filter((c) => c.type === 'client'), '1001').some((e) => e.refId === 'cl_a'));
}

// ── engine: recent re-resolution ────────────────────────────────────────────────────
{
  ok('live record resolves + reflects rename', (() => {
    const renamed = { ...state, clients: [{ ...state.clients[0], name: 'Acme Renamed' }, state.clients[1]] };
    return resolveFromSources(SOURCES, renamed, manager, allowAll, 'client', 'cl_a')?.label === 'Acme Renamed';
  })());
  ok('deleted record → null', resolveFromSources(SOURCES, state, manager, allowAll, 'client', 'cl_gone') === null);
  ok('forbidden record → null', resolveFromSources(SOURCES, state, manager, () => false, 'client', 'cl_a') === null);
  ok('crew-hidden record → null', resolveFromSources(SOURCES, state, crew, allowAll, 'client', 'cl_b') === null);
  ok('unknown type → null', resolveFromSources(SOURCES, state, manager, allowAll, 'nope', 'x') === null);
}

// ── engine: precomputed text, relevance order, desktop-only, see-all passthrough ─────
{
  const jobSource = {
    type: 'job', typeLabel: 'Clean', groupLabel: 'Cleans', groupIcon: 'schedule', perm: 'schedule.view',
    select: (s) => s.jobs,
    primary: () => 'Coral Bay HOA',
    sublabel: () => '',
    keywords: (j) => [j.notes],
    order: (j, s, now) => Math.abs(new Date(j.startAt).getTime() - now),
    to: (j) => `/schedule/${j.id}`,
    seeAll: () => '/schedule',
    seeAllLabel: 'Schedule',
  };
  const deskOnly = { ...invoiceSource, type: 'deal', desktopOnly: true };
  const now = Date.parse('2026-09-22T12:00:00Z');
  const st = { jobs: [
    { id: 'j_old', startAt: '2026-08-01T10:00:00Z', notes: 'Floor BUFFER' },
    { id: 'j_soon', startAt: '2026-09-23T10:00:00Z', notes: '' },
  ], invoices: state.invoices };
  const cand = collectCandidates([jobSource, deskOnly], st, manager, allowAll, { now });
  const byId = (id) => cand.find((c) => c.refId === id);
  ok('candidates carry normalized _l/_k', byId('j_old')._l === 'coral bay hoa' && byId('j_old')._k[0] === 'floor buffer');
  ok('order = distance from today (nearest clean smallest)', byId('j_soon').order < byId('j_old').order);
  ok('the nearest clean ranks first among same-labelled rows', rankEntries(cand.filter((c) => c.type === 'job'), 'coral')[0].refId === 'j_soon');
  ok('typeLabel travels with the candidate', byId('j_soon').typeLabel === 'Clean');
  ok('see-all target travels with the candidate', byId('j_soon').seeAll('coral') === '/schedule' && byId('j_soon').seeAllLabel === 'Schedule');
  ok('desktop-only source included on desktop', cand.some((c) => c.type === 'deal'));
  const mob = collectCandidates([jobSource, deskOnly], st, manager, allowAll, { now, isMobile: true });
  ok('desktop-only source dropped on mobile', !mob.some((c) => c.type === 'deal'));
  ok('desktop-only recent resolves to null on mobile', resolveFromSources([jobSource, deskOnly], st, manager, allowAll, 'deal', 'CS-1001', { isMobile: true }) === null);
}

// ── 🔴 LOCKSTEP: the real adapters wire the page's scoped selector, never the raw slice ──
const src = readFileSync(new URL('../src/lib/masterSearch/sources.js', import.meta.url), 'utf8');
ok('client adapter uses selectVisibleClientsFor', /type: 'client'[\s\S]{0,400}selectVisibleClientsFor\(s, user\)/.test(src));
ok('contact adapter uses selectVisibleContactsFor', /type: 'contact'[\s\S]{0,400}selectVisibleContactsFor\(s, user\)/.test(src));
ok('site adapter uses selectVisibleSitesFor', /type: 'site'[\s\S]{0,400}selectVisibleSitesFor\(s, user\)/.test(src));
ok('job adapter scopes crew via selectJobsForUser', /type: 'job'[\s\S]{0,400}crew[\s\S]{0,80}selectJobsForUser\(s, user\.id\)/.test(src));
ok('no scoped type reads the raw s.clients slice for its list', !/type: 'client'[\s\S]{0,300}select: \(s\) => s\.clients/.test(src));
ok('keys adapter uses selectVisibleKeysFor (crew see only their keys)', /type: 'key'[\s\S]{0,300}selectVisibleKeysFor\(s, user\)/.test(src));
ok('cleans show org-timezone dates (fmtDate), never device-local toLocaleDateString', /fmtDate\(j\.startAt/.test(src) && !/toLocaleDateString/.test(src));
ok('cleans show the app status labels via the effective status', /jobStatusLabel\(selectEffectiveJobStatus\(j\)\)/.test(src));
ok('invoices show the derived (live) status', /deriveInvoiceStatus\(inv\)/.test(src));
ok('deals are desktop-only (the board is desktop-bound)', /type: 'opportunity'[\s\S]{0,200}desktopOnly: true/.test(src));
ok('supply items gate on supplies.manage (their tab is manager-only)', /type: 'supplyItem'[\s\S]{0,200}perm: 'supplies\.manage'/.test(src));
ok('no adapter routes by viewer role (crew have no search; see-all takes only the query)', !/seeAll: \([^)]*user/.test(src));

// ── 🔴 LOCKSTEP: crew have NO search, desktop or mobile (owner 2026-09-22) ─────────────
// The gate sits in front of everything search mounts (field, magnifier, sheet, Ctrl/Cmd+K
// and cs:open-search listeners), and the FloatingNav menu hides its "Search" row for crew.
const msSrc = readFileSync(new URL('../src/components/MasterSearch.jsx', import.meta.url), 'utf8');
const gate = msSrc.slice(msSrc.indexOf('export default function MasterSearch'));
ok('MasterSearch returns before mounting search for crew',
  /useSelector\(selectCurrentUser\)[\s\S]{0,120}role === 'crew'\) return[^\n]*\n\s*return <GlobalSearch \/>/.test(gate));
ok('the crew desktop keeps only the empty bar band (no field)', /role === 'crew'\) return isMobile \? null : <div className="topbar" \/>/.test(gate));
ok('hotkey + open-event listeners live only inside the gated search', msSrc.indexOf("addEventListener('keydown'") > msSrc.indexOf('function useMasterSearch')
  && /function GlobalSearch\(\)[\s\S]{0,200}useMasterSearch\(/.test(msSrc));
const fnavSrc = readFileSync(new URL('../src/components/FloatingNav.jsx', import.meta.url), 'utf8');
ok('FloatingNav hides the Search row for crew', /\{!isCrew && \([\s\S]{0,400}cs:open-search/.test(fnavSrc));

// ── 🔴 LOCKSTEP: the phone search bar (owner pick 02 "Facebook" + the launchpad, 2026-09-22) ──
// The spyglass grows leftward into one bar across the top (back arrow at the far left), the
// field focused inside the tap; a portaled full-screen search shows the launchpad until you
// type. The tray tabs and the launchpad's "Go to" come from ONE helper so they can't drift;
// the 2/3 popout and the old sheet are gone (replace-means-delete).
const mobile = msSrc.slice(msSrc.indexOf('if (s.isMobile)'), msSrc.indexOf("const listId = 'msearch-list';"));
ok('the phone surface is a portaled full-screen search (no popout, no sheet)', /createPortal\(\s*<div\s+ref=\{screenRef\}\s+className=\{`msearch-screen/.test(mobile) && /document\.body/.test(mobile)
  && !/BottomPopout|MobileSheet/.test(msSrc));
ok('the spyglass opens straight into typing (flushSync + focus inside the tap)', /className="msearch-trigger"[\s\S]{0,200}onClick=\{\(\) => \{ flushSync\(\(\) => s\.openSearch\(\{ captureFocus: true \}\)\); inputRef\.current\?\.focus\(\); \}\}/.test(mobile));
ok('a back arrow at the far left closes it', /className="msearch-back" aria-label="Close search" onClick=\{s\.closeClear\}/.test(mobile) && /<Icon name="arrowLeft"/.test(mobile)
  && mobile.indexOf('msearch-back') < mobile.indexOf('msearch-screen-field'));
ok('with nothing typed a phone always shows the launchpad (no search-mode latch)', /if \(isMobile\) \{\s*const \{ actions, pages \} = buildLaunchpad\(/.test(msSrc) && /mode === 'launchpad' \? <Launchpad/.test(mobile)
  && !/searching|cancelSearch|msearch-cancel/.test(msSrc));
ok('the menu Search row opens the same bar, field focused', /const onOpen = \(\) => \{\s*flushSync\(\(\) => openSearch\(\{ captureFocus: true \}\)\);\s*inputRef\.current\?\.focus\(\);\s*\};/.test(msSrc));
ok('the screen pads for the on-screen keyboard', /useKeyboardInset\(screenRef, s\.isMobile && s\.open\)/.test(msSrc));
ok('FloatingNav tray tabs come from navData.mobileTabs', /import \{ mobileTabs \} from '\.\.\/lib\/navData'/.test(fnavSrc) && /const tabDefs = mobileTabs\(check, isCrew\)/.test(fnavSrc));
const kbHook = readFileSync(new URL('../src/hooks/useKeyboardInset.js', import.meta.url), 'utf8');
ok('useKeyboardInset reads the visual viewport through the tested math', /window\.visualViewport/.test(kbHook) && /measureKeyboard\(window\.innerHeight, vv\.height, vv\.offsetTop\)/.test(kbHook));
// The morph must START where the spyglass sits, or the field would jump instead of growing
// out of it: the keyframe's right edge + size must match .msearch-trigger's.
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const trig = css.match(/\.msearch-trigger \{[\s\S]*?\}/g)?.find((b) => /position: fixed/.test(b)) || '';
const morph = css.match(/@keyframes msearch-morph \{[\s\S]*?\n\}/)?.[0] || '';
ok('the field grows out of the spyglass (morph starts at its right edge + size)', /right: var\(--space-16\)/.test(trig) && /width: 36px/.test(trig)
  && /right: var\(--space-16\)/.test(morph) && /--ms-btn: 36px/.test(css) && /height: var\(--ms-btn\)/.test(morph));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nmaster-search sources: ${pass}/${pass} passed`);
