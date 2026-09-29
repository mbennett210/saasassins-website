// Selectors — read-only helpers over state. Kept pure; callers can memoize if hot.

import { effectivePermissions } from '../lib/roles';
import { REVIEW_KINDS } from '../lib/clientReview';
import { getVisibleNotificationGroups } from '../lib/notifications';
import { dayKey, todayKey, addDaysKey, startOfDayKey, startOfMonthKey, addMonthsKey } from '../lib/dates';
import { isUserOffOn, timeOffEntryFor } from './timeOffRules';
import { resolveJobCrewIds, isUserJobCrew } from '../lib/crewResolve';
import { DEFAULT_GEOFENCE_RADIUS_M } from '../lib/geo';
import { CLOCK_RULE_KEYS, GEOFENCE_OFF_REASON, isClockRuleOff } from '../lib/clockRules';
import { DEFAULT_SIGNATURE_IMAGE_WIDTH } from '../lib/signature';
import { isOrphanedOpportunity } from '../lib/pipelines';
import { isOpenStatus } from '../lib/workOrders';
import { isMissedClean } from '../lib/opsAlerts';
import { normKeyCompany, makeKeyScope } from '../lib/keyScope';
import {
  invoicePaid, invoiceBalance, deriveInvoiceStatus,
  clientLifetimeRevenue, clientBalance, agingBuckets, uninvoicedCompletedJobs,
  clientCredit, clientCreditSources,
} from '../lib/money';
import { resolveCurrentUser } from './identity';

// ── the shared empty fallback (§8 0.4 / E3) ─────────────────────────────────
//
// `s.foo || []` looks free but is a MIGRATION LANDMINE. When the slice is missing it
// allocates a fresh array per call, so a useSelector consumer with the default Object.is
// comparer re-renders on every dispatch — exactly what useStore() already did. The
// migration compiles, renders correctly, and buys nothing. (selectionCache.js makes that
// the worst case rather than a white screen, which is why the failure is SILENT.)
//
// A shared reference makes the fallback branch identity-stable, so the selector is
// reference-returning in BOTH branches and needs no comparer at all.
//
// FROZEN deliberately: pushing to a selector result is already a bug — it mutates store
// state in place, outside the reducer. The freeze turns that from a silent corruption
// into a TypeError at the call site. Every read/copy op (map/filter/slice/sort/spread)
// is unaffected on an empty array; only mutation throws.
//
// ⚠️ NOT for accumulator seeds. `(groups[k] = groups[k] || []).push(x)` builds a NEW
// array on purpose and must keep its own literal — swapping that one throws.
//
// Enforced by scripts/test-selector-benefit.mjs: an allocating selector reached by
// useSelector without a comparer fails the build. Apply this as each file migrates.
export const EMPTY_ARRAY = Object.freeze([]);

// Client review layer is a nested object of maps; a frozen shared empty keeps the
// selector reference-stable when the slice is absent (older blob), like EMPTY_ARRAY.
export const EMPTY_REVIEW = Object.freeze({ sections: {}, drafts: {}, picks: {}, decisions: {} });

export const selectCompany = (s) => s.company;

// Normalized review results, memoized per slice REFERENCE (WeakMap), so an incomplete
// slice reads safely AND stays identity-stable for a comparer-less useSelector.
const _reviewByRef = new WeakMap();

// The shared client-review slice (section approvals + draft reviews + layout picks +
// build-decision answers + notes). THE READ BOUNDARY that defaults every REVIEW_KIND
// bucket: the LIVE org_state blob is `{sections, drafts, picks}` with NO `decisions` key
// until the first answer is saved, so returning it as-is makes `review.decisions[id]`
// throw the moment /review opens (the demo seed hides this by carrying `decisions: {}`).
//   • absent slice        → the frozen EMPTY_REVIEW
//   • already complete     → the slice BY REFERENCE (stable, no allocation)
//   • missing a bucket     → a normalized copy (missing buckets → {}), memoized per ref
export const selectClientReview = (s) => {
  const cr = s.clientReview;
  if (!cr) return EMPTY_REVIEW;
  if (REVIEW_KINDS.every((k) => cr[k])) return cr;
  let norm = _reviewByRef.get(cr);
  if (!norm) {
    norm = { ...cr };
    for (const k of REVIEW_KINDS) if (!norm[k]) norm[k] = {};
    _reviewByRef.set(cr, norm);
  }
  return norm;
};
export const selectUsers = (s) => s.users;
export const selectActiveUsers = (s) => s.users.filter((u) => u.status === 'active');

// ── Payroll one-off lines (bonus / reimbursement / tip / deduction) ──────────
// Base selector is reference-returning (EMPTY_ARRAY when the slice is absent) so it
// is safe under useSelector without a comparer. The period/user filters ALLOCATE —
// call them inside a useMemo (keyed on the period/user), never bare in useSelector.
export const selectPayrollLines = (s) => s.payrollLines || EMPTY_ARRAY;
export const selectPayrollLinesForPeriod = (s, periodKey) => (s.payrollLines || EMPTY_ARRAY).filter((l) => l.periodKey === periodKey);
export const selectPayrollLinesForUserPeriod = (s, userId, periodKey) => (s.payrollLines || EMPTY_ARRAY).filter((l) => l.userId === userId && l.periodKey === periodKey);

// ── HR: reimbursement requests + per-employee documents ──────────────────────
// Base selectors are reference-returning; the per-user filters ALLOCATE — call
// them inside a useMemo (keyed on the userId), never bare in useSelector.
export const selectReimbursements = (s) => s.reimbursements || EMPTY_ARRAY;
export const selectReimbursementsForUser = (s, userId) => (s.reimbursements || EMPTY_ARRAY).filter((r) => r.userId === userId);
export const selectEmployeeDocuments = (s) => s.employeeDocuments || EMPTY_ARRAY;
export const selectEmployeeDocumentsForUser = (s, userId) => (s.employeeDocuments || EMPTY_ARRAY).filter((d) => d.userId === userId);
// Current-user resolution is CLAIMS-FIRST (mirrors the server; 2026-08-03). The
// pure logic lives in store/identity.js (unit-tested in isolation); this selector
// only feeds it the roster row + the per-session `__auth` claim (stamped by
// sync.js withSession, stripped from the shared blob) and supplies the single-
// slot memo that keeps the reference STABLE (usePermission relies on Object.is;
// there is exactly one current user per session, so one memo slot is safe). The
// common/demo paths return the roster row (or null) by reference; only the two
// divergent paths (claim-role override, claim-only synthesis) allocate.
let _cuMemo = null;
function _memoCurrentUser(deps, make) {
  if (_cuMemo && _cuMemo.deps.length === deps.length && _cuMemo.deps.every((d, i) => d === deps[i])) {
    return _cuMemo.value;
  }
  const value = make();
  _cuMemo = { deps, value };
  return value;
}
// The real authenticated identity (claims-first), ignoring any owner "view as".
export const selectAuthenticatedUser = (s) => resolveCurrentUser({
  row: s.users.find((u) => u.id === s.currentUserId) || null,
  auth: s.__auth || null,
  currentUserId: s.currentUserId,
  memo: _memoCurrentUser,
});

// The EFFECTIVE current user for UI + permissions. An owner may "view as" another
// team member — a VIEW-ONLY perspective switch that renders that user's role/screens
// while the SERVER keeps enforcing the real owner claim (app_metadata). Everyone else
// resolves to their authenticated identity. `viewAsUserId` is transient/per-session
// (stripped from the shared blob: tableSlices.toSharedBlob + offlineCache).
export const selectCurrentUser = (s) => {
  if (s.viewAsUserId && s.__auth?.claimRole === 'owner') {
    const target = s.users.find((u) => u.id === s.viewAsUserId) || null;
    if (target) return target;
  }
  return selectAuthenticatedUser(s);
};

// The RAW roster role (ignores the claim override) — for the RoleSyncBanner
// canary, which must still detect a blob-vs-claim split now that
// selectCurrentUser().role reflects the claim.
export const selectCurrentUserBlobRole = (s) => (s.users.find((u) => u.id === s.currentUserId)?.role) ?? null;
export const selectServices = (s) => s.services;
export const selectFrequencies = (s) => s.frequencies;
export const selectClients = (s) => s.clients;
// Every client stays in the pickable book. Status is derived Lead/Active via
// selectClientStatus, or a manual override (Lead/Active/Inactive) an operator sets;
// an Inactive label does NOT hide a company here. So
// this returns ALL clients: the pickable customer roster (invoice / payment /
// complaint pickers, the new-business count). A Lead must be pickable or you
// could never bill a brand-new customer. Kept as a named selector so those call
// sites still read intentionally.
export const selectActiveClients = (s) => s.clients;
export const selectSites = (s) => s.sites;
export const selectJobs = (s) => s.jobs;
export const selectInvoices = (s) => s.invoices;
export const selectConversations = (s) => s.conversations;
export const selectMessages = (s) => s.messages;
export const selectReminderTemplates = (s) => s.reminderTemplates;
export const selectReminderEvents = (s) => s.reminderEvents;
export const selectPermissions = (s) => s.permissions;

// v2 additions
export const selectContacts = (s) => s.contacts || [];
export const selectTags = (s) => s.tags || [];
export const selectContactActivities = (s) => s.contactActivities || [];
// EMPTY_ARRAY, not `[]`: this is read by usePermission, which nearly every gated
// component calls, so an allocating fallback here re-renders most of the app on every
// dispatch. See the EMPTY_ARRAY note above.
export const selectUserPermissionOverrides = (s) => s.userPermissionOverrides || EMPTY_ARRAY;

// v16 additions — email invitations
export const selectInvitations = (s) => s.invitations || [];
export const selectPendingInvitations = (s) =>
  (s.invitations || []).filter((inv) => inv.status === 'pending');
export const selectInvitationForUser = (s, userId) => {
  if (!userId) return null;
  return (s.invitations || [])
    .filter((inv) => inv.userId === userId && inv.status === 'pending')
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))[0] || null;
};

// v3 additions — messaging snippets
export const selectSnippets = (s) => s.snippets || [];
export const selectSnippetById = (s, id) => (s.snippets || []).find((x) => x.id === id) || null;
// Snippets that apply to a given channel. Snippets with channel='all' always match;
// snippets pinned to a specific channel only match that channel.
export const selectSnippetsForChannel = (s, channel) =>
  (s.snippets || []).filter((x) => x.channel === 'all' || x.channel === channel);

// ---------- Lookups ----------
export const selectClientById = (s, id) => s.clients.find((c) => c.id === id) || null;
export const selectSiteById   = (s, id) => s.sites.find((x) => x.id === id) || null;

// ---------- Account operations (Swept replacement — v49 ops) ----------
export function selectClientOps(s, clientId) {
  const c = selectClientById(s, clientId);
  return {
    security: c?.security || null,
    expectedCleanMins: typeof c?.expectedCleanMins === 'number' ? c.expectedCleanMins : null,
    opsNotes: typeof c?.opsNotes === 'string' ? c.opsNotes : '',
    opsUpdatedAt: c?.opsUpdatedAt || null,
  };
}
// Expected clean time is per-SITE: the site's own value, else the job's (or
// account's) service catalog default, else null. EXPORTED for the Variance report
// (cross-module contract). The service-duration fallback means a clean (every one
// has a site and a service) ALWAYS has an expected baseline, so variance is never
// "No baseline"; the site's own value still wins when set. Returns null (not 0) only
// when nothing is resolvable, so callers render 'No baseline'.
export function selectEffectiveExpectedCleanMins(s, { clientId, siteId, serviceId }) {
  const site = siteId ? selectSiteById(s, siteId) : null;
  if (site && typeof site.expectedCleanMins === 'number') return site.expectedCleanMins;
  const client = clientId ? selectClientById(s, clientId) : null;
  const svcId = serviceId || client?.serviceId;
  if (svcId) {
    const service = selectServiceById(s, svcId);
    if (service && typeof service.defaultDurationMins === 'number') return service.defaultDurationMins;
  }
  return null;
}
export const selectCleaningAreasForSite = (s, siteId) => {
  const site = selectSiteById(s, siteId);
  // EMPTY_ARRAY, not `[]`: this is read through useSelector on MyDay, the crew's home
  // screen, and a fresh array on the (common) no-areas-configured branch would defeat
  // the comparer and re-render the card on every dispatch. See the EMPTY_ARRAY note.
  return Array.isArray(site?.cleaningAreas) ? site.cleaningAreas : EMPTY_ARRAY;
};

