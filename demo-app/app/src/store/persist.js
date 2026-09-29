// v45: Per-sequence "Notify on reply" config. Adds two new fields to each
// marketing sequence — `notifyOnReplyUserId` (string|null; operator-picked
// team user to ping when a contact replies) and `notifyOnReplyChannels`
// ({ inApp: boolean }; channel toggles). The reducer's RECEIVE_MARKETING_REPLY
// case writes a notification row directly into state.notifications when both
// are configured. Email arm intentionally deferred (Resend transactional path
// + DNS records still pending). Migration backfills the two fields onto
// existing sequences. Purely additive.
//
// v42: Per-inbox signature blocks + per-step attachments. Adds `signature`
// (string) to each marketing inbox and `attachments` (array) to each sequence
// step. Attachment blob bytes live in IndexedDB (lib/attachments) — only the
// metadata shape is migrated here. Purely additive.
//
// v41: Per-inbox daily send cap. Adds a `dailySendLimit` field to each
// marketing inbox — the max emails it sends per calendar day, default 10.
// The migration backfills the default onto existing inboxes; purely additive.
//
// v40: Marketing reply tags. Adds a per-sequence `replyTags` array — tags
// applied to a contact when they reply. Migration backfills `[]` onto every
// existing sequence.
//
// v39: Marketing Replies inbox. Adds a `marketingReplies` slice and two
// per-sequence fields — `haltOnReply` (drip stops when a contact replies)
// and `replyRouting` (which pipeline/stage a reply moves the contact to).
// Migration backfills both onto existing sequences from the global default.
//
// v38: Marketing per-inbox send throttle. Adds `sendIntervalMinutes` to
// marketingSettings (minutes each rotation inbox waits between sends,
// default 5). Purely additive — the migration backfills the default onto
// existing states.
//
// v37: Marketing module. Additive — slots in five new top-level state arrays
// (marketingInboxes, marketingSequences, marketingEnrollments, marketingSends)
// and one settings object (marketingSettings: { replyRouting, plainTextDefault,
// defaultSendWindow }). Also reconciles the permissions list against the
// current PERMISSIONS schema so the three new marketing.* keys land with
// their default role assignments without losing user customizations.
//
// v36: Brand domain consolidation + id-based Heather rename. Two coordinated
// changes:
//   1. Every team-user email on @cleanspace.co is rewritten to
//      @cleanspaceonline.com (full brand domain). Same for
//      company.email. The short alias was a placeholder.
//   2. Heather's user record (by stable seed id, not by name match) is
//      force-corrected to "Heather Warren" / "HW" — catches any stale name
//      on existing localStorage that the v35 string-match missed (e.g.
//      "Heather Whitfield" or other prior placeholders).
//
// v35: Heather's real last name. Seed previously used "Heather Cole" as a
// placeholder; corrected to "Heather Warren" (real team member). Migration
// updates the user's name + initials on existing stored state.
//
// v34: Nomenclature consolidation — "Customer" lifecycle stage renamed to
// "Client" (matching the company entity already named Client in the data
// layer) AND the notification pref key newCustomerMessage renamed to
// newClientMessage. Migration:
//   - Every contact with lifecycle === 'customer' is flipped to 'client'.
//   - Every user.notificationPrefs gains newClientMessage with the prior
//     newCustomerMessage value (default true) and drops the old key.
//   - Permissions list reconciled against the live PERMISSIONS schema so
//     refreshed labels (e.g. "View Clients" instead of "View Accounts")
//     flow into stored state without losing role assignments.
//
// v33: Per-user read state and per-user pin/star. Two coordinated changes that
// make user-switching reflect each user's perspective for the demo:
//   1. message.readAt (single global timestamp) → message.readByUserIds[]
//      (set of user ids who've marked the message read). Selectors gain an
//      `authorUserId !== uid` guard so authors don't show their own sends as
//      unread without needing to populate readByUserIds with themselves.
//   2. conversation.starred (single boolean) → conversation.starredByUserIds[]
//      so each user maintains their own pinned list. Mute already followed
//      this pattern (mutedByUserIds) — we're catching star up.
// Migration backfills both shapes from the old fields (read messages get all
// active users; previously-starred threads get the saved currentUserId so the
// user who pinned them keeps their pin).
//
// v29: Persistent in-app notifications. Adds top-level `state.notifications`
// (per-user, sorted newest-first) for the bell-icon notifications panel.
// Purely additive — empty array on existing states.
//
// v28: Per-user notification preferences. Adds `notificationPrefs` to every
// user with all event toggles defaulted on and `mobilePushEnabled` defaulted
// off. Also drops the now-unused reminder UI surface (the `/settings/notifications`
// page is gone) — but the underlying `reminderTemplates` / `reminderEvents`
// state is left in place because the client-facing scheduler still consumes
// it. Purely additive; existing data is preserved.
//
// v27: Email System foundation. Two additive state surfaces in lockstep:
//   1. company.integrations.email — system transactional provider (Resend)
//      that powers invitations, reminder emails, and (later) billing.
//      Mirrors company.integrations.twilio in shape and reducer pattern.
//   2. connectedInboxes — per-user mailbox connections for the Messaging
//      email channel. Each row pairs a userId with a provider (google /
//      microsoft / smtp). Tokens + SMTP passwords NEVER live in client
//      state; backend holds them encrypted at rest.
// Migration is purely additive: slots in the default `email` block where
// missing and ensures `connectedInboxes` exists as an array. Existing data
// is preserved.
//
// v26: Drop the half-baked "internal note on an external thread" feature.
// External threads (sms/email) now only carry direction='in'/'out'. Any
// existing direction='internal' messages on sms/email threads are removed
// during migration. Internal team threads and DMs are unaffected (their
// messages stay direction='internal' as before).
//
// v25: Internal threads gain explicit `participantUserIds` membership (the
// new "New thread" flow forces the creator to pick members or "select all").
// `hiddenForUserIds` is dropped from every conversation — the soft-hide lever
// is gone, users mute or delete instead. Migration backfills existing internal
// threads with all currently-active user ids so prior threads stay visible to
// the team. DM threads keep their two-person participantUserIds untouched.
//
// v24: Replace conversation `followedUserIds` (opt-in subscribe, never wired)
// with `mutedByUserIds` (opt-out silence). Default = empty = notifications on.
// The bell icon in the message panel header now toggles mute and shows a
// bell-off state when the current user has silenced the thread.
//
// v23: Drop "owner" of contact and "assignee" of conversation entirely. Crew
// visibility cascades through jobs.crewIds → client → contacts (admin/owner see
// all). Adds `createdByUserId` + `hiddenForUserIds[]` to conversations: hard
// delete is creator-or-Super-Admin only with a heavy warning; everyone else
// soft-hides threads from their own view.
//
// v22: Invoices rescoped to manual tracking. Drops the 'draft' status (any
// existing drafts migrate to 'pending') and adds two additive fields per
// invoice: `attachment` (metadata for the PDF stored in IndexedDB) and `notes`
// (free-form text shown alongside the summary).
//
// v21: Drop archive concept entirely (only deletion). Purges currently-archived
// conversations/contacts/clients and strips archive flags from the schema.
// Bump in lockstep with INITIAL_STATE.version.
import { PERMISSIONS } from '../lib/roles';
import { collapseToSingleLocationV53 } from '../lib/location';
import { correctOwnerIdentity } from '../lib/ownerRename';
import { retireLocationDefaultsV57 } from '../lib/crewChecklist';

const STORAGE_KEY = 'pp.store.v57';

// FROZEN snapshot of the v28-era notification prefs — used ONLY by the historical
// migrateV27toV28 below. These are NOT the current defaults (those live in
// seed.js DEFAULT_NOTIFICATION_PREFS and may evolve); keeping a private literal
// here means editing the current seed default can never retroactively change a
// frozen migration's output. v28 shipped every event toggle on, mobilePush off.
// Keys added after v28 (accountOpsUpdated, marketingReplyAssigned) are
// intentionally absent — their fan-out helpers treat an absent key as on.
const V28_NOTIFICATION_PREFS = {
  newClientMessage: true,
  newDM: true,
  newInternalMessage: true,
  jobCreatedOrRescheduled: true,
  jobCancelled: true,
  invoicePaid: true,
  invoiceOverdue: true,
  mobilePushEnabled: false,
};

