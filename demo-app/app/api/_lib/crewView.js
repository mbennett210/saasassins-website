// CS-002 — the CREW READ PROJECTION.
//
// WHY THIS EXISTS. The whole app store is ONE `org_state` JSONB row, so RLS cannot hide
// fields INSIDE it — a SELECT policy is all-or-nothing on the row. Owner / admin / manager
// keep the full blob; crew must not read pay, HR, invoices, other accounts' data, master
// key codes, or other users' notifications and threads. So crew stop reading `org_state`
// directly (the migration flips its SELECT policy to office-only) and receive a
// server-built PROJECTION from GET /api/state/view instead. This module builds it.
//
// ALLOWLIST, DENY BY DEFAULT. `CREW_VIEW_CLASSIFICATION` names EVERY top-level slice of the
// blob (derived from INITIAL_STATE in src/data/seed.js) as keep / trim / scope / drop /
// table / session. A slice NOT in the classification is DROPPED — the opposite default from
// orgStateGuard's deny-by-exception, and the correct one for a read projection: a new slice
// is invisible to crew until someone deliberately classifies it. test-crew-view.mjs fails
// the build when a slice in INITIAL_STATE is missing here (or a classification key no longer
// exists in the seed), so the two can never drift.
//
//   keep    → passed through whole (org identity + config crew's app needs)
//   trim    → row-level field subset (users: no pay/hr/others' PII; opsSettings: no pay-run)
//   scope   → row-level filter to the crew's assignment (crewAssignedScope) or to self
//   drop    → never in the projection (deny by default)
//   table   → lives per-row in public.jobs, not the blob; crew get their OWN rows from the
//             RLS-scoped jobs table, so the projection carries an empty array
//   session → per-session, never in the shared blob at all (currentUserId)
//
// PURE. No I/O, no env, no throw — projectCrewView(state, { userId, crewJobs | scope }) is a
// function of its inputs, so test-crew-view.mjs drives it with hand-built states. Scope comes
// from authz.crewAssignedScope (the SAME rule the server's site gates use), passed in or
// computed from the caller's jobs.
import { crewAssignedScope } from './authz.js';
import { makeKeyScope } from '../../src/lib/keyScope.js';

// The pay-run money fields inside opsSettings, stripped from the crew projection (the rest —
// geofence radius, variance thresholds, alert graces — the crew clock-in / ops surfaces read).
// Kept in step with the guard's money projection intent (orgStateGuard opsSettings) and
// seed.js INITIAL_STATE.opsSettings.
export const OPS_PAYRUN_FIELDS = Object.freeze([
  'otMultiplier', 'payPeriodCadence', 'payWeekStartDay', 'payDriveTime',
]);

// EVERY top-level slice of INITIAL_STATE, classified. test-crew-view.mjs reconciles this
// against Object.keys(INITIAL_STATE) so a new slice can never slip in unclassified.
export const CREW_VIEW_CLASSIFICATION = Object.freeze({
  version: 'keep',
  company: 'trim',                 // org identity + settings; company.integrations trimmed to the send-readiness fields crew read (no last4/EIN/address/DKIM/DNS/tokens)
  currentUserId: 'session',        // per-session, stripped from the blob by toSharedBlob — never present
  users: 'trim',                   // id/name/initials/avatar/role/status (+phone for office rows); self adds email/phone/prefs/clockRules
  services: 'keep',
  frequencies: 'keep',
  clients: 'scope',                // in-scope accounts only
  sites: 'scope',                  // in-scope locations only
  jobs: 'table',                   // per-row public.jobs; crew get their own rows from the scoped table
  invoices: 'drop',
  quotes: 'drop',
  syncedPayments: 'drop',
  financialSnapshot: 'drop',
  conversations: 'scope',          // threads the caller participates in + external threads for in-scope accounts
  messages: 'scope',               // messages in visible conversations
  reminderTemplates: 'drop',
  reminderEvents: 'drop',
  clientReview: 'drop',
  permissions: 'keep',             // the crew's own can() reads the org matrix
  contacts: 'scope',               // contacts of in-scope accounts
  tags: 'keep',
  contactActivities: 'drop',       // deny by default — not a crew surface
  clientActivities: 'scope',       // activity/notes for in-scope accounts
  userPermissionOverrides: 'scope',// the caller's OWN override row only
  snippets: 'keep',                // canned message text (crew Messaging)
  pipelines: 'drop',
  activePipelineId: 'drop',
  opportunities: 'drop',
  invitations: 'drop',
  timeOff: 'scope',                // the caller's OWN entries
  oauthWorkspaces: 'drop',
  connectedInboxes: 'drop',
  notifications: 'scope',          // the caller's OWN bell rows
  marketingInboxes: 'drop',
  marketingSequences: 'drop',
  marketingEnrollments: 'drop',
  marketingSends: 'drop',
  marketingReplies: 'drop',
  marketingSuppressions: 'drop',
  marketingSettings: 'drop',
  keys: 'scope',                   // in-scope keys + keys the caller holds; masterCode REMOVED
  keyEvents: 'scope',              // events for visible keys
  reviews: 'drop',
  opsSettings: 'trim',             // geofence/variance/alert knobs kept; pay-run fields removed
  payrollLines: 'drop',
  reimbursements: 'drop',
  employeeDocuments: 'drop',
  inspectionTemplates: 'keep',     // crew perform/view QC against the template defs
  checklistTemplates: 'keep',
  accountMedia: 'scope',           // media refs for in-scope sites
  inspectionFollowUps: 'drop',     // manager triage
  opsAlertEvents: 'drop',          // once-fired markers; a crew tab never raises ops alerts
  supplyItems: 'drop',             // crew hold no supplies permission
  supplyRequests: 'drop',
});

