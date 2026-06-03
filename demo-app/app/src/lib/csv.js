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
  { key: 'title',     label: 'Title',      aliases: ['title', 'job title', 'position', 'role'] },
  { key: 'company',   label: 'Company',    aliases: ['company', 'company name', 'account', 'organization', 'org'] },
  { key: 'lifecycle', label: 'Status',  aliases: ['lifecycle', 'stage', 'status', 'type'] },
  { key: 'notes',     label: 'Notes',      aliases: ['notes', 'note', 'description', 'comment', 'comments'] },
];

// A row is valid if at least one of these fields is non-empty.
// Mirrors GHL: people can be leads with just a phone, or just a name + company.
export const CONTACT_IDENTIFIER_KEYS = ['email', 'phone', 'firstName', 'lastName', 'company'];

// Normalize a value for a specific field. Coerces lifecycle into the canonical set,
// strips obvious garbage. Returns the cleaned value or null if invalid.
// Legacy 'customer' inputs (e.g. GHL exports) are mapped to 'client' so older
// CSVs keep importing cleanly after the nomenclature consolidation.
const VALID_LIFECYCLES = ['lead', 'prospect', 'client', 'vendor'];
export function normalizeContact(raw) {
  const out = { ...raw };
  if (out.email) out.email = out.email.toLowerCase().trim();
  if (out.lifecycle) {
    let lc = out.lifecycle.toLowerCase().trim();
    if (lc === 'customer') lc = 'client';
    out.lifecycle = VALID_LIFECYCLES.includes(lc) ? lc : 'lead';
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
  const headers = CONTACT_FIELDS.map((f) => f.key);
  const rows = [
    ['Pat', 'Ramirez', 'pat@evergreenmgmt.com', '555-0142', 'Property Manager', 'Evergreen Management', 'client', 'Long-time client; prefers Tuesday visits'],
    ['Morgan', 'Choi', 'morgan@lakesidehoa.org', '', 'Board President', 'Lakeside HOA', 'prospect', ''],
    ['Sasha', 'Lin', '', '555-0188', 'Operations Lead', 'Mt Baker Hospitality', 'lead', 'Phone-only — referred by Lee Thompson'],
  ];
  const all = [headers, ...rows];
  return all
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
