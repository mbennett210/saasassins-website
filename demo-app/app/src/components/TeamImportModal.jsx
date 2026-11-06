import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import Centred from './Centred';
import Select from './Select';
import Badge from './Badge';
import Icon from './Icon';
import ListPager from './ListPager';
import { useToast } from './Toast';
import { usePagedRows } from '../hooks/usePagedRows';
import { useSession } from '../auth/AuthProvider';
import { useDispatch, useStore } from '../store';
import { ACTIONS, reducer } from '../store/reducer';
import { selectCurrentUser, selectPermissions, selectUserPermissionOverrides } from '../store/selectors';
import { serializeSharedBlob } from '../store/tableSlices';
import { decodeCsvBytes, parseCsv } from '../lib/csv';
import {
  TEAM_FIELDS, TEAM_TEMPLATE_HEADERS, guessTeamMapping, isPrivateHeader, teamMappingReady,
  teamImportPermissions, planTeamImport, prepareTeamImport, runTeamImport, teamProblemsCsv, teamTemplateCsv,
} from '../lib/teamImport';
import { createTeamLogin, bindRosterId } from '../lib/teamApi';
import { LINK_NOT_SENT } from '../lib/signInLink';
import { formatStateBytes } from '../lib/stateBudget';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { newId } from '../lib/ids';
import { IDENTITY } from '../brand/identity.generated.js';
import { useT } from '../i18n/react';
import { msg, renderText } from '../i18n/core';
import { useIsMobile } from '../hooks/useIsMobile';

// Settings → Team → Import team: one row is one TEAM MEMBER (lib/teamImport.js holds every rule;
// this screen only walks it). File → columns → a dry-run preview → the import, run 25 people at a
// time: their logins and set-password emails, then one store action for the 25 (runTeamImport),
// after the shared record's size is checked for the whole file. Cancel at any step before Import
// writes nothing; once it runs, "Stop after this run" (or closing) keeps everything already done.
// `centred` and <Centred>: this pop-up's ×, its buttons' words and its filter counts sit in their
// middle by code (components/Centred), as Add Team Member's do; the kit's own are as they were
// (Forge measured them on 2026-11-03: the × low, a kit button's words 0.5px high, a count 0.6px low).
const STEP = { FILE: 'file', COLUMNS: 'columns', PREVIEW: 'preview', RUNNING: 'running', DONE: 'done' };
const STATUS_BADGE = {
  create: ['green', 'teamImport.status.create'],
  update: ['blue', 'teamImport.status.update'],
  unchanged: ['slate', 'teamImport.status.unchanged'],
  error: ['red', 'teamImport.status.error'],
};
const FILTERS = [
  { key: 'all', labelKey: 'custImport.filter.all' },
  { key: 'create', labelKey: 'custImport.filter.create' },
  { key: 'update', labelKey: 'teamImport.filter.update' },
  { key: 'unchanged', labelKey: 'custImport.filter.unchanged' },
  { key: 'problems', labelKey: 'custImport.filter.problems' },
];
const matchesFilter = (r, f) => (f === 'all' ? true
  : f === 'problems' ? (r.errors.length > 0 || r.warnings.length > 0) : r.status === f);
// The paste box's example: the template's own column names, which the import reads as written.
const PASTE_EXAMPLE = `${TEAM_TEMPLATE_HEADERS.join(',')}\nRosa,Delgado,10234,rosa.delgado@example.com,(954) 555-0142,Crew,15.50,0101`; // i18n-ok: column names the import matches, and a sample row
const applyOps = (s, ops) => reducer(s, { type: ACTIONS.IMPORT_TEAM, ops });
// What happened to a person the import added or left out, for the Done step's list (literal keys).
const NOT_SENT_KEY = {
  [LINK_NOT_SENT.notSetUp]: 'teamImport.outcome.notSetUp',
  [LINK_NOT_SENT.failed]: 'teamImport.outcome.failed',
  [LINK_NOT_SENT.noLink]: 'teamImport.outcome.noLink',
};
function outcomeLines(person) {
  if (person.refusedWhy !== undefined) return [msg('teamImport.outcome.refused', { why: person.refusedWhy })];
  if (person.skipped) return [msg('teamImport.outcome.skipped')];
  const lines = [];
  if (person.adopted) lines.push(msg('teamImport.outcome.adopted'));
  if (person.idChanged) lines.push(person.employeeId ? msg('teamImport.outcome.idChanged', { id: person.employeeId }) : msg('teamImport.outcome.idDropped'));
  if (person.live && !person.invited) lines.push(person.linkWithheld ? msg('teamImport.outcome.withheld') : msg(NOT_SENT_KEY[person.why] || 'teamImport.outcome.failed'));
  return lines;
}

