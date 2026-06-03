// Selectors — read-only helpers over state. Kept pure; callers can memoize if hot.

import { effectivePermissions } from '../lib/roles';
import { getVisibleNotificationGroups, isNotificationVisibleForUser } from '../lib/notifications';

export const selectCompany = (s) => s.company;
export const selectUsers = (s) => s.users;
export const selectActiveUsers = (s) => s.users.filter((u) => u.status === 'active');
export const selectCurrentUser = (s) => s.users.find((u) => u.id === s.currentUserId) || null;
export const selectServices = (s) => s.services;
export const selectFrequencies = (s) => s.frequencies;
export const selectClients = (s) => s.clients;
export const selectActiveClients = (s) => s.clients.filter((c) => c.status === 'active');
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
export const selectUserPermissionOverrides = (s) => s.userPermissionOverrides || [];

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
export const selectSnippetFolders = (s) => s.snippetFolders || [];
export const selectSnippetById = (s, id) => (s.snippets || []).find((x) => x.id === id) || null;
export const selectSnippetFolderById = (s, id) => (s.snippetFolders || []).find((f) => f.id === id) || null;
export const selectSnippetsForFolder = (s, folderId) =>
  (s.snippets || []).filter((x) => x.folderId === folderId);
// Snippets that apply to a given channel. Snippets with channel='all' always match;
// snippets pinned to a specific channel only match that channel.
export const selectSnippetsForChannel = (s, channel) =>
  (s.snippets || []).filter((x) => x.channel === 'all' || x.channel === channel);

// ---------- Lookups ----------
export const selectClientById = (s, id) => s.clients.find((c) => c.id === id) || null;
export const selectSiteById   = (s, id) => s.sites.find((x) => x.id === id) || null;
export const selectServiceById = (s, id) => s.services.find((x) => x.id === id) || null;
export const selectUserById    = (s, id) => s.users.find((x) => x.id === id) || null;

// ---------- Notification preferences ----------
// Per-user toggles + mobilePushEnabled live on user.notificationPrefs.
// All event toggles default true; mobilePushEnabled defaults false.
export const selectNotificationPrefs = (s, userId) => {
  const u = s.users.find((x) => x.id === userId);
  return u?.notificationPrefs || null;
};

// Returns the toggle catalog filtered for a user's role + permission overrides.
// Used by Account → Notifications to render only the rows the user can act on.
export const selectVisibleNotificationGroups = (s, userId) => {
  const user = s.users.find((x) => x.id === userId);
  return getVisibleNotificationGroups(user, s.permissions, s.userPermissionOverrides);
};

