// LIVE DATA-OP — file every CHECKLIST template under the customer it belongs to (R2,
// plan docs/plans/2026-09-27-checklists-by-location.md step 5).
//
// 🔴 NEVER RUN THIS AGAINST PRODUCTION WITHOUT THE OWNER'S RECORDED GO. A dry run against
//    production is still a production connection: it reads the live blob with a
//    production credential. The owner's go is relayed by the orchestrating session and
//    recorded in DATA_AND_SYNC.md §11. Rehearse in the sandbox first.
//
//   node app/scripts/dataop-checklist-location.mjs                 # DRY RUN, sandbox env
//   node app/scripts/dataop-checklist-location.mjs --apply         # write, sandbox env
//
//   Production needs CONFIRM_PROD on EVERY invocation, a dry run included — reading the
//   live blob is itself a production connection, so the guard refuses the prod ref
//   without it (§8.2 rule 3):
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-checklist-location.mjs --prod
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-checklist-location.mjs --prod --apply
//
//   TWO TRANSPORTS, one guard. The service-role pair (SUPABASE_URL +
//   SUPABASE_SERVICE_ROLE_KEY) is used whenever it is present. On a machine whose only
//   production credential is SUPABASE_DB_URL — the Postgres connection string
//   `apply-migration.mjs` already runs on — preload it and the op talks to Postgres
//   directly, on the same plan and under the same guard. A worktree has no app/.env.local
//   of its own, so the relative read below finds nothing and the preloaded environment is
//   the source:
//   CONFIRM_PROD=<prod ref> node --env-file="<checkout>/app/.env.local" app/scripts/dataop-checklist-location.mjs --prod
//   (PowerShell: $env:CONFIRM_PROD='<prod ref>'; node --env-file="…" … --prod)
//
//   ⚠️ PRODUCTION'S RUN IS EXPECTED TO CHANGE NOTHING. Production was read on 2026-09-28:
//   13 customers and ZERO per-cleaner checklist assignments, so no checklist is picked
//   anywhere and every template correctly stays a starter. The op is still the right
//   instrument — it is what makes that a measured fact rather than an assumption, and it is
//   what converts the sandbox (and production later, once cleaners are assigned).
//
// WHAT: for every CHECKLIST template —
//   · picked by NOBODY                      → left alone. It is a starter (client_id null),
//                                             offered under "Start from…".
//   · picked at exactly ONE customer        → stamped with that customer.
//   · picked at SEVERAL                     → the first (in blob order, so the choice is
//                                             deterministic and a re-run agrees) keeps the
//                                             original; every other customer gets its OWN
//                                             copy and has its picks re-pointed at it.
//   · already filed under X, picked at Y    → X is NEVER moved (a checklist that is already
//                                             somebody's stays theirs); Y gets a copy.
// A copy's slug is deterministic (`copySlug`), so a re-run FINDS the copy instead of making
// a second one. Completed checklist records are untouched: they carry their own frozen
// `template_snapshot` and have no FK to the template.
//
// ORDER, and what a failure leaves behind. The table writes (copies, then stamps) happen
// BEFORE the single org_state CAS write, because the re-point needs the copies' ids. If the
// CAS write then loses, nothing is corrupt: the copies exist but nobody points at them yet,
// the stamps are the value they would have been given anyway, and a re-run finds both by
// slug and by value and completes the re-point. The reverse order could not be made safe —
// a pick re-pointed at a row that failed to insert is a dangling checklist.
//
// GUARD CONTRACT (DATA_AND_SYNC.md §8.2). Rules 2 and 3 — which project, may it proceed,
// and say so before the first read — are the SHARED `scripts/_lib/liveGuard.mjs` (CS-025);
// rules 1, 4 and 5 are here, and both halves are re-checked by
// test-dataop-checklist-location.mjs:
//   1. dry run is the DEFAULT; writes need `--apply`;
//   2. the target (Supabase ref, org id) is printed before anything else;
//   3. the sandbox env is the default; production needs `--prod` AND
//      `CONFIRM_PROD=<the prod ref>` in the environment, or the prod ref is refused;
//   4. the rows that will change — the blob AND the template rows — are exported to a
//      gitignored backup before the first write;
//   5. idempotent, and provenance-stamped (`updated_via = 'script:dataop-checklist-location'`).
// CAS: the version predicate rides ON the UPDATE (never check-then-write), exactly as
// `api/_lib/orgState.writeOrgState` does; 0 rows updated = conflict = re-run.
// `protected_fingerprint` is deliberately LEFT ALONE: `crewChecklists` is unprotected, and
// leaving the column stale makes the next browser save take the full protected-field check
// instead of laundering a script write.
//
// The live section below is behind a main-module guard, so importing this file (the offline
// unit suite does) opens nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// A copy's version 1 is decided by the SAME rule the server's templates/copy uses, so a
// converted row and a hand-made copy can never differ.
import { planTemplateCopy, countSchemaItems } from '../src/lib/inspections.js';
// The ONE ceiling every server write enforces — imported, never restated (THE LAW II.3).
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';
// §8.2 rules 2 and 3, shared by every live data-op (CS-025).
import { PROD_REF, ENV_DEFAULT, ENV_PROD, refFromDbUrl, liveTarget, refuseTarget, printTarget, loadEnv } from './_lib/liveGuard.mjs';

