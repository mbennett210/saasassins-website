import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import MediaGallery from './MediaGallery';
import Icon from './Icon';
import SearchSelect from './SearchSelect';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useToast } from './Toast';
import { selectSites, selectSiteById, selectClientById } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import { inspectionFillItems, inspectionFillScore, INSPECTION_PHOTO_PHASES } from '../lib/inspections';
import {
  DRAFT_SAVE_DEBOUNCE_MS, DRAFT_RETRY_MS, DRAFT_CODES,
  draftItemsFromAnswers, answersFromItems, readDraftDevice, writeDraftDevice, clearDraftDevice,
  pickDraftSource, draftAtSite,
} from '../lib/inspectionDrafts';
import { itemAllowsNa } from '../lib/checklistCount';
import { LOCATION_ERROR_KEYS } from '../lib/workOrders';
import { dayKey, todayKey } from '../lib/dates';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { checklistLabel, templateNameOf, templateNameLabel } from '../lib/checklistI18n';

// New Inspection — the form as Matt drew it (Daniel, 2026-10-09: "do what he did for the
// inspection form"; plan docs/plans/2026-10-09-manager-view-redesign.md §2.4), on our engine:
// pick a PUBLISHED inspection template + the building (as before) → the frozen snapshot renders
// → tick each item → submit, scored on the server (lib/inspections). The record keeps the
// snapshot so history never drifts. §5.6.
//
//   • Opens straight onto the list when the building is known and the template is too (one
//     published inspection template, or `presetTemplateId`, the `?templateId=` deep link).
//   • A score card on top: "Checklist score · N of M" and the percent, live as boxes are
//     ticked. Ticked = pass; left unticked = FAIL at Submit; N/A (only where the template
//     allows it) is out of the count. A 1–5 template keeps its picker. ONE rule for what is
//     posted and what the card says (lib/inspections inspectionFillItems / inspectionFillScore),
//     and it runs the server's scoreInspection, so the card's number is the stored one.
//   • The per-item comment stays (HUB-6: the client reads it on the report), behind a
//     "Comment" link so the list reads like the board.
//   • Photos: a BEFORE and an AFTER tile (account_media scope `inspection`, area 'before' /
//     'after'), in place of photos per area. Older inspections keep theirs by area on the report.
//   • Notes (optional) is the office-only note (HUB-16), and says so in plain words.
//   • Phone: one column, the score first. Desktop: the checklist left; score, photos, notes and
//     Submit right (the `.insp-form` grid).
//
// FINISH IT LATER (Matt, the 2026-10-06 call: "I might leave that inspection open"; plan
// 2026-10-11 §3, D7–D9, UI_RULES §154). The record is a draft from Start, and now so are the
// answers: every tick, N/A, rating, comment and note change is SAVED to the draft (debounced,
// DRAFT_SAVE_DEBOUNCE_MS, and at once on close) and copied to this device at once (a lost signal
// loses nothing). A quiet line says "Saved · 1:42 PM" / "Saving…" / "Not saved, will retry".
// "Save and finish later" sits beside Submit. Continue (`resumeId`, from the Inspections list)
// reopens a draft, the newer of the server's and this device's copy winning
// (lib/inspectionDrafts pickDraftSource). Starting a new inspection at a building where this
// person has one open offers "Continue the one you started at 1:40 PM" / "Start a new one".
// A draft scores nothing and tells nobody; Submit does all of that once, unchanged (D8). The
// rules live in lib/inspectionDrafts, shared with the server and the demo stub.
//
// LANGUAGES (CS-193): the screen reads the catalog, and each section and item shows in the
// inspector's language wherever its line is for today's English (checklistLabel; the server
// translates every one on save, CS-850);
// the record still stores the office's English label, so the report reads the same.

function PhotoTile({ phase, label, addLabel, siteId, clientId, refId }) {
  const t = useT();
  const openRef = useRef(null);
  const [count, setCount] = useState(0);
  const canUpload = usePermission('ops.media.upload');
  return (
    <div className="insp-phase">
      <button type="button" className="add-tile insp-phase-add" disabled={!canUpload} aria-label={addLabel} onClick={() => openRef.current?.()}>
        <Icon name="camera" size={20} />
        <span className="insp-phase-label">{label}</span>
        {count > 0 && <span className="insp-phase-count">{t('inspectionFill.photoCount', { count })}</span>}
      </button>
      <MediaGallery
        siteId={siteId}
        clientId={clientId}
        scope="inspection"
        refId={refId}
        areaId={phase}
        label=""
        hint={null}
        emptyText={null}
        showUpload={false}
        openRef={openRef}
        onCount={setCount}
      />
    </div>
  );
}

