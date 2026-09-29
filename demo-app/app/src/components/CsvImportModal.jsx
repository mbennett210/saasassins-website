import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import {
  parseCsv, guessField,
  CONTACT_FIELDS, LOCATION_FIELD_KEYS,
  buildImportPlan,
  buildSampleContactCsv,
} from '../lib/csv';
import { composeAddress } from '../lib/address';
import { newId } from '../lib/ids';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import Icon from './Icon';
import Select from './Select';
import TagPicker from './TagPicker';
import { IDENTITY } from '../brand/identity.generated.js';

const STEP = { UPLOAD: 'upload', MAP: 'map', OPTIONS: 'options', PREVIEW: 'preview', RESULT: 'result' };

const FIELD_LABEL = Object.fromEntries(CONTACT_FIELDS.map((f) => [f.key, f.label]));

// Visual treatment per disposition — kept inline so the modal is self-contained.
const ACTION_META = {
  create:  { label: 'New',     color: 'var(--success)', icon: 'plus' },
  update:  { label: 'Update',  color: 'var(--color-link)', icon: 'check' },
  skip:    { label: 'Skip',    color: 'var(--text-faint)', icon: 'warning' },
  invalid: { label: 'Invalid', color: 'var(--danger)', icon: 'x' },
};

// Human-readable note for a planned row.
function rowNote(r, hasBulk) {
  if (r.action === 'create') {
    const loc = r.location ? ` · location ${composeAddress(r.location)}` : '';
    if (!r.account) return `New contact${loc}`;
    return r.account.isNew
      ? `New contact · creates account “${r.account.name}”${loc}`
      : `New contact · links to ${r.account.name}${loc}`;
  }
  if (r.action === 'update') {
    const fills = (r.changes || []).filter((c) => c.field !== 'companyId').map((c) => FIELD_LABEL[c.field] || c.field);
    const linkChange = (r.changes || []).find((c) => c.field === 'companyId');
    const parts = [`Matched by ${r.matchedBy}`];
    if (fills.length) parts.push(`fills ${fills.join(', ')}`);
    if (linkChange) parts.push(`links ${linkChange.to.name}${linkChange.to.isNew ? ' (new)' : ''}`);
    if (!fills.length && !linkChange && hasBulk) parts.push('add company tag');
    return parts.join(' · ');
  }
  return r.reason || '';
}

