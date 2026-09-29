// READ-ONLY. How big is the live jobs dataset the app pulls into memory on boot?
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
for (const f of ['../.env.local', '../.env.local.bak']) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch { /* next */ }
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { count, error } = await db.from('jobs').select('*', { count: 'exact', head: true });
if (error) { console.error('count failed:', error.message); process.exit(1); }
console.log('jobs table rows:', count);

// Pull all rows in pages to measure real transfer size + status breakdown.
let all = [], from = 0, page = 1000;
for (;;) {
  const { data, error: e } = await db.from('jobs').select('*').order('id', { ascending: true }).range(from, from + page - 1);
  if (e) { console.error('page failed:', e.message); break; }
  all = all.concat(data);
  if (data.length < page) break;
  from += page;
}
const bytes = Buffer.byteLength(JSON.stringify(all), 'utf8');
console.log('rows fetched:', all.length, ' JSON size:', (bytes / 1048576).toFixed(2), 'MB');

const byStatus = {}, bySeries = new Set(); let recurring = 0; let future = 0;
const today = '2026-07-17';
for (const j of all) {
  byStatus[j.status || '(none)'] = (byStatus[j.status || '(none)'] || 0) + 1;
  if (j.seriesId) bySeries.add(j.seriesId);
  if (j.recurrence) recurring++;
  if ((j.date || '') > today) future++;
}
console.log('status breakdown:', byStatus);
console.log('distinct series:', bySeries.size, ' rows w/ recurrence obj:', recurring, ' future-dated rows:', future);
// oldest / newest dates
const dates = all.map((j) => j.date).filter(Boolean).sort();
console.log('date range:', dates[0], '→', dates[dates.length - 1]);
