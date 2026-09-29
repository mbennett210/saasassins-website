// Re-proves the hard checklist/inspection-template DELETE feature against today's law.
// NEW surface (removeTemplateFromClients / store.deleteTemplate / SCRUB_CHECKLIST_TEMPLATE)
// → this suite fails pre-fix and passes on the feature branch.
//
//   node scripts/test-qc-template-delete.mjs
//
//  (b) DATA HANDLING (playbook II.8): store.deleteTemplate is ORG-SCOPED (a stray/cross-org
//      id can't be deleted), IDEMPOTENT (a second delete is a safe no-op — "deleted twice"),
//      and FAILS SAFELY on a DB error (throws, no partial state). Completed inspection_records
//      / checklist_results carry a denormalized template_snapshot and have NO FK to the
//      template, so history keeps rendering after the delete. saveTemplate/publishTemplate use
//      no row-version/CAS predicate (last-write-wins by id), so there is no CAS pattern to
//      match; the delete is a plain org-scoped idempotent DELETE. Driven through the REAL store
//      against fake-supabase (no network, no credentials — BUILD_INTEGRITY §6b).
//  (c) ORG-STATE GUARD: the follow-up org_state save the scrub produces (clients[].crewChecklists
//      only, since R3 retired the location-wide default) clears orgStateGuard for EVERY role that holds qc.templates.edit
//      by default (owner/admin/manager), and for crew too, and does NOT move protectedFingerprint
//      — so the guard's expensive field-authorization read never even fires for it.
//  (d) OFFLINE REPLAY (playbook II.7): re-dispatching SCRUB_CHECKLIST_TEMPLATE is idempotent.
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { installResolveShim, loadStore } from './deletion-core.mjs';
import { removeTemplateFromClients } from '../src/lib/crewChecklist.js';
import { seedPermissions } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000042';
// Set BEFORE anything under api/ loads (constants.js / orgState.js read env at import). The
// URL is a closed local port and fetch is stubbed, so nothing here can reach a network.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();
installResolveShim();

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass += 1; } else { fail += 1; console.error(`FAIL ${name}`); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass += 1; } else { fail += 1; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

// ── (b) store.deleteTemplate — the REAL store against fake-supabase ────────────
const { deleteTemplate } = await import('../api/_lib/qc/store.js');

const SNAP = { name: 'Move-out closeout', kind: 'checklist', schema: { areas: [{ id: 'a1', items: [] }] } };
resetWorld({ tables: {
  inspection_templates: [
    { id: 'it_del', organization_id: ORG, name: 'Move-out closeout', kind: 'checklist' },
    { id: 'it_keep', organization_id: ORG, name: 'Nightly', kind: 'inspection' },
    { id: 'it_other', organization_id: 'org_other', name: 'Another org template', kind: 'checklist' },
  ],
  inspection_template_versions: [
    { id: 'v_del', template_id: 'it_del', version_number: 1, status: 'published' },
  ],
  inspection_records: [
    { id: 'ir1', organization_id: ORG, template_id: 'it_del', template_snapshot: SNAP, result: 'pass', status: 'submitted' },
  ],
  checklist_results: [
    { id: 'cr1', organization_id: ORG, template_id: 'it_del', template_snapshot: { name: 'Move-out closeout' }, completed_count: 5, total_count: 5 },
  ],
} });

const r1 = await deleteTemplate('it_del');
eq('deleteTemplate returns { ok: true }', r1, { ok: true });
ok('the deleted template row is gone', !world.tables.inspection_templates.some((t) => t.id === 'it_del'));
ok('the sibling template it_keep is untouched', world.tables.inspection_templates.some((t) => t.id === 'it_keep'));

// org-scoped: the DELETE filtered on BOTH id AND organization_id === this org
const delLog = world.log.filter((q) => q.table === 'inspection_templates' && q.op === 'delete').pop();
eq('delete is org-scoped (id + organization_id predicate)',
  { id: delLog?.eq?.id, organization_id: delLog?.eq?.organization_id }, { id: 'it_del', organization_id: ORG });

// history survives: completed records + their frozen snapshot are untouched (no FK)
const rec = world.tables.inspection_records.find((x) => x.id === 'ir1');
ok('the completed inspection record survives the template delete (no FK)', !!rec);
eq('the inspection keeps its frozen template_snapshot', rec?.template_snapshot, SNAP);
ok('the completed checklist record survives with its snapshot',
  world.tables.checklist_results.some((c) => c.id === 'cr1' && c.template_snapshot?.name === 'Move-out closeout'));

// no cross-org delete: deleting another org's template id through this route removes nothing
const beforeLen = world.tables.inspection_templates.length;
const rOther = await deleteTemplate('it_other');
eq('a cross-org delete returns ok but removes nothing', rOther, { ok: true });
ok('a template in ANOTHER org is not deleted (org-scoped)', world.tables.inspection_templates.some((t) => t.id === 'it_other'));
eq('no other-org row was removed', world.tables.inspection_templates.length, beforeLen);

// idempotent: a second delete of the already-deleted template is safe ("deleted twice")
const r2 = await deleteTemplate('it_del');
eq('deleting an already-deleted template is an idempotent no-op', r2, { ok: true });

// fails safely on a DB error: throws, and the row is left intact (no partial state)
world.failWhen = (q) => q.table === 'inspection_templates' && q.op === 'delete';
let threw = false;
try { await deleteTemplate('it_keep'); } catch { threw = true; }
world.failWhen = null;
ok('a DB error makes deleteTemplate throw (fails safely)', threw);
ok('the failed delete left it_keep intact', world.tables.inspection_templates.some((t) => t.id === 'it_keep'));

// ── (c) org-state guard passes the follow-up scrub for every role that may delete ──
const { protectedFieldViolations, protectedFingerprint } = await import('../api/_lib/orgStateGuard.js');

const prev = {
  version: 1,
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', email: 'o@x.test' },
    { id: 'u_admin', role: 'admin', status: 'active', email: 'a@x.test' },
    { id: 'u_mgr', role: 'manager', status: 'active', email: 'm@x.test' },
    { id: 'u_crew', role: 'crew', status: 'active', email: 'c@x.test' },
  ],
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  sites: [],
  clients: [
    { id: 'c1', name: 'Coral Bay', crewChecklists: { u_crew: 'it_del', u_x: 'it_keep' }, standingCrewIds: ['u_crew'] },
    { id: 'c2', name: 'Harbor', crewChecklists: { u_y: 'it_keep' } },
  ],
  company: { timezone: 'America/New_York' },
  timeOff: [], payrollLines: [], reimbursements: [], opsSettings: {},
};
const next = { ...prev, clients: removeTemplateFromClients(prev.clients, 'it_del') };

