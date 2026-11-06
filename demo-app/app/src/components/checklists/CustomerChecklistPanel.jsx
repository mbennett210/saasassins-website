import { useCallback, useEffect, useMemo, useState } from 'react';
import Avatar from '../Avatar';
import Badge from '../Badge';
import ConfirmDialog from '../ConfirmDialog';
import FilterSelect from '../FilterSelect';
import Icon from '../Icon';
import InspectionTemplateEditor from '../InspectionTemplateEditor';
import { useToast } from '../Toast';
import { useAuth } from '../../hooks/useAuth';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectActiveUsers, selectJobsForClient, selectUserById } from '../../store/selectors';
import { compareUsersByName } from '../../lib/roles';
import {
  SCHEDULED_JOB_STATUSES, assignChecklist, holdersOf, reassignChecklist, removeChecklistHolder,
} from '../../lib/checklistAssignments';
import { CLOCK_RULE_OFF_BADGE_KEYS, clockRulesOff } from '../../lib/clockRules';
import { PICKER_MAX_VISIBLE } from '../../lib/pickerOptions';
import * as qcApi from '../../lib/qcApi';
import { msg } from '../../i18n/core';
import { useT } from '../../i18n/react';
import { errorText } from '../../i18n/errors';

// ONE customer's checklists and who holds them — the SAME component in two places
// (UI_RULES §134): the Quality hub's Assignments tab, and the customer page's Service
// setup. Two surfaces that could drift about who holds what is exactly the drift this
// replaces; the old per-cleaner <Select> grid lived in ServiceSetupCard and a separate
// pop-up organizer lived in the Quality hub, and they said different things about the
// same map.
//
// The rules it renders (docs/plans/2026-09-27-checklists-by-location.md §1):
//   R1  "No checklist" is a NORMAL state. A scheduled cleaner without one is listed
//       neutrally, never as a warning.
//   R2  A checklist belongs to ONE customer and is assigned to named cleaners there. A
//       cleaner holds AT MOST ONE checklist per customer, which is the shape of
//       `client.crewChecklists` itself — so Reassign MOVES a pick and never adds a second.
//   R3  There is no customer-wide default.
//
// Every write goes through the SAME action and pruning the customer page always used
// (UPDATE_CLIENT_OPS with a pruned `crewChecklists`), so the two mounts cannot disagree
// and the org_state guard sees the write it has always seen. Each action is ONE step: no
// staged draft, no Save button — the mockup's whole point, and what makes a worklist row
// above fixable in one click.
const ADD_BLANK = '__blank__';
const COPY_PREFIX = 'copy:';

// A cleaner who is on one of this customer's upcoming / in-progress cleans. Same basis as
// the rest of the app, from the one constant (lib/checklistAssignments).
const isScheduled = (job) => SCHEDULED_JOB_STATUSES.includes(job.status);

