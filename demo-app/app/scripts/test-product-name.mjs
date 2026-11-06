// test-product-name — the software's own name, kept apart from the company's (UI_RULES §129; CS-287).
//
// WHY. Matt (the weekly meeting, about 2026-09-22): the SOFTWARE is Clean Corner, "Clean Space's
// proprietary software, Clean Corner, powered by Clean Space", kept off the company's name so it can be
// licensed later. The COMPANY stays Clean Space: it does the cleaning, signs the quotes, writes the
// inspection reports, sends the invoices. The brand pack carried one identity, so the browser tab and the
// home screen said "Clean Space" and nothing could say "Clean Corner" without renaming the company too.
//
//   1. the pack: an optional `product` block (a name; shortName, appTitle and wordmark default to it),
//      validated like every identity value, announced to Forge (PACK_FEATURES 'product-name')
//   2. a pack WITHOUT one behaves exactly as before: the software is named as the company, in IDENTITY, the
//      identity strings and every line the generator writes (index.html, the manifest, sw.js)
//   3. Clean Space's pack names Clean Corner, and the committed tab title, home-screen name, manifest and
//      push title are the active pack's software names
//   4. rendered: the app's own components and templates, bundled with a throwaway identity whose software
//      and company names differ: the software names the sign-in page's logo, the client hub's and the scan
//      page's logo and the sign-in mails; the company names the quote and its PDF bars, the inspection report
//      and its PDF footer, the client hub's (c) footer, the scan page's "Cleaning by" and the sign-in page's
//      (c) line. And the same render under a pack with no product block names the company everywhere, as before.
//   5. the ledger: every read of the brand's name in app/src and app/api, classed SOFTWARE or COMPANY with
//      its reason; a new read fails until someone decides which it is
//
//   node app/scripts/test-product-name.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import * as brandLib from './brand.mjs';

const { loadBrand, activeBrandId, identityOf, identityStrings, rewriteStatic, validate, PACK_FEATURES } = brandLib;
const productOf = typeof brandLib.productOf === 'function' ? brandLib.productOf : null; // missing before the change

const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const NAMES = ['name', 'shortName', 'appTitle', 'wordmark'];
const companyNames = (b) => Object.fromEntries(NAMES.map((k) => [k, b[k]]));
// The rule, restated from the spec (not from productOf): a product block's names, each defaulting to its
// name; no block, the company's names.
const softwareNames = (b) => (b.product
  ? { name: b.product.name, shortName: b.product.shortName ?? b.product.name, appTitle: b.product.appTitle ?? b.product.name, wordmark: b.product.wordmark ?? b.product.name }
  : companyNames(b));

const ACTIVE = loadBrand(activeBrandId()).brand;
const BASE = (() => { const b = JSON.parse(JSON.stringify(ACTIVE)); delete b.product; return b; })(); // the active pack, no product
const PRODUCT = { name: 'Probe Suite', shortName: 'Probe', appTitle: 'Probe Suite Ops', wordmark: 'ProbeSuite' };
const WITH = { ...BASE, product: { ...PRODUCT } };

// ── 1. the pack ───────────────────────────────────────────────────────────────
ok('brand.mjs exports productOf() and validateProduct()', !!productOf && typeof brandLib.validateProduct === 'function');
ok("PACK_FEATURES announces 'product-name' (Forge reads it before it writes a product block)", PACK_FEATURES.includes('product-name'), PACK_FEATURES);
ok('a pack with a product block is valid', validate(WITH).length === 0, validate(WITH));
ok('a product block with only a name is valid', validate({ ...BASE, product: { name: 'Probe Suite' } }).length === 0, validate({ ...BASE, product: { name: 'Probe Suite' } }));
const refuses = (label, product, want) => { const e = validate({ ...BASE, product }); ok(`${label} → refused`, e.some((x) => x.startsWith(want)), e); };
refuses('a product block without its name', { appTitle: 'Probe Ops' }, 'product.name:');
refuses('an unknown product field', { name: 'Probe Suite', tagline: 'Every corner' }, 'product.tagline:');
refuses('a product name with an angle bracket (it lands in an HTML attribute)', { name: 'Probe <Suite>' }, 'product.name:');
refuses('a product title on two lines', { name: 'Probe Suite', appTitle: 'Probe\nOps' }, 'product.appTitle:');
refuses('a product short name with a trailing space', { name: 'Probe Suite', shortName: 'Probe ' }, 'product.shortName:');
refuses('a product given as a bare string', 'Probe Suite', 'product:');
if (productOf) {
  ok('a product block names the software', same(productOf(WITH), PRODUCT), productOf(WITH));
  ok("a product block's missing names default to its name", same(productOf({ ...BASE, product: { name: 'Probe Suite' } }), softwareNames({ product: { name: 'Probe Suite' } })));
  ok('IDENTITY.product is the software\'s names, and IDENTITY.name stays the company\'s', same(identityOf(WITH).product, PRODUCT) && identityOf(WITH).name === BASE.name);
}
ok("the software's names are identity strings too (the ledger and the rebrand sweep forbid them once another brand is active)",
  NAMES.every((k) => identityStrings(WITH).some(([label, v]) => label.startsWith('product') && v === PRODUCT[k])), identityStrings(WITH).filter(([l]) => l.startsWith('product')));

