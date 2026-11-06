// The first-visit welcome that puts the app on a phone's Home Screen (task #127, UI_RULES §178):
// WHO sees it and WHICH steps — one pure decision, no browser globals, so
// scripts/test-install-welcome.mjs holds it against a matrix of real user agents. The browser side
// (the install offer, the stored answers, the hook) is lib/installApp.js; the screen is
// components/InstallWelcome.jsx.
//
// What the phones allow (2026-10-21):
//   • Android (Chrome, Edge, Samsung Internet) fires `beforeinstallprompt`: the page may offer its own
//     Install button, which opens the phone's install box. Nothing installs without that confirm.
//   • iPhone and iPad give a page no install button at all; the person adds it from the browser's own
//     menu, so the welcome shows that browser's steps. Safari on iOS 26+ freezes the OS version in its
//     user agent ("iPhone OS 18_7" on iOS 27) — the `Version/27.0` token is the one that moves.
//   • A browser inside another app (Facebook, Instagram, an Android WebView…) can't add anything: the
//     welcome says so and offers the link to open in Safari or Chrome.

// localStorage, per browser: 'installed' (the app is on this phone) | 'never' (stop for good).
export const INSTALL_STORE_KEY = 'cs.installWelcome';
// sessionStorage, this visit: '1' once "Continue in the browser" was tapped.
export const INSTALL_LATER_KEY = 'cs.installWelcome.later';
// sessionStorage, this visit: '1' once the welcome has been on screen (the push prompt waits).
export const INSTALL_SHOWN_KEY = 'cs.installWelcome.shown';

// The phone this is, from its user agent: 'ios' (iPhone, iPod, iPad — an iPad that reports a Mac is
// told apart by its touch points), 'android', or null (a computer: never shown there).
export function phoneOf(ua = '', maxTouchPoints = 0) {
  if (/iPhone|iPod|iPad/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua) && Number(maxTouchPoints) > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return null;
}

export function isIPad(ua = '', maxTouchPoints = 0) {
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && Number(maxTouchPoints) > 1);
}

// In-app browsers that say who they are. They cannot add a page to the Home Screen.
const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|LinkedInApp|Snapchat|musical_ly|BytedanceWebview|TikTok|\bLine\/|MicroMessenger|Pinterest|GSA\//;