function InspectionRow({ item, answer, numeric, max, commentOpen, onChange, onToggleComment }) {
  const t = useT();
  const label = checklistLabel(item, t.lang) || t('inspectionFill.itemFallback');
  const naOk = itemAllowsNa(item);
  const na = naOk && answer.na === true;
  const ticked = answer.ticked === true;
  const tone = na ? 'is-na' : (!numeric && !ticked ? 'is-off' : '');
  const commentId = `insp-comment-${item.id}`;
  return (
    <li className={`insp-row ${tone}`}>
      <div className="insp-row-main">
        {numeric ? (
          <>
            <span className="insp-row-label">{label}</span>
            <select
              className="input insp-rate-num"
              aria-label={t('inspectionFill.rateAria', { item: label })}
              value={na ? 'na' : (answer.rating ?? '')}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v === 'na' ? { na: true, rating: undefined } : { na: false, rating: v === '' ? undefined : Number(v) });
              }}
            >
              <option value="">—</option>{/* i18n-ok: a dash, "not rated yet" */}
              {Array.from({ length: max }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
              {naOk && <option value="na">{t('inspectionFill.na')}</option>}
            </select>
          </>
        ) : (
          <label className="insp-tick">
            <input type="checkbox" checked={ticked && !na} disabled={na} onChange={() => onChange({ ticked: !ticked })} />
            <span className="insp-row-label">{label}</span>
          </label>
        )}
        <div className="insp-row-tools">
          {naOk && !numeric && (
            <button
              type="button"
              className={`chip chip-sm insp-na${na ? ' on' : ''}`}
              aria-pressed={na}
              aria-label={t('inspectionFill.naAria', { item: label })}
              onClick={() => onChange({ na: !na })}
            >
              {t('inspectionFill.na')}
            </button>
          )}
          <button type="button" className="btn btn-link insp-comment-link" aria-expanded={commentOpen} aria-controls={commentId} onClick={onToggleComment}>
            {answer.comment ? t('inspectionFill.commentEdit') : t('inspectionFill.comment')}
          </button>
        </div>
      </div>
      {commentOpen ? (
        <input
          id={commentId}
          className="input insp-comment"
          aria-label={t('inspectionFill.commentAria', { item: label })}
          placeholder={t('inspectionFill.commentPlaceholder')}
          value={answer.comment || ''}
          onChange={(e) => onChange({ comment: e.target.value })}
        />
      ) : answer.comment ? <p className="insp-comment-read text-xs text-muted">{answer.comment}</p> : null}
    </li>
  );
}

// The refusals a draft can meet, in the reader's language (the API's words are English, LANG-8).
const DRAFT_ERRORS = {
  [DRAFT_CODES.notADraft]: 'inspectionFill.draft.notOpen',
  [DRAFT_CODES.notYours]: 'inspectionFill.draft.notYours',
  'not-found': 'inspectionFill.draft.gone',
};
const refusedDraft = (e) => e?.code === DRAFT_CODES.notADraft || e?.code === DRAFT_CODES.notYours || e?.status === 404;

// The line that says where the draft's save stands (D7, UI_RULES §154): quiet, one line, never a
// toast. `idle` = nothing changed since it opened.
const SAVE_IDLE = { kind: 'idle', at: null, error: null };
function SaveLine({ save, online }) {
  const t = useT();
  let text;
  let warn = false;
  if (save.kind === 'saving') text = t('inspectionFill.draft.saving');
  else if (save.kind === 'saved' && save.at) {
    text = dayKey(save.at) === todayKey()
      ? t('inspectionFill.draft.saved', { at: save.at })
      : t('inspectionFill.draft.savedEarlier', { at: save.at });
  } else if (save.kind === 'error') { text = online ? t('inspectionFill.draft.retry') : t('inspectionFill.draft.offlineKept'); warn = true; }
  else if (save.kind === 'closed') { text = errorText(t, save.error, 'inspectionFill.draft.notOpen', DRAFT_ERRORS); warn = true; }
  else text = t('inspectionFill.draft.autosave');
  return <p className={`insp-save text-xs${warn ? ' text-danger' : ' text-muted'}`} role="status" aria-live="polite">{text}</p>;
}