// ---------- Keys (check-in / check-out) ----------
export const selectKeys = (s) => s.keys || [];
// Complaints folded into Work Orders (type:complaint) — a relational problem_reports row
// read async via qcApi, no longer a blob slice. Dashboard complaint KPIs are computed by
// selectComplaintKpisFromWorkOrders (below) over the fetched work-order list.

// ---------- Supplies (S58) ----------
// Base selectors are reference-returning (EMPTY_ARRAY when the slice is absent) so a
// useSelector default comparer stays correct; the sorted/filtered reads build a new
// array each call, so their callers pass a shallow comparer or read via useStore.
export const selectSupplyItems = (s) => s.supplyItems || EMPTY_ARRAY;
export const selectSupplyItemsForClient = (s, clientId) => (s.supplyItems || EMPTY_ARRAY)
  .filter((i) => i.clientId === clientId)
  .slice()
  .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
export const selectSupplyRequests = (s) => (s.supplyRequests || [])
  .slice()
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
export const selectOpenSupplyRequestCount = (s) => (s.supplyRequests || EMPTY_ARRAY).filter((r) => r.status === 'open').length;
export const selectReviews = (s) => s.reviews || {};
// Day-over-day variance, computed on the fly from timestamped records (no daily
// snapshot needed). Revenue/quotes-sent deltas are added once those carry dated
// events; clients + complaints are available today.
export function selectVarianceYesterday(s) {
  // createdAt is a full instant; bucket it by the ORG's calendar day so "today vs
  // yesterday" is the business's day, not the viewer's.
  const today = todayKey();
  const yest = addDaysKey(today, -1);
  const onDay = (arr, field, k) => (arr || []).filter((x) => {
    const v = x?.[field]; if (!v) return false;
    return dayKey(v) === k;
  }).length;
  // Complaints yesterday-delta now comes from Work Orders (type:complaint) via
  // selectComplaintKpisFromWorkOrders — the Dashboard merges it into this card.
  return {
    newClients: onDay(s.clients, 'createdAt', today) - onDay(s.clients, 'createdAt', yest),
  };
}
export const selectKeyById = (s, id) => (s.keys || []).find((k) => k.id === id) || null;
// Lightweight follow-up (assignee + done) for a failed/needs-follow-up inspection.
// null when no triage has been set — readers must default (blob may lack the slice).
export const selectInspectionFollowUp = (s, inspectionId) =>
  (s.inspectionFollowUps || []).find((r) => r.inspectionId === inspectionId) || null;
export const selectKeyEventsForKey = (s, keyId) =>
  (s.keyEvents || []).filter((e) => e.keyId === keyId).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
// Keys grouped by client name, alphabetical. Within each company, keys are
// ordered by site (so a multi-site account's keys cluster by building) then by
// label; keys with no site sort last (shown as "Unassigned" per row).
export const selectKeysByClient = (s) => {
  const groups = {};
  for (const k of (s.keys || [])) {
    const name = k.clientName || 'Unassigned';
    (groups[name] = groups[name] || []).push(k);
  }
  return Object.keys(groups)
    .sort((a, b) => a.localeCompare(b))
    .map((clientName) => ({
      clientName,
      keys: groups[clientName].slice().sort((a, b) => {
        const an = a.siteName || '', bn = b.siteName || '';
        if (!an !== !bn) return an ? -1 : 1;          // unassigned (no site) sorts last
        return an.localeCompare(bn) || (a.label || '').localeCompare(b.label || '');
      }),
    }));
};
// Keys filed under a company, ordered by label. Clean Space tracks keys per COMPANY
// (not per building), so match by CRM clientId when the key has one, else by the
// key's free-text company name — the imported prod keys carry a company name but
// no clientId/siteId. Powers the per-company key list on the account (ClientDetail)
// page. clientId is authoritative when present; the name fallback only applies to
// un-linked imported keys, so a key with a different clientId never matches on name.
export const selectKeysForClient = (s, client) => {
  if (!client) return [];
  const cname = normKeyCompany(client.name);
  return (s.keys || [])
    .filter((k) => (k.clientId ? k.clientId === client.id : (!!k.clientName && normKeyCompany(k.clientName) === cname)))
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
};
export const selectServiceById = (s, id) => s.services.find((x) => x.id === id) || null;
export const selectUserById    = (s, id) => s.users.find((x) => x.id === id) || null;

// ---------- Notification preferences ----------
// Per-user toggles + mobilePushEnabled live on user.notificationPrefs.
// All event toggles + mobilePushEnabled default true. mobilePushEnabled is an
// opt-out master switch; actual OS push still requires a per-device subscription.
export const selectNotificationPrefs = (s, userId) => {
  const u = s.users.find((x) => x.id === userId);
  return u?.notificationPrefs || null;
};

// Per-user email signature {enabled, text, imageDataUrl, imagePath, imageWidth}.
// Defaults gracefully (enabled on, empty) when the field is absent — existing org_state
// documents predate signatures, and an empty signature appends nothing anyway.
//
// 🔴 THIS LIST MUST STAY COMPLETE AGAINST DEFAULT_SIGNATURE_PREFS (data/seed.js), and
// the reason is worse than "a read returns undefined". C07 shipped `imagePath` through
// the reader, the upload route, the send path and the preview — and then this selector,
// the ONE hop between the store and every consumer, silently dropped it. That made the
// whole feature inert end to end (buildOutboundEmail saw no imagePath, so a user who had
// successfully uploaded got no image on any email), and because settings/Account.jsx
// reads this selector into a local draft and dispatches that draft back, an unrelated
// text edit wrote `imagePath: null` over a real reference — A READ BUG THAT CAUSED DATA
// LOSS, orphaning the Storage object.
//
// Rebuilding an object field-by-field is what makes that possible: a spread cannot drop
// a field added later, a hand-written list silently does. Pinned by
// scripts/test-signature-store-roundtrip.mjs, which asserts this selector against the
// seed defaults so a new prefs field cannot be added without appearing here.
export const selectSignaturePrefs = (s, userId) => {
  const sp = s.users.find((x) => x.id === userId)?.signaturePrefs;
  // Normalize each field so a partially-written prefs object (e.g. text set
  // before `enabled` was ever touched) still reports enabled on by default.
  // Explicit `false` is preserved (?? only fills null/undefined).
  return {
    enabled: sp?.enabled ?? true,
    text: sp?.text ?? '',
    imageDataUrl: sp?.imageDataUrl ?? null,
    // The C07 Storage object key. Without this line the STORAGE shape is unreachable.
    imagePath: sp?.imagePath ?? null,
    // Display width for the signature image (S/M/L scaling). The sanitizer in
    // lib/signature (signatureImageWidth) clamps + defaults, so a missing value
    // resolves to 240; passing it through keeps the raw draft round-trippable.
    imageWidth: sp?.imageWidth ?? DEFAULT_SIGNATURE_IMAGE_WIDTH,
  };
};

// Returns the toggle catalog filtered for a user's role + permission overrides.
// Used by Account → Notifications to render only the rows the user can act on.
export const selectVisibleNotificationGroups = (s, userId) => {
  const user = s.users.find((x) => x.id === userId);
  return getVisibleNotificationGroups(user, s.permissions, s.userPermissionOverrides);
};

// Persistent notifications inbox (surfaced through the bell). Sorted newest
// first. Pass an optional limit to cap; bell uses 50.
export const selectNotificationsForUser = (s, userId, limit) => {
  if (!userId) return [];
  const list = (s.notifications || [])
    .filter((n) => n.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return typeof limit === 'number' ? list.slice(0, limit) : list;
};

export const selectUnreadNotificationCount = (s, userId) => {
  if (!userId) return 0;
  return (s.notifications || []).reduce(
    (acc, n) => acc + (n.userId === userId && !n.readAt ? 1 : 0),
    0
  );
};
export const selectJobById     = (s, id) => s.jobs.find((x) => x.id === id) || null;
export const selectInvoiceById = (s, id) => s.invoices.find((x) => x.id === id) || null;
export const selectConversationById = (s, id) => s.conversations.find((x) => x.id === id) || null;
export const selectContactById = (s, id) => (s.contacts || []).find((c) => c.id === id) || null;
export const selectContactByEmail = (s, email) => {
  if (!email) return null;
  const lower = email.trim().toLowerCase();
  return (s.contacts || []).find((c) => (c.email || '').toLowerCase() === lower) || null;
};
export const selectUserByEmail = (s, email) => {
  if (!email) return null;
  const lower = email.trim().toLowerCase();
  return s.users.find((u) => (u.email || '').toLowerCase() === lower) || null;
};
export const selectPipelines = (s) => s.pipelines || [];
export const selectActivePipeline = (s) =>
  (s.pipelines || []).find((p) => p.id === s.activePipelineId) || (s.pipelines || [])[0] || null;
export const selectActivePipelineStages = (s) => {
  const pl = selectActivePipeline(s);
  // Master now carries REAL stages (it's the single sales board), so return them.
  return pl?.stages || [];
};
export const selectTagById = (s, id) => (s.tags || []).find((t) => t.id === id) || null;

// ---------- Relationship reads ----------
export const selectSitesForClient = (s, clientId) =>
  s.sites.filter((x) => x.clientId === clientId);

export const selectJobsForClient = (s, clientId) =>
  s.jobs.filter((j) => j.clientId === clientId).sort((a, b) => (a.startAt < b.startAt ? 1 : -1));

export const selectInvoicesForClient = (s, clientId) =>
  s.invoices.filter((inv) => inv.clientId === clientId).sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1));

export const selectMessagesForConversation = (s, convId) =>
  s.messages.filter((m) => m.conversationId === convId).sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));

export const selectConversationForClient = (s, clientId) =>
  s.conversations.find((c) => c.clientId === clientId) || null;

// Is a job "assigned to" a crew user? True iff they're named on job.crewIds. Single
// source of truth for "is this clean mine", shared with My Day visibility and the
// notification fan-out via lib/crewResolve.js.
export function isJobAssignedToUser(s, job, userId) {
  return isUserJobCrew(job, userId);
}

// A job's crew as ACTIVE user objects: the people named on job.crewIds. Powers the
// manager surfaces (Schedule rows, JobDetail crew card, notification fan-outs) so
// admin and crew see the SAME crew.
export function selectEffectiveCrewForJob(s, job) {
  if (!job) return [];
  const out = [];
  for (const id of resolveJobCrewIds(job)) {
    const user = (s.users || []).find((u) => u.id === id);
    if (user && user.status === 'active') out.push({ user });
  }
  return out;
}

// A crew member's jobs = the cleans they're named on (job.crewIds). Account/site
// BROWSE visibility is separate (selectVisibleClientIdsFor). Managers use the full
// Schedule; this is the crew My Day/Schedule scope.
export const selectJobsForUser = (s, userId) => {
  if (!userId) return [];
  return (s.jobs || []).filter((j) => isUserJobCrew(j, userId));
};