// Default shape for company.integrations.email (kept here so the migration
// and future seed reseeds stay in lockstep without importing seed.js).
const DEFAULT_EMAIL_INTEGRATION = {
  connected: false,
  provider: null,
  apiKeyLast4: null,
  verifiedDomain: null,
  defaultFrom: null,
  defaultReplyTo: null,
  connectedAt: null,
  lastVerifiedAt: null,
  lastError: null,
  domain: {
    status: 'not_started',
    dkimRecords: [],
    spfStatus: null,
    dmarcStatus: null,
    lastCheckedAt: null,
    failureReason: null,
  },
};

// Default Marketing settings — duplicated here (not imported from seed.js) so
// migrations don't pull on seed data and so the shape is unambiguous at the
// persistence layer.
const DEFAULT_MARKETING_SETTINGS = {
  replyRouting: {
    enabled: false,
    pipelineId: null,
    stageKey: null,
  },
  plainTextDefault: false,
  defaultSendWindow: { start: 9, end: 17 },
  sendTimezone: null,
  sendIntervalMinutes: 5,
  unsubscribe: {
    enabled: true,
    message: 'Not interested? {unsubscribe} from these emails.',
    linkText: 'Unsubscribe',
    includeAddress: true,
    address: '',
    baseUrl: '',
  },
};

function migrateV17toV18(state) {
  const crewRestorePerms = ['messaging.use', 'messaging.internalComment'];
  const permissions = (state.permissions || []).map((p) =>
    crewRestorePerms.includes(p.id) && !p.roles.includes('crew')
      ? { ...p, roles: [...p.roles, 'crew'] }
      : p
  );
  return { ...state, version: 18, permissions };
}

function migrateV18toV19(state) {
  const permissions = (state.permissions || []).map((p) => {
    if (p.id === 'dashboard.view') {
      return { ...p, roles: p.roles.filter((r) => r !== 'crew') };
    }
    if ((p.id === 'messaging.use' || p.id === 'messaging.internalComment') && !p.roles.includes('crew')) {
      return { ...p, roles: [...p.roles, 'crew'] };
    }
    return p;
  });
  return { ...state, version: 19, permissions };
}

// v20: additive — DMs introduce a new channel value ('dm') and a new
// participantUserIds field. Existing conversations are untouched.
function migrateV19toV20(state) {
  return { ...state, version: 20 };
}

// v21: Archive concept is gone. Anything currently archived is hard-deleted
// (matches the "no archiving, only deletion" directive). The `archived` field
// on conversations and the 'archived' lifecycle bucket on contacts are stripped.
// `archivedAt` timestamps on contacts/clients are dropped too. Inactive clients
// (status: 'inactive' with archivedAt) are purged; active clients are untouched.
// Also reconciles the permissions list with the current PERMISSIONS schema:
// adds new permission keys (e.g. messaging.startInternalThread), migrates the
// renamed clients.archive → clients.delete (preserving role assignments), and
// drops permission rows that no longer exist in the schema.
function migrateV20toV21(state) {
  const archivedConvIds = new Set(
    (state.conversations || []).filter((c) => c.archived === true).map((c) => c.id)
  );
  const archivedContactIds = new Set(
    (state.contacts || []).filter((c) => c.lifecycle === 'archived').map((c) => c.id)
  );
  const archivedClientIds = new Set(
    (state.clients || []).filter((c) => c.archivedAt || c.status === 'inactive').map((c) => c.id)
  );

  const conversations = (state.conversations || [])
    .filter((c) => !archivedConvIds.has(c.id))
    .map(({ archived, ...rest }) => rest); // strip archived flag from survivors

  const messages = (state.messages || []).filter((m) => !archivedConvIds.has(m.conversationId));

  const contacts = (state.contacts || [])
    .filter((c) => !archivedContactIds.has(c.id) && !archivedClientIds.has(c.companyId))
    .map(({ archivedAt, ...rest }) => rest);

  const clients = (state.clients || [])
    .filter((c) => !archivedClientIds.has(c.id))
    .map(({ archivedAt, ...rest }) => rest);

  // Reconcile permissions against the live PERMISSIONS schema.
  const existingByKey = new Map((state.permissions || []).map((p) => [p.id, p]));
  // clients.archive was renamed to clients.delete — carry over its role list.
  const renamed = existingByKey.get('clients.archive');
  if (renamed && !existingByKey.has('clients.delete')) {
    existingByKey.set('clients.delete', { ...renamed, id: 'clients.delete', label: 'Delete clients' });
  }
  existingByKey.delete('clients.archive');
  const permissions = Object.entries(PERMISSIONS).map(([key, def]) => {
    const prev = existingByKey.get(key);
    return prev
      ? { id: key, label: def.label, roles: prev.roles }
      : { id: key, label: def.label, roles: [...def.defaultRoles] };
  });

  return {
    ...state,
    version: 21,
    conversations,
    messages,
    contacts,
    clients,
    sites: (state.sites || []).filter((s) => !archivedClientIds.has(s.clientId)),
    jobs: (state.jobs || []).filter((j) => !archivedClientIds.has(j.clientId)),
    invoices: (state.invoices || []).filter((i) => !archivedClientIds.has(i.clientId)),
    clientActivities: (state.clientActivities || []).filter((a) => !archivedClientIds.has(a.clientId)),
    contactActivities: (state.contactActivities || []).filter((a) => !archivedContactIds.has(a.contactId)),
    permissions,
  };
}

// v22: Invoices rescope. Drop the 'draft' status (→ 'pending') and add the two
// additive fields the new UI reads: `attachment` (null when no PDF on file) and
// `notes` (empty string by default). Purely additive — existing payments,
// line items, statuses and FKs are untouched.
function migrateV21toV22(state) {
  const invoices = (state.invoices || []).map((inv) => ({
    ...inv,
    status: inv.status === 'draft' ? 'pending' : inv.status,
    attachment: inv.attachment ?? null,
    notes: typeof inv.notes === 'string' ? inv.notes : '',
  }));
  return { ...state, version: 22, invoices };
}

// v23: Strip contact-owner and conversation-assignee. Add createdByUserId +
// hiddenForUserIds[] to every conversation. Reconcile permissions against the
// live schema (drops dead keys, ensures contacts.view applies to crew).
function migrateV22toV23(state) {
  // Strip ownerUserId from every contact.
  const contacts = (state.contacts || []).map(({ ownerUserId, ...rest }) => rest);

  // Backfill conversation creator from the earliest authored message on the
  // thread. For inbound-only threads (no human author) we leave it null —
  // hard-delete falls back to Super Admin only.
  const msgsByConv = new Map();
  (state.messages || []).forEach((m) => {
    if (!m.conversationId) return;
    const arr = msgsByConv.get(m.conversationId);
    if (!arr) msgsByConv.set(m.conversationId, [m]);
    else arr.push(m);
  });
  const firstAuthor = (convId) => {
    const arr = msgsByConv.get(convId) || [];
    const authored = arr
      .filter((m) => m.authorUserId)
      .sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));
    return authored[0]?.authorUserId || null;
  };

  const conversations = (state.conversations || []).map((c) => {
    const { assignedUserId, ...rest } = c;
    let creator = c.createdByUserId;
    if (!creator) {
      // For DMs, the lower-sorted participant id is a stable proxy for "originator".
      if (c.channel === 'dm') creator = (c.participantUserIds || [])[0] || null;
      else creator = firstAuthor(c.id);
    }
    return {
      ...rest,
      createdByUserId: creator,
      hiddenForUserIds: Array.isArray(c.hiddenForUserIds) ? c.hiddenForUserIds : [],
    };
  });

  // Reconcile permissions: drop dead keys, add new ones, preserve role
  // assignments where the key still exists.
  const existingByKey = new Map((state.permissions || []).map((p) => [p.id, p]));
  const permissions = Object.entries(PERMISSIONS).map(([key, def]) => {
    const prev = existingByKey.get(key);
    return prev
      ? { id: key, label: def.label, roles: prev.roles }
      : { id: key, label: def.label, roles: [...def.defaultRoles] };
  });
  // If contacts.view exists but lacks crew (carried over from a pre-v23 state where
  // it was admin/owner only), ensure crew is included so the new visibility model
  // takes effect.
  const cv = permissions.find((p) => p.id === 'contacts.view');
  if (cv && !cv.roles.includes('crew')) cv.roles = [...cv.roles, 'crew'];

  return {
    ...state,
    version: 23,
    contacts,
    conversations,
    permissions,
  };
}

