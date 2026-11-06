// The BROWSER's language state (CS-193): which language this screen is in, and loading the
// catalogs it needs. Browser-only — the server renders with core.js and api/_lib/i18n.js.
//
// The language comes from languages.resolveLanguage: the signed-in person's saved choice
// (components/LanguageSync feeds it from their roster row), else the phone's, else English.
// Until the store has loaded, the choice this device last saw is used (a per-device
// convenience in localStorage, so a Spanish cleaner's sign-in screen and first paint are
// already Spanish); the roster row wins the moment it arrives.
//
// Non-English catalogs are LAZY: a separate download, fetched only when a screen needs that
// language — an English-only office never pays for Spanish or Creole. Until it arrives the
// screen shows English (core.js falls back per key), then re-renders in place.
//
// THE SERVER'S LINES (CS-851). Whatever this build's bundle lacks — a line added or reworded
// after es.js / ht.js were written — the server translates itself (GET /api/i18n/lines). They
// are merged OVER the bundled catalog: the device's copy for this build as soon as the catalog
// loads (so they show offline), and a fresh set once per session (refreshServerLines, called by
// components/LanguageSync once someone is signed in). The cache and the fetch rules are
// src/i18n/serverLines.js.
import {
  registerCatalog, hasCatalog, getCatalogVersion, onCatalogChange, SOURCE_CATALOG,
} from './core.js';
import {
  LANGUAGE_INFO, SOURCE_LANGUAGE, AUTO_LANGUAGE, normalizeLanguage, normalizeLanguageChoice,
  phoneLanguageFrom, resolveLanguage,
} from './languages.js';
import { setUiLocale } from '../lib/dates.js';
import { markStub } from '../lib/demoMode.js';
import { APP_BUILD } from '../lib/appBuild.js';
import { readCachedLines, refreshServerLines as refreshLines } from './serverLines.js';

const CHOICE_KEY = 'cleanspace_lang_choice_v1';

const LOADERS = {
  es: () => import('./catalog/es.js'),
  ht: () => import('./catalog/ht.js'),
};

function readPhoneLanguage() {
  try {
    const list = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
    return phoneLanguageFrom(list);
  } catch { return null; }
}
function readCachedChoice() {
  try { return normalizeLanguageChoice(localStorage.getItem(CHOICE_KEY)); } catch { return AUTO_LANGUAGE; }
}
function writeCachedChoice(choice) {
  try {
    if (choice === AUTO_LANGUAGE) localStorage.removeItem(CHOICE_KEY);
    else localStorage.setItem(CHOICE_KEY, choice);
  } catch { /* private window / blocked storage: the roster row still decides */ }
}

function build(choice, phone) {
  const lang = resolveLanguage({ choice, phone });
  return { choice, phone, lang, version: getCatalogVersion() };
}

let snapshot = build(readCachedChoice(), readPhoneLanguage());
const listeners = new Set();
function emit() { for (const fn of listeners) { try { fn(); } catch { /* noop */ } } }

function apply() {
  setUiLocale(LANGUAGE_INFO[snapshot.lang].dateLocale);
  try { document.documentElement.lang = snapshot.lang; } catch { /* no DOM */ }
}
apply();

onCatalogChange(() => { snapshot = { ...snapshot, version: getCatalogVersion() }; emit(); });

export function subscribeLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getLanguageSnapshot() { return snapshot; }
export function currentLanguage() { return snapshot.lang; }

// The person's saved choice ('auto' | 'en' | 'es' | 'ht'), from their roster row. `persist:
// false` is for an owner VIEWING AS someone else: their screen shows that person's language
// for the visit, and this device's remembered choice stays the owner's own.
export function setLanguageChoice(choice, { persist = true } = {}) {
  const c = normalizeLanguageChoice(choice);
  if (persist) writeCachedChoice(c);
  if (c === snapshot.choice) return;
  snapshot = build(c, snapshot.phone);
  apply();
  emit();
  ensureCatalog(snapshot.lang);
}

// The bundled catalog of each loaded language (demo pseudo-text included), and the server's lines
// over it. Registered together, so a fresh set of lines never loses the bundle and the reverse.
const bundled = new Map();
const serverLines = new Map();
const storageOf = (kind) => { try { return kind === 'session' ? sessionStorage : localStorage; } catch { return null; } };
function publish(code) {
  if (!bundled.has(code)) return;
  registerCatalog(code, { ...bundled.get(code), ...(serverLines.get(code) || {}) });
}
export function applyServerLines(lang, lines) {
  const code = normalizeLanguage(lang);
  if (!code || code === SOURCE_LANGUAGE || !lines || typeof lines !== 'object') return;
  serverLines.set(code, { ...(serverLines.get(code) || {}), ...lines });
  publish(code);
}
// Fetch this session's lines for `lang` (once per session and build) and merge them. `fetchLines`
// is lib/i18nApi's (passed in, so this module carries no API client). Never throws.
export async function refreshServerLines(lang, fetchLines) {
  const code = normalizeLanguage(lang);
  if (!code || code === SOURCE_LANGUAGE) return null;
  return refreshLines({
    lang: code, build: APP_BUILD, fetchLines, storage: storageOf('local'), session: storageOf('session'),
    en: SOURCE_CATALOG, onLines: (lines) => applyServerLines(code, lines),
  });
}

const inFlight = new Map();
// Fetch and register a language's catalog. Safe to call any number of times; resolves when
// it is usable (or failed — a failed download leaves English showing, never a blank).
export function ensureCatalog(lang) {
  const code = normalizeLanguage(lang);
  if (!code || code === SOURCE_LANGUAGE || hasCatalog(code)) return Promise.resolve(true);
  if (inFlight.has(code)) return inFlight.get(code);
  const p = (async () => {
    try {
      const mod = await LOADERS[code]();
      let dict = mod.default || {};
      // DEMO ONLY: fill what the catalog has no line for yet with pseudo-text, so the demo
      // shows which lines are converted (src/i18n/pseudo.js). Plain import.meta.env.MODE so
      // Vite folds it and the whole branch, sentinel included, is absent from `npm run build`.
      if (import.meta.env.MODE === 'demo') {
        markStub('cs-stub:i18n-pseudo');
        const { pseudoCatalog } = await import('./pseudo.js');
        dict = { ...pseudoCatalog(SOURCE_CATALOG), ...dict };
      }
      bundled.set(code, dict);
      // The device's copy of the server's lines for THIS build, under any fresher set already here.
      serverLines.set(code, { ...(readCachedLines(storageOf('local'), code, APP_BUILD) || {}), ...(serverLines.get(code) || {}) });
      publish(code);
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(code);
    }
  })();
  inFlight.set(code, p);
  return p;
}

// Start loading the language this device will most likely need, before the first render.
// main.jsx waits on it briefly so a Spanish cleaner's first paint is Spanish.
export function preloadCurrentLanguage() { return ensureCatalog(snapshot.lang); }