// ---------- Scheduling: effective status, labels, conflicts, grouped views (v49 ops) ----------
// Centralized 'missed' synthesis so the status facet, the badges, and the
// variance report all agree on ONE definition (an 'upcoming' job whose start has
// passed reads as 'missed').
export function selectEffectiveJobStatus(job, now = Date.now()) {
  if (!job) return 'upcoming';
  if (job.status === 'done' || job.status === 'in_progress'
    || job.status === 'cancelled' || job.status === 'missed') return job.status;
  return new Date(job.startAt).getTime() < now ? 'missed' : 'upcoming';
}

// Effective tags for a clean = the union of its own tags, its site's tags, and its
// customer's tags, so filtering by a customer tag surfaces the clean even when the
// clean carries no tag of its own. Null-safe on un-backfilled jobs/sites.
export function selectEffectiveTagIds(s, job) {
  const own = Array.isArray(job?.tagIds) ? job.tagIds : [];
  const site = job?.siteId ? selectSiteById(s, job.siteId) : null;
  const siteTags = Array.isArray(site?.tagIds) ? site.tagIds : [];
  const client = job?.clientId ? selectClientById(s, job.clientId) : null;
  const clientTags = Array.isArray(client?.tagIds) ? client.tagIds : [];
  return [...new Set([...own, ...siteTags, ...clientTags])];
}

// The crew id set for a job = the people named on job.crewIds. The double-booking
// unit: an overlap between two cleans that share a named cleaner is a conflict the
// scheduler must see. Bare id Set (no active-user filter) — conflict math only
// needs the ids.
export function effectiveCrewIdSet(s, job) {
  return resolveJobCrewIds(job);
}

// UNASSIGNED = no ACTIVE crew will do this clean: its resolved crew (crewResolve)
// is empty, or names only inactive/offboarded people. The office's "nobody's on
// this" signal — powers the Schedule Unassigned filter/count/red styling and the
// By-Cleaner "Unassigned" lane, and the save-time guard in the create/edit forms.
// Accepts a real job OR a draft shape ({ crewIds, crewExcludedIds, siteId, clientId }).
export function selectIsJobUnassigned(s, job) {
  const ids = effectiveCrewIdSet(s, job);
  if (!ids.size) return true;
  for (const u of (s.users || [])) {
    if (u.status === 'active' && ids.has(u.id)) return false;
  }
  return true;
}

// ACTIONABLE unassigned = unassigned AND still needs someone: done/cancelled
// cleans are resolved, nobody has to be scheduled for them. `missed` is kept IN
// on purpose — an unassigned clean whose time passed with nobody on it is the
// worst case (the Sept 1 signal), not one to hide. THE ONE status rule shared
// by the Schedule count chip, the Unassigned filter facet, the By-Cleaner lane
// and the red row label, so all four always agree on the same set of cleans.
export function selectIsJobUnassignedActionable(s, job) {
  const st = selectEffectiveJobStatus(job);
  if (st === 'done' || st === 'cancelled') return false;
  return selectIsJobUnassigned(s, job);
}

// O(n^2) overlap + shared-crew conflict set over a WINDOWED job list (a day/week,
// never the full list). Factored out of the two inlined loops in Schedule.jsx so
// every view shares one definition. Shared-crew is computed on EFFECTIVE crew
// (named + standing), so two overlapping cleans a standing cleaner covers both
// read as a conflict even when neither names them explicitly (CLEANSPACE_SWEPT §5.2).
export function selectConflictJobIds(s, jobs) {
  const ids = new Set();
  const crewSets = jobs.map((j) => effectiveCrewIdSet(s, j));
  for (let i = 0; i < jobs.length; i++) {
    for (let k = i + 1; k < jobs.length; k++) {
      const a = jobs[i], b = jobs[k];
      if (a.status === 'cancelled' || b.status === 'cancelled') continue;
      if (a.startAt < b.endAt && a.endAt > b.startAt) {
        const bSet = crewSets[k];
        let shared = false;
        for (const id of crewSets[i]) { if (bSet.has(id)) { shared = true; break; } }
        if (shared) { ids.add(a.id); ids.add(b.id); }
      }
    }
  }
  // Time-off flag (Sept 1): a clean whose effective crew includes someone booked
  // off that day gets the same warning dot as a double-booking — this is the
  // calendar-level "she's off but still assigned to 3 cleans tonight" signal
  // that had no way to exist before the timeOff model.
  const timeOff = s.timeOff || [];
  if (timeOff.length) {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (j.status === 'cancelled' || j.status === 'done' || ids.has(j.id)) continue;
      for (const uid of crewSets[i]) {
        if (isUserOffOn(timeOff, uid, j.startAt)) { ids.add(j.id); break; }
      }
    }
  }
  return ids;
}

// Crew see only the SPECIFIC sites they're scheduled at: a Tower-A-only cleaner
// never sees Tower B listed. Every clean names a specific site, so a crew member's
// sites are exactly the sites of the cleans they're named on. Managers see all
// sites. Feeds the schedule location facet, the checklist/problem-report site
// pickers, AND ClientDetail's site cards (filtered by clientId there). NOTE: account
// KEYS deliberately stay account-wide (per-company inventory — any crew who can open
// the account sees its full key set).
export function selectVisibleSitesFor(s, user) {
  const sites = selectSites(s);
  if (!user || user.role !== 'crew') return sites;
  const jobSiteIds = new Set();
  for (const j of s.jobs || []) {
    if ((j.crewIds || []).includes(user.id) && j.siteId) jobSiteIds.add(j.siteId);
  }
  return sites.filter((site) => jobSiteIds.has(site.id));
}

