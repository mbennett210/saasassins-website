// Reading and writing spreadsheet files (CSV) — and the inbound lead webhook's person engine.
//
// THREE CALLERS, TWO ENGINES (2026-10-03; the supply catalog import 2026-10-27):
//   · Customers → Import customers reads a file through decodeCsvBytes + parseCsv below and
//     plans it in lib/customerImport.js, where one row is one BUILDING (a customer and its one
//     location). Its problems file is written by toCsvText.
//   · Supplies → Catalog → Import items (task 257) reads a CSV the same way, and an Excel
//     workbook's cells (lib/xlsx.js) through gridTable, so both become the same table; it plans
//     them in lib/supplyCatalogImport.js and writes its template and problems file too.
//   · The inbound lead webhook (api/_lib/leads/upsert.js) feeds buildImportPlan one synthetic
//     PERSON row. The person upsert at the bottom of this file is ITS engine: match by
//     Contact ID → email → phone, fill blanks, tie a company by name or email domain.
// The person engine used to BE the Customers import. When the import became customer-first,
// the parts only that screen used (its location columns, the contacts sample file, the column
// guesser) left with it (THE LAW II.5); the webhook's behaviour is unchanged.
// Node-safe (the server and the tests import it). Its one import is the repo's CSV cell
// escaper, payroll.js `csvCell` (pure).

import { csvCell } from './payroll.js';

// ── reading a file ──────────────────────────────────────────────────────────────────────────
// Real spreadsheet exports, not hand-written CSV:
//   · Excel's "CSV UTF-8" starts with a byte-order mark; its plain "CSV" is Windows-1252;
//     "Unicode text" is UTF-16 with tabs (decodeCsvBytes);
//   · where the comma is a decimal mark (most of Europe and Latin America) Excel separates with
//     semicolons, and sometimes writes a `sep=;` first line to say so;
//   · Windows line endings (CRLF), and quoted fields holding commas and line breaks;
//   · blank rows and blank columns trailing a sheet, and two columns with the same header.

const DELIMITERS = [',', ';', '\t'];

// The separator a file uses, counted on its first line outside quotes. Ties go to the comma.
export function detectDelimiter(text) {
  const s = String(text ?? '');
  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if ([...counts.values()].some((n) => n > 0)) break; // the first line that has any separator
      continue;
    }
    if (!inQuotes && counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  }
  let best = ',';
  for (const d of DELIMITERS) if (counts.get(d) > counts.get(best)) best = d;
  return best;
}

// Text → { headers, rows, delimiter, renamed, dropped, sheetRows } (gridTable's table).
//   headers  the first row, trimmed; a repeated header gets " (2)", " (3)"… so each column can
//            be told apart (`renamed` lists them: [{ index, from, to }])
//   rows     every later row with any value in it, trimmed, padded to the header's width
//   dropped  how many empty columns (no header, no value in any row) were left out
export function parseCsv(text, { delimiter } = {}) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  let sep = delimiter;
  // Excel's `sep=;` line names the separator and is not part of the data.
  const directive = /^sep=(.)[ \t]*(\r\n|\n|\r)/i.exec(s);
  if (directive) { sep = sep || directive[1]; s = s.slice(directive[0].length); }
  if (!sep) sep = detectDelimiter(s);

  const all = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); all.push(row); row = []; };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else if (ch === '\r') {
        field += '\n'; // a line break inside a field is one \n, whatever the file used
        if (s[i + 1] === '\n') i += 1;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === sep) { endField(); continue; }
    if (ch === '\r') { if (s[i + 1] === '\n') i += 1; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) endRow();
  return { ...gridTable(all), delimiter: sep };
}

