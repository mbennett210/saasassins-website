// The CONTRACT-REMINDER WALKER (CON-6..CON-10, CS-194). Matt: "We need a notification to
// blow out to someone on our team to let them know that this contract is due for renewal."
//
// It rides the existing every-5-minute operational-alert cron (api/cron/ops-alerts.js) as a
// fifth walker — NO new cron entry. Why that one and not the daily pair:
//   · a reminder is a BELL plus a push, and the bell is a row in the shared record, so the
//     raise needs an `org_state` CAS write and an immediate push flush. `cron/ops-alerts` is
//     the one scheduled run that already owns both; `time/watchdog` (daily) makes no org_state
//     write at all — PAY-15's digest on it is push-only, with no bell — and `cron/reap` is
//     pure database maintenance.
//   · the five-minute cadence costs nothing here because the reminders are MATERIALIZED:
//     `contract_reminders` is read through one PARTIAL index on "not rung, not done, due on or
//     before today", which returns no rows on almost every run. There is no walk over
//     hundreds of contracts — that is the whole reason the schedule is a table.
//
// OFFICE HOURS gate the RAISE, not the delivery (the WO-7 precedent). A renewal is sixty days
// away; nobody needs it at 03:00, and holding the row rather than the push means no bell
// accumulates overnight either. Outside hours the reminder simply stays due and rings in the
// morning — the stored row is the record whatever the bell does.
//
// PURE + node-safe (explicit .js on every import), so the serverless cron and the offline
// suite run the identical rule. It never reads a clock or a zone: `now` and `tz` come in.
import { dayKey, diffDaysKey, fmtDate } from './dates.js';
import { isWithinOfficeHours } from './officeHours.js';
import { resolveAccountSupervisor } from './notifications.js';
import {
  CONTRACT_REMINDER_MAX_PER_RUN, REMINDER_KIND, REMINDER_KIND_LABELS,
  reminderIsDue, reminderTitle, reminderBody, contractLeftTheBook,
} from './contracts.js';
import { archivedClientIds } from './customerStatus.js';

// ONE kind for every contract reminder, because the per-user toggle is one switch
// (lib/notifications 'contractReminder') and the dispatcher only ever sees the event key.
// Which DATE it is about is in the copy, where a person reads it.
export const CONTRACT_ALERT_KIND = 'contractReminder';

// The ops-alert marker id. Deterministic on the reminder row, so a CAS retry inside one run
// re-applies to a no-op. It is the SECOND dedup: the durable one is `notified_at` on the
// reminder row itself, stamped after the bell lands, which is what stops a re-ring once this
// marker is pruned at the shift horizon.
export const contractAlertId = (reminderId) => `oa_contract_${reminderId}`;

// Where the bell takes you. A single-building contract opens that customer's Contract tab,
// which is where the office actually works; a master agreement over several buildings has no
// single customer page, so it opens the contract on the Contracts list.
export function contractAlertUrl({ contractId, clientIds }) {
  const ids = Array.isArray(clientIds) ? clientIds.filter(Boolean) : [];
  return ids.length === 1 ? `/clients/${ids[0]}?tab=contract` : `/contracts?c=${contractId}`;
}

// Who hears about it (Matt, CON-9: "the account's manager and the owner(s)"). Every covered
// building's valid supervisor, plus every active owner, deduped — a city's ten-building
// master agreement reaches all ten account managers, not just the first one's.
// `resolveAccountSupervisor` is the SAME reader every other account alert uses, so a demoted
// or deactivated supervisor is skipped here exactly as it is there.
export function contractAlertRecipients(state, clientIds) {
  const ids = new Set();
  for (const clientId of Array.isArray(clientIds) ? clientIds : []) {
    const sup = resolveAccountSupervisor(state, clientId);
    if (sup) ids.add(sup.id);
  }
  for (const u of state.users || []) {
    if (u && u.role === 'owner' && u.status === 'active') ids.add(u.id);
  }
  return [...ids];
}