// Group a (filtered, windowed) job list by cleaner for the by-cleaner view. A
// multi-cleaner clean appears under EVERY assigned cleaner's lane. Only cleaners
// with >=1 clean in the window are shown.
export function selectScheduleRowsByCleaner(s, jobs, users) {
  // 🔴 "Assigned" is crewIds ∪ the account's/site's STANDING crew — isJobAssignedToUser
  // above is documented as the single source of truth for it, and this selector used a
  // raw `(j.crewIds || []).includes(u.id)` instead. A standing cleaner therefore did not
  // appear in Schedule → By Cleaner for cleans they are genuinely working, and their
  // totalMinutes was understated, so the view the scheduler uses to balance load was
  // silently missing a whole class of assignment.
  //
  // effectiveCrewIdSet is computed ONCE PER JOB rather than calling isJobAssignedToUser
  // for every (user, job) pair — that predicate walks sites/clients on each call, which
  // would be O(users × jobs × entities) on the page that renders the whole schedule.
  const crewByJob = new Map(jobs.map((j) => [j.id, effectiveCrewIdSet(s, j)]));
  const activeIds = new Set((users || []).map((u) => u.id));
  const mins = (j) => Math.max(0, Math.round((new Date(j.endAt).getTime() - new Date(j.startAt).getTime()) / 60000));
  const rows = users
    .map((u) => {
      const js = jobs
        .filter((j) => crewByJob.get(j.id)?.has(u.id))
        .sort((a, b) => a.startAt.localeCompare(b.startAt));
      return { user: u, jobs: js, totalMinutes: js.reduce((sum, j) => sum + mins(j), 0) };
    })
    .filter((row) => row.jobs.length > 0)
    .sort((a, b) => (a.user.name || '').localeCompare(b.user.name || ''));
  // "Unassigned" lane: cleans no ACTIVE cleaner is on (empty resolved crew, or
  // only inactive people). Previously these vanished from By-Cleaner entirely —
  // the office had no way to see a clean nobody was scheduled for. Pinned to the
  // TOP so it can't be missed; only shown when there is at least one.
  const orphan = jobs
    .filter((j) => {
      // Same status rule as selectIsJobUnassignedActionable: a done/cancelled
      // clean needs nobody, so it must not sit in the "nobody scheduled" lane.
      const st = selectEffectiveJobStatus(j);
      if (st === 'done' || st === 'cancelled') return false;
      const set = crewByJob.get(j.id);
      if (!set || set.size === 0) return true;
      for (const id of set) if (activeIds.has(id)) return false;
      return true;
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  if (orphan.length) {
    rows.unshift({ user: null, unassigned: true, jobs: orphan, totalMinutes: orphan.reduce((sum, j) => sum + mins(j), 0) });
  }
  return rows;
}

// Today's (non-cancelled) cleans for a crew member, sorted by start — the scope of
// the My Day hub. "Today" is the ORG's calendar day, so an off-site VA or a crew
// member who has travelled still sees the business's today, not their device's.
export function selectTodayCleansForUser(s, userId, now = Date.now()) {
  const tk = dayKey(now);
  return selectJobsForUser(s, userId)
    .filter((j) => j.status !== 'cancelled' && dayKey(j.startAt) === tk)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}

// Client-side mirror of the server's resolveJobContext (api/_lib/time/store.js):
// resolves a job's denormalized names, the point-in-time expected baseline
// (shift → site → client → null), and the geofence center/radius. Fed to the
// timeApi stub (so demo clock-in resolves exactly as prod) and used for display.
export function selectClockContextForJob(s, job, userId) {
  if (!job) return null;
  const site = job.siteId ? selectSiteById(s, job.siteId) : null;
  const clientId = job.clientId || site?.clientId || null;
  const client = clientId ? selectClientById(s, clientId) : null;
  const user = userId ? selectUserById(s, userId) : null;
  const shift = (job.shiftId && Array.isArray(site?.shifts)) ? site.shifts.find((sh) => sh.id === job.shiftId) : null;
  const expectedMins = (shift && typeof shift.expectedCleanMins === 'number')
    ? shift.expectedCleanMins
    : selectEffectiveExpectedCleanMins(s, { clientId, siteId: job.siteId, serviceId: job.serviceId });
  const radiusM = (shift && Number.isFinite(shift.geofenceRadiusM)) ? shift.geofenceRadiusM
    : Number.isFinite(site?.geofenceRadiusM) ? site.geofenceRadiusM
      : (s.opsSettings?.defaultGeofenceRadiusM ?? DEFAULT_GEOFENCE_RADIUS_M);
  return {
    jobId: job.id, seriesId: job.seriesId || null, shiftId: job.shiftId || null,
    clientId, siteId: job.siteId || null, userId,
    clientName: client?.name || null, siteName: site?.name || null, userName: user?.name || null,
    scheduledStart: job.startAt || null, scheduledEnd: job.endAt || null,
    expectedMins: Number.isFinite(expectedMins) ? expectedMins : null,
    siteLat: Number.isFinite(site?.lat) ? site.lat : null,
    siteLng: Number.isFinite(site?.lng) ? site.lng : null,
    radiusM,
    // Either switch disables the ring, exactly as the server resolves it: the SITE's own, or
    // the office turning it off for this cleaner (`user.clockRules.geofenceOff`, step 4b/R7).
    // A crew session is served its own `clockRules` in the projection (api/_lib/crewView.js),
    // so this reads the same fact the handler does; the verdict itself stays the server's.
    geofenceEnabled: site?.geofenceEnabled !== false && !isClockRuleOff(user, CLOCK_RULE_KEYS.geofence),
    geofenceDisabledReason: isClockRuleOff(user, CLOCK_RULE_KEYS.geofence)
      ? GEOFENCE_OFF_REASON
      : (site?.geofenceEnabled === false ? 'geofence_disabled' : null),
  };
}

// v9: recurring series
export const selectSeriesJobs = (s, seriesId) =>
  seriesId ? s.jobs.filter((j) => j.seriesId === seriesId).sort((a, b) => a.startAt.localeCompare(b.startAt)) : [];
export const selectSeriesMaster = (s, seriesId) =>
  seriesId ? s.jobs.find((j) => j.seriesId === seriesId && j.recurrence) : null;

// v9: conflict detection — crew members assigned to overlapping time slots.
// Returns [{ job, userId, userName }] for each overlap (excludes cancelled jobs). A
// crew member conflicts when they're named on the other job's crew, so the
// scheduler is warned about double-booking someone.
export function selectCrewConflicts(s, crewIds, startAt, endAt, excludeJobId = null) {
  if (!crewIds?.length || !startAt || !endAt) return [];
  const results = [];
  for (const job of s.jobs) {
    if (job.id === excludeJobId) continue;
    if (job.status === 'cancelled') continue;
    if (job.startAt >= endAt || job.endAt <= startAt) continue;
    for (const uid of crewIds) {
      if (isJobAssignedToUser(s, job, uid)) {
        const user = s.users.find((u) => u.id === uid);
        results.push({ job, userId: uid, userName: user?.name || uid });
      }
    }
  }
  // Time-off conflicts (Sept 1): a second conflict KIND, so every surface that
  // already renders overlap warnings (NewJobModal, Schedule drag, JobDetail)
  // lights up for "this person is booked off that day" with no extra wiring.
  // Shape: { timeOff: entry, userId, userName, job: null } — callers branch on
  // `c.timeOff` (an overlap conflict always carries a job; these never do).
  for (const uid of crewIds) {
    const off = timeOffEntryFor(s.timeOff || [], uid, startAt);
    if (off) {
      const user = s.users.find((u) => u.id === uid);
      results.push({ job: null, timeOff: off, userId: uid, userName: user?.name || uid });
    }
  }
  return results;
}

// ── Time off (Sept 1 — see store/timeOffRules.js for the model) ───────────────
export const selectTimeOff = (s) => s.timeOff || EMPTY_ARRAY;
export function selectTimeOffForUser(s, userId) {
  return (s.timeOff || []).filter((t) => t.userId === userId);
}

export const selectContactsForClient = (s, clientId) =>
  (s.contacts || []).filter((c) => c.companyId === clientId);

// Derived "function" of a person at their company (CRM-MODEL §2). Three assignable
// role designations, toggled in the Contacts tab, each resolved from the FK that
// actually drives behavior — NEVER stored on the contact, so a person's function
// can't drift from the relationships that use it. Title is who they are (their job);
// this is what they're FOR.
//   • Primary → client.primaryContactId  (the account's main person)
//   • Billing → client.billingContactId  (who invoices are addressed to — BillingCard)
//   • Site    → the account location's siteContactId  (who crew call on arrival; the
//               Location card, JobDetail and reminders all read this ONE field). One
//               location per customer, so the site role IS that location's contact —
//               there is no separate company-level site FK (removed 2026-09-13).
export function selectContactRoleFlags(s, contact) {
  if (!contact) return { primary: false, billing: false, site: false };
  const client = contact.companyId ? selectClientById(s, contact.companyId) : null;
  const location = client ? selectSitesForClient(s, client.id)[0] : null;
  return {
    primary: Boolean(client && client.primaryContactId === contact.id),
    billing: Boolean(client && client.billingContactId === contact.id),
    site: Boolean(location && location.siteContactId === contact.id),
  };
}

// A person's tags live on their company (account) — tagging is company-level in
// this B2B CRM, so all of a company's people share one tag set. A company-less
// contact (rare: manual quick-add, vendor) falls back to its own tagIds. This is
// the single source of truth for "a contact's tags" across the list + detail.
export const selectEffectiveTagIdsForContact = (s, contact) => {
  if (!contact) return [];
  if (contact.companyId) return selectClientById(s, contact.companyId)?.tagIds || [];
  return contact.tagIds || [];
};

export const selectInvoicesForContact = (s, contactId) =>
  (s.invoices || []).filter((inv) => inv.billingContactId === contactId);

export const selectConversationsForContact = (s, contactId) =>
  (s.conversations || []).filter((c) => c.contactId === contactId);

// ---------- Dashboard follow-ups ----------
// Stale leads — contacts in lead/prospect lifecycle with no recent update. `updatedAt` is
// our proxy for activity: gets bumped whenever the contact is edited, tagged, staged,
// or a note is appended.
export function selectStaleLeads(s, { daysStale = 7 } = {}) {
  const cutoff = Date.now() - daysStale * 24 * 60 * 60 * 1000;
  return (s.contacts || [])
    .filter((c) => (c.lifecycle === 'lead' || c.lifecycle === 'prospect') && !selectContactIsVendor(s, c))
    .filter((c) => {
      const ref = c.updatedAt || c.createdAt;
      return !ref || new Date(ref).getTime() < cutoff;
    })
    .sort((a, b) => {
      const aT = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bT = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return aT - bT; // oldest (most stale) first
    });
}

// Unanswered threads — external conversations with status=open where the most recent
// message is inbound and older than `hoursStale`.
export function selectUnansweredThreads(s, { hoursStale = 24 } = {}) {
  const cutoff = Date.now() - hoursStale * 60 * 60 * 1000;
  const msgsByConv = new Map();
  (s.messages || []).forEach((m) => {
    const arr = msgsByConv.get(m.conversationId);
    if (!arr) msgsByConv.set(m.conversationId, [m]);
    else arr.push(m);
  });
  return (s.conversations || [])
    .filter((c) => c.channel !== 'internal')
    .map((c) => {
      const msgs = msgsByConv.get(c.id) || [];
      const last = msgs.reduce(
        (acc, m) => (!acc || new Date(m.sentAt) > new Date(acc.sentAt) ? m : acc),
        null
      );
      return { conv: c, last };
    })
    .filter(({ last }) => last && last.direction === 'in' && new Date(last.sentAt).getTime() < cutoff)
    .sort((a, b) => new Date(a.last.sentAt) - new Date(b.last.sentAt))
    .map(({ conv, last }) => ({ ...conv, lastInboundAt: last.sentAt, lastPreview: last.text }));
}

export const selectActivitiesForContact = (s, contactId) =>
  (s.contactActivities || [])
    .filter((a) => a.contactId === contactId)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));

export const selectActivitiesForClient = (s, clientId) =>
  (s.clientActivities || [])
    .filter((a) => a.clientId === clientId)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));

// ---------- Integrations ----------
export const selectIntegrations = (s) => s.company?.integrations || {};
export const selectTwilioIntegration = (s) => s.company?.integrations?.twilio || null;
export const selectTwilioConnected = (s) =>
  Boolean(s.company?.integrations?.twilio?.connected);
export const selectTwilioPhone = (s) =>
  s.company?.integrations?.twilio?.phoneNumber || null;
export const selectA2P = (s) => s.company?.integrations?.twilio?.a2p || null;
// Sending real SMS requires both: the Twilio account is connected AND A2P 10DLC is approved.
// The UI uses this to gate the SMS composer + show clear blockers when ungated.
export const selectIsTwilioSendReady = (s) => {
  const tw = s.company?.integrations?.twilio;
  if (!tw?.connected) return false;
  if (!tw.phoneNumber) return false;
  if (tw.a2p?.status !== 'approved') return false;
  return true;
};
// Reasons an outbound send would be blocked, in display order. Empty array = ready.
export const selectTwilioBlockers = (s) => {
  const tw = s.company?.integrations?.twilio;
  const blockers = [];
  if (!tw?.connected) blockers.push({ key: 'not_connected', label: 'Twilio account not connected' });
  if (tw?.connected && !tw.phoneNumber) blockers.push({ key: 'no_number', label: 'No phone number provisioned' });
  if (tw?.connected && tw.a2p?.status !== 'approved') {
    const status = tw.a2p?.status || 'not_started';
    const map = {
      not_started: 'A2P 10DLC registration not started',
      pending: 'A2P 10DLC pending carrier approval',
      rejected: 'A2P 10DLC was rejected. Resubmit required',
      suspended: 'A2P 10DLC registration suspended',
    };
    blockers.push({ key: `a2p_${status}`, label: map[status] || 'A2P not approved' });
  }
  return blockers;
};

// ---------- Integrations / Email Provider (Resend) ----------
// System transactional sender — used for invitations, reminder emails, and
// future billing. Per-user conversational email (Messaging suite) lives in
// connectedInboxes (Phase 3) and has its own selectors.
export const selectEmailIntegration = (s) => s.company?.integrations?.email || null;
export const selectEmailConnected = (s) =>
  Boolean(s.company?.integrations?.email?.connected);
export const selectEmailVerifiedDomain = (s) =>
  s.company?.integrations?.email?.verifiedDomain || null;

// Default From for system transactional sends. Falls back to the company
// email so the existing AddUserModal flow keeps working in stub/dev mode
// before the provider is connected. Once connected, `email.defaultFrom`
// must be on the verified domain (backend enforces this).
export const selectEmailDefaultFrom = (s) =>
  s.company?.integrations?.email?.defaultFrom || s.company?.email || null;

export const selectEmailDefaultReplyTo = (s) =>
  s.company?.integrations?.email?.defaultReplyTo || null;

// Sending real transactional email requires both: the provider account is
// connected AND the verified domain has cleared DKIM/SPF/DMARC checks.
// In stub/dev mode we deliberately don't gate sends so the existing
// invitation + reminder flows keep working without a connected provider —
// the UI surfaces the "Dev mode" banner so it's clear what's happening.
export const selectIsEmailSendReady = (s) => {
  const em = s.company?.integrations?.email;
  if (!em?.connected) return false;
  if (!em.verifiedDomain) return false;
  if (em.domain?.status !== 'verified') return false;
  return true;
};

// Reasons a system email send would be blocked, in display order. Empty
// array = ready. Mirrors selectTwilioBlockers shape so the Settings UI can
// reuse the same blocker-list pattern.
export const selectEmailBlockers = (s) => {
  const em = s.company?.integrations?.email;
  const blockers = [];
  if (!em?.connected) {
    blockers.push({ key: 'not_connected', label: 'Email provider not connected' });
    return blockers;
  }
  if (!em.verifiedDomain) {
    blockers.push({ key: 'no_domain', label: 'No sending domain configured' });
  }
  if (em.domain?.status !== 'verified') {
    const status = em.domain?.status || 'not_started';
    const map = {
      not_started: 'Domain verification not started',
      pending: 'Domain verification pending. DNS records propagating',
      failed: 'Domain verification failed. Check DKIM/SPF/DMARC records',
    };
    blockers.push({ key: `domain_${status}`, label: map[status] || 'Domain not verified' });
  }
  if (!em.defaultFrom) {
    blockers.push({ key: 'no_default_from', label: 'No default From address set' });
  }
  return blockers;
};

// ---------- Connected Inboxes (per-user mailbox connections) ----------
// Each user can connect one or more mailboxes (Gmail OAuth / Microsoft 365
// OAuth / SMTP). Sending email from Messaging routes through the user's
// default inbox so messages come from the rep's own address — not the
// system "notifications@" sender. Tokens + SMTP passwords NEVER live in
// state (backend holds them encrypted at rest).
export const selectConnectedInboxes = (s) =>
  Array.isArray(s.connectedInboxes) ? s.connectedInboxes : [];

export const selectConnectedInboxById = (s, id) =>
  (s.connectedInboxes || []).find((i) => i.id === id) || null;

export const selectConnectedInboxesForUser = (s, userId) =>
  (s.connectedInboxes || []).filter((i) => i.userId === userId);

