// CS-193 — the CONVERTED screens show no hard-coded English (the brief's mechanical check).
//
// Every file in CONVERTED below is a screen (or a piece of one) a cleaner or a supervisor
// reads, converted to the translation layer. This parses each with espree (eslint's own
// parser) and fails on ENGLISH a reader would see that did not come from the catalog:
//   • JSX text with words in it                         <p>Clock in</p>
//   • a visible attribute given words                    aria-label="Close" · title={'Open'}
//   • words rendered from an expression                  {busy ? 'Saving…' : null}
//   • words handed to a toast / error / notice setter     toast('Saved') · setError('Failed')
//   • a visible property of an object given words        { label: 'Clock out' }
// A string with no run of two letters (a "·", a "—", "#3") is not words. Text that is truly
// not for translating — a person's own content, a brand name, an example phone number — is
// allowed by an `i18n-ok` comment on the same or the previous line, which says why.
//
// It also holds the navigation model's two names together: every nav leaf's English
// `label` (what search reads) equals the English of its `labelKey` (what the screen shows).
//
// Offline. Run: node scripts/test-i18n-coverage.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// The converted files. A screen joins this list the moment it is converted, and stays.
export const CONVERTED = [
  // the cleaner's day
  'src/pages/MyDay.jsx',
  'src/components/ClockControl.jsx',
  // the Cleaner Hub (brief A, 2026-10-13): Home is MyDay above; the stops, the clock screen, the
  // one clock both clocks draw, and the crew shell's chrome
  'src/pages/crew/CrewStops.jsx',
  'src/pages/crew/CrewClock.jsx',
  'src/hooks/useClockActions.js',
  'src/components/CrewChrome.jsx',
  'src/components/CrewJobVisit.jsx',
  'src/components/CleanChecklist.jsx',
  'src/components/ChecklistFill.jsx',
  'src/components/ChecklistItemPhoto.jsx',
  // the Cleaner Hub's checklist page (Brief B, written on the catalog from the start)
  'src/pages/crew/CrewChecklist.jsx',
  'src/components/MediaGallery.jsx',
  // a location's cleaning areas: the read-only list a cleaner reads on a clean's page, and the office's
  // editor with the standard list (QR-8, QR Wave 2 builder L; converted with the list)
  'src/components/CleaningAreasEditor.jsx',
  'src/components/AccountNotesPanel.jsx',
  'src/components/StubRecoveryBanner.jsx',
  'src/components/OfflineQueueFailures.jsx',
  'src/pages/Keys.jsx',
  // the Cleaner Hub (Builder C, 2026-10-13; new, written on the catalog from the start): Client
  // Requests (the list, one request and their shared pieces) and My Hours
  'src/pages/crew/CrewRequests.jsx',
  'src/pages/crew/CrewRequest.jsx',
  'src/pages/crew/requestParts.jsx',
  'src/pages/crew/CrewHours.jsx',
  // notifications
  'src/components/NotificationsBell.jsx',
  'src/components/MobileNotificationList.jsx',
  // settings: the landing page a cleaner opens it from, your account, the language switch
  'src/pages/settings/SettingsLayout.jsx',
  'src/pages/settings/SettingsHub.jsx',
  'src/pages/settings/Account.jsx',
  'src/components/LanguageCard.jsx',
  // navigation and the app's frame
  'src/components/FloatingNav.jsx',
  'src/components/Sidebar.jsx',
  'src/components/UserSwitcher.jsx',
  'src/App.jsx',
  'src/layouts/AppLayout.jsx',
  'src/components/SyncIndicator.jsx',
  // the boot screen before the company's data has loaded (CS-672; new, written on the catalog from the start)
  'src/components/BootScreen.jsx',
  'src/components/RoleSyncBanner.jsx',
  'src/components/MobilePushGate.jsx',
  // the Home Screen welcome a phone's browser opens under (task #127, UI_RULES §178; new, written on
  // the catalog from the start)
  'src/components/InstallWelcome.jsx',
  'src/components/RequirePerm.jsx',
  'src/components/DetailHeader.jsx',
  'src/components/NotFound.jsx',
  'src/components/ErrorBoundary.jsx',
  // a screen the phone hasn't kept, opened with no signal (CS-665; written on the catalog from the start)
  'src/components/OfflineScreen.jsx',
  'src/pages/Login.jsx',
  'src/components/ReportIssueModal.jsx',
  'src/components/ScreenshotDropzone.jsx',
  // messages (a cleaner's channels and direct messages; the office inbox shares the files)
  'src/pages/Messaging.jsx',
  'src/components/MessagingHeader.jsx',
  'src/components/ConversationThreadList.jsx',
  'src/components/ConversationMessagePanel.jsx',
  'src/components/ConversationContextPanel.jsx',
  // the customers' conversations (client hub redesign, plan §3.4), written on the catalog from the start
  'src/components/CustomerMessagesInbox.jsx',
  'src/components/CustomerThread.jsx',
  'src/components/MessagesDock.jsx',
  'src/components/ThreadTitleEditor.jsx',
  'src/components/ChannelBadge.jsx',
  'src/components/BulkActionBar.jsx',
  'src/components/NewDmModal.jsx',
  'src/components/NewInternalThreadModal.jsx',
  // the supervisor's screens
  'src/components/InspectionFill.jsx',
  'src/pages/Approvals.jsx',
  // Client Requests (the manager view redesign, 2026-10-09; new, written on the catalog from the start)
  'src/pages/ClientRequests.jsx',
  // the Operations Manager's Accounts page and assignment card (S131; new, written on the catalog
  // from the start), and the manager Home and the owner's switch the OM's views extend (written on
  // the catalog since the manager view redesign, 2026-10-09; listed S131)
  'src/pages/TeamAccounts.jsx',
  'src/components/AccountManagerAssignmentCard.jsx',
  'src/pages/ManagerHome.jsx',
  'src/pages/OwnerHome.jsx',
  'src/pages/TimeClock.jsx',
  'src/components/TimeClockHistory.jsx',
  'src/components/TimeEntryModal.jsx',
  'src/components/checklists/ChecklistAssignments.jsx',
  'src/components/checklists/CleanerChecklistPanel.jsx',
  'src/components/checklists/CustomerChecklistPanel.jsx',
  // supplies: the supervisor's requests and approvals, the request form's order sheet, a
  // building's own Supplies tab (its list, budget and requests), and the usage report (one
  // implementation on the Supplies page and Reports), with the report kit it is built on; the
  // master supply list's Catalog tab and a building's switches over it (2026-10-11, written on
  // the catalog from the start)
  'src/pages/Supplies.jsx',
  'src/components/SupplyRequestModal.jsx',
  'src/components/ClientSupplies.jsx',
  'src/components/SupplyCatalog.jsx',
  'src/components/SupplyCatalogImport.jsx',
  'src/components/SupplyListSwitches.jsx',
  // the delivery step (2026-10-12; written on the catalog from the start): the driver's
  // Deliveries page (a driver may read it in Spanish on a crew login) and the cleaner's supplies
  // line on My Day and the visit. (The office's "Record sent" is deleted — S131, II.5.)
  'src/pages/Deliveries.jsx',
  // the supply ORDERS (S131; written on the catalog from the start): the order queue and its
  // tiles, the Supply Manager's Home, one order's page, the decline form and the moves' toasts
  'src/components/SupplyQueue.jsx',
  'src/components/SupplyQueueTiles.jsx',
  'src/components/SupplyDeclineModal.jsx',
  'src/pages/SupplyHome.jsx',
  'src/pages/SupplyOrder.jsx',
  'src/hooks/useSupplyMoves.js',
  // By building's "Awaiting your approval" cards (S131 Wave 2, brief A; written on the catalog)
  'src/components/SupplyApprovalCards.jsx',
  'src/components/CrewSupplyNote.jsx',
  'src/hooks/useSupplyLinesText.js',
  'src/pages/reports/SupplyUsageReport.jsx',
  'src/pages/reports/reportKit.jsx',
  // time to resolve (Matt's KPI, the Oct 6 call; new, written on the catalog from the start): the
  // office's report, and the customer hub's tile, whose catalog lines render in English (LANG-8)
  'src/pages/reports/ResolveTimeReport.jsx',
  // the visitors' thumbs by building (QR-30, 2026-10-17; new, written on the catalog from the start)
  'src/pages/reports/VisitorRatingsReport.jsx',
  'src/pages/hub/HubResolveTile.jsx',
  // the Cleaner Hub (Builder D, 2026-10-13; new, written on the catalog from the start): the
  // cleaner's Request Supplies and Scan Site QR Code, and the customer hub's scan page, whose
  // catalog lines render in English (LANG-8). The scanner component itself takes its words in.
  'src/pages/crew/CrewSupplies.jsx',
  'src/pages/crew/CrewScan.jsx',
  'src/pages/hub/HubScan.jsx',
  // QR Wave 2 (new, written on the catalog from the start): the office's scanner and the area page
  // an office scan lands on (UI_RULES §175)
  'src/pages/OfficeScan.jsx',
  'src/pages/AreaPage.jsx',
  // the supply orders' cleaner side (S131 Builder C; new, written on the catalog from the start): one
  // of the cleaner's orders, and the order lines both cleaner screens draw
  'src/pages/crew/CrewSupplyOrder.jsx',
  'src/pages/crew/supplyOrderParts.jsx',
  // the shared inspection report page (/inspect/:token), the customer's: its words are catalog
  // lines rendered in English (LANG-8), converted when its failures were told apart (2026-10-12)
  'src/pages/PublicInspection.jsx',
  // the office's translation review (new, written on the catalog from the start)
  'src/components/TemplateTranslations.jsx',
  // QuickBooks' "needs matching" list (Wave 3, QB-12; new, written on the catalog from the start)
  'src/components/QboMatchingCard.jsx',
  // a team member's photo (UI_RULES §141; new, written on the catalog from the start — it sits
  // on Your account, which every cleaner reads)
  'src/components/AvatarPhotoControl.jsx',
  'src/components/AvatarPhotoEditor.jsx',
  // HR warnings (Matt's HR-1..HR-5; new, written on the catalog from the start — a cleaner
  // reads and signs their own on My Day)
  'src/components/HrWarningDetail.jsx',
  'src/components/HrWarningForm.jsx',
  'src/components/EmployeeWarningsCard.jsx',
  'src/components/MyWarningsCard.jsx',
  'src/pages/hr/WarningsTab.jsx',
  // HR incident reports (task #258: Matt's incident report form, set up like warnings; new,
  // written on the catalog from the start)
  'src/components/HrIncidentForm.jsx',
  'src/components/HrIncidentDetail.jsx',
  'src/components/EmployeeIncidentsCard.jsx',
  'src/pages/hr/IncidentsTab.jsx',
  // HR terminations (Super Clippy's idea #513: Matt's termination form, which turns the login
  // off; new, written on the catalog from the start)
  'src/components/HrTerminationForm.jsx',
  'src/components/HrTerminationDetail.jsx',
  'src/components/EmployeeTerminationCard.jsx',
  'src/pages/hr/TerminationsTab.jsx',
  // Customers → Import customers (rebuilt customer-first on the catalog, 2026-10-03)
  'src/components/CsvImportModal.jsx',
  // Settings → Team → Import team (task #466; new, written on the catalog from the start)
  'src/components/TeamImportModal.jsx',
  // a new customer's onboarding bar (task 471, UI_RULES §190; new, written on the catalog from the start)
  'src/components/OnboardingBar.jsx',
  // a customer's Documents tab and Settings → Company's documents for every customer (the client
  // hub redesign, 2026-10-08; new, written on the catalog from the start)
  'src/components/ClientDocuments.jsx',
  'src/components/CustomerDocumentsCard.jsx',
  'src/components/CustomerDocumentModal.jsx',
  // a one-time sign-in link the app couldn't email, handed to the office to send (CS-661 / GO-10,
  // S128; new, written on the catalog from the start): staff invites and resets, customer invites
  'src/components/SignInLinkPanel.jsx',
  // the manager's today screens (Builder A, 2026-10-09; new, written on the catalog from the start):
  // Shift check-in, Checklists today, the Schedule's Today view, and the pieces they share
  'src/pages/ShiftCheckIn.jsx',
  'src/pages/ChecklistsToday.jsx',
  'src/components/ScheduleToday.jsx',
  'src/components/ManagerTodayKit.jsx',
  // the QR codes page (Matt, 2026-10-30; UI_RULES §183; new, written on the catalog from the start)
  // and the one download behind its "QR code links" and the Customers list's
  'src/pages/QrCodes.jsx',
  'src/hooks/useScanLinksDownload.js',
  // the location's Cleaning instructions card, which that page opens in its pop-up (converted 2026-10-30)
  'src/components/CleaningInstructionsCard.jsx',
  // the kit every screen uses
  'src/components/Modal.jsx',
  'src/components/Toast.jsx',
  'src/components/ConfirmDialog.jsx',
  'src/components/Select.jsx',
  'src/components/SearchSelect.jsx',
  'src/components/FilterSelect.jsx',
  'src/components/MobileSheet.jsx',
  'src/components/ListPager.jsx',
  'src/components/TableSearch.jsx',
];

