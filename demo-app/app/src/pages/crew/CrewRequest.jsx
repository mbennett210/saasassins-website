// Request Details — one client request on the cleaner's phone, and Mark Complete (Matt's Cleaner
// Hub board "Request Details"; plan docs/plans/2026-10-13-cleaner-hub.md §3 D3, brief C §2).
//
// D3 (Daniel, 2026-10-13: "Cleaner closes it"): Mark Complete RESOLVES the ticket. Three pieces:
//   · the PHOTO of the finished work — REQUIRED (WO-10): an account_media row at scope
//     `problem_report` with this ticket's id, added through the shared MediaGallery (its own
//     upload, offline buffering and shrink). The button counts the photos through the gallery's
//     own `onCount`, so it can never disagree with what is on screen; the SERVER is the boundary
//     (409 photo-required, re-read and said here);
//   · the NOTE for the account manager (optional) — an OFFICE-ONLY line on the ticket
//     (problems/message `internal: true`): the customer never sees it;
//   · Mark Complete → problems/update { status: 'resolved' }, which tells the account manager.
// The button stays where it is, disabled, with the reason under it (UI_RULES §118 / §131): the
// owner viewing as a cleaner (nothing is written as the owner, D8), no signal (no queued resolve:
// "you can complete this when you're back online"), no location (no photo can be filed — CS-697),
// no photo yet. Every word is a catalog line (`crewRequests.*`); the request's words travel as written.
import { useCallback, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import Badge from '../../components/Badge';
import MediaGallery from '../../components/MediaGallery';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../hooks/useAuth';
import { useCrewPreview } from '../../hooks/useCrewPreview';
import { useMyRequests } from '../../hooks/useMyRequests';
import * as qcApi from '../../lib/qcApi';
import { crewPaths } from '../../lib/crewPaths';
import { crewRequestOverdue } from '../../lib/crewRequests';
import { RESOLVE_PHOTO_CODE } from '../../lib/workOrders';
import { isOfflineError } from '../../lib/netError';
import { useT } from '../../i18n/react';
import { CrewPageHead, requestPlace, requestWhen } from './requestParts';

// What each lock says (literal keys, UI_RULES §140; the preview's names the person, below).
const LOCK_KEYS = {
  offline: 'crewRequests.complete.offline',
  noLocation: 'crewRequests.complete.noLocation',
  needPhoto: 'crewRequests.complete.needPhoto',
};

// Why Mark Complete is off right now (the first that applies) — or null.
function lockReason({ previewing, online, hasSite, photoCount }) {
  if (previewing) return 'preview';
  if (!online) return 'offline';
  if (!hasSite) return 'noLocation';
  if (!photoCount) return 'needPhoto';
  return null;
}

export default function CrewRequest() {
  const { ticketId } = useParams();
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const { previewing, name: previewName } = useCrewPreview();
  const { data, loading, offline, savedAt, refresh } = useMyRequests();
  const all = data ? [...(data.open || []), ...(data.recentDone || [])] : [];
  const req = all.find((r) => r.id === ticketId) || null;

  const [photoCount, setPhotoCount] = useState(0);
  const onCount = useCallback((n) => setPhotoCount(n), []);
  const openPicker = useRef(null);
  const [galleryKey, setGalleryKey] = useState(0);   // a refused complete re-reads the photos
  const [note, setNote] = useState('');
  const notePosted = useRef('');                      // a retry never posts the same note twice
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState(null);       // a catalog key: what went wrong, said under the button
  const [completed, setCompleted] = useState(false);

  const head = (sub) => <CrewPageHead title={t('crewRequests.detailTitle')} sub={sub} fallback={crewPaths.requests()} />;
  if (!req) {
    return (
      <div className="page page-narrow crew-req-page">
        {head(null)}
        {!data && loading ? <p className="text-muted text-sm">{t('common.loading')}</p>
          : !data && offline ? <p className="crew-req-note" role="status">{t('crewRequests.offlineNone')}</p>
            : (
              <div className="crew-req-failed" role="status">
                <p>{data ? t('crewRequests.notFound') : t('crewRequests.loadFailed')}</p>
                {data ? <p className="text-muted text-sm">{t('crewRequests.notFoundHint')}</p> : null}
                <Link className="btn btn-outline" to={crewPaths.requests()}>{t('crewRequests.backToList')}</Link>
              </div>
            )}
      </div>
    );
  }

  const isDone = completed || req.status === 'resolved';
  const overdue = !isDone && crewRequestOverdue(req);
  const lock = isDone ? null : lockReason({ previewing, online: !offline, hasSite: !!req.siteId, photoCount });
  const managerName = req.managerName || '';

  async function complete() {
    if (busy.current || lock) return;
    busy.current = true; setWorking(true); setProblem(null);
    try {
      const text = note.trim();
      if (text && notePosted.current !== text) {
        try {
          await qcApi.addWorkOrderMessage({
            problemId: req.id, body: text, internal: true,
            authorUserId: currentUser?.id || null, authorRole: 'crew', authorName: currentUser?.name || null,
          });
          notePosted.current = text;
        } catch (e) {
          setProblem(isOfflineError(e) ? 'crewRequests.complete.offline' : (e?.status === 403 ? 'crewRequests.complete.notYours' : 'crewRequests.complete.noteFailed'));
          return;
        }
      }
      await qcApi.updateProblem({ id: req.id, status: 'resolved' });
      setCompleted(true);
      toast.success(t('crewRequests.complete.doneTitle'));
      refresh();
    } catch (e) {
      if (e?.code === RESOLVE_PHOTO_CODE) { setProblem('crewRequests.complete.needPhoto'); setGalleryKey((k) => k + 1); }
      else if (isOfflineError(e)) setProblem('crewRequests.complete.offline');
      else if (e?.status === 403) setProblem('crewRequests.complete.notYours');
      else setProblem('crewRequests.complete.failed');
    } finally {
      busy.current = false; setWorking(false);
    }
  }

  const reasonText = lock === 'preview' ? t('crewRequests.complete.preview', { name: previewName })
    : lock ? t(LOCK_KEYS[lock]) : null;
  return (
    <div className="page page-narrow crew-req-page">
      {head(requestPlace(t, req))}
      {savedAt ? <p className="crew-req-note" role="status">{t('crewRequests.offlineKept', { at: savedAt })}</p> : null}

      <article className={`card crew-req-card crew-req-card-detail${overdue ? ' is-overdue' : ''}${isDone ? ' is-done' : ''}`}>
        <div className="crew-req-card-top">
          {isDone
            ? <Badge variant="green">{t('crewRequests.completedChip')}</Badge>
            : <Badge variant={overdue ? 'red' : 'amber'}>{overdue ? t('crewRequests.overdue') : t('crewRequests.assigned')}</Badge>}
          <span className="crew-req-when">{requestWhen(t, req.createdAt)}</span>
        </div>
        <h2 className="crew-req-title">{req.title}</h2>
        {req.description ? <p className="crew-req-desc crew-req-desc-full">{req.description}</p> : null}
        {managerName ? <p className="crew-req-from crew-req-from-rule"><Icon name="user" size={14} /> {t('crewRequests.from', { name: managerName })}</p> : null}
      </article>

      {isDone ? (
        <section className="crew-req-done-box" aria-live="polite">
          <h3 className="crew-req-section-title"><Icon name="check" size={18} /> {t('crewRequests.complete.doneTitle')}</h3>
          {completed
            ? <p>{managerName ? t('crewRequests.complete.doneTold', { name: managerName }) : t('crewRequests.complete.doneToldNoName')}</p>
            : (req.resolvedAt ? <p>{t('crewRequests.complete.doneAt', { at: req.resolvedAt })}</p> : null)}
          {req.siteId ? (
            <MediaGallery siteId={req.siteId} clientId={req.clientId} scope="problem_report" refId={req.id} label="" hint={null} emptyText={null} readOnly hideWhenEmpty />
          ) : null}
          <Link className="btn btn-outline crew-req-back-list" to={crewPaths.requests()}>{t('crewRequests.backToList')}</Link>
        </section>
      ) : (
        <section className="crew-req-complete" aria-labelledby="crew-req-complete-h">
          <h3 id="crew-req-complete-h" className="crew-req-section-title">{t('crewRequests.complete.heading')}</h3>
          {req.siteId ? (
            <>
              <MediaGallery
                key={galleryKey}
                siteId={req.siteId} clientId={req.clientId} scope="problem_report" refId={req.id}
                label="" hint={null} emptyText={null} showUpload={false} openRef={openPicker} onCount={onCount}
                readOnly={previewing}
              />
              <button
                type="button"
                className="add-tile crew-req-photo-tile"
                disabled={previewing}
                onClick={() => openPicker.current && openPicker.current()}
              >
                <Icon name="camera" size={26} />
                <span className="crew-req-photo-label">{photoCount ? t('crewRequests.complete.addAnother') : t('crewRequests.complete.addPhoto')}</span>
                {!photoCount ? <span className="crew-req-photo-hint">{t('crewRequests.complete.photoRequired')}</span> : null}
              </button>
            </>
          ) : null}
          <label className="crew-req-note-field">
            <span className="sr-only">{t('crewRequests.complete.notePlaceholder')}</span>
            <textarea
              className="input crew-req-note-input" rows={3} maxLength={2000}
              placeholder={t('crewRequests.complete.notePlaceholder')}
              value={note} onChange={(e) => setNote(e.target.value)} disabled={previewing}
              aria-describedby="crew-req-note-hint"
            />
          </label>
          <p id="crew-req-note-hint" className="crew-req-hint">{t('crewRequests.complete.noteHint')}</p>
          <button
            type="button"
            className="btn btn-primary crew-req-submit"
            disabled={!!lock || working}
            aria-describedby={lock || problem ? 'crew-req-why' : undefined}
            onClick={complete}
          >
            {working ? t('crewRequests.complete.working') : t('crewRequests.complete.button')}
          </button>
          {lock || problem ? (
            <p id="crew-req-why" className="crew-req-why" role="status">{problem ? t(problem) : reasonText}</p>
          ) : null}
          <p className="crew-req-notify">
            {managerName ? t('crewRequests.complete.notify', { name: managerName }) : t('crewRequests.complete.notifyNoName')}
          </p>
        </section>
      )}
    </div>
  );
}
