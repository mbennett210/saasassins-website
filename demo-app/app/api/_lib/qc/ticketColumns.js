// Whether problem_reports has the columns migration 20261017110000 adds (`site_area_id`, and with
// it `reporter_name` / `reporter_contact` and the 'visitor' origin) — PROBED, never assumed.
//
// The migration is written, not applied (the owner applies it before the release). Until it lands
// every ticket read and write must work exactly as before: a write that named `site_area_id`, or a
// declared-column read that selected it, would fail outright on the old shape (PostgREST: PGRST204
// / 42703) and take the customer's Requests and the office's New work order down with it. So the
// paths that name the column ask here first (the inbox owner column's pattern, inboxOwnership.js):
//   · qc/store.createProblem writes `site_area_id` only once it exists (an area named before then is
//     left off the ticket, logged — the ticket itself always goes through);
//   · clientHub/reads selects it for the customer's own requests only once it exists.
// A positive answer is kept for the instance's life (a schema does not lose a column under it); a
// negative one is asked again after NEGATIVE_TTL_MS, so the paths follow the migration within a
// minute of it landing. Any error reads as "not yet" — the only cost is a missing area label.
import { getSupabase } from '../supabase.js';

export const TICKET_AREA_COLUMN = 'site_area_id';
const NEGATIVE_TTL_MS = 60_000;
let probe = { known: false, present: false, checkedAt: 0 };

export async function ticketAreaColumnReady(db = getSupabase()) {
  if (probe.known && probe.present) return true;
  if (probe.known && Date.now() - probe.checkedAt < NEGATIVE_TTL_MS) return false;
  let present = false;
  try {
    const { error } = await db.from('problem_reports').select(TICKET_AREA_COLUMN).limit(1);
    present = !error;
  } catch {
    present = false;
  }
  probe = { known: true, present, checkedAt: Date.now() };
  return present;
}

// Test-only: the probe is process-wide state.
export function __resetTicketColumnProbe() {
  probe = { known: false, present: false, checkedAt: 0 };
}
