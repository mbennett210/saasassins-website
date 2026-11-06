import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import EmptyState from '../../components/EmptyState';
import MobileSheet from '../../components/MobileSheet';
import ChecklistItemPhoto from '../../components/ChecklistItemPhoto';
import { useToast } from '../../components/Toast';
import { useSelector, useJobsHydrated } from '../../store';
import { selectClientById, selectJobById, selectSiteById, selectUserById } from '../../store/selectors';
import { useAuth } from '../../hooks/useAuth';
import { usePermission } from '../../hooks/usePermission';
import { useCrewPreview } from '../../hooks/useCrewPreview';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useBackTarget } from '../../hooks/useBackTarget';
import { useFromHere } from '../../hooks/useFromHere';
import { useChecklistResults, reloadChecklistResults } from '../../hooks/useCleanChecklist';
import { crewPaths } from '../../lib/crewPaths';
import { checklistFor, latestChecklistFor } from '../../lib/crewChecklist';
import { coveredCleanerId } from '../../lib/jobCover';
import { checklistFillRefusal, checklistOpensAt } from '../../lib/checklistWindow';
import {
  countChecklistSubmission, itemAllowsNa, itemRequiresPhoto, submittedItemKey,
  notCompletedReasonOk, notCompletedReasonOf, normalizeNotCompletedReason,
  NOT_COMPLETED_REASON_MIN, NOT_COMPLETED_REASON_MAX, CHECKLIST_NOTE_MAX,
} from '../../lib/checklistCount';
import {
  readChecklistDraft, writeChecklistDraft, newChecklistDraft, draftItems, draftPhotoKeys, submitChecklistDraft,
} from '../../lib/checklistDraft';
import { checklistLabel, templateNameLabel } from '../../lib/checklistI18n';
import { schemaAreasFor } from '../../lib/checklistAreas';
import * as qcApi from '../../lib/qcApi';
import * as timeApi from '../../lib/timeApi';
import { fmtTime } from '../../lib/dates';
import { useT } from '../../i18n/react';
import { english } from '../../i18n/core';
import { errorText } from '../../i18n/errors';

// MY CHECKLIST — the cleaner's checklist for one clean, on its own page (Matt's "Cleaner Hub"
// boards Checklist + ChecklistMeridian, 2026-10-13; Brief B; UI_RULES §166). Route
// `crewPaths.checklist(jobId)` = /my-day/checklist/:jobId, gate `qc.checklist.perform`.
//
// WHAT IT IS:
//   • the cleaner's OWN checklist for this clean (`crewChecklist.checklistFor`, covers
//     included — "Covering for {name} · {checklist}"), drawn from the PUBLISHED schema;
//   • one row per task: the tick (bold while unresolved), a COMMENT (the item's `note`), a
//     PHOTO on every task (`ChecklistItemPhoto`; where the office asked for one the tick still
//     waits for it, CS-547), N/A only where the office allows it (CS-546), and "MARK AS NOT
//     COMPLETED" with a reason (Matt's rule: it counts toward unlocking Clock Out, the office
//     sees the reason, it is never counted as cleaned — lib/checklistCount);
//   • progress by the SAME rule the server stores (`countChecklistSubmission` over the very
//     list that will be posted, and this phone's photos);
//   • SAVED ON THE PHONE AS THEY GO (UI_RULES §154, lib/checklistDraft): every change is kept on
//     the phone at once, one quiet line says so, and the page reopens where it was left — even
//     with no signal once the checklist has been opened online;
//   • ONE Save at the end, only once every task is resolved: one submission whose
//     `clientSubmitId` is the id the draft minted first (its photos are filed under it); offline
//     it is queued like every checklist (lib/qcApi). Then "Saved at 9:42 PM" and Clock Out. A
//     saved checklist reads back read-only. No partial save here (the integration pass saves a
//     partial draft at clock-out for a cleaner whose lock is off).
//
// OPENED FROM A QR CODE (Builder D's scan → `crewPaths.checklist(jobId, areaId)` → `?area=`): once
// the checklist has loaded, the section(s) that area names (`checklistAreas.schemaAreasFor`: the
// building's area a section is linked to, or a section's own id) scroll into view once and are
// marked for a moment. An unknown or missing area does nothing.
//
// WHEN IT OPENS FOR CHECK-OFF: once the cleaner is clocked in to THIS clean (the
// ChecklistMeridian board); before that the tasks are shown, disabled, under "Opens for
// check-off once you're clocked in on site" (or the clean's window line, CS-690).
// The lock banner shows only when the clock-out actually waits on it for this cleaner
// (`clockRules.checklistBlockOff` not set). The owner's "View as" (useCrewPreview) draws it
// read-only: the server would record anything written as the owner.
const NC_PICKS = [
  ['locked', 'crewChecklist.ncPick.locked'],
  ['broken', 'crewChecklist.ncPick.broken'],
  ['supplies', 'crewChecklist.ncPick.supplies'],
  ['other', 'crewChecklist.ncPick.other'],
];