// A preview row's notes, one line each under it: what a person already on the team gets (grey),
// then what stops the row (red) and what to check (amber). A new person's changes are its columns.
const DASH = <span className="text-xs text-muted">—</span>;
function previewNotes(r) {
  const info = r.status === 'update' || r.status === 'unchanged' ? r.changes.map((m) => ({ kind: 'info', m })) : [];
  return [...info, ...r.errors.map((m) => ({ kind: 'err', m })), ...r.warnings.map((m) => ({ kind: 'warn', m }))];
}
// The notes as their list (built outside the table, whose body maps only the page's rows).
function noteListOf(notes, t) {
  if (notes.length === 0) return null;
  return (
    <ul className="csv-notes">
      {notes.map((n, i) => (
        <li key={i} className={`csv-note is-${n.kind}`}>
          {n.kind !== 'info' && <Icon name={n.kind === 'err' ? 'x' : 'warning'} size={16} />}
          <span>{t(n.m)}</span>
        </li>
      ))}
    </ul>
  );
}

// While the paste box has the cursor, a drag moves only the box's own text (the styling vault's
// "Text boxes on a phone: never under the keyboard": everything around the box holds still while you
// type). With the keyboard up iOS pans the whole page under any drag nothing scrolls, and measured on
// the iOS 27 simulator (2026-11-03) a drag on this pop-up's title slid the box under the keyboard's
// bar and its buttons behind the keyboard. Each drag is cancelled before it moves anything, unless it
// is on the box and the box's text has more to show that way.
function useHoldWhileTyping(boxRef, active) {
  useEffect(() => {
    if (!active) return undefined;
    let lastY = null;
    const start = (e) => { lastY = e.touches[0]?.clientY ?? null; };
    const move = (e) => {
      const y = e.touches[0]?.clientY ?? null;
      const dy = lastY === null || y === null ? 0 : y - lastY;
      lastY = y;
      const box = boxRef.current;
      if (box && box.contains(e.target)) {
        const canUp = box.scrollTop > 0;
        const canDown = box.scrollTop + box.clientHeight < box.scrollHeight - 1;
        if ((dy > 0 && canUp) || (dy < 0 && canDown)) return;
      }
      if (e.cancelable) e.preventDefault();
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
    };
  }, [boxRef, active]);
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TeamImportModal({ open, onClose }) {
  const t = useT();
  const phone = useIsMobile();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { configured: live } = useSession();
  const currentUser = selectCurrentUser(state);
  const permissions = selectPermissions(state);
  const overrides = selectUserPermissionOverrides(state);
  const perms = useMemo(() => teamImportPermissions({ actor: currentUser, permissions, overrides }), [currentUser, permissions, overrides]);

  const [step, setStep] = useState(STEP.FILE);
  const [file, setFile] = useState(null); // { headers, rows, delimiter, renamed, encoding, name, guessed }
  const [mapping, setMapping] = useState({});
  const [pasted, setPasted] = useState('');
  const pasteRef = useRef(null);
  const [typing, setTyping] = useState(false);
  useHoldWhileTyping(pasteRef, open && typing && step === STEP.FILE);
  const [readError, setReadError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState('all');
  const [verdict, setVerdict] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [imported, setImported] = useState(null); // the plan as it was imported (the Done step)
  const [progress, setProgress] = useState(null); // { done, total }
  const [stopping, setStopping] = useState(false);
  const [result, setResult] = useState(null);
  // The run reads the store as it stands between runs, and keeps going after this pop-up closes
  // (closing asks it to stop after the run it's on).
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const running = useRef(false);
  const stopAsked = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (running.current) return; // a run still finishing: show it, never a fresh file step
    setStep(STEP.FILE); setFile(null); setMapping({}); setPasted(''); setReadError(null);
    setFilter('all'); setVerdict(null); setRefusal(null); setImported(null); setProgress(null);
    setStopping(false); setResult(null);
    stopAsked.current = false;
  }, [open]);

  // The pay column is payroll.rates.edit's on the server, so without it the column isn't offered.
  const allowed = useMemo(() => new Set(TEAM_FIELDS.filter((f) => f.key !== 'pay' || perms.canPay).map((f) => f.key)), [perms]);

  const read = (text, extra = {}) => {
    setReadError(null);
    const parsed = parseCsv(text);
    if (!parsed.headers.length || !parsed.rows.length) { setReadError(msg('custImport.err.empty')); return; }
    const guessed = guessTeamMapping(parsed.headers);
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

  const ready = teamMappingReady(mapping);
  const setField = (idx, key) => setMapping((prev) => {
    const next = {};
    for (const [i, k] of Object.entries(prev)) if (k !== key && Number(i) !== idx) next[i] = k;
    if (key) next[idx] = key;
    return next;
  });
  const fieldOptions = useMemo(() => [
    { value: '', label: t('custImport.skip') },
    ...TEAM_FIELDS.filter((f) => allowed.has(f.key)).map((f) => ({ value: f.key, label: t(f.labelKey) })),
  ], [allowed, t]);

  // The dry run: what each row WOULD do, against the team as it is right now. Writes nothing. Once
  // the import runs, the plan it ran is kept (re-planned, every row added would read "No change").
  const plan = useMemo(() => {
    if (step === STEP.RUNNING || step === STEP.DONE) return imported;
    if (!file || step !== STEP.PREVIEW) return null;
    return planTeamImport({ rows: file.rows, mapping, state, perms, live });
  }, [file, mapping, state, perms, live, step, imported]);

  // The size check runs a moment after the preview settles: it applies the whole import to a copy
  // of the shared record and measures it, which is too heavy to repeat on every keystroke.
  useEffect(() => {
    if (step !== STEP.PREVIEW || !plan) return undefined;
    setVerdict(null); setRefusal(null);
    const id = setTimeout(() => {
      const prepared = prepareTeamImport({ state, plan, newId, applyOps, serialize: serializeSharedBlob });
      setVerdict(prepared.verdict);
      setRefusal(prepared.refusal);
    }, 250);
    return () => clearTimeout(id);
  }, [plan, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowsShown = useMemo(() => (plan ? plan.rows.filter((r) => matchesFilter(r, filter)) : []), [plan, filter]);
  const pager = usePagedRows(rowsShown, { resetKey: filter });
  // The Done step's list: everyone the run left out, and everyone added who needs a look.
  const attention = useMemo(() => {
    if (!result) return [];
    const people = [
      ...result.refused.map((p) => ({ ...p, refusedWhy: p.why })),
      ...result.skipped.map((p) => ({ ...p, skipped: true })),
      ...result.added.map((p) => ({ ...p, live })),
    ];
    return people.map((p) => ({ ...p, lines: outcomeLines(p) })).filter((p) => p.lines.length).sort((a, b) => a.line - b.line);
  }, [result, live]);
  const attentionPager = usePagedRows(attention, { resetKey: result });

  const downloadProblems = () => {
    if (!plan || !file) return;
    download(teamProblemsCsv({ plan, headers: file.headers, render: (m) => t(m) }), `${IDENTITY.slug}-team-import-problems.csv`);
  };

  const doImport = async () => {
    if (!plan || running.current) return;
    const prepared = prepareTeamImport({ state, plan, newId, applyOps, serialize: serializeSharedBlob });
    if (prepared.refusal) { setRefusal(prepared.refusal); setVerdict(prepared.verdict); return; }
    running.current = true;
    stopAsked.current = false;
    setImported(plan);
    setStopping(false);
    const total = prepared.ops.filter((o) => o.op === 'addUser').length;
    setProgress({ done: 0, total });
    setStep(STEP.RUNNING);
    let res;
    try {
      res = await runTeamImport({
        ops: prepared.ops,
        live,
        createLogin: createTeamLogin,
        bindId: bindRosterId,
        dispatch,
        actionType: ACTIONS.IMPORT_TEAM,
        getState: () => stateRef.current,
        applyOps,
        onProgress: (p) => setProgress({ done: p.done, total: p.total }),
        shouldStop: () => stopAsked.current,
      });
    } finally {
      running.current = false;
    }
    setResult(res);
    setStep(STEP.DONE);
    const added = res.added.length;
    if (res.stopped) toast.success(t('teamImport.toastStopped', { added, left: res.left }));
    else toast.success(t('teamImport.toastDone', { added, filled: res.filled }));
  };

  const stop = () => { stopAsked.current = true; setStopping(true); };
  // Closing mid-run stops it after the run it's on: everyone already added stays added.
  const close = () => {
    if (running.current) { stopAsked.current = true; setStopping(true); }
    onClose();
  };

  const problems = plan ? plan.rows.filter((r) => r.errors.length || r.warnings.length).length : 0;
  const counts = plan?.counts || { create: 0, update: 0, unchanged: 0, error: 0, warning: 0 };
  const toWrite = counts.create + counts.update;
  const privateCols = file ? file.headers.filter((h) => isPrivateHeader(h)) : [];
  const payOut = file ? Object.values(file.guessed || {}).includes('pay') && !allowed.has('pay') : false;

  if (!perms.canImport) {
    return (
      <Modal open={open} onClose={onClose} title={t('teamImport.title')} size="lg" centred>
        <p className="text-sm">{t('teamImport.notPermitted')}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}><Centred>{t('common.close')}</Centred></button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title={t('teamImport.title')} size="lg" centred>
      {step === STEP.FILE && (
        <div className="csv-step">
          <p className="text-sm text-muted">{t('teamImport.lead')}</p>
          <div className="csv-template-row">
            <button type="button" className="btn btn-link" onClick={() => download(teamTemplateCsv(), `${IDENTITY.slug}-team-template.csv`)}>
              {t('custImport.template')}
            </button>
            <span className="text-xs text-muted">{t('teamImport.templateHint')}</span>
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
            <span className="text-xs text-muted">{t('teamImport.dropHint', { size: formatBytes(ATTACHMENT_MAX_BYTES) })}</span>
          </label>
          <label className="form-label" htmlFor="team-csv-paste">{t('custImport.paste')}</label>
          <textarea id="team-csv-paste" ref={pasteRef} className="input csv-paste" rows={5} placeholder={PASTE_EXAMPLE} value={pasted} onChange={(e) => setPasted(e.target.value)} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} />
          {readError && <div className="conflict-warning"><Icon name="warning" size={14} /><span>{t(readError)}</span></div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}><Centred>{t('common.cancel')}</Centred></button>
            <button type="button" className="btn btn-primary" disabled={!pasted.trim()} onClick={() => read(pasted)}><Centred>{t('custImport.readPasted')}</Centred></button>
          </div>
        </div>
      )}

      {step === STEP.COLUMNS && file && (
        <div className="csv-step">
          <p className="text-sm text-muted">{t('custImport.mapLead', { count: file.rows.length })}</p>
          {(file.encoding === 'windows-1252' || file.delimiter !== ',' || file.renamed?.length > 0 || privateCols.length > 0 || payOut) && (
            <div className="callout callout-info csv-notes">
              {file.encoding === 'windows-1252' && <p>{t('custImport.readAs1252')}</p>}
              {file.delimiter === ';' && <p>{t('custImport.readSemicolon')}</p>}
              {file.delimiter === '\t' && <p>{t('custImport.readTab')}</p>}
              {file.renamed?.length > 0 && <p>{t('custImport.renamedHeaders', { columns: file.renamed.map((r) => r.to) })}</p>}
              {privateCols.length > 0 && <p>{t('teamImport.privateSkipped', { columns: privateCols })}</p>}
              {payOut && <p>{t('teamImport.payNotAllowed')}</p>}
            </div>
          )}
          <div className="csv-map-list">
            {file.headers.map((h, idx) => (
              <div key={idx} className="csv-map-row">
                <div className="csv-map-header">
                  <div className="text-sm font-semi truncate" title={h}>{h || t('custImport.emptyHeader')}</div>
                  {/* A private column's cells are never shown. */}
                  <div className="text-xs text-muted truncate">{isPrivateHeader(h) ? '—' : (file.rows.find((r) => r[idx])?.[idx] || '—')}</div>
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
          {!ready.name && <div className="conflict-warning"><Icon name="warning" size={14} /><span>{t('teamImport.needName')}</span></div>}
          {!ready.email && <div className="conflict-warning"><Icon name="warning" size={14} /><span>{t('teamImport.needEmail')}</span></div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.FILE)}><Centred>{t('custImport.back')}</Centred></button>
            <button type="button" className="btn btn-primary" disabled={!ready.name || !ready.email} onClick={() => setStep(STEP.PREVIEW)}><Centred>{t('custImport.toPreview')}</Centred></button>
          </div>
        </div>
      )}

      {step === STEP.PREVIEW && plan && (
        <div className="csv-step">
          <div className="csv-stats">
            <div className="csv-stat tone-create"><strong>{counts.create}</strong><span>{t('teamImport.stat.create')}</span></div>
            <div className="csv-stat tone-update"><strong>{counts.update}</strong><span>{t('teamImport.stat.update')}</span></div>
            <div className="csv-stat"><strong>{counts.unchanged}</strong><span>{t('teamImport.stat.unchanged')}</span></div>
            <div className="csv-stat tone-error"><strong>{counts.error}</strong><span>{t('teamImport.stat.error')}</span></div>
            <div className="csv-stat tone-warning"><strong>{counts.warning}</strong><span>{t('teamImport.stat.warning')}</span></div>
          </div>
          {live && counts.create > 0 && <p className="text-xs text-muted">{t('teamImport.runNote')}</p>}
          {refusal
            ? <div className="callout callout-danger">{t(refusal)}</div>
            : <p className="text-xs text-muted">{verdict
              ? t('custImport.size', { after: formatStateBytes(verdict.after), limit: formatStateBytes(verdict.limit) })
              : t('custImport.sizeChecking')}</p>}
          <div className="csv-filter" role="group" aria-label={t('custImport.filterAria')}>
            {FILTERS.map((f) => {
              const n = plan.rows.filter((r) => matchesFilter(r, f.key)).length;
              return (
                <button key={f.key} type="button" className={`chip chip-sm ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
                  {t(f.labelKey)} <span className="control-count"><Centred kind="ink" watch={filter === f.key}>{n}</Centred></span>
                </button>
              );
            })}
          </div>
          {/* Each fact in its own column (UI_RULES §188): the result, the person (their row and email
              under the name), the role, employee ID, pay and Works at they'll have; what the row
              notes or can't do reads under it, on one line each (in the card on a phone). */}
          <div className="table-wrap mobile-stack csv-preview team-preview">
            <table>
              <thead>
                <tr>
                  <th>{t('custImport.col.result')}</th>
                  <th>{t('teamImport.col.member')}</th>
                  <th>{t('teamImport.field.role')}</th>
                  <th>{t('teamImport.field.employeeId')}</th>
                  <th>{t('teamImport.col.pay')}</th>
                  <th>{t('teamImport.col.worksAt')}</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((r) => {
                  const [variant, key] = STATUS_BADGE[r.status];
                  const works = r.worksAt.join(', ');
                  const noteList = noteListOf(previewNotes(r), t);
                  return (
                    <Fragment key={r.line}>
                      <tr className={noteList && !phone ? 'has-note' : undefined}>
                        <td data-label={t('custImport.col.result')}><Badge variant={variant}>{t(key)}</Badge></td>
                        <td className="cell-primary">
                          <span className="team-person-text">
                            <span className="name truncate" title={r.name}>{r.name || '—'}</span>
                            <span className="team-person-sub truncate" title={r.email}>{t('teamImport.rowEmail', { line: r.line, email: r.email || '—' })}</span>
                          </span>
                        </td>
                        <td data-label={t('teamImport.field.role')} className="team-role">{r.role ? renderText(r.role, t.lang) : DASH}</td>
                        <td data-label={t('teamImport.field.employeeId')} className="csv-num">{r.employeeId || DASH}</td>
                        <td data-label={t('teamImport.col.pay')} className="csv-num">
                          {r.pay !== null
                            ? <span>{t.rich('teamImport.payHourly', { rate: r.pay }, { muted: (chunk) => <span className="text-muted">{chunk}</span> })}</span>
                            : r.payOnFile ? <span className="text-xs text-muted">{t('teamImport.payOnFile')}</span> : DASH}
                        </td>
                        <td data-label={t('teamImport.col.worksAt')} className="team-works">
                          {r.worksAt.length
                            ? <span className="truncate" title={works}>{r.worksAt[0]}{r.worksAt.length > 1 && <span className="text-muted"> {t('worksAt.more', { count: r.worksAt.length - 1 })}</span>}</span>
                            : DASH}
                        </td>
                        {noteList && phone && <td data-label={t('teamImport.col.notes')} className="csv-notes-cell">{noteList}</td>}
                      </tr>
                      {noteList && !phone && <tr className="csv-note-row"><td /><td colSpan={5}>{noteList}</td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('custImport.rowsNoun')} />
          <div className="modal-actions">
            {problems > 0 && <button type="button" className="btn btn-secondary csv-problems-btn" onClick={downloadProblems}><Centred>{t('custImport.download')}</Centred></button>}
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.COLUMNS)}><Centred>{t('custImport.back')}</Centred></button>
            <button type="button" className="btn btn-primary" disabled={!verdict || !!refusal || toWrite === 0} onClick={doImport}>
              <Centred>{toWrite === 0 ? t('custImport.nothingToImport') : t('teamImport.importN', { count: toWrite })}</Centred>
            </button>
          </div>
        </div>
      )}

      {step === STEP.RUNNING && progress && (
        <div className="csv-step">
          <p className="text-sm font-semi" aria-live="polite">{t('teamImport.running', { done: progress.done, total: progress.total })}</p>
          <p className="text-xs text-muted">{stopping ? t('teamImport.stopping') : t('teamImport.closeNote')}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" disabled={stopping} onClick={stop}><Centred>{t('teamImport.stop')}</Centred></button>
          </div>
        </div>
      )}

      {step === STEP.DONE && result && (
        <div className="csv-step">
          <p className="text-sm font-semi">{result.stopped ? t('teamImport.stopped', { count: result.left }) : t('teamImport.done')}</p>
          <div className="csv-stats">
            <div className="csv-stat tone-create"><strong>{result.added.length}</strong><span>{t('teamImport.stat.added')}</span></div>
            {live && <div className="csv-stat"><strong>{result.added.filter((p) => p.invited).length}</strong><span>{t('teamImport.stat.invited')}</span></div>}
            <div className="csv-stat tone-update"><strong>{result.filled}</strong><span>{t('teamImport.stat.update')}</span></div>
            <div className="csv-stat tone-error"><strong>{result.refused.length + result.skipped.length + counts.error}</strong><span>{t('teamImport.stat.refused')}</span></div>
          </div>
          {attention.length > 0 && (
            <>
              <p className="text-sm">{t('teamImport.attention')}</p>
              <div className="table-wrap mobile-stack csv-preview">
                <table>
                  <thead>
                    <tr>
                      <th>{t('custImport.col.row')}</th>
                      <th>{t('teamImport.col.member')}</th>
                      <th>{t('teamImport.field.email')}</th>
                      <th>{t('teamImport.col.outcome')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attentionPager.pageRows.map((p) => (
                      <tr key={p.line}>
                        <td data-label={t('custImport.col.row')} className="csv-line">{p.line}</td>
                        <td className="cell-primary"><span className="truncate" title={p.name}>{p.name || '—'}</span></td>
                        <td data-label={t('teamImport.field.email')}><span className="truncate" title={p.email}>{p.email || '—'}</span></td>
                        <td data-label={t('teamImport.col.outcome')} className="csv-result-cell">
                          <ul className="csv-result-lines">
                            {p.lines.map((m, i) => <li key={i} className={p.refusedWhy !== undefined || p.skipped ? 'text-danger' : 'csv-warn'}>{t(m)}</li>)}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ListPager pager={attentionPager} noun={t('custImport.rowsNoun')} />
            </>
          )}
          <div className="modal-actions">
            {problems > 0 && <button type="button" className="btn btn-secondary csv-problems-btn" onClick={downloadProblems}><Centred>{t('custImport.download')}</Centred></button>}
            <button type="button" className="btn btn-primary" onClick={onClose}><Centred>{t('common.done')}</Centred></button>
          </div>
        </div>
      )}
    </Modal>
  );
}
