// Live READ: every multi-occurrence series has EXACTLY ONE recurrence master.
//
// Why this can't be assumed: whole-series edit, delete-with-cap, and TOP_UP all
// locate the master with `jobs.find(j => j.seriesId === X && j.recurrence)`. A
// series with NO master can't be series-edited (the SeriesScopeModal disables
// "This & all future" with the no-master reason) and TOP_UP can never extend it
// — its tail silently runs dry. A series with TWO masters makes the found master
// order-dependent. Both states are data corruption, not code states: the
// churn-era ping-pong could clobber the reducer's recurrence re-home mid-flight
// (master's recurrence nulled, new anchor's pin lost — found live 2026-07-21 on
// 2 of 145 series). The ping-pong fix removes the corruption mechanism; this
// probe is the tripwire that says whether any OTHER mechanism still creates it.
//
// READ-ONLY — no writes. Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
//
//   node scripts/test-series-master-invariant.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const f of ['../.env.local', '../.env.local.bak']) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch { /* try next */ }
}
const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// One paginated pass over (series_id, has-recurrence) — no payloads pulled.
const perSeries = new Map(); // series_id -> { occ, masters }
const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await db
    .from('jobs')
    .select('series_id, data->recurrence')
    .eq('organization_id', ORG)
    .not('series_id', 'is', null)
    .order('id')
    .range(from, from + PAGE - 1);
  if (error) { console.error('read failed:', error.message); process.exit(2); }
  for (const r of data || []) {
    const s = perSeries.get(r.series_id) || { occ: 0, masters: 0 };
    s.occ += 1;
    // PostgREST aliases `data->recurrence` to `recurrence`; a null-typed key or a
    // missing key both arrive as null — only a real object counts as a master.
    if (r.recurrence && typeof r.recurrence === 'object') s.masters += 1;
    perSeries.set(r.series_id, s);
  }
  if (!data || data.length < PAGE) break;
}

const masterless = [...perSeries].filter(([, s]) => s.occ > 1 && s.masters === 0);
const multi = [...perSeries].filter(([, s]) => s.masters > 1);
// Single-occurrence masterless rows are orphans, not series — reported, not failed
// (deleting them is a human decision; see the 2026-07-21 repair note).
const orphans = [...perSeries].filter(([, s]) => s.occ === 1 && s.masters === 0);

console.log(`series checked: ${perSeries.size}`);
if (orphans.length) console.log(`  ⚠ single-occurrence orphans (no recurrence, not failed): ${orphans.map(([id]) => id).join(', ')}`);
if (masterless.length) console.error(`  ✗ MASTERLESS multi-occurrence series: ${masterless.map(([id, s]) => `${id} (${s.occ} occ)`).join(', ')}`);
if (multi.length) console.error(`  ✗ MULTI-MASTER series: ${multi.map(([id, s]) => `${id} (${s.masters} masters)`).join(', ')}`);

const bad = masterless.length + multi.length;
console.log(`\nseries master invariant: ${bad === 0 ? 'HOLDS' : `${bad} violation(s)`}`);
process.exit(bad ? 1 : 0);
