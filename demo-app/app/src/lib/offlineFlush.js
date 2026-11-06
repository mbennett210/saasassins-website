// The reconnect pump for the three queues the clock-out block depends on, in the ONE
// order that keeps a replayed clock-out honest: the MEDIA queue, then the CHECKLIST
// queue, then the PUNCH queue (see lib/queueFlushOrder for why order matters at all, and
// for the single-flight guarantee).
//
// EVERY trigger of these queues comes through here — the three background syncs, the
// Retry button, and SIGN-OUT. Sign-out matters most on a shared phone: the end of a shift
// IS a sign-out, and it replays the punch queue while the session is still valid, so
// draining the punches alone would put a replayed clock-out ahead of the checklist that
// finished the clean and flag an entry that was fine.
//
// 🔴 WHY MEDIA GOES FIRST (CS-547). A checklist item the office marked "photo required"
// counts as done only once its photo is a real `account_media` row
// (api/_lib/qc/store.checklistPhotoKeys), and a replayed submission is counted when it
// LANDS. So a cleaner who worked a basement offline — photo queued, checklist queued —
// would have the submission counted short if the checklist drained first, and would come
// back online to a checklist that says 4 of 5 for work they finished. Draining the photos
// first is the same reasoning that already puts checklists before punches: the queue that
// supplies the EVIDENCE goes before the queue that is JUDGED on it.
//
// It is not a guarantee, and it is not pretending to be one: a photo whose upload is
// genuinely failing keeps its item uncounted, which is visible as "n of m" and fixable by
// re-ticking online, and never costs anyone their punch (an offline clock-out is accepted
// and flagged, never refused — THE LAW II.8).
//
// `chain` is for a trigger the user is watching (Retry): see runOrderedFlush.
import { flushChecklistQueue } from './qcApi';
import { flushMediaQueue } from './accountMediaApi';
import { flushOfflineQueue } from './timeApi';
import { runOrderedFlush } from './queueFlushOrder';

export const CLOCK_FLUSH_KEY = 'clock';

// The media step on its own, through the SAME single-flight key — what OfflineMediaSync
// runs, so a background media drain joins the pass in flight instead of racing it (the
// media queue's own drain is not re-entrant-safe by itself, and two passes would both
// read the queue before either removed anything).
export function flushMediaOnly() {
  return runOrderedFlush(CLOCK_FLUSH_KEY, [
    { name: 'media', run: () => flushMediaQueue() },
  ]);
}

export function flushClockQueues({ currentUserId = null, chain = false } = {}) {
  return runOrderedFlush(CLOCK_FLUSH_KEY, [
    // 1. the photos a checklist item needs before it can count as done.
    { name: 'media', run: () => flushMediaQueue() },
    // 2. the finished checklists — the server must see these before any clock-out replay.
    { name: 'checklists', run: () => flushChecklistQueue() },
    // 3. the buffered punches.
    { name: 'punches', run: () => flushOfflineQueue({ currentUserId }) },
  ], { chain });
}
