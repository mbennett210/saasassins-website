// The checklist TEMPLATE layer that the per-cleaner reminders now depend on.
//
// F1 — the template list must be COMPLETE. The reminder walker skips a cleaner whose
// checklist is not in the live-id set (CS-353), so a truncated template read is not a
// slow list: every cleaner bound to an older checklist reads as "deleted" and is never
// reminded again. PostgREST caps EVERY response at db-max-rows (1000 on Supabase)
// whatever `.limit()`/`.range()` asked for, and step 5 plans ~3,750 checklist rows.
// Driven against scripts/fake-postgrest.mjs, which caps like the real thing.
//
// F6 — a CHECKLIST with ZERO items can never be complete (the completion rule is
// `total_count > 0 && completed_count >= total_count`), so its holders would be nudged and
// escalated on every clean for ever, and step 4's clock-out block would lock them out with
// nothing to tick. Publishing one is refused at the server AND in the demo stub, from ONE
// shared rule (lib/inspections.publishRefusal) so the two cannot drift.
//
//   node app/scripts/test-checklist-template-reads.mjs
import { fakeDb } from './fake-postgrest.mjs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const { listTemplates, listTemplateIds, publishTemplate } = await import('../api/_lib/qc/store.js');
const { publishRefusal, countSchemaItems, NO_ITEMS_MESSAGE } = await import('../src/lib/inspections.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };

// ── F1: a complete, ordered template read past db-max-rows ────────────────────
{
  const N = 2500;                 // step 5's ~3,750 checklist rows are the same class
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const rows = [];
  for (let i = 0; i < N; i += 1) {
    rows.push({
      id: `it_c_${String(i).padStart(5, '0')}`, organization_id: ORG, kind: 'checklist',
      name: `Checklist ${i}`, updated_at: new Date(base + i * 60000).toISOString(),
    });
  }
  // Noise the read must exclude: inspection-kind rows, and another org's checklists.
  for (let i = 0; i < 40; i += 1) {
    rows.push({ id: `it_i_${i}`, organization_id: ORG, kind: 'inspection', name: `Inspection ${i}`, updated_at: new Date(base).toISOString() });
    rows.push({ id: `it_x_${i}`, organization_id: 'org_other', kind: 'checklist', name: `Other org ${i}`, updated_at: new Date(base).toISOString() });
  }
  const db = fakeDb({ inspection_templates: rows }, { maxRows: 1000 });

  const all = await listTemplates({ kind: 'checklist' }, {}, db);
  ok(all.length === N, `F1: every checklist template comes back past max-rows 1000 (got ${all.length} of ${N})`);
  ok(new Set(all.map((t) => t.id)).size === all.length, 'F1b: no row is repeated across page boundaries');
  ok(all.every((t) => t.kind === 'checklist'), 'F1c: the kind filter runs in the query — no inspection rows');
  ok(all.every((t) => t.organization_id === ORG), 'F1d: the read stays inside the org');
  const sorted = all.every((t, i) => i === 0 || all[i - 1].updated_at > t.updated_at
    || (all[i - 1].updated_at === t.updated_at && all[i - 1].id > t.id));
  ok(sorted, 'F1e: newest-first with an id tiebreaker, so page membership is deterministic');

  const unfiltered = await listTemplates({}, {}, db);
  ok(unfiltered.length === N + 40, `F1f: with no kind the read is still complete (got ${unfiltered.length} of ${N + 40})`);

  const ids = await listTemplateIds({ kind: 'checklist' }, db);
  ok(ids.length === N && ids.every((v) => typeof v === 'string'), `F1g: the cron's narrow ids-only read is complete too (got ${ids.length} of ${N})`);
  ok(new Set(ids).size === N, 'F1h: …and carries every id exactly once');
}

// ── F6: the publish rule, shared by the server, the stub and the editor ────────
{
  const empty = { areas: [{ id: 'a1', label: 'Area', items: [] }] };
  const none = { areas: [] };
  const one = { areas: [{ id: 'a1', label: 'Area', items: [{ id: 'i1', label: 'Sweep' }] }] };
  ok(countSchemaItems(one) === 1 && countSchemaItems(empty) === 0 && countSchemaItems(none) === 0 && countSchemaItems(null) === 0,
    'F6: countSchemaItems counts items across areas, and 0 for an empty/absent schema');
  ok(publishRefusal({ kind: 'checklist', schema: empty }) === NO_ITEMS_MESSAGE,
    'F6a: a checklist with an area but no items is refused');
  ok(publishRefusal({ kind: 'checklist', schema: none }) === NO_ITEMS_MESSAGE, 'F6b: a checklist with no areas at all is refused');
  ok(publishRefusal({ kind: 'checklist', schema: one }) === null, 'F6c: a checklist with one item publishes');
  ok(publishRefusal({ kind: 'inspection', schema: empty }) === null, 'F6d: an inspection template is left alone');
  ok(publishRefusal() === null, 'F6e: called with nothing it never refuses (it is a guard, not a gate)');

  // The server, through the REAL store against fake-supabase.
  resetWorld({ tables: {
    inspection_templates: [
      { id: 'it_empty', organization_id: ORG, kind: 'checklist', name: 'Blank list', is_published: false, published_version_id: null },
      { id: 'it_ok', organization_id: ORG, kind: 'checklist', name: 'Floor care', is_published: false, published_version_id: null },
      { id: 'it_insp', organization_id: ORG, kind: 'inspection', name: 'Walk', is_published: false, published_version_id: null },
    ],
    inspection_template_versions: [
      { id: 'v_empty', template_id: 'it_empty', version_number: 1, status: 'draft', schema: empty },
      { id: 'v_ok', template_id: 'it_ok', version_number: 1, status: 'draft', schema: one },
      { id: 'v_insp', template_id: 'it_insp', version_number: 1, status: 'draft', schema: empty },
    ],
  } });

  const refused = await publishTemplate('it_empty');
  ok(refused && refused.refused === NO_ITEMS_MESSAGE, `F6f: the server refuses to publish an item-less checklist (got ${JSON.stringify(refused)})`);
  ok(world.tables.inspection_template_versions.find((v) => v.id === 'v_empty')?.status === 'draft',
    'F6g: …and nothing is written — the version stays a draft');
  ok(world.tables.inspection_templates.find((t) => t.id === 'it_empty')?.is_published === false,
    'F6h: …and the template stays unpublished');

  const published = await publishTemplate('it_ok');
  ok(published && !published.refused && published.template?.is_published === true,
    'F6i: a checklist with an item still publishes');
  const insp = await publishTemplate('it_insp');
  ok(insp && !insp.refused && insp.template?.is_published === true,
    'F6j: an item-less INSPECTION template still publishes (the guard is checklist-only)');
}

console.log(`\nchecklist-template-reads: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