// Returns the user's chosen default if it's still active; otherwise the
// most-recently-connected active inbox; otherwise null. The Messaging
// compose pane reads this to populate the "Sending as" dropdown.
export const selectDefaultConnectedInbox = (s, userId) => {
  const all = (s.connectedInboxes || []).filter((i) => i.userId === userId);
  if (!all.length) return null;
  const explicit = all.find((i) => i.isDefault && i.status === 'active');
  if (explicit) return explicit;
  const actives = all
    .filter((i) => i.status === 'active')
    .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1));
  return actives[0] || null;
};

// Whether the given user has at least one active connected inbox. Sending
// email through Messaging is gated on this — without an active connection,
// the compose pane blocks Email-channel sends with an inline CTA to
// Settings → Connected Inboxes.
export const selectUserHasActiveInbox = (s, userId) =>
  (s.connectedInboxes || []).some((i) => i.userId === userId && i.status === 'active');

// Reasons the email channel is blocked for a given user, in display order.
// Empty array = ready to send. Used by the Messaging compose pane to render
// the "connect your inbox" CTA when sending email isn't possible.
export const selectMessagingEmailBlockersForUser = (s, userId) => {
  const inboxes = (s.connectedInboxes || []).filter((i) => i.userId === userId);
  const blockers = [];
  if (!inboxes.length) {
    blockers.push({ key: 'no_inbox', label: 'No connected inbox. Connect Gmail / Outlook / SMTP in Settings → Connected Inboxes' });
    return blockers;
  }
  const actives = inboxes.filter((i) => i.status === 'active');
  if (!actives.length) {
    const expired = inboxes.find((i) => i.status === 'expired');
    if (expired) {
      blockers.push({ key: 'token_expired', label: `Reconnect ${expired.email}. Authorization expired` });
    } else {
      blockers.push({ key: 'all_inboxes_error', label: 'All connected inboxes are in an error state. Reconnect or check provider' });
    }
  }
  return blockers;
};

// ---------- Google Workspaces (multi-Workspace OAuth registry, v47) ----------
// Super-admin registry of Google Workspace orgs, each wired to its own Internal
// OAuth app. Mailboxes (per-user connectedInboxes + marketing rotation inboxes)
// attribute to a workspace via `workspaceId`. The client_secret never lives in
// state — only display metadata + setup status.
export const selectOAuthWorkspaces = (s) =>
  Array.isArray(s.oauthWorkspaces) ? s.oauthWorkspaces : [];

export const selectOAuthWorkspaceById = (s, id) =>
  (s.oauthWorkspaces || []).find((w) => w.id === id) || null;

// Every connected inbox across ALL users — the super-admin org-wide view. The
// per-user Connected Inboxes page uses selectConnectedInboxesForUser instead.
export const selectAllConnectedInboxes = (s) =>
  Array.isArray(s.connectedInboxes) ? s.connectedInboxes : [];

// A read-time "Primary Workspace" bucket that catches any mailbox NOT attributed
// to a registered Workspace. This makes already-connected mailboxes surface in
// the admin view on a live deployment whose shared doc predates the registry
// (the Supabase doc isn't run through the v47 migration on hydrate — see
// store/sync.js), without mutating any data. `isVirtual` marks it as auto-
// surfaced rather than a real registry entry.
export const VIRTUAL_PRIMARY_WS_ID = '__primary_unassigned__';
const makeVirtualPrimary = () => ({
  id: VIRTUAL_PRIMARY_WS_ID,
  label: 'Primary Workspace',
  domains: [],
  clientId: null,
  clientSecretLast4: null,
  status: 'active',
  isPrimary: true,
  isVirtual: true,
});

// Resolve an inbox to a workspace id: its own when it points at a registered
// Workspace; otherwise the registered primary (if any); otherwise the virtual
// Primary bucket. So unattributed/legacy mailboxes always have a home.
function resolveInboxWorkspaceId(inbox, registered, registeredIds) {
  if (inbox.workspaceId && registeredIds.has(inbox.workspaceId)) return inbox.workspaceId;
  const primary = registered.find((w) => w.isPrimary);
  return primary ? primary.id : VIRTUAL_PRIMARY_WS_ID;
}

// Bucket every connected inbox under its resolved workspace, returning the list
// of workspaces (registered first, virtual Primary prepended only if it caught
// any unattributed mailboxes) alongside their inbox arrays.
function bucketInboxesByWorkspace(s) {
  const registered = selectOAuthWorkspaces(s);
  const registeredIds = new Set(registered.map((w) => w.id));
  const inboxes = selectAllConnectedInboxes(s);
  const byWs = new Map();
  inboxes.forEach((i) => {
    const wid = resolveInboxWorkspaceId(i, registered, registeredIds);
    if (!byWs.has(wid)) byWs.set(wid, []);
    byWs.get(wid).push(i);
  });
  const list = [...registered];
  if (byWs.has(VIRTUAL_PRIMARY_WS_ID)) list.unshift(makeVirtualPrimary());
  return { list, byWs };
}

// Workspaces enriched with how many mailboxes are attributed to each + a health
// roll-up. Drives the registry list counts. Includes the virtual Primary bucket
// when there are unattributed mailboxes (e.g. on a pre-registry live doc).
export const selectOAuthWorkspacesWithCounts = (s) => {
  const marketing = Array.isArray(s.marketingInboxes) ? s.marketingInboxes : [];
  const { list, byWs } = bucketInboxesByWorkspace(s);
  return list.map((w) => {
    const mailboxes = byWs.get(w.id) || [];
    return {
      ...w,
      mailboxCount: mailboxes.length,
      marketingCount: marketing.filter((m) => m.workspaceId === w.id).length,
      healthy: mailboxes.every((i) => i.status === 'active'),
    };
  });
};

// Org-wide inboxes grouped by workspace (each inbox decorated with its owner's
// name) — for the super-admin "View mailboxes" roll-up.
export const selectInboxesGroupedByWorkspace = (s) => {
  const usersById = new Map((s.users || []).map((u) => [u.id, u]));
  const { list, byWs } = bucketInboxesByWorkspace(s);
  return list.map((w) => ({
    workspace: w,
    inboxes: (byWs.get(w.id) || []).map((i) => ({ ...i, ownerName: usersById.get(i.userId)?.name || '—' })),
  }));
};

// Resolve which workspace a mailbox address belongs to by domain match. Lets
// the connect flow auto-select the right Workspace so the picker only surfaces
// when the address domain is unknown/ambiguous. Returns null when no match.
export const selectWorkspaceForEmail = (s, email) => {
  const domain = String(email || '').split('@')[1]?.toLowerCase();
  if (!domain) return null;
  return (
    selectOAuthWorkspaces(s).find((w) =>
      (w.domains || []).some((d) => String(d).toLowerCase() === domain)
    ) || null
  );
};

// Merge explicit contact activities with synthesized events from related records (invoices, jobs, messages).
// Used by the ContactDetail Activity timeline.
export function selectSynthesizedActivityForContact(s, contactId) {
  const contact = selectContactById(s, contactId);
  if (!contact) return [];
  const explicit = selectActivitiesForContact(s, contactId).map((a) => ({
    ...a,
    _source: 'activity',
  }));
  const invoices = (s.invoices || [])
    .filter((inv) => inv.billingContactId === contactId)
    .map((inv) => ({
      id: `syn-inv-${inv.id}`,
      kind: 'invoice',
      contactId,
      body: `Invoice ${inv.id} issued · ${inv.status}`,
      occurredAt: inv.issueDate,
      authorUserId: null,
      _source: 'invoice',
      _ref: inv.id,
    }));
  const jobs = contact.companyId
    ? (s.jobs || [])
        .filter((j) => j.clientId === contact.companyId)
        .map((j) => ({
          id: `syn-job-${j.id}`,
          kind: 'meeting',
          contactId,
          body: `Job scheduled · ${j.status}`,
          occurredAt: j.startAt,
          authorUserId: null,
          _source: 'job',
          _ref: j.id,
        }))
    : [];
  const convoIds = new Set((s.conversations || []).filter((cv) => cv.contactId === contactId).map((cv) => cv.id));
  const msgs = (s.messages || [])
    .filter((m) => convoIds.has(m.conversationId))
    .map((m) => ({
      id: `syn-msg-${m.id}`,
      kind: m.direction === 'in' ? 'email' : 'email',
      contactId,
      body: `${m.direction === 'in' ? 'Received' : 'Sent'}: ${m.text}`,
      occurredAt: m.sentAt,
      authorUserId: m.authorUserId,
      _source: 'message',
      _ref: m.id,
    }));
  return [...explicit, ...invoices, ...jobs, ...msgs].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
}

// Visibility model:
//   - owner / admin: see ALL clients and ALL contacts.
//   - crew:          see the clients they're scheduled at — any account they're on
//                    a clean for (job.clientId, falling back to the job's site's
//                    client). Contacts attached to those clients follow; standalone
//                    contacts (no companyId) are not surfaced to crew.
// Returns the set of client ids visible to a given user.
export function selectVisibleClientIdsFor(s, user) {
  if (!user) return new Set();
  if (user.role !== 'crew') return new Set((s.clients || []).map((c) => c.id));
  const ids = new Set();
  const siteClient = {};
  (s.sites || []).forEach((si) => { siteClient[si.id] = si.clientId; });
  // Jobs the crew is on — resolve the account by clientId, else via the job's site.
  (s.jobs || []).forEach((j) => {
    if (!(j.crewIds || []).includes(user.id)) return;
    const cid = j.clientId || (j.siteId ? siteClient[j.siteId] : null);
    if (cid) ids.add(cid);
  });
  return ids;
}

export function selectVisibleClientsFor(s, user) {
  if (!user) return [];
  if (user.role !== 'crew') return s.clients || [];
  const ids = selectVisibleClientIdsFor(s, user);
  return (s.clients || []).filter((c) => ids.has(c.id));
}

export function selectVisibleContactsFor(s, user) {
  if (!user) return [];
  if (user.role !== 'crew') return s.contacts || [];
  const ids = selectVisibleClientIdsFor(s, user);
  return (s.contacts || []).filter((c) => c.companyId && ids.has(c.companyId));
}

// Keys this user may see: every key for non-crew; for crew, keys at their assigned
// companies plus any key in their own hands. The rule lives in lib/keyScope so the Keys
// page and global search apply it identically. Non-crew get the slice BY REFERENCE.
export function selectVisibleKeysFor(s, user) {
  const keys = selectKeys(s);
  if (!user || user.role !== 'crew') return keys;
  return keys.filter(makeKeyScope(user, selectVisibleClientsFor(s, user)));
}

// ── Opportunities (company-owned deals; the pipeline board's cards) ─────────
export const selectOpportunities = (s) => s.opportunities || EMPTY_ARRAY;
export const selectOpportunitiesForClient = (s, clientId) =>
  (s.opportunities || []).filter((o) => o.clientId === clientId);
// Opportunities on the active pipeline (the board's cards), in array order. A
// vendor company never has one, so no extra vendor filter is needed here.
export function selectPipelineOpportunities(s) {
  const pl = selectActivePipeline(s);
  if (!pl) return [];
  return (s.opportunities || []).filter((o) => o.pipelineId === pl.id && o.stage);
}
// Total value of OPEN opportunities on the active pipeline (won/lost excluded).
export const selectOpenOpportunityValue = (s) =>
  selectPipelineOpportunities(s)
    .filter((o) => o.status === 'open')
    .reduce((sum, o) => sum + (Number(o.value) || 0), 0);

// Orphaned opportunities — deals that carry a stage (so they were placed on a board) but
// whose placement is invalid: a stale stage key, or a pipeline that no longer exists. They
// are visible on NO board yet still live in `state.opportunities`. The Pipeline page
// surfaces these so already-vanished deals can be sent back to New Lead triage.
export function selectOrphanedOpportunities(s) {
  const pipelines = s.pipelines || [];
  return (s.opportunities || []).filter((o) => isOrphanedOpportunity(pipelines, o));
}

