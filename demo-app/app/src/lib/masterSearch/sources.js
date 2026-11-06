// masterSearch/sources.js — record adapters for global search. Each adapter turns one
// entity slice into rank-ready candidates via the pure engine in ./collect.js. This module
// imports the store selectors, so it is browser-only; its wiring is proven by the lockstep
// in scripts/test-master-search-sources.mjs and scripts/test-key-scope.mjs.
//
// 🔴 THE CREW-SCOPING RULE: an adapter's `select` IS the target page's own scoped selector,
// never a re-derived filter. So a record shows in search exactly when it shows on its page
// for that user — a crew member can never surface a customer, clean or key they are not
// assigned to. If you add an adapter, wire `select` to the page's scoped selector (or add
// one to store/selectors.js), never `state.<slice>` for a crew-reachable type.
// Crew have no search at all today (MasterSearch renders none for them, owner 2026-09-22);
// the scoping stays anyway, so the data layer never depends on that UI gate (a UI-only
// scope is a leak waiting for the gate to move).
//
// Records gate on minQueryLen (2 chars) so a single letter does not dump the whole book.
// rankBucket = 2 + typeIndex encodes the fixed type order (customers first) for tie-breaks;
// `order` sorts same-labelled rows by relevance (a customer's cleans: nearest to today).
// Labels shown to the user always use the app's own vocabulary (status/stage/role labels,
// org-timezone dates), never raw enum values.
//
// DELIBERATELY NOT SEARCHED (owner's v1 depth cut + judgment calls):
//   • conversations / message text, quotes, and QC inspections/checklists/work-orders/
//     templates — the owner scoped v1 to core store records. Each would be an async adapter
//     (qcApi.listChecklists / quotesApi.listQuotes) fetched on palette open; v1 ships none,
//     so there is zero async/caching machinery. Add one when the owner asks.
//   • snippets (no standalone management surface to land on), pipelines-as-records (the
//     /pipeline page covers the 3 board names), time entries (punches are not named things;
//     /time covers), account media (binary), payroll lines / reimbursements / HR docs
//     (period- or person-scoped rows inside their pages), notifications (the bell owns them),
//     supply requests (the Supplies requests tab covers them), and a building's supply-list
//     ITEMS since SUP-13 (2026-10-05): both live in their own tables behind /api/supplies now,
//     and a record source reads the store. The list is a tab of its customer's page (round 3,
//     2026-10-06), which the customer source already finds.
//   • dead store slices checklistTemplates / inspectionTemplates / accountMedia — declared in
//     INITIAL_STATE but never read by the app (real data is in qcApi / accountMediaApi).
import {
  selectVisibleClientsFor,
  selectVisibleContactsFor,
  selectVisibleSitesFor,
  selectVisibleKeysFor,
  selectJobsForUser,
  selectEffectiveJobStatus,
  selectUsers,
  selectJobs,
  selectInvoices,
  selectOpportunities,
  selectActivePipeline,
  selectServices,
  selectTags,
  selectReminderTemplates,
  selectClientById,
} from '../../store/selectors';
import { ROLE_LABELS } from '../roles';
import { deriveInvoiceStatus } from '../money';
import { customerLabel } from '../customerNumber';
import { collectCandidates, resolveFromSources } from './collect.js';
import { makeJobSource, cleanWords as clean, capFirst as cap } from './jobRecords.js';

const TAG_SCOPE_LABELS = { contact: 'People', client: 'Customers', all: 'All records' };
const stageOf = (s, o) => {
  const pl = (s.pipelines || []).find((p) => p.id === o.pipelineId);
  const stage = pl?.stages?.find((st) => st.key === o.stage);
  return { stageLabel: stage?.label || cap(o.stage), pipeline: pl };
};