// The alert records due right now, in the shape applyOpsAlert consumes.
//
//   reminders  the rows `contracts/store.dueReminders` returned (already filtered in SQL;
//              re-judged here through the SAME pure rule so the index and the walker cannot
//              drift — reminderIsDue is the one definition)
//   subjects   contractId -> { id, name, clientIds } (the narrow read the cron makes only
//              when something is actually due)
//   state      the org_state snapshot (users + clients, for routing and names)
//
// Bounded by CONTRACT_REMINDER_MAX_PER_RUN: the office enters hundreds of contracts in an
// afternoon, and a hundred bells in one tick is a notification flood nobody reads. The rest
// ring on the following runs, minutes later, and nothing is lost — the reminder ROW is the
// record and the Contracts page shows it whether or not a bell went out.
//
// A contract whose EVERY building is archived has left the book (CS-663, lib/contracts
// contractLeftTheBook): its reminders ring nobody. They are skipped, never stamped — a restored
// customer's contract rings again — and silencedContractReminders (below) counts them, so the
// cron reads past them rather than letting them crowd its bounded read.
export function getDueContractAlerts({ reminders, subjects, state, firedIds, now, settings }) {
  const tz = (state && state.company && state.company.timezone) || null;
  const opsSettings = settings || (state && state.opsSettings) || {};
  if (!isWithinOfficeHours(now, opsSettings, tz)) return [];
  const today = dayKey(now, tz);
  const byId = subjects instanceof Map ? subjects : new Map((subjects || []).map((s) => [s.id, s]));
  const clientName = (id) => ((state && state.clients) || []).find((c) => c.id === id)?.name || null;
  const archived = archivedClientIds(state && state.clients);

  const out = [];
  for (const r of reminders || []) {
    if (out.length >= CONTRACT_REMINDER_MAX_PER_RUN) break;
    if (!reminderIsDue(r, today)) continue;
    const id = contractAlertId(r.id);
    if (firedIds && firedIds.has(id)) continue;
    const subject = byId.get(r.contractId);
    if (!subject) continue;              // the contract went away under us — nothing to say
    if (contractLeftTheBook(subject, archived)) continue;   // every building archived (CS-663)
    const clientIds = subject.clientIds || [];
    const label = subject.name || clientName(clientIds[0]) || 'A customer';
    const userIds = contractAlertRecipients(state || {}, clientIds);
    out.push({
      id,
      kind: CONTRACT_ALERT_KIND,
      // With recipients resolved the routing is exact; with none resolvable (no supervisor
      // anywhere and no active owner) it blankets the office bench rather than going silent —
      // a renewal nobody is told about is the whole defect this exists to prevent.
      recipientScope: userIds.length ? 'users' : 'office',
      userIds,
      clientId: clientIds[0] || null,
      reminderId: r.id,
      reminderKind: r.kind,
      contractId: r.contractId,
      // CON-10's Renewals card is built from the alert, not from a second read: the walker
      // already holds the buildings and the names, and resolving them twice is how two
      // surfaces come to disagree about what a contract is called.
      reminderTargetDate: r.targetDate,
      clientIds,
      cardTitle: renewalCardTitle(subject.name, clientName(clientIds[0])),
      title: reminderTitle(r.kind, label),
      body: reminderBody(r.kind, {
        dateText: fmtDate(r.targetDate, { month: 'long', day: 'numeric', year: 'numeric' }, tz),
        daysAhead: diffDaysKey(today, r.targetDate),
      }),
      url: contractAlertUrl({ contractId: r.contractId, clientIds }),
    });
  }
  return out;
}

// The due reminders of contracts that have LEFT THE BOOK (every building archived, CS-663). They
// ring nobody and stay due, so they would hold places at the front of the cron's bounded due read
// (soonest first) run after run; the cron counts them and reads that much further, so a live
// reminder behind them still rings (api/cron/ops-alerts contractAlertsFor). Nothing is written.
export function silencedContractReminders({ reminders, subjects, state, now }) {
  const tz = (state && state.company && state.company.timezone) || null;
  const today = dayKey(now, tz);
  const byId = subjects instanceof Map ? subjects : new Map((subjects || []).map((s) => [s.id, s]));
  const archived = archivedClientIds(state && state.clients);
  if (!archived.size) return [];
  return (reminders || []).filter((r) => r && reminderIsDue(r, today) && byId.has(r.contractId)
    && contractLeftTheBook(byId.get(r.contractId), archived)).map((r) => r.id);
}

// ── CON-10: a renewal ALSO lands on the Renewals board ──────────────────────
//
// Matt (CON-10): a reminder can be marked done, snoozed or noted, "and renewals also land on
// the Renewals board". So when a RENEWAL or an END-DATE reminder rings, the same cron run
// that writes the bell also puts one opportunity card on the board — inside the SAME
// `org_state` CAS write, so a CAS miss retries both together and the two can never disagree
// about whether a renewal happened.
//
// A PRICE CHANGE and a CANCELLATION-NOTICE deadline deliberately place nothing: neither is a
// deal to work, and a board that filled up with them would be the thing nobody reads.
export const RENEWAL_CARD_KINDS = Object.freeze([REMINDER_KIND.renewal, REMINDER_KIND.end]);

// 🔴 FOUND BY STAGE KEY, NEVER BY THE SEED'S PIPELINE ID. The seeded "Renewals & Upsells"
// board is one row in a browser-writable slice: it can be renamed, re-created or replaced,
// and a clone of this shell starts with its own ids. The stage key is the contract.
export const RENEWAL_STAGE_KEY = 'renewal-due';

