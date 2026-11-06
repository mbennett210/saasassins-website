// Where QR codes are made (UI_RULES §183). Matt (2026-10-30): "what about the QR codes? How do I create
// them? I'm not able to find that". A location's codes come from its cleaning areas (QR-6) and lived
// only on each customer's Notes tab, shown only once the location had areas: his first customer had
// none, so the card said nothing about codes at all. Daniel's pick (2026-10-30): a page in the menu,
// plus the location's own card.
//
//   1. the page: a route, a menu row and a search result; every building with its areas, gated as the
//      codes are, its codes and areas opened in the ONE card (never a second copy);
//   2. the card with no areas yet says its codes start there and opens the area editor; ticked areas
//      count as unsaved and Save Changes saves them (found in the final drive, 2026-10-30);
//   3. CS-952: a new area's code shows once the save lands, without a reload;
//   4. the all-buildings spreadsheet is one hook behind both of its buttons.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying on the
// first missing export. Offline. Run: node scripts/test-qr-codes-page.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const nav = await import('../src/lib/navData.js').catch(() => ({}));
const scan = await import('../src/lib/scanCodes.js').catch(() => ({}));
const registry = await import('../src/lib/masterSearch/registry.js').catch(() => ({}));
const roles = await import('../src/lib/roles.js');
const core = await import('../src/i18n/core.js');
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
const checkerFor = (role) => { const user = { id: `u_${role}`, role }; return (key) => roles.can(user, key, undefined, []); };

