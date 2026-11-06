// SUP-7 (b) / SUP-10 ★a — the over-budget supply flag.
//
// Matt (SUP-7 b): "a field where we can enter the estimated budget for the building. As we
// order the items which have prices, it goes against the budget. If it goes over the budget
// over a monthly period, the account is flagged as over budget for supplies." SUP-10 ★a settles
// the period as the CALENDAR month.
//
// The BUDGET is a field on the customer (the shared record). The SPEND is the snapshotted line
// totals of the requests DELIVERED this calendar month — and since SUP-13 (2026-10-05) those live
// in the supply table, so the spend is ONE server read (`suppliesApi.budgets` → GET
// /api/supplies/budgets, a complete narrow read summed in cents, in the ORG's month — II.8). The
// customers list, a customer's page, its budget card and the Supplies page all read it through
// this file, so they cannot disagree.
//
// 🔴 CS-963 (Daniel, 2026-11-02, "Same fix, after this release (Recommended)"): the spend is read
// as the app opens (`prefetchSupplyBudgets`, from the office shell) and kept for the app, the same
// way as the ticket counts (lib/keptRead.js, CS-962), so the Customers list and a customer's page
// draw with "Over supply budget" already in place and nothing moves after. Those two take the kept
// copy (`useKeptSupplyBudgets`): each draws with the spend as it was when it opened and asks for a
// read in the background (one a minute at most); what that read says shows the next time a page
// opens, never on the page already open. A page opened before the first read has answered waits
// (`ready` false: draw nothing the flag would move), then takes it once, or draws without the flag
// if it hasn't answered in WAIT_MS. The Supplies page and the supply usage report keep their own
// read (`useSupplyBudgets`), so their figures update right after an order changes, and each answer
// they get is kept for the next page that opens.
//
// 🔴 A spend that has not loaded is NOT zero. Until the read lands (or when it fails) every
// building answers `over: false` with `spend: null` and `loaded: false`, so a badge never claims
// "on budget" or "over budget" on no evidence — the readers show a quiet "—" or a Retry instead
// (UI_RULES §117: a figure reads its whole window or says it could not).
//
// Only a `supplies.view` holder asks (the route refuses anyone else).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore, useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { usePermission } from './usePermission';
import { todayKey, startOfMonthKey, startOfDayKey, fmtDateLong } from '../lib/dates';
import { supplyBudgetFor, isOverSupplyBudget, supplyOrderDayFor } from '../lib/supplies';
import * as suppliesApi from '../lib/suppliesApi';
import { createKeptRead } from '../lib/keptRead';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The app's one kept copy of this month's spend, { clientId → cents }; an answer of another shape
// is kept as none spent.
const keptSpend = createKeptRead({
  read: () => suppliesApi.budgets().then((r) => (r && r.spendCents) || {}),
  accept: (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
});

// What a page takes once the first read has answered, its wait is over, or a person's Retry has
// answered: ready, with whatever is kept for `owner` (nothing, if the read hasn't answered).
function settledView(owner) {
  const s = keptSpend.snapshot(owner);
  return { ready: true, value: s.value, failed: s.failed };
}

/** The office shell calls this as the app opens, so the spend is in before a page needs it. */
export function prefetchSupplyBudgets(userId) {
  keptSpend.setOwner(userId ?? null);
  keptSpend.refresh();
}

// The current org-zone calendar month as { monthKey, fromMs, label }.
export function currentSupplyMonth() {
  const firstKey = startOfMonthKey(todayKey());
  return {
    monthKey: firstKey.slice(0, 7),
    fromMs: startOfDayKey(firstKey).getTime(),
    label: fmtDateLong(startOfDayKey(firstKey).toISOString()).replace(/\s\d+,/, ''),
  };
}

// The Supplies page's and the supply usage report's: a read of its own as the page opens and on
// Retry, so its figures update right after an order changes. Each answer is kept for the next
// Customers list or customer's page that opens.
export function useSupplyBudgets() {
  const canView = usePermission('supplies.view');
  const owner = useSelector(selectCurrentUser)?.id ?? null;
  const [spendCents, setSpendCents] = useState(null); // { clientId → cents } | null until loaded
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!canView) return undefined;
    let live = true;
    setError(null);
    suppliesApi.budgets()
      .then((r) => {
        const cents = (r && r.spendCents) || {};
        keptSpend.take(owner, cents);
        if (live) setSpendCents(cents);
      })
      .catch((e) => { if (live) { setError(e); setSpendCents(null); } });
    return () => { live = false; };
  }, [canView, owner, tick]);

  return useBudgetsView({ spendCents, error, refresh, ready: true });
}