// v24: Field rename + semantic flip — followedUserIds (opt-in, dead) becomes
// mutedByUserIds (opt-out). Existing follow lists are dropped on migration:
// the old field never gated anything, so users would be surprised to find
// they had pre-existing "subscriptions" they don't remember opting into,
// and the inverted meaning (now "silence me") would be doubly wrong.
function migrateV23toV24(state) {
  const conversations = (state.conversations || []).map((c) => {
    const { followedUserIds, ...rest } = c;
    return { ...rest, mutedByUserIds: [] };
  });
  return { ...state, version: 24, conversations };
}

// v26: Strip direction='internal' messages from external (sms/email) threads.
// The cross-channel internal-note feature is gone — messaging is per-channel
// only now. Internal team threads and DMs keep all their internal-direction
// messages because for those channels every message IS internal.
function migrateV25toV26(state) {
  const externalConvIds = new Set(
    (state.conversations || [])
      .filter((c) => c.channel === 'sms' || c.channel === 'email')
      .map((c) => c.id)
  );
  const messages = (state.messages || []).filter((m) => {
    if (m.direction !== 'internal') return true;
    return !externalConvIds.has(m.conversationId);
  });
  return { ...state, version: 26, messages };
}

// v29: Persistent in-app notifications surface. Adds an empty `notifications`
// array on the root state so the bell can read/write through one slice.
function migrateV28toV29(state) {
  return { ...state, version: 29, notifications: Array.isArray(state.notifications) ? state.notifications : [] };
}

// v33: Per-user read state + per-user pin. Backfills:
//   - message.readByUserIds: if the old readAt was set, treat the message as
//     read by every active staff user (the original semantic was "the team has
//     marked this read"). Otherwise empty list. The old readAt field is
//     dropped from the row.
//   - conversation.starredByUserIds: previously-starred threads are pinned for
//     the saved currentUserId (the user who would have toggled it). Other
//     users get an empty pin list. The old starred boolean is dropped.
function migrateV29toV33(state) {
  const allActiveIds = (state.users || [])
    .filter((u) => u.status === 'active')
    .map((u) => u.id);
  const pinnerId = state.currentUserId || (state.users || [])[0]?.id || null;
  const messages = (state.messages || []).map((m) => {
    const { readAt, ...rest } = m;
    if (Array.isArray(rest.readByUserIds)) return rest;
    return { ...rest, readByUserIds: readAt ? [...allActiveIds] : [] };
  });
  const conversations = (state.conversations || []).map((c) => {
    const { starred, ...rest } = c;
    if (Array.isArray(rest.starredByUserIds)) return rest;
    return { ...rest, starredByUserIds: starred && pinnerId ? [pinnerId] : [] };
  });
  return { ...state, version: 33, messages, conversations };
}

// v28: Per-user notification preferences. Backfills DEFAULT_NOTIFICATION_PREFS
// onto every existing user, merging with any pre-existing prefs (so a manually-
// seeded fixture isn't clobbered). The reminders settings page was deleted at
// the same time, but its underlying state (reminderTemplates, reminderEvents)
// is preserved because the client-facing scheduler still uses it.
function migrateV27toV28(state) {
  const users = (state.users || []).map((u) => ({
    ...u,
    notificationPrefs: { ...V28_NOTIFICATION_PREFS, ...(u.notificationPrefs || {}) },
  }));
  return { ...state, version: 28, users };
}

// v27: Email System foundation — slot the system email-provider integration
// into company.integrations AND ensure connectedInboxes is a valid array.
// Additive — preserves any existing `email` block (so a manually-seeded test
// fixture isn't clobbered) and only inserts defaults where missing.
function migrateV26toV27(state) {
  const company = state.company || {};
  const integrations = company.integrations || {};
  const existingEmail = integrations.email;
  return {
    ...state,
    version: 27,
    company: {
      ...company,
      integrations: {
        ...integrations,
        email: existingEmail
          ? { ...DEFAULT_EMAIL_INTEGRATION, ...existingEmail, domain: { ...DEFAULT_EMAIL_INTEGRATION.domain, ...(existingEmail.domain || {}) } }
          : DEFAULT_EMAIL_INTEGRATION,
      },
    },
    connectedInboxes: Array.isArray(state.connectedInboxes) ? state.connectedInboxes : [],
  };
}

// v25: Drop hiddenForUserIds; require participantUserIds on internal threads.
// Backfill existing internal threads with the current set of active users so
// prior team threads stay visible to everyone (matching the pre-membership
// "public to all staff" behavior). DM threads already carry participantUserIds
// — leave them alone. External threads (sms/email) don't gate on membership.
function migrateV24toV25(state) {
  const allActiveIds = (state.users || [])
    .filter((u) => u.status === 'active')
    .map((u) => u.id);
  const conversations = (state.conversations || []).map((c) => {
    const { hiddenForUserIds, ...rest } = c;
    if (rest.channel !== 'internal') return rest;
    // Use the existing participantUserIds if a future build already populated them;
    // otherwise backfill with all active users.
    const existing = Array.isArray(rest.participantUserIds) ? rest.participantUserIds : [];
    return { ...rest, participantUserIds: existing.length ? existing : allActiveIds };
  });
  return { ...state, version: 25, conversations };
}

// v34: Nomenclature consolidation. Flip lifecycle 'customer' → 'client',
// rename notification pref newCustomerMessage → newClientMessage, and
// reconcile permissions against the live PERMISSIONS schema (refreshes
// labels like "View Accounts" → "View Clients" without touching role
// assignments).
function migrateV33toV34(state) {
  const contacts = (state.contacts || []).map((c) =>
    c.lifecycle === 'customer' ? { ...c, lifecycle: 'client' } : c
  );
  const users = (state.users || []).map((u) => {
    const prefs = u.notificationPrefs || {};
    const { newCustomerMessage, ...rest } = prefs;
    const next = {
      ...rest,
      newClientMessage:
        typeof rest.newClientMessage === 'boolean'
          ? rest.newClientMessage
          : (typeof newCustomerMessage === 'boolean' ? newCustomerMessage : true),
    };
    return { ...u, notificationPrefs: next };
  });
  const existingByKey = new Map((state.permissions || []).map((p) => [p.id, p]));
  const permissions = Object.entries(PERMISSIONS).map(([key, def]) => {
    const prev = existingByKey.get(key);
    return prev
      ? { id: key, label: def.label, roles: prev.roles }
      : { id: key, label: def.label, roles: [...def.defaultRoles] };
  });
  return { ...state, version: 34, contacts, users, permissions };
}

// v35: Heather Cole → Heather Warren rename on the seeded user. Real team
// member last name correction. Idempotent: only patches the matching record.
function migrateV34toV35(state) {
  const users = (state.users || []).map((u) => {
    if (u.email === 'heather@cleanspace.co' || u.name === 'Heather Cole') {
      return { ...u, name: 'Heather Warren', initials: 'HW' };
    }
    return u;
  });
  return { ...state, version: 35, users };
}

// v36: Brand domain rewrite + id-based Heather correction. Rewrites every
// @cleanspace.co email on user records and company.email to the full
// @cleanspaceonline.com domain. Heather's record (matched by stable
// seed id 'u_seed_heather') is force-corrected to "Heather Warren" / "HW"
// regardless of any stale name that survived the v35 string match.
function migrateV35toV36(state) {
  const rewriteDomain = (email) =>
    typeof email === 'string'
      ? email.replace(/@cleanspace\.co$/i, '@cleanspaceonline.com')
      : email;
  const users = (state.users || []).map((u) => {
    const next = { ...u, email: rewriteDomain(u.email) };
    if (u.id === 'u_seed_heather') {
      next.name = 'Heather Warren';
      next.initials = 'HW';
    }
    return next;
  });
  const company = state.company
    ? { ...state.company, email: rewriteDomain(state.company.email) }
    : state.company;
  return { ...state, version: 36, users, company };
}

