// THE HUB'S INVOICES AND DOCUMENTS SCREENS (the client hub redesign, Builder C, Wave B; Matt's
// boards mobile-05 / mobile-06 / web-04 / web-05 and Home's tiles mobile-01 / web-01).
//
// The server half (the scope, the cents, the statuses, the states, the PDF's re-check, the
// documents' scope and the agreement) is held by test-hub-invoices.mjs and
// test-customer-documents-routes.mjs. This suite holds what the CUSTOMER reads off those answers:
//   A. the words (src/pages/hub/hubPaperwork.js, the one module the pages and the tiles read): money
//      through moneyCents only, "Due …" / "Paid …", the Partly paid note, every non-ready state's
//      sentence and short line, the agreement's "Started …" and "Signed copy not on file yet." with
//      nothing to open, "Valid through …" / Expired / "On file", the tiles' lines;
//   B. the wiring: both sections in the ONE nav list (UI_RULES §144) with their routes and seeded
//      sweep paths, both tiles in Home's TILES (each reading its own answer, so Home never waits on
//      QuickBooks), "View" through the server's re-checked links, and NO pay button (Matt's s2).
//
// REGRESSION (THE LAW II.3): on the pre-change tree (the integration base b30a91bf) none of the
// pages, tiles, nav entries or routes exist, so every check below fails.
//
//   node app/scripts/test-hub-paperwork.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installResolveShim } from './deletion-core.mjs';

installResolveShim(); // the screens' modules use Vite's extensionless imports
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const load = async (rel) => { try { return await import(pathToFileURL(path.join(APP, rel)).href); } catch (e) { return { __error: e?.message || String(e) }; } };

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

const W = await load('src/pages/hub/hubPaperwork.js');
const { moneyCents } = await import(pathToFileURL(path.join(APP, 'src/lib/money.js')).href);
const { fmtDate } = await import(pathToFileURL(path.join(APP, 'src/lib/dates.js')).href);
const { HUB_INVOICE_STATE, HUB_INVOICE_STATE_SENTENCES, INVOICE_STATUS } = await import(pathToFileURL(path.join(APP, 'src/lib/hubInvoices.js')).href);
const { AGREEMENT_DOCUMENT_ID } = await import(pathToFileURL(path.join(APP, 'src/lib/customerDocuments.js')).href);
ok('the screens\' words are one module (src/pages/hub/hubPaperwork.js)', !W.__error, W.__error);
const short = (d) => fmtDate(d, { month: 'short', day: 'numeric' });
const long = (d) => fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });

