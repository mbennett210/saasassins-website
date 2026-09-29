// ORDERED, single-flight reconnect flush.
//
// WHY ORDER MATTERS. The checklist queue and the punch queue drain independently, each on
// its own load / online / visibilitychange / interval triggers. If the punch queue wins
// the race, the server sees a replayed CLOCK-OUT before the checklist that finished the
// clean, and the entry is flagged "checklist not finished at clock-out" although the
// cleaner did finish it — a clean record turned into a manager's chore by a scheduling
// coincidence. So the checklist queue drains FIRST, always.
//
// SINGLE-FLIGHT. Several triggers fire together on reconnect (the `online` event, the tab
// becoming visible, the interval). They must join the pass in flight rather than start a
// second one, or the two drains interleave and the ordering guarantee is lost again.
//
// A step that throws never skips the next one: the punch queue must still drain when the
// checklist queue is having a bad day. Each step's error comes back as { error } so the
// caller can log it, never as a rejection (a background pump must not produce unhandled
// rejections).
//
// Pure / node-safe — no imports at all, so the ordering is unit-tested headlessly
// (scripts/test-clock-out-gate.mjs). lib/offlineFlush.js binds the real queues.

const inFlight = new Map(); // key → the pass currently running

// `steps` = [{ name, run }] in the order they must run. Returns { [name]: result | { error } }.
//
// `chain: true` is for a trigger that must NOT be swallowed — a Retry the user just
// tapped. Joining the pass in flight would be a no-op for them, because that pass read
// the queue before the tap cleared the item's failed mark. Chaining runs a fresh pass
// once the current one settles: the tap always reaches the queue, and the order inside
// each pass is unchanged.
export function runOrderedFlush(key, steps, { chain = false } = {}) {
  const running = inFlight.get(key);
  if (running && !chain) return running;
  const start = async () => {
    const out = {};
    for (const step of steps || []) {
      if (!step || typeof step.run !== 'function') continue;
      try {
        out[step.name] = await step.run();
      } catch (e) {
        out[step.name] = { error: e?.message || String(e) };
      }
    }
    return out;
  };
  const pass = running ? running.then(start, start) : start();
  inFlight.set(key, pass);
  // Clear only our own pass, so a later trigger that already replaced it is untouched.
  pass.then(() => { if (inFlight.get(key) === pass) inFlight.delete(key); },
    () => { if (inFlight.get(key) === pass) inFlight.delete(key); });
  return pass;
}
