// The work-order drawer: one ticket's detail, its conversation with the client, its photos and
// the office's actions (status, assign, priority, category, escalate, resolve). ONE component,
// opened from the Quality hub's Work Orders tab (components/WorkOrdersPanel) and from Client
// Requests (pages/ClientRequests, the manager view redesign, 2026-10-09: "Respond"). It was lifted
// out of WorkOrdersPanel whole (II.5), so the two places can never offer different actions.
//
// Its words are still the Work Orders tab's English: the office's screens move to the catalog in
// Matt's order (LANG-1), and this one has not been converted yet. New words go through the catalog.
//
// Matt's email (2026-10-09): the drawer also shows the FIRST-REPLY clock (his 30 minutes, the
// WO-5 window) beside the fix deadline, from lib/clientRequests requestClock — the one clock the
// queue counts down. It draws work orders only: a customer's message thread is answered where it
// lives, Messaging → Customers and the customer page's Messages tab (HUB-24 (c), 2026-10-12).
//
// WO-19: a ticket a FAILED inspection opened (type `failed_inspection`, lib/failedInspectionTicket)
// names the building's cleaners on it (`crew_user_ids`) and opens the inspection's report
// (`inspection_id`, components/InspectionReportModal — the report the Quality hub opens).
//
// THE CLEANER HUB (2026-10-13, brief C §1): EVERY ticket shows "Cleaners on this ticket", and the
// OFFICE chooses them here — the building's cleaners first (anyone on its cleans from a week back to
// two weeks ahead, lib/crewRequests buildingCleaners), then a search over every active cleaner
// (SearchSelect: capped, never the whole roster at once, UI_RULES §127). Each one added sees the
// request on their phone (/my-day/requests) and is told; the server holds the rule (office only,
// active cleaners, bounded — lib/crewRequests checkCrewRouting). A cleaner sees the list read-only.
//
// QR Wave 2 (2026-10-17, QR-22..QR-26): a ticket a VISITOR reported from a QR code says so ("Reported
// by a visitor"), with the name and the phone or email they left, a reply link built from the checked
// contact (lib/visitorReports visitorContactHref) — the office's alone: a cleaner's copy of the ticket
// never carries them (api/qc) — and the photo they added (scope visitor_report, read-only). Any
// ticket about one of the building's areas names it (`site_area_id`, lib/workOrders ticketAreaLabel).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { selectUserById, selectActiveUsers, selectSites, selectClientById } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import { fmtDate } from '../lib/dates';
import {
  nextStatus, isOpenStatus,
  WO_CATEGORIES, WO_CATEGORY_META, woCategoryLabel, UNCATEGORIZED_LABEL,
  RESOLVE_PHOTO_MESSAGE, FAILED_INSPECTION_TYPE,
  woStatusLabel, woPriorityLabel, woTypeLabel,
  WO_STATUS_META, WO_PRIORITY_META, WO_TYPE_META, WO_PRIORITIES,
} from '../lib/workOrders';
import Badge from './Badge';
import Icon from './Icon';
import SearchSelect from './SearchSelect';
import MediaGallery from './MediaGallery';
import InspectionReportModal from './InspectionReportModal';
import SidePanel from './SidePanel';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { requestClock } from '../lib/clientRequests';
import { isClientRequestType, isVisitorReport, ticketAreaLabel } from '../lib/workOrders';
import { visitorContactHref } from '../lib/visitorReports';
import { buildingCleaners, isRoutableCrew, ticketCrewIds, MAX_REQUEST_CREW, CREW_ROUTING_CODES, CREW_ROUTING_ERROR_KEYS } from '../lib/crewRequests';

export const initialsOf = (name) => (name || '').split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

// Who raised a ticket, as the office reads it — ONE chip for the Work Orders list and this drawer: a
// customer's (◆ Client portal), the office's own (Internal), or a visitor's from a QR code.
const ORIGIN_KEYS = Object.freeze({
  portal: 'workOrders.origin.portal',
  internal: 'workOrders.origin.internal',
  visitor: 'workOrders.origin.visitor',
});
export function WorkOrderOriginChip({ origin }) {
  const t = useT();
  const o = Object.prototype.hasOwnProperty.call(ORIGIN_KEYS, origin) ? origin : 'internal';
  return <span className={`wo-origin ${o}`}>{t(ORIGIN_KEYS[o])}</span>;
}