const VISIBLE_ATTRS = new Set([
  'aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'aria-placeholder',
  'title', 'placeholder', 'alt', 'label', 'sublabel', 'confirmLabel', 'cancelLabel', 'message',
  'emptyText', 'emptyLabel', 'emptyMessage', 'hint', 'helperText', 'description', 'caption',
  'heading', 'subtitle', 'sheetTitle', 'tooltip', 'searchPlaceholder', 'ariaLabel', 'buttonLabel',
  'actionLabel', 'noMatchesText', 'clearLabel', 'allLabel',
  // A table cell's label on a phone (UI_RULES §24: the stacked card prints it with attr()).
  'data-label',
  // A detail page's back pill (DetailHeader / BackLink / useBackTarget).
  'backLabel', 'fallbackLabel',
]);
const VISIBLE_PROPS = new Set([
  'label', 'title', 'body', 'message', 'placeholder', 'confirmLabel', 'cancelLabel', 'emptyText',
  'hint', 'description', 'sublabel', 'caption', 'ariaLabel', 'tooltip', 'heading', 'subtitle',
]);
const SETTER_RE = /^(toast|showToast|notify|alert|confirm|set[A-Z]\w*(Error|Err|Message|Msg|Notice|Status|Warning|Hint|Text|Label))$/;
const WORDS = /[A-Za-z]{2,}/;