// ── A. invoices ──────────────────────────────────────────────────────────────
{
  ok('A1 the banner is Matt\'s sentence, word for word (his note s2)', W.INVOICE_BANNER === 'View-only here — billing and payment are handled through QuickBooks.');
  const open = { id: '1', number: 'CS-1042', totalCents: 116000, balanceCents: 116000, issuedDay: '2026-09-29', dueDay: '2026-10-13', paidDay: null, status: INVOICE_STATUS.open, partlyPaid: false };
  const paid = { ...open, id: '2', number: 'CS-1031', balanceCents: 0, paidDay: '2026-09-02', status: INVOICE_STATUS.paid };
  const credit = { ...paid, id: '3', paidDay: null };
  const partly = { ...open, id: '4', totalCents: 98050, balanceCents: 48050, partlyPaid: true };
  ok('A2 open: "Due <day>"; paid: "Paid <day>"; paid with no payment day: "Paid"',
    W.invoiceDueLine?.(open) === `Due ${short('2026-10-13')}` && W.invoiceDueLine(paid) === `Paid ${short('2026-09-02')}` && W.invoiceDueLine(credit) === 'Paid',
    `${W.invoiceDueLine?.(open)} | ${W.invoiceDueLine?.(paid)} | ${W.invoiceDueLine?.(credit)}`);
  ok('A3 the phone card\'s line: "Issued Sep 29 · Due Oct 13"', W.invoiceDaysLine?.(open) === `Issued ${short('2026-09-29')} · Due ${short('2026-10-13')}`, W.invoiceDaysLine?.(open));
  ok('🔴 A4 "Partly paid" names what is still due, in cents through moneyCents', W.invoicePartlyLine?.(partly) === `Partly paid · ${moneyCents(48050)} still due` && W.invoicePartlyLine(open) === '', W.invoicePartlyLine?.(partly));
  ok('A5 the status badges: Open amber, Overdue red, Paid green', W.INVOICE_BADGE?.open?.label === 'Open' && W.INVOICE_BADGE.overdue?.label === 'Overdue' && W.INVOICE_BADGE.paid?.label === 'Paid'
    && W.INVOICE_BADGE.open.variant === 'amber' && W.INVOICE_BADGE.overdue.variant === 'red' && W.INVOICE_BADGE.paid.variant === 'green');
  ok('A6 a row still owed (open or overdue) is the tinted one; a paid one is not', W.invoiceOwed?.(open) && W.invoiceOwed({ ...open, status: INVOICE_STATUS.overdue }) && !W.invoiceOwed(paid));
  const states = ['not-connected', 'not-linked', 'unsupported-dimension', 'unavailable'];
  ok('🔴 A7 every non-ready state shows the server\'s own sentence (lib/hubInvoices.js)', states.every((s) => W.invoiceStateSentence?.(s) === HUB_INVOICE_STATE_SENTENCES[s]));
  const ready = { state: HUB_INVOICE_STATE.ready, total: 3, summary: { openCount: 1, openCents: 116000, overdueCount: 0, paidCount: 2 } };
  ok('🔴 A8 the Home tile: "1 open ($1,160.00) · 2 paid · via QuickBooks", money through moneyCents',
    W.invoicesTileLine?.(ready) === `1 open (${moneyCents(116000)}) · 2 paid · via QuickBooks` && moneyCents(116000) === '$1,160.00', W.invoicesTileLine?.(ready));
  ok('A9 …nothing owed says so; no invoices in the year says so', W.invoicesTileLine?.({ ...ready, summary: { openCount: 0, openCents: 0, paidCount: 2 } }) === 'Nothing owed · 2 paid · via QuickBooks'
    && W.invoicesTileLine({ state: HUB_INVOICE_STATE.ready, total: 0, summary: {} }) === 'No invoices in the last 12 months');
  const lines = states.map((s) => W.invoicesTileLine?.({ state: s }));
  ok('A10 every non-ready state gets a short line on the tile (never the ready sentence, never blank)', lines.every((l) => typeof l === 'string' && l && !/via QuickBooks/.test(l)), JSON.stringify(lines));
}

// ── A. documents ─────────────────────────────────────────────────────────────
{
  const data = {
    agreement: { title: 'Coral Bay + Bayshore master agreement', startedDay: '2026-01-06', hasFile: true },
    documents: [
      { id: 'd1', kind: 'coi', title: 'Certificate of Insurance', validUntil: '2027-03-31', expired: false },
      { id: 'd2', kind: 'coi', title: 'Certificate of Insurance', validUntil: '2026-09-26', expired: true },
      { id: 'd3', kind: 'w9', title: 'W-9', validUntil: null, expired: false },
    ],
  };
  const cards = W.hubDocumentCards?.(data) || [];
  ok('A11 the agreement comes first, opened by its own id, "Started <day>"', cards[0]?.id === AGREEMENT_DOCUMENT_ID && cards[0]?.line === `Started ${long('2026-01-06')}` && cards[0]?.canOpen === true, JSON.stringify(cards[0]));
  ok('A12 a COI: "Valid through <day>"; an expired one is flagged Expired', cards[1]?.line === `Valid through ${long('2027-03-31')}` && !cards[1].expired && cards[2]?.expired === true, JSON.stringify(cards.slice(1, 3)));
  ok('A13 a W-9 (no end date): "On file"', cards[3]?.line === 'On file' && cards[3]?.canOpen === true);
  const noFile = W.hubDocumentCards?.({ agreement: { title: 'Service Agreement', startedDay: '2026-01-06', hasFile: false }, documents: [] }) || [];
  ok('🔴 A14 an agreement with no signed copy says "Signed copy not on file yet." and offers nothing to open',
    noFile[0]?.line === 'Signed copy not on file yet.' && noFile[0]?.canOpen === false && W.AGREEMENT_NO_FILE === 'Signed copy not on file yet.');
  ok('A15 nothing at all: no cards (the page shows its empty state)', (W.hubDocumentCards?.({ agreement: null, documents: [] }) || ['x']).length === 0);
  ok('A16 the Home tile: "Service agreement · COI · W-9" — each name once', W.documentsTileLine?.(data) === 'Service agreement · COI · W-9', W.documentsTileLine?.(data));
  ok('A17 …and "No documents yet" with none', W.documentsTileLine?.({ agreement: null, documents: [] }) === 'No documents yet');
  ok('A18 Matt\'s note line, word for word', W.DOCUMENTS_NOTE === "These documents are specific to this property. Switch properties to see that location's paperwork.");
}

