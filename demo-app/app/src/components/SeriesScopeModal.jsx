import Modal from './Modal';
import { useT } from '../i18n/react';

// Shared "apply to just this occurrence, or this and all future?" chooser for any
// recurring-series edit or delete. ONE prompt: Cancel / X aborts entirely (no
// chained second dialog), so dismissing never re-prompts. The caller only hears
// about a real choice through onPick('single' | 'future') and owns closing +
// acting on it. Reused by JobDetail (edit + delete), Schedule's Reschedule button,
// and Week drag-drop — every path that could mutate a series occurrence must route
// through this so none of them silently edits/deletes one occurrence of a series.
//
// disableFuture: hide the "This & all future" option (only "Just this one" remains).
// disableReason says WHY, and the copy must match, because the wrong message sends
// users in a circle — the shipped bug behind "editing a job doesn't update the
// future": JobDetail disables this while the jobs backfill is still loading, but
// the only copy was the multi-day one ("…open the job and use Edit"), shown to a
// user who was ALREADY in the job's Edit. They clicked the only button left,
// edited one occurrence, got a success toast, and concluded series edits are
// broken. No error existed anywhere for anyone to see.
//   'loading'   — the series' occurrences are still loading (the app holds the jobs
//                 window, not the table, and a whole-series operation needs every
//                 occurrence — see JobDetail's gate comment). Transient: the prompt
//                 re-renders when the series lands, so the option APPEARS while the
//                 modal is open. Say that. (Catalog: seriesScope.loading.)
//   'load-failed' — the series could not be loaded (Schedule's quick paths ask once,
//                 before the prompt): series-wide changes wait for a retry.
//                 (Catalog: seriesScope.loadFailed.)
//   'no-master' — the series has no recurrence master (data needs repair);
//                 permanent until an admin fixes it. Say that too.
//   null        — the legacy multi-day quick-path reason (Schedule's flat
//                 Reschedule form + drag-drop, where per-day crews/times can't be
//                 edited safely without the block editor; the full Edit page IS
//                 the remedy there, so that copy stays).
const CATALOG_REASONS = { loading: 'seriesScope.loading', 'load-failed': 'seriesScope.loadFailed' };
const DISABLED_COPY = {
  'no-master': 'This job is part of a recurring series whose recurrence record is missing, so series-wide changes are unavailable. You can change single occurrences. Ask your admin to repair the series.',
  // A series cleaned twice on the same day cannot be expressed by the recurrence
  // (dayOverrides holds one entry per weekday), so a series-wide edit would re-time
  // BOTH of that day's cleans to one time and silently merge them. Say what the schedule
  // does and what to do instead — "unavailable" with no reason reads as a broken app.
  'twice-in-a-day': 'This series cleans the same site more than once on some days, which a series-wide edit can’t change safely. It would collapse both of that day’s cleans onto one time. Change occurrences one at a time here, or delete the remaining series and recreate it with the times you want.',
  default: 'This job is part of a multi-day recurring series. You can change just this occurrence here. To change the whole series (per-day crew & times), open the job and use Edit.',
};

// summary: optional node describing what "This & all future" would affect — for a
// DELETE that is a breakdown of the schedule blocks about to be destroyed. Deleting a
// whole series is irreversible and fires on ONE click with no second confirm, so the
// prompt has to state what goes: which site, which days at which times, whose crew,
// and how many jobs. Hidden when the future option isn't offered — nothing would be
// destroyed beyond this occurrence, so listing the series would misdescribe the act.
export default function SeriesScopeModal({ open, intent = 'edit', onPick, onClose, disableFuture = false, disableReason = null, summary = null }) {
  const t = useT();
  const isDelete = intent === 'delete';
  const variant = isDelete ? 'btn-danger' : 'btn-primary';
  const disabledCopy = CATALOG_REASONS[disableReason]
    ? t(CATALOG_REASONS[disableReason])
    : (DISABLED_COPY[disableReason] || DISABLED_COPY.default);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isDelete ? 'Delete recurring job' : 'Edit recurring job'}
      size="sm"
    >
      <p className="confirm-message">
        {disableFuture
          ? disabledCopy
          : 'This job is part of a recurring series. Apply to just this one, or this and all future jobs?'}
      </p>
      {summary && !disableFuture && summary}
      <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${variant}`} onClick={() => onPick('single')}>Just this one</button>
        {!disableFuture && (
          <button type="button" className={`btn ${variant}`} onClick={() => onPick('future')}>This &amp; all future</button>
        )}
      </div>
    </Modal>
  );
}
