// CSV parsing + column-to-field mapping.
// Handles quoted fields, escaped quotes (RFC-4180), CRLF/LF line endings,
// and missing trailing newline. No external deps.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // swallow — handled by \n
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // flush last field/row if present
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // strip empty trailing rows (common with trailing newlines)
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) {
    rows.pop();
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const [headers, ...dataRows] = rows;
  return {
    headers: headers.map((h) => h.trim()),
    rows: dataRows.map((r) => r.map((c) => c.trim())),
  };
}

// Heuristics for matching CSV header names to entity fields.
// Returns the entity-field key that best matches a header, or null.
export function guessField(header, fieldDefs) {
  const norm = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const def of fieldDefs) {
    for (const alias of def.aliases) {
      const a = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (norm === a) return def.key;
    }
  }
  // partial match — header contains alias or vice versa
  for (const def of fieldDefs) {
    for (const alias of def.aliases) {
      const a = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (a.length >= 4 && (norm.includes(a) || a.includes(norm))) return def.key;
    }
  }
  return null;
}

// Build a row of mapped values keyed by entity field.
// `mapping` is `{ csvColIndex: entityFieldKey | null }`.
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

export const CONTACT_FIELDS = [
  { key: 'firstName', label: 'First Name', aliases: ['first', 'firstname', 'first name', 'given name', 'fname'] },
  { key: 'lastName',  label: 'Last Name',  aliases: ['last', 'lastname', 'last name', 'surname', 'family name', 'lname'] },
  { key: 'email',     label: 'Email',      aliases: ['email', 'email address', 'e-mail', 'mail'] },
  { key: 'phone',     label: 'Phone',      aliases: ['phone', 'phone number', 'mobile', 'cell', 'tel', 'telephone'] },
  // Service-location address — the CUSTOMER'S one location, never the person (one
  // location per customer). Routed to the company's site on import (see
  // locationFromMapped); kept off the contact payload.
  { key: 'locStreet', label: 'Street',     aliases: ['street', 'address', 'street address', 'service address', 'mailing address', 'addr', 'address line 1', 'address1'] },
  { key: 'locCity',   label: 'City',       aliases: ['city', 'town'] },
  { key: 'locState',  label: 'State',      aliases: ['state', 'province', 'region'] },
  { key: 'locZip',    label: 'ZIP',        aliases: ['zip', 'zipcode', 'postal', 'postal code', 'postcode'] },
  { key: 'title',     label: 'Title',      aliases: ['title', 'job title', 'position', 'role'] },
  { key: 'company',   label: 'Company',    aliases: ['company', 'company name', 'account', 'organization', 'org'] },
  { key: 'type',      label: 'Type',    aliases: ['type', 'customer or vendor', 'lifecycle', 'stage', 'status', 'kind'] },
  { key: 'notes',     label: 'Notes',      aliases: ['notes', 'note', 'description', 'comment', 'comments'] },
  { key: 'id',        label: 'Contact ID', aliases: ['id', 'contact id', 'contactid', 'record id', 'recordid', 'ghl id'] },
];

// The service-location columns (a customer's single location, never the person).
export const LOCATION_FIELD_KEYS = ['locStreet', 'locCity', 'locState', 'locZip'];

// Pull the structured service address out of a mapped row. Returns null when the
// row carries no location column, so callers can skip the location entirely.
export function locationFromMapped(mapped) {
  const street = (mapped.locStreet || '').trim();
  const city = (mapped.locCity || '').trim();
  const state = (mapped.locState || '').trim();
  const zip = (mapped.locZip || '').trim();
  if (!street && !city && !state && !zip) return null;
  return { street, city, state, zip };
}

// A row is valid if at least one of these fields is non-empty.
// Mirrors GHL: people can be leads with just a phone, or just a name + company —
// or just a Contact ID when the file's purpose is to update existing records.
export const CONTACT_IDENTIFIER_KEYS = ['email', 'phone', 'firstName', 'lastName', 'company', 'id'];