const isWordsLiteral = (n) => n && n.type === 'Literal' && typeof n.value === 'string' && WORDS.test(n.value);
const isWordsTemplate = (n) => n && n.type === 'TemplateLiteral' && n.quasis.some((q) => WORDS.test(q.value.cooked || ''));
// The words an expression would RENDER: a literal, a template's own text, or either branch of
// a ternary / logical (the {busy ? 'Saving…' : 'Save'} shape).
function renderedWords(n) {
  if (!n) return null;
  if (isWordsLiteral(n)) return n.value;
  if (isWordsTemplate(n)) return n.quasis.map((q) => q.value.cooked).join('…');
  if (n.type === 'ConditionalExpression') return renderedWords(n.consequent) || renderedWords(n.alternate);
  if (n.type === 'LogicalExpression') return renderedWords(n.right) || (n.operator !== '&&' ? renderedWords(n.left) : null);
  return null;
}
const calleeName = (c) => (c?.type === 'Identifier' ? c.name
  : c?.type === 'MemberExpression' && !c.computed ? (c.object?.type === 'Identifier' && c.object.name === 'toast' ? 'toast' : c.property?.name) : null);
const attrName = (a) => (a.name?.type === 'JSXIdentifier' ? a.name.name : a.name?.type === 'JSXNamespacedName' ? `${a.name.namespace.name}:${a.name.name.name}` : null);

