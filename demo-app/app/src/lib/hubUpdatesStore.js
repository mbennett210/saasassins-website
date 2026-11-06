// THE BELL'S ANSWER AS ONE SMALL STORE (the client hub redesign, plan §3.4, Wave B) — the logic
// behind pages/hub/hubUpdates.js, kept here PURE and node-safe (the reads are passed in; no React,
// no backend) so the suites can drive it.
//
// GET /api/hub/updates answers the bell's list AND `messagesUnread`, the Messages badge's count.
// The layout, the bell (mounted twice: the phone's top bar and the desktop's Home bar) and the
// Messages page all want it, so one store reads it for all of them: one request a minute however
// many are mounted.
//
//   · The first subscriber starts the read and the re-read every `pollMs` (only while the page is
//     visible; one read on coming back). The last one stops it and FORGETS the answer, so a sign-out
//     followed by another login in the same tab never shows the first login's bell.
//   · A GENERATION drops a read that lands after a reset (the last unsubscribe, a new viewer), and
//     the next read after a reset is a fresh request, never the dropped one handed back. (React
//     mounts every effect twice in development: subscribe, unsubscribe, subscribe. Handing back the
//     first, dropped read left the bell empty until the next minute.)
//   · `reload()` re-reads now (the Messages page, after it marks a thread read).
//   · `opened()` is the bell opening: re-read, then mark seen (POST updates-seen), then clear the
//     count here. Each row keeps its "new" dot until the next read, so the list just opened still
//     shows which lines are new. A refused or failed mark (a preview, offline) is quiet: the count
//     stays until a later open.
//   · `setViewer(key)`: a different viewer than the last one resets the answer and reads again.
const EMPTY = Object.freeze({ data: null, error: '' });

export function createHubUpdatesStore({ fetchUpdates, markSeen, pollMs = 60000, doc = typeof document !== 'undefined' ? document : null } = {}) {
  let snap = EMPTY;
  let viewer = null;
  let gen = 0;
  let inflight = null;
  let timer = null;
  const listeners = new Set();

  const emit = (next) => { snap = next; listeners.forEach((l) => l()); };
  const nextGeneration = () => { gen += 1; inflight = null; };

  function reload() {
    if (inflight) return inflight;
    const mine = gen;
    const p = Promise.resolve()
      .then(() => fetchUpdates())
      .then((data) => { if (mine === gen) emit({ data: data || null, error: '' }); })
      .catch((e) => { if (mine === gen) emit({ data: snap.data, error: e?.message || 'Updates could not be loaded.' }); })
      .finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }

  async function opened() {
    await reload();
    const mine = gen;
    try {
      const r = await markSeen();
      if (mine === gen && snap.data) emit({ ...snap, data: { ...snap.data, unseen: 0, seenAt: r?.seenAt || snap.data.seenAt || null } });
    } catch { /* quiet: the count stays until a later open */ }
  }

  const onVisible = () => { if (!doc || doc.visibilityState === 'visible') reload(); };
  function start() {
    reload();
    if (!doc) return;
    timer = setInterval(onVisible, pollMs);
    doc.addEventListener('visibilitychange', onVisible);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (doc) doc.removeEventListener('visibilitychange', onVisible);
    nextGeneration();
    viewer = null;
    snap = EMPTY;
  }

  function subscribe(l) {
    listeners.add(l);
    if (listeners.size === 1) start();
    return () => {
      listeners.delete(l);
      if (listeners.size === 0) stop();
    };
  }

  function setViewer(key) {
    if (key === undefined || key === viewer) return;
    const changed = viewer !== null;
    viewer = key;
    if (changed) { nextGeneration(); emit(EMPTY); reload(); }
  }

  return { subscribe, getSnapshot: () => snap, reload, opened, setViewer };
}
