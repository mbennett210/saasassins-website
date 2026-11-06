import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import TagPicker from './TagPicker';
import Badge from './Badge';
import Icon from './Icon';
import ListPager from './ListPager';
import { useToast } from './Toast';
import { usePagedRows } from '../hooks/usePagedRows';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useDispatch, useStore } from '../store';
import { ACTIONS, reducer } from '../store/reducer';
import { selectClientStatus } from '../store/selectors';
import { serializeSharedBlob } from '../store/tableSlices';
import { decodeCsvBytes, parseCsv } from '../lib/csv';
import {
  IMPORT_FIELDS, CONTACT_FIELD_KEYS, TEMPLATE_HEADERS, guessImportMapping, isBillingHeader,
  importPermissions, planCustomerImport, prepareImport, commitImport, importedLocations,
  locatableLocations, locateResults, importProblemsCsv, customerTemplateCsv,
} from '../lib/customerImport';
import { geocodeAddress } from '../lib/geoApi';
import { GEOCODE_STATUS, GEOCODE_MAX_PER_RUN, resolveGeocodeMany } from '../lib/geocodeLocation';
import { formatStateBytes } from '../lib/stateBudget';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { newId } from '../lib/ids';
import { IDENTITY } from '../brand/identity.generated.js';
import { useT } from '../i18n/react';
import { msg } from '../i18n/core';

// Customers → Import customers: one row is one BUILDING (lib/customerImport.js holds every rule;
// this screen only walks it). File → columns → a dry-run preview → the import, written as ONE
// store action after the shared record's size is checked (commitImport), then the buildings are
// located a hundred at a time. Cancel at any step before Import writes nothing.
const STEP = { FILE: 'file', COLUMNS: 'columns', PREVIEW: 'preview', DONE: 'done' };
const STATUS_BADGE = {
  create: ['green', 'custImport.status.create'],
  update: ['blue', 'custImport.status.update'],
  unchanged: ['slate', 'custImport.status.unchanged'],
  same: ['purple', 'custImport.status.same'],
  error: ['red', 'custImport.status.error'],
};
// Row filters (rows, not customers). "Same customer" shows only when the file repeats a building.
const FILTERS = [
  { key: 'all', labelKey: 'custImport.filter.all' },
  { key: 'create', labelKey: 'custImport.filter.create' },
  { key: 'update', labelKey: 'custImport.filter.update' },
  { key: 'unchanged', labelKey: 'custImport.filter.unchanged' },
  { key: 'same', labelKey: 'custImport.filter.same', onlyWhenAny: true },
  { key: 'problems', labelKey: 'custImport.filter.problems' },
];
const matchesFilter = (r, f) => (f === 'all' ? true
  : f === 'problems' ? (r.errors.length > 0 || r.warnings.length > 0) : r.status === f);
