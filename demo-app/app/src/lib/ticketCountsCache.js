// The ticket counts behind the "complaining too much" flag (WO-14), read when the app opens and kept
// (CS-962). Daniel, 2026-11-02, replying "1." to "Read the counts when the app opens (Recommended)":
// the app reads the ticket counts once as it opens and keeps them, so the Customers list and a
// customer's page draw with their red flags already in place and nothing moves after; the counts are
// read again in the background, and a change shows the next time a page opens, never while it is on
// screen; only a page opened before the first read has answered waits for it (about 0.8 seconds live).
//
// Before this, each of those pages read the counts after it was drawn: on a computer the Customers
// list drew, then its flags arrived, its Status column widened and its rows grew (185px on the demo).
//
// The keeping is lib/keptRead.js, which the supply spend behind "Over supply budget" uses too (CS-963);
// this gives it the counts' shape. No React and no fetch here: hooks/useTicketFlags.js gives it the
// read (qcApi.ticketCounts), and test-ticket-counts.mjs runs it on its cases.
import { createKeptRead, REFRESH_MS, WAIT_MS } from './keptRead.js';

export { REFRESH_MS, WAIT_MS };

/**
 * One app's counts.
 * @param {{ read: () => Promise<Map<string, number>>, now?: () => number,
 *   later?: (fn: () => void, ms: number) => unknown, cancel?: (timer: unknown) => void }} io
 */
export function createTicketCounts(io) {
  // An answer that is not counts flags nobody.
  const kept = createKeptRead({ ...io, accept: (m) => (m instanceof Map ? m : new Map()) });
  return {
    /** Whose counts these are; another person's forgets them and drops a read under way. */
    setOwner: kept.setOwner,
    /** Read the counts, unless a read is under way or the last began less than REFRESH_MS ago. */
    refresh: () => kept.refresh(),
    /** What a page opening now draws with, for `id`: not ready until the first read has answered. */
    snapshot(id) {
      const s = kept.snapshot(id);
      return { ready: s.ready, counts: s.value };
    },
    /** Call back once, when the first read has answered or WAIT_MS has gone, whichever is first. */
    whenSettled: kept.whenSettled,
  };
}