// A stored submission's marks, in the draft's `checks` shape, for the read-back of a saved one.
function checksFromItems(items) {
  const out = {};
  for (const it of Array.isArray(items) ? items : []) {
    const key = submittedItemKey(it);
    if (!key) continue;
    const reason = notCompletedReasonOf(it);
    out[key] = {
      checked: !!it.checked,
      na: !!it.na,
      notCompleted: !!reason,
      reason,
      note: typeof it.note === 'string' && it.note.trim() ? it.note.trim() : null,
    };
  }
  return out;
}

export default function CrewChecklist() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const nav = useFromHere();
  const { jobId } = useParams();
  const [searchParams] = useSearchParams();
  const areaParam = searchParams.get('area') || null;
  const { currentUser } = useAuth();
  const userId = currentUser?.id || null;
  const { previewing } = useCrewPreview();
  const canPerform = usePermission('qc.checklist.perform');
  const online = useOnlineStatus();
  const jobsHydrated = useJobsHydrated();

  const job = useSelector(useCallback((s) => selectJobById(s, jobId), [jobId]));
  const site = useSelector(useCallback((s) => (job?.siteId ? selectSiteById(s, job.siteId) : null), [job?.siteId]));
  const clientId = job?.clientId || site?.clientId || null;
  const client = useSelector(useCallback((s) => (clientId ? selectClientById(s, clientId) : null), [clientId]));
  const me = useSelector(useCallback((s) => (userId ? selectUserById(s, userId) : null), [userId]));
  const coveredId = coveredCleanerId(job, userId);
  const coveredName = useSelector(useCallback((s) => (coveredId ? selectUserById(s, coveredId)?.name || null : null), [coveredId]));
  const graceMins = useSelector(useCallback((s) => s.opsSettings?.autoCloseGraceMins, []));

  const templateId = job ? checklistFor({ client, job, userId }) : null;
  const draftId = useMemo(() => ({ jobId: job?.id || null, templateId, userId }), [job?.id, templateId, userId]);

  // ── the draft (lib/checklistDraft): read once per clean, written on every change ──
  // `keptOnPhone` drives the quiet "Saved on this phone" line: true once a change was written,
  // or when the page reopened on a draft the phone had kept.
  const [draft, setDraft] = useState(() => (job?.id && templateId ? readChecklistDraft({ jobId: job.id, templateId, userId }) : null) || newChecklistDraft());
  const [keptOnPhone, setKeptOnPhone] = useState(false);
  const loadedFor = useRef(null);
  useEffect(() => {
    const k = `${draftId.jobId}|${draftId.templateId}|${draftId.userId}`;
    if (!draftId.jobId || !draftId.templateId || loadedFor.current === k) return;
    loadedFor.current = k;
    const kept = readChecklistDraft(draftId);
    setDraft(kept || newChecklistDraft());
    setKeptOnPhone(!!kept);
  }, [draftId]);

  // ── the published checklist (and, offline, the copy the draft kept) ──
  const [published, setPublished] = useState(null);
  const [checklistName, setChecklistName] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loadTick, setLoadTick] = useState(0);
  useEffect(() => {
    if (!templateId) return undefined;
    let alive = true;
    setLoadError(null);
    qcApi.getTemplate(templateId)
      .then((r) => {
        if (!alive) return;
        const live = r?.published?.schema || null;
        if (live) { setPublished(live); setChecklistName(r?.template?.name || null); } else setLoadError(new Error(''));
      })
      .catch((e) => { if (alive) setLoadError(e || new Error('')); });
    return () => { alive = false; };
  }, [templateId, loadTick]);
  const schema = published || draft?.schema || null;
  // The name as the office wrote it (kept on the phone with the draft), and as the reader reads it:
  // its line for today's name from the schema it came with — online or the phone's copy (CS-850).
  const shownName = checklistName || draft?.name || null;
  const readName = shownName ? templateNameLabel(shownName, schema?.nameI18n, t.lang) : null;

  // ── a QR code's area: scroll to it once the checklist is on screen, and mark it for a moment ──
  const focusIds = useMemo(() => schemaAreasFor(schema, areaParam), [schema, areaParam]);
  const [focusOn, setFocusOn] = useState(false);
  const focusedOnce = useRef(null);
  const focusTimer = useRef(null);
  useEffect(() => () => clearTimeout(focusTimer.current), []);
  useEffect(() => {
    if (!focusIds.length || focusedOnce.current === areaParam) return;
    const el = typeof document !== 'undefined' ? document.getElementById(`crew-chk-area-${focusIds[0]}`) : null;
    if (!el) return;
    focusedOnce.current = areaParam;
    let reduce = false;
    try { reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { reduce = false; }
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    setFocusOn(true);
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => setFocusOn(false), 2400);
  }, [focusIds, areaParam]);

  // ── the saved submission (synced, or still queued on this phone) ──
  const { results, queued } = useChecklistResults(job?.id || null);
  const savedRow = latestChecklistFor(results, { templateId, userId });
  const queuedRow = useMemo(() => (queued || []).find((q) => q && !q.failed && q.payload
    && q.payload.jobId === job?.id && q.payload.templateId === templateId
    && (q.payload.completedByUserId || userId) === userId) || null, [queued, job?.id, templateId, userId]);
  const [justSaved, setJustSaved] = useState(null);   // { at, pending }
  const saved = justSaved
    || (savedRow ? { at: savedRow.performed_at, pending: false, items: savedRow.items } : null)
    || (queuedRow ? { at: queuedRow.payload.filledAt || queuedRow.createdAt, pending: true, items: queuedRow.payload.items } : null);

  // ── is this cleaner clocked in to THIS clean? ──
  const [entries, setEntries] = useState(null);
  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    const load = () => timeApi.mine({ userId }).then((rows) => { if (alive) setEntries(rows || []); }).catch(() => { if (alive) setEntries((e) => e || []); });
    load();
    window.addEventListener('cleanspace:time-queue-flushed', load);
    window.addEventListener('online', load);
    return () => {
      alive = false;
      window.removeEventListener('cleanspace:time-queue-flushed', load);
      window.removeEventListener('online', load);
    };
  }, [userId]);
  const clockedIn = !!(entries || []).find((e) => e && e.job_id === job?.id && !e.clock_out_at);

  // The clean's window (CS-690) ticks while it waits to open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const fillRefusal = job ? checklistFillRefusal(job, nowMs, { graceMins, clockedIn }) : null;
  const opensAt = fillRefusal === 'early' ? checklistOpensAt(job, { graceMins }) : null;

  const open = clockedIn && !fillRefusal;
  const canEdit = open && !previewing && canPerform && !saved && !!schema;
  const lockApplies = me?.clockRules?.checklistBlockOff !== true;

  // ── the list that will be posted, and its count by the server's rule ──
  const checks = useMemo(() => (saved?.items ? checksFromItems(saved.items) : (draft?.checks || {})), [saved, draft]);
  const items = useMemo(() => draftItems(schema, { ...draft, checks }), [schema, draft, checks]);
  const photoKeys = useMemo(() => draftPhotoKeys(draft), [draft]);
  const progress = useMemo(() => countChecklistSubmission(schema, items, { photoKeys }), [schema, items, photoKeys]);
  const total = progress.total_count;
  const done = progress.completed_count;
  const allResolved = total > 0 && done >= total;
  const started = done > 0 || Object.keys(draft?.checks || {}).length > 0;

  // Every change goes to the phone at once (UI_RULES §154), with the checklist it was made on.
  // Built from the LATEST draft (a ref, not the render's copy): a photo upload finishes after
  // the cleaner may have ticked something else, and must not write the older draft back over it.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const persist = useCallback((update) => {
    const next = update(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    setKeptOnPhone(writeChecklistDraft(draftId, { ...next, schema, name: shownName }));
  }, [draftId, schema, shownName]);
  // A MARK carries when it was made (QR-1: an area finished when its last task did); a comment
  // is not a mark and leaves the stamp alone.
  const mark = (key, patch) => persist((d) => ({
    ...d,
    checks: { ...d.checks, [key]: { ...(d.checks || {})[key], ...patch, at: new Date().toISOString() } },
  }));
  const setNote = (key, note) => persist((d) => ({ ...d, checks: { ...d.checks, [key]: { ...(d.checks || {})[key], note } } }));
  const setPhotoCount = (key, n) => persist((d) => ({ ...d, photos: { ...(d.photos || {}), [key]: n } }));

  // ── the two sheets ──
  const [commentFor, setCommentFor] = useState(null);   // { key, label, text }
  const [ncFor, setNcFor] = useState(null);             // { key, label, text, pick, marked }
  const saveComment = () => {
    if (!commentFor) return;
    setNote(commentFor.key, commentFor.text.trim().slice(0, CHECKLIST_NOTE_MAX) || null);
    setCommentFor(null);
  };
  const saveNotCompleted = () => {
    if (!ncFor || !notCompletedReasonOk(ncFor.text)) return;
    // A quick pick left as it is goes to the office in the office's English; anything the
    // cleaner wrote is kept as written (their own words are never translated).
    const pickKey = NC_PICKS.find(([k]) => k === ncFor.pick)?.[1] || null;
    const reason = pickKey && ncFor.pick !== 'other' && ncFor.text.trim() === t(pickKey)
      ? english(pickKey)
      : normalizeNotCompletedReason(ncFor.text);
    mark(ncFor.key, { notCompleted: true, reason, checked: false, na: false });
    setNcFor(null);
  };
  const undoNotCompleted = () => {
    if (!ncFor) return;
    mark(ncFor.key, { notCompleted: false, reason: null });
    setNcFor(null);
  };

  // ── Save: ONE submission, under the draft's own id ──
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!canEdit || !allResolved || busy) return;
    setBusy(true);
    try {
      const res = await submitChecklistDraft({
        job: { id: job.id, siteId: job.siteId || null, clientId },
        templateId, userId, schema,
        draft: { ...draft, checks },
        submit: qcApi.submitChecklist,
      });
      setJustSaved({ at: new Date().toISOString(), pending: !!res?.pending_sync, items });
      reloadChecklistResults(job.id);
    } catch (e) {
      toast.error(errorText(t, e, 'crewChecklist.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // ── the back arrow: where the cleaner came from, else Home ──
  const back = useBackTarget(crewPaths.home(), location.state?.from ? null : t('crewChecklist.home'));
  const backAria = back.label === t('back.back') ? back.label : t('crewChecklist.backTo', { place: back.label });
  const head = (sub) => (
    <header className="crew-chk-head">
      <button type="button" className="btn-icon crew-chk-back crew-chk-tap" aria-label={backAria} onClick={back.goBack}>
        <Icon name="chevronLeft" size={22} />
      </button>
      <div className="crew-chk-titles">
        <h1 className="crew-chk-title">{t('crewChecklist.title')}</h1>
        {sub && <p className="crew-chk-sub">{sub}</p>}
      </div>
    </header>
  );

  if (!job) {
    if (!jobsHydrated) return <div className="page crew-chk-page">{head(null)}<p className="text-muted">{t('common.loading')}</p></div>;
    return (
      <div className="page crew-chk-page">
        {head(null)}
        <EmptyState icon={<Icon name="schedule" size={28} />} title={t('crewChecklist.notFound.title')} message={t('crewChecklist.notFound.message')} />
      </div>
    );
  }

  const customer = client?.name || site?.name || null;
  const sub = customer && job.startAt ? t('crewChecklist.sub', { customer, start: job.startAt }) : customer;
  if (!templateId) {
    return (
      <div className="page crew-chk-page">
        {head(sub)}
        <EmptyState icon={<Icon name="check" size={28} />} title={t('crewChecklist.none.title')} message={t('crewChecklist.none.message')} />
      </div>
    );
  }

  const banner = (() => {
    if (saved) return null;
    if (!open) {
      const text = fillRefusal === 'early' && opensAt
        ? t('checklist.clean.opensAt', { time: fmtTime(new Date(opensAt).toISOString()) })
        : (fillRefusal === 'late' ? t('checklist.clean.closed') : t('crewChecklist.preview'));
      return <p className="crew-chk-banner is-preview" role="note"><Icon name="mapPin" size={18} /><span>{text}</span></p>;
    }
    if (lockApplies) return <p className="crew-chk-banner is-lock" role="note"><Icon name="lock" size={18} /><span>{t('crewChecklist.lock')}</span></p>;
    return null;
  })();
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const left = Math.max(0, total - done);

  return (
    <div className="page crew-chk-page">
      {head(sub)}
      {coveredName && (
        <p className="crew-chk-cover text-sm">{t('crewChecklist.coveringFor', { name: coveredName, checklist: readName || t('checklist.clean.checklist') })}</p>
      )}
      {banner}
      {!online && (
        <p className="crew-chk-offline text-sm" role="status">{schema ? t('crewChecklist.noSignal') : t('crewChecklist.noSignalNoCopy')}</p>
      )}

      {!schema ? (
        loadError ? (
          <div className="card crew-chk-load">
            <p className="text-sm">{online ? errorText(t, loadError, 'crewChecklist.loadFailed') : t('crewChecklist.noSignalNoCopy')}</p>
            <button type="button" className="btn btn-outline" onClick={() => setLoadTick((n) => n + 1)}>{t('common.retry')}</button>
          </div>
        ) : <p className="text-muted">{t('common.loading')}</p>
      ) : (
        <>
          <div className="crew-chk-progress">
            <div className="crew-chk-progress-row">
              <span className="crew-chk-progress-label">{t('crewChecklist.tasks')}</span>
              <span className={`crew-chk-progress-count${started || saved ? '' : ' is-quiet'}`} role="status">
                {started || saved ? t('crewChecklist.resolved', { done, total }) : t('crewChecklist.notStarted')}
              </span>
            </div>
            <span className="crew-chk-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
            {keptOnPhone && !saved && <p className="crew-chk-kept text-xs">{t('crewChecklist.savedOnPhone')}</p>}
          </div>

          {(schema.areas || []).map((area) => (
            <section
              className={`crew-chk-area${focusOn && focusIds.includes(area.id) ? ' crew-chk-area-focus' : ''}`}
              key={area.id || area.label}
              id={area.id ? `crew-chk-area-${area.id}` : undefined}
            >
              {(schema.areas || []).length > 1 && (
                <h2 className="crew-chk-area-label">{checklistLabel(area, t.lang) || t('checklist.fill.areaFallback')}</h2>
              )}
              <ul className="crew-chk-list">
                {(area.items || []).filter((it) => it && it.id).map((it) => {
                  const c = checks[it.id] || {};
                  const label = checklistLabel(it, t.lang) || t('checklist.fill.itemFallback');
                  const needsPhoto = itemRequiresPhoto(it);
                  const shots = Number(draft?.photos?.[it.id]) || 0;
                  const photoBlocked = needsPhoto && shots === 0;
                  const row = items.find((x) => x.key === it.id);
                  const resolved = countChecklistSubmission({ areas: [{ items: [it] }] }, row ? [row] : [], { photoKeys }).completed_count > 0;
                  const ncOn = !!(c.notCompleted && c.reason);
                  return (
                    <li key={it.id} className={`crew-chk-row${resolved ? ' is-resolved' : ''}${canEdit ? ' is-open' : ''}`}>
                      <div className="crew-chk-main">
                        <label className="crew-chk-check">
                          <input
                            type="checkbox"
                            checked={!!c.checked}
                            disabled={!canEdit || photoBlocked}
                            onChange={() => mark(it.id, { checked: !c.checked, na: false, notCompleted: false, reason: null })}
                          />
                          <span className="crew-chk-label">{label}</span>
                        </label>
                        {!saved && (
                          <div className="crew-chk-acts">
                            {itemAllowsNa(it) && (
                              <button
                                type="button"
                                className={`chip crew-chk-na crew-chk-tap ${c.na ? 'on' : ''}`}
                                aria-pressed={!!c.na}
                                aria-label={t('checklist.fill.naAria', { item: label })}
                                disabled={!canEdit}
                                onClick={() => mark(it.id, { na: !c.na, checked: false, notCompleted: false, reason: null })}
                              >
                                {t('checklist.fill.na')}
                              </button>
                            )}
                            <button
                              type="button"
                              className={`btn-icon crew-chk-act crew-chk-tap ${c.note ? 'is-on' : ''}`}
                              aria-label={c.note ? t('crewChecklist.commentEdit', { item: label }) : t('crewChecklist.commentAdd', { item: label })}
                              disabled={!canEdit}
                              onClick={() => setCommentFor({ key: it.id, label, text: c.note || '' })}
                            >
                              <Icon name="messaging" size={18} />
                            </button>
                            <ChecklistItemPhoto
                              variant="icon"
                              className="crew-chk-tap"
                              required={needsPhoto}
                              disabled={!canEdit}
                              siteId={job.siteId}
                              clientId={clientId}
                              submissionId={draft.submissionId}
                              itemKey={it.id}
                              itemLabel={label}
                              count={shots}
                              onCount={(n) => setPhotoCount(it.id, n)}
                            />
                            <button
                              type="button"
                              className={`btn-icon crew-chk-act crew-chk-nc crew-chk-tap ${ncOn ? 'is-on' : ''}`}
                              aria-label={ncOn ? t('crewChecklist.ncChange', { item: label }) : t('crewChecklist.ncMark', { item: label })}
                              aria-pressed={ncOn}
                              disabled={!canEdit}
                              onClick={() => setNcFor({ key: it.id, label, text: c.reason || '', pick: null, marked: ncOn })}
                            >
                              <Icon name="x" size={18} />
                            </button>
                          </div>
                        )}
                      </div>
                      {photoBlocked && canEdit && !c.notCompleted && <p className="crew-chk-why text-xs">{t('crewChecklist.photoRequired')}</p>}
                      {ncOn && (
                        <p className="crew-chk-strip text-sm"><Icon name="warning" size={16} /><span>{t('crewChecklist.ncStrip', { reason: c.reason })}</span></p>
                      )}
                      {c.note && <p className="crew-chk-note text-sm">{c.note}</p>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          <div className="crew-chk-foot">
            {saved ? (
              <>
                <p className="crew-chk-saved" role="status">
                  <Icon name="check" size={18} />
                  <span>{saved.pending ? t('crewChecklist.savedPending', { at: saved.at }) : t('crewChecklist.savedAt', { at: saved.at })}</span>
                </p>
                <p className="text-xs text-muted">{t('crewChecklist.savedReadOnly')}</p>
                {clockedIn && !previewing && (
                  <button type="button" className="btn btn-primary crew-chk-cta" onClick={() => navigate(crewPaths.clock(job.id), { state: nav })}>
                    {t('crewChecklist.clockOut')}
                  </button>
                )}
              </>
            ) : !open ? (
              <p className="crew-chk-foot-note is-quiet">{t('crewChecklist.previewFoot')}</p>
            ) : allResolved ? (
              <button type="button" className="btn btn-primary crew-chk-cta" disabled={!canEdit || busy} onClick={save}>
                {busy ? t('common.saving') : t('crewChecklist.save')}
              </button>
            ) : (
              <p className="crew-chk-foot-note">{lockApplies ? t('crewChecklist.left', { count: left }) : t('crewChecklist.leftNoLock', { count: left })}</p>
            )}
          </div>
        </>
      )}

      <MobileSheet
        open={!!commentFor}
        onClose={() => setCommentFor(null)}
        title={t('crewChecklist.commentTitle')}
        footer={(
          <div className="crew-chk-sheet-actions">
            {commentFor && checks[commentFor.key]?.note && (
              <button type="button" className="btn btn-outline" onClick={() => { setNote(commentFor.key, null); setCommentFor(null); }}>{t('crewChecklist.commentRemove')}</button>
            )}
            <button type="button" className="btn btn-outline" onClick={() => setCommentFor(null)}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={saveComment}>{t('common.save')}</button>
          </div>
        )}
      >
        {commentFor && (
          <div className="form-group">
            <p className="crew-chk-sheet-item text-sm">{commentFor.label}</p>
            <textarea
              className="input textarea-md"
              aria-label={t('crewChecklist.commentAdd', { item: commentFor.label })}
              placeholder={t('crewChecklist.commentPlaceholder')}
              maxLength={CHECKLIST_NOTE_MAX}
              value={commentFor.text}
              onChange={(e) => setCommentFor((p) => ({ ...p, text: e.target.value }))}
            />
            <p className="form-help">{t('crewChecklist.commentHelp')}</p>
          </div>
        )}
      </MobileSheet>

      <MobileSheet
        open={!!ncFor}
        onClose={() => setNcFor(null)}
        title={t('crewChecklist.ncTitle')}
        footer={(
          <div className="crew-chk-sheet-actions">
            {ncFor?.marked && (
              <button type="button" className="btn btn-outline" onClick={undoNotCompleted}>{t('crewChecklist.ncUndo')}</button>
            )}
            <button type="button" className="btn btn-outline" onClick={() => setNcFor(null)}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={!ncFor || !notCompletedReasonOk(ncFor.text)} onClick={saveNotCompleted}>{t('crewChecklist.ncSave')}</button>
          </div>
        )}
      >
        {ncFor && (
          <div className="form-group">
            <p className="crew-chk-sheet-item text-sm">{ncFor.label}</p>
            <div className="crew-chk-picks" role="group" aria-label={t('crewChecklist.ncTitle')}>
              {NC_PICKS.map(([k, key]) => (
                <button
                  key={k}
                  type="button"
                  className={`chip crew-chk-pick crew-chk-tap ${ncFor.pick === k ? 'on' : ''}`}
                  aria-pressed={ncFor.pick === k}
                  onClick={() => setNcFor((p) => ({ ...p, pick: k, text: k === 'other' ? '' : t(key) }))}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <label className="form-label" htmlFor="crew-chk-reason">{t('crewChecklist.ncReason')}</label>
            <textarea
              id="crew-chk-reason"
              className="input textarea-sm"
              maxLength={NOT_COMPLETED_REASON_MAX}
              value={ncFor.text}
              onChange={(e) => setNcFor((p) => ({ ...p, text: e.target.value }))}
            />
            <p className="form-help">{t('crewChecklist.ncHelp', { min: NOT_COMPLETED_REASON_MIN, max: NOT_COMPLETED_REASON_MAX })}</p>
          </div>
        )}
      </MobileSheet>
    </div>
  );
}
