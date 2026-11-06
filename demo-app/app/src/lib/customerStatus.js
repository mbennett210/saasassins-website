// A customer's STATUS, read the same way everywhere (CS-683, the S128 full-app pass).
//
// The status menu and the Customers import write `client.statusOverride` (lead / active /
// inactive); the old `client.status` field was retired with the derived-status model
// (persist v21) and survives only on rows written before it. The reminder walkers kept reading
// the retired field, so a building marked Inactive through the menu still got inspection-due
// pushes and monthly supply-order reminders, and the manager Home still counted it as an
// inspection due. This module is the ONE answer to "is this a building we clean now?", read by
// every reminder walker (lib/opsAlerts), the cron's reads (api/cron/ops-alerts,
// api/qc latest-by-client), the supplies rule (lib/supplies isSupplyBuilding) and the manager
// Home's count (lib/managerHome).
//
// PURE, no imports, so the browser, the serverless functions and the offline suites run it
// as written.

// The values `statusOverride` may hold. Lead / Active / Inactive are the status menu's; a
// customer with none is DERIVED (store/selectors selectClientStatus: Active on real work, else
// Lead).
export const CUSTOMER_STATUS = Object.freeze({
  lead: 'lead',
  active: 'active',
  inactive: 'inactive',
  archived: 'archived',
});
export const CUSTOMER_STATUS_OVERRIDES = Object.freeze(Object.values(CUSTOMER_STATUS));

// Archived: Matt's "never delete customers" (kickoff 2026-09-10; CS-027 / CS-663). The record,
// its number and its history stay; it leaves every working surface until it is restored.
export const isArchivedCustomer = (client) => !!client && client.statusOverride === CUSTOMER_STATUS.archived;
// The archived customers' ids in a book, for the readers keyed by id (the contracts book and its
// reminders, the ticket walker).
export const archivedClientIds = (clients) => new Set((Array.isArray(clients) ? clients : []).filter(isArchivedCustomer).map((c) => c.id));

// 🔴 THE ONE RULE: a building we clean now. Not a vendor (a supplier is never cleaned), not
// marked Inactive or Archived, and not Inactive on the retired field either (rows written
// before the status menu). A Lead stays in: the inspection rule already leaves a building that
// was never inspected alone, and the supplies rule narrows further (isSupplyBuilding).
export function isActiveBuilding(client) {
  if (!client || !client.id) return false;
  if (client.type === 'vendor') return false;
  if (client.statusOverride === CUSTOMER_STATUS.inactive || client.statusOverride === CUSTOMER_STATUS.archived) return false;
  if (client.status === CUSTOMER_STATUS.inactive) return false;
  return true;
}

// ── THE ARCHIVE (CS-663 / CS-027) ────────────────────────────────────────────
// Matt, kickoff 2026-09-10: "Never delete customers — reactivating a former customer keeps the
// same ID." Archive REPLACES delete: the customer keeps its record, number, contacts, location,
// invoices, notes and history, and leaves every working surface — the pickers
// (store/selectors selectActiveClients), the active list (Customers shows it only under the
// Archived filter), the reminder walkers and the Home counts (isActiveBuilding above), the
// contracts book and its reminders, the ticket repeats, the waiting messages, and the customer
// hub (its logins lose access) — until it is restored. Status lives where it already lived,
// `statusOverride`, with three stamps beside it. Only ARCHIVE_CLIENT / RESTORE_CLIENT write
// them; the server holds that to `clients.delete` ("Archive customers"), and refuses a customer
// REMOVAL for everyone (api/_lib/orgStateGuard).
export const ARCHIVE_STAMPS = Object.freeze(['archivedAt', 'archivedBy', 'statusBeforeArchive']);
const RESTORABLE = new Set([CUSTOMER_STATUS.lead, CUSTOMER_STATUS.active, CUSTOMER_STATUS.inactive]);

export function archiveCustomerPatch(client, { at, by = null } = {}) {
  const before = client && RESTORABLE.has(client.statusOverride) ? client.statusOverride : null;
  return { statusOverride: CUSTOMER_STATUS.archived, archivedAt: at || null, archivedBy: by || null, statusBeforeArchive: before };
}
// Restore puts back the status it had (none = derived again) and clears the stamps. The cleans the
// archive took off the schedule are NOT put back: a returning customer's schedule is set up anew.
export function restoreCustomerPatch(client) {
  const back = client && RESTORABLE.has(client.statusBeforeArchive) ? client.statusBeforeArchive : null;
  return { statusOverride: back, archivedAt: null, archivedBy: null, statusBeforeArchive: null };
}
// The archive state of a row, as one comparable tuple (the server's guard and digest read it).
export const archiveTuple = (client) => [
  isArchivedCustomer(client), client?.archivedAt ?? null, client?.archivedBy ?? null, client?.statusBeforeArchive ?? null,
];
export const carriesArchiveState = (client) => !!client
  && (isArchivedCustomer(client) || ARCHIVE_STAMPS.some((k) => client[k] != null));
// An ordinary customer edit (UPDATE_CLIENT: the status menu, the import, a card) never moves a
// customer into or out of the archive, nor touches its stamps — ARCHIVE_CLIENT also ends the
// schedule, and RESTORE_CLIENT puts the status back. Returns the patch without that part.
export function withoutArchiveChange(prevClient, patch) {
  if (!patch || typeof patch !== 'object') return patch;
  let out = patch;
  for (const k of ARCHIVE_STAMPS) {
    if (Object.prototype.hasOwnProperty.call(out, k)) { const { [k]: _drop, ...rest } = out; out = rest; }
  }
  if (Object.prototype.hasOwnProperty.call(out, 'statusOverride')
    && (out.statusOverride === CUSTOMER_STATUS.archived) !== isArchivedCustomer(prevClient)) {
    const { statusOverride: _drop, ...rest } = out; out = rest;
  }
  return out;
}

// WHAT THE ARCHIVE TAKES OFF THE SCHEDULE: every one of the customer's cleans that has not started
// (status upcoming, starting after the archive), and its never-ending series stop at the archive
// (their master's recurrence capped, as "end this and all future" does), so no top-up mints
// another. Cleans done, running or missed stay — they are the history.
//   → { removeIds: string[], capMasterIds: string[] }
export function archiveSchedulePlan(jobs, clientId, atMs) {
  const mine = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.clientId === clientId);
  const removeIds = mine
    .filter((j) => j.status === 'upcoming' && Date.parse(j.startAt) > atMs)
    .map((j) => j.id);
  const removing = new Set(removeIds);
  const capMasterIds = mine
    .filter((j) => !removing.has(j.id) && j.recurrence && j.recurrence.endType === 'never')
    .map((j) => j.id);
  return { removeIds, capMasterIds };
}