export async function scanFile(rel) {
  const espree = await import('espree');
  const src = readFileSync(path.join(APP, rel), 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true, comment: true });
  const allowed = new Set();
  for (const c of ast.comments || []) if (/i18n-ok/.test(c.value)) { allowed.add(c.loc.start.line); allowed.add(c.loc.end.line + 1); allowed.add(c.loc.end.line); }
  const hits = [];
  const hit = (node, what, text) => {
    const line = node.loc?.start?.line;
    if (allowed.has(line)) return;
    hits.push(`${rel}:${line} ${what} "${String(text).trim().replace(/\s+/g, ' ').slice(0, 60)}"`);
  };
  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'JSXText':
        if (WORDS.test(node.value)) hit(node, 'JSX text', node.value);
        break;
      case 'JSXAttribute': {
        const name = attrName(node);
        if (name && VISIBLE_ATTRS.has(name)) {
          if (isWordsLiteral(node.value)) hit(node, `${name}=`, node.value.value);
          else if (node.value?.type === 'JSXExpressionContainer') {
            const w = renderedWords(node.value.expression);
            if (w) hit(node, `${name}={}`, w);
          }
        }
        break;
      }
      case 'JSXExpressionContainer':
        // A <style> element's child is CSS, not words.
        if (parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment') && parent.openingElement?.name?.name !== 'style') {
          const w = renderedWords(node.expression);
          if (w) hit(node, 'rendered', w);
        }
        break;
      case 'CallExpression': {
        const name = calleeName(node.callee);
        if (name && SETTER_RE.test(name)) {
          const w = renderedWords(node.arguments[0]);
          if (w) hit(node, `${name}()`, w);
        }
        break;
      }
      case 'Property': {
        const key = node.key?.type === 'Identifier' ? node.key.name : node.key?.type === 'Literal' ? node.key.value : null;
        if (key && VISIBLE_PROPS.has(key) && !node.computed) {
          const w = renderedWords(node.value);
          if (w) hit(node, `${key}:`, w);
        }
        break;
      }
      default:
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'parent' || k === 'loc' || k === 'range') continue;
      if (Array.isArray(v)) for (const c of v) walk(c, node);
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  };
  walk(ast, null);
  return hits;
}