// Normalize mapped values: lowercase the email, and coerce the company Type into
// Customer / Vendor. Only 'vendor' is special; legacy lifecycle values (lead /
// prospect / client) all describe a customer, so anything not 'vendor' becomes
// 'customer'. (Status Lead/Active is derived from real work, never imported.)
export function normalizeContact(raw) {
  const out = { ...raw };
  if (out.email) out.email = out.email.toLowerCase().trim();
  if (out.type) {
    out.type = out.type.toLowerCase().trim() === 'vendor' ? 'vendor' : 'customer';
  }
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

// Build a downloadable sample CSV that documents every supported column
// and demonstrates the variety of identifier combinations the importer accepts.
export function buildSampleContactCsv() {
  // Samples create NEW contacts, so omit the internal Contact ID column. Headers use
  // the human labels (Street/City/State/ZIP = the customer's service location);
  // guessField maps them back on re-import.
  const headers = CONTACT_FIELDS.filter((f) => f.key !== 'id').map((f) => f.label);
  const rows = [
    ['Pat', 'Ramirez', 'pat@evergreenmgmt.com', '555-0142', '500 SE 3rd Ave', 'Fort Lauderdale', 'FL', '33301', 'Property Manager', 'Evergreen Management', 'customer', 'Long-time customer; prefers Tuesday visits'],
    ['Morgan', 'Choi', 'morgan@lakesidehoa.org', '', '2000 E Las Olas Blvd', 'Fort Lauderdale', 'FL', '33301', 'Board President', 'Lakeside HOA', 'customer', ''],
    ['Sasha', 'Lin', '', '555-0188', '1 N Federal Hwy', 'Boca Raton', 'FL', '33432', 'Operations Lead', 'Mt Baker Hospitality', 'customer', 'Phone-only, no email'],
    ['Alex', 'Rivera', 'alex@sunshinesupply.com', '555-0199', '4000 NW 36th St', 'Miami', 'FL', '33142', 'Account Rep', 'Sunshine Supply Co', 'vendor', 'Cleaning-supplies vendor (kept out of sales views)'],
  ];
  const all = [headers, ...rows];
  return all
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

// ── Upsert matching (GHL-style) ──────────────────────────────────────────────
// Leading CRMs (GoHighLevel, HubSpot, Salesforce) treat CSV import as an UPSERT:
// match each row to an existing record on a stable key, UPDATE the match (enrich
// without clobbering), and CREATE only when nothing matches. We mirror that:
//   • People match on Contact ID -> email -> phone (first hit wins).
//   • Companies link to an existing account by normalized name or (non-free)
//     email domain — else a new account is created.
//   • Enrichment fills BLANK fields only; populated values are never overwritten,
//     and the match key (email) is never reassigned.

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

// Fields the importer will fill on a matched contact — blanks only, never the
// match key (email), never a value that's already populated.
function computeEnrichment(existing, mapped, account) {
  const has = (v) => !!(v && String(v).trim());
  const changes = [];
  for (const field of ['firstName', 'lastName', 'title', 'phone', 'notes']) {
    if (has(mapped[field]) && !has(existing[field])) changes.push({ field, to: mapped[field] });
  }
  if (account && !existing.companyId) changes.push({ field: 'companyId', to: account });
  return changes;
}

// Plan every parsed row against existing data. One record per row:
//   { rowIndex, mapped, action, matchedBy?, contactId?, account?, changes?, reason? }
//   action: 'create' | 'update' | 'skip' | 'invalid'
// mode: 'upsert' (create + update) | 'update' (update existing only, never create).
// `bulk` (optional) describes the bulk options applied to every imported contact:
//   { tagIds: [...] }
// A matched contact counts as an UPDATE (not a no-op skip) only when bulk would
// actually change it — a company tag it lacks. This keeps the preview honest vs.
// what apply does. (Deals are company Opportunities, placed on the Pipeline board,
// never a bulk side effect of importing a person, so there is no stage routing here.)
export function buildImportPlan({ rows, headers, mapping, existingContacts = [], existingClients = [], mode = 'upsert', bulk = null, requireCompany = false }) {
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
    // The customer's service-location address (null when the row has no location
    // columns). Rides the plan so the importer seeds it onto the company's site.
    const location = locationFromMapped(mapped);
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
      return { rowIndex: i, mapped, action: 'update', matchedBy, contactId: match.id, account, changes, location };
    }
    if (dupInFile) return { rowIndex: i, mapped, action: 'skip', reason: 'Duplicate in file' };
    if (mode === 'update') return { rowIndex: i, mapped, action: 'skip', reason: 'No match. Update-only' };
    // Company gate (B2B): a NEW contact must belong to a company. Block rows that
    // neither match nor create one — keeps imported data clean by construction.
    if (requireCompany && !account) return { rowIndex: i, mapped, action: 'invalid', reason: 'Missing company' };
    return { rowIndex: i, mapped, action: 'create', account, location };
  });
}