export const OP_NAME = 'dataop-checklist-location';
export { PROD_REF, ENV_DEFAULT, ENV_PROD, refFromDbUrl, liveTarget, refuseTarget, printTarget };

// Inspection templates stay company-wide; only checklists are filed under a customer.
export const TEMPLATE_KIND = 'checklist';
// Narrow reads (DEV_PLAYBOOK 3.5.15): the fields a copy needs, never the schema — that
// arrives once, for the handful of templates that actually get copied.
export const TEMPLATE_SELECT = 'id,name,kind,client_id,slug,rating_scale,is_published,published_version_id';
export const VERSION_SELECT = 'id,template_id,version_number,schema,status';
export const PAGE = 1000;

// A copy's slug is a FUNCTION of the source and the customer, never random: it is what makes
// a second run recognise its own work instead of copying again. `slug` is unique in the
// schema, so it is also a hard stop against a duplicate.
export function copySlug(sourceTemplateId, clientId) {
  return `cl-copy-${sourceTemplateId}-${clientId}`;
}

// templateId -> [clientId, …] in BLOB ORDER, each customer once however many of its cleaners
// picked the same checklist. Blob order is what makes "the first customer keeps the
// original" a deterministic choice that a re-run makes the same way.
export function holdersByTemplate(clients) {
  const out = new Map();
  for (const c of clients || []) {
    if (!c || !c.id) continue;
    const seen = new Set();
    for (const templateId of Object.values(c.crewChecklists || {})) {
      if (!templateId || seen.has(templateId)) continue;
      seen.add(templateId);
      const at = out.get(templateId);
      if (at) at.push(c.id); else out.set(templateId, [c.id]);
    }
  }
  return out;
}

const isChecklist = (t) => !!t && t.kind === TEMPLATE_KIND;
const countAssignments = (clients) => (clients || []).reduce((n, c) => n + Object.keys(c?.crewChecklists || {}).length, 0);

// A pick is MISPLACED when it names a checklist that is not filed under that customer —
// including one filed under nobody. Zero of them is the state this op exists to reach, and
// it is what "re-run and see nothing to do" means.
function census(clients, templates) {
  const byId = new Map((templates || []).filter(isChecklist).map((t) => [t.id, t]));
  let misplaced = 0;
  for (const c of clients || []) {
    for (const templateId of new Set(Object.values(c?.crewChecklists || {}))) {
      const t = byId.get(templateId);
      if (t && (t.client_id ?? null) !== c.id) misplaced += 1;
    }
  }
  const checklists = [...byId.values()];
  return {
    checklists: checklists.length,
    starters: checklists.filter((t) => (t.client_id ?? null) === null).length,
    filed: checklists.filter((t) => (t.client_id ?? null) !== null).length,
    misplacedPicks: misplaced,
    assignments: countAssignments(clients),
  };
}

