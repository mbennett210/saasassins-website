// React's door into the translation layer (CS-193). A component that shows words calls
// `const t = useT()` and renders `t('myDay.title')` — never an English literal. Subscribed
// through useSyncExternalStore, so a language switch, or a lazy catalog arriving, re-renders
// every component that asked.
//
//   t(key, params)          → the text in the current language (English where untranslated)
//   t(message)              → a msg(...) built elsewhere, rendered here
//   t.rich(key, params, {b: (chunk) => <strong>{chunk}</strong>})
//                           → the text as React nodes, with its <b>…</b>-style tags rendered
//   t.lang                  → 'en' | 'es' | 'ht'
import { Fragment, useMemo, useSyncExternalStore } from 'react';
import { translate } from './core.js';
import { subscribeLanguage, getLanguageSnapshot } from './runtime.js';

export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, getLanguageSnapshot);
}

// `<b>` is bold by default; a caller passes renderers for any other tag it uses.
const DEFAULT_TAGS = { b: (chunk) => <strong>{chunk}</strong> };
const RICH_RE = /<([a-z][a-z0-9]*)>([\s\S]*?)<\/\1>/g;

export function richText(text, tags = {}) {
  const renderers = { ...DEFAULT_TAGS, ...tags };
  const parts = [];
  let last = 0;
  for (const m of String(text || '').matchAll(RICH_RE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const render = renderers[m[1]];
    parts.push(render ? render(m[2]) : m[2]);
    last = m.index + m[0].length;
  }
  if (last < String(text || '').length) parts.push(String(text).slice(last));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

// The translator for one language, built OUTSIDE the hook (the hook only memoizes it): a
// function carrying its language, its catalog version and `rich` as properties.
function makeT(lang, version) {
  const t = (key, params) => translate(lang, key, params);
  t.rich = (key, params, tags) => richText(translate(lang, key, params), tags);
  t.lang = lang;
  t.version = version;
  return t;
}

export function useT() {
  const { lang, version } = useLanguage();
  return useMemo(() => makeT(lang, version), [lang, version]);
}
