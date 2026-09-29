// The reconnect pump for the two queues the clock-out block depends on, in the ONE order
// that keeps a replayed clock-out honest: the CHECKLIST queue first, then the PUNCH queue
// (see lib/queueFlushOrder for why, and for the single-flight guarantee).
//
// EVERY trigger of these two queues comes through here — the two background syncs, the
// Retry button, and SIGN-OUT. Sign-out matters most on a shared phone: the end of a shift
// IS a sign-out, and it replays the punch queue while the session is still valid, so
// draining the punches alone would put a replayed clock-out ahead of the checklist that
// finished the clean and flag an entry that was fine.
//
// `chain` is for a trigger the user is watching (Retry): see runOrderedFlush.
import { flushChecklistQueue } from './qcApi';
import { flushOfflineQueue } from './timeApi';
import { runOrderedFlush } from './queueFlushOrder';

export const CLOCK_FLUSH_KEY = 'clock';

export function flushClockQueues({ currentUserId = null, chain = false } = {}) {
  return runOrderedFlush(CLOCK_FLUSH_KEY, [
    // 1. the finished checklists — the server must see these before any clock-out replay.
    { name: 'checklists', run: () => flushChecklistQueue() },
    // 2. the buffered punches.
    { name: 'punches', run: () => flushOfflineQueue({ currentUserId }) },
  ], { chain });
}