// ── 2. no product block: exactly as before ───────────────────────────────────
const INDEX = read(APP, 'index.html');
const MANIFEST = read(APP, 'public', 'manifest.json');
const SW = read(APP, 'public', 'sw.js');
for (const p of [BASE, loadBrand('harbor-pine').brand]) {
  const label = p === BASE ? `${p.id} without its product block` : `${p.id} (no product block)`;
  if (productOf) ok(`${label}: the software is named as the company`, same(productOf(p), companyNames(p)), productOf(p));
  ok(`${label}: IDENTITY.product carries the company's names`, same(identityOf(p).product, companyNames(p)), identityOf(p).product);
  ok(`${label}: the identity strings are the company's alone`, !identityStrings(p).some(([k]) => k.startsWith('product')));
  // the lines the generator writes, as it wrote them before a product block existed
  const html = rewriteStatic('index.html', INDEX, p);
  ok(`${label}: index.html's title and app-name metas are the company's`,
    html.includes(`<title>${escHtml(p.appTitle)}</title>`) && html.includes(`<meta name="application-name" content="${escHtml(p.shortName)}" />`)
    && html.includes(`<meta name="apple-mobile-web-app-title" content="${escHtml(p.shortName)}" />`));
  const man = JSON.parse(rewriteStatic('public/manifest.json', MANIFEST, p));
  ok(`${label}: the manifest's name, short name and description are the company's`, man.name === p.name && man.short_name === p.shortName && man.description === p.description, man);
  const app = /^const APP_NAME = (".*?");/m.exec(rewriteStatic('public/sw.js', SW, p));
  ok(`${label}: sw.js's push title is the company's name`, !!app && JSON.parse(app[1]) === p.name, app?.[1]);
}

// ── 3. Clean Space's pack, and the committed outputs ────────────────────────
const CS = loadBrand('cleanspace').brand;
ok("Clean Space's pack names its software Clean Corner (Matt: \"Clean Space's proprietary software, Clean Corner\")", CS.product?.name === 'Clean Corner', CS.product);
ok("Clean Space's pack keeps the company Clean Space", CS.name === 'Clean Space');
{
  const sw = softwareNames(ACTIVE);
  ok(`the tab title (index.html <title>) is the active pack's software title ("${sw.appTitle}")`, INDEX.includes(`<title>${escHtml(sw.appTitle)}</title>`));
  ok(`the home screen's names (application-name, apple-mobile-web-app-title) are the software's short name ("${sw.shortName}")`,
    INDEX.includes(`<meta name="application-name" content="${escHtml(sw.shortName)}" />`) && INDEX.includes(`<meta name="apple-mobile-web-app-title" content="${escHtml(sw.shortName)}" />`));
  const man = JSON.parse(MANIFEST);
  ok(`the manifest names the software ("${sw.name}" / "${sw.shortName}")`, man.name === sw.name && man.short_name === sw.shortName, [man.name, man.short_name]);
  const app = /^const APP_NAME = (".*?");/m.exec(SW);
  ok(`a push's default title (sw.js APP_NAME) is the software's name ("${sw.name}")`, !!app && JSON.parse(app[1]) === sw.name, app?.[1]);
}