// The whole plan, pure: what to stamp, what to copy, which picks move, and what the census
// looks like before and after. `changed` false means a re-run is a no-op, so `--apply`
// refuses to burn an org_state version.
export function planChecklistLocationOp({ clients = [], templates = [] } = {}) {
  const holders = holdersByTemplate(clients);
  const stamps = [];
  const copies = [];
  const repoints = [];

  for (const t of templates) {
    if (!isChecklist(t)) continue;                 // inspections stay company-wide
    const picked = holders.get(t.id) || [];
    if (!picked.length) continue;                  // nobody picks it — it is a starter
    const owner = t.client_id ?? null;
    // An existing filing is authority: it is never moved. Only an unfiled row is stamped,
    // and it goes to the first customer that picks it.
    const primary = owner || picked[0];
    if (!owner) stamps.push({ templateId: t.id, name: t.name ?? null, clientId: primary });
    for (const clientId of picked) {
      if (clientId === primary) continue;
      const slug = copySlug(t.id, clientId);
      copies.push({ sourceTemplateId: t.id, name: t.name ?? null, clientId, slug });
      const c = clients.find((x) => x && x.id === clientId);
      for (const [userId, templateId] of Object.entries(c?.crewChecklists || {})) {
        if (templateId === t.id) repoints.push({ clientId, userId, fromTemplateId: t.id, toSlug: slug });
      }
    }
  }

  // The census AFTER, projected: stamps applied and the copies present. The copies' ids are
  // not known until they are inserted, so the projection uses their slug as a stand-in —
  // nothing in the census reads an id.
  const stampBy = new Map(stamps.map((s) => [s.templateId, s.clientId]));
  const nextTemplates = [
    ...templates.map((t) => (stampBy.has(t.id) ? { ...t, client_id: stampBy.get(t.id) } : t)),
    ...copies.map((c) => ({ id: c.slug, kind: TEMPLATE_KIND, client_id: c.clientId, name: c.name })),
  ];
  const nextClients = repoints.length
    ? applyRepoints(clients, repoints, new Map(copies.map((c) => [c.slug, c.slug])))
    : clients;

  return {
    before: census(clients, templates),
    after: census(nextClients, nextTemplates),
    stamps,
    copies,
    repoints,
    changed: stamps.length > 0 || copies.length > 0 || repoints.length > 0,
  };
}

// Move each re-pointed pick onto the copy that was made for it. `idBySlug` maps a planned
// copy's slug to the template id it was actually written as. A slug with no id THROWS: a
// pick silently left on the source would be the exact bug this op exists to remove.
export function applyRepoints(clients, repoints, idBySlug) {
  if (!repoints || !repoints.length) return clients || [];
  const byClient = new Map();
  for (const r of repoints) {
    const to = idBySlug.get(r.toSlug);
    if (!to) throw new Error(`no template id for copy slug ${r.toSlug} — refusing to re-point onto nothing`);
    const at = byClient.get(r.clientId) || new Map();
    at.set(r.userId, to);
    byClient.set(r.clientId, at);
  }
  return (clients || []).map((c) => {
    const moves = c && byClient.get(c.id);
    if (!moves) return c;
    const picks = { ...(c.crewChecklists || {}) };
    for (const [userId, templateId] of moves) picks[userId] = templateId;
    return { ...c, crewChecklists: picks };
  });
}

