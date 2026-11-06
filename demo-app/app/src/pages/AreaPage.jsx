// THE AREA PAGE (QR Wave 2, UI_RULES §175) — `/areas/:siteId/:areaId`, where an office scan lands.
// Matt (QR-17, 2026-10-16): "A page for that area: the last clean with the cleaner's name and
// checklist, the photo, open requests at the building, who's on site now, and buttons for Start
// inspection, New request and Open customer." QR-20: an Admin and the Super Admin get the same page.
// Open customer went on 2026-11-03 (task 467 from Clean Corner's queue, after the call with Matt).
// QR-18: a manager's scan is not saved — this page reads, and writes only what someone asks it to
// (a new request, a ticket's own actions in the one work-order drawer).
//
// Phone first (they scan with a phone in a hallway), fine on desktop: the area, the building and the
// customer; the three buttons; then the cards — the last clean (when, in the org's zone; who, from the
// roster; which checklist; that area's items; the photo, large on a tap; "Open the full checklist"),
// the location's open requests (newest first, each opening its ticket in place) and who is on site.
// Every read already exists and is gated on its own key, so each card reads, fails and retries on its
// own (lib/areaPage holds what the page decides from them):
//   · the last clean — EP-200 (qcApi.areaStatus, qc.view);
//   · open requests — qcApi.listOpenProblems narrowed to the location (problems.manage, the queue's key);
//   · on site now — timeApi.entriesAll narrowed to the location and the last day (time.view).
// Every word is a catalog line (UI_RULES §140); the work-order drawer keeps its own English.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStore } from '../store';
import { selectUserById } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useFromHere } from '../hooks/useFromHere';
import * as qcApi from '../lib/qcApi';
import * as timeApi from '../lib/timeApi';
import { toWorkOrder, deriveSla, normalizePriority, WO_TYPE_META, WO_PRIORITY_META } from '../lib/workOrders';
import {
  areaPageWhere, areaLastClean, areaItemsView, areaPhoto, checklistRowFor,
  areaPageRequests, onSiteNow, onSiteReadWindow, areaRequestPrefill,
} from '../lib/areaPage';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { useToast } from '../components/Toast';
import Avatar from '../components/Avatar';
import Badge from '../components/Badge';
import BackLink from '../components/BackLink';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import Modal from '../components/Modal';
import ChecklistResultModal from '../components/ChecklistResultModal';
import WorkOrderModal from '../components/WorkOrderModal';
import WorkOrderDrawer from '../components/WorkOrderDrawer';

const MIN = 60 * 1000;
// The clocks and "on site" re-judge on this beat while the page is open.
const TICK_MS = 60 * 1000;
// Each type's and priority's word, as literal keys (a key is never built at run time).
const TYPE_KEYS = {
  complaint: 'clientReq.type.complaint',
  request: 'clientReq.type.request',
  issue: 'clientReq.type.issue',
  failed_inspection: 'clientReq.type.failed_inspection',
};
const PRIORITY_KEYS = { low: 'alerts.priority.low', medium: 'alerts.priority.medium', urgent: 'alerts.priority.urgent' };
const ITEM_STATE_KEYS = {
  done: 'areaPage.item.done',
  na: 'areaPage.item.na',
  notcompleted: 'areaPage.item.notCompleted',
  notdone: 'areaPage.item.notDone',
};

// One read for one card: { phase: 'off' | 'loading' | 'ok' | 'error', data, error, retry }. An answer
// on screen stays while a re-read runs or fails; the connection coming back reads again.
function useCardRead(reader, enabled, online) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState(() => ({ phase: enabled ? 'loading' : 'off', data: null, error: null }));
  useEffect(() => {
    if (!enabled) { setState({ phase: 'off', data: null, error: null }); return undefined; }
    let live = true;
    setState((s) => (s.phase === 'ok' ? s : { phase: 'loading', data: null, error: null }));
    reader()
      .then((data) => { if (live) setState({ phase: 'ok', data, error: null }); })
      .catch((error) => { if (live) setState((s) => (s.phase === 'ok' ? s : { phase: 'error', data: null, error })); });
    return () => { live = false; };
  }, [reader, enabled, online, tick]);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, retry };
}

// A card's own failure line: offline, or the read's error (`message`, already in the reader's
// language) with Try again.
function CardFailed({ read, online, message }) {
  const t = useT();
  return (
    <div className="areapg-failed" role="status">
      <p className="text-sm text-muted">{online ? message : t('areaPage.offline')}</p>
      {online && <button type="button" className="btn btn-secondary" onClick={read.retry}>{t('clientReq.tryAgain')}</button>}
    </div>
  );
}

