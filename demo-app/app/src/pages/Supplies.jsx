// Supplies — the order queue, usage, every building's state and the master list (S58, direction D:
// the "Swept-familiar" bulk queue; rebuilt 2026-10-04 to the approval-queue shape of UI_RULES §132,
// with pages/Approvals.jsx as the reference).
//
// 🔴 ROUND 3 (Daniel, 2026-10-06: "Go with A; but the separate supply tab in the customer view
// that B has. Wire it up."): a building's supply list lives on the customer's own Supplies tab
// (components/ClientSupplies), next to its budget and order day. An old `?tab=approved` link lands
// on Requests, or with `cust=` on that customer's Supplies tab. The request form is the order sheet
// (components/SupplyRequestModal), shared with the customer tab; its "Edit list" leads to that tab.
//
// 🔴 THE SUPPLY ORDERS (S131, plan docs/plans/2026-10-14-supply-orders.md; Matt's boards): a
// cleaner (or anyone holding supplies.request) orders from the building's list → the building's
// account manager approves it (or their operations manager, the owner or an admin; never the
// Supply Manager — lib/supplies maySupplyDecide) or declines it with a reason → the Supply Manager
// submits it to the supplier → each line is delivered (the Supply Manager on the order page, or the
// driver on /deliveries), backordered with the supplier's ETA, or cancelled with a reason → the
// Supply Manager marks it Completed once every line is resolved. The Requests tab IS the order
// queue (components/SupplyQueue: six tabs, an order's number, the bulk bar), with the Supply
// Manager's tiles over it for supplies.manage holders (components/SupplyQueueTiles); a row opens
// the order page (pages/SupplyOrder, /supplies/orders/:id). The in-page detail view and the
// "Record sent" step are deleted (II.5).
//
// 🔴 SUP-13 (2026-10-05): the queue and the approved lists left the shared record for their own
// tables. Everything here reads and writes through lib/suppliesApi (/api/supplies/*): the queue
// PAGES on the server (20 a page, its total said), and loading, error-with-Retry and offline are
// real states. Offline is HONEST: nothing is queued on the phone, so the controls say "No signal"
// and stay off until there is one (UI_RULES §131).
//
// 🔴 SUP-5 / CS-191: the Usage tab IS Reports → Supply usage (pages/reports/SupplyUsageReport
// `SupplyUsageView`, one implementation), counted per DELIVERY, 12 months back (SUP-13).
// 🔴 SUP-7 / SUP-10 ★a: the picked building's monthly budget sits in the queue's header.
// 🔴 BY BUILDING (the manager view redesign, Wave B, 2026-10-09; Matt's boards on SUP-14 ★a):
// `?tab=buildings`. Every building in the Manager / Customer scope with ONE state — Needs attention
// (over this month's budget), Pending approval (an order waiting for approval), Order placed
// (approved, or with the supplier), All set — from ONE complete read (suppliesApi.buildings → GET
// /api/supplies/buildings, lib/supplies supplyBuildingRows). No stock counts: the app keeps none
// (Matt's Q5). Reorder opens the order sheet for that building.
// 🔴 THE ACCOUNT MANAGER'S SIDE (S131 Wave 2, brief A; the AM Hub's boards am-web-08 / am-mobile-08):
// a 4th tile, Pending approval — the orders waiting for a decision THIS viewer may make (lib/supplies
// supplyAwaitingApproval over hooks/useSupplyRules, the queue's own rule) — and those orders as the
// "Awaiting your approval" cards over the table (components/SupplyApprovalCards: Decline with a
// reason, Approve in one tap, the existing decide door). Each row lists its orders in progress —
// "#SO-1047 · With Supply Manager · Partially fulfilled", then each line's state ("Trash liners —
// backordered (ETA Oct 21)": the supplier's ETA the Supply Manager typed is the only date shown) —
// each opening its order's page. The header's "need attention" counts the pending approvals inside.
// 🔴 THE TEAM (S131, Builder R's lib/teamScope): the Manager filter is lib/managerFilter's ONE rule —
// an Operations Manager opens on their whole team (`mgr=team`, which the server resolves from their
// claim) and picks among their team; a manager who supervises buildings opens on their own; the
// owner and an admin on all, picking anyone. The owner arriving from the Operations view's Supplies
// tile (`?mgr=team&om=<the OM>`, S131 Wave 2) reads THAT Operations Manager's team: the `om` goes
// with every read (By building, the queue, Usage), the route holding it to an owner or an admin
// naming an active Operations Manager (lib/teamScope teamLeadFor); picking anything else drops it.
// 🔴 THE CATALOG (Matt, the Oct 6 call: "the little Bible"; plan 2026-10-11 §2; S131's board
// sm-web-03): `?tab=catalog` — the org's master supply list, or one building's products
// (components/SupplyCatalog). The office edits it (supplies.manage); everyone with supplies.view
// reads it.
//
// "Location" is the customer (one location per customer). Prices are internal purchasing costs,
// shown to requesters where a price has been entered (SUP-4) — NOT customer financials, so no
// invoices.view gate here (see lib/roles.js supplies.* note).
//
// LANGUAGES (CS-193, UI_RULES §140): every word is a catalog line (`supplyPage.*`). People's own
// words — item names, notes, reasons, names — travel as written.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useStore } from '../store';
import { selectActiveClients, selectClientById } from '../store/selectors';
import { SUPERVISOR_ROLES } from '../lib/roles';
import { defaultManagerFor, managerFilterParam, managerFilterValue, managerFilterIds, teamPickLead } from '../lib/managerFilter';
import { TEAM, isOpsManager, teamMemberIds } from '../lib/teamScope';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useSupplyBudgets } from '../hooks/useSupplyBudgets';
import { useTableSearch } from '../hooks/useTableSearch';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePagedRows } from '../hooks/usePagedRows';
import { useSupplyRules } from '../hooks/useSupplyRules';
import { searchRows } from '../lib/searchRows';
import { money } from '../lib/dates';
import {
  SUPPLY_STATUS, SUPPLY_BUILDING_STATE, SUPPLY_LINE_STATE, supplyAwaitingApproval, supplyEtaInstant,
} from '../lib/supplies';
import * as suppliesApi from '../lib/suppliesApi';
import Icon from '../components/Icon';
import Badge from '../components/Badge';
import EmptyState from '../components/EmptyState';
import TableSearch from '../components/TableSearch';
import ListPager from '../components/ListPager';
import SupplyRequestModal from '../components/SupplyRequestModal';
import SupplyCatalog from '../components/SupplyCatalog';
import SupplyQueue from '../components/SupplyQueue';
import SupplyQueueTiles from '../components/SupplyQueueTiles';
import SupplyApprovalCards from '../components/SupplyApprovalCards';
import { ManagerFilter, CustomerFilter, defaultCustomRange, StatCard } from './reports/reportKit';
import { SupplyUsageView, SUPPLY_USAGE_PILLS } from './reports/SupplyUsageReport';
import { useT } from '../i18n/react';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The page's views (round 3: the building's list lives on the customer's Supplies tab; the
// manager view redesign added By building, 2026-10-09; the master supply list added the
// Catalog, 2026-10-11).
const TABS = [
  { key: 'requests', labelKey: 'supplyPage.tab.requests' },
  { key: 'usage', labelKey: 'supplyPage.tab.usage' },
  { key: 'buildings', labelKey: 'supplyPage.tab.buildings' },
  { key: 'catalog', labelKey: 'supplyPage.tab.catalog' },
];
// By building: each state's word, chip colour and tile tone (lib/supplies SUPPLY_BUILDING_STATE).
// Pending approval wears the queue's own Pending approval colour (lib/supplies supplyOrderVariant).
const BLD_STATE_KEYS = {
  [SUPPLY_BUILDING_STATE.attention]: 'supplyPage.bld.state.attention',
  [SUPPLY_BUILDING_STATE.pending]: 'supplyPage.bld.state.pending',
  [SUPPLY_BUILDING_STATE.placed]: 'supplyPage.bld.state.placed',
  [SUPPLY_BUILDING_STATE.allSet]: 'supplyPage.bld.state.allSet',
};
const BLD_STATE_VARIANTS = {
  [SUPPLY_BUILDING_STATE.attention]: 'red',
  [SUPPLY_BUILDING_STATE.pending]: 'purple',
  [SUPPLY_BUILDING_STATE.placed]: 'amber',
  [SUPPLY_BUILDING_STATE.allSet]: 'green',
};
// A row lists this many of its orders, then "+N more orders"; an order this many lines, then "+N more".
const BLD_ORDERS_SHOWN = 3;
const BLD_LINES_SHOWN = 4;
// Every view's own URL keys, cleared when the view changes so one tab's search or page never
// leaks into another (the queue's ?status= / ?q= / ?page=; the Catalog's ?cq= search, ?ccat=
// category, ?cp= page and ?cb= building).
const VIEW_KEYS = { status: null, page: null, q: null, iq: null, uq: null, bq: null, bp: null, cq: null, ccat: null, cp: null, cb: null };