// ── the Postgres transport ───────────────────────────────────────────────────
// The statements the op needs, parameterized, on an injected `pg.Client` — injected so the
// offline suite can drive the whole op on a fake that records `query(text, params)`.
// node-postgres hands `bigint` back as a STRING (PostgREST hands back a number), so
// `version` is normalized here or `version + 1` would concatenate instead of adding.
export function pgTransport(client) {
  return {
    readOrgState: async (org) => {
      const { rows } = await client.query(
        'select state, version from public.org_state where organization_id = $1', [org]);
      return rows[0] ? { state: rows[0].state, version: Number(rows[0].version) } : null;
    },
    countTemplates: async (org) => {
      const { rows } = await client.query(
        'select count(*)::int as n from public.inspection_templates where organization_id = $1 and kind = $2',
        [org, TEMPLATE_KIND]);
      return rows[0]?.n ?? 0;
    },
    // No PostgREST row cap on this transport, so ONE ordered statement is the complete set;
    // the caller proves it against the count rather than trusting it.
    readTemplates: async (org) => {
      const { rows } = await client.query(
        'select id, name, kind, client_id, slug, rating_scale, is_published, published_version_id'
        + ' from public.inspection_templates where organization_id = $1 and kind = $2 order by id',
        [org, TEMPLATE_KIND]);
      return rows;
    },
    readVersions: async (templateIds) => {
      if (!templateIds.length) return [];
      const { rows } = await client.query(
        'select id, template_id, version_number, schema, status from public.inspection_template_versions'
        + ' where template_id = any($1) order by template_id, version_number',
        [templateIds]);
      return rows;
    },
    insertTemplate: async ({ org, slug, name, clientId, ratingScale }) => {
      const { rows } = await client.query(
        'insert into public.inspection_templates'
        + ' (organization_id, slug, name, kind, client_id, rating_scale, is_published, published_version_id, created_by)'
        + ' values ($1, $2, $3, $4, $5, $6, false, null, null) returning id',
        [org, slug, name, TEMPLATE_KIND, clientId, ratingScale]);
      return rows[0]?.id || null;
    },
    insertVersion: async ({ templateId, schema, publish, nowIso }) => {
      const { rows } = await client.query(
        'insert into public.inspection_template_versions (template_id, version_number, schema, status, published_at)'
        + ' values ($1, 1, $2::jsonb, $3, $4) returning id',
        [templateId, schema, publish ? 'published' : 'draft', publish ? nowIso : null]);
      return rows[0]?.id || null;
    },
    // `item_count` rides with the publish, exactly as store.publishTemplate sets it: a copy
    // this op makes must be the same kind of row as one made in the app, or step 6's
    // summary would show it with a blank count for ever.
    publishCopy: async ({ org, templateId, versionId, itemCount }) => {
      const { rows } = await client.query(
        'update public.inspection_templates set is_published = true, published_version_id = $1, item_count = $2, updated_at = now()'
        + ' where id = $3 and organization_id = $4 returning id',
        [versionId, itemCount, templateId, org]);
      return rows;
    },
    // `client_id is null` is the guard, not an optimisation: this statement can only ever
    // FILL an empty customer, never move a checklist out from under one.
    stampClientId: async ({ org, templateId, clientId }) => {
      const { rows } = await client.query(
        'update public.inspection_templates set client_id = $1, updated_at = now()'
        + ' where id = $2 and organization_id = $3 and client_id is null returning id',
        [clientId, templateId, org]);
      return rows;
    },
    casWrite: async ({ org, baseVersion, state }) => {
      const { rows } = await client.query(
        'update public.org_state set state = $1::jsonb, version = version + 1, updated_at = now(),'
        + ' updated_via = $2, updated_by = null, updated_by_build = null, updated_by_tab = $3'
        + ' where organization_id = $4 and version = $5 returning version',
        [state, `script:${OP_NAME}`, `script:${OP_NAME}`, org, baseVersion]);
      return rows;
    },
  };
}