// The first board that declares the renewal stage, or null when no board does — in which case
// the run places nothing and COUNTS it, rather than inventing a column on another board.
export function findRenewalPlacement(pipelines) {
  for (const p of Array.isArray(pipelines) ? pipelines : []) {
    const stage = ((p && p.stages) || []).find((s) => s && s.key === RENEWAL_STAGE_KEY);
    if (stage) return { pipelineId: p.id, stage: stage.key };
  }
  return null;
}

// 🔴 THE CARD'S ID IS THE DEDUP, and it is caller-minted from the contract and the date the
// reminder is about. So: a re-run of the cron, a CAS retry, and a renewal AND an end-date
// reminder landing in the same cycle all resolve to one card; the NEXT cycle's date mints a
// new one. Nothing in it is random, so nothing has to be looked up to know it is already there.
export const renewalOpportunityId = (contractId, targetDate) => `opp_ct_${contractId}_${targetDate}`;

// What the card is called: the customer, or a master agreement's own name and the first
// building it covers (Matt's CON-10 wording). The board card HEADLINES the company from
// `clientId`; this is the deal's own label beside it.
export function renewalCardTitle(contractName, firstClientName) {
  const building = firstClientName || 'a building';
  return contractName ? `${contractName} — ${building}` : building;
}

// The note the office reads on the card. A bare DAY KEY, never a formatted date: this string
// is stored and cannot be re-zoned later (the activity-log rule), and a key is unambiguous.
export function renewalCardNote(alert) {
  const when = alert && alert.reminderTargetDate;
  const what = alert && alert.reminderKind === REMINDER_KIND.end
    ? `The contract ends on ${when}.`
    : `The contract renews on ${when}.`;
  return `${what} Open it at /contracts?c=${alert && alert.contractId}`;
}

// Place the cards for the alerts this attempt actually RAISED. Returns the next
// `opportunities` slice (or null when nothing changed), plus what it did, so the run can
// report it. PURE — the caller merges it into the state it is about to write.
//
// `placed`  cards added this attempt.
// `skipped` renewals that found no board to go on. Counted rather than swallowed, because a
//           renamed or deleted Renewals board is exactly the silent failure worth seeing.
//
// Additive and default-safe: a missing `opportunities` or `pipelines` slice reads as empty,
// so this needs no store-version bump (brain/recipes/version-bump-decision).
export function applyRenewalOpportunities(state, alerts, { now = Date.now() } = {}) {
  const wanted = (Array.isArray(alerts) ? alerts : [])
    .filter((a) => a && a.contractId && a.reminderTargetDate && RENEWAL_CARD_KINDS.includes(a.reminderKind));
  if (!wanted.length) return { opportunities: null, placed: 0, skipped: 0 };

  const placement = findRenewalPlacement(state && state.pipelines);
  if (!placement) return { opportunities: null, placed: 0, skipped: wanted.length };

  const existing = Array.isArray(state && state.opportunities) ? state.opportunities : [];
  // A card the office has already MOVED or CLOSED is matched here by id alone, whatever its
  // stage or status — it is left exactly as it is, which is the whole point of a stable id.
  const have = new Set(existing.map((o) => o && o.id));
  const stamp = new Date(now).toISOString();
  const added = [];
  for (const a of wanted) {
    const id = renewalOpportunityId(a.contractId, a.reminderTargetDate);
    if (have.has(id)) continue;
    have.add(id);                                   // two reminders, one cycle, one card
    const clientId = (a.clientIds || [])[0] || a.clientId || null;
    const client = ((state && state.clients) || []).find((c) => c && c.id === clientId) || null;
    const supervisor = resolveAccountSupervisor(state || {}, clientId);
    added.push({
      id,
      clientId,
      primaryContactId: (client && client.primaryContactId) || null,
      title: a.cardTitle || renewalCardTitle(null, client && client.name),
      // 🔴 EMPTY, DELIBERATELY (CS-019). A contract's value is REVENUE, served only to a
      // holder of `invoices.view` — and `org_state` is one record every pipeline viewer
      // downloads. Copying the money onto a board card would hand it to exactly the people
      // the contract routes strip it from. The office types a deal value if it wants one.
      value: null,
      expectedCloseDate: a.reminderTargetDate,
      pipelineId: placement.pipelineId,
      stage: placement.stage,
      status: 'open',
      ownerUserId: supervisor ? supervisor.id : null,
      notes: renewalCardNote(a),
      stageChangedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  if (!added.length) return { opportunities: null, placed: 0, skipped: 0 };
  return { opportunities: [...existing, ...added], placed: added.length, skipped: 0 };
}

// The activity-log line for a reminder the cron rang (LOG-7's automatic actions). One
// sentence, no timestamp — a write point has no org zone and a stored string cannot be
// re-zoned later, so the DATE is already formatted into `body` by the caller above.
export const contractAlertLogSummary = (alert) =>
  `${REMINDER_KIND_LABELS[alert && alert.reminderKind] || 'Contract reminder'} — ${(alert && alert.title) || ''}`.trim();