// Effective permissions for a specific user (for the overrides UI).
export function selectEffectivePermissionsForUser(s, userId) {
  const user = selectUserById(s, userId);
  return effectivePermissions(user, s.permissions, s.userPermissionOverrides || []);
}

// ---------- Derived ----------
// Pure invoice / revenue math lives in `../lib/money` (dependency-free so it is
// unit-testable headlessly). Re-exported here so existing call sites that import
// from '../store/selectors' keep working.
export {
  invoiceTotal, invoicePaid, invoiceBalance, deriveInvoiceStatus,
  BILLING_UNITS, billingUnitShort, lineItemFromService,
} from '../lib/money';

// Thin state-scoped wrappers over the pure `../lib/money` derivations.
export const selectClientLifetimeRevenue = (s, clientId) => clientLifetimeRevenue(s.invoices, clientId);
export const selectClientBalance = (s, clientId) => clientBalance(s.invoices, clientId);

// Derived customer status (Jobber-style), the ONE status we display + filter on:
// Active (has any job or invoice) vs Lead (no work yet). Fully derived from real
// work, so it can never drift and nothing is stored. There is deliberately NO
// archive state: this build deletes customers it no longer wants, it does not
// archive them (the "no archiving, only deletion" directive; see persist.js v21).
const CLIENT_STATUS_OVERRIDES = new Set(['lead', 'active', 'inactive']);
export const selectClientStatus = (s, client) => {
  if (!client) return 'lead';
  // Manual override (Lead/Active/Inactive) wins when an operator has set one on the
  // company. Otherwise DERIVED: Active on the first real work OR a won deal
  // (CRM-MODEL §3: winning an opportunity is a conversion event), else a Lead.
  if (CLIENT_STATUS_OVERRIDES.has(client.statusOverride)) return client.statusOverride;
  const hasWork = selectJobsForClient(s, client.id).length > 0
    || selectInvoicesForClient(s, client.id).length > 0
    || (s.opportunities || []).some((o) => o.clientId === client.id && o.status === 'won');
  return hasWork ? 'active' : 'lead';
};

// ── Type (manual) vs Sales-eligibility (CRM-MODEL §3, §6) ────────────────────
// Type is the ONE hand-set flag on a company: Customer (default) or Vendor. A
// Vendor is a supplier you buy from. It lives in the Customers list but is
// excluded from every sales surface. selectClientIsVendor is the single place
// vendor-ness is read, so the rule can never drift.
export const selectClientIsVendor = (s, clientOrId) => {
  const client = typeof clientOrId === 'string' ? selectClientById(s, clientOrId) : clientOrId;
  return client?.type === 'vendor';
};
// A person sits under a Vendor company, so they drop out of sales views with it.
export const selectContactIsVendor = (s, contact) =>
  Boolean(contact?.companyId && selectClientIsVendor(s, contact.companyId));
// THE sales-exclusion seam: contacts (people) NOT under a vendor company. The
// Pipeline, Marketing, and Dashboard stale-leads all route through this (or the
// selectContactIsVendor predicate) so a vendor can never leak into a sales view.
export const selectSalesContacts = (s) =>
  (s.contacts || []).filter((c) => !selectContactIsVendor(s, c));
// The badge a company shows: Vendor Type wins (off the sales track, so no
// Lead/Active), else the derived Lead/Active status. ONE source so the hub list,
// the ClientDetail header, and the contact's Company section never disagree.
export const selectClientBadgeStatus = (s, client) =>
  client?.type === 'vendor' ? 'vendor' : selectClientStatus(s, client);
export const selectClientCredit = (s, clientId) => clientCredit(s.invoices, clientId);
export const selectClientCreditSources = (s, clientId) => clientCreditSources(s.invoices, clientId);
export const selectAgingBuckets = (s, now = new Date()) => agingBuckets(s.invoices, now);
export const selectUninvoicedCompletedJobs = (s) => uninvoicedCompletedJobs(s.jobs, s.invoices);

// Generate the next invoice id following `<prefix>-<n>`. Mirrors the
// reducer's internal allocator so callers can pre-compute an id (needed when
// the same dispatch chain creates an invoice and then references it — e.g.
// the Record Payment flow auto-creates a stub invoice and immediately appends a
// payment to it).
export function nextInvoiceId(state) {
  const prefix = state.company.invoicePrefix || 'INV';
  const numbers = (state.invoices || [])
    .map((inv) => {
      const m = String(inv.id).match(new RegExp(`^${prefix}-(\\d+)$`));
      return m ? Number(m[1]) : 0;
    })
    .filter(Boolean);
  const next = (numbers.length ? Math.max(...numbers) : 1000) + 1;
  return `${prefix}-${next}`;
}

// Dashboard summary stats
export function selectDashboardStats(s) {
  // startAt is an instant (bucket via dayKey); issueDate is a calendar day-key
  // (compare as a string — re-parsing it as a Date would UTC-shift it a day).
  const todayK = todayKey();
  const weekEndK = addDaysKey(todayK, 7);

  const jobsToday = s.jobs.filter((j) => dayKey(j.startAt) === todayK);
  const invoicesThisWeek = s.invoices.filter((inv) => {
    const d = String(inv.issueDate || '').slice(0, 10);
    return d >= todayK && d < weekEndK;
  });

  const collected = s.invoices.reduce((a, inv) => a + invoicePaid(inv), 0);
  const outstanding = s.invoices.reduce((a, inv) => {
    const st = deriveInvoiceStatus(inv);
    return st === 'pending' ? a + invoiceBalance(inv) : a;
  }, 0);
  const overdue = s.invoices.reduce((a, inv) => {
    const st = deriveInvoiceStatus(inv);
    return st === 'overdue' ? a + invoiceBalance(inv) : a;
  }, 0);
  const overdueCount = s.invoices.filter((inv) => deriveInvoiceStatus(inv) === 'overdue').length;
  const outstandingCount = s.invoices.filter((inv) => deriveInvoiceStatus(inv) === 'pending').length;

  const activeClients = s.clients.filter((c) => selectClientStatus(s, c) === 'active').length;

  const uid = s.currentUserId;
  const unreadMessages = s.messages.filter((m) =>
    m.direction === 'in' && !(m.readByUserIds || []).includes(uid)
  ).length;

  return {
    jobsToday: jobsToday.length,
    invoicesThisWeek: invoicesThisWeek.length,
    collected,
    outstanding,
    outstandingCount,
    overdue,
    overdueCount,
    activeClients,
    unreadMessages,
    totalInvoices: s.invoices.length,
    weekRevenue: collected, // simplified — expanded in Phase 4
  };
}

export const selectUnreadReminderCount = (s) =>
  (s.reminderEvents || []).filter((e) => !e.readAt).length;
export const selectFailedReminderCount = (s) =>
  (s.reminderEvents || []).filter((e) => e.status === 'failed').length;

// ─── Clean Space KPIs (per questionnaire Q17 + Q18) ─────────────────────────────
// All windowed selectors use a rolling N-day lookback from "now" so the
// dashboard auto-updates without bookkeeping. Complaint KPIs now come from Work Orders
// (type:complaint) via selectComplaintKpisFromWorkOrders, not a blob slice. Missed cleans
// are derived deterministically (lib/opsAlerts.isMissedClean): a scheduled clean whose
// window fully passed with NO clock-in at all (done/cancelled/in-progress excluded). Same
// rule as the shift-missed alert, so the KPI and the alert agree. It needs the covered
// job-id set (from time entries) passed in (see selectMissedCleansThisMonth).

// Org-tz start-of-day, n days ago — the rolling-window floor for the dashboard
// metrics below. Anchored in the org zone so the window edge doesn't move with the
// viewer. Compared against job.startAt / createdAt instants (all full ISO).
const daysAgoDate = (n) => startOfDayKey(addDaysKey(todayKey(), -n));

// Q17: "missed cleans" — count + estimated revenue impact over the last 30 days.
// A clean is missed when its window fully passed with no clock-in at all (deterministic,
// lib/opsAlerts.isMissedClean, NOT a manual status). `coveredJobIds` is a Set of job ids
// that have a real clock-in — the caller (Dashboard) fetches it complete from the server
// (timeApi.coveredJobIds, the same read the late/missed alerts use). Revenue impact uses
// service.defaultDurationMins as a rough proxy ($150/hr).
export function selectMissedCleansThisMonth(s, coveredJobIds, now = Date.now()) {
  const since = daysAgoDate(30).getTime();
  const services = s.services || [];
  const missed = (s.jobs || []).filter((j) => {
    const t = new Date(j.startAt).getTime();
    return Number.isFinite(t) && t >= since && isMissedClean(j, coveredJobIds, now);
  });
  const revenueImpact = missed.reduce((sum, j) => {
    const svc = services.find((sv) => sv.id === j.serviceId);
    const hours = (svc?.defaultDurationMins || 60) / 60;
    return sum + hours * 150;
  }, 0);
  return { count: missed.length, revenueImpact };
}

// Q17: "labor report" — sum of crew-hours for jobs that started in the last 7 days.
// labor-hours = (endAt - startAt) × crewIds.length, summed over completed/in-progress.
export function selectLaborHoursThisWeek(s) {
  const since = daysAgoDate(7);
  const totalMins = (s.jobs || [])
    .filter((j) => {
      const start = new Date(j.startAt);
      return start >= since && (j.status === 'done' || j.status === 'in_progress');
    })
    .reduce((sum, j) => {
      const dur = Math.max(0, (new Date(j.endAt) - new Date(j.startAt)) / 60000);
      const crewSize = Math.max(1, (j.crewIds || []).length);
      return sum + dur * crewSize;
    }, 0);
  return Math.round(totalMins / 60);
}

// Q18: "outstanding quotes" — count + total value of OPEN opportunities with a
// bid out and awaiting a decision (Proposal Sent or Negotiation on the board).
const OUTSTANDING_QUOTE_STAGES = new Set(['proposal', 'negotiation']);
export function selectOutstandingQuotes(s) {
  const inQuote = (s.opportunities || []).filter(
    (o) => o.status === 'open' && OUTSTANDING_QUOTE_STAGES.has(o.stage)
  );
  const value = inQuote.reduce((sum, o) => sum + (Number(o.value) || 0), 0);
  return { count: inQuote.length, value };
}

// Q18: revenue this month (paid amount logged within current calendar month).
export function selectRevenueThisMonth(s) {
  // payment.date is a calendar day-key ('YYYY-MM-DD'); compare as a string against
  // the org month start. Parsing it as a Date would read it as UTC midnight and drop
  // the first day of the month in a negative-offset zone.
  const monthStart = startOfMonthKey(todayKey());
  return (s.invoices || []).reduce((sum, inv) => {
    return sum + (inv.payments || []).reduce((paySum, p) => {
      return String(p.date || '').slice(0, 10) >= monthStart ? paySum + (Number(p.amount) || 0) : paySum;
    }, 0);
  }, 0);
}

// ─── WS-A: Dashboard prior-period trends + complaint ratio (Q17) ─────────────
// Computed comparisons that REPLACE the previously-hardcoded dashboard trend
// arrows. Each metric compares its current rolling window to the immediately
// preceding equal-length window (revenue uses calendar months). `direction` is
// expressed from the reader's perspective — 'up' = good (green), 'down' = bad
// (red) — so for defect/cost metrics (missed cleans, complaints) a DROP maps to
// 'up'. All read-only; NO new state. Empty stores yield zero-deltas ('up').

