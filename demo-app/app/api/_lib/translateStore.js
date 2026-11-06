// THE TRANSLATION STORE (CS-851, CS-850): every Spanish and Haitian Creole line the server
// produces, translated ONCE per (language, exact English) by Google Cloud Translation and kept in
// `public.machine_translations` (supabase/migrations/20261015120000_machine_translations.sql).
// No person approves anything; the office may still type its own wording for a checklist line,
// which the template keeps beside the label (src/lib/checklistI18n) — an override, never a gate.
//
//   translateAll(lang, english[]) → (string | null)[], index-aligned with `english`
//
//   1. a line the term list pins (TERM_LINES, e.g. "Clock in") is the pinned line, no Google;
//   1b. the org's customer and building names in a line (`properNouns`, CS-856) become `{noun0}` …
//      placeholders: the line is stored and translated in that shape and each name is put back
//      exactly as written — never translated, and every "Nightly Close-Out — <customer>" shares one
//      stored translation (src/i18n/terms shapeProperNouns);
//   2. the store is read for the rest (one row per lang + sha256 of the exact English, names
//      protected);
//   3. only what the store lacks goes to Google, in batches under machineTranslate's caps, its
//      placeholders, tags and protected nouns as tokens (src/i18n/terms prepareForMachine);
//   4. what comes back is restored (a lost or mangled token = null, never a broken line), held to
//      the term list (repairTerms), STORED (`on conflict do nothing`, so two callers translating
//      the same line never fail) and returned.
//
// 🔴 THE CALLER ALWAYS WORKS. A Google error, a store error, no key: that line answers null (the
// caller shows the English) and the error goes to reportError as a CODE — never the key, never
// Google's words, never the text. Concurrent calls in one process share one request per line.
import { createHash } from 'node:crypto';
import { getSupabase } from './supabase.js';
import { reportError } from './monitor.js';
import { machineConfigured, machineTranslate, MachineTranslateError, MACHINE_LANGUAGES, batchesOf } from './machineTranslate.js';
import { prepareForMachine, repairTerms, forbiddenHits, pinnedLineFor, properNounMatcher, shapeProperNouns, fillProperNouns } from '../../src/i18n/terms.js';
import { SOURCE_CATALOG, placeholdersOf } from '../../src/i18n/core.js';

export const STORE_TABLE = 'machine_translations';
export const STORE_CONFLICT = 'lang,source_hash';
// A line longer than this is never sent (a checklist line is ≤ 500; the app's longest is ~600).
export const MAX_ENGLISH_CHARS = 4000;
// Hashes per store read: 64 hex characters each, so a GET query string stays near 6 KB.
export const READ_CHUNK = 80;
const WRITE_CHUNK = 200;

export const sha256Hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

// Lines already stored for `lang`: Map(hash → translation). A failed read is reported and reads
// as nothing stored (the lines then go to Google, and the write's `do nothing` absorbs a repeat).
export async function readStored(lang, hashes, { db = null, report = reportError } = {}) {
  const out = new Map();
  const list = [...new Set(hashes)].filter(Boolean);
  if (!list.length) return out;
  let client;
  try { client = db || getSupabase(); } catch (err) { report('i18n.store-read', new Error(err?.code || 'store-unavailable'), { lang }); return out; }
  const chunks = [];
  for (let i = 0; i < list.length; i += READ_CHUNK) chunks.push(list.slice(i, i + READ_CHUNK));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const { data, error } = await client.from(STORE_TABLE).select('source_hash, translation')
        .eq('lang', lang).in('source_hash', chunk);
      if (error) throw error;
      for (const r of data || []) if (r?.source_hash && typeof r.translation === 'string') out.set(r.source_hash, r.translation);
    } catch (err) {
      report('i18n.store-read', new Error(err?.code || 'store-read-failed'), { lang, lines: chunk.length });
    }
  }));
  return out;
}

async function writeStored(rows, { db, report }) {
  if (!rows.length) return 0;
  let client;
  try { client = db || getSupabase(); } catch (err) { report('i18n.store-write', new Error(err?.code || 'store-unavailable'), { lines: rows.length }); return 0; }
  let wrote = 0;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    try {
      const { error } = await client.from(STORE_TABLE).upsert(chunk, { onConflict: STORE_CONFLICT, ignoreDuplicates: true });
      if (error) throw error;
      wrote += chunk.length;
    } catch (err) {
      report('i18n.store-write', new Error(err?.code || 'store-write-failed'), { lines: chunk.length });
    }
  }
  return wrote;
}