// ── the PostgREST (service-role) transport ───────────────────────────────────
// The SAME statements over supabase-js. Paged where PostgREST caps rows, count-first and
// ordered, exactly as the Postgres transport is. `casRows` exists only so the offline suite
// can drive a CAS miss on a fake that has no version column of its own.
export function supabaseTransport(db, { casRows = null } = {}) {
  return {
    readOrgState: async (org) => {
      const { data, error } = await db.from('org_state').select('state, version')
        .eq('organization_id', org).maybeSingle();
      if (error) throw new Error(`org_state read failed: ${error.message}`);
      return data ? { state: data.state, version: Number(data.version) } : null;
    },
    countTemplates: async (org) => {
      const { count, error } = await db.from('inspection_templates').select('id', { count: 'exact', head: true })
        .eq('organization_id', org).eq('kind', TEMPLATE_KIND);
      if (error) throw new Error(`templates count failed: ${error.message}`);
      return count || 0;
    },
    // Each page's whole chain is written out at the call site — `.order()` before
    // `.range()`, on the primary key — so `lint:paging` can see the ordering it exists to
    // enforce. Tucked inside a helper the sweep cannot read the chain, and an unordered
    // OFFSET walk silently skips or repeats rows across page boundaries.
    readTemplates: async (org) => {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db.from('inspection_templates').select(TEMPLATE_SELECT)
          .eq('organization_id', org).eq('kind', TEMPLATE_KIND)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`templates page @${from} failed: ${error.message}`);
        rows.push(...(data || []));
        if ((data || []).length < PAGE) return rows;
      }
    },
    readVersions: async (templateIds) => {
      if (!templateIds.length) return [];
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db.from('inspection_template_versions').select(VERSION_SELECT)
          .in('template_id', templateIds)
          .order('template_id', { ascending: true }).order('version_number', { ascending: true }).order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`versions page @${from} failed: ${error.message}`);
        rows.push(...(data || []));
        if ((data || []).length < PAGE) return rows;
      }
    },
    insertTemplate: async ({ org, slug, name, clientId, ratingScale }) => {
      const { data, error } = await db.from('inspection_templates').insert({
        organization_id: org, slug, name, kind: TEMPLATE_KIND, client_id: clientId,
        rating_scale: ratingScale, is_published: false, published_version_id: null, created_by: null,
      }).select('id').single();
      if (error) throw new Error(error.message);
      return data?.id || null;
    },
    insertVersion: async ({ templateId, schema, publish, nowIso }) => {
      const { data, error } = await db.from('inspection_template_versions').insert({
        template_id: templateId, version_number: 1, schema,
        status: publish ? 'published' : 'draft', published_at: publish ? nowIso : null,
      }).select('id').single();
      if (error) throw new Error(error.message);
      return data?.id || null;
    },
    publishCopy: async ({ org, templateId, versionId, itemCount, nowIso }) => {
      const { data, error } = await db.from('inspection_templates')
        .update({ is_published: true, published_version_id: versionId, item_count: itemCount, updated_at: nowIso })
        .eq('id', templateId).eq('organization_id', org).select('id');
      if (error) throw new Error(error.message);
      return data || [];
    },
    stampClientId: async ({ org, templateId, clientId, nowIso }) => {
      const { data, error } = await db.from('inspection_templates')
        .update({ client_id: clientId, updated_at: nowIso })
        .eq('id', templateId).eq('organization_id', org).is('client_id', null).select('id');
      if (error) throw new Error(error.message);
      return data || [];
    },
    casWrite: async ({ org, baseVersion, state, nowIso }) => {
      const { data, error } = await db.from('org_state').update({
        state,
        version: (baseVersion || 0) + 1,
        updated_at: nowIso,
        updated_via: `script:${OP_NAME}`,
        updated_by: null,
        updated_by_build: null,
        updated_by_tab: `script:${OP_NAME}`,
      }).eq('organization_id', org).eq('version', baseVersion).select('version');
      if (error) throw new Error(error.message);
      return casRows ? casRows() : (data || []);
    },
  };
}

