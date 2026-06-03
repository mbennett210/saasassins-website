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
