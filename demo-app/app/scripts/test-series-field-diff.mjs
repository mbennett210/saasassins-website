// A "this & all future" series edit must carry EVERY field the user changed — and
// nothing else.
//
// ══ THE DEFECT ════════════════════════════════════════════════════════════════
// Reported by the client as "edited jobs are not making changes downstream", and
// reproduced against the demo build on 2026-07-20.
//
// JobDetail's series branch built its uniform patch as a fixed literal:
//
//   const shared = { notes, serviceId, siteId: currentForm.siteId || null, tagIds };
//
// Two defects in one line.
//
//   1. clientId WAS NOT IN IT. The Company select is editable in "this & all future"
//      scope — unlike Date, which the form hides for that scope — so an admin could
//      change the account, get "Updated all future jobs in series", and see NO
//      occurrence move. Not even the one on screen: the future branch dispatches only
//      UPDATE_JOB_SERIES, never UPDATE_JOB, so there is no single-occurrence write to
//      fall back on. Picking "Just this one" changed it correctly — i.e. the scope that
//      MEANS "apply this downstream" was the only scope that discarded the edit.
//
//   2. THE PATCH WAS UNDIFFED. UPDATE_JOB_SERIES spreads the uniform patch onto every
//      eligible occurrence, so a field the user never touched flattens that field
//      across the whole series. crewIds was hardened against exactly this
//      (test-series-crew-flatten.mjs); notes/serviceId/siteId/tagIds never were.
//
// The two compounded into data loss. The Company onChange resets `siteId: ''` so the
// site picker can repopulate — and siteId WAS in the patch. So changing the account
// wiped st_… → null on every future occurrence, while the account itself did not move.
// Observed: 4/4 occurrences kept clientId cl_seed_olympic and lost their siteId.
//
// The fix diffs every field against a baseline snapshotted when the edit STARTS.
// It must be the edit-time snapshot, not `initial`: `initial` is a useMemo over the
// LIVE job, so a concurrent change from another tab moves it underneath an open draft
// and every untouched field would then read as an edit — re-arming defect 2 through a
// different door. NewJobModal has diffed all of these since the crew-flatten fix; this
// was the entry point never brought in line.
//
//   node scripts/test-series-field-diff.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const src = read('../src/pages/JobDetail.jsx');

// ── 🔴 the series patch is built by diffing, not as a literal ───────────
{
  ok('🔴 the fixed `shared` literal that dropped clientId is gone',
    !/const shared = \{ notes: currentForm\.notes, serviceId: currentForm\.serviceId/.test(src));
  ok('  ...replaced by an accumulating object', /const shared = \{\};/.test(src));

  // Every field the "all future" form can actually change must be diffed IN.
  for (const [field, re] of [
    ['clientId', /if \(currentForm\.clientId !== base\.clientId\) shared\.clientId = currentForm\.clientId;/],
    ['siteId', /if \(\(currentForm\.siteId \|\| null\) !== \(base\.siteId \|\| null\)\) shared\.siteId = currentForm\.siteId \|\| null;/],
    ['serviceId', /if \(currentForm\.serviceId !== base\.serviceId\) shared\.serviceId = currentForm\.serviceId;/],
    ['notes', /if \(\(currentForm\.notes \|\| ''\) !== \(base\.notes \|\| ''\)\) shared\.notes = currentForm\.notes;/],
    ['tagIds', /if \(!sameIds\(currentForm\.tagIds, base\.tagIds\)\) shared\.tagIds = currentForm\.tagIds;/],
  ]) {
    ok(`🔴 ${field} rides the series patch ONLY when the user changed it`, re.test(src));
  }
}

// ── 🔴 the baseline is the edit-time snapshot, not the live record ──────
{
  ok('🔴 an editBaseline snapshot exists', /const \[editBaseline, setEditBaseline\] = useState\(null\);/.test(src));
  // Guards the three calls IN ORDER at the start of beginEdit; trailing statements
  // (e.g. re-arming the save-time unassigned guard) are allowed after them.
  ok('  ...taken when the edit STARTS, re-seeding the draft at the same moment',
    /const beginEdit = \(\) => \{ setForm\(initial\); setEditBaseline\(initial\); setEditing\(true\);[^}]*\};/.test(src));
  ok('  ...and the diff reads it', /const base = editBaseline \|\| initial;/.test(src));

  // BOTH entry points into edit mode must go through it, or one of them leaves a
  // stale mount-time draft and diffs against the wrong thing.
  ok('  ...both edit entry points call beginEdit()', (src.match(/beginEdit\(\);/g) || []).length === 2);
  ok('  ...and no raw setEditing(true) survives outside it',
    (src.match(/setEditing\(true\)/g) || []).length === 1);
}