// ── the op ───────────────────────────────────────────────────────────────────
// Everything after the target is printed, on whichever transport was chosen. Returns the
// exit code rather than ending the process itself: after network I/O, exiting outright
// takes node down on Windows with a libuv assertion. `process.exitCode` only.
export async function runChecklistLocationOp({
  t, org, apply = false, now = new Date(), backupDir = new URL('./', import.meta.url),
  log = console.log, err = console.error,
} = {}) {
  let snap, count, templates;
  try {
    snap = await t.readOrgState(org);
    if (!snap?.state) { err('org_state not initialized for this org.'); return 1; }
    count = await t.countTemplates(org);            // count-first (THE LAW II.7 fetch strategy)
    templates = await t.readTemplates(org);
  } catch (e) { err(e.message); return 1; }

  // A read that does not match its own count is an incomplete read, and a plan computed from
  // one would file the wrong checklists. Refuse; the table moved, so re-run.
  if (templates.length !== count) {
    err(`templates read is incomplete: ${templates.length} row(s) for a count of ${count}. Nothing written; re-run.`);
    return 1;
  }

  const state = snap.state;
  const clients = state.clients || [];
  const plan = planChecklistLocationOp({ clients, templates });

  log(`  org_state    : v${snap.version}, ${clients.length} customers`);
  log(`  templates    : ${templates.length} ${TEMPLATE_KIND} rows (count said ${count})`);
  const lines = (label, c) => {
    log(`  ${label}  checklist templates                : ${c.checklists}`);
    log(`          filed under a customer             : ${c.filed}`);
    log(`          starters (filed under nobody)      : ${c.starters}`);
    log(`          picks on someone else's checklist  : ${c.misplacedPicks}`);
    log(`          per-cleaner assignments            : ${c.assignments}`);
  };
  log('');
  lines('BEFORE', plan.before);
  lines('AFTER ', plan.after);
  log(`          (${plan.stamps.length} stamped, ${plan.copies.length} copied, ${plan.repoints.length} pick(s) re-pointed)\n`);
  const nameOf = (id) => clients.find((c) => c.id === id)?.name || id;
  for (const s of plan.stamps) log(`   · stamp  ${s.name || s.templateId}  → ${nameOf(s.clientId)}`);
  for (const c of plan.copies) log(`   · copy   ${c.name || c.sourceTemplateId}  → ${nameOf(c.clientId)}  (slug ${c.slug})`);
  for (const r of plan.repoints) log(`   · point  ${nameOf(r.clientId)} / ${r.userId}  ${r.fromTemplateId} → ${r.toSlug}`);

  if (!plan.changed) {
    log('\n✓ Every checklist is already filed under the customer that uses it. No-op.\n');
    return 0;
  }
  if (!apply) {
    log('\n--dry-run (the default): nothing written. Re-run with --apply to arm.\n');
    return 0;
  }

  // The blob the re-point would produce, checked against the ceiling BEFORE anything is
  // written — a run that would be refused at the last step must not leave copies behind.
  const bytesGuess = Buffer.byteLength(JSON.stringify({ ...state, clients: applyRepoints(clients, plan.repoints, new Map(plan.copies.map((c) => [c.slug, c.slug]))) }), 'utf8');
  if (bytesGuess > MAX_STATE_BYTES) {
    err(`Refusing: the result is ${Math.round(bytesGuess / 1024)} KB, over the ${Math.round(MAX_STATE_BYTES / 1024)} KB ceiling.`);
    return 1;
  }

  // (4) backup first — the blob AND the template rows, because this op rewrites both.
  const nowIso = now.toISOString();
  const backupName = `orgstate-backup-${nowIso.replace(/[:.]/g, '-')}.json`;
  writeFileSync(new URL(`./${backupName}`, backupDir), JSON.stringify({ version: snap.version, state, templates }));
  JSON.parse(readFileSync(new URL(`./${backupName}`, backupDir), 'utf8')); // it parses

  // The copies. A previous run that made them and then lost the CAS write left them behind
  // on their deterministic slug: find them rather than insert a second set.
  const bySlug = new Map(templates.map((x) => [x.slug, x]));
  const byId = new Map(templates.map((x) => [x.id, x]));
  const idBySlug = new Map();
  // The schemas are read ONLY for the sources whose copy still has to be made: a re-run
  // that finds every copy already there reads no schema at all.
  const sources = [...new Set(plan.copies.filter((c) => !bySlug.has(c.slug)).map((c) => c.sourceTemplateId))];
  let versions = [];
  try {
    versions = sources.length ? await t.readVersions(sources) : [];
  } catch (e) { err(`versions read failed: ${e.message}`); return 1; }

  try {
    for (const copy of plan.copies) {
      const already = bySlug.get(copy.slug);
      if (already) { idBySlug.set(copy.slug, already.id); log(`   · copy exists already: ${copy.slug} → ${already.id}`); continue; }
      const src = byId.get(copy.sourceTemplateId);
      const mine = versions.filter((v) => v.template_id === copy.sourceTemplateId);
      const published = mine.find((v) => v.id === src?.published_version_id) || null;
      const latest = mine.slice().sort((a, b) => (a.version_number || 0) - (b.version_number || 0)).pop() || null;
      // The SAME rule the server's templates/copy applies, so a converted row and a
      // hand-made copy are the same kind of thing.
      const { schema, publish } = planTemplateCopy({
        kind: TEMPLATE_KIND,
        publishedSchema: published?.schema ?? null,
        latestSchema: published ? null : latest?.schema ?? null,
        sourcePublished: !!(src?.is_published && published),
      });
      const templateId = await t.insertTemplate({
        org, slug: copy.slug, name: copy.name, clientId: copy.clientId,
        ratingScale: src?.rating_scale || { type: 'passfail', passThreshold: 100 },
      });
      if (!templateId) throw new Error(`the copy for ${copy.clientId} returned no id`);
      const versionId = await t.insertVersion({ templateId, schema, publish, nowIso });
      if (publish) {
        // An affected-row count is the ONLY proof a guarded UPDATE did anything
        // (DEV_PLAYBOOK 3.5.2). Discarded, a publish that matched nothing would leave a
        // copy that says "draft" while the op reports it filed.
        const rows = await t.publishCopy({ org, templateId, versionId, itemCount: countSchemaItems(schema), nowIso });
        if (!rows || !rows.length) throw new Error(`publishing the copy ${copy.slug} updated 0 rows — it is not in this org, or it vanished mid-run`);
      }
      idBySlug.set(copy.slug, templateId);
    }
    for (const s of plan.stamps) {
      // The stamp is guarded by `client_id is null`, so 0 rows means somebody filed this
      // checklist between the read and the write: the plan is stale and the blob must not
      // be re-pointed against it.
      const rows = await t.stampClientId({ org, templateId: s.templateId, clientId: s.clientId, nowIso });
      if (!rows || !rows.length) {
        throw new Error(`stamping client_id on ${s.templateId} updated 0 rows — it was filed under a customer while this ran. Nothing more written; re-run.`);
      }
    }
  } catch (e) { err(`Write failed: ${e.message}`); return 1; }

  if (!plan.repoints.length) {
    log(`\n✓ Filed ${plan.stamps.length} checklist(s) and made ${plan.copies.length} copy(ies). No pick had to move, so org_state is untouched.\n`);
    log(`  Backup: app/scripts/${backupName}\n`);
    return 0;
  }

  // (5) ONE CAS write: the version predicate rides ON the update.
  const nextState = { ...state, clients: applyRepoints(clients, plan.repoints, idBySlug) };
  let wrote;
  try {
    wrote = await t.casWrite({ org, baseVersion: snap.version, state: nextState, nowIso });
  } catch (e) { err('Write failed: ' + e.message); return 1; }
  if (!wrote || !wrote.length) {
    err('CAS conflict — org_state changed under me. The copies and stamps are already in place');
    err('and are found by slug on a re-run, so nothing is corrupt. Re-run to finish the re-point.');
    return 1;
  }

  log(`\n✓ Filed ${plan.stamps.length} checklist(s), made ${plan.copies.length} copy(ies), re-pointed ${plan.repoints.length} pick(s). org_state v${snap.version} → ${snap.version + 1}.`);
  log(`  Backup: app/scripts/${backupName}`);
  log('  Verify: re-run without --apply — it must report 0 stamped, 0 copied, 0 re-pointed,');
  log('  and "picks on someone else\'s checklist: 0". Then INV-13/INV-15.\n');
  return 0;
}