// Rows of cells (a CSV's records, or a sheet's rows by number) → the table an import reads:
// { headers, rows, renamed, dropped, sheetRows, sheetCols } — the first row with anything in it is
// the header; `sheetRows` is each data row's index in `grid` (its "Row N" is that + 1) and
// `sheetCols` each column's (empty columns are left out). `keepRow(index)` keeps a
// row that has no text (a sheet row holding only a picture).
export function gridTable(grid, { keepRow = () => false } = {}) {
  const all = (grid || []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []));
  // Rows with nothing in them (Excel's `,,,` rows, a blank line) are not data.
  const filledAt = [];
  all.forEach((r, i) => { if (r.some((c) => c.trim() !== '') || (filledAt.length > 0 && keepRow(i))) filledAt.push(i); });
  if (filledAt.length === 0) return { headers: [], rows: [], renamed: [], dropped: 0, sheetRows: [], sheetCols: [] };
  const filled = filledAt.map((i) => all[i]);
  const [head, ...body] = filled;
  const width = Math.max(head.length, ...body.map((r) => r.length));
  // A leading apostrophe before = + - @ is a CSV writer's formula guard (ours on the problems
  // file, payroll.js csvCell), not part of the value.
  const cell = (r, i) => (r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
  // A column with no header and no value anywhere is a trailing artefact, not a field.
  const keep = [];
  for (let i = 0; i < width; i += 1) {
    if (cell(head, i) !== '' || body.some((r) => cell(r, i) !== '')) keep.push(i);
  }
  const seen = new Map();
  const renamed = [];
  const headers = keep.map((i, at) => {
    const h = cell(head, i);
    if (!h) return h;
    const k = h.toLowerCase();
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n === 1) return h;
    const to = `${h} (${n})`;
    renamed.push({ index: at, from: h, to });
    return to;
  });
  const rows = body.map((r) => keep.map((i) => cell(r, i)));
  return { headers, rows, renamed, dropped: width - keep.length, sheetRows: filledAt.slice(1), sheetCols: keep };
}

// Bytes → { text, encoding }. A byte-order mark decides; else the bytes are UTF-8 when they
// are VALID UTF-8, and Windows-1252 otherwise — Excel's plain "CSV" save, which writes "José"
// as the single byte E9 (decoded as UTF-8 it reads "Jos�"). The encoding is reported so
// the screen can say the file was read that way.
export function decodeCsvBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  const dec = (label, from = 0, fatal = false) => new TextDecoder(label, { fatal }).decode(bytes.subarray(from));
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { text: dec('utf-8', 3), encoding: 'utf-8' };
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: dec('utf-16le', 2), encoding: 'utf-16le' };
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    try { return { text: dec('utf-16be', 2), encoding: 'utf-16be' }; } catch { /* no UTF-16BE decoder: fall through */ }
  }
  try { return { text: dec('utf-8', 0, true), encoding: 'utf-8' }; } catch { /* not valid UTF-8 */ }
  try { return { text: dec('windows-1252'), encoding: 'windows-1252' }; } catch { /* no legacy decoder */ }
  return { text: dec('utf-8'), encoding: 'utf-8' };
}