export default function Supplies() {
  const t = useT();
  const state = useStore();
  const online = useOnlineStatus() !== false;
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canView = usePermission('supplies.view');
  const canManage = usePermission('supplies.manage');
  const canApprove = usePermission('supplies.approve');
  const canRequest = usePermission('supplies.request');
  const canDeliver = usePermission('supplies.deliver');
  const budgets = useSupplyBudgets();
  // What the demo stub reads to judge like the route does (the real route reads the claim).
  const ctx = useMemo(() => ({
    state, user: currentUser, holds: { view: canView, request: canRequest, approve: canApprove, manage: canManage, deliver: canDeliver },
  }), [state, currentUser, canView, canRequest, canApprove, canManage, canDeliver]);

  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab = rawTab === 'usage' || rawTab === 'buildings' || rawTab === 'catalog' ? rawTab : 'requests';
  // Round 3: the old "Approved items" tab is gone. A link to it (a bookmark, an old search hit)
  // lands on the Requests view — or, naming a customer, on that customer's Supplies tab, where
  // the list lives now.
  useEffect(() => {
    if (rawTab !== 'approved') return;
    const cust = params.get('cust');
    if (cust && selectClientById(state, cust)) { navigate(`/clients/${cust}?tab=supplies`, { replace: true, state: nav }); return; }
    const next = new URLSearchParams(params);
    next.delete('tab');
    next.delete('iq');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTab]);
  const setParam = useCallback((patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => { if (v == null || v === '') next.delete(k); else next.set(k, v); });
    return next;
  }, { replace: true }), [setParams]);

  // The Manager filter's people: an Operations Manager picks among their TEAM (themselves and their
  // account managers, lib/teamScope); everyone else among every active manager (S131 Wave 2).
  const managers = useMemo(() => {
    const active = (state.users || []).filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role));
    if (!isOpsManager(currentUser)) return active;
    const team = new Set(teamMemberIds(state.users || [], currentUser.id));
    return active.filter((u) => team.has(u.id));
  }, [state.users, currentUser]);
  const activeClients = useMemo(() => selectActiveClients(state), [state]);

  // The Manager filter (lib/managerFilter — the ONE rule Client Requests and Messaging → Customers
  // read, UI_RULES §169): an Operations Manager opens on their whole team (`team`, resolved on the
  // server from their claim), a manager who supervises buildings on their own, anyone else on all.
  // Choosing "All managers" over a default is stored as `mgr=all`, or the default would snap back.
  // `mgrScope` is the filter as the managers it keeps (the Customer filter's options).
  const defaultMgr = useMemo(() => defaultManagerFor(currentUser, state.clients, state.users), [currentUser, state.clients, state.users]);
  const mgrFilter = managerFilterValue({ viewer: currentUser, clients: state.clients, users: state.users, mgrParam: params.get('mgr') });
  // The owner's pick of an Operations Manager's team (lib/managerFilter teamPickLead): its `om`.
  const omParam = params.get('om') || '';
  const teamLead = useMemo(() => teamPickLead({ viewer: currentUser, users: state.users || [], value: mgrFilter, omParam }), [currentUser, state.users, mgrFilter, omParam]);
  const omFilter = teamLead ? teamLead.id : '';
  const mgrScope = useMemo(() => managerFilterIds(mgrFilter, { viewer: currentUser, users: state.users || [], omParam: omFilter }), [mgrFilter, omFilter, currentUser, state.users]);
  const custFilter = params.get('cust') || '';
  const setManager = (v) => setParam({ mgr: managerFilterParam(v, defaultMgr), om: v === TEAM ? omFilter || null : null, cust: null, page: null });

  // The tabs' counts: the queue reports its own on every read; another tab reads them once, for
  // the header's "N waiting · N new · N with the supplier".
  const [counts, setCounts] = useState(null);
  const onCounts = useCallback((c) => setCounts(c), []);
  const [queueKey, setQueueKey] = useState(0);
  useEffect(() => {
    if (tab === 'requests') return undefined;
    let live = true;
    suppliesApi.listOrders({ countsOnly: true }, ctx).then((r) => { if (live) setCounts(r.counts); }).catch(() => {});
    return () => { live = false; };
    // ctx carries the store for the demo stub; the real read keys on the tab alone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // ── By building (one complete read of every building's state, for the Manager / Customer) ──
  const [bld, setBld] = useState(null);           // { monthKey, buildings, counts } | null while loading
  const [bldErr, setBldErr] = useState(null);
  const [bldTick, setBldTick] = useState(0);
  const reloadBuildings = useCallback(() => setBldTick((n) => n + 1), []);
  useEffect(() => {
    if (tab !== 'buildings') return undefined;
    let live = true;
    setBldErr(null);
    setBld(null);
    suppliesApi.buildings({ mgr: mgrFilter, cust: custFilter, om: omFilter || null }, ctx)
      .then((r) => { if (live) setBld(r); })
      .catch((e) => { if (live) setBldErr(e); });
    return () => { live = false; };
    // ctx carries the store for the demo stub; the real read keys on the filters alone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mgrFilter, omFilter, custFilter, bldTick]);

  const [reqOpen, setReqOpen] = useState(false);
  // SUP-14 ★a: Reorder starts a new order for THAT building (the order sheet, preset to it).
  const [reorderFor, setReorderFor] = useState(null);
  // Global search "Request supplies" deep-link: ?new=1 opens the request modal once, then
  // strips only that param (any ?tab / ?status stays). Gated on canRequest.
  useEffect(() => {
    if (params.get('new') && canRequest) {
      setReqOpen(true);
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  }, [params, canRequest, setParams]);

  const switchTab = (next) => setParam({ tab: next === 'requests' ? null : next, ...VIEW_KEYS });

  // The Usage view's filters live in the URL beside the queue's (?period=, ?from=, ?to=; the
  // Manager and Customer are shared, so moving between tabs keeps the same building). A period
  // the view does not offer (an old `?period=60d`) reads as the default.
  const customDefault = useMemo(() => defaultCustomRange(), []);
  const usageFilters = {
    period: SUPPLY_USAGE_PILLS.some((p) => p.value === params.get('period')) ? params.get('period') : '30d',
    from: params.get('from') || customDefault.from,
    to: params.get('to') || customDefault.to,
    mgr: mgrFilter,
    om: omFilter,
    cust: custFilter,
  };
  const onUsageFilters = (patch) => {
    const p = { page: null };
    if ('period' in patch) p.period = patch.period === '30d' ? null : patch.period;
    if ('from' in patch) p.from = patch.from;
    if ('to' in patch) p.to = patch.to;
    if ('cust' in patch) p.cust = patch.cust;
    if ('mgr' in patch) { p.mgr = managerFilterParam(patch.mgr, defaultMgr); p.om = patch.mgr === TEAM ? omFilter || null : null; p.cust = null; }
    setParam(p);
  };

  const queueFilters = (
    <div className="filter-bar">
      <ManagerFilter managers={managers} currentUser={currentUser} value={mgrFilter} onChange={setManager} team teamLead={teamLead} />
      <CustomerFilter clients={activeClients} managerScope={mgrScope} value={custFilter} onChange={(v) => setParam({ cust: v, page: null })} />
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>{t('supplyPage.title')}</h1>
          {tab === 'buildings' ? (
            // Matt's board: "8 properties · 3 need attention", for the buildings in view — over budget
            // and pending approval alike (the counts' needAttention: the manager Home's figure too).
            <p className="page-sub">
              {bld ? <>{t('supplyPage.bld.properties', { count: bld.counts.total })} · {t('supplyPage.bld.needAttention', { count: bld.counts.needAttention })}</> : null}
            </p>
          ) : (
            <p className="page-sub">
              {counts ? t.rich('supplyPage.sub', {
                waiting: counts[SUPPLY_STATUS.requested] || 0, approved: counts[SUPPLY_STATUS.approved] || 0,
                sent: (counts[SUPPLY_STATUS.sent] || 0) + (counts.partial || 0),
              }) : null}
              {budgets.overCount > 0 ? <> · <span className="supply-over-inline">{t('supplyPage.overBudgetCount', { count: budgets.overCount })}</span></> : null}
            </p>
          )}
        </div>
        {canRequest && (
          <div className="page-head-actions">
            <button type="button" className="btn btn-primary" onClick={() => setReqOpen(true)} disabled={!online}>{t('supplyPage.request')}</button>
          </div>
        )}
      </div>
      {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}

      <div className="section-tabs" role="tablist" aria-label={t('supplyPage.viewsAria')}>
        {TABS.map((v) => (
          <button key={v.key} type="button" role="tab" aria-selected={tab === v.key} className={`section-tab ${tab === v.key ? 'active' : ''}`} onClick={() => switchTab(v.key)}>
            {t(v.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'requests' ? (
        <>
          {/* The Supply Manager's tiles (Matt's board), for whoever processes the orders. */}
          {canManage && <SupplyQueueTiles counts={counts} basePath="/supplies" />}
          <SupplyQueue
            ctx={ctx} mgrFilter={mgrFilter} omFilter={omFilter} custFilter={custFilter} filters={queueFilters} budgets={budgets}
            headExtra={<BudgetNote clientId={custFilter} state={state} budgets={budgets} />}
            reloadKey={queueKey} onCounts={onCounts}
            onChanged={() => { budgets.refresh(); reloadBuildings(); }}
          />
        </>
      ) : tab === 'buildings' ? (
        <BuildingsView
          {...{ data: bld, error: bldErr, onRetry: reloadBuildings, managers, currentUser, activeClients, mgrFilter, mgrScope, custFilter, teamLead,
            setManager, setParam, canRequest, canApprove, online, nav, ctx, onReorder: setReorderFor,
            onChanged: () => { reloadBuildings(); budgets.refresh(); setQueueKey((k) => k + 1); },
            onShowAll: () => switchTab('requests') }}
        />
      ) : tab === 'catalog' ? (
        <SupplyCatalog />
      ) : (
        <SupplyUsageView filters={usageFilters} onFilters={onUsageFilters} managers={managers} live />
      )}

      {(reqOpen || reorderFor) && (
        <SupplyRequestModal
          presetClientId={reorderFor || custFilter || null}
          budgets={budgets}
          onClose={() => { setReqOpen(false); setReorderFor(null); }}
          onSubmitted={() => { setReqOpen(false); setReorderFor(null); setQueueKey((k) => k + 1); reloadBuildings(); }}
          // The office's "Edit list" / "Set up the list": the building's own Supplies tab, its
          // switches open.
          onEditList={(id) => { setReqOpen(false); setReorderFor(null); navigate(`/clients/${id}?tab=supplies&edit=1`, { state: nav }); }}
        />
      )}
    </div>
  );
}

// The picked building's month, in a table's header (SUP-7 / SUP-10): spend of budget, and by how
// much it is over. Nothing when no building is picked, and a quiet "—" until the spend has
// loaded (an unloaded spend is not $0.00).
function BudgetNote({ clientId, state, budgets }) {
  const t = useT();
  if (!clientId) return null;
  const client = selectClientById(state, clientId);
  if (!client) return null;
  const st = budgets.statusFor(clientId);
  if (!st.loaded) return <span className="supply-budget text-sm text-muted">{budgets.error ? t('supplyPage.budget.failed') : '—'}</span>;
  if (st.budget == null) {
    return <span className="supply-budget text-sm text-muted">{t('supplyPage.budget.none', { amount: money(st.spend) })}</span>;
  }
  return (
    <span className={`supply-budget text-sm ${st.over ? 'is-over' : ''}`}>
      <span>{t.rich('supplyPage.budget.of', { amount: money(st.spend), budget: money(st.budget) })}</span>
      {st.over
        ? <Badge variant="red">{t('supplyPage.budget.over', { amount: money(round2(st.spend - st.budget)) })}</Badge>
        : <span className="text-muted">{t('supplyPage.budget.left', { amount: money(st.remaining) })}</span>}
    </span>
  );
}

// ── By building (the manager view redesign, Wave B, 2026-10-09; Matt's boards on SUP-14 ★a) ───
// The tiles (All set · Order placed · Needs attention, as the board draws Stocked · Low · Out; S131
// Wave 2 adds the board's 4th, Pending approval — the orders waiting for THIS viewer's decision — for
// whoever holds supplies.approve), the "Awaiting your approval" cards (components/SupplyApprovalCards),
// then every building with its one state and its orders in progress — "#SO-1047 · With Supply Manager
// · Partially fulfilled", each line's state under it, each opening its order's page — and who a
// waiting order waits on when it is not this viewer: never a stock count or a delivery date of the
// app's own (the only date is a backordered line's supplier ETA, as the Supply Manager typed it).
// Desktop: Property · Status · Items · Reorder. A phone folds the all-set buildings into one line, as
// the board does, and lists the rest as cards. The rows come ordered from the rule (needs attention
// first); the search (a building, an item, an approver or an order number) and the pager work over
// that complete list.
function BuildingsView({
  data, error, onRetry, managers, currentUser, activeClients, mgrFilter, mgrScope, custFilter, teamLead, setManager, setParam,
  canRequest, canApprove, online, nav, ctx, onReorder, onChanged, onShowAll,
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const rules = useSupplyRules();
  const [bq, setBq] = useTableSearch('bq', { reset: ['bp'] }); // one address update (CS-720)
  const all = useMemo(() => (data ? data.buildings : []), [data]);
  // 🔴 The cards and the 4th tile: the waiting orders THIS viewer may decide — the queue's own rule.
  const awaiting = useMemo(() => supplyAwaitingApproval(all, (o) => rules.mayDecide(o, 'approve')), [all, rules]);
  const mine = useMemo(() => new Set(awaiting.map((o) => o.id)), [awaiting]);
  const found = useMemo(() => searchRows(all, bq, (r) => `${r.name} ${r.items.join(' ')} ${r.approverName || ''} ${(r.orders || []).map((o) => o.no || '').join(' ')}`), [all, bq]);
  const allSetN = found.filter((r) => r.state === SUPPLY_BUILDING_STATE.allSet).length;
  const listed = useMemo(
    () => (isMobile ? found.filter((r) => r.state !== SUPPLY_BUILDING_STATE.allSet) : found),
    [found, isMobile],
  );
  const pager = usePagedRows(listed, { param: 'bp', resetKey: `${mgrFilter}|${teamLead ? teamLead.id : ''}|${custFilter}|${bq}|${isMobile}` });
  // An order's head — its number, then the account manager's words (lib/supplies supplyOrderAmKeys).
  const orderHead = (o) => [o.no ? `#${o.no}` : t('supplyPage.order.noNumber'), ...(o.labelKeys || []).map((k) => t(k))].join(' · ');
  // An order's lines: what was asked (name and quantity) until it is with the supplier, then each
  // line's state from the per-line record; this many, then "+N more".
  const lineWords = (o) => {
    const lines = o.lines || [];
    const parts = lines.map((l) => {
      const item = l.name || t('supplyPage.item');
      if (!l.state) return t('supplyPage.bld.itemQty', { item, qty: l.qty });
      if (l.state === SUPPLY_LINE_STATE.delivered) return t('supplyPage.bld.line.delivered', { item });
      if (l.state === SUPPLY_LINE_STATE.backordered) {
        return l.eta ? t('supplyPage.bld.line.backordered', { item, eta: supplyEtaInstant(l.eta) }) : t('supplyPage.bld.line.backorderedNoEta', { item });
      }
      if (l.state === SUPPLY_LINE_STATE.cancelled) return t('supplyPage.bld.line.cancelled', { item });
      return l.delivered > 0 ? t('supplyPage.bld.line.partly', { item, delivered: l.delivered, qty: l.qty }) : t('supplyPage.bld.line.onOrder', { item });
    });
    const head = parts.slice(0, BLD_LINES_SHOWN).join(lines.some((l) => l.state) ? ' · ' : ', ');
    return parts.length > BLD_LINES_SHOWN ? `${head} ${t('supplyPage.bld.moreItems', { count: parts.length - BLD_LINES_SHOWN })}` : head;
  };
  const counts = data ? data.counts : null;

  return (
    <>
      <div className="filter-bar">
        <ManagerFilter managers={managers} currentUser={currentUser} value={mgrFilter} onChange={setManager} team teamLead={teamLead} />
        <CustomerFilter clients={activeClients} managerScope={mgrScope} value={custFilter} onChange={(v) => setParam({ cust: v, bp: null })} />
      </div>

      {error ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('supplyPage.bld.loadFailed')}
          message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
          action={<button type="button" className="btn btn-primary" onClick={onRetry}>{t('supplyPage.tryAgain')}</button>}
        />
      ) : !data ? (
        <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>
      ) : all.length === 0 ? (
        <EmptyState icon={<Icon name="building" size={28} />} title={t('supplyPage.bld.empty')} message={t('supplyPage.bld.emptyHint')} />
      ) : (
        <>
          <div className={`stat-grid supply-bld-tiles${canApprove ? ' has-approvals' : ''}`}>
            <StatCard label={t('supplyPage.bld.state.allSet')} value={counts.allSet} tone={counts.allSet > 0 ? 'success' : null} />
            <StatCard label={t('supplyPage.bld.state.placed')} value={counts.placed} tone={counts.placed > 0 ? 'warn' : null} />
            <StatCard label={t('supplyPage.bld.state.attention')} value={counts.attention} tone={counts.attention > 0 ? 'danger' : null} />
            {canApprove && <StatCard label={t('supplyPage.bld.state.pending')} value={awaiting.length} tone={awaiting.length > 0 ? 'approval' : null} />}
          </div>

          <SupplyApprovalCards orders={awaiting} ctx={ctx} online={online} onChanged={onChanged} onShowAll={onShowAll} />

          <div className="table-head">
            <div className="table-controls">
              <TableSearch value={bq} onChange={setBq} placeholder={t('supplyPage.bld.search')} />
            </div>
          </div>

          {/* The board's phone line: every all-set building in one row. */}
          {isMobile && allSetN > 0 && (
            <p className="supply-bld-allset" role="status"><Icon name="check" size={16} /> {t('supplyPage.bld.allSetLine', { count: allSetN })}</p>
          )}

          {found.length === 0 ? (
            <EmptyState icon={<Icon name="search" size={28} />} title={t('supplyPage.noSearchMatch')} message={t('supplyPage.noSearchMatchHint')} />
          ) : listed.length === 0 ? null : (
            <>
              <div className="table-wrap mobile-stack">
                <table>
                  <thead>
                    <tr>
                      <th>{t('supplyPage.bld.col.property')}</th>
                      <th>{t('supplyPage.bld.col.status')}</th>
                      <th>{t('supplyPage.bld.col.items')}</th>
                      <th className="supply-actions-col"><span className="sr-only">{t('supplyPage.col.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageRows.map((r) => {
                      const orders = r.orders || [];
                      // §118: a waiting order that is not this viewer's to decide says whose it is.
                      const othersWaiting = orders.some((o) => o.status === SUPPLY_STATUS.requested && !mine.has(o.id));
                      return (
                        <tr key={r.clientId} className={`supply-bld-row is-${r.state}`}>
                          <td className="cell-primary">
                            <Link className="linklike truncate" to={`/clients/${r.clientId}?tab=supplies`} state={nav} title={r.name}>{r.name || '—'}</Link>
                          </td>
                          <td data-label={t('supplyPage.bld.col.status')}>
                            <Badge variant={BLD_STATE_VARIANTS[r.state]}>{t(BLD_STATE_KEYS[r.state])}</Badge>
                          </td>
                          <td data-label={t('supplyPage.bld.col.items')}>
                            {/* ONE cell child, so a phone card's label/value row stays two columns (§24). */}
                            <div className="supply-bld-items">
                              {orders.length === 0 && <span>—</span>}
                              {orders.slice(0, BLD_ORDERS_SHOWN).map((o) => (
                                <span key={o.id} className="supply-bld-order">
                                  {/* i18n-ok: the order's number, as stored, before the catalog's words */}
                                  <Link className="linklike supply-bld-order-head" to={`/supplies/orders/${encodeURIComponent(o.id)}`} state={nav}>{orderHead(o)}</Link>
                                  {/* i18n-ok: the items' own names, as the office wrote them, in the catalog's words */}
                                  <span className="text-xs text-muted">{lineWords(o)}</span>
                                </span>
                              ))}
                              {orders.length > BLD_ORDERS_SHOWN && (
                                <span className="text-xs text-muted">{t('supplyPage.bld.moreOrders', { count: orders.length - BLD_ORDERS_SHOWN })}</span>
                              )}
                              {othersWaiting && (
                                <span className="text-xs text-muted">{r.approverName ? t('supplyPage.bld.waitingFor', { name: r.approverName }) : t('supplyPage.noApprover')}</span>
                              )}
                              {r.over && <span className="text-xs supply-bld-over">{t('supplyPage.bld.over', { spend: r.spend, budget: r.budget })}</span>}
                            </div>
                          </td>
                          <td className="cell-actions supply-actions-col">
                            {canRequest && (
                              <button
                                type="button"
                                className={`btn btn-sm ${r.state === SUPPLY_BUILDING_STATE.attention ? 'btn-gold' : 'btn-outline'}`}
                                disabled={!online}
                                onClick={() => onReorder(r.clientId)}
                              >{t('supplyPage.bld.reorder')}</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ListPager pager={pager} noun={t('pager.noun.buildings')} />
            </>
          )}
        </>
      )}
    </>
  );
}