export default function CustomerChecklistPanel({
  client,
  // TWO capabilities, because the server keeps two (L3 S2): `canEdit` is `ops.edit` —
  // ASSIGN, reassign, remove a holder — and `canEditTemplates` is `qc.templates.edit`,
  // which is what the server requires to add, copy, edit or delete a checklist. Offering
  // the second set on the first key handed a viewer five controls the server refuses
  // (UI_RULES §118: don't offer what the server will refuse for this viewer).
  canEdit = false,
  canEditTemplates = false,
  today = null,          // Map(cleanerId -> { done, total, complete }) for today's cleans, or null
  scheduleKnown = true,  // false while the store's jobs window is still filling (L3 S4):
                         // "not on an upcoming clean" is then a guess, so it is not said
  embedded = false,      // true inside the customer page's Service setup card
  sourceChecklists = null, // every checklist in the org, for "Start from…"; null = load it here
  headerActions = null,  // e.g. the Assignments screen's "Open customer" link
  onChanged = null,      // a write landed that the parent's own reads should pick up
  onSelectCleaner = null, // (userId) => void — the Assignments screen switches its rail
  reloadKey = 0,
}) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();

  const [templates, setTemplates] = useState(null);   // THIS customer's checklists | null while loading
  const [loadError, setLoadError] = useState(null);
  const [reload, setReload] = useState(0);
  const [sources, setSources] = useState(sourceChecklists);
  const [editorFor, setEditorFor] = useState(undefined); // undefined = closed · null = new · id = edit
  const [deleteTpl, setDeleteTpl] = useState(null);
  const [busy, setBusy] = useState(false);

  const clientId = client?.id;
  const picks = useMemo(() => client?.crewChecklists || {}, [client]);

  // This customer's own checklists. The list is scoped SERVER-side (`?clientId`), because
  // a customer's menus must never show another building's checklist — at 750 customers
  // narrowing 3,750 rows in the browser is both wrong and wasteful.
  useEffect(() => {
    if (!clientId) return undefined;
    let alive = true;
    setTemplates(null);
    setLoadError(null);
    Promise.resolve()
      .then(() => qcApi.listTemplates({ kind: 'checklist', clientId }))
      .then((rows) => { if (alive) setTemplates(rows || []); })
      .catch((e) => { if (alive) { setTemplates([]); setLoadError(e); } });
    return () => { alive = false; };
  }, [clientId, reload, reloadKey]);

  // "Start from…" needs every checklist in the org (starters, and the other customers'
  // checklists to copy). The Assignments screen already holds that read for its summary
  // and hands it down; embedded on a customer page there is nobody to hand it down, so it
  // is read once — and only for someone who can actually create one.
  useEffect(() => { if (sourceChecklists) setSources(sourceChecklists); }, [sourceChecklists]);
  useEffect(() => {
    if (sourceChecklists || !canEditTemplates || !clientId) return undefined;
    let alive = true;
    Promise.resolve()
      .then(() => qcApi.templatesSummary())
      .then((rows) => { if (alive) setSources(rows || []); })
      .catch(() => { if (alive) setSources([]); });   // the picker just offers "Blank" then
    return () => { alive = false; };
  }, [sourceChecklists, canEditTemplates, clientId, reloadKey]);

  const activeUsers = useMemo(() => selectActiveUsers(state).slice().sort(compareUsersByName), [state]);
  const scheduledIds = useMemo(() => {
    if (!clientId) return new Set();
    return new Set(selectJobsForClient(state, clientId).filter(isScheduled).flatMap((j) => j.crewIds || []));
  }, [state, clientId]);

  const userOf = useCallback((id) => selectUserById(state, id), [state]);
  const supervisor = client?.supervisorId ? userOf(client.supervisorId) : null;

  // Every scheduled cleaner who holds nothing here. R1: this is a NORMAL list, not a
  // problem list — a 20-minute weekly clean does not need a checklist.
  const withoutChecklist = useMemo(() => (
    [...scheduledIds].filter((uid) => !picks[uid]).map(userOf).filter(Boolean).sort(compareUsersByName)
  ), [scheduledIds, picks, userOf]);

  // ── writes: one step each, straight to UPDATE_CLIENT_OPS ───────────────────
  const commit = (crewChecklists, message) => {
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_OPS,
      id: clientId,
      patch: { crewChecklists },
      actorName: currentUser?.name,
      summary: msg('alerts.ops.checklistAssignments'),
    });
    toast.success(message);
    onChanged?.();
  };
  const nameOf = (uid) => userOf(uid)?.name || t('cka.thatCleaner');
  const templateName = (tid) => templates?.find((tpl) => tpl.id === tid)?.name || t('cka.thatChecklist');

  const doAssign = (templateId, userId) => {
    if (!userId) return;
    const had = picks[userId];
    commit(assignChecklist(picks, { userId, templateId }), had && had !== templateId
      ? t('cka.moved', { name: nameOf(userId), checklist: templateName(templateId) })
      : t('cka.nowHas', { name: nameOf(userId), checklist: templateName(templateId) }));
  };
  const doReassign = (templateId, fromUserId, toUserId) => {
    if (!toUserId || toUserId === fromUserId) return;
    commit(reassignChecklist(picks, { templateId, fromUserId, toUserId }),
      t('cka.reassigned', { checklist: templateName(templateId), name: nameOf(toUserId) }));
  };
  const doRemove = (userId) => commit(removeChecklistHolder(picks, userId), t('cka.removed', { name: nameOf(userId) }));

  const doDelete = async (tpl) => {
    setBusy(true);
    try {
      await qcApi.deleteTemplate(tpl.id);
      // Anti-orphan: the same scrub the Templates tab runs, so no cleaner is left pointing
      // at a checklist that no longer exists. Completed checklists keep their own snapshot.
      dispatch({ type: ACTIONS.SCRUB_CHECKLIST_TEMPLATE, templateId: tpl.id });
      toast.success(t('cka.deleted', { name: tpl.name }));
      setReload((n) => n + 1);
      onChanged?.();
    } catch (e) { toast.error(errorText(t, e, 'cka.deleteFailed')); }
    finally { setBusy(false); }
  };

  const doAdd = async (value) => {
    if (!value) return;
    if (value === ADD_BLANK) { setEditorFor(null); return; }
    const sourceId = value.startsWith(COPY_PREFIX) ? value.slice(COPY_PREFIX.length) : null;
    if (!sourceId) return;
    setBusy(true);
    try {
      await qcApi.copyTemplate({ id: sourceId, clientId });
      toast.success(t('cka.copied'));
      setReload((n) => n + 1);
      onChanged?.();
    } catch (e) { toast.error(errorText(t, e, 'cka.copyFailed')); }
    finally { setBusy(false); }
  };

  // ── pickers (searchable, so 1,500 cleaners stay reachable) ─────────────────
  // Each picker's first row is its prompt and its value is always '' — picking is an
  // ACTION, not a selection, so the control returns to its prompt straight away.
  const cleanerOptions = (excludeIds = []) => {
    const skip = new Set(excludeIds);
    const rows = activeUsers.filter((u) => !skip.has(u.id));
    const here = rows.filter((u) => scheduledIds.has(u.id));
    const away = rows.filter((u) => !scheduledIds.has(u.id));
    return [
      { value: '', label: t('cka.assignCleaner') },
      ...here.map((u) => ({ value: u.id, label: t('cka.scheduledHere', { name: u.name }) })),
      ...away.map((u) => ({ value: u.id, label: t('cka.notScheduledHere', { name: u.name }) })),
    ];
  };
  const addOptions = useMemo(() => {
    const rows = sources || [];
    const starters = rows.filter((tpl) => tpl && tpl.id && !tpl.client_id);
    const others = rows.filter((tpl) => tpl && tpl.id && tpl.client_id && tpl.client_id !== clientId);
    const customerName = (id) => (state.clients || []).find((c) => c.id === id)?.name || t('cka.anotherCustomer');
    return [
      { value: '', label: t('cka.addChecklist') },
      { value: ADD_BLANK, label: t('cka.blank') },
      ...starters.map((tpl) => ({ value: `${COPY_PREFIX}${tpl.id}`, label: t('cka.startFrom', { name: tpl.name }) })),
      ...others.map((tpl) => ({ value: `${COPY_PREFIX}${tpl.id}`, label: t('cka.copyFrom', { name: tpl.name, customer: customerName(tpl.client_id) }) })),
    ];
  }, [sources, clientId, state.clients, t]);
  const giveOptions = useMemo(() => [
    { value: '', label: t('cka.give') },
    ...(templates || []).map((tpl) => ({ value: tpl.id, label: tpl.name })),
  ], [templates, t]);

  // ── badges ─────────────────────────────────────────────────────────────────
  const todayBadge = (uid) => {
    const day = today?.get(uid);
    if (!day) return null;
    if (day.complete) return <Badge variant="green">{t('cka.doneToday')}</Badge>;
    // 0/0 is not progress (UI_RULES §131) — an untouched checklist says so in words.
    return <Badge variant="amber">{day.total > 0 ? t('cka.todayProgress', { done: day.done, total: day.total }) : t('cka.notStartedToday')}</Badge>;
  };
  const ruleBadges = (u) => clockRulesOff(u).map((k) => <Badge key={k} variant="amber">{CLOCK_RULE_OFF_BADGE_KEYS[k] ? t(CLOCK_RULE_OFF_BADGE_KEYS[k]) : k}</Badge>);

  if (!client) return null;

  const count = templates?.length ?? 0;
  const addPicker = canEditTemplates && (
    <span className="cka-picker">
      <FilterSelect value="" onChange={doAdd} options={addOptions} maxVisible={PICKER_MAX_VISIBLE} ariaLabel={t('cka.addAria', { customer: client.name })} />
    </span>
  );

  return (
    <div className={`cka-customer${embedded ? ' cka-embedded' : ''}`}>
      {!embedded && (
        <div className="cka-dhead">
          <div className="cka-dhead-main">
            <span className="cka-label">{t('cka.customer')}</span>
            <h3 className="cka-dtitle">{client.name}</h3>
            <p className="text-sm text-muted cka-dsub">
              {[
                supervisor ? t('cka.supervisor', { name: supervisor.name }) : null,
                t('cka.scheduledCount', { count: scheduledIds.size }),
                templates === null ? null : t('cka.checklistCount', { count }),
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="cka-dhead-actions">
            {headerActions}
            {addPicker}
          </div>
        </div>
      )}

      <div className="cka-sect">
        <span className="cka-label cka-sect-label">
          {embedded ? t('cka.checklistsForCustomer') : t('cka.customersChecklists')}
        </span>
        {embedded && canEditTemplates && <div className="cka-embedded-actions">{addPicker}</div>}
        {templates === null ? (
          <p className="text-sm text-muted">{t('cka.loading')}</p>
        ) : loadError ? (
          <div className="callout callout-danger cka-callout" role="alert">
            <span className="text-sm">{t('cka.customerLoadFailed', { detail: errorText(t, loadError, 'cka.checkConnection') })}</span>
            <button type="button" className="btn btn-primary" onClick={() => setReload((n) => n + 1)}>{t('cka.tryAgain')}</button>
          </div>
        ) : count === 0 ? (
          <p className="text-sm text-muted">
            {t('cka.noChecklists')}
          </p>
        ) : templates.map((tpl) => {
          const holders = holdersOf(picks, tpl.id);
          const strays = holders.filter((uid) => !scheduledIds.has(uid));
          return (
            <div key={tpl.id} className={`cka-ck${holders.length === 0 || strays.length ? ' cka-ck-flagged' : ''}`}>
              <div className="cka-ck-head">
                <div className="cka-ck-name">
                  <span className="cka-ck-title">{tpl.name}</span>
                  <span className="text-xs text-muted">
                    {/* The count is a COLUMN on the row (step 5 F4): the published
                        version's, null while it is a draft. It used to come from the
                        org-wide summary, so the customer page read the whole book for a
                        number, a read-only viewer never saw one, and a checklist added a
                        second ago showed none until a reload (L3 S8). */}
                    {Number.isFinite(tpl.item_count) ? t('cka.itemCount', { count: tpl.item_count }) : t('cka.checklistWord')}
                    {tpl.is_published === false ? ` · ${t('cka.draft')}` : ''}
                  </span>
                </div>
                {canEditTemplates && (
                  <div className="cka-ck-actions">
                    <button type="button" className="btn btn-link" onClick={() => setEditorFor(tpl.id)}>{t('cka.edit')}</button>
                    <button type="button" className="btn btn-link" onClick={() => setDeleteTpl(tpl)}>{t('cka.delete')}</button>
                  </div>
                )}
              </div>
              <div className="cka-holders">
                {holders.length === 0 && <Badge variant="amber">{t('cka.nobodyHolds')}</Badge>}
                {holders.map((uid) => {
                  const u = userOf(uid);
                  if (!u) return null;
                  return (
                    /* Three GROUPS, not eight loose children (L3 S6): who · what is true of
                       them · what you can do. Each group wraps as a unit, so a long name
                       pushes the badges to their own line instead of squeezing them into
                       each other, and nothing ever paints over the name. */
                    <span className="cka-holder" key={uid}>
                      <span className="cka-holder-who">
                        <Avatar user={u} size="sm" />
                        {onSelectCleaner
                          ? <button type="button" className="linklike cka-holder-name" onClick={() => onSelectCleaner(uid)}>{u.name}</button>
                          : <span className="cka-holder-name">{u.name}</span>}
                      </span>
                      <span className="cka-holder-tags">
                        {scheduleKnown && !scheduledIds.has(uid) && <Badge variant="amber">{t('cka.notOnUpcoming')}</Badge>}
                        {todayBadge(uid)}
                        {ruleBadges(u)}
                      </span>
                      <span className="cka-holder-do">
                      {canEdit && (
                        <span className="cka-holder-move">
                          <FilterSelect
                            value=""
                            onChange={(to) => doReassign(tpl.id, uid, to)}
                            options={[{ value: '', label: t('cka.reassign') }, ...cleanerOptions([uid]).slice(1)]}
                            maxVisible={PICKER_MAX_VISIBLE}
                            ariaLabel={t('cka.reassignAria', { checklist: tpl.name, name: u.name })}
                          />
                        </span>
                      )}
                      {canEdit && (
                        <button type="button" className="chip-remove" aria-label={t('cka.removeAria', { name: u.name, checklist: tpl.name })} onClick={() => doRemove(uid)}>
                          <Icon name="x" size={12} />
                        </button>
                      )}
                      </span>
                    </span>
                  );
                })}
                {canEdit && (
                  <span className="cka-picker">
                    <FilterSelect
                      value=""
                      onChange={(uid) => doAssign(tpl.id, uid)}
                      options={cleanerOptions(holders)}
                      maxVisible={PICKER_MAX_VISIBLE}
                      ariaLabel={t('cka.assignToAria', { checklist: tpl.name })}
                    />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {withoutChecklist.length > 0 && (
        <div className="cka-sect">
          <span className="cka-label cka-sect-label">{t('cka.withoutChecklist')}</span>
          {withoutChecklist.map((u) => (
            <div className="cka-row" key={u.id}>
              <Avatar user={u} size="sm" />
              <span className="cka-row-grow">
                {onSelectCleaner
                  ? <button type="button" className="linklike" onClick={() => onSelectCleaner(u.id)}>{u.name}</button>
                  : <span>{u.name}</span>}
              </span>
              {todayBadge(u.id)}
              {ruleBadges(u)}
              <Badge variant="slate">{t('cka.noChecklist')}</Badge>
              {canEdit && count > 0 && (
                <span className="cka-picker">
                  <FilterSelect
                    value=""
                    onChange={(tid) => doAssign(tid, u.id)}
                    options={giveOptions}
                    ariaLabel={t('cka.giveAria', { name: u.name, customer: client.name })}
                  />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* `clientId` + `presetKind="checklist"` files a new checklist under THIS customer
          (R2). The editor is step 5's; this is the call, not a second copy of the rule. */}
      <InspectionTemplateEditor
        open={editorFor !== undefined}
        templateId={editorFor || null}
        presetKind="checklist"
        clientId={clientId}
        onClose={() => setEditorFor(undefined)}
        onSaved={() => { setEditorFor(undefined); setReload((n) => n + 1); onChanged?.(); }}
      />
      <ConfirmDialog
        open={!!deleteTpl}
        title={t('cka.deleteTitle')}
        message={deleteTpl
          ? t('cka.deleteMessage', { name: deleteTpl.name, count: holdersOf(picks, deleteTpl.id).length, customer: client.name })
          : ''}
        confirmLabel={t('cka.deleteConfirm')}
        variant="danger"
        onConfirm={() => deleteTpl && !busy && doDelete(deleteTpl)}
        onClose={() => setDeleteTpl(null)}
      />
    </div>
  );
}
