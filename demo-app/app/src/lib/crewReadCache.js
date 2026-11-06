// The last answer a Cleaner Hub read got, KEPT ON THE PHONE (the Cleaner Hub, brief C: "Offline:
// the last answer kept on the phone, else No signal"; THE LAW II.7 — cache-first paint, online
// too). A cleaner opens My Hours or Client Requests in a basement with no signal and still sees
// what this phone last read, said as such, instead of a spinner.
//
// localStorage, one key per read, a small map of slots (the person and, for My Hours, the period)
// → { answer, savedAt }. RETENTION AT THE WRITE POINT: at most `max` slots, the oldest dropped.
// Every access is guarded — a private window, a full or blocked store answers "nothing kept" and
// the screen works without it. Only a person's OWN reads are kept (never an office preview).
export function makeReadCache(storageKey, { max = 12 } = {}) {
  const loadAll = () => {
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  };
  return {
    get(slot) {
      const e = loadAll()[slot];
      return e && e.answer && typeof e.savedAt === 'string' ? e : null;
    },
    put(slot, answer) {
      try {
        if (typeof localStorage === 'undefined' || answer == null) return;
        const all = loadAll();
        all[slot] = { answer, savedAt: new Date().toISOString() };
        const keep = Object.entries(all)
          .sort((a, b) => (Date.parse(b[1]?.savedAt) || 0) - (Date.parse(a[1]?.savedAt) || 0))
          .slice(0, max);
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(keep)));
      } catch { /* a full or blocked store keeps nothing — the screen still works */ }
    },
  };
}