// ── 4. rendered, with a throwaway identity whose software and company names differ ──────
// The app's own components and templates, bundled once (rolldown, as the design system renders its icons) with
// the generated identity module replaced by one that reads `globalThis.__PN_IDENTITY__` when the bundle loads,
// so one bundle loads twice: under WITH (a product) and under BASE (none). Routing, the session, the scan
// read and the hub's reads (lib/clientHubApi: the layout's one read of the bell's answer) are stubbed; nothing
// else is.
const ID_FILE = path.join(APP, 'src', 'brand', 'identity.generated.js');
const LOGO_FILE = path.join(APP, 'src', 'brand', 'logo.generated.js');
// Inside app/node_modules/.cache, so the bundle's own imports of react and react-dom resolve to the app's copies.
const CACHE = path.join(APP, 'node_modules', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(CACHE, 'test-product-name-'));
const abs = (...p) => JSON.stringify(path.join(APP, ...p).split(path.sep).join('/'));
const entry = path.join(tmp, 'entry.jsx');
fs.writeFileSync(entry, `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import Login from ${abs('src', 'pages', 'Login.jsx')};
import HubLayout from ${abs('src', 'layouts', 'HubLayout.jsx')};
import PublicAreaScan from ${abs('src', 'pages', 'PublicAreaScan.jsx')};
import * as quote from ${abs('src', 'lib', 'quoteTemplate.js')};
import * as report from ${abs('src', 'lib', 'inspectionReportTemplate.js')};
import * as signIn from ${abs('src', 'lib', 'signInEmail.js')};
export const login = () => renderToStaticMarkup(createElement(Login));
export const hub = () => renderToStaticMarkup(createElement(HubLayout, { viewerName: 'Pat Lee' }));
export const scan = () => renderToStaticMarkup(createElement(PublicAreaScan));
export { quote, report, signIn };
`);
const SHIMS = {
  '\0rrd': `import { createElement } from 'react';
export function Link({ to, children, ...rest }) { return createElement('a', { href: typeof to === 'string' ? to : '#', ...rest }, children); }
export function Outlet() { return null; }
export function Navigate() { return null; }
export function useNavigate() { return () => {}; }
export function useSearchParams() { return [new URLSearchParams(''), () => {}]; }
export function useLocation() { return { pathname: '/', search: '', hash: '', state: null, key: 'default' }; }
export function useParams() { return { token: 'probe-token' }; }`,
  '\0auth': `export function useSession() {
  const no = () => {};
  return { signIn: async () => ({}), signOut: async () => ({}), sendPasswordReset: async () => ({}), updatePassword: async () => ({}),
    recovery: false, clearRecovery: no, authError: '', clearAuthError: no, session: null, loading: false,
    sessionExpired: false, clearSessionExpired: no, accountDisabled: null, clearAccountDisabled: no };
}`,
  // …and the visitor's two actions below the card (UI_RULES §174), called only on a tap.
  '\0scan': `export function getPublicAreaScan() { return new Promise(() => {}); }
export function sendVisitorReport() { return new Promise(() => {}); }
export function rateScanArea() { return new Promise(() => {}); }`,
  '\0hub-api': `export function fetchHubUpdates() { return new Promise(() => {}); }
export function markHubUpdatesSeen() { return new Promise(() => {}); }`,
  '\0i18n-runtime': `const snap = { choice: 'auto', phone: null, lang: 'en', version: 0 };
export function subscribeLanguage() { return () => {}; }
export function getLanguageSnapshot() { return snap; }
export function currentLanguage() { return 'en'; }
export function setLanguageChoice() {}
export function ensureCatalog() { return Promise.resolve(true); }
export function preloadCurrentLanguage() { return Promise.resolve(true); }`,
};
const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const plugin = {
  name: 'product-name-test',
  resolveId(id, importer) {
    if (id === 'react-router-dom') return '\0rrd';
    if (/(^|[\\/])auth[\\/]AuthProvider(\.jsx)?$/.test(id)) return '\0auth';
    if (/(^|[\\/])scanCodesApi(\.js)?$/.test(id)) return '\0scan';
    if (/(^|[\\/])clientHubApi(\.js)?$/.test(id)) return '\0hub-api';
    if (/(^|[\\/])runtime(\.js)?$/.test(id) && /[\\/]src[\\/]i18n[\\/]/.test(importer || '')) return '\0i18n-runtime';
    return null;
  },
  load(id) {
    if (Object.hasOwn(SHIMS, id)) return SHIMS[id];
    if (sameFile(id, ID_FILE)) return 'export const IDENTITY = globalThis.__PN_IDENTITY__;';
    if (sameFile(id, LOGO_FILE)) return 'export const DOC_LOGO_IMAGE = null;';
    return null;
  },
};
let views = null;
try {
  const bundle = await rolldown({
    input: entry, platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: true, SSR: true }) } },
  });
  await bundle.write({ file: path.join(tmp, 'views.mjs'), format: 'esm' });
  const url = pathToFileURL(path.join(tmp, 'views.mjs')).href;
  const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
  const load = async (pack, tag) => { globalThis.__PN_IDENTITY__ = deepFreeze(identityOf(pack)); return import(`${url}?${tag}`); };
  views = { with: await load(WITH, 'with'), base: await load(BASE, 'base') };
} catch (e) {
  fails.push(`the views bundle builds and loads (${String(e?.message || e).split('\n')[0]})`);
}
if (views) {
  const altOf = (html, cls) => new RegExp(`class="${cls}"[^>]*?alt="([^"]*)"|alt="([^"]*)"[^>]*?class="${cls}"`).exec(html)?.slice(1).find(Boolean);
  // the element's first line of text: up to its first closing tag, less any opening tag before the text (the sign-in
  // page's footer is two lines in spans, the (c) line first)
  const textOf = (html, cls) => new RegExp(`class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</`).exec(html)?.[1].replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim();
  const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  const v = views.with;
  const SOFT = PRODUCT.name;
  const CO = BASE.name;
  // the sign-in page
  const login = v.login();
  ok(`the sign-in page's logo is named for the software ("${SOFT}")`, decode(altOf(login, 'login-logo')) === SOFT, altOf(login, 'login-logo'));
  ok(`the sign-in page's (c) line names the company ("© 2026 ${CO}")`, decode(textOf(login, 'login-foot')) === `© 2026 ${CO}`, textOf(login, 'login-foot'));
  // the client hub's frame
  const hub = v.hub();
  ok(`the client hub's logo is named for the software ("${SOFT}")`, decode(altOf(hub, 'hub-logo')) === SOFT, altOf(hub, 'hub-logo'));
  ok(`the client hub's (c) footer names the company ("© 2026 ${CO}")`, decode(textOf(hub, 'hub-foot')) === `© 2026 ${CO}`, textOf(hub, 'hub-foot'));
  // the public scan page's frame
  const scan = v.scan();
  ok(`the scan page's logo is named for the software ("${SOFT}")`, decode(altOf(scan, 'scan-logo')) === SOFT, altOf(scan, 'scan-logo'));
  ok(`the scan page says "Cleaning by ${CO}" (the company)`, decode(textOf(scan, 'scan-foot')) === `Cleaning by ${CO}`, textOf(scan, 'scan-foot'));
  // the documents: the company's, and never the software's
  const doc = (html) => decode(String(html).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' '));
  const fields = { clientName: 'Northside Auto Group', contactName: 'Morgan Hayes', restrooms: '4' };
  const q = doc(v.quote.buildQuoteHtml(fields, {}));
  ok(`the quote names the company and never the software`, q.includes(CO) && !q.includes(SOFT) && !q.includes(PRODUCT.wordmark));
  ok(`the quote's PDF header and footer name the company and never the software`,
    doc(v.quote.PRINT_HEADER).includes(CO) && doc(v.quote.PRINT_FOOTER).includes(CO) && !doc(v.quote.PRINT_HEADER + v.quote.PRINT_FOOTER).includes(SOFT));
  const rep = { inspection: { templateName: 'Monthly quality walk', clientName: 'Northside Auto Group', inspectorName: 'Kyler Nguyen', performedAt: '2026-09-22T15:00:00Z', result: 'pass', overallScore: 92,
    schema: { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Floors' }] }] } }, items: [{ itemKey: 'i1', rating: 'pass' }], photos: [] };
  const r = doc(v.report.buildInspectionReportHtml(rep, {})) + doc(v.report.buildInspectionReportHtml(rep, { forPdf: true }));
  ok('the inspection report (and its PDF) names the company and never the software', r.includes(CO) && !r.includes(SOFT));
  ok("the inspection report's PDF footer names the company", doc(v.report.REPORT_PRINT_FOOTER).includes(CO) && !doc(v.report.REPORT_PRINT_FOOTER).includes(SOFT));
  // the software's own sign-in mails
  const mail = typeof v.signIn.setPasswordEmail === 'function' ? ['invite', 'reset'].map((k) => v.signIn.setPasswordEmail('https://example.test/login#x', k)) : null;
  ok('src/lib/signInEmail.js exports setPasswordEmail() (the sign-in mail\'s words, which api/_lib/users.js sends)', !!mail);
  if (mail) {
    ok(`an invite is "Set up your ${SOFT} account", the software's`, mail[0].subject === `Set up your ${SOFT} account` && doc(mail[0].html).includes(SOFT) && !doc(mail[0].html).includes(CO), mail[0].subject);
    ok(`a reset is "Reset your ${SOFT} password", the software's`, mail[1].subject === `Reset your ${SOFT} password` && doc(mail[1].html).includes(SOFT) && !doc(mail[1].html).includes(CO), mail[1].subject);
  }
  // with no product block, every one of those reads the company, as before
  const b = views.base;
  const loginB = b.login(); const hubB = b.hub(); const scanB = b.scan();
  ok('with no product block, the sign-in, hub and scan logos are named for the company, as before',
    [altOf(loginB, 'login-logo'), altOf(hubB, 'hub-logo'), altOf(scanB, 'scan-logo')].every((a) => decode(a) === CO), [altOf(loginB, 'login-logo'), altOf(hubB, 'hub-logo'), altOf(scanB, 'scan-logo')]);
  if (typeof b.signIn.setPasswordEmail === 'function') {
    ok('with no product block, the sign-in mails name the company, as before', b.signIn.setPasswordEmail('https://example.test/l', 'invite').subject === `Set up your ${CO} account`);
  }
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
delete globalThis.__PN_IDENTITY__;

// ── 5. the ledger: every read of the brand's name, classed ──────────────────
// [file, reads of the SOFTWARE's name (IDENTITY.product.*), reads of the COMPANY's (IDENTITY.name / wordmark /
// appTitle / shortName), why]. Counted on code lines (comments are prose about it). A file not listed here
// that reads a name, or a count that moves, fails: decide whether the place shows the software or the company.
const LEDGER = [
  // the software: what the person using the app sees of it
  ['src/lib/documentTitle.js', 1, 0, "the browser tab's title"],
  ['src/pages/Login.jsx', 1, 0, "the sign-in page's logo (its (c) line reads the seeded org's name: the company)"],
  ['src/components/Sidebar.jsx', 1, 0, "the nav bar's logo (the no-logo fallback shows the org's own name: the company)"],
  ['src/pages/MyDay.jsx', 1, 0, "the cleaner's Home header names the app (the Cleaner Hub)"],
  ['src/components/MasterSearch.jsx', 1, 0, "the search box's label: searching the app"],
  ['src/components/BootScreen.jsx', 1, 0, "the boot screen's \"Can't reach\": the app the person cannot reach (CS-672)"],
  ['src/components/GmailConnectInstructions.jsx', 5, 0, "the app's own OAuth app, which a Workspace admin trusts"],
  ['src/components/WebhooksSection.jsx', 1, 0, 'pushing data into the app'],
  ['src/pages/settings/ConnectedInboxes.jsx', 1, 0, 'the app keeps an account email and a mailbox apart'],
  ['src/pages/settings/QuickStart.jsx', 8, 0, 'installing the app on a phone: the home-screen name'],
  ['src/components/HrTerminationForm.jsx', 2, 0, "a termination's form: the person's login to the app turns off (Super Clippy's idea #513)"],
  ['src/pages/hr/TerminationsTab.jsx', 1, 0, "HR → Terminations: each one turns the person's login to the app off"],
  ['src/components/InstallWelcome.jsx', 2, 0, 'the Home Screen welcome: its logo\'s name and "Open {product} from your Home Screen" (UI_RULES §178)'],
  ['src/pages/hub/HubAlertsSteps.jsx', 1, 0, 'Crew on the way\'s Home Screen steps: the welcome\'s "Open {product} from your Home Screen" (UI_RULES §187)'],
  ['src/pages/review/MockupFrame.jsx', 1, 0, "a Review design question's mockup draws the app's own screens: the nav bar's name beside its logo (UI_RULES §179)"],
  ['src/pages/settings/settingsNav.js', 2, 0, 'Quick Start: finish setting up the app'],
  ['src/lib/push.js', 1, 0, "the demo's test push"],
  ['api/push/test.js', 1, 0, 'the test push'],
  ['src/lib/signInEmail.js', 2, 0, 'the sign-in mails (an invite, a password reset)'],
  // both, in one place
  ['src/layouts/HubLayout.jsx', 1, 1, "the client hub's logo is the software's; its (c) footer the company's"],
  ['src/pages/PublicAreaScan.jsx', 1, 2, 'the scan page\'s logo is the software\'s; "Cleaning by" and its Sign-in line ("{company} team or customer?", UI_RULES §172) the company'],
  ['src/pages/settings/Account.jsx', 1, 1, 'the account-email note names the app; the email-signature example the company'],
  ['src/components/HrTerminationDetail.jsx', 1, 1, "a termination's read view: the login to the app it turns off; its subtitle the employer's name, as on an incident report"],
  ['api/_lib/push/dispatch.js', 2, 1, "a push's default title and the digest name the app; a text names the company (its number is registered to the business)"],
  // the company: who does the cleaning, signs, bills and sends
  ['src/brand/logo.js', 0, 1, "the documents' letterhead mark"],
  ['src/lib/quoteTemplate.js', 0, 2, 'the quote and its PDF'],
  ['src/lib/inspectionReportTemplate.js', 0, 3, 'the inspection report and its PDF'],
  ['src/lib/hrWarningDocument.js', 0, 2, "a printed employee warning: the employer's letterhead and footer"],
  ['src/lib/hrIncidentDocument.js', 0, 3, "a printed incident report (task #258): the employer's letterhead mark, the subtitle and the footer of the company's own form"],
  ['src/components/HrIncidentForm.jsx', 0, 1, "the incident report form's subtitle: the employer's name, as on the company's own form"],
  ['src/components/HrIncidentDetail.jsx', 0, 1, "an incident report's subtitle: the employer's name, as on the company's own form"],
  ['src/lib/hrTerminationDocument.js', 0, 3, "a printed termination (idea #513): the employer's letterhead mark, its line under the title and the footer"],
  ['src/lib/activityLogExport.js', 0, 2, "a customer's activity record (PDF)"],
  ['src/lib/quoteEmails.js', 0, 5, 'the sign-request and signed-copy emails to a customer'],
  ['src/pages/PublicQuote.jsx', 0, 5, "the public quote's signing consent: a legal agreement with the company"],
  ['src/pages/QuoteEditor.jsx', 0, 2, "signing as the company's representative"],
  ['src/components/CreateQuoteModal.jsx', 0, 1, "the company's quote template"],
  ['src/pages/review/DraftPreview.jsx', 0, 2, 'the sender of the customer-facing drafts'],
  ['src/data/emailDrafts.js', 0, 1, 'the customer-facing drafts catalog'],
  ['src/data/seed.js', 0, 2, "the demo org's own name and its customer messages"],
  ['src/lib/reminderScheduler.js', 0, 1, "the customer messages' {company}: the company's name when the shared record names none"],
  ['src/lib/hubDemo.js', 0, 1, "the hub view's brand (the company whose buildings these are)"],
  ['api/hub/[...path].js', 0, 1, "the hub view's brand (the company whose buildings these are)"],
  ['api/_lib/clientHub/notify.js', 0, 4, "the client hub's emails (the office's Messages reply too): sign-off by the company's team"],
  ['api/_lib/email.js', 0, 1, "the system sender's display name: the company's mailbox"],
  ['api/_lib/monitor.js', 0, 1, "an ops alert names the deployment's company"],
];
const PRODUCT_READ = /\bIDENTITY\.product\.(name|shortName|appTitle|wordmark)\b/g;
const COMPANY_READ = /\bIDENTITY\.(name|wordmark|appTitle|shortName)\b/g;
const isComment = (l) => /^\s*(\/\/|\/?\*)/.test(l);
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
};
const found = new Map();
for (const root of ['src', 'api']) {
  for (const f of walk(path.join(APP, root))) {
    const r = path.relative(APP, f).split(path.sep).join('/');
    if (r === 'src/brand/identity.generated.js') continue;
    let p = 0; let c = 0;
    for (const line of read(f).split('\n')) {
      if (isComment(line)) continue;
      p += (line.match(PRODUCT_READ) || []).length;
      c += (line.match(COMPANY_READ) || []).length;
    }
    if (p || c) found.set(r, [p, c]);
  }
}
const listed = new Map(LEDGER.map(([r, p, c]) => [r, [p, c]]));
const unclassed = [...found.keys()].filter((r) => !listed.has(r));
ok('every read of the brand\'s name in app/src and app/api is classed software or company', unclassed.length === 0, unclassed.map((r) => `${r} ${found.get(r)}`).join('; '));
const moved = [...listed.keys()].filter((r) => !same(found.get(r) || [0, 0], listed.get(r)));
ok('each classed file reads the software and the company exactly as many times as the ledger says', moved.length === 0,
  moved.map((r) => `${r}: ledger ${listed.get(r)}, code ${found.get(r) || [0, 0]}`).join('; '));
ok('every ledger row states its reason', LEDGER.every(([, , , why]) => typeof why === 'string' && why.length > 12));

console.log(`\ntest-product-name: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
}
