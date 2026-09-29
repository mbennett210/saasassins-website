// CS-002 — the CREW READ PROJECTION, pure. Drives projectCrewView (api/_lib/crewView.js)
// with a hand-built state and asserts the classification is COMPLETE and the projection is
// scoped/trimmed/dropped exactly as designed. No Supabase — projectCrewView is pure.
//
//   node app/scripts/test-crew-view.mjs
import { readFileSync } from 'node:fs';
import { projectCrewView, CREW_VIEW_CLASSIFICATION, OPS_PAYRUN_FIELDS } from '../api/_lib/crewView.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const has = (arr, id) => Array.isArray(arr) && arr.some((x) => x && x.id === id);
const absent = (arr, id) => !has(arr, id);

// ── 1. every INITIAL_STATE slice is classified, and no classification key is stale ──
// The mechanical guarantee (BUILD_INTEGRITY audit-rigor): a new blob slice fails this until
// someone classifies it, so a sensitive slice can never default into the projection. seed.js
// uses Vite's extensionless imports, so it can't be imported under bare node — parse the
// INITIAL_STATE object's TOP-LEVEL keys straight from the source text instead (mechanical
// enumeration from the source of truth; LF/CRLF-safe).
function initialStateSlices() {
  const src = readFileSync(new URL('../src/data/seed.js', import.meta.url), 'utf8');
  const marker = 'export const INITIAL_STATE = {';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('INITIAL_STATE not found in seed.js');
  // The object body ends at the first line that is exactly "};" at column 0 after the marker.
  const after = src.slice(at + marker.length);
  const endRel = after.search(/\n};\s*(\r?\n|$)/);
  const body = after.slice(0, endRel < 0 ? after.length : endRel);
  const keys = new Set();
  // Top-level keys sit at exactly two-space indent; nested object/array content is deeper,
  // comments start with // (not \w), closing braces/brackets are not \w — none of which match.
  for (const line of body.split(/\r?\n/)) {
    const m = /^ {2}(\w+)\s*[:,]/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}
const SLICES = initialStateSlices();
ok('parsed a sane number of INITIAL_STATE slices (>40)', SLICES.size > 40);
for (const key of SLICES) {
  ok(`INITIAL_STATE slice classified: ${key}`, key in CREW_VIEW_CLASSIFICATION);
}
for (const key of Object.keys(CREW_VIEW_CLASSIFICATION)) {
  ok(`classification key exists in INITIAL_STATE: ${key}`, SLICES.has(key));
}

