// The first-visit Home Screen welcome (task #127, UI_RULES §178).
//
//   1. lib/installWelcome's decision against real user agents: who sees it (a phone's browser only,
//      never the Home Screen app, never a computer, never after "I already have the app" / "Don't show
//      again", not again this visit after "Continue in the browser") and which steps (Safari 27 / 26 /
//      older, an iPad that reports a Mac, Chrome / Edge / Firefox on iOS, Android with and without the
//      install offer, Samsung Internet, browsers inside other apps);
//   2. every step is a catalog line, every glyph is in the Icon registry, every variant has its steps;
//   3. the wiring: main.jsx loads lib/installApp first; the sign-in page (not its set-a-new-password
//      screen), the office shell and the customer hub (in English, LANG-8) mount it; the public pages
//      don't; the push prompt waits on it; the manifest lets Android say the app is installed.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying on the
// first missing export. Offline. Run: node scripts/test-install-welcome.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const show = (v) => JSON.stringify(v);

const mod = await import('../src/lib/installWelcome.js').catch(() => ({}));
const decide = typeof mod.installWelcomeFor === 'function' ? mod.installWelcomeFor : () => undefined;
const STEPS = mod.INSTALL_STEPS || {};
const NOTE = mod.INSTALL_NOTE || {};

// Real user agents. Safari on iOS 27 as the iOS 27 simulator sent it (2026-10-21): the OS version is
// frozen at 18_7, the Version/ token is the one that moves.
const UA = {
  safari27: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  safari26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  safari18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  edgeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.57 Mobile/15E148 Safari/605.1.15',
  firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0;FBBV/1;FBDV/iPhone16,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
  instagramIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0 (iPhone16,2; iOS 18_6; en_US; en-US; scale=3.00; 1179x2556; 123)',
  webviewIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  edgeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
  samsung: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  webviewAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.43 Mobile Safari/537.36',
  facebookAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.43 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/500.0.0.47.109;]',
  instagramAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241005.015) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.43 Mobile Safari/537.36 Instagram 400.0.0.0 Android',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};
const variantOf = (ua, extra = {}) => decide({ ua, maxTouchPoints: 5, ...extra })?.variant ?? null;

// ── 1. Who sees it, and which steps ──
const CASES = [
  ['iPhone, Safari 27 (the page menu at the left of the address bar)', variantOf(UA.safari27), 'ios-safari'],
  ['iPhone, Safari 26 (⋯ beside the address bar)', variantOf(UA.safari26), 'ios-safari-26'],
  ['iPhone, Safari 18 (the toolbar Share button)', variantOf(UA.safari18), 'ios-safari-legacy'],
  ['an iPad that reports a Mac (touch points 5)', variantOf(UA.ipadAsMac), 'ipad-safari'],
  ['an older iPad that says iPad', variantOf(UA.ipadOld), 'ipad-safari'],
  ['iPhone, Chrome', variantOf(UA.chromeIos), 'ios-chrome'],
  ['iPhone, Edge', variantOf(UA.edgeIos), 'ios-other'],
  ['iPhone, Firefox', variantOf(UA.firefoxIos), 'ios-other'],
  ['iPhone, inside Facebook', variantOf(UA.facebookIos), 'inapp'],
  ['iPhone, inside Instagram', variantOf(UA.instagramIos), 'inapp'],
  ['iPhone, a bare web view in some app (no Safari/ token)', variantOf(UA.webviewIos), 'inapp'],
  ['Android, Chrome with no install offer (the ⋮ menu steps)', variantOf(UA.chromeAndroid), 'android-chrome'],
  ['Android, Chrome with the install offer (the Install button)', variantOf(UA.chromeAndroid, { canPrompt: true }), 'android-prompt'],
  ['Android, Edge with no offer', variantOf(UA.edgeAndroid), 'android-chrome'],
  ['Android, Samsung Internet with the offer', variantOf(UA.samsung, { canPrompt: true }), 'android-prompt'],
  ['Android, Samsung Internet with no offer', variantOf(UA.samsung), 'android-other'],
  ['Android, Firefox', variantOf(UA.firefoxAndroid), 'android-other'],
  ['Android, a WebView inside some app', variantOf(UA.webviewAndroid), 'inapp'],
  ['Android, inside Facebook (even with an offer, it can’t install)', variantOf(UA.facebookAndroid, { canPrompt: true }), 'inapp'],
  ['Android, inside Instagram', variantOf(UA.instagramAndroid), 'inapp'],
  ['a Mac, Chrome', decide({ ua: UA.chromeMac, maxTouchPoints: 0 }), null],
  ['a Mac, Safari (no touch points, so not an iPad)', decide({ ua: UA.safariMac, maxTouchPoints: 0 }), null],
  ['Windows, Chrome', decide({ ua: UA.chromeWindows, maxTouchPoints: 0 }), null],
];
for (const [label, got, want] of CASES) ok(`${label} → ${show(want)} (got ${show(got)})`, got === want);