function jobsBetween(s, sinceMs, untilMs) {
  return (s.jobs || []).filter((j) => {
    const t = new Date(j.startAt).getTime();
    return Number.isFinite(t) && t >= sinceMs && t < untilMs;
  });
}
function laborHoursBetween(s, sinceMs, untilMs) {
  const mins = jobsBetween(s, sinceMs, untilMs)
    .filter((j) => j.status === 'done' || j.status === 'in_progress')
    .reduce((sum, j) => {
      const dur = Math.max(0, (new Date(j.endAt) - new Date(j.startAt)) / 60000);
      const crewSize = Math.max(1, (j.crewIds || []).length);
      return sum + dur * crewSize;
    }, 0);
  return Math.round(mins / 60);
}
function countCreatedBetween(list, sinceMs, untilMs, extra) {
  return (list || []).filter((x) => {
    const t = new Date(x?.createdAt).getTime();
    if (!(Number.isFinite(t) && t >= sinceMs && t < untilMs)) return false;
    return extra ? extra(x) : true;
  }).length;
}
function collectedInCalendarMonth(s, monthOffset) {
  // pay.date is a calendar day-key; window it with org month-start day-keys and
  // compare as strings (see selectRevenueThisMonth on why not to re-parse).
  const base = startOfMonthKey(todayKey());
  const start = addMonthsKey(base, monthOffset);
  const end = addMonthsKey(base, monthOffset + 1);
  return (s.invoices || []).reduce((sum, inv) =>
    sum + (inv.payments || []).reduce((p, pay) => {
      const d = String(pay.date || '').slice(0, 10);
      return (d >= start && d < end) ? p + (Number(pay.amount) || 0) : p;
    }, 0), 0);
}
function makeTrend(current, prior, goodWhen /* 'increase' | 'decrease' */) {
  const delta = current - prior;
  const improved = goodWhen === 'decrease' ? delta <= 0 : delta >= 0;
  return { current, prior, delta, direction: improved ? 'up' : 'down' };
}

// Prior-period trend objects for the dashboard's stat cards. Windows are rolling
// (missed/complaints = 30d vs prior 30d; labor = 7d vs prior 7d; companies =
// net-active created in 30d vs prior 30d; collected = calendar month over month).
// `jobsFullyLoaded` — pass the sync manager's hydration flag. It gates the ONE trend
// whose prior window reaches outside the boot window: missed cleans compares -30..now
// against -60..-30, and since E6 the app boots on ~-45/+100 days, so up to HALF the
// prior period is simply not in `s.jobs` yet. The comparison then reports fewer prior
// missed cleans than really occurred and the arrow points the wrong way — it shows an
// improvement that did not happen, on a defect metric someone acts on.
//
// UI_RULES §40 already governs this: a trend arrow "must reflect a computed
// prior-period comparison" and where the basis does not exist the card carries "no
// trend at all rather than a fabricated one". A half-loaded basis is not a basis.
//
// ⚠️ DEFAULTS TO OMITTING THE TREND. A caller that forgets the flag gets no arrow
// rather than a wrong one — the safe direction. Every other trend here reads blob
// slices (complaints, clients, invoices) or a 14-day window well inside the boot
// range, so none of them is affected.
export function selectDashboardTrends(s, { jobsFullyLoaded = false, coveredJobIds = null, entriesLoaded = false } = {}) {
  const now = Date.now();
  const d30 = daysAgoDate(30).getTime();
  const d60 = daysAgoDate(60).getTime();
  const d7 = daysAgoDate(7).getTime();
  const d14 = daysAgoDate(14).getTime();
  const isActive = (c) => selectClientStatus(s, c) === 'active';

  // Missed is deterministic and clock-in-aware (isMissedClean), so it needs BOTH the full
  // job set (the -60..-30 prior window reaches outside the boot range) AND the covered set
  // from fetched time entries. Missing either yields no arrow rather than a wrong one.
  const missedCur = jobsBetween(s, d30, now).filter((j) => isMissedClean(j, coveredJobIds, now)).length;
  const missedPrior = jobsBetween(s, d60, d30).filter((j) => isMissedClean(j, coveredJobIds, now)).length;

  const companiesNew30 = countCreatedBetween(s.clients, d30, now, isActive);
  const companiesNewPrior = countCreatedBetween(s.clients, d60, d30, isActive);

  return {
    // null when the basis is partial, so the card renders no arrow (UI_RULES §40).
    missedCleans: (jobsFullyLoaded && entriesLoaded) ? makeTrend(missedCur, missedPrior, 'decrease') : null,
    laborHours: makeTrend(laborHoursBetween(s, d7, now), laborHoursBetween(s, d14, d7), 'increase'),
    // complaints trend now sourced from Work Orders — see selectComplaintKpisFromWorkOrders.
    companies: makeTrend(companiesNew30, companiesNewPrior, 'increase'),
    collected: makeTrend(collectedInCalendarMonth(s, 0), collectedInCalendarMonth(s, -1), 'increase'),
  };
}

// Complaint KPIs for the Dashboard, sourced from Work Orders (type:complaint) — a
// relational problem_reports projection the Dashboard fetches via qcApi — instead of the
// retired blob `complaints` slice. `s` still supplies "cleans" (completed jobs, blob-sync)
// for the per-100 ratio. Time math reads the relational `created_at` (ISO), falling back to
// `createdAt`. Null-safe: an unloaded list yields zeros and a flat trend.
//   open           — non-resolved complaints (the "Open Complaints" tile value)
//   ratio          — complaints in the window per 100 completed cleans (same window)
//   trend          — 30d vs prior 30d, 'decrease' is good (green)
//   yesterdayDelta — org-day today-minus-yesterday, for the "Variance (vs yesterday)" card
export function selectComplaintKpisFromWorkOrders(s, workOrders, days = 30) {
  const list = (Array.isArray(workOrders) ? workOrders : []).filter((w) => w.type === 'complaint');
  const at = (w) => new Date(w.created_at || w.createdAt).getTime();
  const now = Date.now();
  const since = daysAgoDate(days).getTime();
  const priorStart = daysAgoDate(days * 2).getTime();
  const inWindow = (a, b) => list.filter((w) => { const t = at(w); return Number.isFinite(t) && t >= a && t < b; }).length;

  const open = list.filter((w) => isOpenStatus(w.status)).length;
  const cur = inWindow(since, now);
  const prior = inWindow(priorStart, since);
  const cleans = (s.jobs || []).filter(
    (j) => j.status === 'done' && new Date(j.startAt).getTime() >= since
  ).length;

  const today = todayKey();
  const yest = addDaysKey(today, -1);
  const onDay = (k) => list.filter((w) => { const v = w.created_at || w.createdAt; return v && dayKey(v) === k; }).length;

  return {
    open,
    complaints: cur,
    cleans,
    ratio: cleans > 0 ? (cur / cleans) * 100 : 0,
    trend: makeTrend(cur, prior, 'decrease'),
    yesterdayDelta: onDay(today) - onDay(yest),
  };
}

// Reminder stats (computed from events)
export function selectReminderStats(s) {
  const start = new Date(); start.setDate(start.getDate() - 30);
  const recent = s.reminderEvents.filter((e) => new Date(e.sentAt) >= start);
  const sent = recent.filter((e) => e.status === 'sent').length;
  const failed = recent.filter((e) => e.status === 'failed').length;
  const total = sent + failed;
  const deliveryRate = total > 0 ? Math.round((sent / total) * 100) : 100;
  return {
    sentThisMonth: sent,
    deliveryRate,
    noShowsPrevented: Math.round(sent * 0.06), // synthetic heuristic for prototype
  };
}

// Unread messages count per conversation. For DMs, "unread for me" means messages
// authored by the *other* participant that I haven't read yet — not direction='in'
// (DM messages all carry direction='internal').
//
// Muted threads (the current user is in `mutedByUserIds`) report zero unread —
// muting silences both the in-app toast and the visible badge on the thread row.
export function selectUnreadForConversation(s, conversationId) {
  const conv = s.conversations.find((c) => c.id === conversationId);
  if (!conv) return 0;
  const uid = s.currentUserId;
  if (Array.isArray(conv.mutedByUserIds) && conv.mutedByUserIds.includes(uid)) return 0;
  const isUnreadForViewer = (m) =>
    m.authorUserId !== uid && !(m.readByUserIds || []).includes(uid);
  if (conv.channel === 'dm') {
    return s.messages.filter(
      (m) => m.conversationId === conversationId && Boolean(m.authorUserId) && isUnreadForViewer(m)
    ).length;
  }
  if (conv.channel === 'internal') {
    return s.messages.filter(
      (m) => m.conversationId === conversationId && isUnreadForViewer(m)
    ).length;
  }
  return s.messages.filter(
    (m) => m.conversationId === conversationId && m.direction === 'in' && isUnreadForViewer(m)
  ).length;
}

// ---------- Messaging inbox helpers (Phase 2a) ----------

// Sort conversations newest-first using denormalized lastMessageAt (falls back to createdAt).
export function sortConversationsByRecency(list) {
  return [...list].sort((a, b) => {
    const aT = a.lastMessageAt || a.createdAt || '';
    const bT = b.lastMessageAt || b.createdAt || '';
    return aT < bT ? 1 : aT > bT ? -1 : 0;
  });
}

// Returns conversations scoped to a given inbox bucket.
//   'inbox'    — all external (sms/email) conversations. No per-user gating.
//   'internal' — internal-only team chats (channel === 'internal'). Visibility is
//                gated to listed participants — creators must explicitly include
//                members at thread-creation time (via the New-thread modal). The
//                "soft hide from view" lever was removed; users can mute the
//                thread (silence notifications) or hard-delete it (creator/Super
//                Admin only). Crew who aren't members never see the thread.
//   'dm'       — 1:1 direct messages (channel === 'dm'). Visibility is gated to
//                participants for ALL roles (owner/admin/crew) — admins do NOT
//                see DMs they aren't party to.
export function selectConversationsForInbox(s, inbox, currentUser) {
  const convos = s.conversations || [];
  const uid = currentUser?.id;

  if (inbox === 'internal') {
    if (!uid) return [];
    const list = convos.filter(
      (c) => c.channel === 'internal' && (c.participantUserIds || []).includes(uid)
    );
    return sortConversationsByRecency(list);
  }

  if (inbox === 'dm') {
    if (!uid) return [];
    const list = convos.filter(
      (c) => c.channel === 'dm' && (c.participantUserIds || []).includes(uid)
    );
    return sortConversationsByRecency(list);
  }

  // 'inbox' — all external threads.
  const external = convos.filter((c) => c.channel === 'sms' || c.channel === 'email');
  return sortConversationsByRecency(external);
}

// Resolve who created a thread, surviving the creator's removal from the team.
// DELETE_USER demotes createdByUserId → createdByName (the keys/heldByName move),
// so the name outlives the link. Returns:
//   state 'active'   — creator is a live, active team member
//   state 'inactive' — creator's record exists but isn't status:'active'
//                      (disabled / revoked invite) — they may come back
//   state 'removed'  — creator was hard-deleted; only the denormalized name is left
//   state 'unknown'  — no creator at all (inbound/system threads, or a deletion
//                      that predates createdByName)
export function selectThreadCreator(s, conv) {
  if (!conv) return { user: null, name: null, isActive: false, state: 'unknown' };
  const user = conv.createdByUserId ? selectUserById(s, conv.createdByUserId) : null;
  if (user) {
    const isActive = user.status === 'active';
    return { user, name: user.name || null, isActive, state: isActive ? 'active' : 'inactive' };
  }
  const name = conv.createdByName || null;
  // A dangling id with no matching user record is a removal too — same outcome
  // for the caller as a cleanly nulled link.
  const removed = Boolean(name) || Boolean(conv.createdByUserId);
  return { user: null, name, isActive: false, state: removed ? 'removed' : 'unknown' };
}