// The paste box's example: the template's own column names, which the import reads as written.
const PASTE_EXAMPLE = `${TEMPLATE_HEADERS.slice(0, 8).join(',')}\n0101,Harbor View Towers,Customer,Active,1200 N Ocean Blvd,Pompano Beach,FL,33062`; // i18n-ok: column names the import matches, and a sample row
const applyOps = (s, ops) => reducer(s, { type: ACTIONS.IMPORT_CUSTOMERS, ops });

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CsvImportModal({ open, onClose }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEditClients = usePermission('clients.edit');
  const canEditContacts = usePermission('contacts.edit');
  const perms = useMemo(() => importPermissions({
    role: currentUser?.role,
    holds: (k) => (k === 'clients.edit' ? canEditClients : k === 'contacts.edit' ? canEditContacts : false),
  }), [currentUser?.role, canEditClients, canEditContacts]);

  const [step, setStep] = useState(STEP.FILE);
  const [file, setFile] = useState(null); // { headers, rows, delimiter, renamed, encoding, name }
  const [mapping, setMapping] = useState({});
  const [pasted, setPasted] = useState('');
  const [readError, setReadError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [tagIds, setTagIds] = useState([]);
  const [filter, setFilter] = useState('all');
  const [verdict, setVerdict] = useState(null); // the size check for the plan on screen
  const [refusal, setRefusal] = useState(null);
  const [result, setResult] = useState(null);
  const [imported, setImported] = useState(null); // the plan as it was imported (the "done" step)
  const [locating, setLocating] = useState(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!open) return;
    setStep(STEP.FILE); setFile(null); setMapping({}); setPasted(''); setReadError(null);
    setTagIds([]); setFilter('all'); setVerdict(null); setRefusal(null); setResult(null); setImported(null);
    busy.current = false;
  }, [open]);

  // Fields this person may fill: the server refuses contacts without "Create / edit contacts"
  // and a supervisor from anyone but a Super Admin or Admin, so those are not offered at all.
  const allowed = useMemo(() => new Set(IMPORT_FIELDS.filter((f) => (f.group !== 'contact' || perms.canContacts)
    && (f.group !== 'supervisor' || perms.canAssignSupervisor)).map((f) => f.key)), [perms]);

  const read = (text, extra = {}) => {
    setReadError(null);
    const parsed = parseCsv(text);
    if (!parsed.headers.length || !parsed.rows.length) { setReadError(msg('custImport.err.empty')); return; }
    const guessed = guessImportMapping(parsed.headers);
    const kept = Object.fromEntries(Object.entries(guessed).filter(([, key]) => allowed.has(key)));
    setFile({ ...parsed, encoding: 'utf-8', ...extra, guessed });
    setMapping(kept);
    setStep(STEP.COLUMNS);
  };
  const readFile = async (f) => {
    if (!f) return;
    if (f.size > ATTACHMENT_MAX_BYTES) { setReadError(msg('custImport.err.fileTooLarge', { size: formatBytes(ATTACHMENT_MAX_BYTES) })); return; }
    try {
      const { text, encoding } = decodeCsvBytes(new Uint8Array(await f.arrayBuffer()));
      read(text, { encoding, name: f.name });
    } catch { setReadError(msg('custImport.err.unreadable')); }
  };

  const nameMapped = Object.values(mapping).includes('name');
  const setField = (idx, key) => setMapping((prev) => {
    const next = {};
    for (const [i, k] of Object.entries(prev)) if (k !== key && Number(i) !== idx) next[i] = k;
    if (key) next[idx] = key;
    return next;
  });
  const fieldOptions = useMemo(() => [
    { value: '', label: t('custImport.skip') },
    ...IMPORT_FIELDS.filter((f) => allowed.has(f.key)).map((f) => ({ value: f.key, label: t(f.labelKey) })),
  ], [allowed, t]);

  // The dry run: what each row WOULD do, against the book as it is right now. Writes nothing.
  // Once imported, the "done" step keeps the plan as it was imported (re-planned against the new
  // book, every row would read "unchanged").
  const plan = useMemo(() => {
    if (step === STEP.DONE) return imported;
    if (!file || step !== STEP.PREVIEW) return null;
    // statusOf: the store's own status rule, so a new person under a customer already on file
    // takes the lifecycle that follows the status the customer page shows.
    return planCustomerImport({ headers: file.headers, rows: file.rows, mapping, state, perms, tagIds, statusOf: (c) => selectClientStatus(state, c) });
  }, [file, mapping, state, perms, tagIds, step, imported]);

  // The size check runs a moment after the preview settles: it applies the import to a copy of
  // the shared record and measures it, which is too heavy to repeat on every keystroke.
  useEffect(() => {
    if (step !== STEP.PREVIEW || !plan) return undefined;
    setVerdict(null); setRefusal(null);
    const id = setTimeout(() => {
      const prepared = prepareImport({ state, plan, newId, applyOps, serialize: serializeSharedBlob });
      setVerdict(prepared.verdict);
      setRefusal(prepared.refusal);
    }, 250);
    return () => clearTimeout(id);
  }, [plan, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowsShown = useMemo(() => (plan ? plan.rows.filter((r) => matchesFilter(r, filter)) : []), [plan, filter]);
  const pager = usePagedRows(rowsShown, { resetKey: filter });

  const downloadProblems = () => {
    if (!plan || !file) return;
    download(importProblemsCsv({ plan, headers: file.headers, render: (m) => t(m) }), `${IDENTITY.slug}-import-problems.csv`);
  };

  // Locate buildings a hundred at a time through the bounded geocoder; with no Maps key it stops
  // at the first "unavailable" answer instead of asking a hundred times. The run's answers are
  // ONE action (one pending entry, one save even when a refused save is replayed action by
  // action, CS-008), each applied only while its building still has the address looked up.
  // A lookup the server REFUSED (CS-083: this sign-in's hourly allowance, or the company's daily
  // quota) stops the run too; the refused buildings get no answer, so they stay waiting for the
  // next press, and the panel says which refusal it was and, for the hourly one, when.
  const locate = async (items) => {
    if (!items.length) return;
    setLocating({ running: true, count: Math.min(items.length, GEOCODE_MAX_PER_RUN) });
    const res = await resolveGeocodeMany(items, { geocode: geocodeAddress, stopWhenUnavailable: true });
    if (res.patches.length) dispatch({ type: ACTIONS.LOCATE_BUILDINGS, results: locateResults(items, res.patches) });
    const count = (s) => res.patches.filter((p) => p.patch.geocodeStatus === s).length;
    setLocating({
      running: false,
      located: count(GEOCODE_STATUS.LOCATED),
      notFound: count(GEOCODE_STATUS.NOT_LOCATED),
      unavailable: res.stoppedUnavailable || count(GEOCODE_STATUS.UNAVAILABLE) > 0,
      limited: res.stoppedLimited ? {
        quota: res.limitCode === 'lookup-quota',
        minutes: res.retryAfterMs ? Math.max(1, Math.ceil(res.retryAfterMs / 60000)) : null,
      } : null,
    });
  };
  const waiting = useMemo(() => (open ? locatableLocations(state) : []), [open, state]);

  const doImport = () => {
    if (!plan || busy.current) return;
    busy.current = true;
    const committed = commitImport({
      state, plan, newId, applyOps, serialize: serializeSharedBlob, dispatch, actionType: ACTIONS.IMPORT_CUSTOMERS,
    });
    busy.current = false;
    if (committed.refusal) { setRefusal(committed.refusal); setVerdict(committed.verdict); return; }
    const c = plan.customers;
    setResult({ ...c, error: plan.counts.error, contacts: plan.contacts });
    setImported(plan);
    setStep(STEP.DONE);
    toast.success(t('custImport.toastDone', { created: c.create, updated: c.update }));
    locate(importedLocations(committed.ops, committed.verdict?.stateAfter));
  };

  const problems = plan ? plan.rows.filter((r) => r.errors.length || r.warnings.length).length : 0;
  // Rows (the filters, "not imported", "with a note") and customers (the totals, the button).
  const counts = plan?.counts || { create: 0, update: 0, unchanged: 0, same: 0, error: 0, warning: 0 };
  const customers = plan?.customers || { create: 0, update: 0, unchanged: 0 };
  const toWrite = customers.create + customers.update;
  const billing = file ? file.headers.filter((h) => isBillingHeader(h)) : [];
  const guessedOut = file ? Object.values(file.guessed || {}).filter((k) => !allowed.has(k)) : [];

  const locatePanel = (
    <div className="csv-locate">
      {locating?.running && <p className="text-sm">{t('custImport.locating', { count: locating.count })}</p>}
      {locating && !locating.running && (
        <>
          {locating.located > 0 && <p className="text-sm">{t('custImport.located', { count: locating.located })}</p>}
          {locating.notFound > 0 && <p className="text-sm">{t('custImport.notFound', { count: locating.notFound })}</p>}
          {locating.unavailable && <div className="callout callout-info">{t('custImport.lookupUnavailable')}</div>}
          {locating.limited && (
            <div className="callout callout-info csv-notes">
              <p>{locating.limited.quota ? t('custImport.lookupQuota') : t('custImport.lookupLimited')}</p>
              {!locating.limited.quota && locating.limited.minutes && <p>{t('custImport.lookupRetry', { count: locating.limited.minutes })}</p>}
            </div>
          )}
        </>
      )}
      {/* After an "unavailable" answer there is nobody to ask: no button until the import is opened
          again. A refused run keeps it: the waiting buildings are asked again on the next press. */}
      {!locating?.running && !locating?.unavailable && waiting.length > 0 && (
        <div className="csv-locate-row">
          <span className="text-sm text-muted">{t('custImport.notLocatedYet', { count: waiting.length })}</span>
          <button type="button" className="btn btn-secondary" onClick={() => locate(waiting)}>
            {t('custImport.locateNext', { count: Math.min(waiting.length, GEOCODE_MAX_PER_RUN) })}
          </button>
        </div>
      )}
    </div>
  );

  if (!perms.canImport) {
    return (
      <Modal open={open} onClose={onClose} title={t('custImport.title')} size="lg">
        <p className="text-sm">{t('custImport.notPermitted')}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t('custImport.title')} size="lg">
      {step === STEP.FILE && (
        <div className="csv-step">
          <p className="text-sm text-muted">{t('custImport.lead')}</p>
          <div className="csv-template-row">
            <button type="button" className="btn btn-link" onClick={() => download(customerTemplateCsv(), `${IDENTITY.slug}-customers-template.csv`)}>
              {t('custImport.template')}
            </button>
            <span className="text-xs text-muted">{t('custImport.templateHint')}</span>
          </div>
          <label
            className={`csv-dropzone ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer?.files?.[0]); }}
          >
            <input type="file" className="csv-file-input" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => readFile(e.target.files?.[0])} />
            <Icon name="upload" size={28} />
            <span className="csv-drop-title">{t('custImport.drop')}</span>
            <span className="text-xs text-muted">{t('custImport.dropHint', { size: formatBytes(ATTACHMENT_MAX_BYTES) })}</span>
          </label>
          <label className="form-label" htmlFor="csv-paste">{t('custImport.paste')}</label>
          <textarea id="csv-paste" className="input csv-paste" rows={5} placeholder={PASTE_EXAMPLE} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          {readError && <div className="conflict-warning"><Icon name="warning" size={14} /><span>{t(readError)}</span></div>}
          {locatePanel}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={!pasted.trim()} onClick={() => read(pasted)}>{t('custImport.readPasted')}</button>
          </div>
        </div>
      )}

      {step === STEP.COLUMNS && file && (
        <div className="csv-step">
          <p className="text-sm text-muted">{t('custImport.mapLead', { count: file.rows.length })}</p>
          {(file.encoding === 'windows-1252' || file.delimiter !== ',' || file.renamed?.length > 0 || billing.length > 0 || guessedOut.length > 0) && (
            <div className="callout callout-info csv-notes">
              {file.encoding === 'windows-1252' && <p>{t('custImport.readAs1252')}</p>}
              {file.delimiter === ';' && <p>{t('custImport.readSemicolon')}</p>}
              {file.delimiter === '\t' && <p>{t('custImport.readTab')}</p>}
              {file.renamed?.length > 0 && <p>{t('custImport.renamedHeaders', { columns: file.renamed.map((r) => r.to) })}</p>}
              {billing.length > 0 && <p>{t('custImport.billingSkipped', { columns: billing })}</p>}
              {guessedOut.some((k) => CONTACT_FIELD_KEYS.includes(k)) && <p>{t('custImport.contactsNotAllowed')}</p>}
              {guessedOut.includes('supervisor') && <p>{t('custImport.supervisorNotAllowed')}</p>}
            </div>
          )}
          <div className="csv-map-list">
            {file.headers.map((h, idx) => (
              <div key={idx} className="csv-map-row">
                <div className="csv-map-header">
                  <div className="text-sm font-semi truncate" title={h}>{h || t('custImport.emptyHeader')}</div>
                  <div className="text-xs text-muted truncate">{file.rows.find((r) => r[idx])?.[idx] || '—'}</div>
                </div>
                <Select
                  ariaLabel={t('custImport.mapAria', { column: h || t('custImport.emptyHeader') })}
                  value={mapping[idx] || ''}
                  onChange={(v) => setField(idx, v || '')}
                  options={fieldOptions}
                />
              </div>
            ))}
          </div>
          {!nameMapped && <div className="conflict-warning"><Icon name="warning" size={14} /><span>{t('custImport.needName')}</span></div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.FILE)}>{t('custImport.back')}</button>
            <button type="button" className="btn btn-primary" disabled={!nameMapped} onClick={() => setStep(STEP.PREVIEW)}>{t('custImport.toPreview')}</button>
          </div>
        </div>
      )}

      {step === STEP.PREVIEW && plan && (
        <div className="csv-step">
          <div className="csv-stats">
            <div className="csv-stat tone-create"><strong>{customers.create}</strong><span>{t('custImport.stat.create')}</span></div>
            <div className="csv-stat tone-update"><strong>{customers.update}</strong><span>{t('custImport.stat.update')}</span></div>
            <div className="csv-stat"><strong>{customers.unchanged}</strong><span>{t('custImport.stat.unchanged')}</span></div>
            <div className="csv-stat tone-error"><strong>{counts.error}</strong><span>{t('custImport.stat.error')}</span></div>
            <div className="csv-stat tone-warning"><strong>{counts.warning}</strong><span>{t('custImport.stat.warning')}</span></div>
          </div>
          {counts.same > 0 && <p className="text-xs text-muted">{t('custImport.sameRows', { count: counts.same })}</p>}
          <p className="text-xs text-muted">{t('custImport.contactsPlanned', { added: plan.contacts.create, updated: plan.contacts.update })}</p>
          {refusal
            ? <div className="callout callout-danger">{t(refusal)}</div>
            : <p className="text-xs text-muted">{verdict
              ? t('custImport.size', { after: formatStateBytes(verdict.after), limit: formatStateBytes(verdict.limit) })
              : t('custImport.sizeChecking')}</p>}
          <div className="form-group">
            <label className="form-label">{t('custImport.tags')}</label>
            <TagPicker value={tagIds} onChange={setTagIds} />
            <div className="form-help">{t('custImport.tagsHint')}</div>
          </div>
          <div className="csv-filter" role="group" aria-label={t('custImport.filterAria')}>
            {FILTERS.map((f) => {
              const n = plan.rows.filter((r) => matchesFilter(r, f.key)).length;
              if (f.onlyWhenAny && n === 0) return null;
              return (
                <button key={f.key} type="button" className={`chip chip-sm ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
                  {t(f.labelKey)} <span className="control-count">{n}</span>
                </button>
              );
            })}
          </div>
          <div className="table-wrap mobile-stack csv-preview">
            <table>
              <thead>
                <tr>
                  <th>{t('custImport.col.row')}</th>
                  <th>{t('custImport.col.customer')}</th>
                  <th>{t('custImport.col.location')}</th>
                  <th>{t('custImport.col.result')}</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((r) => {
                  const [variant, key] = STATUS_BADGE[r.status];
                  return (
                    <tr key={r.line}>
                      <td data-label={t('custImport.col.row')} className="csv-line">{r.line}</td>
                      <td className="cell-primary"><span className="truncate" title={r.label}>{r.label || '—'}</span></td>
                      <td data-label={t('custImport.col.location')}><span className="truncate" title={r.address}>{r.address || '—'}</span></td>
                      <td data-label={t('custImport.col.result')} className="csv-result-cell">
                        <div className="csv-result">
                          <Badge variant={variant}>{t(key)}</Badge>
                          <ul className="csv-result-lines">
                            {r.errors.map((m, i) => <li key={`e${i}`} className="text-danger">{t(m)}</li>)}
                            {r.changes.map((m, i) => <li key={`c${i}`}>{t(m)}</li>)}
                            {r.warnings.map((m, i) => <li key={`w${i}`} className="csv-warn">{t(m)}</li>)}
                          </ul>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('custImport.rowsNoun')} />
          <div className="modal-actions">
            {problems > 0 && <button type="button" className="btn btn-secondary csv-problems-btn" onClick={downloadProblems}>{t('custImport.download')}</button>}
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.COLUMNS)}>{t('custImport.back')}</button>
            <button type="button" className="btn btn-primary" disabled={!verdict || !!refusal || toWrite === 0} onClick={doImport}>
              {toWrite === 0 ? t('custImport.nothingToImport') : t('custImport.importN', { count: toWrite })}
            </button>
          </div>
        </div>
      )}

      {step === STEP.DONE && result && (
        <div className="csv-step">
          <p className="text-sm font-semi">{t('custImport.done')}</p>
          <div className="csv-stats">
            <div className="csv-stat tone-create"><strong>{result.create}</strong><span>{t('custImport.stat.create')}</span></div>
            <div className="csv-stat tone-update"><strong>{result.update}</strong><span>{t('custImport.stat.update')}</span></div>
            <div className="csv-stat"><strong>{result.unchanged}</strong><span>{t('custImport.stat.unchanged')}</span></div>
            <div className="csv-stat tone-error"><strong>{result.error}</strong><span>{t('custImport.stat.error')}</span></div>
          </div>
          <p className="text-xs text-muted">{t('custImport.contactsDone', { added: result.contacts.create, updated: result.contacts.update })}</p>
          {locatePanel}
          <div className="modal-actions">
            {problems > 0 && <button type="button" className="btn btn-secondary csv-problems-btn" onClick={downloadProblems}>{t('custImport.download')}</button>}
            <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.done')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
