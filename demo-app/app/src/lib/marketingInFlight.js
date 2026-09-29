// Module-level in-flight guard for marketing sends, keyed `${enrollmentId}::${stepId}`.
// Lives in its own module (rather than inside MarketingScheduler) so the
// Diagnostics "Retry" can clear a key and let the scheduler re-fire that send.
//
// Otherwise it's never deleted: state-based hasSent() dedup covers refires
// across reloads; this Set only closes the brief window before the pending
// RECORD_MARKETING_SEND dispatch lands in state.
export const inFlight = new Set();

// Drop a key so the scheduler's next tick re-fires that (enrollment, step) —
// used by the Diagnostics Retry, paired with removing the failed send row.
export function clearInFlight(key) {
  inFlight.delete(key);
}