// The browser, on a phone: 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'inapp' | 'other'.
export function browserOf(ua = '', phone = phoneOf(ua)) {
  if (!phone) return null;
  if (IN_APP.test(ua)) return 'inapp';
  if (phone === 'android') {
    if (/; wv\)/.test(ua)) return 'inapp'; // an Android WebView inside some app
    if (/SamsungBrowser\//.test(ua)) return 'samsung';
    if (/EdgA\//.test(ua)) return 'edge';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/OPR\/|YaBrowser\/|UCBrowser\//.test(ua)) return 'other';
    if (/Chrome\//.test(ua)) return 'chrome';
    return 'other';
  }
  if (/CriOS\//.test(ua)) return 'chrome';
  if (/EdgiOS\//.test(ua)) return 'edge';
  if (/FxiOS\//.test(ua)) return 'firefox';
  // Every iOS browser carries "Safari/"; a bare web view inside an app does not.
  if (!/Safari\//.test(ua)) return 'inapp';
  if (/OPiOS\/|OPT\/|Ddg\/|DuckDuckGo|YaBrowser\//.test(ua)) return 'other';
  return 'safari';
}

// Safari's own version (`Version/27.0` → 27), or 0 when it can't be read.
export function safariVersion(ua = '') {
  const m = /Version\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : 0;
}

// The decision. Returns null (show nothing) or { phone, browser, variant, ipad }.
//   standalone      — opened from the Home Screen icon (never shown there)
//   stored          — this browser's INSTALL_STORE_KEY: 'installed' | 'never' | null
//   laterThisVisit  — "Continue in the browser" was tapped this visit
//   canPrompt       — Android handed over its install offer (beforeinstallprompt)
// Variants:
//   ios-safari         Safari 27+: the page menu (three lines) at the left of the address bar → Share
//                      → View More → Add to Home Screen → Add (seen on the iOS 27 simulator)
//   ios-safari-26      Safari 26: ⋯ beside the address bar → Share → Add to Home Screen → Add
//   ios-safari-legacy  Safari 25 and older: the Share button in the toolbar → Add to Home Screen → Add
//   ipad-safari        Safari on an iPad: Share → Add to Home Screen → Add
//   ios-chrome         Chrome: Share at the right of the address bar → Add to Home Screen → Add
//                      (Google's "Use web apps" help, iPhone & iPad)
//   ios-other          Edge, Firefox and the rest on iOS: this browser's Share → Add to Home Screen
//   android-prompt     the page's own Install button
//   android-chrome     Chrome or Edge with no offer: ⋮ More → Install and create shortcut → Install
//                      (Google's "Use web apps" help, Android)
//   android-other      Samsung Internet, Firefox and the rest with no offer: this browser's menu
//   inapp              a browser inside another app: open the page in Safari / Chrome first
export function installWelcomeFor({
  ua = '', maxTouchPoints = 0, standalone = false, stored = null, laterThisVisit = false, canPrompt = false,
} = {}) {
  if (standalone) return null;
  if (stored === 'installed' || stored === 'never') return null;
  if (laterThisVisit) return null;
  const phone = phoneOf(ua, maxTouchPoints);
  if (!phone) return null;
  const browser = browserOf(ua, phone);
  const ipad = phone === 'ios' && isIPad(ua, maxTouchPoints);
  let variant;
  if (browser === 'inapp') variant = 'inapp';
  else if (phone === 'android') {
    if (canPrompt) variant = 'android-prompt';
    else if (browser === 'chrome' || browser === 'edge') variant = 'android-chrome';
    else variant = 'android-other';
  } else if (browser === 'safari') {
    const v = safariVersion(ua);
    if (ipad) variant = 'ipad-safari';
    else if (v >= 27) variant = 'ios-safari';
    else if (v === 26) variant = 'ios-safari-26';
    else variant = 'ios-safari-legacy';
  } else if (browser === 'chrome') variant = 'ios-chrome';
  else variant = 'ios-other';
  return { phone, browser, variant, ipad };
}

// The steps each variant shows, as catalog keys (installWelcome.*); `icon` names the glyph drawn
// beside a step (an Icon name; components/InstallWelcome.jsx). The last step of every manual path is "open it
// from the Home Screen". android-prompt has no steps: its Install button is the step.
const OPEN = { key: 'installWelcome.step.open', icon: 'home' };
export const INSTALL_STEPS = {
  'ios-safari': [
    { key: 'installWelcome.step.safari27Menu', icon: 'pageMenu' },
    { key: 'installWelcome.step.safariShare', icon: 'share' },
    { key: 'installWelcome.step.safariAdd', icon: 'addSquare' },
    OPEN,
  ],
  'ios-safari-26': [
    { key: 'installWelcome.step.safari26Menu', icon: 'dots' },
    { key: 'installWelcome.step.safariShare', icon: 'share' },
    { key: 'installWelcome.step.safariAdd', icon: 'addSquare' },
    OPEN,
  ],
  'ios-safari-legacy': [
    { key: 'installWelcome.step.safariLegacyShare', icon: 'share' },
    { key: 'installWelcome.step.legacyAdd', icon: 'addSquare' },
    OPEN,
  ],
  'ipad-safari': [
    { key: 'installWelcome.step.ipadShare', icon: 'share' },
    { key: 'installWelcome.step.legacyAdd', icon: 'addSquare' },
    OPEN,
  ],
  'ios-chrome': [
    { key: 'installWelcome.step.chromeIosShare', icon: 'share' },
    { key: 'installWelcome.step.legacyAdd', icon: 'addSquare' },
    OPEN,
  ],
  'ios-other': [
    { key: 'installWelcome.step.otherIosShare', icon: 'share' },
    { key: 'installWelcome.step.legacyAdd', icon: 'addSquare' },
    OPEN,
  ],
  'android-prompt': [],
  'android-chrome': [
    { key: 'installWelcome.step.androidMenu', icon: 'kebab' },
    { key: 'installWelcome.step.androidInstall', icon: 'addSquare' },
    OPEN,
  ],
  'android-other': [
    { key: 'installWelcome.step.androidOtherMenu', icon: 'kebab' },
    OPEN,
  ],
  inapp: [
    { key: 'installWelcome.step.inappOpen', icon: 'external' },
    { key: 'installWelcome.step.inappCopy', icon: 'copy' },
  ],
};

// A note under the steps, for the paths that may not work in this browser.
export const INSTALL_NOTE = {
  'ios-other': 'installWelcome.note.useSafari',
  'android-other': 'installWelcome.note.useChrome',
};
