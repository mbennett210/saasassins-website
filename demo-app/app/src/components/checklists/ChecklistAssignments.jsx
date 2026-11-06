import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Avatar from '../Avatar';
import Badge from '../Badge';
import EmptyState from '../EmptyState';
import FilterSelect from '../FilterSelect';
import Icon from '../Icon';
import ListPager from '../ListPager';
import TableSearch from '../TableSearch';
import CleanerChecklistPanel from './CleanerChecklistPanel';
import CustomerChecklistPanel from './CustomerChecklistPanel';
import { useAuth } from '../../hooks/useAuth';
import { useFromHere } from '../../hooks/useFromHere';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { usePagedRows } from '../../hooks/usePagedRows';
import { usePermission } from '../../hooks/usePermission';
import { useTableSearch } from '../../hooks/useTableSearch';
import { useDispatch, useJobsHydrated, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectActiveUsers, selectClientById, selectUserById } from '../../store/selectors';
import { compareUsersByName } from '../../lib/roles';
import { searchRows } from '../../lib/searchRows';
import {
  ISSUE_HINT_KEYS, ISSUE_KINDS, ISSUE_LABEL_KEYS,
  checklistIssues, issueIndex, removeChecklistHolder, assignChecklist,
  scheduledCleanersByCustomer, todayByCustomer, resolveRailSelection, cleanerRailIndex,
} from '../../lib/checklistAssignments';
import { CLOCK_RULE_KEYS, CLOCK_RULE_LABEL_KEYS, clockRulesOff, nextClockRules } from '../../lib/clockRules';
import { opsAlertReadWindows } from '../../lib/opsAlerts';
import { PICKER_MAX_VISIBLE } from '../../lib/pickerOptions';
import { canRetryError } from '../../pages/reports/reportKit';
import * as qcApi from '../../lib/qcApi';
import { msg } from '../../i18n/core';
import { useT } from '../../i18n/react';
import { errorText } from '../../i18n/errors';

// Quality → Assignments: the problems-first summary (D) over the search-one-customer-or-
// cleaner workspace (B). Layout 1 of the 2026-09-27 mockup, signed off by the owner
// ("go w/ 1."), built to UI_RULES §134 and plan R9.
//
// 🔴 WHY IT IS SHAPED THIS WAY. At 750 customers × 1,500 cleaners nobody scrolls a list of
// assignments looking for what is wrong, and nothing here renders every customer at once:
//   · D says what needs attention across the whole book (four counters over ONE pure
//     answer, lib/checklistAssignments), and each worklist row is fixed in one click;
//   · B renders exactly ONE customer or ONE cleaner at a time, reached by search, with the
//     rail paged at 20 (UI_RULES §72).
// It replaced the pop-up organizer (ChecklistAssignmentsModal), which built a card for
// EVERY customer with a scheduled cleaner, staged every edit in local state and committed
// them on a Save button — unusable past a few dozen customers, and silently lost on a
// mis-click.
//
// Every read is the one another surface already makes: the checklist summary the pickers
// use, and the SAME window read the in-browser reminder tick runs
// (lib/opsAlerts.opsAlertReadWindows → qcApi.listChecklists), so "overdue today" here and
// the cleaner's nudge can never disagree.
const EMPTY_ROWS = [];

const FILTERS = [
  { key: 'all', labelKey: 'cka.filter.all' },
  { key: 'with', labelKey: 'cka.filter.with' },
  { key: 'attn', labelKey: 'cka.filter.attn' },
];

// One head per problem kind: only one worklist renders at a time, so each says what its
// own columns are instead of sharing a vague "item / details". Catalog keys ('' = no head).
const WORKLIST_HEADS = {
  overdue: ['cka.head.cleanerChecklist', 'cka.head.customer', 'cka.head.progress', ''],
  rules: ['cka.head.cleaner', 'cka.head.whatIsOff', '', ''],
  nobody: ['cka.head.checklist', 'cka.head.customer', '', ''],
  strays: ['cka.head.cleanerChecklist', 'cka.head.customer', '', ''],
};