// v37: Marketing module — additive. Slots in the five new top-level state
// arrays + settings object where missing (existing data is preserved if a
// fixture has them set). Reconciles the permissions list against the live
// PERMISSIONS schema so the three new marketing.* keys (marketing.view /
// .manage / .connectInbox) land with their default role assignments.
function migrateV36toV37(state) {
  const existingByKey = new Map((state.permissions || []).map((p) => [p.id, p]));
  const permissions = Object.entries(PERMISSIONS).map(([key, def]) => {
    const prev = existingByKey.get(key);
    return prev
      ? { id: key, label: def.label, roles: prev.roles }
      : { id: key, label: def.label, roles: [...def.defaultRoles] };
  });
  const existingSettings = state.marketingSettings && typeof state.marketingSettings === 'object'
    ? state.marketingSettings
    : null;
  const marketingSettings = existingSettings
    ? {
        ...DEFAULT_MARKETING_SETTINGS,
        ...existingSettings,
        replyRouting: {
          ...DEFAULT_MARKETING_SETTINGS.replyRouting,
          ...(existingSettings.replyRouting || {}),
        },
        defaultSendWindow: {
          ...DEFAULT_MARKETING_SETTINGS.defaultSendWindow,
          ...(existingSettings.defaultSendWindow || {}),
        },
      }
    : { ...DEFAULT_MARKETING_SETTINGS };
  return {
    ...state,
    version: 37,
    permissions,
    marketingInboxes:     Array.isArray(state.marketingInboxes)     ? state.marketingInboxes     : [],
    marketingSequences:   Array.isArray(state.marketingSequences)   ? state.marketingSequences   : [],
    marketingEnrollments: Array.isArray(state.marketingEnrollments) ? state.marketingEnrollments : [],
    marketingSends:       Array.isArray(state.marketingSends)       ? state.marketingSends       : [],
    marketingSettings,
  };
}

// v38: Marketing per-inbox send throttle. Adds `sendIntervalMinutes` to
// marketingSettings — the minimum minutes each rotation inbox waits between
// sends. Backfills the default (5) where the field is missing; no other
// slice is touched.
function migrateV37toV38(state) {
  const prev = state.marketingSettings && typeof state.marketingSettings === 'object'
    ? state.marketingSettings
    : DEFAULT_MARKETING_SETTINGS;
  return {
    ...state,
    version: 38,
    marketingSettings: {
      ...prev,
      sendIntervalMinutes:
        typeof prev.sendIntervalMinutes === 'number' ? prev.sendIntervalMinutes : 5,
    },
  };
}

// v39: Marketing Replies inbox. Adds the `marketingReplies` slice and two
// per-sequence fields: `haltOnReply` (default true) and `replyRouting`
// (copied from the global default in marketingSettings). Purely additive.
function migrateV38toV39(state) {
  const globalRouting =
    (state.marketingSettings && state.marketingSettings.replyRouting) ||
    { enabled: false, pipelineId: null, stageKey: null };
  const sequences = (state.marketingSequences || []).map((s) => ({
    ...s,
    haltOnReply: typeof s.haltOnReply === 'boolean' ? s.haltOnReply : true,
    replyRouting:
      s.replyRouting && typeof s.replyRouting === 'object'
        ? s.replyRouting
        : { ...globalRouting },
  }));
  return {
    ...state,
    version: 39,
    marketingReplies: Array.isArray(state.marketingReplies) ? state.marketingReplies : [],
    marketingSequences: sequences,
  };
}

// v40: Marketing reply tags. Backfills a per-sequence `replyTags` array
// (tags applied to a contact on reply) onto every existing sequence.
function migrateV39toV40(state) {
  const sequences = (state.marketingSequences || []).map((s) => ({
    ...s,
    replyTags: Array.isArray(s.replyTags) ? s.replyTags : [],
  }));
  return { ...state, version: 40, marketingSequences: sequences };
}

// v41: Per-inbox daily send cap. Backfills `dailySendLimit` (default 10 — the
// max emails an inbox sends per calendar day) onto every existing marketing
// inbox. Purely additive; no other slice is touched.
function migrateV40toV41(state) {
  const marketingInboxes = (state.marketingInboxes || []).map((i) => ({
    ...i,
    dailySendLimit: typeof i.dailySendLimit === 'number' ? i.dailySendLimit : 10,
  }));
  return { ...state, version: 41, marketingInboxes };
}

// v42: Per-inbox signature blocks + per-step attachments. Backfills
// `signature: ''` onto every marketing inbox and `attachments: []` onto every
// step of every sequence. Attachment blobs live in IndexedDB, so this only
// reconciles the metadata shape. Purely additive.
function migrateV41toV42(state) {
  const marketingInboxes = (state.marketingInboxes || []).map((i) => ({
    ...i,
    signature: typeof i.signature === 'string' ? i.signature : '',
  }));
  const marketingSequences = (state.marketingSequences || []).map((s) => ({
    ...s,
    steps: (s.steps || []).map((st) => ({
      ...st,
      attachments: Array.isArray(st.attachments) ? st.attachments : [],
    })),
  }));
  return { ...state, version: 42, marketingInboxes, marketingSequences };
}

// Compose v29 → v33 → v34 → v35 → v36 → v37 → v38 → v39 → v40 → v41 → v42 hops
// on top of any earlier migration chain. v29 is the last numbered shape change
// before v33 (intermediate v30/v31/v32 storage keys existed but never bumped
// state.version); v34 is the nomenclature consolidation; v35 is the
// Heather Warren rename; v36 rewrites the brand domain + force-corrects
// Heather by id; v37 adds the Marketing module slots; v38 adds the
// per-inbox send throttle; v39 adds the Marketing Replies inbox; v40 adds
// per-sequence reply tags; v41 adds the per-inbox daily send cap; v42 adds
// per-inbox signatures + per-step attachments. Covers all stored states from
// v17 through v41.
// v43: Master Pipeline. Injects the special, un-deletable Master Pipeline at
// the front of state.pipelines — its columns are the OTHER pipelines, so it
// carries no stored stages — and makes it the active pipeline. Contacts are
// routed into its "New Leads" intake (pipelineId = master, stage = 'intake')
// when they are leads with no pipeline, OR when their pipelineId no longer
// resolves to a real pipeline (repairs contacts long-orphaned against the
// never-created 'pl_seed_default').
function migrateV42toV43(state) {
  const existingMaster = (state.pipelines || []).find((p) => p.isMaster);
  const masterId = existingMaster ? existingMaster.id : 'pl_seed_master';
  const pipelines = existingMaster
    ? state.pipelines
    : [
        {
          id: masterId,
          label: 'Master Pipeline',
          isMaster: true,
          createdAt: new Date().toISOString(),
          stages: [],
        },
        ...(state.pipelines || []),
      ];
  const knownPipelineIds = new Set(pipelines.map((p) => p.id));
  const contacts = (state.contacts || []).map((c) => {
    const orphaned = c.pipelineId && !knownPipelineIds.has(c.pipelineId);
    const unroutedLead = c.lifecycle === 'lead' && !c.pipelineId && !c.stage;
    if (orphaned || unroutedLead) {
      return { ...c, pipelineId: masterId, stage: 'intake' };
    }
    return c;
  });
  return { ...state, version: 43, pipelines, activePipelineId: masterId, contacts };
}

// v44: Editable Master Pipeline columns. The Master Pipeline's `stages` now
// stores which pipelines appear as its board columns — an ordered list of
// { pipelineId } references (previously always empty; columns were auto-derived
// from all non-master pipelines). The migration backfills it with every
// existing non-master pipeline so the board is unchanged until the user
// curates it via Manage Columns.
function migrateV43toV44(state) {
  const pipelines = (state.pipelines || []).map((p) => {
    if (!p.isMaster) return p;
    if (Array.isArray(p.stages) && p.stages.length > 0) return p;
    const cols = (state.pipelines || [])
      .filter((x) => !x.isMaster)
      .map((x) => ({ pipelineId: x.id }));
    return { ...p, stages: cols };
  });
  return { ...state, version: 44, pipelines };
}

// v45: Per-sequence "Notify on reply" config. Adds `notifyOnReplyUserId` (null)
// and `notifyOnReplyChannels` ({ inApp: false }) to every existing marketing
// sequence so the editor's new picker + toggle have a defined shape to bind to.
// Purely additive — existing replyRouting / replyTags / haltOnReply untouched.
function migrateV44toV45(state) {
  const marketingSequences = (state.marketingSequences || []).map((s) => ({
    ...s,
    notifyOnReplyUserId:
      typeof s.notifyOnReplyUserId === 'string' && s.notifyOnReplyUserId
        ? s.notifyOnReplyUserId
        : null,
    notifyOnReplyChannels: {
      inApp: s.notifyOnReplyChannels?.inApp === true,
    },
  }));
  return { ...state, version: 45, marketingSequences };
}

