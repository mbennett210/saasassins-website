// One read the app makes as it opens and keeps, for a flag the Customers list and a customer's page draw beside
// a customer's status: the ticket counts behind "N tickets in 30 days" (CS-962, through lib/ticketCountsCache.js)
// and this month's supply spend behind "Over supply budget" (CS-963, hooks/useSupplyBudgets.js).
//
// Daniel, 2026-11-02: replying "1." to "Read the counts when the app opens (Recommended)" for the ticket flags,
// then "Same fix, after this release (Recommended)" for the supply flag: the app reads them as it opens and keeps
// them, so the list and a customer's page draw with their flags already in place and nothing moves after. A page
// draws with the read as it was when the page opened; the read is made again in the background (at most once
// every REFRESH_MS), and what it says shows the next time a page opens, never on the page already open. Only a
// page opened before the first read has answered waits for it, at most WAIT_MS.
//
// No React and no fetch here: the hooks give it the read, and test-ticket-counts.mjs and test-supply-budgets.mjs
// run it on its cases.

/** A page that opens reads again when the last read began longer ago than this. */
export const REFRESH_MS = 60 * 1000;
/** The longest a page waits for the first read before it draws without it. */
export const WAIT_MS = 4 * 1000;

/**
 * One app's kept read.
 * @param {{ read: () => Promise<unknown>, accept?: (answer: unknown) => unknown, now?: () => number,
 *   later?: (fn: () => void, ms: number) => unknown, cancel?: (timer: unknown) => void }} io
 *   `accept` shapes an answer into what is kept, so an answer of the wrong shape is kept as the empty one.
 */
export function createKeptRead({ read, accept = (x) => x, now = () => Date.now(), later = (fn, ms) => setTimeout(fn, ms), cancel = (timer) => clearTimeout(timer) }) {
  let owner = null;      // whose read this is: the signed-in person's id
  let value = null;      // what the last read that answered said, shaped by `accept`; null before one
  let failed = false;    // the last read failed: `value` is the last good one's
  let settled = false;   // the first read has answered, or failed
  let reading = null;    // the read under way
  let began = -Infinity; // when the last read began
  let round = 0;         // a read begun for the person before is dropped
  let order = 0;         // reads and takes, in the order they began
  let keptOrder = 0;     // the order of what `value` holds: a read begun before it never replaces it
  const waiting = new Set();

  const settle = () => {
    if (settled) return;
    settled = true;
    for (const fire of [...waiting]) fire();
  };

  return {
    /** Whose read this is; another person's forgets it and drops a read under way. */
    setOwner(id) {
      if (id === owner) return;
      owner = id;
      value = null;
      failed = false;
      settled = false;
      reading = null;
      began = -Infinity;
      round += 1;
      keptOrder = 0;
    },

    /**
     * Read, unless a read is under way or the last began less than REFRESH_MS ago; `force` (a person's Retry)
     * reads at once, unless one is under way. A failed read keeps what the last good one said and says it
     * failed; with none kept, there is nothing to draw a flag from (a red badge nobody can explain is worse
     * than an absent one, WO-14).
     */
    refresh({ force = false } = {}) {
      if (reading || (!force && now() - began < REFRESH_MS)) return reading;
      const mine = round;
      const myOrder = ++order;
      began = now();
      reading = Promise.resolve()
        .then(() => read())
        .then((answer) => {
          if (mine !== round || myOrder < keptOrder) return;
          value = accept(answer);
          failed = false;
          keptOrder = myOrder;
        })
        .catch(() => { if (mine === round && myOrder > keptOrder) failed = true; })
        .finally(() => {
          if (mine !== round) return;
          reading = null;
          settle();
        });
      return reading;
    },

    /**
     * Keep an answer read elsewhere for `id` (the Supplies page's own read), for the next page that opens. It
     * counts as the last read, and a read begun before it never puts the older answer back.
     */
    take(id, answer) {
      if (id !== owner) return;
      value = accept(answer);
      failed = false;
      keptOrder = ++order;
      began = now();
      settle();
    },

    /** What a page opening now draws with, for `id`: not ready until the first read has answered. */
    snapshot(id) {
      return id === owner && settled ? { ready: true, value, failed } : { ready: false, value: null, failed: false };
    },

    /**
     * Call back once, when the first read has answered or WAIT_MS has gone, whichever is first: the one update a
     * waiting page takes. Returns the way to stop waiting (the page closed).
     */
    whenSettled(callback) {
      if (settled) { callback(); return () => {}; }
      let done = false;
      let timer = null;
      const fire = () => {
        if (done) return;
        done = true;
        waiting.delete(fire);
        cancel(timer);
        callback();
      };
      waiting.add(fire);
      timer = later(fire, WAIT_MS);
      return () => { done = true; waiting.delete(fire); cancel(timer); };
    },
  };
}