// the scrub did what it should (so the guard assertions below aren't vacuous)
eq('scrub dropped only the per-cleaner entry for the deleted template', next.clients[0].crewChecklists, { u_x: 'it_keep' });
eq('scrub left standingCrewIds untouched', next.clients[0].standingCrewIds, ['u_crew']);

const selfOf = { owner: 'u_owner', admin: 'u_admin', manager: 'u_mgr', crew: 'u_crew' };
for (const role of ['owner', 'admin', 'manager', 'crew']) {
  eq(`guard allows the template-scrub save for ${role} (no violations)`,
    protectedFieldViolations(prev, next, role, selfOf[role]), []);
}
ok('the scrub does not move protectedFingerprint (guard deep read never fires)',
  protectedFingerprint(prev) === protectedFingerprint(next));

// ── (d) SCRUB_CHECKLIST_TEMPLATE is an idempotent offline replay ──────────────
const store = await loadStore();
const base = { clients: [
  { id: 'c1', crewChecklists: { u_a: 'it_del', u_b: 'it_keep' } },
  { id: 'c2', crewChecklists: { u_c: 'it_keep' } },
] };
const s1 = store.reducer(base, { type: store.ACTIONS.SCRUB_CHECKLIST_TEMPLATE, templateId: 'it_del' });
ok('first replay scrubs the deleted template', JSON.stringify(s1.clients[0].crewChecklists) === JSON.stringify({ u_b: 'it_keep' }));
const s2 = store.reducer(s1, { type: store.ACTIONS.SCRUB_CHECKLIST_TEMPLATE, templateId: 'it_del' });
eq('re-dispatching the scrub is an idempotent no-op', JSON.stringify(s2.clients), JSON.stringify(s1.clients));

console.log(`\nqc-template-delete: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
