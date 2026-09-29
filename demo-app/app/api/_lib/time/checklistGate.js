// The SERVER half of the clock-out block (R4-R6 of docs/plans/2026-09-27-checklists-by-
// location.md). The crew button (components/ClockControl) is the courtesy; this is the
// boundary — an old bundle, a cached tab or a direct API call must not be able to clock a
// cleaner out of a clean whose checklist they have not finished.
//
// ONE RULE, BOTH SIDES. The verdict comes from the same pure `clockOutGate`
// (src/lib/crewChecklist.js) the button reads, so the two can never disagree about which
// checklist applies, whose submission counts, or what "finished" means. Imported with the
// .js extension so this function loads in plain Node (DEV_PLAYBOOK 3.4.16 / CS-011).
//
// WHAT IT COSTS. Every crew clock-out now resolves the clean's context exactly as
// clock-in does — one org_state read (request-cached) and one `jobs` row. On top of that,
// and ONLY when the cleaner actually holds a checklist there and the block is not off for
// them, a COMPLETE read of their own submissions for that clean: count-first, then paged
// on the `checklist_results_job_id_idx` index (migration 20260718000000), the other two
// predicates narrowing inside it, over narrow columns. It is complete rather than a
// newest-N cap because a cleaner who re-opens their checklist to add notes writes a row
// each time: a finished submission buried under later partials would otherwise read as
// unfinished and refuse a cleaner who had in fact finished.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { selectAll, exactCount } from '../pagedSelect.js';
import { checklistFor, clockOutGate, GATE } from '../../../src/lib/crewChecklist.js';

// The refusal. A code the client can branch on, a plain message the crew can read, and the
// progress so the button can say 12/46 without a second round trip. Nothing else: no
// stack, no SQL, no env names (DEV_PLAYBOOK 3.4.12). Defined once, next to the crew copy
// the button shows (src/lib/clockOutBlock.js), so the two can never drift.
export {
  CHECKLIST_INCOMPLETE_CODE, CHECKLIST_INCOMPLETE_ERROR,
  CHECKLIST_CHECK_FAILED_CODE, CHECKLIST_CHECK_FAILED_ERROR,
} from '../../../src/lib/clockOutBlock.js';

// A buffered clock-out is NEVER refused (THE LAW II.8 — fix instead of reject: the work
// already happened and the punch is the only record of it). It is accepted and FLAGGED, so
// the unfinished checklist shows where a manager will see it, at approval.
export const checklistFlagNote = (done, total) => `checklist not finished at clock-out (${done}/${total})`;
// …and when the gate could not be READ at all, the replay is still accepted — with a flag
// that says exactly that, rather than accusing the cleaner of an unfinished checklist.
export const CHECKLIST_UNKNOWN_NOTE = 'checklist status unknown at clock-out';

// Narrow columns — the gate counts, it never renders items (a checklist row's `items`
// JSONB is kilobytes).
const RESULT_COLUMNS = 'id,job_id,template_id,completed_by_user_id,completed_count,total_count,performed_at';
// A ceiling on ONE cleaner's own submissions for ONE clean. Far above any real number
// (a clean's checklist re-opened a few times); past it the read fails loudly rather than
// silently answering on a slice.
const MAX_RESULTS = 5000;

// `ctx` is a resolveJobContext result (state + job + client). `userId` is the ENTRY OWNER,
// never the caller: the office closing someone else's punch is not gated at all.
export async function checklistGateFor({ ctx, userId, jobId, db = getSupabase() }) {
  const none = { state: GATE.NONE, done: 0, total: 0 };
  if (!jobId || !userId) return none;
  const rules = (Array.isArray(ctx?.state?.users) ? ctx.state.users : [])
    .find((u) => u && u.id === userId)?.clockRules || null;
  const checklistId = checklistFor({ client: ctx?.client || null, job: ctx?.job || null, userId });
  // R1 — no checklist is a normal state, never a warning and never a block. A job row that
  // has since been deleted lands here too: fail open rather than strand a cleaner.
  if (!checklistId) return none;
  // R6 — the office turned the block off for this one cleaner (step 4b's Team switch).
  if (rules && rules.checklistBlockOff === true) return { state: GATE.OFF, done: 0, total: 0 };

  const scoped = (q) => q
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('job_id', jobId)
    .eq('completed_by_user_id', userId)
    .eq('template_id', checklistId);
  const rows = await selectAll({
    count: async () => {
      const { count, error } = await scoped(db.from('checklist_results').select('id', { count: 'exact', head: true }));
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await scoped(db.from('checklist_results').select(RESULT_COLUMNS))
        .order('performed_at', { ascending: true }).order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
    maxRows: MAX_RESULTS,
  });

  // clockOutGate sorts by performed_at itself, so an ascending read is fine.
  return clockOutGate({ checklistId, rules, results: rows, userId, jobId });
}

export const checklistBlocks = (gate) => gate?.state === GATE.BLOCKED;
// The gate could not be evaluated. The two callers answer it differently, and that
// difference IS the rule: a LIVE clock-out fails closed (503, retryable, nothing
// recorded), a buffered REPLAY is accepted and flagged (THE LAW II.8).
export const checklistUnknown = (gate) => gate?.state === GATE.UNKNOWN;
export const CHECKLIST_GATE_UNKNOWN = Object.freeze({ state: GATE.UNKNOWN, done: 0, total: 0 });
