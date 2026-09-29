// Display vocabulary for internal-thread ownership. Kept in one place because
// two surfaces render it — the message-pane sub-header and the Super Admin's
// orphaned-threads panel — and they must agree on what "removed" vs "inactive"
// means before anyone deletes a thread based on that label.
//
// The states come from selectThreadCreator (store/selectors.js).

export const CREATOR_STATE_SUFFIX = {
  active: '',
  inactive: ' (inactive)',
  removed: ' (removed)',
  unknown: '',
};

export const CREATOR_STATE_REASON = {
  inactive: 'Creator’s account is no longer active',
  removed: 'Creator was removed from the team',
  unknown: 'No creator on record',
};

// "Jane Doe (removed)" / "Jane Doe" / "Unknown" — the one-line byline for a
// thread's creator.
export function threadCreatorLabel(creator) {
  if (!creator?.name) return 'Unknown';
  return `${creator.name}${CREATOR_STATE_SUFFIX[creator.state] || ''}`;
}
