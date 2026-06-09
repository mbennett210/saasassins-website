// v37: Shell baseline rebrand to PolishPoint. Company entity + team-user
// roster genericized to placeholder identities, brand strings swapped,
// theme switched to PolishPoint Blue. No state-shape change — the storage-key
// bump (pp.store.v36 → pp.store.v37) is intentional and orphans any pre-rebrand
// localStorage so the next load reseeds cleanly from INITIAL_STATE. No
// migration function needed; the key bump IS the migration.
//
// v36: Legacy brand-domain consolidation + a per-user record correction for a
// pre-rebrand deployment. Only ever affected pre-v37 localStorage; it is now an
// inert version bump (the demo and all fresh clones start at v38, so it never
// runs against real data).
//
// v35: Legacy per-user name correction for a pre-rebrand deployment. Only ever
// affected pre-v37 localStorage; it is now an inert version bump.
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

const STORAGE_KEY = 'pp.store.v40';

// Default per-user notification prefs — kept here so the migration can
// backfill it on existing users without importing from seed.js.
const DEFAULT_NOTIFICATION_PREFS = {
  newClientMessage: true,
  newDM: true,
  newInternalMessage: true,
  jobCreatedOrRescheduled: true,
  jobCancelled: true,
  invoicePaid: true,
  invoiceOverdue: true,
  mobilePushEnabled: true,
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

function migrateV14toV15(state) {
  const defaultPipelineId = 'pl_seed_default';
  const pipelines = [{
    id: defaultPipelineId,
    label: 'Sales Pipeline',
    createdAt: new Date().toISOString(),
    stages: state.pipelineStages || [],
  }];
  const contacts = (state.contacts || []).map((c) => ({
    ...c,
    pipelineId: c.stage ? defaultPipelineId : null,
  }));
  const { pipelineStages, ...rest } = state;
  return {
    ...rest,
    version: 15,
    pipelines,
    activePipelineId: defaultPipelineId,
    contacts,
  };
}

function migrateV15toV16(state) {
  return {
    ...state,
    version: 16,
    invitations: state.invitations || [],
  };
}

function migrateV16toV17(state) {
  const contacts = (state.contacts || []).map(({ visibility, ...rest }) => rest);
  const crewRevokePerms = ['contacts.view', 'contacts.edit.own', 'messaging.use', 'messaging.internalComment'];
  const permissions = (state.permissions || []).map((p) =>
    crewRevokePerms.includes(p.id) ? { ...p, roles: p.roles.filter((r) => r !== 'crew') } : p
  );
  return { ...state, version: 17, contacts, permissions };
}

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
    notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...(u.notificationPrefs || {}) },
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

// v35: Legacy per-user name correction for a pre-rebrand deployment. The
// records it targeted only existed in pre-v37 localStorage, which no longer
// occurs (demo + fresh clones start at v38), so this is now an inert bump.
function migrateV34toV35(state) {
  return { ...state, version: 35 };
}

// v36: Legacy brand-domain consolidation + a per-user record correction for a
// pre-rebrand deployment. The emails/records it rewrote only existed in pre-v37
// localStorage, which no longer occurs (demo + fresh clones start at v38), so
// this is now an inert version bump.
function migrateV35toV36(state) {
  return { ...state, version: 36 };
}

// v38: Marketing module (cold-email sequences). Additive — five new top-level
// entities + a settings object. v37 was a key-bump-only rebrand step (no shape
// change), so this hop applies cleanly to any v36- or v37-shaped state. Fully
// idempotent: every field guards with `|| <default>`.
function migrateV37toV38(state) {
  return {
    ...state,
    version: 38,
    marketingInboxes: state.marketingInboxes || [],
    marketingSequences: state.marketingSequences || [],
    marketingEnrollments: state.marketingEnrollments || [],
    marketingSends: state.marketingSends || [],
    marketingReplies: state.marketingReplies || [],
    marketingSettings: state.marketingSettings || {
      replyRouting: { enabled: false, pipelineId: null, stageKey: null },
      plainTextDefault: false,
      defaultSendWindow: { start: 9, end: 17 },
      sendTimezone: null,
      sendIntervalMinutes: 5,
    },
  };
}

// Compose v29 → v33 → v34 → v35 → v36 → v38 hops on top of any earlier
// migration chain. v29 is the last numbered shape change before v33 (intermediate
// v30/v31/v32 storage keys existed but never bumped state.version); v34 is
// the nomenclature consolidation; v35 is the Heather Warren rename; v36
// rewrites the brand domain + force-corrects Heather by id; v37 was a key-only
// rebrand bump (no shape change); v38 adds the Marketing module. This single
// composition covers all stored states from v17 through v37.
const toLatest = (s) => migrateV37toV38(migrateV35toV36(migrateV34toV35(migrateV33toV34(migrateV29toV33(migrateV28toV29(s))))));