export default function CsvImportModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();

  const [step, setStep] = useState(STEP.UPLOAD);
  const [parsed, setParsed] = useState({ headers: [], rows: [] });
  const [mapping, setMapping] = useState({});
  const [mode, setMode] = useState('upsert'); // 'upsert' (create + update) | 'update' (update only)
  // Bulk options applied to every imported contact (new + matched).
  const [bulkTagIds, setBulkTagIds] = useState([]);
  const [pasted, setPasted] = useState('');
  const [parseError, setParseError] = useState(null);
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (!open) return;
    setStep(STEP.UPLOAD);
    setParsed({ headers: [], rows: [] });
    setMapping({});
    setMode('upsert');
    setBulkTagIds([]);
    setPasted('');
    setParseError(null);
    setResults(null);
  }, [open]);

  const tagById = useMemo(() => Object.fromEntries((state.tags || []).map((t) => [t.id, t.label])), [state.tags]);

  const hasBulk = bulkTagIds.length > 0;

  const handleFile = (file) => {
    if (!file) return;
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setParseError(`File too large (max ${formatBytes(ATTACHMENT_MAX_BYTES)}).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => loadText(String(e.target.result || ''));
    reader.onerror = () => setParseError('Could not read file.');
    reader.readAsText(file);
  };

  const loadText = (text) => {
    setParseError(null);
    const result = parseCsv(text);
    if (!result.headers.length || !result.rows.length) {
      setParseError('No data found. Make sure the file has a header row and at least one data row.');
      return;
    }
    setParsed(result);
    // Auto-guess mapping
    const next = {};
    result.headers.forEach((h, idx) => {
      const guess = guessField(h, CONTACT_FIELDS);
      if (guess) next[idx] = guess;
    });
    setMapping(next);
    setStep(STEP.MAP);
  };

  // A Company column is required — every contact belongs to a company (B2B) —
  // plus at least one person identifier so rows can be matched or created.
  const companyMapped = Object.values(mapping).includes('company');
  const personMapped = ['email', 'phone', 'firstName', 'lastName', 'id'].some((k) => Object.values(mapping).includes(k));
  const mappingValid = companyMapped && personMapped;

  const downloadSample = () => {
    const csv = buildSampleContactCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${IDENTITY.slug}-contacts-sample.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // The import plan: every row's disposition vs. existing data, recomputed when
  // the file, mapping, mode, or bulk options change.
  const plan = useMemo(() => {
    if (step !== STEP.PREVIEW) return null;
    return buildImportPlan({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping,
      existingContacts: state.contacts || [],
      existingClients: state.clients || [],
      mode,
      requireCompany: true,
      bulk: hasBulk ? { tagIds: bulkTagIds } : null,
    });
  }, [parsed, mapping, mode, bulkTagIds, step, state]);

  const stats = useMemo(() => {
    const base = { create: 0, update: 0, skip: 0, invalid: 0 };
    if (!plan) return base;
    return plan.reduce((acc, r) => { acc[r.action]++; return acc; }, base);
  }, [plan]);

  // Columns shown in the preview table (the mapped fields, minus the internal id).
  const previewCols = useMemo(
    () => CONTACT_FIELDS.filter((f) => f.key !== 'id' && Object.values(mapping).includes(f.key)),
    [mapping]
  );

  const doImport = () => {
    if (!plan) return;
    const createdClientIds = new Map(); // normName -> id (one new account per company, batch-wide)
    const filledCompanyIds = new Set(); // companies whose blank location we've seeded this batch

    const ensureAccountId = (account, type, location) => {
      if (!account) return null;
      if (!account.isNew) return account.id;
      if (createdClientIds.has(account.normName)) return createdClientIds.get(account.normName);
      const id = newId('cl');
      // Type (Customer / Vendor) is the one manual company flag; Status (Lead /
      // Active) is derived, never stored. Contact # is allocated by the reducer.
      // Structured location columns ride on the client so ADD_CLIENT's
      // buildClientLocation seeds the customer's one location with its address.
      dispatch({ type: ACTIONS.ADD_CLIENT, client: { id, name: account.name, type: type === 'vendor' ? 'vendor' : 'customer', ...(location || {}) } });
      createdClientIds.set(account.normName, id);
      return id;
    };

    // Fill an EXISTING customer's BLANK location from the row — blanks only, never
    // overwrite; once per company per batch. A company created above already got its
    // address via ADD_CLIENT (its new site isn't in this render's `state` snapshot,
    // so the lookup no-ops for it). Vendors have no location.
    const fillLocationIfBlank = (companyId, location) => {
      if (!companyId || !location || filledCompanyIds.has(companyId)) return;
      filledCompanyIds.add(companyId);
      const site = (state.sites || []).find((s) => s.clientId === companyId);
      if (!site || (site.address && site.address.trim())) return;
      const { street, city, state: st, zip } = location;
      dispatch({ type: ACTIONS.UPDATE_SITE, id: site.id, patch: { street, city, state: st, zip, address: composeAddress({ street, city, state: st, zip }) } });
    };

    let created = 0, updated = 0;
    for (const r of plan) {
      if (r.action === 'create') {
        const companyId = ensureAccountId(r.account, r.mapped.type, r.location);
        fillLocationIfBlank(companyId, r.location); // existing company with a blank location
        const payload = { ...r.mapped };
        delete payload.company;
        delete payload.type; // Type is a company flag, applied to the account above, not the person
        delete payload.id; // never adopt a CSV-supplied value as our internal id on create
        delete payload.tagIds; // tags are company-level, applied below, not on the person
        for (const k of LOCATION_FIELD_KEYS) delete payload[k]; // address is the customer's LOCATION, never the person
        if (companyId) payload.companyId = companyId;
        dispatch({ type: ACTIONS.ADD_CONTACT, contact: payload });
        // Bulk tags go to the contact's company (every create now has one).
        if (bulkTagIds.length && companyId) {
          bulkTagIds.forEach((t) => dispatch({ type: ACTIONS.TAG_CLIENT, id: companyId, tagId: t }));
        }
        created++;
      } else if (r.action === 'update') {
        const existing = (state.contacts || []).find((c) => c.id === r.contactId);
        const patch = {};
        let companyId = existing?.companyId || null;
        for (const ch of r.changes) {
          if (ch.field === 'companyId') {
            const linked = ensureAccountId(ch.to, r.mapped.type, r.location);
            if (linked) { patch.companyId = linked; companyId = linked; }
          } else {
            patch[ch.field] = ch.to;
          }
        }
        fillLocationIfBlank(companyId, r.location); // seed the company's blank location
        // Bulk tags → company; fall back to the contact only if it's company-less.
        let taggedCompany = false;
        if (bulkTagIds.length) {
          if (companyId) {
            bulkTagIds.forEach((t) => dispatch({ type: ACTIONS.TAG_CLIENT, id: companyId, tagId: t }));
            taggedCompany = true;
          } else {
            const union = [...new Set([...((existing && existing.tagIds) || []), ...bulkTagIds])];
            if (union.length !== ((existing && existing.tagIds) || []).length) patch.tagIds = union;
          }
        }
        if (Object.keys(patch).length) {
          dispatch({ type: ACTIONS.UPDATE_CONTACT, id: r.contactId, patch });
          updated++;
        } else if (taggedCompany) {
          updated++;
        }
      }
    }

    const newClients = createdClientIds.size;
    setResults({ created, updated, skipped: stats.skip + stats.invalid, newClients, total: plan.length });
    setStep(STEP.RESULT);
    if (created || updated) {
      const bits = [];
      if (created) bits.push(`${created} added`);
      if (updated) bits.push(`${updated} updated`);
      if (newClients) bits.push(`${newClients} new compan${newClients === 1 ? 'y' : 'ies'}`);
      toast.success(bits.join(' · '));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import Contacts (CSV)" size="lg">
      {step === STEP.UPLOAD && (
        <div>
          <p className="text-sm text-muted" style={{ marginBottom: 6 }}>
            Upload a CSV with a header row, or paste rows below. Each row needs a{' '}
            <strong>company</strong>, plus at least one of <strong>email, phone, or name</strong>.{' '}
            Add <strong>Street, City, State, ZIP</strong> to set that customer’s service location.
          </p>
          <p className="text-xs text-muted" style={{ marginBottom: 6 }}>
            This is an <strong>upsert</strong>: each row is matched to an existing person by{' '}
            <strong>email → phone</strong> (or a <strong>Contact ID</strong> column) and{' '}
            <strong>updated</strong>. Blank fields are filled in, existing values are never overwritten.
            Unmatched rows are added. Companies link to an existing account by name or email domain, or are created.
            On the next steps you’ll choose what to apply (tags) and confirm.
          </p>
          <p className="text-xs" style={{ marginBottom: 14 }}>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); downloadSample(); }}
            >
              Download sample CSV ↓
            </a>
            <span className="text-muted"> · supported columns with example rows</span>
          </p>
          <label className="csv-dropzone">
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => handleFile(e.target.files?.[0])}
              style={{ display: 'none' }}
            />
            <Icon name="archive" size={32} />
            <div style={{ marginTop: 8, fontWeight: 600 }}>Click to choose a CSV file</div>
            <div className="text-xs text-muted">or drag and drop · max 5 MB</div>
          </label>
          <div style={{ margin: '14px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>or paste below</div>
          <textarea
            className="input"
            rows={6}
            placeholder={'firstName,lastName,email,phone,title,company,type,notes\nJane,Doe,jane@example.com,555-0100,Office Manager,Acme Co,customer,'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          {parseError && <div className="conflict-warning" style={{ marginTop: 10 }}><Icon name="warning" size={14} /><span>{parseError}</span></div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!pasted.trim()}
              onClick={() => loadText(pasted)}
            >
              Parse pasted text
            </button>
          </div>
        </div>
      )}

      {step === STEP.MAP && (
        <div>
          <p className="text-sm text-muted" style={{ marginBottom: 14 }}>
            Match each CSV column to a field. Columns set to <em>Skip</em> are ignored. Map a{' '}
            <strong>Contact ID</strong> column to update records exactly (e.g. re-importing an export).
          </p>
          <div className="csv-map-list">
            {parsed.headers.map((h, idx) => (
              <div key={idx} className="csv-map-row">
                <div className="csv-map-header">
                  <div className="text-sm font-semi">{h || <em className="text-muted">(empty)</em>}</div>
                  <div className="text-xs text-muted">{parsed.rows[0]?.[idx]?.slice(0, 40) || '—'}</div>
                </div>
                <Select
                  ariaLabel="CSV column mapping"
                  value={mapping[idx] || ''}
                  onChange={(v) => setMapping({ ...mapping, [idx]: v || null })}
                  options={[{ value: '', label: 'Skip' }, ...CONTACT_FIELDS.map((f) => ({ value: f.key, label: f.label }))]}
                />
              </div>
            ))}
          </div>
          {!mappingValid && (
            <div className="conflict-warning" style={{ marginTop: 10 }}>
              <Icon name="warning" size={14} />
              <span>Map a <strong>Company</strong> column (every contact belongs to a company), plus at least one of: Contact ID, Email, Phone, First Name, or Last Name.</span>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.UPLOAD)}>Back</button>
            <button type="button" className="btn btn-primary" disabled={!mappingValid} onClick={() => setStep(STEP.OPTIONS)}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === STEP.OPTIONS && (
        <div>
          <p className="text-sm text-muted" style={{ marginBottom: 14 }}>
            Apply these to <strong>every contact in this import</strong>. Both new ones and existing matches. All optional.
          </p>

          <div className="form-group">
            <label className="form-label">Add tags</label>
            <TagPicker value={bulkTagIds} onChange={setBulkTagIds} />
            <div className="text-xs text-muted" style={{ marginTop: 4 }}>Tags apply to each contact’s company, shared by everyone there.</div>
          </div>
          <div className="text-xs text-muted" style={{ marginTop: 10 }}>
            Deals live on the Pipeline board as company opportunities. Import the people here, then add a deal for a company from the board.
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.MAP)}>Back</button>
            <button type="button" className="btn btn-primary" onClick={() => setStep(STEP.PREVIEW)}>
              Preview ({parsed.rows.length} rows)
            </button>
          </div>
        </div>
      )}

      {step === STEP.PREVIEW && plan && (
        <div>
          <div className="csv-mode" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span className="text-xs text-muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>When importing</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className={`btn btn-sm ${mode === 'upsert' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setMode('upsert')}
              >
                Create &amp; update
              </button>
              <button
                type="button"
                className={`btn btn-sm ${mode === 'update' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setMode('update')}
              >
                Update only
              </button>
            </div>
            <span className="text-xs text-muted">
              {mode === 'upsert' ? 'Add new people and update existing ones.' : 'Only update existing people. Never create new records.'}
            </span>
          </div>

          {hasBulk && (
            <div className="text-xs" style={{ marginBottom: 10, padding: '8px 10px', background: 'var(--inset-bg)', borderRadius: 8 }}>
              <strong>Also applying to every imported contact:</strong>{' '}
              {bulkTagIds.length > 0 && <>Tags: {bulkTagIds.map((id) => tagById[id] || '?').join(', ')}</>}
            </div>
          )}

          <div className="csv-stats">
            <div className="csv-stat"><strong style={{ color: ACTION_META.create.color }}>{stats.create}</strong><span>New</span></div>
            <div className="csv-stat"><strong style={{ color: ACTION_META.update.color }}>{stats.update}</strong><span>Update</span></div>
            <div className="csv-stat"><strong style={{ color: ACTION_META.skip.color }}>{stats.skip}</strong><span>Skipped</span></div>
            <div className="csv-stat"><strong style={{ color: ACTION_META.invalid.color }}>{stats.invalid}</strong><span>Invalid</span></div>
          </div>

          <div className="csv-preview-wrap">
            <table className="csv-preview-table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Action</th>
                  {previewCols.map((f) => <th key={f.key}>{f.label}</th>)}
                  <th>What happens</th>
                </tr>
              </thead>
              <tbody>
                {plan.slice(0, 50).map((r) => {
                  const meta = ACTION_META[r.action];
                  return (
                    <tr key={r.rowIndex} className={`csv-row csv-row-${r.action}`}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: meta.color, fontWeight: 600, fontSize: 12 }}>
                          <Icon name={meta.icon} size={13} />{meta.label}
                        </span>
                      </td>
                      {previewCols.map((f) => (
                        <td key={f.key}>{r.mapped[f.key] || <span className="text-muted">—</span>}</td>
                      ))}
                      <td className="text-xs text-muted">{rowNote(r, hasBulk)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {plan.length > 50 && (
              <div className="text-xs text-muted" style={{ padding: '8px 12px', textAlign: 'center' }}>
                Showing first 50 of {plan.length} rows. All rows will be processed.
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.OPTIONS)}>Back</button>
            <button type="button" className="btn btn-primary" disabled={stats.create + stats.update === 0} onClick={doImport}>
              Apply{stats.create ? ` · ${stats.create} new` : ''}{stats.update ? ` · ${stats.update} updated` : ''}
            </button>
          </div>
        </div>
      )}

      {step === STEP.RESULT && results && (
        <div>
          <div className="csv-stats">
            <div className="csv-stat"><strong style={{ color: ACTION_META.create.color }}>{results.created}</strong><span>Added</span></div>
            <div className="csv-stat"><strong style={{ color: ACTION_META.update.color }}>{results.updated}</strong><span>Updated</span></div>
            <div className="csv-stat"><strong style={{ color: ACTION_META.skip.color }}>{results.skipped}</strong><span>Skipped</span></div>
            {results.newClients > 0 && (
              <div className="csv-stat"><strong style={{ color: ACTION_META.create.color }}>{results.newClients}</strong><span>New companies</span></div>
            )}
          </div>
          <p className="text-sm" style={{ marginTop: 14 }}>
            {results.created || results.updated
              ? `Done. ${results.created} contact${results.created === 1 ? '' : 's'} added and ${results.updated} updated${results.newClients > 0 ? `, ${results.newClients} new compan${results.newClients === 1 ? 'y' : 'ies'} created from company columns` : ''}.`
              : 'No records were changed.'}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