function migrateV45toV46(state) {
  // Backfill per-user email signature prefs (text + optional image; auto-add on).
  //
  // SPREAD FIRST, then default. The original rebuilt this object from a fixed three-field
  // list, which drops any prefs field added after it was written (imageWidth, and C07's
  // imagePath). Harmless in practice — a state still at v45 predates both fields, so
  // there is nothing to drop — but it is the same field-by-field rebuild that made
  // selectSignaturePrefs silently delete a real imagePath, and this migration would
  // become a data-loss step the moment the assumption stopped holding.
  const users = (state.users || []).map((u) => ({
    ...u,
    signaturePrefs: {
      ...(u.signaturePrefs || {}),
      enabled: u.signaturePrefs?.enabled ?? true,
      text: u.signaturePrefs?.text ?? '',
      imageDataUrl: u.signaturePrefs?.imageDataUrl ?? null,
    },
  }));
  return { ...state, version: 46, users };
}

// v47: Multi-Workspace OAuth registry. Adds the `oauthWorkspaces` slice and
// attributes every existing connected inbox to a Workspace via `workspaceId`.
// If a stored state already has connected inboxes but no registry, we synthesize
// a single "Primary Workspace" (the legacy single env OAuth app) so existing
// connections have a home and nothing is orphaned. Purely additive.
function migrateV46toV47(state) {
  const existing = Array.isArray(state.oauthWorkspaces) ? state.oauthWorkspaces : [];
  const inboxes = Array.isArray(state.connectedInboxes) ? state.connectedInboxes : [];
  let oauthWorkspaces = existing;
  let primaryId = existing.find((w) => w.isPrimary)?.id || existing[0]?.id || null;
  if (existing.length === 0 && inboxes.length > 0) {
    primaryId = 'ws_primary';
    oauthWorkspaces = [{
      id: primaryId,
      label: 'Primary Workspace',
      domains: [],
      clientId: null,
      clientSecretLast4: null,
      status: 'active',
      isPrimary: true,
      connectedAt: new Date().toISOString(),
      lastError: null,
    }];
  }
  const connectedInboxes = inboxes.map((i) => ({
    ...i,
    workspaceId: i.workspaceId || primaryId || null,
  }));
  return { ...state, version: 47, oauthWorkspaces, connectedInboxes };
}

// v48: Marketing suppression list (CAN-SPAM opt-out). Additive — adds the
// `marketingSuppressions` array so unsubscribed / opted-out emails are honored
// as a hard gate in the send + enrollment walks. Existing rows are untouched.
function migrateV47toV48(state) {
  const ms = state.marketingSettings || {};
  return {
    ...state,
    version: 48,
    marketingSuppressions: Array.isArray(state.marketingSuppressions) ? state.marketingSuppressions : [],
    marketingSettings: {
      ...ms,
      unsubscribe: {
        enabled: true,
        message: 'Not interested? {unsubscribe} from these emails.',
        linkText: 'Unsubscribe',
        includeAddress: true,
        address: '',
        baseUrl: '',
        ...(ms.unsubscribe || {}),
      },
    },
  };
}

// Mirrors seed.js opsSettings. Spread UNDER the stored value so an operator's tuned
// setting always wins and only genuinely-missing keys are filled. Declared before its
// only consumer so the reference can never sit in a temporal dead zone.
const OPS_SETTINGS_V49_DEFAULTS = {
  defaultGeofenceRadiusM: 76,
  autoCloseGraceMins: 120,
  offlineReplayWindowHours: 12,
  varianceFlagOverMins: 15,
  varianceFlagUnderMins: 15,
  expectedBasis: 'labor',
  attributionModel: 'per_cleaner',
  // NO keyOverdueDays — the key return window was removed 2026-07-22. A v48 blob
  // that still carries one keeps it as inert residue; nothing reads it.
};

// v48 → v49. THE MISSING HOP: seed.js is at version 49 and STORAGE_KEY is
// 'pp.store.v49', but this function did not exist — so loadState() could never return
// anything above 48, the v49 fast path (which tested `=== 48`) never matched a
// correctly-versioned blob, and LOCAL/DEMO PERSISTENCE WAS DEAD: every load fell
// through to a reseed. Silent, because a reseed looks like a working app with fresh
// data. Any later bump (C07's v49 → v50) would have landed on top of a chain that
// already could not reach its own current version, and shipped inert.
//
// Everything v49 added over v48 is ADDITIVE and DEFAULT-SAFE — the seed says so
// itself ("Additive default-safe slices, NO store-version bump ... readers must
// default"). So this fills defaults for anything a v48 blob lacks and never
// transforms existing data. `??` rather than `||` so a legitimately empty array or a
// deliberate `null` (financialSnapshot) is preserved rather than overwritten.
function migrateV48toV49(state) {
  const s = state || {};
  return {
    ...s,
    version: 49,
    quotes: Array.isArray(s.quotes) ? s.quotes : [],
    syncedPayments: Array.isArray(s.syncedPayments) ? s.syncedPayments : [],
    financialSnapshot: s.financialSnapshot ?? null,
    oauthWorkspaces: Array.isArray(s.oauthWorkspaces) ? s.oauthWorkspaces : [],
    // NB: v49 originally seeded a `complaints: []` default here. Complaints were later
    // folded into Work Orders (type:complaint, relational) and the blob slice retired, so
    // this migration no longer reintroduces it — a stale `complaints` array on an old blob
    // is inert (no reader). See selectors.selectComplaintKpisFromWorkOrders.
    reviews: s.reviews && typeof s.reviews === 'object' ? s.reviews : { indeedActual: 0 },
    // Swept-replacement slices: relational truth lives in Supabase, these are the
    // blob-side defaults readers fall back to (CLEANSPACE_SWEPT.md §2.3).
    inspectionTemplates: Array.isArray(s.inspectionTemplates) ? s.inspectionTemplates : [],
    checklistTemplates: Array.isArray(s.checklistTemplates) ? s.checklistTemplates : [],
    accountMedia: Array.isArray(s.accountMedia) ? s.accountMedia : [],
    inspectionFollowUps: Array.isArray(s.inspectionFollowUps) ? s.inspectionFollowUps : [],
    opsSettings: { ...OPS_SETTINGS_V49_DEFAULTS, ...(s.opsSettings || {}) },
  };
}

// v50: Opportunity entity + a single Master pipeline. Deals used to be per-person
// fields on contacts (stage/pipelineId/dealValue/expectedCloseDate/stageChangedAt);
// they become company-owned Opportunity records. The 1.1/1.2/1.3 placeholder
// pipelines are removed and Master gains real sales stages; stale stage keys map
// onto them. The old 1.3 "Clients" retention stages were never deals, so contacts
// parked there get NO opportunity (they are simply active customers). A structural
// transform (NOT additive), so `test-persist-chain` treats this hop specially.
const V50_MASTER_STAGES = [
  { id: 'ps_seed_new-lead',    key: 'new-lead',    label: 'New Lead' },
  { id: 'ps_seed_contacted',   key: 'contacted',   label: 'Contacted' },
  { id: 'ps_seed_walkthrough', key: 'walkthrough', label: 'Walkthrough Scheduled' },
  { id: 'ps_seed_proposal',    key: 'proposal',    label: 'Proposal Sent' },
  { id: 'ps_seed_negotiation', key: 'negotiation', label: 'Negotiation' },
  { id: 'ps_seed_won',         key: 'won',         label: 'Won' },
  { id: 'ps_seed_lost',        key: 'lost',        label: 'Lost' },
];
const V50_RETENTION_STAGES = new Set([
  'new-client', 'launch-sequence', 'check-in-1m', 'check-in-3m', 'check-in-6m', 'check-in-12m', 'canceled-client',
]);
const V50_STAGE_MAP = {
  'new-lead': 'new-lead', 'contact-info': 'new-lead', 'intake': 'new-lead',
  'day-1': 'contacted', 'day-2': 'contacted', 'day-3': 'contacted', 'day-4': 'contacted',
  'day-5': 'contacted', 'day-6': 'contacted', 'day-7': 'contacted', 'actively-working': 'contacted',
  'sales-campaign': 'contacted', 'nurture-campaign': 'contacted',
  'walkthrough': 'walkthrough', 'walkthrough-scheduled': 'walkthrough',
  'estimate-ghl': 'proposal', 'estimate-phone': 'proposal',
  'no-reply-1': 'negotiation', 'no-reply-2': 'negotiation', 'no-reply-3': 'negotiation', 'ghosted': 'negotiation',
  'follow-up-1w': 'negotiation', 'follow-up-2w': 'negotiation', 'follow-up-1m': 'negotiation',
  'follow-up-2m': 'negotiation', 'follow-up-3m': 'negotiation', 'follow-up-4m': 'negotiation',
  'follow-up-5m': 'negotiation', 'follow-up-6m': 'negotiation',
  'won': 'won', 'lost': 'lost', 'closed-lead': 'lost', 'not-interested': 'lost',
};
function migrateV49toV50(state) {
  const s = state || {};
  const masterSrc = (s.pipelines || []).find((p) => p.isMaster);
  const masterId = masterSrc?.id || 'pl_seed_master';
  const migratedOpps = [];
  const contacts = (s.contacts || []).map((c) => {
    const { stage, pipelineId, dealValue, expectedCloseDate, stageChangedAt, ...rest } = c;
    if (stage && !V50_RETENTION_STAGES.has(stage) && rest.companyId) {
      migratedOpps.push({
        id: `opp_mig_${rest.id}`,
        clientId: rest.companyId,
        primaryContactId: rest.id,
        title: '',
        value: dealValue ?? null,
        expectedCloseDate: expectedCloseDate ?? null,
        pipelineId: masterId,
        stage: V50_STAGE_MAP[stage] || 'new-lead',
        status: stage === 'won' ? 'won'
          : (stage === 'lost' || stage === 'closed-lead' || stage === 'not-interested') ? 'lost' : 'open',
        stageChangedAt: stageChangedAt ?? null,
        createdAt: rest.createdAt ?? null,
        updatedAt: rest.updatedAt ?? null,
      });
    }
    return rest; // contact minus the five legacy pipeline/deal fields
  });
  return {
    ...s,
    version: 50,
    pipelines: [{ id: masterId, label: 'Master Pipeline', isMaster: true, createdAt: masterSrc?.createdAt ?? null, stages: V50_MASTER_STAGES }],
    activePipelineId: masterId,
    contacts,
    opportunities: Array.isArray(s.opportunities) ? s.opportunities : migratedOpps,
  };
}