// A key row with its master code removed. The crew Keys page shows custody, never the
// master code — the code reveal is a separate server-gated capability (ops.revealCodes).
function stripMasterCode(k) {
  if (!k || typeof k !== 'object') return k;
  const { masterCode, ...rest } = k;
  return rest;
}

// The caller's own row keeps its contact + preference fields; every other row is trimmed to
// what the crew UI legitimately renders (name / avatar / role / status, and phone only for a
// supervisor they may need to reach). Never pay / hr / employeeDocuments / disabledAt / other
// people's email or notification prefs.
function trimUserRow(u, isSelf) {
  if (!u || typeof u !== 'object') return u;
  const row = {
    id: u.id,
    name: u.name ?? null,
    initials: u.initials ?? null,
    avatar: u.avatar ?? null,
    role: u.role ?? null,
    status: u.status ?? null,
  };
  // Office rows keep a phone so crew can reach a supervisor; crew rows do not.
  if (u.role && u.role !== 'crew') row.phone = u.phone ?? null;
  if (isSelf) {
    row.email = u.email ?? null;
    row.phone = u.phone ?? null;
    row.notificationPrefs = u.notificationPrefs ?? null;
    row.signaturePrefs = u.signaturePrefs ?? null;
    // Their OWN clock rules only (checklists step 4b): the clock-out gate and the clock-in
    // control read `clockRules` off the current user, so a cleaner the office exempted from
    // the checklist block or the geofence would still be blocked BY THEIR OWN DEVICE if the
    // projection dropped the field — the server would allow the punch the app refuses to
    // send. Read-only here: mergeCrewChanges never merges it back (only name / phone /
    // prefs), and orgStateGuard refuses it from a non-holder on their own row as well.
    row.clockRules = u.clockRules ?? null;
  }
  return row;
}

// opsSettings without the pay-run money fields (see OPS_PAYRUN_FIELDS).
function trimOpsSettings(ops) {
  if (!ops || typeof ops !== 'object') return ops ?? null;
  const out = {};
  for (const [k, v] of Object.entries(ops)) if (!OPS_PAYRUN_FIELDS.includes(k)) out[k] = v;
  return out;
}

// company with company.integrations TRIMMED (CS-002 F2). integrations holds connection SECRETS
// — twilio accountSidLast4 / connectedAt / inboundWebhookUrl and a2p EIN + business address;
// email apiKeyLast4 / verifiedDomain / defaultFrom and the DKIM/SPF/DMARC records — none of
// which a field user has any reason to see. The only crew-reachable readers of integrations are
// the messaging composer (useMessageSender) and the reminder scheduler, and they read ONLY
// send-readiness: is SMS connected, the from-number, the A2P status, and the transactional
// reply-to. So the projection keeps EXACTLY those fields and drops the rest — never a last4,
// EIN, address, DKIM/DNS record, webhook URL or token. Everything else on `company` (name,
// logo, timezone, address, email) is org identity the crew app needs and passes through.
function trimCompanyForCrew(company) {
  if (!company || typeof company !== 'object') return company ?? null;
  const integ = company.integrations;
  if (!integ || typeof integ !== 'object') return company; // nothing sensitive to trim
  const integrations = {};
  if (integ.twilio && typeof integ.twilio === 'object') {
    integrations.twilio = {
      connected: !!integ.twilio.connected,
      phoneNumber: integ.twilio.phoneNumber ?? null,
      a2p: { status: integ.twilio.a2p?.status ?? null },
    };
  }
  if (integ.email && typeof integ.email === 'object') {
    integrations.email = { defaultReplyTo: integ.email.defaultReplyTo ?? null };
  }
  return { ...company, integrations };
}