// An internal thread with no ACTIVE creator behind it. This is the Super-Admin
// maintenance set: the creator was deleted, or their account is no longer active.
// The zero-participants clause is the degenerate case that makes this feature
// necessary at all — selectConversationsForInbox is participant-scoped for every
// role, so once a thread's members are all deleted it is visible to NOBODY and
// can never be reached, let alone removed, without this escape hatch.
export function selectIsOrphanedThread(s, conv) {
  if (!conv || conv.channel !== 'internal') return false;
  if ((conv.participantUserIds || []).length === 0) return true;
  return !selectThreadCreator(s, conv).isActive;
}

// Every orphaned internal thread, newest-first. Super-Admin call sites only —
// this deliberately bypasses participant scoping, so it must never feed a
// surface that renders message contents.
export function selectOrphanedInternalThreads(s) {
  const list = (s.conversations || []).filter((c) => selectIsOrphanedThread(s, c));
  return sortConversationsByRecency(list);
}

// Who may retitle a thread. Names belong to their owner: the creator can always
// rename their own thread, and nobody else can — EXCEPT that an orphan's name
// would otherwise be frozen forever, so a Super Admin can rename those (the same
// cleanliness/maintenance justification as orphan delete). Single definition,
// shared by the message-pane header and the orphan panel.
export function selectCanRenameThread(s, conv, currentUser) {
  if (!conv || conv.channel !== 'internal' || !currentUser) return false;
  if (conv.createdByUserId && conv.createdByUserId === currentUser.id) return true;
  return currentUser.role === 'owner' && selectIsOrphanedThread(s, conv);
}

// Find an existing DM thread between two users (order-independent).
// Used by the New-DM flow for dedup.
export function selectDmConversationBetween(s, userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return null;
  const sorted = [userIdA, userIdB].sort();
  return (s.conversations || []).find((c) => {
    if (c.channel !== 'dm') return false;
    const p = (c.participantUserIds || []).slice().sort();
    return p.length === 2 && p[0] === sorted[0] && p[1] === sorted[1];
  }) || null;
}

// For a DM conversation, returns the user record for the *other* participant
// (the one who isn't the current user). Returns null if none found.
export function selectOtherParticipant(s, conv, currentUserId) {
  if (!conv || conv.channel !== 'dm') return null;
  const otherId = (conv.participantUserIds || []).find((id) => id !== currentUserId);
  if (!otherId) return null;
  return selectUserById(s, otherId);
}

// Unread count for a whole inbox bucket (used by the rail badges).
export function selectUnreadCountForInbox(s, inbox, currentUser) {
  const convos = selectConversationsForInbox(s, inbox, currentUser);
  return convos.reduce((acc, c) => acc + selectUnreadForConversation(s, c.id), 0);
}

// ---------- Marketing (v37) ----------
// Email marketing module — company-shared rotation inboxes + sequences with
// embedded steps + per-contact enrollments + send-events log + global settings.
// Distinct from per-user Messaging (which uses connectedInboxes).

export const selectMarketingInboxes = (s) =>
  Array.isArray(s.marketingInboxes) ? s.marketingInboxes : [];

// Round-robin candidate set: enabled + status==='active', sorted by rotationOrder.
// The scheduler picks marketingInboxes[seq.nextInboxIndex % activeInboxes.length].
export const selectActiveMarketingInboxes = (s) =>
  (s.marketingInboxes || [])
    .filter((i) => i.enabled !== false && i.status === 'active')
    .sort((a, b) => (a.rotationOrder ?? 0) - (b.rotationOrder ?? 0));

export const selectMarketingInboxById = (s, id) =>
  (s.marketingInboxes || []).find((i) => i.id === id) || null;

// The marketing-suppression row for a given email (case-insensitive), or null.
// Row shape: { email, source, reason, createdAt }. Backs the contact card's
// "Marketing emails" row (provenance label + toggle) and any suppression check
// that needs the WHY, not just membership.
export const selectMarketingSuppressionForEmail = (s, email) => {
  const key = (email || '').trim().toLowerCase();
  if (!key) return null;
  return (s.marketingSuppressions || []).find(
    (row) => (row.email || '').toLowerCase() === key
  ) || null;
};

export const selectMarketingSequences = (s) =>
  Array.isArray(s.marketingSequences) ? s.marketingSequences : [];

export const selectActiveMarketingSequences = (s) =>
  (s.marketingSequences || []).filter((seq) => seq.status === 'active');

export const selectMarketingSequenceById = (s, id) =>
  (s.marketingSequences || []).find((seq) => seq.id === id) || null;

// Steps are embedded on the sequence row; return them sorted by .order.
export const selectStepsForSequence = (s, sequenceId) => {
  const seq = (s.marketingSequences || []).find((x) => x.id === sequenceId);
  if (!seq) return [];
  return [...(seq.steps || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
};

export const selectMarketingEnrollments = (s) =>
  Array.isArray(s.marketingEnrollments) ? s.marketingEnrollments : [];

export const selectEnrollmentsForSequence = (s, sequenceId) =>
  (s.marketingEnrollments || []).filter((e) => e.sequenceId === sequenceId);

export const selectActiveEnrollmentsForSequence = (s, sequenceId) =>
  (s.marketingEnrollments || []).filter(
    (e) => e.sequenceId === sequenceId && e.status === 'active'
  );

// Classify an enrollment into a flow-view bucket: a numeric step index (the
// step it will receive NEXT), 'replied', 'completed', or null (unenrolled).
// A replied enrollment reports as 'replied' regardless of step so the per-step
// counts reflect only contacts still actively moving through the sequence.
function flowBucketOf(e, stepCount) {
  if (!e || e.status === 'unenrolled') return null;
  if (e.repliedAt || e.status === 'replied') return 'replied';
  const i = e.currentStepIndex || 0;
  if (e.status === 'completed' || i >= stepCount) return 'completed';
  return i;
}

// Flow-view summary for a sequence: perStep[i] = how many active contacts are
// currently waiting to receive step i, plus replied + completed tallies.
// Excludes unenrolled. stepCount bounds the perStep array.
export function selectEnrollmentStepBuckets(s, sequenceId, stepCount) {
  const n = Math.max(0, stepCount || 0);
  const perStep = Array.from({ length: n }, () => 0);
  let replied = 0;
  let completed = 0;
  (s.marketingEnrollments || []).forEach((e) => {
    if (e.sequenceId !== sequenceId) return;
    const b = flowBucketOf(e, n);
    if (b === null) return;
    if (b === 'replied') replied += 1;
    else if (b === 'completed') completed += 1;
    else perStep[b] += 1;
  });
  return { perStep, replied, completed };
}

// Enrollments in one flow bucket — a step index, 'replied', or 'completed' —
// sorted FIFO by enrolledAt (matching the Enrolled roster). Excludes
// unenrolled. Backs the per-step contact list.
export function selectEnrollmentsInBucket(s, sequenceId, bucket, stepCount) {
  const n = Math.max(0, stepCount || 0);
  return (s.marketingEnrollments || [])
    .filter((e) => e.sequenceId === sequenceId && flowBucketOf(e, n) === bucket)
    .sort((a, b) => {
      const aT = a.enrolledAt || '';
      const bT = b.enrolledAt || '';
      return aT < bT ? -1 : aT > bT ? 1 : 0;
    });
}

export const selectEnrollmentForContactAndSequence = (s, contactId, sequenceId) =>
  (s.marketingEnrollments || []).find(
    (e) => e.contactId === contactId && e.sequenceId === sequenceId
  ) || null;

export const selectMarketingSends = (s) =>
  Array.isArray(s.marketingSends) ? s.marketingSends : [];

export const selectSendsForEnrollment = (s, enrollmentId) =>
  (s.marketingSends || []).filter((sd) => sd.enrollmentId === enrollmentId);

export const selectSendsForSequence = (s, sequenceId) =>
  (s.marketingSends || []).filter((sd) => sd.sequenceId === sequenceId);

// Delivery diagnostics for a sequence: the failed sends (raw — the UI resolves
// contact/step + humanizes the reason) plus systemic blockers that silently
// stall delivery (currently: no connected sending inbox while contacts wait).
export function selectSequenceDiagnostics(s, sequenceId) {
  const failed = (s.marketingSends || []).filter(
    (sd) => sd.sequenceId === sequenceId && sd.status === 'failed'
  );
  const waiting = (s.marketingEnrollments || []).filter(
    (e) => e.sequenceId === sequenceId && e.status === 'active' && !e.repliedAt
  );
  const activeInboxes = (s.marketingInboxes || []).filter(
    (i) => i.enabled !== false && i.status === 'active'
  );
  return {
    failed,
    failedCount: failed.length,
    waitingCount: waiting.length,
    noActiveInbox: waiting.length > 0 && activeInboxes.length === 0,
  };
}

// Marketing replies — inbound replies correlated to a sequence/contact, newest
// first so the Replies inbox reads top-down.
export const selectMarketingReplies = (s) =>
  [...(s.marketingReplies || [])].sort((a, b) => {
    const at = a.receivedAt || '';
    const bt = b.receivedAt || '';
    return at < bt ? 1 : at > bt ? -1 : 0;
  });

// Global Marketing settings — falls back to a sane empty shape so consumers
// can read replyRouting.pipelineId etc. without optional-chaining gymnastics.
export const selectMarketingSettings = (s) =>
  s.marketingSettings || {
    replyRouting: { enabled: false, pipelineId: null, stageKey: null },
    plainTextDefault: false,
    defaultSendWindow: { start: 9, end: 17 },
    sendTimezone: null,
    sendIntervalMinutes: 5,
  };

// Resolves the reply-routing config into concrete pipeline + stage records.
// Returns null when the user hasn't picked a target OR the picked pipeline /
// stage no longer exists (defensive — pipelines can be edited / deleted).
export const selectReplyRoutingTarget = (s) => {
  const settings = selectMarketingSettings(s);
  const rr = settings.replyRouting || {};
  if (!rr.enabled) return null;
  if (!rr.pipelineId || !rr.stageKey) return null;
  const pipeline = (s.pipelines || []).find((p) => p.id === rr.pipelineId);
  if (!pipeline) return null;
  const stage = (pipeline.stages || []).find((st) => st.key === rr.stageKey);
  if (!stage) return null;
  return { pipeline, stage };
};

// Aggregate stats for the Overview tab. enrolledCount counts all enrollments
// for the sequence regardless of status (matches "how many people did we put
// in this sequence ever"). sent/replied/failed are derived from the sends log.
export function selectSequenceStats(s, sequenceId) {
  const enrollments = (s.marketingEnrollments || []).filter((e) => e.sequenceId === sequenceId);
  const sends = (s.marketingSends || []).filter((sd) => sd.sequenceId === sequenceId);
  const sentCount = sends.filter((sd) => sd.status === 'sent').length;
  const failedCount = sends.filter((sd) => sd.status === 'failed').length;
  const repliedCount = enrollments.filter((e) => e.status === 'replied').length;
  const lastActivityAt = sends.reduce(
    (acc, sd) => (sd.sentAt && (!acc || sd.sentAt > acc) ? sd.sentAt : acc),
    null
  );
  return {
    // Exclude unenrolled — they've been pulled out of the sequence; counting
    // them inflates the "enrolled" stat past what the SequenceContactsModal
    // actually shows in its Enrolled tab.
    enrolledCount: enrollments.filter((e) => e.status !== 'unenrolled').length,
    sentCount,
    failedCount,
    repliedCount,
    lastActivityAt,
  };
}
