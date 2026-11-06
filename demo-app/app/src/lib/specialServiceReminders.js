// The SPECIAL-SERVICE REMINDER (task #507 from Clean Corner's queue; UI_RULES §192). Matt, "clean
// corner" (2026-11-03, 10:46 AM PT): "The system should automatically notify both the Account
// Manager and Operations Manager when the next special service is coming up. We don't need these
// services added to the regular cleaning schedule. We simply need reminders so our team knows when
// to coordinate the work." Daniel's pick (2026-11-04): "Build the reminders too", as offered: a bell
// and a phone alert to the building's Account Manager and that manager's Operations Manager,
// SPECIAL_SERVICE_LEAD_DAYS before the next date, during office hours, on the same alert run as the
// contract reminders, with no email and no text.
//
// It rides the every-5-minute operational-alert cron (api/cron/ops-alerts.js) as its eighth walker,
// NO new cron entry, and reads nothing but the shared record the run already holds: the services
// live on the customers (lib/specialServices). Cron-only, like the contract reminders.
//
// ONCE PER DATE. The alert's id carries the building, the service and the date it is about, and its
// marker (kind `specialServiceDue`, `refId` = building:service) is kept newest-per-service for as
// long as that service exists (lib/opsAlertApply), so a service is told about once for each next
// date: Mark done (or an edit of the date) moves it to a new date, which is told about again when
// it comes up. A date that has already passed when it's entered is told about once too, as overdue.
//
// WHO: the building's Account Manager (lib/notifications resolveAccountSupervisor: set, active, an
// eligible tier) and the Operations Manager that manager reports to (lib/teamScope opsManagerOf),
// deduped. A building with neither: the active Super Admins (Claude's default, so a reminder never
// goes to nobody). Each is still gated on their own switch (Account → Notifications) and on seeing
// customers (`clients.view`) at the fan-out.
//
// OFFICE HOURS gate the RAISE, not the delivery (the contract reminders' rule): outside them the
// reminder simply stays due and rings when the office opens.
//
// PURE + node-safe (explicit .js on every import); `now` comes in. The words are MESSAGES (msg), so
// each bell row is written in its reader's language (CS-193).
import { dayKey, diffDaysKey } from './dates.js';
import { isWithinOfficeHours } from './officeHours.js';
import { resolveAccountSupervisor, SPECIAL_SERVICE_EVENT } from './notifications.js';
import { opsManagerOf } from './teamScope.js';
import { isActiveBuilding } from './customerStatus.js';
import { msg } from '../i18n/core.js';
import { specialServicesOf, frequencyLabel, SPECIAL_SERVICE_LEAD_DAYS } from './specialServices.js';

// The event is declared ONCE, beside its catalog entry (lib/notifications), because the catalog is
// read at load time and this module imports that one.
export { SPECIAL_SERVICE_EVENT };
export const SPECIAL_SERVICE_ALERT_KIND = 'specialServiceDue';
// At most this many told a run, the soonest first; the rest ring on the next runs, minutes later.
// Bounds one run's bell rows when a whole book's services are entered in an afternoon.
export const SPECIAL_SERVICE_MAX_PER_RUN = 60;

// Deterministic, so a repeat tick (or a CAS retry) is a no-op.
export const specialServiceAlertId = (clientId, serviceId, nextDate) => `oa_specialSvc_${clientId}_${serviceId}_${nextDate}`;
// The subject the marker is kept for (one per service, newest).
export const specialServiceRefId = (clientId, serviceId) => `${clientId}:${serviceId}`;
// Where the bell takes its reader: the customer's page, whose Overview has the Special services card.
export const specialServiceUrl = (clientId) => `/clients/${encodeURIComponent(clientId)}`;

// The refIds of every service that still exists — what keeps a marker (lib/opsAlertApply).
export function liveSpecialServiceRefs(state) {
  const out = new Set();
  for (const c of (state && state.clients) || []) {
    for (const s of specialServicesOf(c)) out.add(specialServiceRefId(c.id, s.id));
  }
  return out;
}

// Who hears about one building's service.
export function specialServiceRecipients(state, clientId) {
  const users = (state && state.users) || [];
  const ids = [];
  const am = resolveAccountSupervisor(state || {}, clientId);
  if (am) {
    ids.push(am.id);
    const om = opsManagerOf(users, am.id); // null when the manager is an OM, or reports to none
    if (om && om.status === 'active' && !ids.includes(om.id)) ids.push(om.id);
  }
  if (!ids.length) {
    for (const u of users) if (u && u.role === 'owner' && u.status === 'active') ids.push(u.id);
  }
  return ids;
}

// One service's sentence (title + body), shared by the bell and the activity log.
export function specialServiceCopy({ client, service, today }) {
  const frequency = frequencyLabel(service.months);
  const params = { service: service.type, customer: (client && client.name) || '', date: service.nextDate, frequency: msg(frequency.key, frequency.params) };
  const title = params.customer ? msg('alerts.specialSvc.title', params) : msg('alerts.specialSvc.titleNoName', params);
  const body = diffDaysKey(today, service.nextDate) < 0
    ? msg('alerts.specialSvc.bodyOverdue', params)
    : msg('alerts.specialSvc.bodySoon', params);
  return { title, body };
}

// The services due to be told about right now → alert records in the shape applyOpsAlert consumes
// (the `users` scope, its recipients resolved here).
//   state     the org_state snapshot (customers, users, settings)
//   firedIds  the ids of every ops-alert marker already raised
export function getDueSpecialServiceAlerts({ state, firedIds = new Set(), now, settings = null } = {}) {
  const s = state || {};
  const tz = (s.company && s.company.timezone) || null;
  if (!isWithinOfficeHours(now, settings || s.opsSettings || {}, tz)) return [];
  const today = dayKey(now, tz);
  const due = [];
  for (const client of s.clients || []) {
    if (!isActiveBuilding(client)) continue;
    for (const service of specialServicesOf(client)) {
      if (diffDaysKey(today, service.nextDate) > SPECIAL_SERVICE_LEAD_DAYS) continue;
      const id = specialServiceAlertId(client.id, service.id, service.nextDate);
      if (firedIds.has(id)) continue;
      due.push({ client, service, id });
    }
  }
  due.sort((a, b) => a.service.nextDate.localeCompare(b.service.nextDate) || a.id.localeCompare(b.id));
  return due.slice(0, SPECIAL_SERVICE_MAX_PER_RUN).map(({ client, service, id }) => {
    const copy = specialServiceCopy({ client, service, today });
    return {
      id, kind: SPECIAL_SERVICE_ALERT_KIND, eventKey: SPECIAL_SERVICE_EVENT,
      clientId: client.id, refId: specialServiceRefId(client.id, service.id),
      recipientScope: 'users', userIds: specialServiceRecipients(s, client.id),
      title: copy.title, body: copy.body, url: specialServiceUrl(client.id),
    };
  });
}