// QR-23 (f): the visitor's own name and phone or email, when they left them (the office's alone).
function VisitorReporter({ wo }) {
  const t = useT();
  const name = typeof wo.reporter_name === 'string' && wo.reporter_name.trim() ? wo.reporter_name.trim() : null;
  const contact = typeof wo.reporter_contact === 'string' && wo.reporter_contact.trim() ? wo.reporter_contact.trim() : null;
  const href = contact ? visitorContactHref(contact) : null;
  if (!name && !contact) return <div className="wo-dh-raised">{t('workOrders.drawer.visitorNoContact')}</div>;
  return (
    <div className="wo-dh-raised">
      {name ? t('workOrders.drawer.visitorBy', { name }) : t('workOrders.origin.visitor')}
      {contact && <> · {href ? <a href={href}>{contact}</a> : contact}</>}
    </div>
  );
}
const fmtMsgTime = (iso) => { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

// One message in the work-order thread. Client messages sit left (gold), office/crew
// right (ink). translated_body renders the auto-translation under the original.
// WO-9: an INTERNAL note (`m.internal`) is the office's own line — the client hub never
// fetches it — so it is drawn apart (dashed, unfilled) and labelled, never mistaken for a reply.
function WorkOrderMessage({ m }) {
  const client = m.author_role === 'client';
  const internal = m.internal === true;
  return (
    <div className={`wo-msg ${client ? 'client' : 'us'}${internal ? ' internal' : ''}`}>
      <span className={`wo-msg-av ${client ? 'client' : ''}`}>{initialsOf(m.author_name) || (client ? 'C' : 'S')}</span>
      <div className="wo-bub">
        {internal && <div className="wo-msg-internal">Internal note · not shown to the client</div>}
        <div className="wo-msg-who">{m.author_name || (client ? 'Client' : 'Staff')}</div>
        <div>{m.body}</div>
        {m.translated_body && <div className="wo-trans">“{m.translated_body}” · auto-translated from {m.from_lang}</div>}
        <div className="wo-msg-at">{fmtMsgTime(m.created_at)}</div>
      </div>
    </div>
  );
}

// The drawer itself: the shared SidePanel (its slide in and out, the dim that closes it, Esc),
// drawing the ticket's detail. Always mounted by its pages: `wo` null closes it, and the panel
// keeps the last ticket, with the names it came with, on screen while it slides out. `wo` carries
// its `sla` (deriveSla). The detail mounts with each opening, so its state starts fresh each time.
export default function WorkOrderDrawer({ wo, canManage, onClose, onUpdate, onRefresh, clientName, supervisorName }) {
  const item = wo ? { wo, clientName, supervisorName } : null;
  return (
    <SidePanel item={item} onClose={onClose} className="wo-drawer" label="Work order detail">
      {(shown) => (
        <WorkOrderDetail
          wo={shown.wo} canManage={canManage} onClose={onClose}
          onUpdate={onUpdate} onRefresh={onRefresh} clientName={shown.clientName} supervisorName={shown.supervisorName}
        />
      )}
    </SidePanel>
  );
}

// The first-reply line in a ticket's detail: sent (when), not needed (an issue, or the ticket has
// moved on), or the countdown — lib/clientRequests requestClock, the queue's own clock.
function FirstReplyCell({ wo, settings }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);
  if (!isClientRequestType(wo.type)) return null;
  const clock = requestClock(wo, { now, settings });
  let text;
  let tone = '';
  if (wo.first_reply_at) text = t('workOrders.firstReply.sent', { at: wo.first_reply_at });
  else if (clock.phase !== 'reply') text = '—';
  else if (clock.state === 'breached') { text = t('workOrders.firstReply.overdue', { time: clock.minutes }); tone = 'sla-breached'; }
  else { text = t('workOrders.firstReply.left', { time: clock.minutes }); tone = 'sla-soon'; }
  return (
    <div><div className="wo-k">{t('workOrders.firstReply.label')}</div><div className="wo-v"><span className={`wo-sla ${tone}`}>{text}</span></div></div>
  );
}