// ── writing a file (the import's template and problems file) ───────────────────────────────
// RFC 4180 with Excel's habits: a byte-order mark so Excel reads it as UTF-8, and CRLF line
// ends. Every cell goes through the repo's one escaper, payroll.js `csvCell`: quoted, and
// 🔴 a text cell starting = + - @ TAB CR LF is written as text (a leading apostrophe). The
// problems file echoes back what someone typed into a spreadsheet, and Excel runs such a cell
// as a formula ("+1+cmd|…" too: a sign and a digit is no proof of a number). parseCsv reads
// the apostrophe back off, so a fixed problems file imports clean.
export function toCsvText(rows, { bom = true } = {}) {
  return `${bom ? '﻿' : ''}${(rows || []).map((r) => (r || []).map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ── shared normalizers (Add customer, Add contact and the lead webhook dedupe with these) ───

// Free/consumer email providers — never tie two contacts to one account by these.
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'proton.me', 'gmx.com', 'comcast.net', 'verizon.net', 'att.net',
]);

const COMPANY_SUFFIX_RE = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llp|lp|pllc|pc|group|holdings|enterprises)\b/g;

// Normalize a company name for matching: lowercase, drop punctuation + common
// legal suffixes, collapse whitespace. "Bellevue Tech Park, LLC" -> "bellevue tech park".
export function normalizeCompanyName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[.,&/\\'"()_-]/g, ' ')
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Phone -> bare digits, last 10 (US), for format-insensitive matching.
export function normalizePhone(phone) {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

export function emailDomain(email) {
  const m = /@([^@\s]+)$/.exec(String(email || '').toLowerCase().trim());
  return m ? m[1] : '';
}

// ── the lead webhook's person upsert (api/_lib/leads/upsert.js) ────────────────────────────
// Leading CRMs (GoHighLevel, HubSpot, Salesforce) treat an inbound lead as an UPSERT: match the
// person on a stable key, UPDATE the match (enrich without clobbering), CREATE only when nothing
// matches. We mirror that:
//   • People match on Contact ID -> email -> phone (first hit wins).
//   • Companies link to an existing account by normalized name or (non-free)
//     email domain — else a new account is created.
//   • Enrichment fills BLANK fields only; populated values are never overwritten,
//     and the match key (email) is never reassigned.

// A row of mapped values keyed by field. `mapping` is `{ columnIndex: fieldKey | null }`.
export function applyMapping(row, headers, mapping) {
  const out = {};
  for (const idx in mapping) {
    const fieldKey = mapping[idx];
    if (!fieldKey) continue;
    const val = (row[idx] ?? '').trim();
    if (val) out[fieldKey] = val;
  }
  return out;
}

// A lead is valid if at least one of these is non-empty: a person can arrive with just a phone,
// or just a name + company — or just a Contact ID when the sender echoes back our own id.
export const CONTACT_IDENTIFIER_KEYS = ['email', 'phone', 'firstName', 'lastName', 'company', 'id'];

// Lowercase the email (the person's key).
export function normalizeContact(raw) {
  const out = { ...raw };
  if (out.email) out.email = out.email.toLowerCase().trim();
  return out;
}

// Validate a row. Returns { valid: bool, reason?: string }.
// If email is provided, its format must be valid. Otherwise any one of
// CONTACT_IDENTIFIER_KEYS being non-empty is enough to accept the row.
export function validateContactRow(mapped) {
  if (mapped.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mapped.email)) return { valid: false, reason: 'Invalid email' };
    return { valid: true };
  }
  const hasAny = CONTACT_IDENTIFIER_KEYS.some((k) => mapped[k] && String(mapped[k]).trim());
  if (!hasAny) return { valid: false, reason: 'Need at least one of email, phone, name, or company' };
  return { valid: true };
}

function resolveAccount(mapped, { clientByNormName, clientByDomain, batchAccounts }) {
  const companyText = (mapped.company || '').trim();
  const normName = normalizeCompanyName(companyText);
  const domain = emailDomain(mapped.email);
  if (normName && clientByNormName.has(normName)) {
    const cl = clientByNormName.get(normName);
    return { id: cl.id, name: cl.name, isNew: false, via: 'name' };
  }
  if (domain && !FREE_EMAIL_DOMAINS.has(domain) && clientByDomain.has(domain)) {
    const cl = clientByDomain.get(domain);
    return { id: cl.id, name: cl.name, isNew: false, via: 'domain' };
  }
  if (companyText) {
    if (batchAccounts.has(normName)) return batchAccounts.get(normName);
    const acc = { id: null, name: companyText, normName, isNew: true, via: 'new' };
    batchAccounts.set(normName, acc);
    return acc;
  }
  return null;
}

// Fields filled on a matched contact — blanks only, never the match key (email), never a
// value that's already populated.
function computeEnrichment(existing, mapped, account) {
  const has = (v) => !!(v && String(v).trim());
  const changes = [];
  for (const field of ['firstName', 'lastName', 'title', 'phone', 'notes']) {
    if (has(mapped[field]) && !has(existing[field])) changes.push({ field, to: mapped[field] });
  }
  if (account && !existing.companyId) changes.push({ field: 'companyId', to: account });
  return changes;
}

// Plan every row against existing data. One record per row:
//   { rowIndex, mapped, action, matchedBy?, contactId?, account?, changes?, reason? }
//   action: 'create' | 'update' | 'skip' | 'invalid'
// mode: 'upsert' (create + update) | 'update' (update existing only, never create).
// `bulk` (optional): { tagIds: [...] } applied to every contact. A matched contact counts as an
// UPDATE (not a no-op skip) only when bulk would actually change it — a company tag it lacks.
export function buildImportPlan({ rows, headers, mapping, existingContacts = [], existingClients = [], mode = 'upsert', bulk = null }) {
  const clientById = new Map((existingClients || []).map((c) => [c.id, c]));
  const bulkAffects = (existing, account) => {
    if (!bulk) return false;
    // Tags are company-level — a bulk tag "adds" only if the contact's company
    // (or the contact itself, when company-less) doesn't already carry it.
    const companyId = (existing && existing.companyId) || (account && !account.isNew ? account.id : null);
    const company = companyId ? clientById.get(companyId) : null;
    const tags = company ? (company.tagIds || []) : ((existing && existing.tagIds) || []);
    return (bulk.tagIds || []).some((t) => !tags.includes(t));
  };
  const byId = new Map(), byEmail = new Map(), byPhone = new Map();
  for (const c of existingContacts) {
    if (c.id && !byId.has(c.id)) byId.set(c.id, c);
    const e = (c.email || '').toLowerCase().trim(); if (e && !byEmail.has(e)) byEmail.set(e, c);
    const p = normalizePhone(c.phone); if (p && !byPhone.has(p)) byPhone.set(p, c);
  }
  const clientByNormName = new Map(), clientByDomain = new Map();
  for (const cl of existingClients) {
    const n = normalizeCompanyName(cl.name); if (n && !clientByNormName.has(n)) clientByNormName.set(n, cl);
    const d = emailDomain(cl.email); if (d && !FREE_EMAIL_DOMAINS.has(d) && !clientByDomain.has(d)) clientByDomain.set(d, cl);
  }

  const seenEmail = new Set(), seenPhone = new Set(), batchAccounts = new Map();

  return rows.map((row, i) => {
    const mapped = normalizeContact(applyMapping(row, headers, mapping));
    const v = validateContactRow(mapped);
    if (!v.valid) return { rowIndex: i, mapped, action: 'invalid', reason: v.reason };

    const idKey = mapped.id;
    const emailKey = (mapped.email || '').toLowerCase().trim();
    const phoneKey = normalizePhone(mapped.phone);

    let match = null, matchedBy = null;
    if (idKey && byId.has(idKey)) { match = byId.get(idKey); matchedBy = 'Contact ID'; }
    else if (emailKey && byEmail.has(emailKey)) { match = byEmail.get(emailKey); matchedBy = 'email'; }
    else if (phoneKey && byPhone.has(phoneKey)) { match = byPhone.get(phoneKey); matchedBy = 'phone'; }

    const dupInFile = (emailKey && seenEmail.has(emailKey)) || (phoneKey && seenPhone.has(phoneKey));
    if (emailKey) seenEmail.add(emailKey);
    if (phoneKey) seenPhone.add(phoneKey);

    const account = resolveAccount(mapped, { clientByNormName, clientByDomain, batchAccounts });

    if (match) {
      const changes = computeEnrichment(match, mapped, account);
      // contactId on the skip too, so a no-op match (e.g. an idempotent webhook
      // re-post) can still report which existing contact it resolved to.
      if (!changes.length && !bulkAffects(match, account)) return { rowIndex: i, mapped, action: 'skip', matchedBy, contactId: match.id, reason: 'Already up to date' };
      return { rowIndex: i, mapped, action: 'update', matchedBy, contactId: match.id, account, changes };
    }
    if (dupInFile) return { rowIndex: i, mapped, action: 'skip', reason: 'Duplicate in file' };
    if (mode === 'update') return { rowIndex: i, mapped, action: 'skip', reason: 'No match. Update-only' };
    return { rowIndex: i, mapped, action: 'create', account };
  });
}