// ── 1. The page ───────────────────────────────────────────────────────────────────────────────────
{
  const app = read('src/App.jsx');
  ok('🔴 /qr-codes is a route, loaded lazily like every page, gated as the codes are (sites.edit)',
    /const QrCodes = lazyRoute\(\(\) => import\('\.\/pages\/QrCodes'\)\);/.test(app)
    && /<Route path="qr-codes" element=\{<RequirePerm perm="sites\.edit"><QrCodes \/><\/RequirePerm>\} \/>/.test(app));
  const leaf = (fn(nav, 'navLeaves')() || []).find((l) => l.to === '/qr-codes');
  ok('🔴 it is a row in the menu (Operations), with the QR glyph', !!leaf && leaf.labelKey === 'nav.qrCodes' && leaf.icon === 'qr'
    && (nav.NAV || []).find((e) => e.group === 'Operations')?.children?.some((c) => c.to === '/qr-codes'));
  ok('…the owner sees it, a cleaner never does', fn(nav, 'visible')(leaf || {}, checkerFor('owner'), false, false, { team: true }) === true
    && fn(nav, 'visible')(leaf || {}, checkerFor('crew'), false, true, {}) === false);
  const entries = registry.PAGE_ENTRIES || [];
  ok('search finds it as a page, gated sites.edit', entries.some((e) => e.to === '/qr-codes' && e.perm === 'sites.edit'));
  const reg = read('src/lib/masterSearch/registry.js');
  ok('…by the words someone would type ("qr code", "labels", "create qr code")', /'\/qr-codes': \[[^\]]*'qr code'[^\]]*'labels'[^\]]*'create qr code'/.test(reg));

  const page = read('src/pages/QrCodes.jsx');
  ok('the page refuses anyone the codes refuse: sites.edit AND an office role (scanCodesAllowed)', /scanCodesAllowed\(currentUser\?\.role \|\| null, canSitesEdit\)/.test(page)
    && /if \(!allowed\) \{/.test(page));
  ok('it lists every location of every customer we clean for: no vendor, no archived customer (QR-27)',
    /client\.type === 'vendor' \|\| isArchivedCustomer\(client\)/.test(page) && /scanAreasOf\(site\)\.length/.test(page));
  ok('🔴 a location opens its own Cleaning instructions card: the ONE card (areas editor, codes, labels), never a copy',
    /<CleaningInstructionsCard\s+key=\{open\.site\.id\}\s+location=\{open\.site\}\s+canEdit=\{canSitesEdit\}/.test(page) && !/import AreaScanCodes/.test(page));
  ok('🔴 "Add areas" opens it straight on its areas editor (one click fewer than Edit inside it)',
    /setOpened\(\{ id: r\.site\.id, edit: r\.areas === 0 \}\)/.test(page) && /startEditing=\{opened\?\.edit === true\}/.test(page));
  ok('🔴 closing it with areas added or changed and not saved asks first, and only then drops them',
    /onDirtyChange=\{setDirty\}/.test(page) && /const closeCodes = \(\) => \{ if \(dirty\) setAsking\(true\); else setOpened\(null\); \};/.test(page)
    && /onClose=\{closeCodes\}/.test(page) && /<ConfirmDialog[\s\S]{0,120}open=\{asking\}/.test(page) && /title=\{t\('qrPage\.discardTitle'\)\}/.test(page)
    && /cancelLabel=\{t\('qrPage\.keepEditing'\)\}/.test(page));
  ok('…each row\'s button names its building for a screen reader',
    /aria-label=\{t\(r\.areas > 0 \? 'qrPage\.openCodesFor' : 'qrPage\.addAreasFor', \{ location:/.test(page)
    && (core.english('qrPage.openCodesFor', { location: 'Main' }) || '').includes('Main')
    && (core.english('qrPage.addAreasFor', { location: 'Main' }) || '').includes('Main'));
  ok('…and a phone\'s card keeps a location\'s address under its name (one block in the cell)', /<div className="qr-codes-loc">/.test(page) && /\.qr-codes-loc \{ min-width: 0; \}/.test(read('src/index.css')));
  ok('…"Add areas" for a location with none, "Open codes" for one with codes', /t\('qrPage\.addAreas'\)/.test(page) && /t\('qrPage\.openCodes'\)/.test(page)
    && /<Badge variant="amber">\{t\('qrPage\.noAreas'\)\}<\/Badge>/.test(page));
  ok('…the customer\'s name opens their page, carrying the way back (useFromHere)', /to=\{`\/clients\/\$\{r\.client\.id\}\?tab=notes`\} state=\{nav\}/.test(page));
  ok('…whose back pill names the QR codes page', /if \(pathname === '\/qr-codes'\) return 'nav\.qrCodes';/.test(read('src/hooks/useFromHere.js')));
  ok('20 a page, the filters in the URL (UI_RULES tables, back-nav)', /usePagedRows\(rows,/.test(page) && /<ListPager pager=\{pager\}/.test(page) && /useSearchParams\(\)/.test(page));
  ok('it says how codes are made, and how many buildings have none yet', /t\('qrPage\.how'\)/.test(page) && /t\('qrPage\.withoutAreas', \{ count: withoutAreas \}\)/.test(page));
  ok('stacked cards on a phone (mobile-stack, every cell labelled)', /table-wrap mobile-stack/.test(page) && (page.match(/data-label=\{t\('qrPage\.col\./g) || []).length >= 3);
}

// ── 2. The card with no areas yet ─────────────────────────────────────────────────────────────────
{
  const card = read('src/components/CleaningInstructionsCard.jsx');
  // Every word of the card is a catalog line (CS-193): the checks read the words through the catalog.
  ok('🔴 with no areas, the card says each area gets its own QR code to print',
    /t\('areaEditor\.emptyCodes'\)/.test(card) && /^No cleaning areas yet\. Add each area.*QR code here, ready to print\.$/.test(core.english('areaEditor.emptyCodes') || ''));
  ok('…and offers "Add areas", which opens the area editor', /className="cleaning-areas-empty"/.test(card)
    && /onClick=\{\(\) => setEditing\(true\)\}>\{t\('areaEditor\.addAreas'\)\}<\/button>/.test(card) && core.english('areaEditor.addAreas') === 'Add areas');
  ok('…its subtitle says so too while codes are shown', /t\('areaEditor\.cardHintCodes'\)/.test(card) && /each area gets its own QR code to print/.test(core.english('areaEditor.cardHintCodes') || ''));
  ok('🔴 the QR codes page can open it on its editor (an editor only), and hears whether areas wait unsaved',
    /useState\(\(\) => startEditing && canEdit === true\)/.test(card)
    && /const dirty = editing && \(pending > 0 \|\| JSON\.stringify\(draft\) !== JSON\.stringify\(initial\)\);/.test(card)
    && /onDirtyChange\?\.\(dirty\)/.test(card));
  // Found in the final drive (2026-10-30): ticked areas, then Save Changes, saved nothing under an
  // "updated" toast and no codes came, and the pop-up closed on ticks without asking. The ticks live in
  // the card now: a tick waiting is unsaved, and Save Changes adds the ticked areas with the rest.
  ok('🔴 a ticked area counts as unsaved: the card holds the editor\'s ticks and counts the ones still waiting',
    /const \[picked, setPicked\] = useState\(\(\) => new Set\(\)\);/.test(card)
    && /const pending = editing \? pendingStandardAreas\(draft, picked\)\.length : 0;/.test(card)
    && /<CleaningAreasEditor value=\{draft\} onChange=\{setDraft\} picked=\{picked\} onPickedChange=\{setPicked\} \/>/.test(card));
  ok('🔴 Save Changes saves the ticked areas with the rest, through the one rule (lib/standardAreas)',
    /const next = addStandardAreas\(draft, \[\.\.\.picked\]\);\s*dispatch\(\{ type: ACTIONS\.UPDATE_SITE, id: location\.id, patch: \{ cleaningAreas: next \} \}\);/.test(card)
    && /import \{ addStandardAreas, pendingStandardAreas \} from '\.\.\/lib\/standardAreas';/.test(card));
  ok('…and a save, Cancel or another location clears the ticks', (card.match(/setPicked\(new Set\(\)\)/g) || []).length >= 3);
  ok('the empty card lays out as a column (index.css)', /\.cleaning-areas-empty \{ display: flex; flex-direction: column;/.test(read('src/index.css')));
}

// ── 3. CS-952: a new area's code shows without a reload ───────────────────────────────────────────
{
  const missing = fn(scan, 'scanCodesMissing');
  const site = { cleaningAreas: [{ id: 'a1', label: 'Lobby' }, { id: 'a2', label: 'Restroom' }] };
  ok('🔴 scanCodesMissing: an area with no code is missing', missing(site, [{ areaId: 'a1' }]) === true);
  ok('…every area with a code is not', missing(site, [{ areaId: 'a1' }, { areaId: 'a2' }]) === false);
  ok('…no areas, nothing missing; a list that isn\'t one counts as none', missing({ cleaningAreas: [] }, []) === false && missing(site, null) === true);
  const panel = read('src/components/AreaScanCodes.jsx');
  ok('🔴 the codes panel asks again once the save has landed (synced) and an area still has no code',
    /const synced = useSyncStatus\(\) === 'synced';/.test(panel) && /scanCodesMissing\(location, data\.codes\)/.test(panel)
    && /useEffect\(\(\) => \{ if \(synced && missing\) load\(\); \}, \[synced, missing, load\]\);/.test(panel));
}

// ── 4. One spreadsheet, two buttons ───────────────────────────────────────────────────────────────
{
  const hook = read('src/hooks/useScanLinksDownload.js');
  ok('the all-buildings links download is one hook', /export function useScanLinksDownload\(\)/.test(hook) && /fetchScanLinks\(\)/.test(hook) && /saveScanLinksCsv\(/.test(hook));
  ok('…used by the Customers list and the QR codes page, neither keeping its own copy',
    /useScanLinksDownload\(\)/.test(read('src/pages/Clients.jsx')) && /useScanLinksDownload\(\)/.test(read('src/pages/QrCodes.jsx'))
    && !/fetchScanLinks/.test(read('src/pages/Clients.jsx')));
}

console.log(`\ntest-qr-codes-page: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
