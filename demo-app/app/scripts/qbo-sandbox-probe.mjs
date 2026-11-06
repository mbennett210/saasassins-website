// qbo-sandbox-probe.mjs — a LIVE-EFFECT probe (NOT a test; no `test-` prefix, so run-tests.mjs
// never runs it). It connects Intuit's SANDBOX company with the app's DEVELOPMENT keys and
// captures the RAW ProfitAndLoss / entity / CompanyInfo JSON as fixtures, so the multi-column
// column→id mapping in api/_lib/qbo/report.js (columnEntityMap) can be confirmed against a real
// company. Tokens live in MEMORY ONLY and are revoked at the end; only non-token JSON is written.
//
// 🔴 DO NOT RUN THIS from an agent session. It needs the owner's real Development keys and a
// human consent click in a browser. Run it by hand:
//
//   1. Put the app's Development keys in app/.env.qbo.local (gitignored by .env.*.local — do
//      NOT commit it). It needs, one KEY=VALUE per line:
//        QBO_CLIENT_ID=...        (Development client id)
//        QBO_CLIENT_SECRET=...    (Development client secret)
//        QBO_ENVIRONMENT=sandbox  (REQUIRED — the probe refuses anything else)
//      Register the redirect URI  http://localhost:5299/qbo/callback  on the Intuit app's
//      "Redirect URIs" list (Development) first, verbatim.
//   2. node app/scripts/qbo-sandbox-probe.mjs
//   3. Open the printed authorize URL, consent with the sandbox company, and the local
//      one-shot server on :5299 finishes the exchange, writes fixtures to
//      app/scripts/fixtures/qbo/, prints a COUNTS-ONLY summary, revokes the token and exits.
//
// It reuses the SAME api/_lib/qbo client code the route uses, so a fixture it captures is what
// the route would parse.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildAuthorizeUrl, exchangeCode, fetchCompanyInfo, queryEntities, fetchProfitAndLoss, revokeToken,
} from '../api/_lib/qbo/client.js';
import { resolveRange } from '../api/_lib/qbo/ranges.js';
import { columnEntityMap } from '../api/_lib/qbo/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5299;
const REDIRECT_URI = `http://localhost:${PORT}/qbo/callback`;
const FIXTURES = path.join(HERE, 'fixtures', 'qbo');

// Load app/.env.qbo.local into process.env WITHOUT printing any value.
function loadEnvFile() {
  const p = path.join(HERE, '..', '.env.qbo.local');
  if (!existsSync(p)) { console.error(`Missing ${p} — see the header for what it must contain.`); process.exit(1); }
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnvFile();
if ((process.env.QBO_ENVIRONMENT || '').trim().toLowerCase() !== 'sandbox') {
  console.error('Refusing to run: QBO_ENVIRONMENT must be "sandbox".');
  process.exit(1);
}
const creds = { clientId: process.env.QBO_CLIENT_ID, clientSecret: process.env.QBO_CLIENT_SECRET };
if (!creds.clientId || !creds.clientSecret) { console.error('Refusing to run: QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set.'); process.exit(1); }
const environment = 'sandbox';

const stateNonce = crypto.randomBytes(16).toString('hex');
const authorizeUrl = buildAuthorizeUrl({ clientId: creds.clientId, redirectUri: REDIRECT_URI, state: stateNonce });

function saveFixture(name, data) {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(path.join(FIXTURES, `${name}.json`), JSON.stringify(data, null, 2));
}

// Summarize a P&L report by COUNTS + the column→id mapping only — never the money values.
function summarizePnl(label, report) {
  const cols = columnEntityMap(report?.Columns?.Column);
  const withId = cols.filter((c) => c.kind === 'entity').length;
  const rollups = cols.filter((c) => c.kind === 'rollup').length;
  console.log(`  P&L ${label}: ${cols.length} columns, ${withId} entity column(s), ${rollups} parent roll-up(s); basis=${report?.Header?.ReportBasis || '?'}`);
}

async function runProbe(code, realmId) {
  const tokens = await exchangeCode(code, { ...creds, redirectUri: REDIRECT_URI }); // in memory only
  try {
    const access = tokens.access_token;
    const company = await fetchCompanyInfo(access, { environment, realmId });
    saveFixture('companyinfo', { companyName: company.companyName });
    console.log(`  CompanyInfo: name set=${!!company.companyName}`);

    for (const type of ['customer', 'class', 'department']) {
      const rows = await queryEntities(access, { environment, realmId, entityType: type });
      saveFixture(`entities-${type}`, rows);
      console.log(`  ${type}s: ${rows.length} (active ${rows.filter((r) => r.active).length} / inactive ${rows.filter((r) => !r.active).length})`);
    }

    const ranges = ['d30', 'all'];
    for (const range of ranges) {
      const { start, end } = resolveRange(range);
      for (const summarize of ['Customers', 'Classes', 'Departments', 'Total']) {
        const report = await fetchProfitAndLoss(access, { environment, realmId, startDate: start, endDate: end, summarizeColumnBy: summarize });
        saveFixture(`pnl-${summarize}-${range}`, report);
        summarizePnl(`${summarize}/${range}`, report);
      }
    }
    console.log(`\nWrote fixtures to ${FIXTURES}`);
  } finally {
    try { await revokeToken(tokens.refresh_token, creds); console.log('  revoked the token.'); } catch { /* best effort */ }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/qbo/callback') { res.statusCode = 404; return res.end('not found'); }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const realmId = url.searchParams.get('realmId');
  const error = url.searchParams.get('error');
  res.setHeader('Content-Type', 'text/plain');
  if (error) { res.end(`Intuit returned: ${error}. You can close this tab.`); server.close(); return; }
  if (state !== stateNonce) { res.statusCode = 400; res.end('state mismatch'); return; }
  if (!code || !realmId) { res.statusCode = 400; res.end('missing code/realmId'); return; }
  res.end('Connected. Capturing fixtures — watch the terminal. You can close this tab.');
  try { await runProbe(code, realmId); console.log('\nDone.'); } catch (e) { console.error('Probe failed:', e?.code || e?.message || 'error'); }
  server.close();
});

server.listen(PORT, () => {
  console.log(`\nQBO sandbox probe listening on http://localhost:${PORT}`);
  console.log('Open this authorize URL in a browser and consent with the SANDBOX company:\n');
  console.log(authorizeUrl);
  console.log('\nWaiting for the Intuit redirect…');
});