// Is a conversation visible to this crew member?
//   internal / dm  → the caller is a participant. An ORPHANED thread (all participants
//                    offboarded by DELETE_USER, participantUserIds now []) is NOT visible:
//                    selectors.js scopes internal/dm to participants for EVERY role
//                    (selectConversationsForInbox), and the only surface that reaches an
//                    orphaned thread is the Super-Admin-only selectOrphanedInternalThreads
//                    maintenance escape hatch, which never renders message contents. So an
//                    orphan stays office-only here too — an empty participant list is NOT
//                    visible-to-all (CS-002 F1: the old `parts.length === 0` clause leaked
//                    every orphaned thread, with its messages, into every crew projection).
//   external (sms/email/other) → the thread belongs to an account in the caller's scope
//                    (by clientId, or by the linked contact's company).
export function conversationVisibleToCrew(conv, userId, clientIds, contactCompany) {
  if (!conv || typeof conv !== 'object') return false;
  const parts = Array.isArray(conv.participantUserIds) ? conv.participantUserIds : [];
  if (conv.channel === 'internal' || conv.channel === 'dm') {
    return parts.includes(userId);
  }
  if (conv.clientId && clientIds.has(conv.clientId)) return true;
  const co = conv.contactId ? contactCompany.get(conv.contactId) : null;
  return !!co && clientIds.has(co);
}

// Build the crew projection of `state` for `userId`. Scope is the caller's assignment
// (authz.crewAssignedScope): pass a precomputed `scope`, or `crewJobs` (the caller's jobs
// from public.jobs) to compute it. Returns a NEW object carrying only the classified,
// trimmed, scoped slices — never a reference into `state` for a slice it filters.
export function projectCrewView(state, { userId, crewJobs = [], scope = null } = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const sc = scope || crewAssignedScope(s, userId, crewJobs);
  const clientIds = new Set(Array.isArray(sc?.clientIds) ? sc.clientIds : []);
  const siteIds = new Set(Array.isArray(sc?.siteIds) ? sc.siteIds : []);

  const users = (Array.isArray(s.users) ? s.users : []).map((u) => trimUserRow(u, !!u && u.id === userId));

  const clients = (Array.isArray(s.clients) ? s.clients : []).filter((c) => c && clientIds.has(c.id));
  const sites = (Array.isArray(s.sites) ? s.sites : []).filter((si) => si && siteIds.has(si.id));
  const contacts = (Array.isArray(s.contacts) ? s.contacts : []).filter((c) => c && c.companyId && clientIds.has(c.companyId));
  const clientActivities = (Array.isArray(s.clientActivities) ? s.clientActivities : []).filter((a) => a && clientIds.has(a.clientId));

  // Keys: the exact rule the Keys page + selectVisibleKeysFor apply, then master codes out.
  const keyScope = makeKeyScope({ id: userId, role: 'crew' }, clients);
  const visibleKeys = (Array.isArray(s.keys) ? s.keys : []).filter(keyScope);
  const keys = visibleKeys.map(stripMasterCode);
  const visibleKeyIds = new Set(visibleKeys.map((k) => k && k.id));
  const keyEvents = (Array.isArray(s.keyEvents) ? s.keyEvents : []).filter((e) => e && visibleKeyIds.has(e.keyId));

  const contactCompany = new Map((Array.isArray(s.contacts) ? s.contacts : []).map((c) => [c && c.id, c && c.companyId]));
  const conversations = (Array.isArray(s.conversations) ? s.conversations : [])
    .filter((c) => conversationVisibleToCrew(c, userId, clientIds, contactCompany));
  const convIds = new Set(conversations.map((c) => c.id));
  const messages = (Array.isArray(s.messages) ? s.messages : []).filter((m) => m && convIds.has(m.conversationId));

  const accountMedia = (Array.isArray(s.accountMedia) ? s.accountMedia : [])
    .filter((m) => m && (siteIds.has(m.siteId) || clientIds.has(m.clientId)));

  return {
    // keep
    version: s.version,
    services: s.services ?? [],
    frequencies: s.frequencies ?? [],
    tags: s.tags ?? [],
    permissions: s.permissions ?? [],
    snippets: s.snippets ?? [],
    inspectionTemplates: s.inspectionTemplates ?? [],
    checklistTemplates: s.checklistTemplates ?? [],
    // trim
    company: trimCompanyForCrew(s.company),
    users,
    opsSettings: trimOpsSettings(s.opsSettings),
    // scope
    clients,
    sites,
    contacts,
    clientActivities,
    conversations,
    messages,
    keys,
    keyEvents,
    accountMedia,
    notifications: (Array.isArray(s.notifications) ? s.notifications : []).filter((n) => n && n.userId === userId),
    timeOff: (Array.isArray(s.timeOff) ? s.timeOff : []).filter((t) => t && t.userId === userId),
    userPermissionOverrides: (Array.isArray(s.userPermissionOverrides) ? s.userPermissionOverrides : []).filter((o) => o && o.userId === userId),
    // table — crew get their own rows from the RLS-scoped public.jobs, not the blob
    jobs: [],
  };
}