export function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.version === 38) return parsed;
    }
    // v37 direct accept: previous storage key (key-only rebrand bump, version 37).
    // Run v37 → v38 to add the Marketing entities.
    const v37Raw = window.localStorage.getItem('pp.store.v37');
    if (v37Raw) {
      const parsed = JSON.parse(v37Raw);
      if (parsed && typeof parsed === 'object') return migrateV37toV38(parsed);
    }
    // v35 direct accept: previous storage key. Run v35 → v36 → v38.
    const v35Raw = window.localStorage.getItem('pp.store.v35');
    if (v35Raw) {
      const parsed = JSON.parse(v35Raw);
      if (parsed && typeof parsed === 'object') return migrateV37toV38(migrateV35toV36(parsed));
    }
    // v34 direct accept: previous storage key. Run v34 → v35 → v36 → v38.
    const v34Raw = window.localStorage.getItem('pp.store.v34');
    if (v34Raw) {
      const parsed = JSON.parse(v34Raw);
      if (parsed && typeof parsed === 'object') return migrateV37toV38(migrateV35toV36(migrateV34toV35(parsed)));
    }
    // v33 direct accept: previous storage key. Run v33 → v34 → v35 → v36 → v38.
    const v33Raw = window.localStorage.getItem('pp.store.v33');
    if (v33Raw) {
      const parsed = JSON.parse(v33Raw);
      if (parsed && typeof parsed === 'object') return migrateV37toV38(migrateV35toV36(migrateV34toV35(migrateV33toV34(parsed))));
    }
    // Stale-key direct accepts: prior storage keys (v28-v32) parked here as
    // version=29-shaped data. Run v29→v33→v34→v35→v36.
    for (const key of ['pp.store.v32', 'pp.store.v31', 'pp.store.v30', 'pp.store.v29']) {
      const r = window.localStorage.getItem(key);
      if (!r) continue;
      const parsed = JSON.parse(r);
      if (parsed && typeof parsed === 'object') return migrateV35toV36(migrateV34toV35(migrateV33toV34(migrateV29toV33(parsed))));
    }
    // Attempt v28 → v29 → v33 → v34 migration
    const v28Raw = window.localStorage.getItem('pp.store.v28');
    if (v28Raw) {
      const v28 = JSON.parse(v28Raw);
      if (v28 && typeof v28 === 'object' && v28.version === 28) return toLatest(v28);
    }
    // Attempt v27 → v28 → ... → v33 migration chain
    const v27Raw = window.localStorage.getItem('pp.store.v27');
    if (v27Raw) {
      const v27 = JSON.parse(v27Raw);
      if (v27 && typeof v27 === 'object' && v27.version === 27) return toLatest(migrateV27toV28(v27));
    }
    // Attempt v26 → v27 → ... → v33 migration chain
    const v26Raw = window.localStorage.getItem('pp.store.v26');
    if (v26Raw) {
      const v26 = JSON.parse(v26Raw);
      if (v26 && typeof v26 === 'object' && v26.version === 26) return toLatest(migrateV27toV28(migrateV26toV27(v26)));
    }
    // Attempt v25 → v26 → ... → v33 migration chain
    const v25Raw = window.localStorage.getItem('pp.store.v25');
    if (v25Raw) {
      const v25 = JSON.parse(v25Raw);
      if (v25 && typeof v25 === 'object' && v25.version === 25) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(v25))));
    }
    // Attempt v24 → v25 → ... → v33 migration chain
    const v24Raw = window.localStorage.getItem('pp.store.v24');
    if (v24Raw) {
      const v24 = JSON.parse(v24Raw);
      if (v24 && typeof v24 === 'object' && v24.version === 24) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(v24)))));
    }
    // Attempt v23 → v24 → ... → v33 migration chain
    const v23Raw = window.localStorage.getItem('pp.store.v23');
    if (v23Raw) {
      const v23 = JSON.parse(v23Raw);
      if (v23 && typeof v23 === 'object' && v23.version === 23) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(v23))))));
    }
    // Attempt v22 → v23 → ... → v33 migration chain
    const v22Raw = window.localStorage.getItem('pp.store.v22');
    if (v22Raw) {
      const v22 = JSON.parse(v22Raw);
      if (v22 && typeof v22 === 'object' && v22.version === 22) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(v22)))))));
    }
    // Attempt v21 → ... → v33 migration chain
    const v21Raw = window.localStorage.getItem('pp.store.v21');
    if (v21Raw) {
      const v21 = JSON.parse(v21Raw);
      if (v21 && typeof v21 === 'object' && v21.version === 21) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(v21))))))));
    }
    // Attempt v20 → ... → v33 migration chain
    const v20Raw = window.localStorage.getItem('pp.store.v20');
    if (v20Raw) {
      const v20 = JSON.parse(v20Raw);
      if (v20 && typeof v20 === 'object' && v20.version === 20) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(migrateV20toV21(v20)))))))));
    }
    // Attempt v19 → ... → v33 migration chain
    const v19Raw = window.localStorage.getItem('pp.store.v19');
    if (v19Raw) {
      const v19 = JSON.parse(v19Raw);
      if (v19 && typeof v19 === 'object' && v19.version === 19) return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(migrateV20toV21(migrateV19toV20(v19))))))))));
    }
    // Attempt v18 → ... → v33 migration chain
    const v18Raw = window.localStorage.getItem('pp.store.v18');
    if (v18Raw) {
      const v18 = JSON.parse(v18Raw);
      if (v18 && typeof v18 === 'object' && v18.version === 18) {
        return toLatest(migrateV27toV28(migrateV26toV27(migrateV25toV26(migrateV24toV25(migrateV23toV24(migrateV22toV23(migrateV21toV22(migrateV20toV21(migrateV19toV20(migrateV18toV19(v18)))))))))));
      }
    }
    // Attempt v17 → ... → v33 migration chain
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

export function saveState(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or private mode — silently drop.
  }
}

export function clearState() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
