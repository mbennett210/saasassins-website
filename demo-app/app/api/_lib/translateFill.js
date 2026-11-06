// THE FILL (CS-851, CS-850): everything this build's people will read in Spanish or Creole is
// translated BEFORE anyone opens the app — run by the ops-alerts cron (api/cron/ops-alerts.js,
// every 5 minutes, before it raises its alerts), and doing real work at most ONCE PER BUILD.
//
//   1. the app's owed lines (api/_lib/i18n.js pendingFor: what the bundle lacks or holds for old
//      English), es and ht, through translateAll — the store first, Google only for what it lacks;
//   2. every PUBLISHED template's current version whose name, sections or items have no line for
//      today's English (the ones saved before the system translated, any a Google outage left
//      English on its save, and machine lines from an older TRANSLATOR_VERSION — CS-856: the first
//      fill translated customer and building names; the office's own lines are never redone): translated through the same function and written back CAS-safe — only
//      `schema` changes, by adding lines; the English, the version number and everything else
//      stay — and the template row's `name_i18n` (the lists' copy of the name's lines) follows it,
//      written only while the row still has that name;
//   3. the build's fill row (machine_translation_fills): its assembled lines, which every server
//      process merges in one read before it renders an alert, and `complete` once 1 and 2 are done,
//      after which every later run of this build stops at that one read.
//
// Bounded: a time budget (FILL_BUDGET_MS) inside the cron's 60 s; past it the run stops and the
// next one carries on. Idempotent: a re-run finds the lines stored and the templates translated,
// and writes nothing new. Nothing here can break the cron: every failure is reported as a code
// and the alerts still run (English shows for what is not filled yet).
import { getSupabase } from './supabase.js';
import { reportError } from './monitor.js';
import { machineConfigured } from './machineTranslate.js';
import { translateAll } from './translateStore.js';
import { SERVER_LANGUAGES, translatePendingLines, fillBuildId, readFillRow, writeFillRow, ensureStoredLines } from './i18n.js';
import { listTemplates } from './qc/store.js';
import { fillSchemaTranslations, schemaNeedsTranslation } from '../../src/lib/checklistI18n.js';
import { orgProperNouns } from '../../src/i18n/terms.js';
import { readOrgState } from './orgState.js';

export const FILL_BUDGET_MS = 20000;
const VERSION_CHUNK = 50;

// Step 2: the published templates' current versions. → { scanned, filled, complete }
export async function backfillTemplates({ db, translate, deadline = null, report = reportError } = {}) {
  const out = { scanned: 0, filled: 0, complete: true };
  let rows;
  try {
    rows = await listTemplates({}, { columns: 'id,is_published,published_version_id,name,name_i18n' }, db);
  } catch (err) {
    report('i18n.fill-templates', new Error(err?.code || 'template-read-failed'), {});
    return { ...out, complete: false };
  }
  const live = rows.filter((t) => t?.is_published && t.published_version_id);
  const rowOf = new Map(live.map((t) => [t.published_version_id, t]));
  const ids = live.map((t) => t.published_version_id);
  for (let i = 0; i < ids.length; i += VERSION_CHUNK) {
    if (deadline && Date.now() > deadline) { out.complete = false; break; }
    let versions;
    try {
      const { data, error } = await db.from('inspection_template_versions').select('id, template_id, status, published_at, schema')
        .in('id', ids.slice(i, i + VERSION_CHUNK));
      if (error) throw error;
      versions = data || [];
    } catch (err) {
      report('i18n.fill-templates', new Error(err?.code || 'version-read-failed'), {});
      out.complete = false;
      continue;
    }
    for (const v of versions) {
      out.scanned += 1;
      const row = rowOf.get(v.id);
      const name = typeof row?.name === 'string' ? row.name.trim() : '';
      if (v.status !== 'published') continue;
      let schema = v.schema;
      if (schemaNeedsTranslation(v.schema, { name })) {
        if (deadline && Date.now() > deadline) { out.complete = false; break; }
        const filled = await fillSchemaTranslations(v.schema, translate, { name });
        if (filled.missing) out.complete = false;
        if (filled.translated) {
          // CAS: the version as it was read — still published, published at the same moment (a
          // re-publish moves it). A miss is a race: the next run reads it afresh.
          try {
            let q = db.from('inspection_template_versions').update({ schema: filled.schema })
              .eq('id', v.id).eq('template_id', v.template_id).eq('status', 'published');
            q = v.published_at == null ? q.is('published_at', null) : q.eq('published_at', v.published_at);
            const { data, error } = await q.select('id');
            if (error) throw error;
            if ((data || []).length === 1) { out.filled += 1; schema = filled.schema; } else { out.complete = false; continue; }
          } catch (err) {
            report('i18n.fill-templates', new Error(err?.code || 'version-write-failed'), {});
            out.complete = false;
            continue;
          }
        }
      }
      // The row's copy of the name's lines follows the published version (CAS: the same name).
      const want = schema?.nameI18n ?? null;
      if (row && name && want && JSON.stringify(row.name_i18n ?? null) !== JSON.stringify(want)) {
        try {
          const { data, error } = await db.from('inspection_templates').update({ name_i18n: want })
            .eq('id', row.id).eq('name', row.name).select('id');
          if (error) throw error;
          if ((data || []).length !== 1) out.complete = false;
        } catch (err) {
          report('i18n.fill-templates', new Error(err?.code || 'name-write-failed'), {});
          out.complete = false;
        }
      }
    }
  }
  return out;
}

export async function fillTranslations({ db = null, env = process.env, now = Date.now(), budgetMs = FILL_BUDGET_MS, report = reportError } = {}) {
  let client = db;
  try { client = client || getSupabase(); } catch { return { skipped: 'no-database' }; }
  const buildId = fillBuildId(env);
  const row = await readFillRow(buildId, { db: client, report });
  if (row?.complete) return { skipped: 'done', buildId };
  if (!machineConfigured(env)) return { skipped: 'off', buildId };
  const deadline = now + budgetMs;
  const opts = { db: client, env, deadline, report };
  const lines = {};
  const counts = {};
  let complete = true;
  for (const lang of SERVER_LANGUAGES) {
    const r = await translatePendingLines(lang, opts);
    lines[lang] = r.lines;
    counts[lang] = { owed: r.owed, filled: Object.keys(r.lines).length };
    if (counts[lang].filled < r.owed) complete = false;
  }
  // The org's customer and building names go through as written (CS-856, src/i18n/terms).
  let properNouns = [];
  try { properNouns = orgProperNouns((await readOrgState()).state); } catch { /* none: nothing to protect */ }
  const templates = await backfillTemplates({ db: client, deadline, report, translate: (lang, list) => translateAll(lang, list, { ...opts, properNouns }) });
  if (!templates.complete) complete = false;
  await writeFillRow(buildId, lines, complete, { db: client, report, now });
  await ensureStoredLines({ force: true, db: client, env });
  return { buildId, complete, lines: counts, templates };
}
