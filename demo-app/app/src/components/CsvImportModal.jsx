import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import {
  parseCsv, guessField, applyMapping,
  CONTACT_FIELDS, CONTACT_IDENTIFIER_KEYS,
  normalizeContact, validateContactRow,
  buildSampleContactCsv,
} from '../lib/csv';
import { newId } from '../lib/ids';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import Icon from './Icon';
import Select from './Select';

const STEP = { UPLOAD: 'upload', MAP: 'map', PREVIEW: 'preview', RESULT: 'result' };

export default function CsvImportModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();

  const [step, setStep] = useState(STEP.UPLOAD);
  const [parsed, setParsed] = useState({ headers: [], rows: [] });
  const [mapping, setMapping] = useState({});
  const [pasted, setPasted] = useState('');
  const [parseError, setParseError] = useState(null);
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (!open) return;
    setStep(STEP.UPLOAD);
    setParsed({ headers: [], rows: [] });
    setMapping({});
    setPasted('');
    setParseError(null);
    setResults(null);
  }, [open]);

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

  // At least one identifier column must be mapped — otherwise no row can be valid.
  const mappingValid = CONTACT_IDENTIFIER_KEYS.some((k) => Object.values(mapping).includes(k));

  const downloadSample = () => {
    const csv = buildSampleContactCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sample-contacts.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const previewRows = useMemo(() => {
    if (step !== STEP.PREVIEW && step !== STEP.MAP) return null;
    const existing = new Set((state.contacts || []).map((c) => (c.email || '').toLowerCase()).filter(Boolean));
    const seenInBatch = new Set();
    return parsed.rows.map((row, i) => {
      const mapped = normalizeContact(applyMapping(row, parsed.headers, mapping));
      const validation = validateContactRow(mapped);
      let status = validation.valid ? 'ok' : 'invalid';
      let reason = validation.reason || null;
      if (validation.valid) {
        const email = (mapped.email || '').toLowerCase();
        if (email) {
          if (existing.has(email)) { status = 'duplicate'; reason = 'Already exists'; }
          else if (seenInBatch.has(email)) { status = 'duplicate'; reason = 'Duplicate in file'; }
          else { seenInBatch.add(email); reason = null; }
        } else {
          reason = 'No email — dedup skipped';
        }
      }
      return { rowIndex: i, mapped, status, reason };
    });
  }, [parsed, mapping, step, state]);

  const stats = useMemo(() => {
    if (!previewRows) return { ok: 0, duplicate: 0, invalid: 0 };
    return previewRows.reduce((acc, r) => { acc[r.status]++; return acc; }, { ok: 0, duplicate: 0, invalid: 0 });
  }, [previewRows]);

  const doImport = () => {
    if (!previewRows) return;
    // Pre-build a lowercase-keyed map of existing clients; track clients created
    // during this batch so the same company name across many rows yields one new client.
    const clientByName = new Map(
      (state.clients || []).map((c) => [c.name.toLowerCase().trim(), c.id])
    );
    const newClientIds = new Map(); // nameLower -> id

    let imported = 0;
    let newClientsCreated = 0;

    for (const row of previewRows) {
      if (row.status !== 'ok') continue;

      const companyRaw = row.mapped.company;
      let companyId = null;
      if (companyRaw) {
        const key = companyRaw.toLowerCase().trim();
        if (clientByName.has(key)) {
          companyId = clientByName.get(key);
        } else if (newClientIds.has(key)) {
          companyId = newClientIds.get(key);
        } else {
          // Spillover: contact references a company we don't have yet — create the client.
          const id = newId('cl');
          dispatch({ type: ACTIONS.ADD_CLIENT, client: { id, name: companyRaw.trim() } });
          newClientIds.set(key, id);
          companyId = id;
          newClientsCreated++;
        }
      }

      const payload = { ...row.mapped };
      delete payload.company;
      if (companyId) payload.companyId = companyId;
      dispatch({ type: ACTIONS.ADD_CONTACT, contact: payload });
      imported++;
    }

    setResults({
      imported,
      skipped: previewRows.length - imported,
      total: previewRows.length,
      newClientsCreated,
    });
    setStep(STEP.RESULT);
    if (imported > 0) {
      const msg = newClientsCreated > 0
        ? `Imported ${imported} contact${imported === 1 ? '' : 's'} · ${newClientsCreated} new client${newClientsCreated === 1 ? '' : 's'}`
        : `Imported ${imported} contact${imported === 1 ? '' : 's'}`;
      toast.success(msg);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import Contacts (CSV)" size="lg">
      {step === STEP.UPLOAD && (
        <div>
          <p className="text-sm text-muted" style={{ marginBottom: 6 }}>
            Upload a CSV file with a header row. Each contact needs at least one of: <strong>email, phone, first name, last name, or company</strong>.
          </p>
          <p className="text-xs text-muted" style={{ marginBottom: 6 }}>
            Duplicates are matched by email — rows without an email skip the duplicate check.
          </p>
          <p className="text-xs" style={{ marginBottom: 14 }}>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); downloadSample(); }}
            >
              Download sample CSV ↓
            </a>
            <span className="text-muted"> · all 8 supported columns with example rows</span>
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
          <div style={{ margin: '14px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>— or paste below —</div>
          <textarea
            className="input"
            rows={6}
            placeholder={'firstName,lastName,email,phone,title,company,lifecycle,notes\nJane,Doe,jane@example.com,555-0100,Office Manager,Acme Co,prospect,'}
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
            Match each CSV column to a field. Columns set to <em>— Skip —</em> are ignored.
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
                  options={[{ value: '', label: '— Skip —' }, ...CONTACT_FIELDS.map((f) => ({ value: f.key, label: f.label }))]}
                />
              </div>
            ))}
          </div>
          {!mappingValid && (
            <div className="conflict-warning" style={{ marginTop: 10 }}>
              <Icon name="warning" size={14} />
              <span>Map at least one of: Email, Phone, First Name, Last Name, or Company — otherwise no rows can be imported.</span>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.UPLOAD)}>Back</button>
            <button type="button" className="btn btn-primary" disabled={!mappingValid} onClick={() => setStep(STEP.PREVIEW)}>
              Preview ({parsed.rows.length} rows)
            </button>
          </div>
        </div>
      )}

      {step === STEP.PREVIEW && previewRows && (
        <div>
          <div className="csv-stats">
            <div className="csv-stat ok">
              <strong>{stats.ok}</strong>
              <span>Ready to import</span>
            </div>
            <div className="csv-stat dup">
              <strong>{stats.duplicate}</strong>
              <span>Duplicates (skipped)</span>
            </div>
            <div className="csv-stat err">
              <strong>{stats.invalid}</strong>
              <span>Invalid (skipped)</span>
            </div>
          </div>
          <div className="csv-preview-wrap">
            <table className="csv-preview-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  {CONTACT_FIELDS.map((f) => (
                    Object.values(mapping).includes(f.key)
                      ? <th key={f.key}>{f.label}</th>
                      : null
                  ))}
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.slice(0, 50).map((r) => (
                  <tr key={r.rowIndex} className={`csv-row csv-row-${r.status}`}>
                    <td>
                      {r.status === 'ok' && <Icon name="check" size={14} />}
                      {r.status === 'duplicate' && <Icon name="warning" size={14} />}
                      {r.status === 'invalid' && <Icon name="x" size={14} />}
                    </td>
                    {CONTACT_FIELDS.map((f) => (
                      Object.values(mapping).includes(f.key)
                        ? <td key={f.key}>{r.mapped[f.key] || <span className="text-muted">—</span>}</td>
                        : null
                    ))}
                    <td className="text-xs text-muted">{r.reason || (r.status === 'ok' ? 'OK' : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {previewRows.length > 50 && (
              <div className="text-xs text-muted" style={{ padding: '8px 12px', textAlign: 'center' }}>
                Showing first 50 of {previewRows.length} rows. All rows will be processed.
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.MAP)}>Back</button>
            <button type="button" className="btn btn-primary" disabled={stats.ok === 0} onClick={doImport}>
              Import {stats.ok} {stats.ok === 1 ? 'contact' : 'contacts'}
            </button>
          </div>
        </div>
      )}

      {step === STEP.RESULT && results && (
        <div>
          <div className="csv-stats">
            <div className="csv-stat ok">
              <strong>{results.imported}</strong>
              <span>Imported</span>
            </div>
            <div className="csv-stat dup">
              <strong>{results.skipped}</strong>
              <span>Skipped</span>
            </div>
            {results.newClientsCreated > 0 && (
              <div className="csv-stat ok">
                <strong>{results.newClientsCreated}</strong>
                <span>New clients</span>
              </div>
            )}
          </div>
          <p className="text-sm" style={{ marginTop: 14 }}>
            {results.imported > 0
              ? `Successfully added ${results.imported} new contact${results.imported === 1 ? '' : 's'}${results.newClientsCreated > 0 ? ` and created ${results.newClientsCreated} new client${results.newClientsCreated === 1 ? '' : 's'} from company columns` : ''}.`
              : 'No new records were added.'}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