// v50 → v51: assignable contact roles. Adds the company-level `billingContactId`
// (mirroring `primaryContactId`) so the Contacts-tab Roles column has a defined shape
// to bind to. Purely additive + default-safe: a client keeps any value it already has;
// `?? c.primaryContactId ?? null` fills the default and preserves a deliberate null.
// (The Site role is NOT a company FK — it reads the location's `siteContactId`. The
// vestigial `client.siteContactId` backfill was removed 2026-09-13; nothing reads it,
// so any lingering value on an old blob is harmless.)
function migrateV50toV51(state) {
  const s = state || {};
  const clients = (s.clients || []).map((c) => ({
    ...c,
    billingContactId: c.billingContactId ?? c.primaryContactId ?? null,
  }));
  return { ...s, version: 51, clients };
}

// v51 → v52: Every key belongs to a site. Strips any key with a null/absent siteId
// (the retired "company-wide / not tied to a building" bucket) plus any key event that
// referenced a dropped key. Data-stripping transform; lockstep with STORAGE_KEY
// (pp.store.v52) and INITIAL_STATE.version.
function migrateV51toV52(state) {
  const s = state || {};
  const keys = (s.keys || []).filter((k) => k.siteId);
  const keptKeyIds = new Set(keys.map((k) => k.id));
  const keyEvents = (s.keyEvents || []).filter((e) => keptKeyIds.has(e.keyId));
  return { ...s, version: 52, keys, keyEvents };
}

// v52 → v53: One location per customer. The transform lives in lib/location.js
// (collapseToSingleLocationV53 — pure, idempotent, and reused by the go-live
// server-side data-op); this hop wires it into the store migration chain. Lockstep
// with STORAGE_KEY (pp.store.v53) and INITIAL_STATE.version.
export function migrateV52toV53(state) {
  return collapseToSingleLocationV53(state);
}

// v53 → v54: Persona rename correction. The seed's Super Admin was renamed
// Marcus Alvarez → Matt Giunco (S35), but that shipped as a plain seed edit with NO
// migration — so any browser seeded before it keeps showing "Marcus Alvarez" as the
// Super Admin forever (a v53 blob is returned as-is by loadStateInner). This
// force-corrects the owner record BY STABLE ID (u_seed_kyler), exactly like the
// Heather rename did in v35/v36, so every returning browser lands on the current name
// with NO data loss. Idempotent — a record already named Matt Giunco is untouched, and
// any OTHER user (incl. client-added ones) is left alone. Lockstep with STORAGE_KEY
// (pp.store.v54) and INITIAL_STATE.version.
export function migrateV53toV54(state) {
  const s = state || {};
  return { ...s, version: 54, users: correctOwnerIdentity(s.users) };
}

// v55: register the schedule.reset permission so its Roles-matrix toggle is
// EDITABLE on already-persisted accounts (not merely enforced via the schema
// fallback). Reconciles state.permissions against the current PERMISSIONS schema —
// preserves every existing role assignment, adds any new key from its defaultRoles,
// drops keys no longer in the schema. Lockstep with STORAGE_KEY (pp.store.v55) and
// INITIAL_STATE.version.
export function migrateV54toV55(state) {
  const s = state || {};
  const existingByKey = new Map((s.permissions || []).map((p) => [p.id, p]));
  const permissions = Object.entries(PERMISSIONS).map(([key, def]) => {
    const prev = existingByKey.get(key);
    return prev
      ? { id: key, label: def.label, roles: prev.roles }
      : { id: key, label: def.label, roles: [...def.defaultRoles] };
  });
  return { ...s, version: 55, permissions };
}

// v56: unify the tag vocabulary — a clean's / location's tags were stored under
// `labelIds` (and surfaced as "Labels"), while customers used `tagIds` ("Tags"). Same
// Tag entity throughout, so rename the field: jobs.labelIds → jobs.tagIds and
// sites.labelIds → sites.tagIds. Idempotent (drops labelIds, keeps a pre-existing
// tagIds if somehow present). Lockstep with STORAGE_KEY (pp.store.v56) and
// INITIAL_STATE.version. NOTE: this runs in local/demo mode only; if the Supabase
// backend is ever activated, the same rename needs a one-time data-op on public.jobs.
export function migrateV55toV56(state) {
  const s = state || {};
  const renameTagField = (arr) => (Array.isArray(arr) ? arr : []).map((o) => {
    if (o && 'labelIds' in o) {
      const { labelIds, ...rest } = o;
      return { ...rest, tagIds: Array.isArray(rest.tagIds) ? rest.tagIds : (labelIds || []) };
    }
    return o;
  });
  return { ...s, version: 56, jobs: renameTagField(s.jobs), sites: renameTagField(s.sites) };
}

// v57: retire the location-wide DEFAULT checklist (R3, Daniel 2026-09-27). A checklist
// belongs to named cleaners at one location; "no checklist" is a normal state (R1). The
// transform lives in lib/crewChecklist.js (retireLocationDefaultsV57 — pure, idempotent,
// and shared with the live data-op app/scripts/dataop-checklist-default.mjs, exactly as
// collapseToSingleLocationV53 is shared), so demo and production convert identically:
// a saved `clients[].checklistTemplateId` becomes an explicit pick for every cleaner on
// that location's upcoming / in-progress cleans who has none, and then the field is
// DELETED. A cleaner's own pick is never overwritten. Lockstep with STORAGE_KEY
// (pp.store.v57) and INITIAL_STATE.version. NOTE: this runs in local/demo mode only —
// the live blob is converted by that data-op, on the owner's go.
export function migrateV56toV57(state) {
  const s = state || {};
  const { clients } = retireLocationDefaultsV57({ clients: s.clients || [], jobs: s.jobs || [] });
  return { ...s, version: 57, clients };
}

const toLatest = (s) => migrateV42toV43(migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(migrateV37toV38(migrateV36toV37(migrateV35toV36(migrateV34toV35(migrateV33toV34(migrateV29toV33(migrateV28toV29(s))))))))))));