// "Cleaners on this ticket" (the Cleaner Hub, brief C §1). The office adds and removes them; each
// change is ONE update of the whole list (the server tells only the newly added), said in a toast.
// Everyone else reads the names. A cleaner since removed from the roster keeps their place by id
// ("No longer active") until the office takes them off.
function TicketCleaners({ wo, state, canRoute, onRefresh, failedInspection }) {
  const t = useT();
  const toast = useToast();
  const stored = useMemo(() => ticketCrewIds(wo), [wo]);
  const storedKey = stored.join('|');
  const [ids, setIds] = useState(stored);
  useEffect(() => { setIds(stored); }, [wo.id, storedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const users = useMemo(() => (Array.isArray(state.users) ? state.users : []), [state.users]);
  const byId = useMemo(() => new Map(users.filter((u) => u && u.id).map((u) => [u.id, u])), [users]);
  const building = useMemo(
    () => (canRoute ? buildingCleaners({ jobs: state.jobs || [], siteId: wo.site_id || null, clientId: wo.client_id || null, users, now: Date.now() }) : []),
    [canRoute, state.jobs, users, wo.site_id, wo.client_id],
  );
  const onBuilding = useMemo(() => new Set(building.map((u) => u.id)), [building]);
  const suggestions = building.filter((u) => !ids.includes(u.id));
  const searchOptions = useMemo(() => (canRoute ? users
    .filter((u) => isRoutableCrew(u) && !ids.includes(u.id))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((u) => ({ value: u.id, label: u.name || u.email || u.id, sublabel: onBuilding.has(u.id) ? '' : t('crewRequests.routing.notOnBuilding') }))
    : []), [canRoute, users, ids, onBuilding, t]);
  const full = ids.length >= MAX_REQUEST_CREW;

  const save = async (next, { added = null, removed = null } = {}) => {
    if (saving) return;
    setSaving(true);
    try {
      const after = await qcApi.updateProblem({ id: wo.id, crewUserIds: next });
      setIds(after ? ticketCrewIds(after) : next);
      const name = byId.get(added || removed)?.name || '';
      toast.success(added ? t('crewRequests.routing.added', { name }) : t('crewRequests.routing.removed', { name }));
      if (onRefresh) onRefresh();
    } catch (e) {
      toast.error(errorText(t, e, 'crewRequests.routing.failed', CREW_ROUTING_ERROR_KEYS));
    } finally {
      setSaving(false);
    }
  };
  const add = (id) => { if (id && !ids.includes(id) && !full) save([...ids, id], { added: id }); };
  const remove = (id) => save(ids.filter((x) => x !== id), { removed: id });

  return (
    <div className="wo-dsec">
      <div className="wo-k">{t('workOrders.drawer.cleaners')}</div>
      {ids.length === 0 ? (
        <p className="wo-desc text-muted">{failedInspection ? t('workOrders.drawer.noCleaners') : t('crewRequests.routing.none')}</p>
      ) : canRoute ? (
        <div className="wo-crew-chips">
          {ids.map((id) => {
            const u = byId.get(id);
            const left = !u || !isRoutableCrew(u);
            return (
              <span key={id} className={`wo-crew-chip${left ? ' is-left' : ''}`}>
                {/* i18n-ok: a person's name, as written */}
                {u?.name || id}{left ? <span className="wo-crew-left"> · {t('crewRequests.routing.left')}</span> : null}
                <button type="button" className="chip-remove" disabled={saving} aria-label={t('crewRequests.routing.removeAria', { name: u?.name || id })} onClick={() => remove(id)}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <p className="wo-desc">{t('workOrders.drawer.cleanerNames', { names: ids.map((id) => byId.get(id)?.name).filter(Boolean) })}</p>
      )}
      {canRoute ? (
        <>
          {suggestions.length ? (
            <div className="wo-crew-suggest">
              <div className="text-xs text-muted">{t('crewRequests.routing.building')}</div>
              <div className="wo-crew-chips">
                {suggestions.map((u) => (
                  <button key={u.id} type="button" className="chip" disabled={saving || full} aria-label={t('crewRequests.routing.addAria', { name: u.name || u.id })} onClick={() => add(u.id)}>
                    {/* i18n-ok: a person's name, as written */}
                    {u.name || u.id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="wo-crew-search">
            <SearchSelect
              value=""
              onChange={(id) => add(id)}
              options={searchOptions}
              placeholder={t('crewRequests.routing.search')}
              searchPlaceholder={t('crewRequests.routing.searchPlaceholder')}
              allowClear={false}
              disabled={saving || full}
              disabledText={full ? t(CREW_ROUTING_ERROR_KEYS[CREW_ROUTING_CODES.tooMany]()) : null}
            />
          </div>
          <p className="text-xs text-muted wo-crew-hint">{t('crewRequests.routing.hint')}</p>
        </>
      ) : null}
    </div>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────
function WorkOrderDetail({ wo, canManage, onClose, onUpdate, onRefresh, clientName, supervisorName }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  const t = useT();
  // The area the ticket is about, named from its own location's list (QR-16 / QR-23).
  const areaLabel = useMemo(() => (wo.site_area_id
    ? ticketAreaLabel(wo, (state.sites || []).find((s) => s && s.id === wo.site_id) || null)
    : null), [wo, state.sites]);
  // WO-19: a failed inspection's ticket opens its inspection report. Its cleaners — and every
  // other ticket's since the Cleaner Hub — are TicketCleaners' (above); the office chooses them.
  const failedInspection = wo.type === FAILED_INSPECTION_TYPE || !!wo.inspection_id;
  const [reportOpen, setReportOpen] = useState(false);
  useEffect(() => { setReportOpen(false); }, [wo.id]);
  const assignable = useMemo(() => selectActiveUsers(state), [state]);
  // CS-697: the office (never a cleaner — the server says the same) gives a ticket with no location
  // its location: one of the ticket's own customer's when it has one, else any of the company's.
  const canSetLocation = canManage && !!currentUser && currentUser.role !== 'crew';
  const locationOptions = useMemo(() => (wo.site_id || !canSetLocation ? [] : selectSites(state)
    .filter((s) => s && (!wo.client_id || s.clientId === wo.client_id))
    .map((s) => { const c = selectClientById(state, s.clientId); return { value: s.id, label: c?.name || s.name, sublabel: s.address || '' }; })),
  [state, wo.site_id, wo.client_id, canSetLocation]);
  const assigneeName = wo.assignee_user_id ? (selectUserById(state, wo.assignee_user_id)?.name || null) : null;
  const next = nextStatus(wo.status);
  // 🔴 WO-10: resolving needs a completion photo on THIS ticket. The count comes from the very
  // gallery below — `MediaGallery`'s own `onCount`, so there is ONE read and the button can
  // never disagree with what is on screen. A ticket with no location can carry no photos at
  // all, so it counts as none. The SERVER is the boundary (it refuses with the same sentence);
  // this only stops the button offering a click that cannot work.
  const [photoCount, setPhotoCount] = useState(0);
  useEffect(() => { setPhotoCount(0); }, [wo.id]);
  const needsPhoto = photoCount === 0;
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // WO-9: on a CLIENT ticket a line can be an internal note instead of a reply. Off by
  // default (the composer's job there is answering the client) and reset per ticket.
  const [internalNote, setInternalNote] = useState(false);
  useEffect(() => { setInternalNote(false); }, [wo.id]);
  const loadMsgs = useCallback(() => { qcApi.listWorkOrderMessages(wo.id).then(setMessages).catch(() => setMessages([])); }, [wo.id]);
  useEffect(() => { setMessages(null); loadMsgs(); }, [loadMsgs]);
  const send = async () => {
    const b = draft.trim();
    if (!b || sending) return;
    setSending(true);
    try {
      await qcApi.addWorkOrderMessage({ problemId: wo.id, body: b, authorUserId: currentUser?.id || null, authorRole: currentUser?.role === 'crew' ? 'crew' : 'office', authorName: currentUser?.name || null, internal: wo.origin === 'portal' && internalNote });
      setDraft(''); loadMsgs(); onRefresh && onRefresh(); // reload the list — status may have auto-advanced
    } catch (e) { toast.error(e.message || 'Could not send the message'); } finally { setSending(false); }
  };
  return (
    <>
      <div className="wo-dh">
        <div className="wo-dh-top">
          <span className="mono wo-dh-id">{wo.id?.startsWith('pr_') ? 'WO' : ''} · {fmtDate(wo.created_at)}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <h3 className="wo-dh-title">{wo.title}</h3>
        <div className="wo-dh-acct">{clientName}</div>
        {/* HUB-13: a ticket raised in the customer hub names WHICH of the customer's people raised it. */}
        {wo.raised_by_client_name && <div className="wo-dh-raised">Raised by {wo.raised_by_client_name} in the customer hub</div>}
        {isVisitorReport(wo) && <VisitorReporter wo={wo} />}
        <div className="wo-dh-badges">
          {wo.escalated && <span className="wo-esc-ribbon"><Icon name="warning" size={12} /> Escalated</span>}
          <Badge variant={WO_STATUS_META[wo.status]?.badge || 'slate'}>{woStatusLabel(wo.status)}</Badge>
          <span className={`wo-pri pri-${wo.priority}`}><span className="wo-dot" />{woPriorityLabel(wo.priority)}</span>
          <Badge variant={WO_TYPE_META[wo.type]?.badge || 'slate'}>{woTypeLabel(wo.type)}</Badge>
          {wo.category && <Badge variant="blue">{woCategoryLabel(wo.category)}</Badge>}
          <WorkOrderOriginChip origin={wo.origin} />
        </div>
      </div>

      <div className="wo-dmeta">
        <div><div className="wo-k">Queue / supervisor</div><div className="wo-v">{supervisorName || '—'}</div></div>
        {wo.site_area_id && (
          <div><div className="wo-k">{t('workOrders.drawer.area')}</div><div className="wo-v">{areaLabel || t('workOrders.drawer.areaRemoved')}</div></div>
        )}
        <FirstReplyCell wo={wo} settings={state.opsSettings || {}} />
        <div><div className="wo-k">SLA</div><div className="wo-v"><span className={`wo-sla sla-${wo.sla.state}`}>{wo.sla.label}</span></div></div>
        <div>
          <div className="wo-k">Assignee</div>
          <div className="wo-v">
            {canManage ? (
              <SearchSelect
                value={wo.assignee_user_id || ''}
                onChange={(id) => onUpdate(wo.id, { assigneeUserId: id || null })}
                options={assignable.map((u) => ({ value: u.id, label: u.name }))}
                placeholder="Unassigned" searchPlaceholder="Assign to…"
              />
            ) : (assigneeName || 'Unassigned')}
          </div>
        </div>
        {canManage && (
          <div>
            {/* WO-12: the reporting category, editable here as Priority is. */}
            <div className="wo-k">Category</div>
            <div className="wo-v">
              <select className="input" value={wo.category || ''} onChange={(e) => onUpdate(wo.id, { category: e.target.value || null })}>
                <option value="">{UNCATEGORIZED_LABEL}</option>
                {WO_CATEGORIES.map((c) => <option key={c} value={c}>{WO_CATEGORY_META[c].label}</option>)}
              </select>
            </div>
          </div>
        )}
        {canManage && (
          <div>
            <div className="wo-k">Priority</div>
            <div className="wo-v">
              <select className="input" value={wo.priority} onChange={(e) => onUpdate(wo.id, { priority: e.target.value })}>
                {WO_PRIORITIES.map((p) => <option key={p} value={p}>{WO_PRIORITY_META[p].label}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {wo.description && <div className="wo-dsec"><div className="wo-k">Details</div><p className="wo-desc">{wo.description}</p></div>}

      <TicketCleaners wo={wo} state={state} canRoute={canSetLocation} onRefresh={onRefresh} failedInspection={failedInspection} />
      {wo.inspection_id && (
        <div className="wo-dsec">
          <button type="button" className="btn btn-outline wo-dsec-action" onClick={() => setReportOpen(true)}>
            <Icon name="shield" size={14} /> {t('workOrders.drawer.openReport')}
          </button>
          <InspectionReportModal open={reportOpen} inspectionId={wo.inspection_id || null} onClose={() => setReportOpen(false)} />
        </div>
      )}

      {/* The photo a VISITOR added to their report (scope visitor_report, QR-23 e) — read-only: only the
          public route files one, and it never counts as a completion photo (WO-10). */}
      {isVisitorReport(wo) && wo.site_id && (
        <div className="wo-dsec">
          <MediaGallery siteId={wo.site_id} clientId={wo.client_id} scope="visitor_report" refId={wo.id} label={t('workOrders.drawer.visitorPhoto')} hint="" readOnly hideWhenEmpty />
        </div>
      )}

      {/* The photo the CLIENT attached in the hub (scope client_ticket) — read-only here: only
          the customer files one, and it never counts as a completion photo (WO-10). */}
      {wo.origin === 'portal' && wo.site_id && (
        <div className="wo-dsec">
          <MediaGallery siteId={wo.site_id} clientId={wo.client_id} scope="client_ticket" refId={wo.id} label="Client’s photos" hint="" readOnly hideWhenEmpty />
        </div>
      )}

      <div className="wo-dsec">
        <div className="wo-thread-head">
          <div className="wo-k">Messages</div>
          {wo.origin === 'portal' && <span className="wo-shared">◆ Shared with {clientName} in the portal</span>}
        </div>
        <div className="wo-thread">
          {messages === null ? <div className="wo-thread-empty">Loading…</div>
            : messages.length === 0 ? <div className="wo-thread-empty">No messages yet.{wo.origin === 'portal' ? ' Reply and the client sees it in their portal.' : ''}</div>
            : messages.map((m) => <WorkOrderMessage key={m.id} m={m} />)}
        </div>
        {canManage && (
          <>
            <div className="wo-composer">
              <textarea className="input wo-composer-input" rows={2} placeholder={wo.origin === 'portal' && !internalNote ? 'Reply to the client…' : 'Add a note…'} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button type="button" className="btn btn-primary" disabled={sending || !draft.trim()} onClick={send}>{sending ? 'Sending…' : (internalNote ? 'Add note' : 'Send')}</button>
            </div>
            {wo.origin === 'portal' && (
              <button type="button" className={`wo-toggle wo-composer-opt ${internalNote ? 'on' : ''}`} onClick={() => setInternalNote((v) => !v)} aria-pressed={internalNote}>
                <span className={`toggle ${internalNote ? 'on' : 'off'}`} aria-hidden="true"><span className="toggle-thumb" /></span> Internal note: not shown to the client
              </button>
            )}
          </>
        )}
      </div>

      <div className="wo-dsec">
        <div className="wo-k">Completion photos</div>
        {wo.site_id ? (
          <>
            <MediaGallery siteId={wo.site_id} clientId={wo.client_id} scope="problem_report" refId={wo.id} label="" hint="Before / after photos. On a client ticket, the client sees these in their hub once it is completed." onCount={setPhotoCount} />
            {needsPhoto && wo.status !== 'resolved' && <p className="text-xs text-muted">{RESOLVE_PHOTO_MESSAGE}</p>}
          </>
        ) : (
          // CS-697: a ticket with no location can carry no photo, so it could never be resolved.
          // The office gives it its location (once; the server refuses a cleaner and a second set),
          // and the gallery opens; a cleaner is told to ask the office.
          <>
            <p className="text-muted text-sm wo-desc">{t('workOrders.drawer.noLocation')}{!canSetLocation && <> {t('workOrders.drawer.askOffice')}</>}</p>
            {canSetLocation && (
              <SearchSelect
                value=""
                onChange={(id) => { if (id) onUpdate(wo.id, { siteId: id }); }}
                options={locationOptions}
                placeholder={t('workOrders.drawer.setLocation')}
                searchPlaceholder={t('workOrders.modal.searchLocations')}
                allowClear={false}
              />
            )}
          </>
        )}
      </div>

      {canManage && (
        <div className="wo-dactions">
          {next && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={next === 'resolved' && needsPhoto}
              title={next === 'resolved' && needsPhoto ? RESOLVE_PHOTO_MESSAGE : undefined}
              onClick={() => onUpdate(wo.id, { status: next })}
            ><Icon name="chevronRight" size={14} /> {woStatusLabel(next)}</button>
          )}
          {!wo.escalated && isOpenStatus(wo.status) && <button type="button" className="btn wo-btn-danger" onClick={() => onUpdate(wo.id, { escalated: true })}><Icon name="warning" size={14} /> Escalate</button>}
          {wo.escalated && <button type="button" className="btn btn-outline" onClick={() => onUpdate(wo.id, { escalated: false })}>De-escalate</button>}
          {wo.status !== 'resolved'
            ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={needsPhoto}
                title={needsPhoto ? RESOLVE_PHOTO_MESSAGE : undefined}
                onClick={() => onUpdate(wo.id, { status: 'resolved' })}
              >Mark resolved</button>
            )
            /* Reopen is NEVER gated: a ticket must always be able to come back out of
               resolved, whatever its photos say (WO-10 covers only the move TO resolved). */
            : <button type="button" className="btn btn-outline" onClick={() => onUpdate(wo.id, { status: 'open' })}>Reopen</button>}
        </div>
      )}
    </>
  );
}