// Adapters in fixed priority order (index 0 = highest tie-break priority).
export const RECORD_SOURCES = [
  {
    type: 'client', typeLabel: 'Customer', groupLabel: 'Customers', groupIcon: 'clients', perm: 'clients.view',
    select: (s, user) => selectVisibleClientsFor(s, user),
    // GO-2: a customer is named "0001 Ball Harbor Village" and found by its number.
    primary: (c) => customerLabel(c) || 'Customer',
    sublabel: (c) => clean([c.primaryContact, c.city]).join(' · '),
    keywords: (c) => clean([c.customerNumber, c.primaryContact, c.email, c.phone, c.street, c.city, c.state, c.zip,
      c.notes, c.type]),
    to: (c) => `/clients/${c.id}`,
    seeAll: (q) => `/clients?q=${encodeURIComponent(q)}`,
    seeAllFiltered: true,
    seeAllLabel: 'Customers',
  },
  {
    type: 'contact', typeLabel: 'Person', groupLabel: 'People', groupIcon: 'user', perm: 'contacts.view',
    select: (s, user) => selectVisibleContactsFor(s, user),
    primary: (c) => `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'Contact',
    sublabel: (c, s) => clean([c.title, (c.companyId && selectClientById(s, c.companyId)?.name) || c.customFields?.company]).join(' · '),
    keywords: (c, s) => clean([c.email, c.phone, c.title, c.lifecycle, c.customFields?.company,
      c.companyId && selectClientById(s, c.companyId)?.name]),
    to: (c) => (c.companyId ? `/clients/${c.companyId}?tab=contacts` : '/contacts'),
    seeAll: (q) => `/contacts?q=${encodeURIComponent(q)}`,
    seeAllFiltered: true,
    seeAllLabel: 'People',
  },
  {
    type: 'user', typeLabel: 'Team member', groupLabel: 'Team', groupIcon: 'clients', perm: 'settings.team.view',
    select: (s) => selectUsers(s),
    primary: (u) => u.name || u.email || 'Team member',
    sublabel: (u) => clean([ROLE_LABELS[u.role] || cap(u.role), u.status && u.status !== 'active' && cap(u.status)]).join(' · '),
    keywords: (u) => clean([u.email, u.phone, u.role, ROLE_LABELS[u.role], u.hr?.employeeId, u.initials]),
    to: (u) => `/settings/team/${u.id}`,
    seeAll: () => '/settings/team',
    seeAllLabel: 'Team',
  },
  {
    type: 'site', typeLabel: 'Location', groupLabel: 'Locations', groupIcon: 'mapPin', perm: 'clients.view',
    select: (s, user) => selectVisibleSitesFor(s, user),
    primary: (x) => x.name || 'Location',
    sublabel: (x, s) => clean([x.address, selectClientById(s, x.clientId)?.name]).join(' · '),
    keywords: (x, s) => clean([x.address, x.geocodedAddress, x.accessNotes, selectClientById(s, x.clientId)?.name]),
    to: (x) => `/clients/${x.clientId}?tab=access`, // the Location card lives on the Access tab
    seeAll: null,
    seeAllLabel: 'Locations',
  },
  // The cleans: built in ./jobRecords.js (CS-674 — indexed lookups, dates once per start,
  // only the visits that changed rebuilt, a bounded window of past visits). Crew see only the
  // visits they are on, through the Schedule's own scoped selector.
  makeJobSource({
    select: (s, user) => (user?.role === 'crew' ? selectJobsForUser(s, user.id) : selectJobs(s)),
    effectiveStatus: selectEffectiveJobStatus,
  }),
  {
    type: 'invoice', typeLabel: 'Invoice', groupLabel: 'Invoices', groupIcon: 'invoices', perm: 'invoices.view',
    select: (s) => selectInvoices(s),
    primary: (inv) => inv.id,
    sublabel: (inv, s) => clean([selectClientById(s, inv.clientId)?.name, cap(deriveInvoiceStatus(inv))]).join(' · '),
    keywords: (inv, s) => clean([
      String(inv.id).replace(/^\D+/, ''), // the bare number, so "1001" finds CS-1001
      deriveInvoiceStatus(inv),
      selectClientById(s, inv.clientId)?.name,
      inv.notes,
      ...(inv.lineItems || []).map((li) => li.description),
    ]),
    to: (inv) => `/invoices/${inv.id}`,
    seeAll: () => '/invoices',
    seeAllLabel: 'Invoices',
  },
  {
    // The pipeline board is desktop-bound (nav desktopOnly), so deals are desktop-only too.
    type: 'opportunity', typeLabel: 'Deal', groupLabel: 'Deals', groupIcon: 'dollarCircle', perm: 'pipeline.view', desktopOnly: true,
    select: (s) => selectOpportunities(s),
    primary: (o) => o.title || 'Deal',
    sublabel: (o, s) => {
      const { stageLabel, pipeline } = stageOf(s, o);
      const offBoard = pipeline && pipeline.id !== selectActivePipeline(s)?.id; // needs a board switch to see
      return clean([selectClientById(s, o.clientId)?.name, stageLabel, offBoard && `${pipeline.label} pipeline`]).join(' · ');
    },
    keywords: (o, s) => clean([stageOf(s, o).stageLabel, o.status, selectClientById(s, o.clientId)?.name]),
    to: () => '/pipeline', // the kanban board has no per-deal route
    seeAll: () => '/pipeline',
    seeAllLabel: 'Pipeline',
  },
  {
    type: 'key', typeLabel: 'Key', groupLabel: 'Keys', groupIcon: 'lock', perm: 'keys.view',
    select: (s, user) => selectVisibleKeysFor(s, user),
    primary: (k) => k.label || 'Key',
    sublabel: (k) => clean([k.clientName, cap(k.status)]).join(' · '),
    keywords: (k) => clean([k.clientName, k.siteName, k.heldByName, k.status, k.notes]),
    to: () => '/keys',
    seeAll: () => '/keys',
    seeAllLabel: 'Keys',
  },
  {
    type: 'service', typeLabel: 'Service', groupLabel: 'Services', groupIcon: 'invoices', perm: 'settings.services',
    select: (s) => selectServices(s),
    primary: (svc) => svc.name || 'Service',
    sublabel: (svc) => clean([svc.billingUnit && `Billed per ${svc.billingUnit}`]).join(' · '),
    keywords: (svc) => clean([svc.billingUnit]),
    to: (svc) => `/settings/services?q=${encodeURIComponent(svc.name || '')}`, // lands filtered to it
    seeAll: (q) => `/settings/services?q=${encodeURIComponent(q)}`,
    seeAllFiltered: true,
    seeAllLabel: 'Services',
  },
  {
    type: 'tag', typeLabel: 'Tag', groupLabel: 'Tags', groupIcon: 'tag', perm: 'tags.manage',
    select: (s) => selectTags(s),
    primary: (t) => t.label || 'Tag',
    sublabel: (t) => clean([t.scope && `${TAG_SCOPE_LABELS[t.scope] || cap(t.scope)} tag`]).join(' · '),
    keywords: (t) => clean([t.scope, t.color]),
    to: () => '/settings/tags',
    seeAll: () => '/settings/tags',
    seeAllLabel: 'Tags',
  },
  {
    type: 'reminderTemplate', typeLabel: 'Reminder', groupLabel: 'Reminder templates', groupIcon: 'reminders', perm: 'reminders.view',
    select: (s) => selectReminderTemplates(s),
    primary: (r) => r.subject || r.key || 'Reminder',
    sublabel: (r) => clean([r.channel && cap(r.channel)]).join(' · '),
    keywords: (r) => clean([r.key, r.channel, r.body]),
    to: () => '/settings/reminders',
    seeAll: () => '/settings/reminders',
    seeAllLabel: 'Reminders',
  },
];

// The candidate-building engine lives in ./collect.js (pure, node-testable). These two are
// the app-facing entry points, bound to the real RECORD_SOURCES.
export const buildRecordCandidates = (state, user, check, opts) =>
  collectCandidates(RECORD_SOURCES, state, user, check, opts);

export const resolveRecordCandidate = (state, user, check, type, refId, opts) =>
  resolveFromSources(RECORD_SOURCES, state, user, check, type, refId, opts);