export default function AreaPage() {
  const t = useT();
  const toast = useToast();
  const nav = useFromHere();
  const online = useOnlineStatus() !== false;
  const { siteId, areaId } = useParams();
  const state = useStore();
  const canInspect = usePermission('qc.inspect');
  const canProblems = usePermission('problems.manage');
  const canSeeTime = usePermission('time.view');
  const canSeeQc = usePermission('qc.view');
  const where = useMemo(() => areaPageWhere({ siteId, areaId, sites: state.sites || [], clients: state.clients || [] }), [siteId, areaId, state.sites, state.clients]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(id); }, []);

  // ── the reads (each card's own) ──
  const cleaningAreas = where?.site?.cleaningAreas;
  const readStatus = useCallback(() => qcApi.areaStatus({ siteId, cleaningAreas: cleaningAreas || [] }), [siteId, cleaningAreas]);
  const status = useCardRead(readStatus, !!where && canSeeQc, online);
  const readRequests = useCallback(() => qcApi.listOpenProblems({ siteIds: [siteId] }), [siteId]);
  const requests = useCardRead(readRequests, !!where && canProblems, online);
  const readPunches = useCallback(() => timeApi.entriesAll({ ...onSiteReadWindow(Date.now()), siteIds: [siteId], lite: true }), [siteId]);
  const punches = useCardRead(readPunches, !!where && canSeeTime, online);

  const last = status.phase === 'ok' ? areaLastClean(status.data, areaId) : null;
  const items = useMemo(() => areaItemsView(last), [last]);
  const photo = areaPhoto(last);
  const cleaner = last?.lastCleanedByUserId ? selectUserById(state, last.lastCleanedByUserId) : null;
  const settings = state.opsSettings || {};
  const reqRows = useMemo(() => (requests.phase === 'ok' ? areaPageRequests({ problems: requests.data, siteId, now, settings }) : []), [requests.phase, requests.data, siteId, now, settings]);
  const here = useMemo(() => (punches.phase === 'ok' ? onSiteNow({ entries: punches.data, siteId, users: state.users || [], now }) : []), [punches.phase, punches.data, siteId, state.users, now]);

  // ── "Open the full checklist": that clean's rows (the clean the submission names, else the
  // location's newest), the submission found by its id ──
  const [result, setResult] = useState(null);
  const [opening, setOpening] = useState(false);
  const openFull = async () => {
    if (!last?.resultId || opening) return;
    setOpening(true);
    try {
      let row = last.jobId ? checklistRowFor(await qcApi.listChecklists({ jobId: last.jobId }), last.resultId) : null;
      if (!row) row = checklistRowFor(await qcApi.listChecklists({ siteId }), last.resultId);
      if (row) setResult(row); else toast.error(t('areaPage.lastClean.openFailed'));
    } catch (e) {
      toast.error(errorText(t, e, 'areaPage.lastClean.openFailed'));
    } finally {
      setOpening(false);
    }
  };
  const [photoOpen, setPhotoOpen] = useState(false);

  // ── New request (the office's ticket form, on this location and this area) and a ticket opened in
  // place in the ONE work-order drawer ──
  const [newOpen, setNewOpen] = useState(false);
  const prefill = where ? areaRequestPrefill({ siteId, area: where.area }) : {};
  const [openId, setOpenId] = useState(null);
  const [touched, setTouched] = useState(null);
  const selected = useMemo(() => {
    if (!openId) return null;
    const raw = (requests.data || []).find((x) => x.id === openId) || (touched && touched.id === openId ? touched : null);
    if (!raw) return null;
    const w = { ...toWorkOrder(raw), first_reply_at: raw.first_reply_at ?? null };
    return { ...w, sla: deriveSla({ dueAt: w.due_at, status: w.status, resolvedAt: w.resolved_at, now }) };
  }, [openId, requests.data, touched, now]);
  const update = async (id, patch) => {
    try {
      const after = await qcApi.updateProblem({ id, ...patch });
      if (after && after.id) setTouched(after);
      requests.retry();
    } catch (e) { toast.error(errorText(t, e, 'clientReq.updateFailed')); }
  };
  const supervisor = where?.client?.supervisorId ? selectUserById(state, where.client.supervisorId) : null;

  // The clock in words: Client Requests' own lines (lib/clientRequests requestClock).
  const leftText = (left) => {
    if (left.phase === 'reply') return left.state === 'breached' ? t('clientReq.left.replyOverdue', { time: left.minutes }) : t('clientReq.left.replyRemaining', { time: left.minutes });
    if (left.state === 'breached') return t('clientReq.left.overdue', { time: left.minutes });
    if (left.state === 'soon' || left.state === 'ok') return t('clientReq.left.remaining', { time: left.minutes });
    if (left.state === 'paused') return t('clientReq.left.paused');
    return null;
  };

  if (!where) {
    return (
      <div className="page areapg">
        <BackLink to="/" />
        <EmptyState icon={<Icon name="building" size={28} />} title={t('areaPage.notFound')} message={t('areaPage.notFoundHint')} />
      </div>
    );
  }
  const { site, client, area } = where;
  const placeLine = client && client.name && site.name && client.name !== site.name
    ? t('areaPage.where', { customer: client.name, location: site.name })
    : (client?.name || site.name || '');
  const agoMins = last ? Math.max(0, Math.round((now - Date.parse(last.lastCleanedAt)) / MIN)) : null;

  return (
    <div className="page areapg">
      <BackLink to="/" />
      <div className="page-head">
        <div className="page-head-text">
          {/* i18n-ok: the area's own name, as the office wrote it */}
          <h1>{area.label}</h1>
          <p className="page-sub areapg-where"><Icon name="building" size={14} /> <span>{placeLine}</span></p>
        </div>
      </div>

      {/* The two buttons, each shown to whoever may use it; the row only when one shows. Open
          customer went on 2026-11-03 (task 467; Matt: "I don't need the open customer there"). */}
      {(canInspect || canProblems) && (
        <div className="areapg-actions">
          {canInspect && (
            <Link className="btn btn-primary" to={`/inspections?fill=1&siteId=${encodeURIComponent(siteId)}`} state={nav}>{t('areaPage.startInspection')}</Link>
          )}
          {canProblems && (
            <button type="button" className="btn btn-gold" onClick={() => setNewOpen(true)} disabled={!online}>{t('areaPage.newRequest')}</button>
          )}
        </div>
      )}

      <div className="areapg-grid">
        {canSeeQc && (
          <section className="card areapg-card areapg-last" aria-labelledby="areapg-last-title">
            <h2 id="areapg-last-title" className="areapg-card-title">{t('areaPage.lastClean.title')}</h2>
            {status.phase === 'loading' ? (
              <p className="text-sm text-muted">{t('common.loading')}</p>
            ) : status.phase === 'error' ? (
              <CardFailed read={status} online={online} message={errorText(t, status.error, 'areaPage.lastClean.loadFailed')} />
            ) : !last ? (
              <div className="areapg-none">
                <p className="areapg-none-title">{t('areaPage.lastClean.none')}</p>
                <p className="text-sm text-muted">{t('areaPage.lastClean.noneHint')}</p>
              </div>
            ) : (
              <>
                <div className="areapg-when">
                  <span className="areapg-when-time">{t('areaPage.lastClean.when', { at: last.lastCleanedAt })}</span>
                  <span className="text-sm text-muted">{t('areaPage.lastClean.ago', { time: agoMins })}</span>
                </div>
                <div className="areapg-who">
                  {cleaner && <Avatar user={cleaner} size="sm" />}
                  <span className="text-sm">{cleaner ? t('areaPage.lastClean.by', { name: cleaner.name }) : t('areaPage.lastClean.byUnknown')}</span>
                </div>
                {last.checklistName && <p className="text-sm text-muted areapg-checklist">{t('areaPage.lastClean.checklist', { name: last.checklistName })}</p>}
                {photo && (
                  <figure className="areapg-photo">
                    <button type="button" className="areapg-photo-btn" onClick={() => setPhotoOpen(true)} aria-label={t('areaPage.photo.enlarge', { area: area.label })}>
                      <img src={photo.thumbUrl || photo.url} alt={t('areaPage.photo.alt', { area: area.label })} loading="lazy" />
                    </button>
                    {photo.createdAt && <figcaption className="text-xs text-muted">{t('areaPage.photo.taken', { at: photo.createdAt })}</figcaption>}
                  </figure>
                )}
                {items.length > 0 && (
                  <ul className="areapg-items">
                    {items.map((it, i) => (
                      <li key={`${i}-${it.key}`} className={`areapg-item is-${it.state}`}>
                        <span className="areapg-item-mark" aria-hidden="true">
                          {it.state === 'done' ? <Icon name="check" size={14} /> : it.state === 'notcompleted' ? <Icon name="warning" size={14} /> : <span>{/* i18n-ok: a mark, not words */}–</span>}
                        </span>
                        <span className="areapg-item-text">
                          {/* i18n-ok: the office's own item label */}
                          <span className="areapg-item-label">{it.label}</span>
                          <span className="areapg-item-state text-xs">{t(ITEM_STATE_KEYS[it.state] || ITEM_STATE_KEYS.notdone)}</span>
                          {it.reason && <span className="areapg-item-reason text-xs">{t('areaPage.item.reason', { reason: it.reason })}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {last.resultId && (
                  <button type="button" className="btn btn-link areapg-open-full" onClick={openFull} disabled={opening || !online}>{t('areaPage.lastClean.openFull')}</button>
                )}
              </>
            )}
          </section>
        )}

        {/* The other two cards stack in their own column, so a tall last clean never stretches them. */}
        {(canProblems || canSeeTime) && (
        <div className="areapg-side">
        {canProblems && (
          <section className="card areapg-card" aria-labelledby="areapg-req-title">
            <h2 id="areapg-req-title" className="areapg-card-title">{t('areaPage.requests.title')}</h2>
            {requests.phase === 'loading' ? (
              <p className="text-sm text-muted">{t('common.loading')}</p>
            ) : requests.phase === 'error' ? (
              <CardFailed read={requests} online={online} message={errorText(t, requests.error, 'areaPage.requests.loadFailed')} />
            ) : reqRows.length === 0 ? (
              <p className="text-sm text-muted">{t('areaPage.requests.none')}</p>
            ) : (
              <ul className="areapg-reqs">
                {reqRows.map((w) => {
                  const pri = normalizePriority(w.priority);
                  const left = leftText(w.left);
                  return (
                    <li key={w.id}>
                      <button type="button" className="areapg-req" onClick={() => setOpenId(w.id)} aria-label={t('areaPage.requests.openAria', { title: w.title || '' })}>
                        <span className="areapg-req-text">
                          <span className="areapg-req-badges">
                            <Badge variant={WO_TYPE_META[w.type]?.badge || 'slate'}>{t(TYPE_KEYS[w.type] || TYPE_KEYS.issue)}</Badge>
                            <Badge variant={WO_PRIORITY_META[pri]?.badge || 'slate'}>{t(PRIORITY_KEYS[pri] || PRIORITY_KEYS.medium)}</Badge>
                          </span>
                          {/* i18n-ok: the request's own title, as written */}
                          <span className="areapg-req-title">{w.title}</span>
                          {left && <span className={`areapg-req-left text-xs is-${w.left.state}`}>{left}</span>}
                        </span>
                        <Icon name="chevronRight" size={18} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {canSeeTime && (
          <section className="card areapg-card" aria-labelledby="areapg-site-title">
            <h2 id="areapg-site-title" className="areapg-card-title">{t('areaPage.onSite.title')}</h2>
            {punches.phase === 'loading' ? (
              <p className="text-sm text-muted">{t('common.loading')}</p>
            ) : punches.phase === 'error' ? (
              <CardFailed read={punches} online={online} message={errorText(t, punches.error, 'areaPage.onSite.loadFailed')} />
            ) : here.length === 0 ? (
              <p className="text-sm text-muted">{t('areaPage.onSite.none')}</p>
            ) : (
              <ul className="areapg-people">
                {here.map((p) => (
                  <li key={p.userId} className="areapg-person">
                    {p.user && <Avatar user={p.user} size="sm" />}
                    {/* i18n-ok: a person's name */}
                    <span className="areapg-person-name">{p.name}</span>
                    <span className="text-xs text-muted">{t('areaPage.onSite.since', { at: p.since })}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        </div>
        )}
      </div>

      <ChecklistResultModal open={!!result} result={result} onClose={() => setResult(null)} />
      {photo && (
        <Modal open={photoOpen} onClose={() => setPhotoOpen(false)} title={t('areaPage.photo.title', { area: area.label })} size="lg">
          <img className="areapg-photo-full" src={photo.url || photo.thumbUrl} alt={t('areaPage.photo.alt', { area: area.label })} />
          {photo.createdAt && <p className="text-xs text-muted">{t('areaPage.photo.taken', { at: photo.createdAt })}</p>}
        </Modal>
      )}
      <WorkOrderModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={() => requests.retry()} {...prefill} />
      {/* Always mounted: it draws nothing while closed, and slides out with the last ticket. */}
      <WorkOrderDrawer
        wo={selected || null} canManage={canProblems} onClose={() => setOpenId(null)}
        onUpdate={update} onRefresh={requests.retry} clientName={client?.name || site.name || '—'} supervisorName={supervisor?.name || null}
      />
    </div>
  );
}
