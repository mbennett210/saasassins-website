// Push corrected financials from the AR Report tab to the live dashboard.
// Reads the sheet's OWN summary cells by label (never re-sums the client rows —
// that double-counted before by including the TOTAL SALES row):
//   • MRR                     = "TOTAL SALES" row, col B
//   • Revenue (this month)    = current month's Collected total (TOTAL SALES row)
//   • Accounts Receivable     = "$$ Outstanding" value
//   • Past Due 30+            = AR minus the most-recent month's OWED (the 1-30 bucket)
// Signs (HMAC-SHA256) + POSTs to the production inbound webhook.
//   node scripts/push-financials.mjs            (push to production)
//   PROD_URL=http://localhost:3001 node scripts/push-financials.mjs  (local)
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const store = await import('../api/_lib/integrations/store.js');
const PROD = process.env.PROD_URL || 'https://cleanspace-gilt.vercel.app';
const AR_GID = 693729890; // current AR Report (Jan–Jun 2026)
const SHEET = `https://docs.google.com/spreadsheets/d/1OKK5WIT1_q5E7ANJe84kHoqH2hoVCB2tKhe1hRWJkQE/export?format=csv&gid=${AR_GID}`;

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const money = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };
const norm = (s) => String(s || '').trim().toLowerCase();
const cents = (d) => Math.round(d * 100);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const rows = parseCsv(await (await fetch(SHEET)).text());

// 1) TOTAL SALES row → MRR (col B) + monthly collected cells
const totIdx = rows.findIndex((r) => norm(r[0]) === 'total sales');
if (totIdx < 0) throw new Error('Could not find "TOTAL SALES" row in the AR tab.');
const totalRow = rows[totIdx];
const mrrCents = cents(money(totalRow[1]));

// 2) Revenue (this month) = current month's Collected. Header (row 0) has month
//    names at the Invoiced col; Collected is the next column.
const header = rows[0] || [];
const cur = MONTHS[new Date().getMonth()];
let monthCol = header.findIndex((v) => norm(v) === cur);
if (monthCol < 0) { // fall back to the latest month present
  header.forEach((v, ci) => { if (MONTHS.includes(norm(v)) && ci > monthCol) monthCol = ci; });
}
let revenueCents = cents(money(totalRow[monthCol + 1]));
let revenueMonth = cur;
// Current month may have no collections entered yet (e.g. early in the month) —
// fall back to the latest month that has a non-zero Collected total.
if (revenueCents === 0) {
  for (let ci = header.length - 1; ci >= 0; ci--) {
    if (MONTHS.includes(norm(header[ci]))) {
      const v = cents(money(totalRow[ci + 1]));
      if (v > 0) { revenueCents = v; revenueMonth = norm(header[ci]); break; }
    }
  }
}

// 3) Accounts Receivable = the value to the right of "$$ Outstanding"
let arCents = 0, outRow = -1;
for (let r = 0; r < rows.length && arCents === 0; r++) {
  for (let c = 0; c < rows[r].length; c++) {
    if (norm(rows[r][c]).includes('outstanding')) {
      for (let k = c + 1; k < rows[r].length; k++) { if (money(rows[r][k]) > 0) { arCents = cents(money(rows[r][k])); outRow = r; break; } }
      break;
    }
  }
}

// 4) Past Due 30+ = AR minus the most-recent month's OWED (= the 1-30-day bucket).
//    The OWED row alternates "OWED" labels with per-month owed values.
let pastDueCents = arCents, latestOwed = 0;
const owedIdx = rows.findIndex((r) => r.some((v) => norm(v) === 'owed'));
if (owedIdx >= 0) {
  const r = rows[owedIdx]; let latestCol = -1;
  for (let c = 0; c < r.length; c++) {
    if (norm(r[c]) === 'owed' && money(r[c + 1]) > 0 && c + 1 > latestCol) { latestCol = c + 1; latestOwed = money(r[c + 1]); }
  }
  pastDueCents = Math.max(0, arCents - cents(latestOwed));
}

console.log('Parsed from sheet:');
console.log('  MRR (TOTAL SALES):       $' + (mrrCents / 100).toLocaleString());
console.log('  Revenue (' + cur + ' collected): $' + (revenueCents / 100).toLocaleString());
console.log('  Accounts Receivable:     $' + (arCents / 100).toLocaleString());
console.log('  Past Due 30+ (AR − latest owed $' + latestOwed.toLocaleString() + '): $' + (pastDueCents / 100).toLocaleString());

// ensure endpoint (reuse; activate)
const eps = await store.listEndpoints();
let ep = eps.find((e) => e.purpose === 'financial_snapshot');
if (!ep) { ep = await store.createEndpoint({ name: 'Financial sheet', purpose: 'financial_snapshot' }); console.log('created endpoint'); }
if (!ep.is_active) { await store.updateEndpoint(ep.id, { is_active: true }); }
const url = `${PROD}/api/settings/inbound/${ep.slug}`;

const body = JSON.stringify({
  source: 'google_sheet',
  revenue_current_month_cents: revenueCents,
  mrr_cents: mrrCents,
  ar_cents: arCents,
  past_due_30_cents: pastDueCents,
});
const sig = 'sha256=' + crypto.createHmac('sha256', ep.signing_secret).update(body, 'utf8').digest('hex');
const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CleanSpace-Signature': sig }, body });
console.log(`\nPOST ${url}\n  -> ${resp.status} ${await resp.text()}`);
