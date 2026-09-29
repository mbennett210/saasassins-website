// Distinguish a TRANSPORT failure (offline / no signal / DNS — safe to buffer and
// replay) from a real server ANSWER (a 4xx/5xx carrying a JSON error message — which
// must NOT be buffered, because replaying it would loop forever). Pure + dependency-free
// so the classification is unit-tested (scripts/test-checklist-offline.mjs).
//
// navigator.onLine is the fast path; a fetch that never reaches the server rejects with a
// TypeError. Pass `online` explicitly to test without a navigator. Used by the offline
// checklist queue (crew audit C1) to decide whether a failed submit gets buffered.
export function isOfflineError(e, { online } = {}) {
  const isOnline = online === undefined
    ? (typeof navigator === 'undefined' ? true : navigator.onLine !== false)
    : online;
  if (isOnline === false) return true;
  const m = String(e?.message || '').toLowerCase();
  // 'load failed' is Safari's transport phrasing and must be matched at a WORD boundary:
  // a bare substring test also matched "Upload failed" and "Download failed", which are
  // Supabase Storage's own REJECTIONS. With the drain now branching on this (CS-007), a
  // misclassified Storage rejection would stop every flush pass and wedge the queue; it
  // previously made uploadMedia buffer a rejection it should have surfaced.
  return e?.name === 'TypeError'
    || m.includes('failed to fetch') || /\bload failed\b/.test(m)
    || m.includes('networkerror') || m.includes('network request failed');
}