// ONE draft session per record opened: what has been edited and saved, the timers, the save in
// flight. A plain object in a ref, so a save still in flight from an earlier open can never
// write into a later one (every state update checks the session is still the live one).
const newSession = (rec) => ({
  id: rec.id, snapshot: rec.template_snapshot || null, serverAt: rec.updated_at || null,
  answers: {}, note: '', editSeq: 0, savedSeq: 0, timer: null, retry: null, inflight: null, stopped: false,
});
const dirty = (s) => !!s && !s.stopped && s.editSeq > s.savedSeq;

export default function InspectionFill({ open, onClose, onSubmitted, presetSiteId = '', presetTemplateId = '', resumeId = '' }) {
  const t = useT();
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  const online = useOnlineStatus();
  const sites = useMemo(() => selectSites(state), [state]);

  const [templates, setTemplates] = useState(null); // null = loading
  const [tplError, setTplError] = useState(null);
  const [templateId, setTemplateId] = useState('');
  const [siteId, setSiteId] = useState(presetSiteId);
  const [record, setRecord] = useState(null); // the started inspection (has template_snapshot)
  const [answers, setAnswers] = useState({}); // { itemId: { ticked, na, rating, comment } }
  const [commentsOpen, setCommentsOpen] = useState({});
  // HUB-16 — the inspector's note for the office. Stored apart from the per-item comments
  // because the CLIENT sees the full report including those comments (HUB-6); this one
  // never enters the report projection, so it reaches no client-facing surface.
  const [internalNote, setInternalNote] = useState('');
  const [busy, setBusy] = useState(false);
  // The form's two actions in flight: 'submit' | 'later' | null.
  const [acting, setActing] = useState(null);
  const autoStarted = useRef(false);
  // Continue: null, 'loading', or { error } when the draft could not be opened.
  const [opening, setOpening] = useState(null);
  const [continued, setContinued] = useState(false);
  // "Continue the one you started": this person's open draft at the building, found before a new
  // one is made — null, or the draft row plus the template the new one would have used.
  const [resumable, setResumable] = useState(null);
  const [save, setSave] = useState(SAVE_IDLE);
  const sessionRef = useRef(null);

  // Send a session's newest answers to its draft. One save at a time (a later call waits for the
  // one in flight, then sends what is newest); nothing to send = nothing sent. A refusal (the
  // draft was submitted or discarded elsewhere, or is not this person's) stops the session; any
  // other failure is tried again after DRAFT_RETRY_MS and when the connection comes back, while
  // the device copy holds the work. → true once the server has everything.
  const flushSession = useCallback(async (s) => {
    if (!s) return true;
    clearTimeout(s.timer); s.timer = null;
    clearTimeout(s.retry); s.retry = null;
    while (s.inflight) { try { await s.inflight; } catch { /* the pass below decides */ } }
    if (s.stopped) return false;
    if (s.editSeq <= s.savedSeq) return true;
    const live = () => sessionRef.current === s;
    const seq = s.editSeq;
    if (live()) setSave((p) => ({ kind: 'saving', at: p.at, error: null }));
    const run = qcApi.saveInspectionDraft({ id: s.id, items: draftItemsFromAnswers(s.snapshot, s.answers), internalNote: s.note });
    s.inflight = run;
    try {
      const r = await run;
      const at = r?.updated_at || new Date().toISOString();
      s.serverAt = at;
      s.savedSeq = Math.max(s.savedSeq, seq);
      if (s.editSeq <= seq) clearDraftDevice(s.id); // the server has it all
      else { const dev = readDraftDevice(s.id); if (dev) writeDraftDevice(s.id, { ...dev, serverAt: at }); }
      if (live()) setSave(dirty(s) ? { kind: 'saving', at, error: null } : { kind: 'saved', at, error: null });
      return !dirty(s);
    } catch (e) {
      if (refusedDraft(e)) {
        s.stopped = true;
        clearDraftDevice(s.id);
        if (live()) setSave({ kind: 'closed', at: null, error: e });
        return false;
      }
      if (live()) setSave((p) => ({ kind: 'error', at: p.at, error: e }));
      s.retry = setTimeout(() => { flushSession(s); }, DRAFT_RETRY_MS);
      return false;
    } finally {
      s.inflight = null;
    }
  }, []);

  // Every change: kept on this device at once, and saved to the draft after a short pause.
  useEffect(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.answers = answers; s.note = internalNote;
    if (!dirty(s)) return;
    writeDraftDevice(s.id, { savedAt: new Date().toISOString(), serverAt: s.serverAt, dirty: true, answers, internalNote });
    setSave((p) => (p.kind === 'error' || p.kind === 'closed' ? p : { kind: 'saving', at: p.at, error: null }));
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { flushSession(s); }, DRAFT_SAVE_DEBOUNCE_MS);
  }, [answers, internalNote, flushSession]);

  // Back online: send what this device is holding.
  useEffect(() => {
    const onOnline = () => { const s = sessionRef.current; if (dirty(s)) flushSession(s); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushSession]);
  // Leaving the page: send it, and stop the timers.
  useEffect(() => () => {
    const s = sessionRef.current;
    if (!s) return;
    clearTimeout(s.timer); clearTimeout(s.retry);
    if (dirty(s)) flushSession(s);
  }, [flushSession]);

  const edited = () => { const s = sessionRef.current; if (s && !s.stopped) s.editSeq += 1; };
  const setAns = (id, patch) => { edited(); setAnswers((p) => ({ ...p, [id]: { ...p[id], ...patch } })); };
  const setNote = (v) => { edited(); setInternalNote(v); };

  // Inspection templates only: a checklist belongs to one customer and is a cleaner's list.
  const loadTemplates = useCallback(() => {
    setTemplates(null); setTplError(null);
    qcApi.listTemplates({ kind: 'inspection' })
      .then((list) => setTemplates((list || []).filter((x) => x.is_published)))
      .catch((e) => setTplError(e));
  }, []);

  // Continue: the draft from the server, or this device's copy when that is newer (D7).
  const openDraft = useCallback(async (id) => {
    setOpening('loading'); setResumable(null);
    try {
      const { inspection: rec, items } = await qcApi.getInspectionDraft(id);
      const device = readDraftDevice(rec.id);
      const fromDevice = pickDraftSource({ serverUpdatedAt: rec.updated_at, device }) === 'device';
      if (device && !fromDevice) clearDraftDevice(rec.id); // the server's copy is the newer one
      const s = newSession(rec);
      if (fromDevice) s.editSeq = 1; // work this device holds that the server never got: send it
      sessionRef.current = s;
      setRecord(rec);
      setSiteId(rec.site_id || '');
      setTemplateId(rec.template_id || '');
      setAnswers(fromDevice ? device.answers : answersFromItems(rec.template_snapshot, items));
      setInternalNote(fromDevice ? (device.internalNote || '') : (rec.internal_note || ''));
      setCommentsOpen({});
      setSave(fromDevice ? { kind: 'saving', at: rec.updated_at || null, error: null } : { kind: 'saved', at: rec.updated_at || null, error: null });
      setContinued(true);
      setOpening(null);
    } catch (e) {
      setOpening({ error: e, id });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Anything the last open left unsent goes now (its own session; nothing of it reaches this one).
    const prev = sessionRef.current;
    if (dirty(prev)) flushSession(prev);
    sessionRef.current = null;
    setTemplateId(presetTemplateId || ''); setSiteId(presetSiteId); setRecord(null);
    setAnswers({}); setCommentsOpen({}); setInternalNote(''); setSave(SAVE_IDLE);
    setResumable(null); setOpening(null); setContinued(false); setActing(null);
    autoStarted.current = !!resumeId;
    if (resumeId) openDraft(resumeId);
    else loadTemplates();
  }, [open, presetSiteId, presetTemplateId, resumeId, loadTemplates, openDraft, flushSession]);

  const start = useCallback(async (id, { fresh = false } = {}) => {
    if (!id) { toast.error(t('inspectionFill.pickTemplate')); return; }
    setBusy(true);
    try {
      // Matt's walk between sites: an inspection this person left open HERE is offered first.
      // A failed read never blocks a new inspection.
      if (!fresh && siteId) {
        let mine = [];
        try { mine = await qcApi.listMyInspectionDrafts({ siteId, inspectorUserId: currentUser?.id || null }); } catch { mine = []; }
        const left = draftAtSite(mine, siteId);
        if (left) { setResumable({ ...left, templateId: id }); return; }
      }
      const site = siteId ? selectSiteById(state, siteId) : null;
      const client = site ? selectClientById(state, site.clientId) : null;
      const rec = await qcApi.createInspection({
        templateId: id, siteId: siteId || null, clientId: site?.clientId || null,
        siteName: site?.name || null, clientName: client?.name || null, inspectorName: currentUser?.name || null,
        // The demo stub's only (the server stamps the inspector from the login): who raised a
        // failed inspection's ticket (WO-19), and whose draft it is.
        inspectorUserId: currentUser?.id || null,
      });
      if (!rec) throw new Error(t('inspectionFill.startFailed'));
      sessionRef.current = newSession(rec);
      setSave(SAVE_IDLE);
      setRecord(rec);
    } catch (e) { toast.error(errorText(t, e, 'inspectionFill.startFailed', LOCATION_ERROR_KEYS)); }
    finally { setBusy(false); }
  }, [siteId, state, currentUser, toast, t]);

  // The template, when there is only one to choose — or the one the link named.
  const onlyTemplate = useMemo(() => {
    if (!templates) return null;
    if (presetTemplateId && templates.some((x) => x.id === presetTemplateId)) return presetTemplateId;
    return templates.length === 1 ? templates[0].id : null;
  }, [templates, presetTemplateId]);
  useEffect(() => { if (onlyTemplate && !templateId) setTemplateId(onlyTemplate); }, [onlyTemplate, templateId]);
  // Straight onto the list when the building and the template are both known (once per open).
  useEffect(() => {
    if (!open || record || busy || autoStarted.current || !online) return;
    if (!onlyTemplate || !siteId) return;
    autoStarted.current = true;
    start(onlyTemplate);
  }, [open, record, busy, online, onlyTemplate, siteId, start]);

  const snap = record?.template_snapshot;
  const numeric = snap?.rating_scale?.type === 'numeric';
  const max = snap?.rating_scale?.max || 5;
  const areas = snap?.schema?.areas || [];
  const score = useMemo(() => inspectionFillScore(snap, answers), [snap, answers]);
  const closed = save.kind === 'closed';

  // Closing the form keeps the draft: whatever is unsent goes now (the device copy holds it if
  // that fails), and the list shows it In progress.
  const close = () => {
    const s = sessionRef.current;
    if (dirty(s)) flushSession(s);
    onClose();
  };

  // "Save and finish later" (D7): send everything, then close with a toast that says where it is.
  const finishLater = async () => {
    const s = sessionRef.current;
    setActing('later');
    const ok = await flushSession(s);
    setActing(null);
    if (ok) toast.success(t('inspectionFill.draft.savedLater'));
    else if (s?.stopped) toast.error(t('inspectionFill.draft.notOpen'));
    else toast.info(t('inspectionFill.draft.savedOnDevice'), { duration: 6000 });
    onClose();
  };

  const submit = async () => {
    const s = sessionRef.current;
    setActing('submit');
    // No draft save may land after (or race) the Submit: stop the timers, wait out the one in flight.
    if (s) {
      clearTimeout(s.timer); clearTimeout(s.retry); s.timer = null; s.retry = null;
      s.stopped = true;
      while (s.inflight) { try { await s.inflight; } catch { /* Submit sends everything anyway */ } }
    }
    try {
      await qcApi.submitInspection({ id: record.id, items: inspectionFillItems(snap, answers), internalNote });
      clearDraftDevice(record.id);
      toast.success(t('inspectionFill.submitted'));
      onSubmitted?.();
      onClose();
    } catch (e) {
      if (s && !refusedDraft(e)) { s.stopped = false; if (dirty(s)) flushSession(s); }
      toast.error(errorText(t, e, 'inspectionFill.submitFailed', DRAFT_ERRORS));
    } finally { setActing(null); }
  };

  const site = siteId ? selectSiteById(state, siteId) : null;
  const client = site ? selectClientById(state, site.clientId) : null;
  const building = client?.name || site?.name || record?.client_name || record?.site_name || null;

  const resumeAt = resumable?.performed_at || resumable?.updated_at || null;
  // The left-open inspection's template, named in the reader's language from the template list
  // (CS-850: the row carries its name lines); the draft's own stored name otherwise.
  const resumableRow = resumable ? (templates || []).find((x) => x.id === resumable.templateId) : null;
  const resumableName = resumableRow?.name === resumable?.template_name && resumableRow ? templateNameOf(resumableRow, t.lang) : (resumable?.template_name || null);
  const continueLabel = resumeAt && dayKey(resumeAt) !== todayKey()
    ? t('inspectionFill.resume.continueEarlier', { at: resumeAt })
    : t('inspectionFill.resume.continueToday', { at: resumeAt });

  return (
    <Modal open={open} onClose={close} title={continued ? t('inspectionFill.titleContinue') : t('inspectionFill.titleNew')} size="lg">
      {!record ? (
        <div className="insp-start">
          {opening === 'loading' ? (
            <p className="text-sm text-muted" role="status">{t('inspectionFill.draft.opening')}</p>
          ) : opening?.error ? (
            <div className="insp-start-state">
              <p className="text-sm">{errorText(t, opening.error, 'inspectionFill.draft.openFailed', DRAFT_ERRORS)}</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.close')}</button>
                {!refusedDraft(opening.error) && <button type="button" className="btn btn-primary" onClick={() => openDraft(opening.id)}>{t('inspectionFill.tryAgain')}</button>}
              </div>
            </div>
          ) : resumable ? (
            // Matt's walk between sites: the inspection this person left open here comes first.
            <div className="insp-resume" role="group" aria-labelledby="insp-resume-lead">
              <p id="insp-resume-lead" className="insp-resume-lead">{building ? t('inspectionFill.resume.leadAt', { building }) : t('inspectionFill.resume.lead')}</p>
              {resumableName && <p className="text-sm text-muted">{resumableName}</p>}
              <div className="insp-resume-actions">
                <button type="button" className="btn btn-primary" onClick={() => openDraft(resumable.id)}>{continueLabel}</button>
                <button type="button" className="btn btn-outline" onClick={() => { const tid = resumable.templateId; setResumable(null); start(tid, { fresh: true }); }}>{t('inspectionFill.resume.startNew')}</button>
              </div>
            </div>
          ) : tplError ? (
            <div className="insp-start-state">
              <p className="text-sm">{errorText(t, tplError, 'inspectionFill.templatesFailed')}</p>
              <button type="button" className="btn btn-primary" onClick={loadTemplates}>{t('inspectionFill.tryAgain')}</button>
            </div>
          ) : templates === null ? (
            <p className="text-sm text-muted" role="status">{t('inspectionFill.loadingTemplates')}</p>
          ) : busy ? (
            <p className="text-sm text-muted" role="status">{t('inspectionFill.starting')}</p>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">{t('inspectionFill.template')}</label>
                <SearchSelect
                  value={templateId}
                  onChange={(id) => setTemplateId(id || '')}
                  options={templates.map((x) => ({ value: x.id, label: templateNameOf(x, t.lang) }))}
                  placeholder={t('inspectionFill.templatePlaceholder')}
                  searchPlaceholder={t('inspectionFill.templateSearch')}
                  emptyText={t('inspectionFill.noTemplates')}
                />
                {templates.length === 0 && <p className="form-help">{t('inspectionFill.noTemplatesHint')}</p>}
              </div>
              <div className="form-group">
                <label className="form-label">{t('inspectionFill.location')}</label>
                <SearchSelect
                  value={siteId}
                  onChange={(id) => setSiteId(id || '')}
                  options={sites.map((s) => { const c = selectClientById(state, s.clientId); return { value: s.id, label: c?.name || s.name, sublabel: s.address || '' }; })}
                  placeholder={t('inspectionFill.pickLocation')}
                  searchPlaceholder={t('inspectionFill.locationSearch')}
                />
              </div>
              {!online && <p className="form-error" role="status">{t('inspectionFill.offline')}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
                {/* CS-697: an inspection starts at its location — its photos, its report and any ticket a
                    failure opens are filed there (the server refuses one with none, location-required). */}
                <button type="button" className="btn btn-primary" disabled={busy || !templateId || !siteId || !online} onClick={() => start(templateId)}>{t('inspectionFill.start')}</button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="insp-form">
          <div className="insp-form-head">
            {(building || snap?.name) && (
              <p className="insp-form-sub text-sm text-muted">{[building, snap?.name ? templateNameLabel(snap?.name, snap?.schema?.nameI18n, t.lang) : null].filter(Boolean).join(' · ') /* i18n-ok: names joined by a separator */}</p>
            )}
            <SaveLine save={save} online={online} />
          </div>
          <div className="insp-form-grid">
            <section className="insp-score" aria-live="polite">
              <div className="insp-score-main">
                <span className="insp-score-label">{t('inspectionFill.scoreLabel')}</span>
                <span className="insp-score-of">
                  {!score.applies ? t('inspectionFill.scoreNone')
                    : numeric ? t('inspectionFill.scoreRated', { done: score.done, total: score.applies })
                      : t('inspectionFill.scoreOf', { done: score.done, total: score.applies })}
                </span>
              </div>
              <span className="insp-score-pct">{score.overallScore != null ? t('inspectionFill.scorePct', { pct: score.overallScore }) : '—' /* i18n-ok: a dash, no score yet */}</span>
            </section>

            <section className="card insp-list">
              <h3 className="insp-card-title">{t('inspectionFill.checklist')}</h3>
              {areas.map((area) => (
                <div className="insp-area-block" key={area.id}>
                  {areas.length > 1 && <h4 className="insp-area-h">{checklistLabel(area, t.lang) || t('inspectionFill.areaFallback')}</h4>}
                  <ul className="insp-rows">
                    {(area.items || []).map((it) => (
                      <InspectionRow
                        key={it.id}
                        item={it}
                        answer={answers[it.id] || {}}
                        numeric={numeric}
                        max={max}
                        commentOpen={!!commentsOpen[it.id]}
                        onChange={(patch) => setAns(it.id, patch)}
                        onToggleComment={() => setCommentsOpen((p) => ({ ...p, [it.id]: !p[it.id] }))}
                      />
                    ))}
                  </ul>
                </div>
              ))}
              {!numeric && <p className="insp-list-hint text-xs text-muted">{t('inspectionFill.untickedHint')}</p>}
            </section>

            <section className="card insp-photos">
              <h3 className="insp-card-title">{t('inspectionFill.photos')}</h3>
              {siteId ? (
                <div className="insp-phase-grid">
                  <PhotoTile phase={INSPECTION_PHOTO_PHASES.BEFORE} label={t('inspectionFill.before')} addLabel={t('inspectionFill.addBefore')} siteId={siteId} clientId={site?.clientId || record.client_id || null} refId={record.id} />
                  <PhotoTile phase={INSPECTION_PHOTO_PHASES.AFTER} label={t('inspectionFill.after')} addLabel={t('inspectionFill.addAfter')} siteId={siteId} clientId={site?.clientId || record.client_id || null} refId={record.id} />
                </div>
              ) : (
                <p className="text-sm text-muted">{t('inspectionFill.photosNeedSite')}</p>
              )}
            </section>

            {/* HUB-16 — for the office, and said so in visible text beside the field (not a
                tooltip, which never appears on a phone). The client's copy of this report
                carries every item comment; this one is the only thing on the screen that does
                not travel with it. */}
            <section className="card insp-notes">
              <label className="insp-card-title" htmlFor="insp-internal-note">{t('inspectionFill.notes')}</label>
              <textarea
                id="insp-internal-note"
                className="input textarea-md"
                placeholder={t('inspectionFill.notesPlaceholder')}
                value={internalNote}
                onChange={(e) => setNote(e.target.value)}
              />
              <p className="form-help">{t('inspectionFill.notesHelp')}</p>
            </section>

            <div className="insp-submit">
              {!online && <p className="form-error" role="status">{t('inspectionFill.offline')}</p>}
              <button type="button" className="btn btn-primary insp-submit-btn" disabled={!!acting || !online || closed} onClick={submit}>
                {acting === 'submit' ? t('inspectionFill.submitting') : t('inspectionFill.submit')}
              </button>
              {/* D7: works offline too — the device copy holds it until the signal is back. */}
              <button type="button" className="btn btn-outline insp-submit-btn" disabled={!!acting || closed} onClick={finishLater}>
                {t('inspectionFill.draft.saveLater')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