// ── 2. the projection ───────────────────────────────────────────────────────
const state = {
  version: 56,
  company: {
    id: 'co', name: 'Clean Space', timezone: 'America/New_York',
    // F2 fixture: every sensitive integrations field populated with a sentinel VALUE, so the
    // trim can be proven to strip them (asserted against these constants, not restated literals).
    integrations: {
      twilio: {
        connected: true,
        accountSidLast4: 'S1D4',
        phoneNumber: '+18005551234',
        phoneNumberFriendlyName: 'Main Line',
        connectedAt: '2026-01-01T00:00:00.000Z',
        lastError: null,
        inboundWebhookUrl: 'https://cleanspace.example/api/twilio/inbound-secret-hook',
        a2p: {
          status: 'approved',
          brandName: 'CS Texting Brand',
          ein: '12-3456789',
          businessAddress: '500 Biz Way, Fort Lauderdale FL',
          useCase: 'customer notifications',
          sampleMessages: ['Your clean is scheduled'],
          submittedAt: null, approvedAt: null, rejectionReason: null, notes: 'internal notes',
        },
      },
      email: {
        connected: true,
        provider: 'resend',
        apiKeyLast4: 'K3Y4',
        verifiedDomain: 'mail.cleanspaceonline.com',
        defaultFrom: 'Clean Space <hello@mail.cleanspaceonline.com>',
        defaultReplyTo: 'reply@cleanspaceonline.com',
        connectedAt: null, lastVerifiedAt: null, lastError: null,
        domain: {
          status: 'verified',
          dkimRecords: [{ host: 'cs._domainkey', type: 'TXT', value: 'v=DKIM1; k=rsa; p=MIGfMA0-SECRETKEYMATERIAL', status: 'verified' }],
          spfStatus: 'configured', dmarcStatus: 'configured', lastCheckedAt: null, failureReason: null,
        },
      },
    },
  },
  currentUserId: 'u_owner',
  users: [
    { id: 'u_owner', name: 'Owner', initials: 'OW', avatar: 1, role: 'owner', status: 'active', email: 'o@x.co', phone: '111', pay: { type: 'none' }, hr: { employeeId: 'E1' }, notificationPrefs: { newDM: true }, signaturePrefs: { text: 'sig' } },
    { id: 'u_crew', name: 'Crew', initials: 'CR', avatar: 2, role: 'crew', status: 'active', email: 'c@x.co', phone: '222', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'E2' }, notificationPrefs: { newDM: true, jobCancelled: false }, signaturePrefs: { text: 'mysig' } },
    { id: 'u_crew2', name: 'Crew2', initials: 'C2', avatar: 3, role: 'crew', status: 'active', email: 'c2@x.co', phone: '333', pay: { type: 'hourly', hourlyRate: 21 }, hr: { employeeId: 'E3' } },
  ],
  services: [{ id: 'svc1', name: 'Janitorial' }],
  frequencies: [{ id: 'f1', label: 'Weekly' }],
  clients: [
    { id: 'c1', name: 'Acme', notes: 'note', standingCrewIds: [] },
    { id: 'c2', name: 'Other', notes: 'secret', standingCrewIds: [] },
  ],
  sites: [
    { id: 's1', clientId: 'c1', name: 'HQ' },
    { id: 's2', clientId: 'c2', name: 'Other site' },
  ],
  contacts: [
    { id: 'ct1', companyId: 'c1', firstName: 'Pat', email: 'pat@acme.co' },
    { id: 'ct2', companyId: 'c2', firstName: 'Sam', email: 'sam@other.co' },
  ],
  clientActivities: [
    { id: 'a1', clientId: 'c1', kind: 'note', authorUserId: 'u_owner', body: 'visible' },
    { id: 'a2', clientId: 'c2', kind: 'note', authorUserId: 'u_owner', body: 'hidden' },
  ],
  invoices: [{ id: 'inv1', clientId: 'c1', total: 12345 }],
  quotes: [{ id: 'q1' }],
  syncedPayments: [{ id: 'sp1' }],
  financialSnapshot: { mrr: 99999 },
  payrollLines: [{ id: 'pl1', userId: 'u_crew', amount: 999 }],
  reimbursements: [{ id: 'rmb1', userId: 'u_crew', amount: 40 }],
  employeeDocuments: [{ id: 'ed1' }],
  permissions: [{ id: 'clients.view', roles: ['owner', 'admin', 'manager', 'crew'] }],
  tags: [{ id: 'tg1', label: 'VIP' }],
  snippets: [{ id: 'sn1', text: 'canned' }],
  inspectionTemplates: [{ id: 'it1' }],
  checklistTemplates: [{ id: 'clt1' }],
  inspectionFollowUps: [{ id: 'if1' }],
  keys: [
    { id: 'k1', clientId: 'c1', clientName: 'Acme', masterCode: 'SECRET1', label: 'K1', status: 'in' },
    { id: 'k2', clientId: 'c2', clientName: 'Other', masterCode: 'SECRET2', label: 'K2', status: 'in' },
    { id: 'k3', clientId: 'c2', clientName: 'Other', masterCode: 'SECRET3', label: 'K3', status: 'out', heldByUserId: 'u_crew' },
  ],
  keyEvents: [
    { id: 'ke1', keyId: 'k1', kind: 'checkin' },
    { id: 'ke2', keyId: 'k2', kind: 'checkin' },
    { id: 'ke3', keyId: 'k3', kind: 'checkout' },
  ],
  conversations: [
    { id: 'cv-dm', channel: 'dm', participantUserIds: ['u_crew', 'u_owner'] },
    { id: 'cv-dm2', channel: 'dm', participantUserIds: ['u_owner', 'u_crew2'] },
    { id: 'cv-int', channel: 'internal', participantUserIds: ['u_crew', 'u_owner'] },
    { id: 'cv-ext1', channel: 'sms', clientId: 'c1', contactId: 'ct1' },
    { id: 'cv-ext2', channel: 'sms', clientId: 'c2', contactId: 'ct2' },
    // F1 fixture: orphaned internal + dm threads (all participants offboarded by DELETE_USER →
    // participantUserIds []). These are the Super-Admin-only maintenance set, never a crew read.
    { id: 'cv-orphan-int', channel: 'internal', participantUserIds: [], createdByName: 'Departed' },
    { id: 'cv-orphan-dm', channel: 'dm', participantUserIds: [] },
  ],
  messages: [
    { id: 'm1', conversationId: 'cv-dm', text: 'hi' },
    { id: 'm2', conversationId: 'cv-dm2', text: 'secret dm' },
    { id: 'm3', conversationId: 'cv-ext2', text: 'other customer' },
    { id: 'm-orphan-int', conversationId: 'cv-orphan-int', text: 'orphan internal secret' },
    { id: 'm-orphan-dm', conversationId: 'cv-orphan-dm', text: 'orphan dm secret' },
  ],
  notifications: [
    { id: 'n1', userId: 'u_crew', title: 'yours' },
    { id: 'n2', userId: 'u_owner', title: 'not yours' },
    { id: 'n3', userId: 'u_crew2', title: 'someone else' },
  ],
  timeOff: [{ id: 'to1', userId: 'u_crew' }, { id: 'to2', userId: 'u_crew2' }],
  userPermissionOverrides: [
    { userId: 'u_crew', grants: ['x'], revokes: [] },
    { userId: 'u_crew2', grants: ['y'], revokes: [] },
  ],
  opsSettings: { defaultGeofenceRadiusM: 250, varianceFlagOverMins: 15, otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0, payDriveTime: true },
  accountMedia: [{ id: 'am1', siteId: 's1', clientId: 'c1' }, { id: 'am2', siteId: 's2', clientId: 'c2' }],
  pipelines: [{ id: 'plp' }], opportunities: [{ id: 'op' }], activePipelineId: 'plp',
  marketingInboxes: [{ id: 'mi' }], marketingSequences: [{ id: 'ms' }], marketingEnrollments: [{ id: 'me' }],
  marketingSends: [{ id: 'msd' }], marketingReplies: [{ id: 'mr' }], marketingSuppressions: [{ id: 'msp' }], marketingSettings: { on: true },
  reviews: { indeedActual: 3 }, opsAlertEvents: [{ id: 'oe' }], supplyItems: [{ id: 'si' }], supplyRequests: [{ id: 'sr' }],
  contactActivities: [{ id: 'ca' }], clientReview: { sections: { x: 1 } },
  reminderTemplates: [{ id: 'rt' }], reminderEvents: [{ id: 're' }],
  oauthWorkspaces: [{ id: 'ow' }], connectedInboxes: [{ id: 'ci' }], invitations: [{ id: 'iv' }],
  jobs: [{ id: 'j-blob', crewIds: ['u_crew'] }],
};
const crewJobs = [{ id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1' }];
const v = projectCrewView(state, { userId: 'u_crew', crewJobs });

// DROPPED slices are absent entirely.
for (const key of ['invoices', 'quotes', 'syncedPayments', 'financialSnapshot', 'payrollLines', 'reimbursements',
  'employeeDocuments', 'pipelines', 'opportunities', 'activePipelineId', 'marketingInboxes', 'marketingSequences',
  'marketingEnrollments', 'marketingSends', 'marketingReplies', 'marketingSuppressions', 'marketingSettings',
  'reviews', 'opsAlertEvents', 'supplyItems', 'supplyRequests', 'contactActivities', 'clientReview',
  'reminderTemplates', 'reminderEvents', 'oauthWorkspaces', 'connectedInboxes', 'invitations', 'currentUserId']) {
  ok(`dropped: ${key} absent`, v[key] === undefined);
}

// KEEP slices present.
ok('keep: version', v.version === 56);
ok('keep: company', v.company && v.company.name === 'Clean Space');

// F2 (CS-002 L3): company.integrations is TRIMMED for crew to exactly the send-readiness
// fields the crew-reachable messaging surface reads (useMessageSender + ReminderScheduler:
// twilio connected/phoneNumber/a2p.status; email defaultReplyTo). No last4s, EIN, business
// address, DKIM/DNS records, webhook URLs, verified domain or tokens ever reach a crew tab.
// Pre-fix `company` was classified 'keep' and passed through WHOLE — every field below shipped.
const integ = v.company && v.company.integrations;
ok('F2: integrations present (trimmed, not dropped)', integ && typeof integ === 'object');
// kept — the exact fields crew-reachable code reads
ok('F2: twilio.connected kept', integ && integ.twilio && integ.twilio.connected === true);
ok('F2: twilio.phoneNumber kept (SMS from-number)', integ && integ.twilio && integ.twilio.phoneNumber === '+18005551234');
ok('F2: twilio.a2p.status kept', integ && integ.twilio && integ.twilio.a2p && integ.twilio.a2p.status === 'approved');
ok('F2: email.defaultReplyTo kept', integ && integ.email && integ.email.defaultReplyTo === 'reply@cleanspaceonline.com');
// sensitive fields removed
ok('F2: twilio.accountSidLast4 removed', integ && integ.twilio && !('accountSidLast4' in integ.twilio));
ok('F2: twilio.inboundWebhookUrl removed', integ && integ.twilio && !('inboundWebhookUrl' in integ.twilio));
ok('F2: twilio.connectedAt removed', integ && integ.twilio && !('connectedAt' in integ.twilio));
ok('F2: a2p.ein removed', integ && integ.twilio && integ.twilio.a2p && !('ein' in integ.twilio.a2p));
ok('F2: a2p.businessAddress removed', integ && integ.twilio && integ.twilio.a2p && !('businessAddress' in integ.twilio.a2p));
ok('F2: a2p.brandName removed', integ && integ.twilio && integ.twilio.a2p && !('brandName' in integ.twilio.a2p));
ok('F2: email.apiKeyLast4 removed', integ && integ.email && !('apiKeyLast4' in integ.email));
ok('F2: email.domain (DKIM/SPF/DMARC) removed', integ && integ.email && !('domain' in integ.email));
ok('F2: email.verifiedDomain removed', integ && integ.email && !('verifiedDomain' in integ.email));
ok('F2: email.defaultFrom removed', integ && integ.email && !('defaultFrom' in integ.email));
// belt-and-braces: no sensitive VALUE survives anywhere in the projected company object.
const companyJson = JSON.stringify(v.company || {});
for (const [label, needle] of [
  ['twilio accountSidLast4', 'S1D4'], ['email apiKeyLast4', 'K3Y4'], ['EIN', '12-3456789'],
  ['business address', '500 Biz Way'], ['DKIM record', 'v=DKIM1'], ['DKIM key material', 'MIGfMA0-SECRETKEYMATERIAL'],
  ['inbound webhook URL', 'inbound-secret-hook'], ['verified sending domain', 'mail.cleanspaceonline.com'],
]) {
  ok(`F2: crew company holds no ${label}`, !companyJson.includes(needle));
}
ok('keep: services', has(v.services, 'svc1'));
ok('keep: frequencies', has(v.frequencies, 'f1'));
ok('keep: tags', has(v.tags, 'tg1'));
ok('keep: permissions', has(v.permissions, 'clients.view'));
ok('keep: snippets', has(v.snippets, 'sn1'));
ok('keep: inspectionTemplates', has(v.inspectionTemplates, 'it1'));
ok('keep: checklistTemplates', has(v.checklistTemplates, 'clt1'));

// SCOPE: clients/sites/contacts/clientActivities/accountMedia in-scope only.
ok('scope: client c1 in', has(v.clients, 'c1'));
ok('scope: client c2 OUT', absent(v.clients, 'c2'));
ok('scope: site s1 in', has(v.sites, 's1'));
ok('scope: site s2 OUT', absent(v.sites, 's2'));
ok('scope: contact ct1 in', has(v.contacts, 'ct1'));
ok('scope: contact ct2 OUT', absent(v.contacts, 'ct2'));
ok('scope: activity a1 in', has(v.clientActivities, 'a1'));
ok('scope: activity a2 OUT', absent(v.clientActivities, 'a2'));
ok('scope: media am1 in', has(v.accountMedia, 'am1'));
ok('scope: media am2 OUT', absent(v.accountMedia, 'am2'));

// SCOPE: keys — in-scope + held-by-crew, masterCode removed.
ok('scope: key k1 (in-scope) in', has(v.keys, 'k1'));
ok('scope: key k2 (out-of-scope) OUT', absent(v.keys, 'k2'));
ok('scope: key k3 (held by crew) in', has(v.keys, 'k3'));
ok('keys: masterCode removed from ALL', Array.isArray(v.keys) && v.keys.every((k) => !('masterCode' in k)));
ok('scope: keyEvent ke1 in', has(v.keyEvents, 'ke1'));
ok('scope: keyEvent ke2 OUT', absent(v.keyEvents, 'ke2'));
ok('scope: keyEvent ke3 in', has(v.keyEvents, 'ke3'));

// SCOPE: conversations + messages.
ok('conv: dm (crew in) visible', has(v.conversations, 'cv-dm'));
ok('conv: dm2 (crew out) HIDDEN', absent(v.conversations, 'cv-dm2'));
ok('conv: internal (crew in) visible', has(v.conversations, 'cv-int'));
ok('conv: ext1 (in-scope acct) visible', has(v.conversations, 'cv-ext1'));
ok('conv: ext2 (out-of-scope acct) HIDDEN', absent(v.conversations, 'cv-ext2'));
ok('msg: m1 (visible conv) present', has(v.messages, 'm1'));
ok('msg: m2 (hidden dm) HIDDEN', absent(v.messages, 'm2'));
ok('msg: m3 (hidden ext) HIDDEN', absent(v.messages, 'm3'));

// F1 (CS-002 L3): an ORPHANED internal/dm thread — participantUserIds [] after DELETE_USER
// scrubs its last member — is NOT visible to crew. selectConversationsForInbox scopes
// internal/dm to participants for EVERY role; an orphaned thread is reachable only through the
// Super-Admin-only selectOrphanedInternalThreads escape hatch, which never renders contents.
// Pre-fix the `parts.length === 0 ||` clause shipped it, and its messages, into every crew view.
ok('F1: orphaned internal thread HIDDEN', absent(v.conversations, 'cv-orphan-int'));
ok('F1: orphaned dm thread HIDDEN', absent(v.conversations, 'cv-orphan-dm'));
ok('F1: orphaned internal thread messages HIDDEN', absent(v.messages, 'm-orphan-int'));
ok('F1: orphaned dm thread messages HIDDEN', absent(v.messages, 'm-orphan-dm'));
// A thread the crew member DOES belong to is still present (guards against over-tightening).
ok('F1: thread crew belongs to still present', has(v.conversations, 'cv-int'));

// SCOPE-to-self: notifications / timeOff / overrides.
ok('notif: own present', has(v.notifications, 'n1'));
ok('notif: owner row HIDDEN', absent(v.notifications, 'n2'));
ok('notif: other crew HIDDEN', absent(v.notifications, 'n3'));
ok('timeOff: own only', has(v.timeOff, 'to1') && absent(v.timeOff, 'to2'));
ok('overrides: own only', v.userPermissionOverrides.length === 1 && v.userPermissionOverrides[0].userId === 'u_crew');

// TRIM: users.
const self = v.users.find((u) => u.id === 'u_crew');
const owner = v.users.find((u) => u.id === 'u_owner');
const crew2 = v.users.find((u) => u.id === 'u_crew2');
ok('users: self keeps email', self && self.email === 'c@x.co');
ok('users: self keeps phone', self && self.phone === '222');
ok('users: self keeps notificationPrefs', self && self.notificationPrefs && self.notificationPrefs.newDM === true);
ok('users: self keeps signaturePrefs', self && self.signaturePrefs && self.signaturePrefs.text === 'mysig');
ok('users: self DROPS pay', self && !('pay' in self));
ok('users: self DROPS hr', self && !('hr' in self));
ok('users: office row keeps phone (reach a supervisor)', owner && owner.phone === '111');
ok('users: office row DROPS email', owner && !('email' in owner));
ok('users: office row DROPS pay/hr', owner && !('pay' in owner) && !('hr' in owner));
ok('users: other crew row DROPS phone', crew2 && !('phone' in crew2));
ok('users: other crew row DROPS pay/hr/email', crew2 && !('pay' in crew2) && !('hr' in crew2) && !('email' in crew2));

// TRIM: opsSettings — geofence/variance kept, pay-run fields removed.
ok('opsSettings: geofence kept', v.opsSettings && v.opsSettings.defaultGeofenceRadiusM === 250);
ok('opsSettings: variance kept', v.opsSettings && v.opsSettings.varianceFlagOverMins === 15);
for (const f of OPS_PAYRUN_FIELDS) ok(`opsSettings: pay-run field removed: ${f}`, v.opsSettings && !(f in v.opsSettings));

// TABLE: jobs emptied (crew get their own from the RLS-scoped table).
ok('jobs: emptied in projection', Array.isArray(v.jobs) && v.jobs.length === 0);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1); }