const RULE_MEANING_KEYS = {
  [CLOCK_RULE_KEYS.checklist]: 'cka.ruleMeaning.checklist',
  [CLOCK_RULE_KEYS.geofence]: 'cka.ruleMeaning.geofence',
};

export default function ChecklistAssignments({ canEdit = false }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const { currentUser } = useAuth();
  const online = useOnlineStatus();
  // The store holds the cleans from 45 days back to 100 days ahead (the jobs window, CS-676 —
  // past the 90-day horizon every regular series is materialised to). Two of the four counters
  // are derived from it, so until it has loaded they answer "not known" rather than a number
  // nobody should act on (L3 S4) — the same gate Schedule and NewJobModal take.
  const jobsHydrated = useJobsHydrated();
  const nav = useFromHere();
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useTableSearch('q');

  // The two per-cleaner clock exemptions take an OFFICE role AS WELL AS the key, on every
  // row — the same rule the member's own Time tab applies and the server enforces
  // (api/_lib/orgStateGuard mayWriteClockRules). With the key alone, two granted cleaners
  // could exempt each other, and R5 leaves a cleaner no way around the block.
  // Managing a checklist is its own key, and the one the SERVER requires (L3 S2).
  // Assigning one is this screen's `ops.edit`; a viewer may hold either without the other.
  const canEditTemplates = usePermission('qc.templates.edit');
  const holdsClockRules = usePermission('time.clockRules');
  const canEditClockRules = holdsClockRules
    && (currentUser?.role === 'owner' || currentUser?.role === 'admin' || currentUser?.role === 'manager');

  const [data, setData] = useState({ summary: null, results: null, error: null, loading: true });
  const [reload, setReload] = useState(0);
  const opsSettings = state.opsSettings;

  // The summary is a narrow, COMPLETE read of every checklist (qc templates/summary); the
  // results are the reminder's own window. They fail apart: a failed checklist read must
  // not also empty the customer rail, and the reverse.
  useEffect(() => {
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    const windows = opsAlertReadWindows(opsSettings || {}, Date.now());
    Promise.allSettled([
      Promise.resolve().then(() => qcApi.templatesSummary()),
      Promise.resolve().then(() => qcApi.listChecklists(windows.checklists)),
    ]).then(([s, r]) => {
      if (!alive) return;
      setData({
        summary: s.status === 'fulfilled' ? (s.value || []) : null,
        results: r.status === 'fulfilled' ? (r.value || []) : null,
        error: s.status === 'rejected' ? s.reason : (r.status === 'rejected' ? r.reason : null),
        loading: false,
      });
    });
    return () => { alive = false; };
  }, [reload, opsSettings]);

  const clients = state.clients;
  const users = state.users;
  const jobs = state.jobs;

  const issues = useMemo(() => checklistIssues({
    clients: clients || [], users: users || [], jobs: jobs || [],
    templates: data.summary, results: data.results, now: Date.now(), settings: opsSettings || {},
    jobsHydrated,
  }), [clients, users, jobs, data, opsSettings, jobsHydrated]);
  const today = useMemo(() => todayByCustomer({
    clients: clients || [], jobs: jobs || [],
    templates: data.summary, results: data.results, now: Date.now(), settings: opsSettings || {},
  }), [clients, jobs, data, opsSettings]);
  const flags = useMemo(() => issueIndex(issues), [issues]);
  const scheduledByCustomer = useMemo(() => scheduledCleanersByCustomer(jobs || []), [jobs]);
  const checklistsByCustomer = useMemo(() => {
    const map = new Map();
    for (const tpl of data.summary || []) {
      if (!tpl || !tpl.client_id) continue;
      map.set(tpl.client_id, (map.get(tpl.client_id) || 0) + 1);
    }
    return map;
  }, [data.summary]);
  const templateName = useMemo(() => {
    const byId = new Map((data.summary || []).map((tpl) => [tpl.id, tpl.name]));
    return (id) => byId.get(id) || t('cka.assignedChecklist');
  }, [data.summary, t]);

  // ── URL state: the switch, the search, the filter and the selection ────────
  const setParams = (patch) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    return next;
  }, { replace: true });

  const selCustomer = searchParams.get('customer') || '';
  const selCleaner = searchParams.get('cleaner') || '';
  const view = searchParams.get('view') === 'cleaners' || (!searchParams.get('view') && selCleaner)
    ? 'cleaners' : 'customers';
  const filter = FILTERS.some((f) => f.key === searchParams.get('f')) ? searchParams.get('f') : 'all';
  const issueKind = ISSUE_KINDS.includes(searchParams.get('issue')) ? searchParams.get('issue') : ISSUE_KINDS[0];

  // ONE atomic URL update each (S1). These used to call setQ('') and then setParams(...) —
  // two functional updates against the same base in one batch, so the search SURVIVED,
  // the record you asked for was filtered out of the rail, and the screen quietly showed
  // whichever row happened to be first. Opening a record now touches only the selection:
  // the search and the filter are the user's, and an explicit selection outranks them
  // (see resolveRailSelection).
  const openCustomer = (id) => setParams({ view: 'customers', customer: id, cleaner: '', cpage: '' });
  const openCleaner = (id) => setParams({ view: 'cleaners', cleaner: id, customer: '', cpage: '' });
  // Switching the rail between two different books DOES clear the search and the chip:
  // "lakeside" means nothing in a list of cleaners. One update, so it actually lands.
  const switchView = (v) => setParams({ view: v, q: '', f: '', rpage: '' });
  const clearRailFilter = () => setParams({ q: '', f: '', rpage: '' });

  // ── the rail's rows ────────────────────────────────────────────────────────
  const activeUsers = useMemo(() => selectActiveUsers(state).slice().sort(compareUsersByName), [state]);
  // Built ONCE from the customers and the schedule — deliberately NOT keyed on `q`, so
  // typing in the rail filters over numbers this already holds instead of re-walking
  // 1,470 x 750 (S3).
  const cleanerIndex = useMemo(() => cleanerRailIndex({ clients, scheduledByCustomer }), [clients, scheduledByCustomer]);
  // ONE row shape, so the pinned row below and the list are the same thing.
  const customerRow = useCallback((c) => {
    const n = checklistsByCustomer.get(c.id) || 0;
    const crew = scheduledByCustomer.get(c.id)?.size || 0;
    return {
      id: c.id,
      name: c.name,
      sub: `${data.summary === null ? t('cka.checklistsUnknown') : t('cka.checklistCount', { count: n })} · ${t('cka.cleanerCount', { count: crew })}`,
      flagged: flags.byClient.has(c.id),
    };
  }, [checklistsByCustomer, scheduledByCustomer, flags, data.summary, t]);
  const cleanerRow = useCallback((u) => ({
    id: u.id,
    name: u.name,
    initials: u.initials,
    avatar: u.avatar,
    // The roster row itself, so the rail's avatar shows the cleaner's photo (UI_RULES §141).
    user: u,
    sub: `${t('cka.customerCount', { count: cleanerIndex.customerCount.get(u.id) || 0 })}${clockRulesOff(u).length ? ` · ${t('cka.ruleIsOff')}` : ''}`,
    flagged: flags.byUser.has(u.id),
  }), [cleanerIndex, flags, t]);

  const railRows = useMemo(() => {
    if (view === 'customers') {
      let rows = (clients || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      rows = searchRows(rows, q, (c) => c.name || '');
      if (filter === 'with') rows = rows.filter((c) => Object.keys(c.crewChecklists || {}).length || checklistsByCustomer.get(c.id));
      if (filter === 'attn') rows = rows.filter((c) => flags.byClient.has(c.id));
      return rows.map(customerRow);
    }
    let rows = searchRows(activeUsers, q, (u) => u.name || '');
    if (filter === 'with') rows = rows.filter((u) => cleanerIndex.holdsAnywhere.has(u.id));
    if (filter === 'attn') rows = rows.filter((u) => flags.byUser.has(u.id));
    return rows.map(cleanerRow);
  }, [view, clients, activeUsers, q, filter, flags, checklistsByCustomer, cleanerIndex, customerRow, cleanerRow]);

  const railPager = usePagedRows(railRows, { param: 'rpage', resetKey: `${view}|${q}|${filter}` });
  // An EXPLICIT selection outranks the rail's own filter (S1): it is shown, and PINNED to
  // the top of the rail when the filter hides it, rather than swapped for whatever row
  // happens to be first. The first row stands in only when there is nothing to show — no
  // selection, or an id whose record is gone.
  const askedFor = view === 'customers' ? selCustomer : selCleaner;
  const askedRecord = view === 'customers'
    ? (askedFor ? selectClientById(state, askedFor) : null)
    : (askedFor ? selectUserById(state, askedFor) : null);
  const selection = resolveRailSelection({
    selectedId: askedFor,
    exists: !!askedRecord,
    visibleIds: railRows.map((r) => r.id),
    fallbackId: railPager.pageRows[0]?.id || '',
  });
  const selectedId = selection.id;
  const selectedClient = view === 'customers' && selectedId ? selectClientById(state, selectedId) : null;
  const selectedUser = view === 'cleaners' && selectedId ? selectUserById(state, selectedId) : null;
  // The pinned row: the same row the list would draw, marked so the rail says plainly
  // that the record you are looking at is outside the filter you set.
  const pinnedRow = useMemo(() => {
    if (!selection.pinned || !askedRecord) return null;
    return view === 'customers' ? customerRow(askedRecord) : cleanerRow(askedRecord);
  }, [selection.pinned, askedRecord, view, customerRow, cleanerRow]);

  // ── the writes a worklist row makes directly ───────────────────────────────
  const commitPicks = (clientId, crewChecklists) => dispatch({
    type: ACTIONS.UPDATE_CLIENT_OPS,
    id: clientId,
    patch: { crewChecklists },
    actorName: currentUser?.name,
    summary: msg('alerts.ops.checklistAssignments'),
  });
  const removeStray = (clientId, userId) => {
    const c = selectClientById(state, clientId);
    if (!c) return;
    commitPicks(clientId, removeChecklistHolder(c.crewChecklists, userId));
  };
  const assignHere = (clientId, templateId, userId) => {
    const c = selectClientById(state, clientId);
    if (!c || !userId) return;
    commitPicks(clientId, assignChecklist(c.crewChecklists, { userId, templateId }));
  };
  // The SAME rule and write path as the member's Time tab (pages/settings/TeamDetail.jsx):
  // nextClockRules keeps the field sparse (null once nothing is off) and UPDATE_USER
  // carries it, so the two surfaces cannot drift and the server sees one shape.
  const turnRuleOn = (userId, key) => {
    const u = selectUserById(state, userId);
    if (!u || !canEditClockRules) return;
    dispatch({ type: ACTIONS.UPDATE_USER, id: userId, patch: { clockRules: nextClockRules(u.clockRules ?? null, key, false) } });
  };

  const cleanerOptionsFor = (clientId, exclude = []) => {
    const here = scheduledByCustomer.get(clientId) || new Set();
    const skip = new Set(exclude);
    const rows = activeUsers.filter((u) => !skip.has(u.id));
    return [
      { value: '', label: t('cka.assignCleaner') },
      ...rows.filter((u) => here.has(u.id)).map((u) => ({ value: u.id, label: t('cka.scheduledHere', { name: u.name }) })),
      ...rows.filter((u) => !here.has(u.id)).map((u) => ({ value: u.id, label: t('cka.notScheduledHere', { name: u.name }) })),
    ];
  };

  // ── D: the worklist for the selected counter ───────────────────────────────
  // null = the schedule is still loading, so this counter has no answer yet (S4).
  const worklist = issues[issueKind];
  const wlRows = worklist || EMPTY_ROWS;
  const wlPager = usePagedRows(wlRows, { param: 'wpage', resetKey: `${issueKind}|${wlRows.length}` });
  const customerName = (id) => selectClientById(state, id)?.name || '—';
  const cleanerName = (id) => selectUserById(state, id)?.name || '—';

  const worklistRow = (x, i) => {
    const key = `${issueKind}-${x.clientId || ''}-${x.userId || ''}-${x.templateId || ''}-${x.rule || ''}-${i}`;
    if (issueKind === 'overdue') {
      const u = selectUserById(state, x.userId);
      return (
        <tr key={key}>
          <td className="cell-primary">
            <span className="cka-wl-who">
              {u && <Avatar user={u} size="sm" />}
              <span className="truncate">{cleanerName(x.userId)} · {templateName(x.templateId)}</span>
            </span>
          </td>
          <td data-label={t('cka.head.customer')}><span className="truncate">{customerName(x.clientId)}</span></td>
          {/* Nothing submitted reads "Not started", never "0/0 done" — the same rule the
              locked clock-out button follows (UI_RULES §131): 0/0 is noise, not progress. */}
          <td data-label={t('cka.head.progress')}><Badge variant="amber">{x.total > 0 ? t('cka.progress', { done: x.done, total: x.total }) : t('cka.notStarted')}</Badge></td>
          <td className="cell-actions">
            <button type="button" className="btn btn-link" onClick={() => openCustomer(x.clientId)}>{t('cka.open')}</button>
          </td>
        </tr>
      );
    }
    if (issueKind === 'rules') {
      const u = selectUserById(state, x.userId);
      return (
        <tr key={key}>
          <td className="cell-primary">
            <span className="cka-wl-who">
              {u && <Avatar user={u} size="sm" />}
              <span className="truncate">{cleanerName(x.userId)}</span>
            </span>
          </td>
          <td data-label={t('cka.head.whatIsOff')}>
            <Badge variant="amber">{CLOCK_RULE_LABEL_KEYS[x.rule] ? t(CLOCK_RULE_LABEL_KEYS[x.rule]) : x.rule}</Badge>
            <span className="text-xs text-muted cka-wl-note">{RULE_MEANING_KEYS[x.rule] ? t(RULE_MEANING_KEYS[x.rule]) : null}</span>
          </td>
          <td data-label="" />
          <td className="cell-actions">
            {canEditClockRules && (
              <button type="button" className="btn btn-link" onClick={() => turnRuleOn(x.userId, x.rule)}>{t('cka.turnBackOn')}</button>
            )}
            <button type="button" className="btn btn-link" onClick={() => openCleaner(x.userId)}>{t('cka.open')}</button>
          </td>
        </tr>
      );
    }
    if (issueKind === 'nobody') {
      return (
        <tr key={key}>
          <td className="cell-primary"><span className="truncate">{templateName(x.templateId)}</span></td>
          <td data-label={t('cka.head.customer')}><span className="truncate">{customerName(x.clientId)}</span></td>
          <td data-label="">
            {canEdit && (
              <span className="cka-picker">
                <FilterSelect
                  value=""
                  onChange={(uid) => assignHere(x.clientId, x.templateId, uid)}
                  options={cleanerOptionsFor(x.clientId)}
                  maxVisible={PICKER_MAX_VISIBLE}
                  ariaLabel={t('cka.assignAria', { checklist: templateName(x.templateId), customer: customerName(x.clientId) })}
                />
              </span>
            )}
          </td>
          <td className="cell-actions">
            <button type="button" className="btn btn-link" onClick={() => openCustomer(x.clientId)}>{t('cka.open')}</button>
          </td>
        </tr>
      );
    }
    const u = selectUserById(state, x.userId);
    return (
      <tr key={key}>
        <td className="cell-primary">
          <span className="cka-wl-who">
            {u && <Avatar user={u} size="sm" />}
            <span className="truncate">{cleanerName(x.userId)} · {templateName(x.templateId)}</span>
          </span>
        </td>
        <td data-label={t('cka.head.customer')}>
          <span className="truncate">{customerName(x.clientId)}</span>
          <span className="text-xs text-muted cka-wl-note">{t('cka.notOnCleanThere')}</span>
        </td>
        <td data-label="" />
        <td className="cell-actions">
          {canEdit && <button type="button" className="btn btn-link" onClick={() => removeStray(x.clientId, x.userId)}>{t('cka.remove')}</button>}
          <button type="button" className="btn btn-link" onClick={() => openCustomer(x.clientId)}>{t('cka.open')}</button>
        </td>
      </tr>
    );
  };

  const heads = WORKLIST_HEADS[issueKind];
  const summaryFailed = data.summary === null && !data.loading;

  return (
    <div className="cka">
      {!online && (
        <p className="text-sm text-muted cka-note" role="status">
          {t('cka.offline')}
        </p>
      )}

      {/* D — four counters over ONE pure answer. A counter opens its worklist below. */}
      <div className="wo-cmdbar" role="group" aria-label={t('cka.countersAria')}>
        {ISSUE_KINDS.map((k) => (
          <button
            type="button"
            key={k}
            className={`wo-seg ${issueKind === k ? 'on' : ''}`}
            aria-pressed={issueKind === k}
            onClick={() => setParams({ issue: k, wpage: '' })}
          >
            <div className={`wo-seg-n tnum ${data.loading || !issues[k] ? '' : (issues[k].length ? 'warn' : 'good')}`}>
              {data.loading || !issues[k] ? '—' : issues[k].length}
            </div>
            <div className="wo-seg-l">{t(ISSUE_LABEL_KEYS[k])}</div>
            <div className="wo-seg-d">{t(ISSUE_HINT_KEYS[k])}</div>
          </button>
        ))}
      </div>

      {summaryFailed && (
        <div className="callout callout-danger cka-callout" role="alert">
          <span className="text-sm">
            {t('cka.loadFailed', { detail: errorText(t, data.error, 'cka.checkConnection') })}
          </span>
          {canRetryError(data.error) && (
            <button type="button" className="btn btn-primary" onClick={() => setReload((n) => n + 1)}>{t('cka.tryAgain')}</button>
          )}
        </div>
      )}

      {/* What the open counter means, at EVERY width — the tiles drop their own hint on a
          phone, so this is where that sentence always lives. */}
      <p className="text-xs text-muted cka-worklist-hint">{t(ISSUE_HINT_KEYS[issueKind])}</p>

      <div className="table-wrap mobile-stack cka-worklist">
        <table>
          <thead><tr>{heads.map((h, i) => <th key={h || `c${i}`}>{h ? t(h) : ''}</th>)}</tr></thead>
          <tbody>
            {data.loading ? (
              <tr className="stack-plain"><td colSpan={heads.length} className="cka-cell-msg">{t('cka.loading')}</td></tr>
            ) : !worklist ? (
              <tr className="stack-plain"><td colSpan={heads.length} className="cka-cell-msg">{t('cka.scheduleLoading')}</td></tr>
            ) : worklist.length === 0 ? (
              <tr className="stack-plain"><td colSpan={heads.length}>
                <EmptyState icon={<Icon name="check" size={28} />} title={t('cka.nothingHere')} message={t('cka.noneNow', { label: t(ISSUE_LABEL_KEYS[issueKind]) })} />
              </td></tr>
            ) : wlPager.pageRows.map(worklistRow)}
          </tbody>
        </table>
        <ListPager pager={wlPager} noun={t('cka.noun.items')} />
      </div>

      {/* B — search one customer or one cleaner; exactly one renders at a time. */}
      <div className="cka-work">
        <div className="cka-rail">
          <div className="cka-railhead">
            <div className="segmented" role="group" aria-label={t('cka.browseBy')}>
              <button type="button" className={`segmented-btn ${view === 'customers' ? 'active' : ''}`} onClick={() => switchView('customers')}>{t('cka.customers')}</button>
              <button type="button" className={`segmented-btn ${view === 'cleaners' ? 'active' : ''}`} onClick={() => switchView('cleaners')}>{t('cka.cleaners')}</button>
            </div>
            <TableSearch value={q} onChange={setQ} placeholder={view === 'customers' ? t('cka.searchCustomers') : t('cka.searchCleaners')} />
            <div className="cka-chips" role="group" aria-label={t('cka.filterAria')}>
              {FILTERS.map((f) => (
                <button
                  type="button"
                  key={f.key}
                  className={`chip chip-sm ${filter === f.key ? 'on' : ''}`}
                  onClick={() => setParams({ f: f.key === 'all' ? '' : f.key, rpage: '' })}
                >
                  {t(f.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="cka-list">
            {/* The open record, PINNED, when the search or the chip hides it (S1). The
                filter stays the user's and the record stays the one they asked for; the
                row says which is which, and Show all is one click. */}
            {pinnedRow && (
              <div className="cka-rail-pinned">
                <button type="button" className="cka-rail-row on" aria-pressed="true" aria-current="true">
                  {view === 'cleaners' && <Avatar user={pinnedRow.user} size="sm" />}
                  <span className="cka-rail-text">
                    <span className="cka-rail-nm truncate">{pinnedRow.name}</span>
                    <span className="cka-rail-sub truncate">{pinnedRow.sub}</span>
                  </span>
                  {pinnedRow.flagged && <span className="cka-flag" aria-label={t('cka.needsAttention')} />}
                </button>
                <p className="cka-rail-outside">
                  {q ? t('cka.outsideSearch') : t('cka.outsideFilter')}{' '}
                  <button type="button" className="linklike" onClick={clearRailFilter}>{t('cka.showAll')}</button>
                </p>
              </div>
            )}
            {railRows.length === 0 ? (
              <p className="text-sm text-muted cka-list-empty">
                {view === 'customers' ? t('cka.noCustomersMatch') : t('cka.noCleanersMatch')}
              </p>
            ) : railPager.pageRows.map((r) => (
              <button
                type="button"
                key={r.id}
                className={`cka-rail-row ${r.id === selectedId ? 'on' : ''}`}
                aria-pressed={r.id === selectedId}
                onClick={() => (view === 'customers' ? openCustomer(r.id) : openCleaner(r.id))}
              >
                {view === 'cleaners' && <Avatar user={r.user} size="sm" />}
                <span className="cka-rail-text">
                  <span className="cka-rail-nm truncate">{r.name}</span>
                  <span className="cka-rail-sub truncate">{r.sub}</span>
                </span>
                {r.flagged && <span className="cka-flag" aria-label={t('cka.needsAttention')} />}
              </button>
            ))}
          </div>
          <div className="cka-railfoot">
            <ListPager pager={railPager} noun={view === 'customers' ? t('cka.noun.customers') : t('cka.noun.cleaners')} />
            <span className="text-xs text-muted">
              {view === 'customers'
                ? t(q || filter !== 'all' ? 'cka.customerMatch' : 'cka.customerCount', { count: railRows.length })
                : t(q || filter !== 'all' ? 'cka.cleanerMatch' : 'cka.cleanerCount', { count: railRows.length })}
            </span>
          </div>
        </div>

        <div className="cka-detail">
          {view === 'customers' && selectedClient ? (
            <CustomerChecklistPanel
              client={selectedClient}
              canEdit={canEdit}
              canEditTemplates={canEditTemplates}
              today={today.get(selectedClient.id) || null}
              scheduleKnown={jobsHydrated}
              sourceChecklists={data.summary}
              onChanged={() => setReload((n) => n + 1)}
              onSelectCleaner={openCleaner}
              headerActions={<Link className="btn btn-outline" to={`/clients/${selectedClient.id}`} state={nav}>{t('cka.openCustomer')}</Link>}
              reloadKey={reload}
            />
          ) : view === 'cleaners' && selectedUser ? (
            <CleanerChecklistPanel
              user={selectedUser}
              canEditClockRules={canEditClockRules}
              today={today}
              templateName={templateName}
              onSelectCustomer={openCustomer}
              onTurnRuleOn={turnRuleOn}
              referrer={nav}
            />
          ) : (
            <EmptyState
              icon={<Icon name="forms" size={28} />}
              title={view === 'customers' ? t('cka.pickCustomer') : t('cka.pickCleaner')}
              message={view === 'customers' ? t('cka.pickCustomerHint') : t('cka.pickCleanerHint')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
