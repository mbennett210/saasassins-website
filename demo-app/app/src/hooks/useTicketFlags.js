// WO-14 — the "complaining too much" flag.
//
// Matt, 2026-09-29: "How should 'complaining too much' show up? — (a) A flag on the account when
// it passes a set number of tickets in 30 days", with 10 as the number. The window is fixed at
// 30 days; the count is `opsSettings.ticketFlagCount30d`.
//
// The counts come from ONE server read (`qcApi.ticketCounts` → `GET /api/qc/problems/counts`,
// a complete narrow read tallied by the shared pure rule), so the customers LIST and a
// customer's own page cannot disagree about whether an account is flagged.
//
// 🔴 CS-962 (Daniel, 2026-11-02: "Read the counts when the app opens"): the read is made as the
// app opens (`prefetchTicketCounts`, from the office shell) and kept for the app, in
// lib/ticketCountsCache.js, so a page draws with its flags in place and nothing moves after.
// Each page draws with the counts as they were when it opened, and asks for a read in the
// background (one a minute at most); what that read says shows the next time a page opens,
// never on the page already open. A page opened before the first read has answered waits
// (`ready` false: draw nothing that a flag would move), then takes it once, or draws without
// flags if it hasn't answered in WAIT_MS.
//
// A FAILED read answers "not flagged" for everyone rather than flagging nothing loudly or
// everything wrongly: the flag is an office convenience, and a red badge nobody can explain is
// worse than an absent one. `loaded` says which of the two it is, for a caller that cares.
import { useCallback, useEffect, useState } from 'react';
import { useStore, useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import { createTicketCounts } from '../lib/ticketCountsCache';
import { isTicketFlagged, ticketFlagThreshold, ticketFlagLabel, TICKET_FLAG_DAYS } from '../lib/workOrders';

// The app's one copy of the counts.
const ticketCounts = createTicketCounts({ read: () => qcApi.ticketCounts({ days: TICKET_FLAG_DAYS }) });

/** The office shell calls this as the app opens, so the counts are in before a page needs them. */
export function prefetchTicketCounts(userId) {
  ticketCounts.setOwner(userId ?? null);
  ticketCounts.refresh();
}

export function useTicketFlags() {
  const ops = useStore().opsSettings || {};
  const owner = useSelector(selectCurrentUser)?.id ?? null;
  const threshold = ticketFlagThreshold(ops);
  // What this page draws with, taken as it opens and kept while it is open.
  const [seen, setSeen] = useState(() => ticketCounts.snapshot(owner));

  useEffect(() => {
    ticketCounts.setOwner(owner);
    ticketCounts.refresh();
    if (seen.ready) return undefined;
    return ticketCounts.whenSettled(() => setSeen({ ready: true, counts: ticketCounts.snapshot(owner).counts }));
    // Once, as the page opens: a read answering later is for the next page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = seen.counts;
  const countFor = useCallback((clientId) => (counts && clientId ? (counts.get(clientId) || 0) : 0), [counts]);
  const isFlagged = useCallback((clientId) => isTicketFlagged(countFor(clientId), ops), [countFor, ops]);
  const labelFor = useCallback((clientId) => ticketFlagLabel(countFor(clientId)), [countFor]);

  return { ready: seen.ready, loaded: counts !== null, threshold, countFor, isFlagged, labelFor, days: TICKET_FLAG_DAYS };
}