// ── live section ─────────────────────────────────────────────────────────────
const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const APPLY = process.argv.includes('--apply');
  const PROD = process.argv.includes('--prod');

  // (3) env: the sandbox unless production is asked for explicitly. A run started with
  // `node --env-file=<checkout>/app/.env.local …` already carries the credential, and this
  // relative read simply finds nothing — a worktree has no env file of its own.
  const envFile = PROD ? ENV_PROD : ENV_DEFAULT;
  const loaded = loadEnv(envFile, import.meta.url);

  const { transport, ref } = liveTarget(process.env);
  const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
  const refusal = transport && refuseTarget({ transport, ref, prod: PROD, confirmProd: process.env.CONFIRM_PROD });

  if (!transport) {
    console.error(`Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_DB_URL (looked in app/${envFile.replace('../', '')}${loaded ? '' : ' — file not found'}).`);
    console.error(PROD ? '' : 'Sandbox is the default. Pass --prod for production (see the guard contract).');
    process.exitCode = 1;
  } else if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
  } else {
    // (2) §8.2 rule 2: name the target BEFORE the first read, so a failed read still says
    // which project and org the run was pointed at.
    printTarget({
      op: OP_NAME, ref: ref || '(unknown)', org: ORG, transport, apply: APPLY,
      envLabel: loaded ? `app/${envFile.replace('../', '')}` : 'the preloaded environment',
    });

    if (transport === 'pg') {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
      try {
        // ONCE. Supabase bans an address after a few failed password attempts, so a connect
        // that fails is reported, never retried.
        await client.connect();
        process.exitCode = await runChecklistLocationOp({ t: pgTransport(client), org: ORG, apply: APPLY });
      } catch (e) {
        console.error('connect failed:', e.message);
        process.exitCode = 1;
      } finally { await client.end().catch(() => {}); }
    } else {
      const { createClient } = await import('@supabase/supabase-js');
      const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      process.exitCode = await runChecklistLocationOp({ t: supabaseTransport(db), org: ORG, apply: APPLY });
    }
  }
}