// Used by NotificationListener to gate event firing: true only when the user
// has the toggle on AND the toggle is visible to their role/permissions.
export const selectShouldNotifyUser = (s, userId, eventKey) => {
  const user = s.users.find((x) => x.id === userId);
  if (!user) return false;
  const prefs = user.notificationPrefs;
  if (!prefs || prefs[eventKey] !== true) return false;
  return isNotificationVisibleForUser(eventKey, user, s.permissions, s.userPermissionOverrides);
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
// Pipelines excluding any "master/triage" board. The shell has no master-board
// concept (that's a per-client Pipeline overhaul), so on the shell this returns
// every pipeline — the filter is a no-op until/unless isMaster exists. Kept
// API-compatible so the Marketing reply-routing picker works unchanged.
export const selectNonMasterPipelines = (s) =>
  (s.pipelines || []).filter((p) => !p.isMaster);
export const selectActivePipeline = (s) =>
  (s.pipelines || []).find((p) => p.id === s.activePipelineId) || (s.pipelines || [])[0] || null;
export const selectActivePipelineStages = (s) => {
  const pl = selectActivePipeline(s);
  return pl ? pl.stages : [];
};
export const selectPipelineStages = selectActivePipelineStages;
export const selectPipelineStageByKey = (s, key) => {
  const stages = selectActivePipelineStages(s);
  return stages.find((st) => st.key === key) || null;
};
export const selectContactsByStageKey = (s, key) => {
  const pl = selectActivePipeline(s);
  if (!pl) return [];
  return (s.contacts || []).filter((c) => c.pipelineId === pl.id && c.stage === key);
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

export const selectJobsForUser = (s, userId) =>
  s.jobs.filter((j) => j.crewIds?.includes(userId));

// v9: recurring series
export const selectSeriesJobs = (s, seriesId) =>
  seriesId ? s.jobs.filter((j) => j.seriesId === seriesId).sort((a, b) => a.startAt.localeCompare(b.startAt)) : [];
export const selectSeriesMaster = (s, seriesId) =>
  seriesId ? s.jobs.find((j) => j.seriesId === seriesId && j.recurrence) : null;

// v9: conflict detection — crew members assigned to overlapping time slots.
// Returns [{ job, userId, userName }] for each overlap. Excludes cancelled jobs.
export function selectCrewConflicts(s, crewIds, startAt, endAt, excludeJobId = null) {
  if (!crewIds?.length || !startAt || !endAt) return [];
  const results = [];
  for (const job of s.jobs) {
    if (job.id === excludeJobId) continue;
    if (job.status === 'cancelled') continue;
    if (job.startAt >= endAt || job.endAt <= startAt) continue;
    for (const uid of crewIds) {
      if (job.crewIds?.includes(uid)) {
        const user = s.users.find((u) => u.id === uid);
        results.push({ job, userId: uid, userName: user?.name || uid });
      }
    }
  }
  return results;
}

export const selectContactsForClient = (s, clientId) =>
  (s.contacts || []).filter((c) => c.companyId === clientId);

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
    .filter((c) => c.lifecycle === 'lead' || c.lifecycle === 'prospect')
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
    .filter((c) => c.channel !== 'internal' && c.status === 'open')
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
      rejected: 'A2P 10DLC was rejected — resubmit required',
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
      pending: 'Domain verification pending — DNS records propagating',
      failed: 'Domain verification failed — check DKIM/SPF/DMARC records',
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
// Settings → My Account → Connected Inboxes.
export const selectUserHasActiveInbox = (s, userId) =>
  (s.connectedInboxes || []).some((i) => i.userId === userId && i.status === 'active');

// Reasons the email channel is blocked for a given user, in display order.
// Empty array = ready to send. Used by the Messaging compose pane to render
// the "connect your inbox" CTA when sending email isn't possible.
export const selectMessagingEmailBlockersForUser = (s, userId) => {
  const inboxes = (s.connectedInboxes || []).filter((i) => i.userId === userId);
  const blockers = [];
  if (!inboxes.length) {
    blockers.push({ key: 'no_inbox', label: 'No connected inbox — connect Gmail / Outlook / SMTP in My Account → Connected Inboxes' });
    return blockers;
  }
  const actives = inboxes.filter((i) => i.status === 'active');
  if (!actives.length) {
    const expired = inboxes.find((i) => i.status === 'expired');
    if (expired) {
      blockers.push({ key: 'token_expired', label: `Reconnect ${expired.email} — authorization expired` });
    } else {
      blockers.push({ key: 'all_inboxes_error', label: 'All connected inboxes are in an error state — reconnect or check provider' });
    }
  }
  return blockers;
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
//   - crew:          see ONLY the clients they have jobs on (any job, any status), and
//                    contacts attached to those clients. Standalone contacts (no companyId)
//                    are not surfaced to crew — they have no client anchor.
// Returns the set of client ids visible to a given user.
export function selectVisibleClientIdsFor(s, user) {
  if (!user) return new Set();
  if (user.role !== 'crew') return new Set((s.clients || []).map((c) => c.id));
  const ids = new Set();
  (s.jobs || []).forEach((j) => {
    if ((j.crewIds || []).includes(user.id) && j.clientId) ids.add(j.clientId);
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

// Pipeline — contacts in the active pipeline with a stage set.
export function selectPipelineContacts(s) {
  const pl = selectActivePipeline(s);
  if (!pl) return [];
  return (s.contacts || []).filter(
    (c) => c.pipelineId === pl.id && c.stage && (c.lifecycle === 'lead' || c.lifecycle === 'prospect' || c.lifecycle === 'client')
  );
}

// Effective permissions for a specific user (for the overrides UI).
export function selectEffectivePermissionsForUser(s, userId) {
  const user = selectUserById(s, userId);
  return effectivePermissions(user, s.permissions, s.userPermissionOverrides || []);
}

// ---------- Derived ----------
export function invoiceTotal(invoice) {
  const sub = (invoice.lineItems || []).reduce((a, li) => a + (Number(li.qty) || 0) * (Number(li.unitPrice) || 0), 0);
  const tax = sub * ((Number(invoice.taxRate) || 0) / 100);
  return Math.round((sub + tax) * 100) / 100;
}

export function invoicePaid(invoice) {
  return (invoice.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
}

export function invoiceBalance(invoice) {
  return Math.round((invoiceTotal(invoice) - invoicePaid(invoice)) * 100) / 100;
}

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

export function deriveInvoiceStatus(invoice, now = new Date()) {
  // Manual 'void' is authoritative; everything else is derived from balance + due date.
  // ('draft' was removed when Invoices was rescoped to manual tracking.)
  if (invoice.status === 'void') return 'void';
  const balance = invoiceBalance(invoice);
  if (balance <= 0 && invoiceTotal(invoice) > 0) return 'paid';
  if (invoice.dueDate && new Date(invoice.dueDate) < now && balance > 0) return 'overdue';
  return 'pending';
}

// Dashboard summary stats
export function selectDashboardStats(s) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);

  const jobsToday = s.jobs.filter((j) => new Date(j.startAt) >= today && new Date(j.startAt) < tomorrow);
  const invoicesThisWeek = s.invoices.filter((inv) => {
    const d = new Date(inv.issueDate);
    return d >= today && d < weekEnd;
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

  const activeClients = s.clients.filter((c) => c.status === 'active').length;

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

// ─── Operations KPIs — missed cleans, labor hours, outstanding quotes ──────
// All windowed selectors use a rolling N-day lookback from "now" so the
// dashboard auto-updates without bookkeeping. `complaint` activities are
// `contactActivities` rows with `kind === 'complaint'`. Missed cleans are
// jobs with `status === 'missed'` (status is set by the reducer/UI when a
// scheduled job is intentionally marked missed; not auto-derived from time
// to avoid silently flipping cancelled jobs).

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysAgoDate = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return startOfDay(d); };

// Q17: "missed cleans" — count + estimated revenue impact over the last 30 days.
// Revenue impact is service.defaultDurationMins as a rough proxy ($150/hr).
export function selectMissedCleansThisMonth(s) {
  const since = daysAgoDate(30);
  const services = s.services || [];
  const missed = (s.jobs || []).filter(
    (j) => j.status === 'missed' && new Date(j.startAt) >= since
  );
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

// Q18: "outstanding quotes" — sum of dealValue + count for contacts at the
// 'quote' stage (Quote Sent in the sales pipeline). Walkthroughs in the
// pre-quote stages are tracked separately.
export function selectOutstandingQuotes(s) {
  const inQuote = (s.contacts || []).filter((c) => c.stage === 'quote');
  const value = inQuote.reduce((sum, c) => sum + (Number(c.dealValue) || 0), 0);
  return { count: inQuote.length, value };
}

// Q18: revenue this month (paid amount logged within current calendar month).
export function selectRevenueThisMonth(s) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return (s.invoices || []).reduce((sum, inv) => {
    return sum + (inv.payments || []).reduce((paySum, p) => {
      return new Date(p.date) >= monthStart ? paySum + (Number(p.amount) || 0) : paySum;
    }, 0);
  }, 0);
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

// Compute the live status of a conversation, auto-un-snoozing past-due timers.
// Pure read — never mutates state. UIs that care about 'open vs snoozed' should
// call this rather than reading conv.status directly.
export function selectEffectiveStatus(conv, now = Date.now()) {
  if (!conv) return 'open';
  if (conv.status === 'snoozed' && conv.snoozedUntil) {
    if (new Date(conv.snoozedUntil).getTime() <= now) return 'open';
  }
  return conv.status || 'open';
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