// One line through the machine, after Google: tokens back, the term list applied, the result
// checked. null = do not use (and do not store) it.
function finish(lang, english, prep, translated, report) {
  const restored = prep.restore(translated);
  if (restored == null) { report('i18n.machine-placeholders', new Error('token-lost'), { lang }); return null; }
  const out = repairTerms(lang, restored);
  const want = placeholdersOf(english);
  const got = placeholdersOf(out);
  if (want.length !== got.length || want.some((p, i) => p !== got[i]) || !out.trim()) {
    report('i18n.machine-placeholders', new Error('placeholders-changed'), { lang });
    return null;
  }
  const hits = forbiddenHits(lang, out);
  // Better the agreed language with one off word than English to a reader who cannot read it:
  // kept, and reported so the term list can grow a repair.
  if (hits.length) report('i18n.machine-term', new Error('forbidden-term'), { lang, rules: hits });
  return out;
}

// Lines being translated right now in this process, so concurrent callers share the request.
const inflight = new Map(); // `${lang}:${hash}` → Promise<string|null>

export async function translateAll(lang, english, {
  db = null, env = process.env, fetchImpl = undefined, report = reportError, en = SOURCE_CATALOG, deadline = null,
  properNouns = null,
} = {}) {
  const list = Array.isArray(english) ? english : [];
  const results = new Array(list.length).fill(null);
  if (!MACHINE_LANGUAGES.includes(lang) || !list.length) return results;

  // 1. pinned lines; everything else by the hash of its shape (names protected, CS-856)
  const matcher = properNounMatcher(properNouns);
  const byHash = new Map(); // hash → { text (the shape), at: [{ i, found }] }
  list.forEach((s, i) => {
    if (typeof s !== 'string' || !s.trim() || s.length > MAX_ENGLISH_CHARS) return;
    const pinned = pinnedLineFor(lang, s, en);
    if (pinned) { results[i] = pinned; return; }
    const { shape, found } = shapeProperNouns(s, matcher);
    const h = sha256Hex(shape);
    if (!byHash.has(h)) byHash.set(h, { text: shape, at: [] });
    byHash.get(h).at.push({ i, found });
  });
  if (!byHash.size) return results;
  // Each line gets the shape's translation with ITS OWN names put back.
  const put = (h, value) => { for (const { i, found } of byHash.get(h).at) results[i] = value == null ? null : fillProperNouns(value, found); };

  // 2. the store
  const stored = await readStored(lang, [...byHash.keys()], { db, report });
  for (const [h, value] of stored) if (byHash.has(h)) put(h, value);
  const missing = [...byHash.keys()].filter((h) => !stored.has(h));
  if (!missing.length || !machineConfigured(env)) return results;

  // 3. what another call in this process is already translating is waited for, not re-sent
  const waits = [];
  const mine = [];
  for (const h of missing) {
    const k = `${lang}:${h}`;
    if (inflight.has(k)) { waits.push([h, inflight.get(k)]); continue; }
    let resolve;
    inflight.set(k, new Promise((r) => { resolve = r; }));
    mine.push({ h, k, resolve, value: null });
  }
  try {
    const bare = [];
    const send = [];
    for (const job of mine) {
      job.prep = prepareForMachine(lang, byHash.get(job.h).text);
      (job.prep.bare ? bare : send).push(job);
    }
    for (const job of bare) job.value = finish(lang, byHash.get(job.h).text, job.prep, job.prep.text, report);
    let at = 0;
    for (const batch of batchesOf(send.map((j) => j.prep.text))) {
      const jobs = send.slice(at, at + batch.length);
      at += batch.length;
      if (deadline && Date.now() > deadline) break;   // out of time: the rest stay English for now
      let got;
      try {
        got = await machineTranslate(batch, lang, { env, ...(fetchImpl ? { fetchImpl } : {}) });
      } catch (err) {
        const code = err instanceof MachineTranslateError ? err.code : 'machine-translation-failed';
        report('i18n.translate', new Error(code), { lang, lines: batch.length });
        break;   // one failure stops this call; the lines stay English and are asked again later
      }
      jobs.forEach((job, j) => { job.value = finish(lang, byHash.get(job.h).text, job.prep, got[j], report); });
    }
    // 4. store and answer
    const rows = mine.filter((j) => j.value != null)
      .map((j) => ({ lang, source_hash: j.h, english: byHash.get(j.h).text, translation: j.value }));
    await writeStored(rows, { db, report });
    for (const job of mine) put(job.h, job.value);
  } finally {
    for (const job of mine) { inflight.delete(job.k); job.resolve(job.value ?? null); }
  }
  for (const [h, p] of waits) put(h, await p);
  return results;
}