for (const ua of [UA.safari27, UA.chromeAndroid]) {
  const who = ua === UA.safari27 ? 'iPhone' : 'Android';
  ok(`🔴 ${who}: opened from the Home Screen icon → nothing`, decide({ ua, standalone: true }) === null);
  ok(`🔴 ${who}: "I already have the app" (stored installed) → nothing`, decide({ ua, stored: 'installed' }) === null);
  ok(`🔴 ${who}: "Don't show again" (stored never) → nothing`, decide({ ua, stored: 'never' }) === null);
  ok(`${who}: "Continue in the browser" this visit → nothing until the next visit`, decide({ ua, laterThisVisit: true }) === null);
  ok(`${who}: a fresh visit with nothing stored → the welcome`, decide({ ua, stored: null, laterThisVisit: false }) !== null);
}
ok('the decision names the phone and the browser', show(decide({ ua: UA.chromeIos })) === show({ phone: 'ios', browser: 'chrome', variant: 'ios-chrome', ipad: false }));
ok('the storage keys are the welcome\'s own', mod.INSTALL_STORE_KEY === 'cs.installWelcome' && mod.INSTALL_LATER_KEY === 'cs.installWelcome.later' && mod.INSTALL_SHOWN_KEY === 'cs.installWelcome.shown');

