// Stable-enough IDs for prototype use. Prefix makes them greppable.
let counter = 0;

export function newId(prefix = 'id') {
  counter += 1;
  const t = Date.now().toString(36);
  const c = counter.toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${c}${r}`;
}

// Deterministic ID for seed data so references stay stable across reloads.
export function seedId(prefix, key) {
  return `${prefix}_seed_${key}`;
}

// ── THE SAMPLE-RECORD MARK (Matt's approved messages, 2026-10-19) ─────────────
// Every record the seed mints is `<prefix>_seed_<key>` (seedId above). Production still holds
// the seed's 13 customers, their 13 contacts and their 406 cleans, each contact with an email
// at a real-looking company domain, so a message sent to one would reach a stranger. A record
// anyone makes in the app is `<prefix>_<base36 time + counter + random>` (newId), or a uuid,
// and neither can carry the mark: base36 has no underscore. An id BUILT from a seed record's id
// carries it too (a seed customer's location is `st_loc_cl_seed_<key>`), and is a sample record
// as well. The mark is DERIVED from seedId, so the two cannot drift apart.
export const SEED_ID_MARK = seedId('', '');                     // '_seed_'
const SEED_ID_RE = new RegExp(`^\\S+${SEED_ID_MARK}\\S+$`);

/** True when `id` is a record the seed made (`<prefix>_seed_<key>`, or an id built from one). */
export function isSeedId(id) {
  return typeof id === 'string' && SEED_ID_RE.test(id);
}

// The first sample-record id among `refs` — an object of ids (or arrays of ids), e.g.
// { clientId, contactId, jobId } — or null when none is one. The customer-message send step
// asks this before anything leaves (api/_lib/customerMessages/send.js).
export function seedRecordIn(refs) {
  if (!refs || typeof refs !== 'object') return null;
  for (const v of Object.values(refs)) {
    for (const id of Array.isArray(v) ? v : [v]) if (isSeedId(id)) return id;
  }
  return null;
}