// ── 1. no hard-coded English in a converted file ──────────────────────────────────────────
let espreeOk = true;
try { await import('espree'); } catch { espreeOk = false; }
ok('the scanner loads (espree)', espreeOk);
const i18nPresent = existsSync(path.join(APP, 'src/i18n/core.js'));
ok('the translation layer exists (src/i18n/core.js)', i18nPresent);
for (const rel of CONVERTED) {
  if (!existsSync(path.join(APP, rel))) { ok(`${rel} exists`, false); continue; }
  let hits;
  try { hits = await scanFile(rel); } catch (e) { hits = [`${rel}: does not parse (${e.message})`]; }
  // A converted screen reads the catalog: it names the hook or a catalog helper.
  const src = readFileSync(path.join(APP, rel), 'utf8');
  ok(`${rel} reads the translation layer`, /from '(\.\.\/)+i18n\/(react|core|errors|relative)'|from '\.\/i18n\//.test(src));
  ok(`${rel} shows no hard-coded English (${hits.length}: ${hits.slice(0, 6).join(' | ')}${hits.length > 6 ? ' | …' : ''})`, hits.length === 0);
}

// ── 2. the nav model's two names agree ────────────────────────────────────────────────────
try {
  const nav = await import('../src/lib/navData.js');
  const core = await import('../src/i18n/core.js');
  const leaves = [...nav.navLeaves(), ...nav.mobileTabs(() => true)];
  const groups = nav.NAV.filter((e) => e.children);
  const bad = leaves.filter((l) => !l.labelKey || core.english(l.labelKey) !== l.label).map((l) => `${l.to}:${l.labelKey || '(none)'}`);
  const badGroups = groups.filter((g) => !g.groupKey || core.english(g.groupKey) !== g.group).map((g) => g.group);
  ok(`every nav leaf's English label is its labelKey's English (bad: ${bad.join(', ') || 'none'})`, bad.length === 0);
  ok(`every nav group's name is its groupKey's English (bad: ${badGroups.join(', ') || 'none'})`, badGroups.length === 0);
} catch {
  ok('the nav model carries catalog keys (src/lib/navData.js + src/i18n/core.js)', false);
}

// The settings landing page's model too: what master search reads (English `label` / `desc`)
// equals what the hub shows (the English of `labelKey` / `descKey`).
try {
  const sn = await import('../src/pages/settings/settingsNav.js');
  const core = await import('../src/i18n/core.js');
  const cards = [sn.SETTINGS_PINNED, ...sn.SETTINGS_GROUPS.flatMap((g) => g.items)];
  const bad = cards.filter((c) => !c.labelKey || !c.descKey
    || core.english(c.labelKey) !== c.label || core.english(c.descKey, c.descParams) !== c.desc).map((c) => c.to);
  const badGroups = sn.SETTINGS_GROUPS.filter((g) => !g.labelKey || core.english(g.labelKey) !== g.label).map((g) => g.key);
  ok(`every settings card's English is its keys' English (bad: ${bad.join(', ') || 'none'})`, bad.length === 0);
  ok(`every settings group's name is its labelKey's English (bad: ${badGroups.join(', ') || 'none'})`, badGroups.length === 0);
} catch {
  ok('the settings model carries catalog keys (src/pages/settings/settingsNav.js)', false);
}

// ── 3. the scanner itself catches each shape (so a green run means something) ─────────────
if (espreeOk) {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'i18n-cov-'));
  const probe = path.join(dir, 'Probe.jsx');
  writeFileSync(probe, [
    "export default function P({ busy }) {",
    "  toast('Saved');",
    "  const opts = [{ value: 1, label: 'First' }];",
    "  return (<div aria-label=\"Close\" title={busy ? 'Saving' : ''}>",
    "    <p>Clock in</p>{busy ? 'Working' : null}",
    "    {/* i18n-ok: a brand name */}",
    "    <b>CleanSpace</b>",
    "    <i>· — #3</i>",
    "  </div>);",
    "}",
  ].join('\n'));
  const rel = path.relative(APP, probe);
  const hits = await scanFile(rel);
  const has = (re) => hits.some((h) => re.test(h));
  ok('scanner: JSX text', has(/JSX text "Clock in"/));
  ok('scanner: a visible attribute', has(/aria-label= "Close"/));
  ok('scanner: a ternary in an attribute', has(/title=\{\} "Saving"/));
  ok('scanner: words rendered from an expression', has(/rendered "Working"/));
  ok('scanner: a toast', has(/toast\(\) "Saved"/));
  ok('scanner: a visible object property', has(/label: "First"/));
  ok('scanner: an i18n-ok line is allowed', !has(/CleanSpace/));
  ok('scanner: symbols are not words', !has(/#3/));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ntest-i18n-coverage: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
