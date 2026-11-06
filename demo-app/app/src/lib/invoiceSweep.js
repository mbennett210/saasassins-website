// Pure detection + application of the OVERDUE-INVOICE sweep (CS-288).
//
// ── WHAT IS DERIVED AND WHAT MUST BE WRITTEN ─────────────────────────────────
// An invoice's overdue STATUS is already derived on every read (money.js
// deriveInvoiceStatus: balance > 0 and past its due date), so no reader needs a
// stored flag and none is added here. What cannot be derived is the EVENT: a bell
// row + push must be raised exactly once per invoice, which needs a durable marker
// (`invoice.overdueNotifiedAt`). So this module is the one pure place the two halves
// live — who is newly overdue, and what raising it does to the state — and both
// readers call it:
//
//   • the client reducer (MARK_INVOICES_OVERDUE), as the fast path while a tab is open;
//   • app/api/cron/ops-alerts.js, the tab-independent path.
//
// Before this split the sweep existed ONLY on mount of /invoices and the admin
// Dashboard. An owner who lives on the home dashboard (AccountDashboard, which never
// dispatched it) could therefore never be told an invoice went overdue — and an ADMIN,
// who by Q24 has no `invoices.view` at all, was the one writing the invoice stamps and
// invoice bells by opening the operational Dashboard. That mount is gone; the cron owns
// the write.
//
// Idempotent by construction: an invoice already stamped is never in the due set, so
// the client tick and the cron are safe to run together and across CAS retries.
// Extracted from the reducer, which is un-importable under node (the same precedent as
// lib/opsAlertApply.js and lib/deleteCascade.js).
import { deriveInvoiceStatus } from './money.js';
import { fanOutInvoiceNotification } from './notifications.js';

// Invoices that are overdue RIGHT NOW and have never been announced. `now` is
// injected (ms or Date) so the caller owns the clock and tests can pin it.
export function newlyOverdueInvoices(invoices, now = Date.now()) {
  const at = new Date(now);
  return (invoices || []).filter(
    (inv) => inv && !inv.overdueNotifiedAt && deriveInvoiceStatus(inv, at) === 'overdue',
  );
}

// Returns { invoices, notifications, marked } to merge onto `state`, or null when
// nothing is newly overdue — the no-op that keeps this safe to run on every mount and
// every cron tick without touching the shared blob.
//
// `actorUserId` is passed through to the fan-out so a person is never told about the
// thing they just did (CS-226). The cron has no actor and passes none.
export function markInvoicesOverdue(state, { now = Date.now(), actorUserId = null } = {}) {
  const due = newlyOverdueInvoices(state?.invoices, now);
  if (due.length === 0) return null;
  const stamp = new Date(now).toISOString();
  const ids = new Set(due.map((inv) => inv.id));
  const invoices = (state.invoices || []).map(
    (inv) => (ids.has(inv.id) ? { ...inv, overdueNotifiedAt: stamp } : inv),
  );
  let notifications = state.notifications || [];
  for (const inv of due) {
    notifications = fanOutInvoiceNotification(
      { ...state, invoices, notifications },
      { invoice: inv, eventKey: 'invoiceOverdue', actorUserId },
    );
  }
  return { invoices, notifications, marked: due.length };
}
