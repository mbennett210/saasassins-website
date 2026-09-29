// Seed the dashboard's financial_snapshot for go-live: REAL revenue/MRR pulled
// live from the financial Google Sheet (per-client roster, gid 693729890) + STUB
// values for the metrics the sheet does NOT contain (Google/Indeed reviews, open
// complaints, new-business, variance, AR aging) so the redesigned dashboard
// renders fully for the client. Swap the stubs for real numbers via the sheet's
// summary tab (or another source) when ready. Re-run any time to refresh revenue.
//   node scripts/seed-snapshot-sample.mjs         (pull revenue + load stubs)
//   CLEAR=1 node scripts/seed-snapshot-sample.mjs (remove the row → fallbacks)
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const store = await import('../api/_lib/integrations/store.js');
const { createClient } = await import('@supabase/supabase-js');
const ORG = '00000000-0000-0000-0000-000000000001';

if (process.env.CLEAR) {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  await admin.from('financial_snapshot').delete().eq('organization_id', ORG);
  console.log('cleared financial_snapshot row (dashboard reverts to computed fallbacks)');
  process.exit(0);
}

// ── REAL: pull MRR (sum of Monthly Payment, col B) from the roster sheet ──
const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1OKK5WIT1_q5E7ANJe84kHoqH2hoVCB2tKhe1hRWJkQE/export?format=csv&gid=693729890';
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const money = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };

let mrrCents = null, billable = 0;
try {
  const resp = await fetch(SHEET_CSV);
  if (!resp.ok) throw new Error('sheet HTTP ' + resp.status);
  const rows = parseCsv(await resp.text()).slice(2); // skip 2 header rows
  const clients = rows.filter((r) => r[0] && r[0].trim() && money(r[1]) > 0);
  billable = clients.length;
  mrrCents = Math.round(clients.reduce((s, r) => s + money(r[1]), 0) * 100);
  console.log(`pulled from sheet: ${billable} billable clients, MRR $${(mrrCents / 100).toLocaleString()}`);
} catch (e) {
  console.warn('sheet pull failed (' + (e.message || e) + ') — revenue falls back to a stub');
}

const snapshot = {
  // REAL — summed live from the financial sheet roster:
  revenue_current_month_cents: mrrCents ?? 25000000, // MRR = sum of monthly payments
  // STUB — NOT in the sheet; swap when the summary tab / real source is ready:
  new_business_actual_cents: 34000000, new_business_goal_cents: 100000000, // $340k / $1M goal
  google_reviews_actual: 62, google_reviews_goal: 100,
  indeed_reviews_actual: 18, indeed_reviews_goal: 50,
  open_complaints: 3, variance_yesterday_cents: -125000,
  outstanding_quotes_cents: 1875000, ar_cents: 4200000, past_due_30_cents: 1150000,
  source: mrrCents ? 'sheet_mrr+stub' : 'stub',
};
await store.upsertSnapshot(snapshot);
const back = await store.getSnapshot();
const okFields = ['revenue_current_month_cents', 'new_business_actual_cents', 'google_reviews_actual', 'open_complaints', 'ar_cents']
  .filter((k) => back[k] === snapshot[k]);
console.log(`snapshot round-trip: ${okFields.length}/5 fields persisted`);
console.log(`REAL revenue/MRR from sheet${mrrCents ? '' : ' (FELL BACK TO STUB)'}; goals / complaints / AR are STUBS — swap when ready.`);