// The Customers list's and a customer's page's: the kept copy as the page opens, so "Over supply
// budget" is drawn with the page. It reads nothing itself.
export function useKeptSupplyBudgets() {
  const canView = usePermission('supplies.view');
  const owner = useSelector(selectCurrentUser)?.id ?? null;
  // What this page draws with, taken as it opens and kept while it is open. Someone who may not see
  // supplies has nothing to wait for, and a permission that changes while the page is open (the
  // owner's View as) leaves what the page took as it was: the flag follows on the next page.
  const [seen, setSeen] = useState(() => (canView ? keptSpend.snapshot(owner) : { ready: true, value: null, failed: false }));

  useEffect(() => {
    if (!canView) return undefined;
    keptSpend.setOwner(owner);
    keptSpend.refresh();
    if (seen.ready) return undefined;
    return keptSpend.whenSettled(() => setSeen(settledView(owner)));
    // Once, as the page opens: a read answering later is for the next page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A person's Retry (the budget card's, when the first read failed) reads at once, and this page
  // shows what it says: they asked.
  const refresh = useCallback(() => {
    const reading = keptSpend.refresh({ force: true });
    if (reading) reading.then(() => setSeen(settledView(owner)));
  }, [owner]);

  // Failed with nothing kept: the readers offer a Retry. A failed read after a good one keeps the
  // good one's figures (the flag as of the last read, as for every page between reads).
  const error = seen.ready && seen.failed && seen.value === null;
  return useBudgetsView({ spendCents: seen.value, error, refresh, ready: seen.ready });
}

// What a page reads from a spend ({ clientId → cents } | null until loaded): the same for the kept
// copy and a page's own read, so the two cannot say different things.
function useBudgetsView({ spendCents, error, refresh, ready }) {
  const state = useStore();
  const clients = state.clients || [];
  const ops = state.opsSettings || {};
  const month = useMemo(() => currentSupplyMonth(), []);

  const loaded = spendCents !== null;
  // clientId → { budget, spend, over, remaining, pct, loaded } for every customer. A building
  // with no budget still has a spend (the card shows it before anyone sets one).
  const statusFor = useCallback((clientId) => {
    const client = clients.find((c) => c.id === clientId) || null;
    const budget = supplyBudgetFor(client);
    if (!loaded) return { budget, spend: null, over: false, remaining: null, pct: null, loaded: false };
    const spend = round2((Number(spendCents[clientId]) || 0) / 100);
    return {
      budget,
      spend,
      over: isOverSupplyBudget(spend, budget),
      remaining: budget == null ? null : round2(budget - spend),
      pct: budget == null ? null : Math.round((spend / budget) * 100),
      loaded: true,
    };
  }, [clients, loaded, spendCents]);

  return useMemo(() => ({
    month,
    ready,
    loaded,
    error,
    refresh,
    statusFor,
    isOver: (clientId) => statusFor(clientId).over,
    // The badge's words: "$236.80 of $200" — the two figures, never a bare "over budget", so
    // whoever sees it knows by how much without opening anything.
    labelFor: (clientId) => {
      const st = statusFor(clientId);
      if (!st.loaded || st.budget == null) return null;
      return `Supplies ${fmtMoney(st.spend)} of ${fmtMoney(st.budget)}`;
    },
    orderDayFor: (client) => supplyOrderDayFor(client, ops),
    overCount: loaded ? clients.filter((c) => statusFor(c.id).over).length : 0,
  }), [month, ready, loaded, error, refresh, statusFor, clients, ops]);
}

// Whole dollars where the figure is a budget glance (a badge has no room for cents and the
// budget itself is an estimate), cents where they matter — the card and the queue use money().
function fmtMoney(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? `$${v.toLocaleString()}` : `$${v.toFixed(2)}`;
}