// ── the Date field stays hidden for the series scope ────────────────────
// A uniform patch carrying startAt would collapse the whole series onto one instant;
// the reducer strips it, so an editable Date here would be a silent no-op of exactly
// the kind this suite exists to prevent. Day moves ride dayShift instead.
{
  ok('Date is still hidden in "all future" scope',
    /\{editScope !== 'future' && \(\s*<FormField label="Date"/.test(src));
  ok('  ...and startAt/endAt still never ride the series patch',
    !/shared\.startAt/.test(src) && !/shared\.endAt/.test(src));
}

// ── simulate the flatten + the drop, before and after ───────────────────
{
  // Three occurrences of one series, deliberately NOT uniform: occ 2 has its own site
  // and note. A real multi-site account looks like this.
  const series = () => ([
    { id: 'a', clientId: 'cl_old', siteId: 'st_1', serviceId: 'svc_x', notes: '' },
    { id: 'b', clientId: 'cl_old', siteId: 'st_2', serviceId: 'svc_x', notes: 'gate code changed' },
    { id: 'c', clientId: 'cl_old', siteId: 'st_1', serviceId: 'svc_x', notes: '' },
  ]);
  const apply = (patch) => series().map((j) => ({ ...j, ...patch }));

  // The user opened occurrence 'a' and changed ONLY the company. The Company onChange
  // resets siteId to '' — that is real form behaviour, not a test contrivance.
  const baseline = { clientId: 'cl_old', siteId: 'st_1', serviceId: 'svc_x', notes: '' };
  const formAfterCompanyChange = { clientId: 'cl_new', siteId: '', serviceId: 'svc_x', notes: '' };

  // OLD: fixed literal — clientId absent, everything else unconditional.
  const oldShared = {
    notes: formAfterCompanyChange.notes,
    serviceId: formAfterCompanyChange.serviceId,
    siteId: formAfterCompanyChange.siteId || null,
    tagIds: [],
  };
  const before = apply(oldShared);
  ok('THE OLD SHAPE left every occurrence on the OLD account',
    before.every((j) => j.clientId === 'cl_old'));
  ok('THE OLD SHAPE wiped the site off every occurrence',
    before.every((j) => j.siteId === null));
  ok('THE OLD SHAPE also clobbered a per-occurrence note',
    before[1].notes === '');

  // NEW: diffed against the edit-time baseline.
  const sameIds = (a, b) => [...(a || [])].sort().join(',') === [...(b || [])].sort().join(',');
  const buildShared = (form, base) => {
    const s = {};
    if (form.clientId !== base.clientId) s.clientId = form.clientId;
    if ((form.siteId || null) !== (base.siteId || null)) s.siteId = form.siteId || null;
    if (form.serviceId !== base.serviceId) s.serviceId = form.serviceId;
    if ((form.notes || '') !== (base.notes || '')) s.notes = form.notes;
    if (!sameIds(form.tagIds, base.tagIds)) s.tagIds = form.tagIds;
    return s;
  };

  const after = apply(buildShared(formAfterCompanyChange, baseline));
  ok('🔴 the company change now reaches every occurrence',
    after.every((j) => j.clientId === 'cl_new'));
  ok('  ...the site reset rides along, because the user really did clear it',
    after.every((j) => j.siteId === null));
  ok('  ...but the untouched per-occurrence note survives',
    after[1].notes === 'gate code changed');

  // A notes-only edit must not touch site/service/client at all.
  const notesOnly = buildShared({ ...baseline, notes: 'call ahead' }, baseline);
  ok('🔴 a notes-only edit sends ONLY notes', JSON.stringify(notesOnly) === '{"notes":"call ahead"}');
  const afterNotes = apply(notesOnly);
  ok('  ...so each occurrence keeps its own site',
    afterNotes[0].siteId === 'st_1' && afterNotes[1].siteId === 'st_2');

  // A no-op save must be a genuine no-op — an empty patch the reducer tolerates.
  ok('an untouched save produces an EMPTY patch',
    JSON.stringify(buildShared(baseline, baseline)) === '{}');
}

console.log(`\nseries field diff: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