function loadStateInner() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Accept BOTH: 49 (correct) and 48 (what actually sits under this key today —
      // the chain could not reach 49, so the app ran at 48 and saved 48 under the v49
      // key). Testing `=== 48` alone was the second half of the bug: a
      // correctly-versioned blob was REJECTED and fell through to a reseed.
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 57) return parsed;
        if (parsed.version === 56) return migrateV56toV57(parsed);
        if (parsed.version === 55) return migrateV56toV57(migrateV55toV56(parsed));
        if (parsed.version === 54) return migrateV56toV57(migrateV55toV56(migrateV54toV55(parsed)));
        if (parsed.version === 53) return migrateV56toV57(migrateV55toV56(migrateV54toV55(migrateV53toV54(parsed))));
        if (parsed.version === 52) return migrateV56toV57(migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(parsed)))));
        if (parsed.version === 51) return migrateV56toV57(migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(parsed))))));
        if (parsed.version === 50) return migrateV56toV57(migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(parsed)))))));
        if (parsed.version === 49) return migrateV56toV57(migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(parsed))))))));
        if (parsed.version === 48) return migrateV56toV57(migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(migrateV48toV49(parsed)))))))));
      }
    }
    // v56 direct accept: the PREVIOUS storage key (pp.store.v56 — the version this build
    // shipped before). An existing install has its data there, not yet under v57 — read it
    // and let the loadState() tail run v56 → v57 (the location default becomes per-cleaner
    // picks, then goes).
    const v56Raw = window.localStorage.getItem('pp.store.v56');
    if (v56Raw) {
      const parsed = JSON.parse(v56Raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 56) return parsed;
        if (parsed.version === 55) return migrateV55toV56(parsed);
        if (parsed.version === 54) return migrateV55toV56(migrateV54toV55(parsed));
        if (parsed.version === 53) return migrateV55toV56(migrateV54toV55(migrateV53toV54(parsed)));
        if (parsed.version === 52) return migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(parsed))));
        if (parsed.version === 51) return migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(parsed)))));
        if (parsed.version === 50) return migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(parsed))))));
        if (parsed.version === 49) return migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(parsed)))))));
        if (parsed.version === 48) return migrateV55toV56(migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(migrateV48toV49(parsed))))))));
      }
    }
    // v55 direct accept: an older storage key (pp.store.v55). An existing install has its
    // data there, not yet under v56/v57 — read it and let the loadState() tail run
    // v55 → v56 → v57 (jobs/sites labelIds → tagIds; then the location default retires).
    const v55Raw = window.localStorage.getItem('pp.store.v55');
    if (v55Raw) {
      const parsed = JSON.parse(v55Raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 55) return parsed;
        if (parsed.version === 54) return migrateV54toV55(parsed);
        if (parsed.version === 53) return migrateV54toV55(migrateV53toV54(parsed));
        if (parsed.version === 52) return migrateV54toV55(migrateV53toV54(migrateV52toV53(parsed)));
        if (parsed.version === 51) return migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(parsed))));
        if (parsed.version === 50) return migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(parsed)))));
        if (parsed.version === 49) return migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(parsed))))));
        if (parsed.version === 48) return migrateV54toV55(migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(migrateV48toV49(parsed)))))));
      }
    }
    // v54 direct accept: an older storage key (pp.store.v54). An existing install has its
    // data there, not yet under v55/v56 — read it and let the loadState() tail run
    // v54 → v55 → v56 (schedule.reset seeds into permissions; then labelIds → tagIds).
    const v54Raw = window.localStorage.getItem('pp.store.v54');
    if (v54Raw) {
      const parsed = JSON.parse(v54Raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 53) return migrateV53toV54(parsed);
        if (parsed.version === 52) return migrateV53toV54(migrateV52toV53(parsed));
        if (parsed.version === 51) return migrateV53toV54(migrateV52toV53(migrateV51toV52(parsed)));
        if (parsed.version === 50) return migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(parsed))));
        if (parsed.version === 49) return migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(parsed)))));
        if (parsed.version === 48) return migrateV53toV54(migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(migrateV48toV49(parsed))))));
        return parsed; // version 54; tail runs 54 → 55
      }
    }
    // v53 direct accept: the previous storage key. The loadState() tail runs v53 → v54.
    const v53Raw = window.localStorage.getItem('pp.store.v53');
    if (v53Raw) {
      const parsed = JSON.parse(v53Raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 52) return migrateV52toV53(parsed);
        if (parsed.version === 51) return migrateV52toV53(migrateV51toV52(parsed));
        if (parsed.version === 50) return migrateV52toV53(migrateV51toV52(migrateV50toV51(parsed)));
        if (parsed.version === 49) return migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(parsed))));
        if (parsed.version === 48) return migrateV52toV53(migrateV51toV52(migrateV50toV51(migrateV49toV50(migrateV48toV49(parsed)))));
        return parsed; // version 53; tail runs 53 → 54
      }
    }
    // v52 direct accept: a prior storage key. The loadState() tail runs v52 → v54.
    const v52Raw = window.localStorage.getItem('pp.store.v52');
    if (v52Raw) {
      const parsed = JSON.parse(v52Raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 51) return migrateV51toV52(parsed);
        if (parsed.version === 50) return migrateV51toV52(migrateV50toV51(parsed));
        if (parsed.version === 49) return migrateV51toV52(migrateV50toV51(migrateV49toV50(parsed)));
        if (parsed.version === 48) return migrateV51toV52(migrateV50toV51(migrateV49toV50(migrateV48toV49(parsed))));
        return parsed; // version 52; tail runs 52 → 53
      }
    }
    // v51 direct accept: the previous storage key. The loadState() tail runs v51 → v52.
    const v51Raw = window.localStorage.getItem('pp.store.v51');
    if (v51Raw) {
      const parsed = JSON.parse(v51Raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 50) return migrateV50toV51(parsed);
        if (parsed.version === 49) return migrateV50toV51(migrateV49toV50(parsed));
        if (parsed.version === 48) return migrateV50toV51(migrateV49toV50(migrateV48toV49(parsed)));
        return parsed; // version 51; tail runs 51 → 52
      }
    }
    // v50 direct accept: the previous storage key. The loadState() tail runs v50 → v51.
    const v50Raw = window.localStorage.getItem('pp.store.v50');
    if (v50Raw) {
      const parsed = JSON.parse(v50Raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    // v49 direct accept: the previous storage key. The loadState() tail runs v49 -> v50
    // (a v48 blob that sat under the v49 key first goes 48 -> 49 here, then the tail).
    const v49Raw = window.localStorage.getItem('pp.store.v49');
    if (v49Raw) {
      const parsed = JSON.parse(v49Raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.version === 48) return migrateV48toV49(parsed);
        return parsed;
      }
    }
    // v47 direct accept: previous storage key. The loadState() tail runs v47 → v48.
    const v47Raw = window.localStorage.getItem('pp.store.v47');
    if (v47Raw) {
      const parsed = JSON.parse(v47Raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    // v46 direct accept: previous storage key. The loadState() tail runs v46 → v47.
    const v46Raw = window.localStorage.getItem('pp.store.v46');
    if (v46Raw) {
      const parsed = JSON.parse(v46Raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    // v45 direct accept: previous storage key. The loadState() tail runs v45 → v46.
    const v45Raw = window.localStorage.getItem('pp.store.v45');
    if (v45Raw) {
      const parsed = JSON.parse(v45Raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    // v44 direct accept: previous storage key. Run v44 → v45 (tail finishes → v46).
    const v44Raw = window.localStorage.getItem('pp.store.v44');
    if (v44Raw) {
      const parsed = JSON.parse(v44Raw);
      if (parsed && typeof parsed === 'object') return migrateV44toV45(parsed);
    }
    // v43 direct accept: previous storage key. Run v43 → v45.
    const v43Raw = window.localStorage.getItem('pp.store.v43');
    if (v43Raw) {
      const parsed = JSON.parse(v43Raw);
      if (parsed && typeof parsed === 'object') return migrateV44toV45(migrateV43toV44(parsed));
    }
    // v42 direct accept: previous storage key. Run v42 → v43.
    const v42Raw = window.localStorage.getItem('pp.store.v42');
    if (v42Raw) {
      const parsed = JSON.parse(v42Raw);
      if (parsed && typeof parsed === 'object') return migrateV42toV43(parsed);
    }
    // v41 direct accept: previous storage key. Run v41 → v42.
    const v41Raw = window.localStorage.getItem('pp.store.v41');
    if (v41Raw) {
      const parsed = JSON.parse(v41Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(parsed);
    }
    // v40 direct accept: previous storage key. Run v40 → v42.
    const v40Raw = window.localStorage.getItem('pp.store.v40');
    if (v40Raw) {
      const parsed = JSON.parse(v40Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(parsed));
    }
    // v39 direct accept: previous storage key. Run v39 → v42.
    const v39Raw = window.localStorage.getItem('pp.store.v39');
    if (v39Raw) {
      const parsed = JSON.parse(v39Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(parsed)));
    }
    // v38 direct accept: previous storage key. Run v38 → v42.
    const v38Raw = window.localStorage.getItem('pp.store.v38');
    if (v38Raw) {
      const parsed = JSON.parse(v38Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(parsed))));
    }
    // v37 direct accept: previous storage key. Run v37 → v42.
    const v37Raw = window.localStorage.getItem('pp.store.v37');
    if (v37Raw) {
      const parsed = JSON.parse(v37Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(migrateV37toV38(parsed)))));
    }
    // v36 direct accept: previous storage key. Run v36 → v42.
    const v36Raw = window.localStorage.getItem('pp.store.v36');
    if (v36Raw) {
      const parsed = JSON.parse(v36Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(migrateV37toV38(migrateV36toV37(parsed))))));
    }
    // v35 direct accept: previous storage key. Run v35 → v42.
    const v35Raw = window.localStorage.getItem('pp.store.v35');
    if (v35Raw) {
      const parsed = JSON.parse(v35Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(migrateV37toV38(migrateV36toV37(migrateV35toV36(parsed)))))));
    }
    // v34 direct accept: previous storage key. Run v34 → v42.
    const v34Raw = window.localStorage.getItem('pp.store.v34');
    if (v34Raw) {
      const parsed = JSON.parse(v34Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(migrateV37toV38(migrateV36toV37(migrateV35toV36(migrateV34toV35(parsed))))))));
    }
    // v33 direct accept: previous storage key. Run v33 → v42.
    const v33Raw = window.localStorage.getItem('pp.store.v33');
    if (v33Raw) {
      const parsed = JSON.parse(v33Raw);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(migrateV37toV38(migrateV36toV37(migrateV35toV36(migrateV34toV35(migrateV33toV34(parsed)))))))));
    }
    // Stale-key direct accepts: prior storage keys (v28-v32) parked here as
    // version=29-shaped data. Run v29→v33→v34→v35→v36→v37→v38→v39→v40→v41→v42.
    for (const key of ['pp.store.v32', 'pp.store.v31', 'pp.store.v30', 'pp.store.v29']) {
      const r = window.localStorage.getItem(key);
      if (!r) continue;
      const parsed = JSON.parse(r);
      if (parsed && typeof parsed === 'object') return migrateV41toV42(migrateV40toV41(migrateV39toV40(migrateV38toV39(migrateV37toV38(migrateV36toV37(migrateV35toV36(migrateV34toV35(migrateV33toV34(migrateV29toV33(parsed))))))))));
    }
    // Attempt v28 → v29 → v33 → v34 → v35 → v36 → v37 migration
    const v28Raw = window.localStorage.getItem('pp.store.v28');
    if (v28Raw) {
      const v28 = JSON.parse(v28Raw);
      if (v28 && typeof v28 === 'object' && v28.version === 28) return toLatest(v28);
    }
    // Attempt v27 → v28 → ... → v37 migration chain
    const v27Raw = window.localStorage.getItem('pp.store.v27');
    if (v27Raw) {
      const v27 = JSON.parse(v27Raw);
      if (v27 && typeof v27 === 'object' && v27.version === 27) return toLatest(migrateV27toV28(v27));
    }
    // Attempt v26 → v27 → ... → v37 migration chain
    const v26Raw = window.localStorage.getItem('pp.store.v26');
    if (v26Raw) {
      const v26 = JSON.parse(v26Raw);
      if (v26 && typeof v26 === 'object' && v26.version === 26) return toLatest(migrateV27toV28(migrateV26toV27(v26)));
    }
    // Attempt v25 → v26 → ... → v37 migration chain
    const v25Raw = window.localStorage.getItem('pp.store.v25');
    if (v25Raw) {
      const v25 = JSON.parse(v25Raw);
      if (v25 && typeof v25 === 'object' && v25.version === 25) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(v25))));
    }
    // Attempt v24 → v25 → ... → v37 migration chain
    const v24Raw = window.localStorage.getItem('pp.store.v24');
    if (v24Raw) {
      const v24 = JSON.parse(v24Raw);
      if (v24 && typeof v24 === 'object' && v24.version === 24) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(v24)))));
    }
    // Attempt v23 → v24 → ... → v37 migration chain
    const v23Raw = window.localStorage.getItem('pp.store.v23');
    if (v23Raw) {
      const v23 = JSON.parse(v23Raw);
      if (v23 && typeof v23 === 'object' && v23.version === 23) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(v23))))));
    }
    // Attempt v22 → v23 → ... → v37 migration chain
    const v22Raw = window.localStorage.getItem('pp.store.v22');
    if (v22Raw) {
      const v22 = JSON.parse(v22Raw);
      if (v22 && typeof v22 === 'object' && v22.version === 22) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(v22)))))));
    }
    // Attempt v21 → ... → v37 migration chain
    const v21Raw = window.localStorage.getItem('pp.store.v21');
    if (v21Raw) {
      const v21 = JSON.parse(v21Raw);
      if (v21 && typeof v21 === 'object' && v21.version === 21) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(v21))))))));
    }
    // Attempt v20 → ... → v37 migration chain
    const v20Raw = window.localStorage.getItem('pp.store.v20');
    if (v20Raw) {
      const v20 = JSON.parse(v20Raw);
      if (v20 && typeof v20 === 'object' && v20.version === 20) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(migrateV20toV21(v20)))))))));
    }
    // Attempt v19 → ... → v37 migration chain
    const v19Raw = window.localStorage.getItem('pp.store.v19');
    if (v19Raw) {
      const v19 = JSON.parse(v19Raw);
      if (v19 && typeof v19 === 'object' && v19.version === 19) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(migrateV20toV21(migrateV19toV20(v19))))))))));
    }
    // Attempt v18 → ... → v37 migration chain
    const v18Raw = window.localStorage.getItem('pp.store.v18');
    if (v18Raw) {
      const v18 = JSON.parse(v18Raw);
      if (v18 && typeof v18 === 'object' && v18.version === 18) {
        return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(migrateV20toV21(migrateV19toV20(migrateV18toV19(v18)))))))))));
      }
    }
    // Attempt v17 → ... → v37 migration chain
    const v17Raw = window.localStorage.getItem('pp.store.v17');
    if (v17Raw) {
      const v17 = JSON.parse(v17Raw);
      if (v17 && typeof v17 === 'object' && v17.version === 17) {
        return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(migrateV20toV21(migrateV19toV20(migrateV18toV19(migrateV17toV18(v17))))))))))));
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Legacy direct-accept chains return states below the current version; the
// remaining hops are applied here so anything that comes back lands fully
// migrated before the store consumes it.
export function loadState() {
  const s = loadStateInner();
  if (!s || typeof s !== 'object') return null;
  let st = s;
  if (st.version === 42) st = migrateV42toV43(st);
  if (st.version === 43) st = migrateV43toV44(st);
  if (st.version === 44) st = migrateV44toV45(st);
  if (st.version === 45) st = migrateV45toV46(st);
  if (st.version === 46) st = migrateV46toV47(st);
  if (st.version === 47) st = migrateV47toV48(st);
  if (st.version === 48) st = migrateV48toV49(st);
  if (st.version === 49) st = migrateV49toV50(st);
  if (st.version === 50) st = migrateV50toV51(st);
  if (st.version === 51) st = migrateV51toV52(st);
  if (st.version === 52) st = migrateV52toV53(st);
  if (st.version === 53) st = migrateV53toV54(st);
  if (st.version === 54) st = migrateV54toV55(st);
  if (st.version === 55) st = migrateV55toV56(st);
  if (st.version === 56) st = migrateV56toV57(st);
  return st;
}

// Warned ONCE, then silent. Dropping the save is the right behaviour — quota pressure
// or private mode must never break the app — but doing it with no signal at all meant
// "local persistence is working" and "local persistence has been dead all session"
// looked identical, which is exactly how the broken v48→v49 chain survived unnoticed.
// One warning per session: this is on a debounced save path, so warning every time
// would flood the console and get muted.
let warnedSaveFailed = false;

export function saveState(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    if (!warnedSaveFailed) {
      warnedSaveFailed = true;
      console.warn(`[persist] localStorage save failed. Local state will NOT survive a reload this session (${e?.name || 'error'}). Usually quota pressure or private mode.`);
    }
  }
}

export function clearState() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