// ── B. the wiring ────────────────────────────────────────────────────────────
{
  const nav = await load('src/pages/hub/hubNav.js');
  const entry = (k) => (nav.HUB_NAV || []).find((e) => e.key === k);
  const inv = entry('invoices');
  const docs = entry('documents');
  ok('🔴 B1 Invoices and Documents are in the ONE nav list: main, order 60 / 70, named in the switch note (UI_RULES §144)',
    inv?.place === 'main' && inv.order === 60 && inv.section === 'invoices' && inv.switchNote === true
      && docs?.place === 'main' && docs.order === 70 && docs.section === 'documents' && docs.switchNote === true,
    JSON.stringify([inv, docs]));
  const app = code('src/App.jsx');
  ok('B2 …each with its route', /path="\/hub\/b\/:buildingId\/invoices" element=\{<HubInvoices \/>\}/.test(app) && /path="\/hub\/b\/:buildingId\/documents" element=\{<HubDocuments \/>\}/.test(app));
  const routes = await load('scripts/app-routes.mjs');
  ok('B3 …and seeded demo paths for the browser sweeps', (routes.PARAMS?.['/hub/b/:buildingId/invoices'] || []).length >= 1 && (routes.PARAMS?.['/hub/b/:buildingId/documents'] || []).length >= 1);
  const home = code('src/pages/hub/HubHome.jsx');
  ok('🔴 B4 both tiles are in Home\'s TILES; Documents is the wide one (a row on the phone)',
    /\{\s*key:\s*'invoices',\s*Tile:\s*HubInvoicesTile\s*\}/.test(home) && /\{\s*key:\s*'documents',\s*Tile:\s*HubDocumentsTile,\s*wide:\s*true\s*\}/.test(home));
  const invTile = code('src/pages/hub/HubInvoicesTile.jsx');
  const docTile = code('src/pages/hub/HubDocumentsTile.jsx');
  ok('🔴 B5 each tile reads its OWN answer (a slow QuickBooks never holds Home up): the summary with a small page, the documents',
    /useHubRead\(\(\) => fetchHubInvoices\(building\.id, \{ limit: 1 \}\)/.test(invTile) && /useHubRead\(\(\) => fetchHubDocuments\(building\.id\)/.test(docTile)
      && !/fetchHubInvoices|fetchHubDocuments/.test(code('src/pages/hub/HubRoot.jsx')));
  const page = code('src/pages/hub/HubInvoices.jsx');
  ok('🔴 B6 NO pay button on the invoices page (Matt\'s s2)', page.length > 0 && !/\bpay(?:\s+now|\s+invoice|ment\s+link)?\b[^"'`]*<\/button>|>\s*Pay\b/i.test(page) && !/href=\{?[^}]*pay/i.test(page));
  ok('B7 the banner is drawn from the constant, on every state of the page', /\{INVOICE_BANNER\}/.test(page));
  ok('B8 "View invoice" opens QuickBooks\'s PDF through the server\'s re-check', /openHubInvoicePdf\(buildingId, r\.id\)/.test(page));
  ok('🔴 B9 money on the page is cents through moneyCents — no dollars arithmetic', /moneyCents\(r\.totalCents\)/.test(page) && !/\/\s*100\b|toFixed\(/.test(page));
  ok('B10 the table maps the server page (`pageRows`, 20 a page) and the pager is drawn', /pager\.pageRows\.map/.test(page) && /<ListPager pager=\{pager\}/.test(page) && /HUB_PAGE_SIZE/.test(page));
  ok('B11 "Updated <time>" from the answer\'s asOf', /data\?\.asOf/.test(page) && /Updated /.test(page));
  const docsPage = code('src/pages/hub/HubDocuments.jsx');
  ok('B12 "View" on a document opens the server\'s re-checked five-minute link, and only where there is a file',
    /openHubDocument\(buildingId, c\.id\)/.test(docsPage) && /c\.canOpen &&/.test(docsPage));
  ok('B13 each page draws its own back arrow (lint:backnav sees it)', /<BackLink\b/.test(page) && /<BackLink\b/.test(docsPage));
}

console.log(`\nhub paperwork screens: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