// ── 2. Every step is a catalog line, every glyph an Icon ──
const VARIANTS = ['ios-safari', 'ios-safari-26', 'ios-safari-legacy', 'ipad-safari', 'ios-chrome', 'ios-other', 'android-prompt', 'android-chrome', 'android-other', 'inapp'];
ok(`every variant has its steps (${show(Object.keys(STEPS))})`, VARIANTS.every((v) => Array.isArray(STEPS[v])) && Object.keys(STEPS).length === VARIANTS.length);
ok('the Install button is the only step-less variant', VARIANTS.filter((v) => (STEPS[v] || []).length === 0).join() === 'android-prompt');
ok('every manual path ends with "open it from the Home Screen"', VARIANTS.filter((v) => v !== 'android-prompt' && v !== 'inapp').every((v) => (STEPS[v] || []).at(-1)?.key === 'installWelcome.step.open'));
const en = read('src/i18n/catalog/en.js');
const keys = [...new Set([
  ...Object.values(STEPS).flat().map((s) => s.key), ...Object.values(NOTE),
  'installWelcome.title', 'installWelcome.why', 'installWelcome.whyPrompt', 'installWelcome.inappWhy',
  'installWelcome.continue', 'installWelcome.haveIt', 'installWelcome.never', 'installWelcome.install',
  'installWelcome.copyLink', 'installWelcome.copied', 'installWelcome.copyFailed',
])];
const missing = keys.filter((k) => !en.includes(`'${k}':`));
ok(`every line the welcome shows is in the English catalog (missing: ${show(missing)})`, keys.length > 20 && missing.length === 0);
const icons = read('src/components/Icon.jsx');
const glyphs = [...new Set(Object.values(STEPS).flat().map((s) => s.icon))];
const noGlyph = glyphs.filter((g) => !new RegExp(`^  ${g}:`, 'm').test(icons));
ok(`every step's glyph is in the Icon registry (missing: ${show(noGlyph)})`, glyphs.length >= 6 && noGlyph.length === 0);
ok('Safari 27\'s steps name the buttons the iOS 27 simulator shows (Share, View More, Add to Home Screen, Open as Web App, Add)',
  /'installWelcome\.step\.safariShare': '.*<b>Share<\/b>.*<b>Add to Home Screen<\/b>.*<b>View More<\/b>/.test(en)
  && /'installWelcome\.step\.safariAdd': '.*<b>Add to Home Screen<\/b>.*<b>Open as Web App<\/b>.*<b>Add<\/b>/.test(en));

// ── 3. The wiring ──
const main = read('src/main.jsx');
ok('main.jsx loads lib/installApp before the app (so Android\'s early install offer is caught)',
  main.indexOf("import './lib/installApp.js'") > -1 && main.indexOf("import './lib/installApp.js'") < main.indexOf("import App from"));
const login = read('src/pages/Login.jsx');
const recoveryBranch = login.slice(login.indexOf('if (recovery) {'), login.indexOf('// Normal sign-in.'));
ok('🔴 the sign-in form mounts the welcome', /<InstallWelcome \/>/.test(login.slice(login.indexOf('// Normal sign-in.'))));
ok('🔴 …but not the set-a-new-password screen (an app added there would open without the link\'s token)', recoveryBranch.length > 0 && !/InstallWelcome/.test(recoveryBranch));
ok('the email box doesn\'t take the cursor while the welcome is due', /autoFocus=\{!welcomeDue\}/.test(login));
const app = read('src/App.jsx');
const shell = app.slice(app.indexOf('function AuthedShell'), app.indexOf('export default function App'));
ok('the office shell mounts the welcome (and the push prompt beside it)', /<InstallWelcome \/>/.test(shell) && /<MobilePushGate \/>/.test(shell));
ok('the customer hub mounts it in English (LANG-8)', /<InstallWelcome englishOnly \/>/.test(read('src/pages/hub/HubRoot.jsx')));
const publicPages = ['src/pages/PublicQuote.jsx', 'src/pages/PublicInspection.jsx', 'src/pages/PublicAreaScan.jsx', 'src/pages/PublicSurvey.jsx'];
ok('🔴 no public page (a quote, a report, a scanned wall code, a survey) mounts it', publicPages.every((p) => read(p) && !/InstallWelcome/.test(read(p))));
const gate = read('src/components/MobilePushGate.jsx');
ok('🔴 the push prompt waits while the welcome is due or has shown this visit (one pop-up per visit)',
  /const heldByInstallWelcome = useInstallWelcomeHold\(\)/.test(gate) && /if \(heldByInstallWelcome \|\|/.test(gate) && /\[currentUser\?\.id, heldByInstallWelcome\]/.test(gate));
const appLib = read('src/lib/installApp.js');
ok('the hold reads "shown this visit" and the live decision', /readSession\(INSTALL_SHOWN_KEY\) \|\| !!installWelcomeNow\(\)/.test(appLib));
const offerHandler = appLib.slice(appLib.indexOf("addEventListener('beforeinstallprompt'"), appLib.indexOf("addEventListener('appinstalled'"));
ok('🔴 on a phone Chrome\'s own install bar stays down even after "I already have the app" / "Don\'t show again" (preventDefault before the stored check); a computer keeps it',
  /if \(!phoneOf\(/.test(offerHandler) && offerHandler.indexOf('e.preventDefault()') > -1 && offerHandler.indexOf('e.preventDefault()') < offerHandler.indexOf("stored() === 'never'") && offerHandler.indexOf('if (!phoneOf(') < offerHandler.indexOf('e.preventDefault()'));
ok('the screen marks itself shown as it opens', /markWelcomeShown\(\)/.test(read('src/components/InstallWelcome.jsx')));
let manifest = {};
try { manifest = JSON.parse(read('public/manifest.json')); } catch { /* reported below */ }
ok('🔴 the manifest names the app itself as a related web app (Android can tell the page it\'s installed)',
  show(manifest.related_applications) === show([{ platform: 'webapp', url: '/manifest.json' }]) && manifest.display === 'standalone');

console.log(`\ntest-install-welcome: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
