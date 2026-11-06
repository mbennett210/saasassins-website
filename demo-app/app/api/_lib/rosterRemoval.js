// A removed member leaves the shared record WITH their login (CS-969, 2026-11-03).
//
// Settings → Team → Remove (api/settings/[...path].js, the 'remove' action) deleted the login and
// left the roster row to the tab: TeamDetail dispatched DELETE_USER after the route answered, and
// that reached org_state only with the tab's next save (600 ms later at the earliest; after a
// re-read and a replay when the record had moved; 5 to 60 s later while saves were failing). A
// page left before that save was answered lost it: the copy the tab writes to the device cache as
// it is hidden never lands on a full page load (measured in Chromium, 0 of 12). So on production
// (task 469) the login was gone and Team still listed the member as active. Replace means delete
// (THE LAW II.5): the login and the record entry go together, in the route's own request.
//
// The cascade is the app's own, lib/deleteCascade removeUserFromRecord, the same function the
// reducer's DELETE_USER spreads (overrides, bell rows, the thread, message and key-event names
// that outlive them, sweepUserOrphans), run on the committed record and CAS-written with a re-read
// on conflict. The record holds no cleans (public.jobs does, store/tableSlices.js), so their crew
// lists are still the tab's DELETE_USER to sweep and mirror, as before; the tab's own replay of
// DELETE_USER on this newer record then changes nothing in it. The route has already refused what
// the app's rule refuses (owed pay, the last Super Admin); the same two checks run here again on
// the record being written, and an id they keep is reported.
//
// Its own module (not memberRemoval.js) so the org-state save route, which reads the pay facts
// from there on every removal, never loads the cascade it doesn't run.
import { readOrgState, writeOrgState } from './orgState.js';
import { syncAssignmentsFromState } from './crewAssignments.js';
import { reportError } from './monitor.js';
import { isLastOwner } from '../../src/lib/roles.js';
import { hasUnsettledPay, removeUserFromRecord } from '../../src/lib/deleteCascade.js';

const ROSTER_CAS_RETRIES = 5;
const onRoster = (state, id) => (Array.isArray(state?.users) ? state.users : []).some((u) => u && u.id === id);
const orgZone = (state) => (typeof state?.company?.timezone === 'string' && state.company.timezone ? state.company.timezone : undefined);

// `userIds`: the member's roster row ids. → { removed, kept, version } (`version` is the record's
// after the write, or as read when there was nothing to write). Throws when the record can't be
// read or keeps moving; the caller reports that and answers `roster.pending`.
export async function removeFromRoster(userIds) {
  const ids = [...new Set((userIds || []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return { removed: [], kept: [], version: null };
  for (let attempt = 0; attempt < ROSTER_CAS_RETRIES; attempt += 1) {
    const { state, version } = await readOrgState();
    if (!version) return { removed: [], kept: [], version: null }; // no record yet: nothing to take out
    let next = state;
    const kept = [];
    for (const id of ids) {
      if (!onRoster(next, id)) continue;
      // The reducer's own refusals (DELETE_USER), on the record being written.
      if (isLastOwner(next.users, id) || hasUnsettledPay(next, id, undefined, orgZone(next))) {
        kept.push(id);
        continue;
      }
      next = removeUserFromRecord(next, id);
    }
    const removed = ids.filter((id) => onRoster(state, id) && !onRoster(next, id));
    if (kept.length) {
      reportError('team.remove_roster_kept', new Error(`the shared record kept ${kept.join(', ')} on the roster after the login was deleted`), { ids });
    }
    if (!removed.length) return { removed, kept, version };
    // `prev`: a roster row leaves (a protected change), so the digest is kept current (orgState.js).
    if (await writeOrgState(next, version, { prev: state })) {
      // The same post-commit step the org-state route runs on a roster change. Best-effort: the
      // removal has committed, and the next roster change re-syncs the table.
      try {
        await syncAssignmentsFromState(next);
      } catch (e) {
        reportError('crew_assignments.sync_failed', e, { note: 'after a team removal (CS-969); the table is stale until the next roster change' });
      }
      return { removed, kept, version: version + 1 };
    }
    // The record moved under us (a tab's save, a cron): re-read and take the member out of that.
  }
  throw new Error('org_state write kept conflicting (too much concurrent activity)');
}
