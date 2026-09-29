// Clean Space — seed data.
// Per-client clone of the shell. Demo clients/contacts/jobs/invoices/messages
// are kept rich (rebranded to FL janitorial) so the app looks alive at handoff.
// Replace via CSV import ($200 migration add-on) once Clean Space's GHL contacts
// land. Source of truth for what's seeded vs. add-on: ../../the approved build plan.

import { seedId } from '../lib/ids';
import { seedPermissions } from '../lib/roles';
import { DEFAULT_GEOFENCE_RADIUS_M } from '../lib/geo';
import { DEFAULT_DRIVE_MAX_GAP_MINS, DEFAULT_DRIVE_FLAG_PCT, DEFAULT_DRIVE_GRACE_MINS } from '../lib/driveTime';
import { buildClientLocation, clientGetsLocation, CLIENT_BILLING_DEFAULTS } from '../lib/location';
import { IDENTITY } from '../brand/identity.generated.js';

// The org's starting identity and copy name the brand from its brand file (brands/<id>/brand.json,
// UI_RULES §129), so a re-skinned build seeds the new client's name, domain and phone, and its owner
// (the brand's signatory, who signs its quotes) as the first Super Admin.
const BRAND_NAME = IDENTITY.name;
const BRAND_DOMAIN = IDENTITY.company.domain;
const BRAND_PHONE = IDENTITY.company.phone;
const OWNER = IDENTITY.company.signatory;
const INVOICE_PREFIX = IDENTITY.monogram; // the seeded invoices are numbered <monogram>-1001…
const OWNER_INITIALS = OWNER.initials; // derived from the name by brand.mjs, as the stored-owner correction reads them
const OWNER_FIRST = OWNER.name.split(/\s+/)[0]; // how the seeded messages address the owner

// ---------- helpers ----------
const atTime = (daysFromToday, hours, minutes = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
};

// Local day-key ('YYYY-MM-DD') `offset` days from today — for time-off (Called-out
// report) dates, which the schedule buckets on the local day the same way.
const todayKey = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

const hoursAgo = (n) => {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d.toISOString();
};

// ---------- core ----------
const company = {
  id: seedId('co', 'main'),
  name: IDENTITY.name,
  owner: OWNER.name,
  logoInitials: IDENTITY.monogram,
  // The brand's horizontal logo, knocked out to white for the dark sidebar
  // (gen-brand-images.mjs, from the brand pack's logos.lockup in brands/<id>/; the file
  // name is a kept identifier). Setting logoUrl makes the sidebar render JUST this image
  // — no gold tile, no "Clean Space / Platform" text (see Sidebar.jsx + .sidebar-brand-image).
  logoUrl: '/cleanspace-logo.png',
  logoMark: '/cleanspace-glyph-ink.png', // fallback only (unused while logoUrl is set)

  invoicePrefix: INVOICE_PREFIX,
  address: IDENTITY.company.address,
  phone: IDENTITY.company.phone,
  email: IDENTITY.company.email,
  businessHours: 'Mon–Fri 7:00 AM – 6:00 PM · 24/7 on request',
  taxRate: 0,
  // Org timezone — anchors the variance report's "last night" / WTD..YTD windows.
  // DEMO NOTE: intentionally Pacific to MATCH this demo laptop's local zone. Seed +
  // ledger times are composed with new Date().setHours(...) in machine-local time
  // (atTime/at helpers), so the org zone MUST equal the laptop zone or the "last
  // night" window mis-groups (verified: America/New_York on this Pacific machine
  // collapses "last night" from 6 cleans/2 flagged → 1/0). GO-LIVE: a real FL clone
  // sets 'America/New_York' AND recomposes seed/ledger times in Eastern together.
  timezone: 'America/Los_Angeles',
  integrations: {
    twilio: {
      connected: false,
      accountSidLast4: null,
      phoneNumber: null,
      phoneNumberFriendlyName: null,
      connectedAt: null,
      lastError: null,
      inboundWebhookUrl: null,
      a2p: {
        status: 'not_started',
        brandName: null,
        ein: null,
        businessAddress: null,
        useCase: null,
        sampleMessages: [],
        submittedAt: null,
        approvedAt: null,
        rejectionReason: null,
        notes: '',
      },
    },
    // System transactional email provider (Resend). Powers invitations,
    // reminder emails, and billing. One provider per deployment, sender locked
    // to a verified subdomain (e.g. mail.cleanspaceonline.com). Per-user emails
    // inside Messaging come from `connectedInboxes` instead — different layer.
    email: {
      connected: false,
      provider: null,             // 'resend' (room for future swaps)
      apiKeyLast4: null,
      verifiedDomain: null,       // e.g. 'mail.cleanspaceonline.com'
      defaultFrom: null,          // 'Clean Space <hello@mail.cleanspaceonline.com>'
      defaultReplyTo: null,
      connectedAt: null,
      lastVerifiedAt: null,
      lastError: null,
      // Domain verification block — analogous to twilio.a2p. DKIM records are
      // generated by the provider on connect; the user copies them into DNS,
      // then the Settings card polls /email/health until status flips to
      // 'verified'.
      domain: {
        status: 'not_started',    // 'not_started' | 'pending' | 'verified' | 'failed'
        dkimRecords: [],          // [{ host, type, value, status }]
        spfStatus: null,          // 'configured' | 'missing' | 'misconfigured'
        dmarcStatus: null,        // 'configured' | 'missing' | 'misconfigured'
        lastCheckedAt: null,
        failureReason: null,
      },
    },
  },
};

// ---------- Users ----------
// Default per-user notification preferences — every toggle defaults on,
// including mobilePushEnabled. The pref is "do you want push on devices
// where you're subscribed?" — separate from per-device subscription state,
// which still requires an explicit browser permission grant on each device.
export const DEFAULT_NOTIFICATION_PREFS = {
  newClientMessage: true,
  newDM: true,
  newInternalMessage: true,
  jobCreatedOrRescheduled: true,
  jobCancelled: true,
  accountOpsUpdated: true,
  keyCustody: true,
  keyLost: true,
  reminderFailed: true,
  problemReported: true,
  invoicePaid: true,
  invoiceOverdue: true,
  marketingReplyAssigned: true,
  inboxExpired: true,
  newLead: false, // opt-in (defaultOff in the catalog) — off until a manager enables it
  quoteSigned: true,
  supplyRequestSubmitted: true,
  supplyRequestCompleted: true,
  mobilePushEnabled: true,
};

// Default per-user email signature. `enabled` defaults on so a signature the
// user writes is auto-appended to new Messaging emails + replies/forwards; an
// empty signature is a no-op until they add text/image. Marketing email
// sequences do NOT use this — they build their own bodies independently.
// `imagePath` (C07) is a Supabase Storage object key; `imageDataUrl` is the legacy
// base64 copy that lived in this blob. BOTH are readable — resolveSignatureImage
// (src/lib/signature.js) prefers imagePath — so this is a purely ADDITIVE, default-safe
// field and needs NO version bump: nothing transforms existing data, and a reader that
// sees neither falls through to "no image". A user who re-uploads gets imagePath set
// and imageDataUrl cleared, which is what actually shrinks the blob.
export const DEFAULT_SIGNATURE_PREFS = {
  enabled: true,
  text: '',
  imageDataUrl: null,
  imagePath: null,
  imageWidth: 240,
};

// Clean Space demo roster: Matt + Dana own the business (Super Admin);
// Yolanda runs hiring/onboarding/accounting; Priya runs scheduling. Fictional
// names — a real clone's roster lands via Settings → Team → Add Member.
// `pay` (additive, default-safe → NO store-version bump; a user without it reads as
// unset → "Set pay" in Payroll). type ∈ hourly | salary | per_visit | none. The demo
// roster shows every pay type: owners take a draw (none), admins are salaried-exempt,
// crew are hourly, and Luis is per-visit (flat rate per completed clean).
const users = [
// `hr` (additive, default-safe → NO store-version bump; readers default {}). HR
// records: employeeId (auto EMP-#### on create, editable), hireDate (day-key),
// employmentType (full_time | part_time | contractor), ptoAllowanceDays (annual).
  { id: seedId('u', 'kyler'),   name: OWNER.name,        email: OWNER.email,                phone: '1-754-555-0101', role: 'owner', status: 'active', avatar: 1, initials: OWNER_INITIALS, createdAt: daysAgo(720), pay: { type: 'none' }, hr: { employeeId: 'EMP-0001', hireDate: '2024-09-02', employmentType: 'full_time', ptoAllowanceDays: 20 } },
  { id: seedId('u', 'steve'),   name: 'Dana Cole',       email: `dana@${BRAND_DOMAIN}`,     phone: '1-754-555-0102', role: 'owner', status: 'active', avatar: 2, initials: 'DC', createdAt: daysAgo(720), pay: { type: 'none' }, hr: { employeeId: 'EMP-0002', hireDate: '2024-09-02', employmentType: 'full_time', ptoAllowanceDays: 20 } },
  { id: seedId('u', 'heather'), name: 'Yolanda Reyes',   email: `yolanda@${BRAND_DOMAIN}`,  phone: '1-754-555-0103', role: 'admin', status: 'active', avatar: 3, initials: 'YR', createdAt: daysAgo(540), pay: { type: 'salary', salaryPerPeriod: 2400, otExempt: true }, hr: { employeeId: 'EMP-0003', hireDate: '2025-03-17', employmentType: 'full_time', ptoAllowanceDays: 18 } },
  { id: seedId('u', 'lauren'),  name: 'Priya Nair',      email: `priya@${BRAND_DOMAIN}`,    phone: '1-754-555-0104', role: 'admin', status: 'active', avatar: 4, initials: 'PN', createdAt: daysAgo(420), pay: { type: 'salary', salaryPerPeriod: 2400, otExempt: true }, hr: { employeeId: 'EMP-0004', hireDate: '2025-07-21', employmentType: 'full_time', ptoAllowanceDays: 18 } },
  // Manager demo persona (S35) — the new 4th tier. Defaults to full access (same as Super
  // Admin) and is pared back in Settings → Roles; seeded so the client can switch into a
  // Manager and see the tier gate the app in real time. Salaried (OT-exempt) on payroll.
  { id: seedId('u', 'mgr1'),    name: 'Renata Cruz',     email: `renata@${BRAND_DOMAIN}`,   phone: '1-754-555-0105', role: 'manager', status: 'active', avatar: 2, initials: 'RC', createdAt: daysAgo(360), pay: { type: 'salary', salaryPerPeriod: 2800, otExempt: true }, hr: { employeeId: 'EMP-0005', hireDate: '2025-09-19', employmentType: 'full_time', ptoAllowanceDays: 18 } },
  { id: seedId('u', 'crew1'),   name: 'Andre Baptiste',  email: `andre@${BRAND_DOMAIN}`,    phone: '1-754-555-0121', role: 'crew',  status: 'active', avatar: 5, initials: 'AB', createdAt: daysAgo(300), pay: { type: 'hourly', hourlyRate: 22 }, hr: { employeeId: 'EMP-0006', hireDate: '2025-11-18', employmentType: 'full_time', ptoAllowanceDays: 15 } },
  { id: seedId('u', 'crew2'),   name: 'Tomas Rivera',    email: `tomas@${BRAND_DOMAIN}`,    phone: '1-754-555-0122', role: 'crew',  status: 'active', avatar: 1, initials: 'TR', createdAt: daysAgo(220), pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0007', hireDate: '2026-02-06', employmentType: 'full_time', ptoAllowanceDays: 15 } },
  { id: seedId('u', 'crew3'),   name: 'Keisha Bryant',   email: `keisha@${BRAND_DOMAIN}`,   phone: '1-754-555-0123', role: 'crew',  status: 'active', avatar: 2, initials: 'KB', createdAt: daysAgo(180), pay: { type: 'hourly', hourlyRate: 21 }, hr: { employeeId: 'EMP-0008', hireDate: '2026-03-18', employmentType: 'full_time', ptoAllowanceDays: 15 } },
  { id: seedId('u', 'crew4'),   name: 'Luis Ferrer',     email: `luis@${BRAND_DOMAIN}`,     phone: '1-754-555-0124', role: 'crew',  status: 'active', avatar: 3, initials: 'LF', createdAt: daysAgo(120), pay: { type: 'per_visit', perVisitRate: 45 }, hr: { employeeId: 'EMP-0009', hireDate: '2026-05-17', employmentType: 'contractor', ptoAllowanceDays: 0 } },
  // Demo Crew — a permanent read-the-crew-view login the client can always sign
  // in with to see exactly what a field user sees. Created email-confirmed with a
  // set password via scripts/create-demo-crew.mjs (no real mailbox needed); kept
  // in the seed so every future clone ships the same demo account.
  { id: seedId('u', 'crewdemo'), name: 'Demo Crew',      email: `crew.demo@${BRAND_DOMAIN}`, phone: '', role: 'crew',  status: 'active', avatar: 4, initials: 'DM', createdAt: daysAgo(1), pay: { type: 'hourly', hourlyRate: 18 }, hr: { employeeId: 'EMP-0010', hireDate: '2026-09-13', employmentType: 'part_time', ptoAllowanceDays: 10 } },
].map((u) => ({ ...u, notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS }, signaturePrefs: { ...DEFAULT_SIGNATURE_PREFS } }));

// ---------- Services ----------
// Commercial cleaning catalog: general-commercial + specialized service lines.
// defaultPrice + billingUnit (WS-C revenue wiring) are additive/default-safe:
// readers default price to 0 and unit to 'per-visit'. They pre-fill invoice
// line items so the office isn't retyping catalog rates on every invoice.
// billingUnit ∈ 'per-visit' | 'monthly' | 'sq-ft'.
const services = [
  // General commercial
  { id: seedId('svc', 'jan'),   name: 'Commercial Janitorial',     defaultDurationMins:  90, defaultPrice: 350,  billingUnit: 'per-visit' },
  { id: seedId('svc', 'flr'),   name: 'Floor Care (strip & wax)',  defaultDurationMins: 180, defaultPrice: 650,  billingUnit: 'monthly'   },
  { id: seedId('svc', 'rst'),   name: 'Restroom Sanitation',       defaultDurationMins:  60, defaultPrice: 195,  billingUnit: 'per-visit' },
  { id: seedId('svc', 'deep'),  name: 'Deep Clean',                defaultDurationMins: 240, defaultPrice: 400,  billingUnit: 'per-visit' },
  // Specialized
  { id: seedId('svc', 'cpt'),   name: 'Carpet & Upholstery',       defaultDurationMins: 150, defaultPrice: 0.35, billingUnit: 'sq-ft'     },
  { id: seedId('svc', 'win'),   name: 'Window Cleaning',           defaultDurationMins:  90, defaultPrice: 285,  billingUnit: 'per-visit' },
  { id: seedId('svc', 'pw'),    name: 'Pressure Washing',          defaultDurationMins: 120, defaultPrice: 1500, billingUnit: 'per-visit' },
  { id: seedId('svc', 'pc'),    name: 'Post-Construction',         defaultDurationMins: 240, defaultPrice: 950,  billingUnit: 'per-visit' },
];

// Look up a service id by key (jan/flr/rst/deep/cpt/win/pw/pc). Client + job seed
// references go through this so they don't depend on array position: removing or
// reordering a service can never silently repoint another account.
const svc = (key) => seedId('svc', key);

const frequencies = [
  { id: seedId('frq', 'wk'),   label: 'Weekly' },
  { id: seedId('frq', 'biwk'), label: 'Bi-Weekly' },
  { id: seedId('frq', 'mo'),   label: 'Monthly' },
  { id: seedId('frq', 'qr'),   label: 'Quarterly' },
  { id: seedId('frq', 'as'),   label: 'As-Needed' },
];

// ---------- Tags ----------
// Lead-source tags per Q1 (Referral / Call-In / Web Form / Email Campaign).
// Plus standard scope tags (VIP, Commercial, Hot Lead, Net-30, DND). Tags are
// free-form; the office adds whatever they like beyond these seeded examples.
const tags = [
  // Lead sources
  { id: seedId('tg', 'referral'),    label: 'Referral',          color: 'green',  scope: 'contact' },
  { id: seedId('tg', 'callin'),      label: 'Call-In',           color: 'blue',   scope: 'contact' },
  { id: seedId('tg', 'webform'),     label: 'Web Form',          color: 'purple', scope: 'contact' },
  { id: seedId('tg', 'emailcamp'),   label: 'Email Campaign',    color: 'amber',  scope: 'contact' },
  // Status / priority
  { id: seedId('tg', 'vip'),         label: 'VIP',               color: 'red',    scope: 'all'     },
  { id: seedId('tg', 'hotlead'),     label: 'Hot Lead',          color: 'red',    scope: 'contact' },
  { id: seedId('tg', 'net30'),       label: 'Net-30',            color: 'blue',   scope: 'all'     },
  { id: seedId('tg', 'needsquote'),  label: 'Needs Quote',       color: 'amber',  scope: 'contact' },
  // Segment
  { id: seedId('tg', 'commercial'),  label: 'Commercial',        color: 'slate',  scope: 'all'     },
  { id: seedId('tg', 'specialized'), label: 'Specialized',       color: 'purple', scope: 'all'     },
  { id: seedId('tg', 'dnd'),         label: 'Do Not Disturb',    color: 'slate',  scope: 'contact' },
];

const tagId = (key) => seedId('tg', key);

// ---------- Pipelines & Opportunities ----------
// ONE real pipeline (the "Master" board). Cards on it are Opportunities (deals),
// each owned by a COMPANY and shown company-first. These are the real stages a
// commercial-cleaning deal moves through (lead -> talk -> walk the site -> bid ->
// close). Won/Lost are terminal; moving an opportunity to Won flips its company to
// Active. Stages are editable in-app. (The old 1.1/1.2/1.3 placeholder boards and
// the Master "meta-board" that rolled them up are gone.)
const pipelines = [
  {
    id: seedId('pl', 'master'),
    label: 'Master Pipeline',
    isMaster: true,
    createdAt: daysAgo(420),
    stages: [
      { id: seedId('ps', 'new-lead'),    key: 'new-lead',    label: 'New Lead' },
      { id: seedId('ps', 'contacted'),   key: 'contacted',   label: 'Contacted' },
      { id: seedId('ps', 'walkthrough'), key: 'walkthrough', label: 'Walkthrough Scheduled' },
      { id: seedId('ps', 'proposal'),    key: 'proposal',    label: 'Proposal Sent' },
      { id: seedId('ps', 'negotiation'), key: 'negotiation', label: 'Negotiation' },
      { id: seedId('ps', 'won'),         key: 'won',         label: 'Won' },
      { id: seedId('ps', 'lost'),        key: 'lost',        label: 'Lost' },
    ],
  },
  // A second board for retaining existing accounts (contract renewals + upsells),
  // its own stages. Won/Lost keep the 'won'/'lost' keys so the terminal-stage
  // status logic still fires; only the ids/labels differ.
  {
    id: seedId('pl', 'renewals'),
    label: 'Renewals & Upsells',
    createdAt: daysAgo(300),
    stages: [
      { id: seedId('ps', 'ren-due'),      key: 'renewal-due',      label: 'Up for Renewal' },
      { id: seedId('ps', 'ren-outreach'), key: 'renewal-outreach', label: 'Outreach Sent' },
      { id: seedId('ps', 'ren-review'),   key: 'renewal-review',   label: 'Reviewing Terms' },
      { id: seedId('ps', 'ren-upsell'),   key: 'renewal-upsell',   label: 'Upsell Offered' },
      { id: seedId('ps', 'ren-won'),      key: 'won',              label: 'Renewed' },
      { id: seedId('ps', 'ren-lost'),     key: 'lost',             label: 'Churned' },
    ],
  },
  // A third board for one-off jobs (post-construction, deep cleans, turnovers)
  // that never become recurring contracts.
  {
    id: seedId('pl', 'projects'),
    label: 'One-Time Projects',
    createdAt: daysAgo(180),
    stages: [
      { id: seedId('ps', 'proj-request'),   key: 'project-request',   label: 'Request Received' },
      { id: seedId('ps', 'proj-assess'),    key: 'project-assess',    label: 'Site Assessment' },
      { id: seedId('ps', 'proj-quote'),     key: 'project-quote',     label: 'Quote Sent' },
      { id: seedId('ps', 'proj-scheduled'), key: 'project-scheduled', label: 'Scheduled' },
      { id: seedId('ps', 'proj-won'),       key: 'won',               label: 'Won' },
      { id: seedId('ps', 'proj-lost'),      key: 'lost',              label: 'Lost' },
    ],
  },
];

// Opportunities: company-owned deals on the pipeline. Each belongs to exactly one
// COMPANY (clientId); the card shows the company first, its primary contact below.
// value replaces the old per-person dealValue; status is 'open' | 'won' | 'lost'.
// Seeded onto the prospect companies so the board isn't empty. Active customers
// (Las Olas, Palmetto) are already won business and are NOT put back on the board.
const opportunities = [
  { id: seedId('opp', 'aventura'),  clientId: seedId('cl', 'aventura'),   primaryContactId: seedId('ct', 'jamiep'),  title: 'Aventura Dental. Janitorial contract',  value: 2400, pipelineId: seedId('pl', 'master'), stage: 'walkthrough', status: 'open', expectedCloseDate: daysFromNow(30), stageChangedAt: daysAgo(2),  createdAt: daysAgo(2) },
  { id: seedId('opp', 'northside'), clientId: seedId('cl', 'northside'),  primaryContactId: seedId('ct', 'morganns'),title: 'Northside Auto. 3-location janitorial',  value: 4500, pipelineId: seedId('pl', 'master'), stage: 'proposal',    status: 'open', expectedCloseDate: daysFromNow(10), stageChangedAt: daysAgo(1),  createdAt: daysAgo(14) },
  { id: seedId('opp', 'coralgab'),  clientId: seedId('cl', 'coralgables'),primaryContactId: seedId('ct', 'taylor'),  title: 'Coral Gables Architects. Post-construction + recurring', value: 3200, pipelineId: seedId('pl', 'master'), stage: 'negotiation', status: 'open', expectedCloseDate: daysFromNow(14), stageChangedAt: daysAgo(3),  createdAt: daysAgo(12) },
  { id: seedId('opp', 'biscayne'),  clientId: seedId('cl', 'biscayne'),   primaryContactId: seedId('ct', 'robin'),   title: 'Biscayne Harbor. Common-area cleaning',  value: 1800, pipelineId: seedId('pl', 'master'), stage: 'contacted',   status: 'open', expectedCloseDate: daysFromNow(21), stageChangedAt: daysAgo(5),  createdAt: daysAgo(8) },
  { id: seedId('opp', 'riverwalk'), clientId: seedId('cl', 'riverwalk'),  primaryContactId: seedId('ct', 'sambrew'), title: 'Riverwalk Brewing. Taproom bi-weekly',   value: 2100, pipelineId: seedId('pl', 'master'), stage: 'new-lead',    status: 'open', expectedCloseDate: daysFromNow(20), stageChangedAt: daysAgo(6),  createdAt: daysAgo(10) },
  // Renewals & Upsells board — existing customers up for contract renewal.
  { id: seedId('opp', 'ren-lasolas'),  clientId: seedId('cl', 'evergreen'), primaryContactId: seedId('ct', 'pat'),     title: 'Las Olas Medical. Annual janitorial renewal',        value: 5400, pipelineId: seedId('pl', 'renewals'), stage: 'renewal-review',   status: 'open', expectedCloseDate: daysFromNow(25), stageChangedAt: daysAgo(4), createdAt: daysAgo(40) },
  { id: seedId('opp', 'ren-palmetto'), clientId: seedId('cl', 'pacridge'),  primaryContactId: seedId('ct', 'kim'),     title: 'Palmetto Ridge. Contract renewal',                   value: 3400, pipelineId: seedId('pl', 'renewals'), stage: 'renewal-outreach', status: 'open', expectedCloseDate: daysFromNow(35), stageChangedAt: daysAgo(2), createdAt: daysAgo(30) },
  { id: seedId('opp', 'ren-lakeside'), clientId: seedId('cl', 'lakeside'),  primaryContactId: seedId('ct', 'morganc'), title: 'Lakeside Office Park. Renewal',                      value: 2200, pipelineId: seedId('pl', 'renewals'), stage: 'renewal-due',      status: 'open', expectedCloseDate: daysFromNow(45), stageChangedAt: daysAgo(1), createdAt: daysAgo(20) },
  { id: seedId('opp', 'ren-bayshore'), clientId: seedId('cl', 'olympic'),   primaryContactId: seedId('ct', 'lee'),     title: 'Bayshore Senior Living. Add restroom + floor care',  value: 3600, pipelineId: seedId('pl', 'renewals'), stage: 'renewal-upsell',   status: 'open', expectedCloseDate: daysFromNow(18), stageChangedAt: daysAgo(3), createdAt: daysAgo(22) },
  { id: seedId('opp', 'ren-coralbay'), clientId: seedId('cl', 'mtbaker'),   primaryContactId: seedId('ct', 'sasha'),   title: 'Coral Bay HOA. Renewal',                             value: 1100, pipelineId: seedId('pl', 'renewals'), stage: 'renewal-review',   status: 'open', expectedCloseDate: daysFromNow(28), stageChangedAt: daysAgo(6), createdAt: daysAgo(26) },
  // One-Time Projects board — post-construction, deep cleans, turnovers.
  { id: seedId('opp', 'proj-gulfstream'), clientId: seedId('cl', 'cascade'),    primaryContactId: seedId('ct', 'dana'),   title: 'Gulfstream Logistics. Warehouse deep clean',             value: 1500, pipelineId: seedId('pl', 'projects'), stage: 'project-assess',    status: 'open', expectedCloseDate: daysFromNow(12), stageChangedAt: daysAgo(2), createdAt: daysAgo(6) },
  { id: seedId('opp', 'proj-flagler'),    clientId: seedId('cl', 'salishan'),   primaryContactId: seedId('ct', 'quinn'),  title: 'Flagler Townhomes. Post-renovation turnover',            value: 950,  pipelineId: seedId('pl', 'projects'), stage: 'project-request',   status: 'open', expectedCloseDate: daysFromNow(30), stageChangedAt: daysAgo(1), createdAt: daysAgo(3) },
  { id: seedId('opp', 'proj-coralgab'),   clientId: seedId('cl', 'coralgables'),primaryContactId: seedId('ct', 'taylor'), title: 'Coral Gables Architects. Post-construction final clean', value: 2800, pipelineId: seedId('pl', 'projects'), stage: 'project-quote',     status: 'open', expectedCloseDate: daysFromNow(15), stageChangedAt: daysAgo(3), createdAt: daysAgo(9) },
  { id: seedId('opp', 'proj-aventura'),   clientId: seedId('cl', 'aventura'),   primaryContactId: seedId('ct', 'jamiep'), title: 'Aventura Dental. Pre-opening deep clean',                value: 1200, pipelineId: seedId('pl', 'projects'), stage: 'project-scheduled', status: 'open', expectedCloseDate: daysFromNow(8),  stageChangedAt: daysAgo(1), createdAt: daysAgo(5) },
];

// ---------- Clients ----------
// Demo clients: FL commercial accounts only (offices, medical, logistics, HOAs,
// senior living, warehouses). Every row is a business/company. Clean Space's real
// book of business lands via CSV import ($200 add-on); this populates the UI for
// training/handoff and exercises every entity surface.
// primaryContactId is wired below after contacts are defined.
const clients = [
  { id: seedId('cl', 'evergreen'), name: 'Las Olas Medical Group', primaryContact: 'Pat Ramirez',  primaryContactId: null, supervisorId: seedId('u', 'mgr1'), email: 'pat@lasolasmed.com',     phone: '(754) 555-0201', serviceId: svc('jan'), frequencyId: frequencies[0].id, revenue: 5400, tagIds: [tagId('vip'), tagId('commercial'), tagId('referral')], notes: '',          lastServiceAt: daysAgo(1),  createdAt: daysAgo(420) },
  { id: seedId('cl', 'lakeside'),  name: 'Lakeside Office Park',    primaryContact: 'Morgan Choi',  primaryContactId: null, email: 'morgan@lakesideop.com',    phone: '(754) 555-0202', serviceId: svc('flr'), frequencyId: frequencies[2].id, revenue: 2200, tagIds: [tagId('net30'), tagId('commercial'), tagId('callin')], notes: '',                                                lastServiceAt: daysAgo(5),  createdAt: daysAgo(380) },
  { id: seedId('cl', 'cascade'),   name: 'Gulfstream Logistics',       primaryContact: 'Dana Park',    primaryContactId: null, email: 'dana@gulfstreamlog.com',      phone: '(754) 555-0203', serviceId: svc('pw'), frequencyId: frequencies[3].id, revenue: 1800, tagIds: [tagId('commercial'), tagId('webform')], notes: 'Bay 3 only; gate code #4421.',                    lastServiceAt: daysAgo(18), createdAt: daysAgo(340) },
  { id: seedId('cl', 'mtbaker'),   name: 'Coral Bay HOA',           primaryContact: 'Sasha Lin',    primaryContactId: null, supervisorId: seedId('u', 'mgr1'), crewChecklists: { [seedId('u', 'crew1')]: 'it_floorcare', [seedId('u', 'crew2')]: 'it_fullclean' }, email: 'sasha@coralbayhoa.org',     phone: '(754) 555-0204', serviceId: svc('win'), frequencyId: frequencies[2].id, revenue: 1100, tagIds: [tagId('referral')], notes: '',                                                lastServiceAt: daysAgo(10), createdAt: daysAgo(210) },
  { id: seedId('cl', 'pacridge'),  name: 'Palmetto Ridge Corp',      primaryContact: 'Kim Nelson',   primaryContactId: null, supervisorId: seedId('u', 'heather'), email: 'kim@palmettoridge.com',         phone: '(754) 555-0205', serviceId: svc('jan'), frequencyId: frequencies[1].id, revenue: 3400, tagIds: [tagId('commercial'), tagId('vip'), tagId('callin')], notes: 'Security badge required; pick up at front desk.', lastServiceAt: daysAgo(3),  createdAt: daysAgo(500) },
  { id: seedId('cl', 'olympic'),   name: 'Bayshore Senior Living',   primaryContact: 'Lee Thompson', primaryContactId: null, supervisorId: seedId('u', 'lauren'), email: 'lee@bayshoresl.com',        phone: '(754) 555-0206', serviceId: svc('rst'), frequencyId: frequencies[0].id, revenue: 2800, tagIds: [], notes: '',                                                lastServiceAt: daysAgo(0),  createdAt: daysAgo(150) },
  { id: seedId('cl', 'salishan'),  name: 'Flagler Townhomes',      primaryContact: 'Quinn Reyes',  primaryContactId: null, email: 'quinn@flaglertownhomes.com',       phone: '(754) 555-0207', serviceId: svc('jan'), frequencyId: frequencies[1].id, revenue: 950,  tagIds: [tagId('needsquote')], notes: 'On hold. Renovation through Q2.',                lastServiceAt: daysAgo(28), createdAt: daysAgo(90) },
  // Prospective customers (Client-primary reshape): the former floating leads are now
  // real accounts, so every person belongs to exactly one customer. Status 'prospect'.
  { id: seedId('cl', 'aventura'),   name: 'Aventura Dental Group',      primaryContact: 'Jamie Park',   primaryContactId: seedId('ct', 'jamiep'),  email: 'jamie@aventuradental.com',   phone: '(754) 555-0301', serviceId: svc('jan'), frequencyId: frequencies[0].id, revenue: 0, tagIds: [tagId('hotlead'), tagId('needsquote'), tagId('webform')], notes: 'Inbound via website form. 4 operatories.',                 lastServiceAt: null, createdAt: daysAgo(2) },
  { id: seedId('cl', 'biscayne'),   name: 'Biscayne Harbor Apartments', primaryContact: 'Robin Vega',   primaryContactId: seedId('ct', 'robin'),   email: 'robin@biscayneharbor.co',    phone: '(754) 555-0302', serviceId: svc('win'), frequencyId: frequencies[2].id, revenue: 0, tagIds: [tagId('emailcamp')],                 notes: '84 units. Common-area cleaning.',                          lastServiceAt: null, createdAt: daysAgo(8) },
  { id: seedId('cl', 'coralgables'),name: 'Coral Gables Architects',    primaryContact: 'Taylor Brooks',primaryContactId: seedId('ct', 'taylor'),  email: 'taylor@coralgablesarch.com', phone: '(754) 555-0303', serviceId: svc('jan'), frequencyId: frequencies[1].id, revenue: 0, tagIds: [tagId('commercial'), tagId('referral')],                    notes: 'Referred by Kim Nelson. Post-construction + recurring.',   lastServiceAt: null, createdAt: daysAgo(12) },
  { id: seedId('cl', 'sunshine'),   name: 'Sunshine Supply Co',         primaryContact: 'Alex Rivera',  primaryContactId: seedId('ct', 'evvendor'),email: 'alex@sunshinesupply.com',    phone: '(754) 555-0304', serviceId: svc('jan'), frequencyId: frequencies[0].id, revenue: 0, tagIds: [tagId('dnd')],                                              notes: 'Cleaning supplies vendor. Net-15.',                       lastServiceAt: null, createdAt: daysAgo(200) },
  { id: seedId('cl', 'northside'),  name: 'Northside Auto Group',       primaryContact: 'Morgan Hayes', primaryContactId: seedId('ct', 'morganns'),email: 'morgan.hayes@nsauto.com',    phone: '(754) 555-0305', serviceId: svc('flr'), frequencyId: frequencies[2].id, revenue: 0, tagIds: [tagId('hotlead'), tagId('commercial'), tagId('callin')],    notes: '3 locations. Quote sent. Waiting on decision.',            lastServiceAt: null, createdAt: daysAgo(14) },
  { id: seedId('cl', 'riverwalk'),  name: 'Riverwalk Brewing Co',       primaryContact: 'Sam Blake',    primaryContactId: seedId('ct', 'sambrew'), email: 'sam@riverwalkbrewing.com',   phone: '(754) 555-0306', serviceId: svc('rst'), frequencyId: frequencies[1].id, revenue: 0, tagIds: [tagId('commercial'), tagId('emailcamp')],                   notes: 'Taproom. Bi-weekly. Budget confirmed.',                    lastServiceAt: null, createdAt: daysAgo(10) },
];

// ---------- Contacts ----------
// 13 customers (7 active + 6 prospects); every contact belongs to exactly one.
const contacts = [
  // Clients
  { id: seedId('ct', 'pat'),       email: 'pat@lasolasmed.com',  firstName: 'Pat',     lastName: 'Ramirez',  title: 'Director of Facilities', phone: '(754) 555-0201', companyId: clients[0].id, tagIds: [tagId('vip'), tagId('commercial'), tagId('referral')],     lifecycle: 'client', stage: 'check-in-12m', pipelineId: seedId('pl', 'clients'), dealValue: null, expectedCloseDate: null, stageChangedAt: daysAgo(420), notes: 'Primary decision maker. Responsive to texts.',          customFields: {}, createdAt: daysAgo(420), updatedAt: daysAgo(1) },
  { id: seedId('ct', 'morganc'),   email: 'morgan@lakesideop.com',  firstName: 'Morgan',  lastName: 'Choi',     title: 'Office Manager',         phone: '(754) 555-0202', companyId: clients[1].id, tagIds: [tagId('net30'), tagId('commercial'), tagId('callin')],      lifecycle: 'client', stage: null, pipelineId: null, dealValue: null, expectedCloseDate: null, stageChangedAt: daysAgo(380), notes: 'Net-30 terms. Prefers email.',                          customFields: {}, createdAt: daysAgo(380), updatedAt: daysAgo(5) },
  { id: seedId('ct', 'dana'),      email: 'dana@gulfstreamlog.com',    firstName: 'Dana',    lastName: 'Park',     title: 'Operations Lead',        phone: '(754) 555-0203', companyId: clients[2].id, tagIds: [tagId('commercial'), tagId('webform')],                     lifecycle: 'client', stage: null, pipelineId: null, dealValue: null, expectedCloseDate: null, stageChangedAt: daysAgo(340), notes: '',                                                      customFields: {}, createdAt: daysAgo(340), updatedAt: daysAgo(18) },
  { id: seedId('ct', 'sasha'),     email: 'sasha@coralbayhoa.org',   firstName: 'Sasha',   lastName: 'Lin',      title: 'HOA Board President',    phone: '(754) 555-0204', companyId: clients[3].id, tagIds: [tagId('referral')],                   lifecycle: 'client', stage: null, pipelineId: null, dealValue: null, expectedCloseDate: null, stageChangedAt: daysAgo(210), notes: 'Referred by Palmetto Ridge.',                            customFields: {}, createdAt: daysAgo(210), updatedAt: daysAgo(10) },
  { id: seedId('ct', 'kim'),       email: 'kim@palmettoridge.com',       firstName: 'Kim',     lastName: 'Nelson',   title: 'Facility Coordinator',   phone: '(754) 555-0205', companyId: clients[4].id, tagIds: [tagId('commercial'), tagId('vip'), tagId('callin')],         lifecycle: 'client', stage: 'check-in-6m', pipelineId: seedId('pl', 'clients'), dealValue: null, expectedCloseDate: null, stageChangedAt: daysAgo(500), notes: 'Largest client. Quarterly business reviews.',          customFields: {}, createdAt: daysAgo(500), updatedAt: daysAgo(3) },
  { id: seedId('ct', 'lee'),       email: 'lee@bayshoresl.com',      firstName: 'Lee',     lastName: 'Thompson', title: 'Resident Services Dir.', phone: '(754) 555-0206', companyId: clients[5].id, tagIds: [],                                       lifecycle: 'client', stage: null, pipelineId: null, dealValue: null, expectedCloseDate: null, stageChangedAt: daysAgo(150), notes: '',                                                      customFields: {}, createdAt: daysAgo(150), updatedAt: daysAgo(0) },
  { id: seedId('ct', 'quinn'),     email: 'quinn@flaglertownhomes.com',     firstName: 'Quinn',   lastName: 'Reyes',    title: 'HOA Manager',            phone: '(754) 555-0207', companyId: clients[6].id, tagIds: [tagId('needsquote')],                  lifecycle: 'client', stage: null, pipelineId: null, dealValue: null, expectedCloseDate: null, stageChangedAt: daysAgo(90),  notes: 'On hold through Q2.',                                   customFields: {}, createdAt: daysAgo(90),  updatedAt: daysAgo(28) },

  // Leads / prospects / vendor
  { id: seedId('ct', 'jamiep'),    email: 'jamie@aventuradental.com', firstName: 'Jamie',   lastName: 'Park',   title: 'Practice Manager', phone: '(754) 555-0301', companyId: clients[7].id, tagIds: [tagId('hotlead'), tagId('needsquote'), tagId('webform')],     lifecycle: 'lead',     stage: 'intake',          pipelineId: seedId('pl', 'master'), dealValue: 2400, expectedCloseDate: daysFromNow(30), stageChangedAt: daysAgo(2),  notes: 'Inbound via website form. Aventura Dental Group. 4 operatories.', customFields: { company: 'Aventura Dental Group' },     createdAt: daysAgo(2),  updatedAt: daysAgo(2) },
  { id: seedId('ct', 'robin'),     email: 'robin@biscayneharbor.co',       firstName: 'Robin',   lastName: 'Vega',   title: 'Property Manager', phone: '(754) 555-0302', companyId: clients[8].id, tagIds: [tagId('emailcamp')],                     lifecycle: 'lead',     stage: 'nurture-campaign', pipelineId: seedId('pl', 'leads'),  dealValue: 1800, expectedCloseDate: daysFromNow(21), stageChangedAt: daysAgo(5),  notes: 'Biscayne Harbor Apartments. 84 units. Common-area cleaning.',          customFields: { company: 'Biscayne Harbor Apartments' },     createdAt: daysAgo(8),  updatedAt: daysAgo(5) },
  { id: seedId('ct', 'taylor'),    email: 'taylor@coralgablesarch.com',    firstName: 'Taylor',  lastName: 'Brooks', title: 'Office Manager',   phone: '(754) 555-0303', companyId: clients[9].id, tagIds: [tagId('commercial'), tagId('referral')],                       lifecycle: 'prospect', stage: 'walkthrough',      pipelineId: seedId('pl', 'sales'),  dealValue: 3200, expectedCloseDate: daysFromNow(14), stageChangedAt: daysAgo(3),  notes: 'Referred by Kim Nelson. Moving offices. Needs post-construction + recurring janitorial.', customFields: { company: 'Coral Gables Architects' }, createdAt: daysAgo(12), updatedAt: daysAgo(3) },
  { id: seedId('ct', 'evvendor'),  email: 'alex@sunshinesupply.com',  firstName: 'Alex',    lastName: 'Rivera', title: 'Account Rep',      phone: '(754) 555-0304', companyId: clients[10].id, tagIds: [tagId('dnd')], doNotContact: true,                                                  lifecycle: 'vendor',   stage: null,           pipelineId: null,                    dealValue: null, expectedCloseDate: null,            stageChangedAt: daysAgo(60), notes: 'Cleaning supplies vendor. Net-15.',                                  customFields: { company: 'Sunshine Supply Co' },        createdAt: daysAgo(200), updatedAt: daysAgo(60) },
  { id: seedId('ct', 'morganns'),  email: 'morgan.hayes@nsauto.com',   firstName: 'Morgan',  lastName: 'Hayes',  title: 'Operations Manager', phone: '(754) 555-0305', companyId: clients[11].id, tagIds: [tagId('hotlead'), tagId('commercial'), tagId('callin')],       lifecycle: 'lead',     stage: 'estimate-phone',   pipelineId: seedId('pl', 'sales'),  dealValue: 4500, expectedCloseDate: daysFromNow(10), stageChangedAt: daysAgo(1),  notes: 'Northside Auto Group. 3 locations. Quote sent. Waiting on decision.', customFields: { company: 'Northside Auto Group' },     createdAt: daysAgo(14), updatedAt: daysAgo(1) },
  { id: seedId('ct', 'sambrew'),   email: 'sam@riverwalkbrewing.com',     firstName: 'Sam',     lastName: 'Blake',  title: 'General Manager',  phone: '(754) 555-0306', companyId: clients[12].id, tagIds: [tagId('commercial'), tagId('emailcamp')],                       lifecycle: 'prospect', stage: 'walkthrough',      pipelineId: seedId('pl', 'sales'),  dealValue: 2100, expectedCloseDate: daysFromNow(20), stageChangedAt: daysAgo(6),  notes: 'Riverwalk Brewing Co taproom. Bi-weekly. Budget confirmed.',          customFields: { company: 'Riverwalk Brewing Co' },          createdAt: daysAgo(10), updatedAt: daysAgo(6) },
];

// People never sit on a pipeline anymore: deals are company-owned Opportunities
// (see `opportunities` above). Strip the legacy per-person pipeline/deal fields so
// no person carries a stage. (`lifecycle` stays for now: it still feeds stale-leads
// + marketing filters, which are not the sales pipeline.)
contacts.forEach((c) => {
  delete c.stage; delete c.pipelineId; delete c.dealValue;
  delete c.expectedCloseDate; delete c.stageChangedAt;
});

// Wire primaryContactId on clients now that contacts exist.
clients[0].primaryContactId = contacts[0].id; // Pat
clients[1].primaryContactId = contacts[1].id; // Morgan
clients[2].primaryContactId = contacts[2].id; // Dana
clients[3].primaryContactId = contacts[3].id; // Sasha
clients[4].primaryContactId = contacts[4].id; // Kim
clients[5].primaryContactId = contacts[5].id; // Lee
clients[6].primaryContactId = contacts[6].id; // Quinn

// Each company's primary contact is also its default Billing contact — a
// company-level role designation reassigned via the Contacts-tab toggles. The Site
// contact role is the account location's `siteContactId` (seeded on the site records
// below), NOT a company-level FK. It coexists with the per-invoice billingContactId,
// which stays operational.
clients.forEach((c) => {
  c.billingContactId = c.primaryContactId;
});

// Contact # (friendly sequential id), Type (Customer/Vendor), and structured
// account address for each company. Clean Space cleans commercial accounts only,
// so every row is a business; Sunshine Supply Co is the one Vendor (a supplier we
// buy from, kept out of every sales view). Status (Lead/Active) stays derived.
const CLIENT_ADDRESSES = [
  ['500 SE 3rd Ave',      'Fort Lauderdale', 'FL', '33301'], // Las Olas Medical Group
  ['200 E Las Olas Blvd', 'Fort Lauderdale', 'FL', '33301'], // Lakeside Office Park
  ['1800 NW 22nd St',     'Miami',           'FL', '33142'], // Gulfstream Logistics
  ['120 Royal Palm Way',  'Boca Raton',      'FL', '33432'], // Coral Bay HOA
  ['88 SE 6th St',        'Miami',           'FL', '33131'], // Palmetto Ridge Corp
  ['1515 S Flagler Dr',   'West Palm Beach', 'FL', '33401'], // Bayshore Senior Living
  ['900 S Congress Ave',  'Delray Beach',    'FL', '33445'], // Flagler Townhomes
  ['21000 NE 28th Ave',   'Aventura',        'FL', '33180'], // Aventura Dental Group
  ['1800 N Bayshore Dr',  'Miami',           'FL', '33132'], // Biscayne Harbor Apartments
  ['2601 S Bayshore Dr',  'Coral Gables',    'FL', '33133'], // Coral Gables Architects
  ['4000 NW 36th St',     'Miami',           'FL', '33142'], // Sunshine Supply Co (Vendor)
  ['5000 N Federal Hwy',  'Fort Lauderdale', 'FL', '33308'], // Northside Auto Group
  ['300 SW 2nd St',       'Fort Lauderdale', 'FL', '33312'], // Riverwalk Brewing Co
];
clients.forEach((cl, i) => {
  cl.contactNumber = 1001 + i;
  cl.type = cl.id === seedId('cl', 'sunshine') ? 'vendor' : 'customer';
  const [street, city, st, zip] = CLIENT_ADDRESSES[i] || ['', '', '', ''];
  cl.street = street; cl.city = city; cl.state = st; cl.zip = zip;
});

// Customer-level billing settings (Overview → Billing information). Additive +
// default-safe; the same defaults the v53 store migration backfills onto older data.
clients.forEach((cl) => { Object.assign(cl, { ...CLIENT_BILLING_DEFAULTS }); });

// ---------- Locations ----------
// One location per customer (the multi-site model was collapsed 2026-09-10). Each
// active account keeps its single service location; geofencing is ALWAYS ON (no
// per-site opt-out). evgrn-main + pac-tower carry real coords + geocodedAddress so
// the clock-in geofence can be demoed live via a DevTools Sensors location spoof
// (DEMO_RUNBOOK.md). Locations without coords still read "on" but pass through at
// clock-in (geofenceVerdict → no_site_coords). expectedCleanMins on every location
// is the variance baseline — without it a variance row reads "No baseline". A
// location is still a `site` internally (the operational key for jobs/keys/geofence/
// variance/media, and the server's site_id at go-live). The 5 prospect customers get
// a location synthesized from their address just below; the vendor gets none.
const sites = [
  { id: seedId('st', 'evgrn-main'),  clientId: clients[0].id, siteContactId: contacts[0].id, name: 'Main Hospital',    address: '500 SE 3rd Ave, Fort Lauderdale, FL 33301',    geocodedAddress: '500 SE 3rd Ave, Fort Lauderdale, FL 33301', accessNotes: 'Loading dock B after 7 PM',  lat: 26.1180, lng: -80.1373, geofenceEnabled: true,  expectedCleanMins: 120, createdAt: daysAgo(420) },
  { id: seedId('st', 'lake-main'),   clientId: clients[1].id, siteContactId: contacts[1].id, name: 'Main Campus',      address: '200 E Las Olas Blvd, Fort Lauderdale, FL 33301', accessNotes: '',                          lat: 26.1196, lng: -80.1400, geofenceEnabled: true, expectedCleanMins: 120, createdAt: daysAgo(380) },
  { id: seedId('st', 'csc-main'),    clientId: clients[2].id, siteContactId: contacts[2].id, name: 'Warehouse 1',      address: '1800 NW 22nd St, Miami, FL 33142',            accessNotes: 'Loading bay only',            lat: 25.8012, lng: -80.2345, geofenceEnabled: true, expectedCleanMins: 150, createdAt: daysAgo(340) },
  { id: seedId('st', 'mtb-clbhs'),   clientId: clients[3].id, siteContactId: contacts[3].id, name: 'Clubhouse',        address: '120 Royal Palm Way, Boca Raton, FL 33432',    accessNotes: '',                            lat: 26.3478, lng: -80.0831, geofenceEnabled: true, expectedCleanMins: 90,  createdAt: daysAgo(210) },
  { id: seedId('st', 'pac-tower'),   clientId: clients[4].id, siteContactId: contacts[4].id, name: 'Tower A',          address: '88 SE 6th St, Miami, FL 33131',               geocodedAddress: '88 SE 6th St, Miami, FL 33131', accessNotes: 'Front desk badge',            lat: 25.7690, lng: -80.1905, geofenceEnabled: true,  expectedCleanMins: 120, createdAt: daysAgo(500) },
  { id: seedId('st', 'oly-main'),    clientId: clients[5].id, siteContactId: contacts[5].id, name: 'Main Residence',   address: '1515 S Flagler Dr, West Palm Beach, FL 33401', accessNotes: 'Service entrance',           expectedCleanMins: 90,  createdAt: daysAgo(150) },
  { id: seedId('st', 'sal-main'),    clientId: clients[6].id, siteContactId: contacts[6].id, name: 'Common Area',      address: '900 S Congress Ave, Delray Beach, FL 33445',  accessNotes: 'On hold until Q2',            expectedCleanMins: 90,  createdAt: daysAgo(90) },
];

// Every customer has exactly one location. The prospect customers (no operational
// site yet) each get one synthesized from their account address; the vendor
// (Sunshine Supply) is not a customer and gets none. Uses the same builder as the
// v53 migration + ADD_CLIENT so a customer minted by any path is identical.
clients.forEach((c) => {
  if (clientGetsLocation(c) && !sites.some((st) => st.clientId === c.id)) {
    sites.push(buildClientLocation(c, services));
  }
});

const siteFor = (clientKey) => sites.find((s) => s.id === seedId('st', clientKey));

// ---------- Keys (check-in / check-out) ----------
// Physical keys belong to a customer's location (siteId), with the company derived
// via the location. Every customer has exactly one location, so a key auto-files
// there. siteId is required, there is no company-wide / general key storage.
// clientName/siteName are denormalized so a row survives a later rename/delete,
// same convention as elsewhere.
const mkKey = (kk, client, site, label, extra = {}) => ({
  id: seedId('key', kk),
  clientId: client?.id ?? null, clientName: client?.name ?? '',
  siteId: site?.id ?? null, siteName: site?.name ?? '',
  masterCode: extra.masterCode ?? '', label,
  status: extra.status ?? 'in',
  heldByUserId: extra.heldByUserId ?? null, heldByName: extra.heldByName ?? null,
  notes: extra.notes ?? '',
  createdAt: daysAgo(extra.age ?? 220), updatedAt: daysAgo(extra.upd ?? 30),
});
const keys = [
  // Las Olas Medical Group
  mkKey('evg-1', clients[0], siteFor('evgrn-main'), 'EV-MH-01', { masterCode: 'EV-MH', notes: 'Main lobby + loading dock B', status: 'out', heldByUserId: seedId('u', 'crew1') }),
  mkKey('evg-2', clients[0], siteFor('evgrn-main'), 'EV-MH-02', { masterCode: 'EV-MH', notes: 'After-hours staff entrance' }),
  // Palmetto Ridge Corp
  mkKey('pac-1', clients[4], siteFor('pac-tower'), 'PR-TA-01', { masterCode: 'PR-TA', notes: 'Badge from front desk', status: 'out', heldByUserId: seedId('u', 'crew4') }),
  // Coral Bay HOA
  mkKey('mtb-1', clients[3], siteFor('mtb-clbhs'), 'MB-CH-01', { notes: 'Clubhouse main' }),
  // Remaining accounts
  mkKey('lake-1', clients[1], siteFor('lake-main'), 'LK-01', { masterCode: 'LK' }),
  mkKey('csc-1', clients[2], siteFor('csc-main'), 'CL-WH-01', { notes: 'Loading bay only', status: 'out', heldByUserId: seedId('u', 'crew3') }),
  mkKey('oly-1', clients[5], siteFor('oly-main'), 'OL-01', { notes: 'Service entrance' }),
];
// Seed history for keys that are currently out / unknown so their History reads
// meaningfully; the in-lockbox keys simply have no events yet.
const keyEvents = [
  { id: seedId('kev', 'evg1-co'),  keyId: seedId('key', 'evg-1'),      kind: 'checkout', byUserId: seedId('u', 'heather'), holderUserId: seedId('u', 'crew1'), holderName: null,                         occurredAt: daysAgo(6),  note: 'For Friday deep-clean' },
  { id: seedId('kev', 'pac1-co'),  keyId: seedId('key', 'pac-1'),      kind: 'checkout', byUserId: seedId('u', 'heather'), holderUserId: seedId('u', 'crew4'), holderName: null,                         occurredAt: daysAgo(2),  note: null },
  { id: seedId('kev', 'csc1-co'),  keyId: seedId('key', 'csc-1'),      kind: 'checkout', byUserId: seedId('u', 'heather'), holderUserId: seedId('u', 'crew3'), holderName: null,                         occurredAt: daysAgo(18), note: null },
];

// ---------- Jobs ----------
const SERIES_EVRGN = seedId('ser', 'evergreen-weekly');
const SERIES_OLY   = seedId('ser', 'olympic-weekly');
const SERIES_CORAL = seedId('ser', 'coralbay-weekly');

const jobs = [
  // One-off jobs
  { id: seedId('j', 'today-2'), clientId: clients[1].id, siteId: siteFor('lake-main').id,  serviceId: svc('flr'), crewIds: [users[5].id],            startAt: atTime(0, 10, 0),  endAt: atTime(0, 12, 0),  status: 'in_progress', notes: '',                              seriesId: null, recurrence: null, createdAt: daysAgo(5) },
  { id: seedId('j', 'today-3'), clientId: clients[4].id, siteId: siteFor('pac-tower').id,  serviceId: svc('jan'), crewIds: [users[6].id],            startAt: atTime(0, 13, 0),  endAt: atTime(0, 15, 0),  status: 'upcoming',    notes: '',                              seriesId: null, recurrence: null, createdAt: daysAgo(3) },
  // Demo (#3): a finished morning clean on a checklist-bound account (Coral Bay HOA)
  // with no checklist logged, so the checklist reminder shows on load. Ended hours ago
  // → escalates to the account supervisor (the crew-nudge tier is unit-tested).
  { id: seedId('j', 'ck-demo'),  clientId: clients[3].id, siteId: siteFor('mtb-clbhs').id,  serviceId: svc('jan'), crewIds: [users[7].id],            startAt: atTime(0, 8, 0),   endAt: atTime(0, 9, 30),  status: 'done',        notes: '',                              seriesId: null, recurrence: null, createdAt: daysAgo(2) },
  { id: seedId('j', 'tom-2'),   clientId: clients[3].id, siteId: siteFor('mtb-clbhs').id,  serviceId: svc('win'), crewIds: [users[5].id, users[6].id], startAt: atTime(1, 10, 30), endAt: atTime(1, 12, 0),  status: 'upcoming',    notes: 'Two cleaners — each has their own checklist.', seriesId: null, recurrence: null, createdAt: daysAgo(1) },
  { id: seedId('j', 'week-1'),  clientId: clients[4].id, siteId: siteFor('pac-tower').id,  serviceId: svc('jan'), crewIds: [users[4].id],            startAt: atTime(3, 9, 0),   endAt: atTime(3, 11, 0),  status: 'upcoming',    notes: '',                              seriesId: null, recurrence: null, createdAt: daysAgo(1) },
  { id: seedId('j', 'week-2'),  clientId: clients[2].id, siteId: siteFor('csc-main').id,   serviceId: svc('pw'), crewIds: [users[5].id],            startAt: atTime(4, 13, 0),  endAt: atTime(4, 15, 0),  status: 'upcoming',    notes: 'Loading bay pressure wash.',    seriesId: null, recurrence: null, createdAt: daysAgo(1) },
  { id: seedId('j', 'yes-1'),   clientId: clients[5].id, siteId: siteFor('oly-main').id,   serviceId: svc('rst'), crewIds: [users[5].id],            startAt: atTime(-1, 14, 0), endAt: atTime(-1, 15, 0), status: 'done',        notes: '',                              seriesId: null, recurrence: null, createdAt: daysAgo(3) },

  // Las Olas Medical weekly janitorial series
  { id: seedId('j', 'evgrn-w0'), clientId: clients[0].id, siteId: siteFor('evgrn-main').id, serviceId: svc('jan'), crewIds: [users[3].id], startAt: atTime(-7, 8, 0), endAt: atTime(-7, 9, 30), status: 'done',     notes: 'Standard janitorial.', seriesId: SERIES_EVRGN, recurrence: { frequency: 'weekly', daysOfWeek: null, endType: 'count', endCount: 12, endDate: null }, createdAt: daysAgo(14) },
  { id: seedId('j', 'evgrn-w1'), clientId: clients[0].id, siteId: siteFor('evgrn-main').id, serviceId: svc('jan'), crewIds: [users[3].id], startAt: atTime(0, 8, 0),  endAt: atTime(0, 9, 30),  status: 'done',     notes: 'Standard janitorial.', seriesId: SERIES_EVRGN, recurrence: null, createdAt: daysAgo(14) },
  { id: seedId('j', 'evgrn-w2'), clientId: clients[0].id, siteId: siteFor('evgrn-main').id, serviceId: svc('jan'), crewIds: [users[3].id], startAt: atTime(7, 8, 0),  endAt: atTime(7, 9, 30),  status: 'upcoming', notes: '',                     seriesId: SERIES_EVRGN, recurrence: null, createdAt: daysAgo(14) },
  { id: seedId('j', 'evgrn-w3'), clientId: clients[0].id, siteId: siteFor('evgrn-main').id, serviceId: svc('jan'), crewIds: [users[3].id], startAt: atTime(14, 8, 0), endAt: atTime(14, 9, 30), status: 'upcoming', notes: '',                     seriesId: SERIES_EVRGN, recurrence: null, createdAt: daysAgo(14) },
  { id: seedId('j', 'evgrn-w4'), clientId: clients[0].id, siteId: siteFor('evgrn-main').id, serviceId: svc('jan'), crewIds: [users[3].id], startAt: atTime(21, 8, 0), endAt: atTime(21, 9, 30), status: 'upcoming', notes: '',                     seriesId: SERIES_EVRGN, recurrence: null, createdAt: daysAgo(14) },

  // Bayshore Senior Living weekly restroom sanitation series
  { id: seedId('j', 'oly-w0'), clientId: clients[5].id, siteId: siteFor('oly-main').id, serviceId: svc('rst'), crewIds: [users[5].id], startAt: atTime(0, 15, 30), endAt: atTime(0, 17, 0), status: 'upcoming', notes: '', seriesId: SERIES_OLY, recurrence: { frequency: 'weekly', daysOfWeek: null, endType: 'count', endCount: 12, endDate: null }, createdAt: daysAgo(7) },
  { id: seedId('j', 'oly-w1'), clientId: clients[5].id, siteId: siteFor('oly-main').id, serviceId: svc('rst'), crewIds: [users[5].id], startAt: atTime(7, 15, 30), endAt: atTime(7, 17, 0), status: 'upcoming', notes: '', seriesId: SERIES_OLY, recurrence: null, createdAt: daysAgo(7) },
  { id: seedId('j', 'oly-w2'), clientId: clients[5].id, siteId: siteFor('oly-main').id, serviceId: svc('rst'), crewIds: [users[5].id], startAt: atTime(14, 15, 30), endAt: atTime(14, 17, 0), status: 'upcoming', notes: '', seriesId: SERIES_OLY, recurrence: null, createdAt: daysAgo(7) },
  { id: seedId('j', 'oly-w3'), clientId: clients[5].id, siteId: siteFor('oly-main').id, serviceId: svc('rst'), crewIds: [users[5].id], startAt: atTime(21, 15, 30), endAt: atTime(21, 17, 0), status: 'upcoming', notes: '', seriesId: SERIES_OLY, recurrence: null, createdAt: daysAgo(7) },

  // Tomorrow Las Olas Medical
  { id: seedId('j', 'tom-1'), clientId: clients[0].id, siteId: siteFor('evgrn-main').id, serviceId: svc('jan'), crewIds: [users[3].id], startAt: atTime(1, 8, 0), endAt: atTime(1, 9, 30), status: 'upcoming', notes: '', seriesId: null, recurrence: null, createdAt: daysAgo(1) },

  // Q17 sample data: one missed clean (last week) so the KPI strip has signal.
  // Real missed cleans get marked via Job detail → "Mark as missed" in production.
  { id: seedId('j', 'miss-1'), clientId: clients[3].id, siteId: siteFor('mtb-clbhs').id, serviceId: svc('rst'), crewIds: [users[6].id], startAt: atTime(-4, 11, 0), endAt: atTime(-4, 12, 0), status: 'missed', notes: 'Crew was rerouted to emergency at Palmetto Ridge; rescheduled for next Tuesday.', seriesId: null, recurrence: null, createdAt: daysAgo(5) },

  // TODAY — crew1 (Andre Baptiste) at the two geofence-armed sites. This is the
  // LIVE clock-in demo path: UserSwitcher → Andre → My Day → clock in (spoof the
  // location per DEMO_RUNBOOK to show the fence block, then override, then inside).
  { id: seedId('j', 'cs-today-1'), clientId: clients[0].id, siteId: siteFor('evgrn-main').id, serviceId: svc('jan'), crewIds: [users[4].id], startAt: atTime(0, 10, 0),  endAt: atTime(0, 12, 0),  status: 'upcoming', notes: 'Main Hospital. Daily janitorial.', seriesId: null, recurrence: null, createdAt: daysAgo(1) },
  { id: seedId('j', 'cs-today-2'), clientId: clients[4].id, siteId: siteFor('pac-tower').id,  serviceId: svc('jan'), crewIds: [users[4].id], startAt: atTime(0, 18, 30), endAt: atTime(0, 20, 30), status: 'upcoming', notes: 'Tower A. Evening service.',       seriesId: null, recurrence: null, createdAt: daysAgo(1) },

  // Edge case: a cancelled clean (client called it off). Keeps the history and the
  // 'cancelled' status without counting against variance or the missed-clean KPI.
  { id: seedId('j', 'cancel-1'), clientId: clients[3].id, siteId: siteFor('mtb-clbhs').id, serviceId: svc('win'), crewIds: [users[6].id], startAt: atTime(-2, 9, 0), endAt: atTime(-2, 10, 0), status: 'cancelled', notes: 'Client cancelled for a private event.', seriesId: null, recurrence: null, createdAt: daysAgo(6) },

  // ── Coral Bay HOA weekly clubhouse series — the COVER demo (R8) ──────────────────
  // Coral Bay is the per-cleaner-checklist account: Andre (crew1) holds it_floorcare, Tomas
  // (crew2) holds it_fullclean (the long 10-section one). Andre is this series' REGULAR
  // cleaner and is already called out TODAY (the same-day call-outs further down), so Tomas
  // covers tonight: `coverFor` says who, and `checklistFor` therefore hands Tomas ANDRE's
  // it_floorcare on this clean only, not his own it_fullclean. Next week's visit is Andre's
  // again, untouched — the other half of the demo. `oneOff: { crew: true }` is what a
  // single-visit crew edit leaves, so a later "this & all future" crew change skips this
  // visit. Cleaners are named the way the Coral Bay account row above names them (seedId,
  // not a roster index). Times avoid every other seed clean for both, so no double-book.
  { id: seedId('j', 'cbay-w0'), clientId: clients[3].id, siteId: siteFor('mtb-clbhs').id, serviceId: svc('jan'), crewIds: [seedId('u', 'crew1')], startAt: atTime(-7, 18, 0), endAt: atTime(-7, 19, 30), status: 'done',     notes: '', seriesId: SERIES_CORAL, recurrence: { frequency: 'weekly', daysOfWeek: null, endType: 'count', endCount: 8, endDate: null }, createdAt: daysAgo(40) },
  { id: seedId('j', 'cbay-w1'), clientId: clients[3].id, siteId: siteFor('mtb-clbhs').id, serviceId: svc('jan'), crewIds: [seedId('u', 'crew2')], startAt: atTime(0, 18, 0),  endAt: atTime(0, 19, 30),  status: 'upcoming', notes: 'Tomas covering for Andre (called out).', seriesId: SERIES_CORAL, recurrence: null, oneOff: { crew: true }, coverFor: { [seedId('u', 'crew2')]: seedId('u', 'crew1') }, createdAt: daysAgo(40) },
  { id: seedId('j', 'cbay-w2'), clientId: clients[3].id, siteId: siteFor('mtb-clbhs').id, serviceId: svc('jan'), crewIds: [seedId('u', 'crew1')], startAt: atTime(7, 18, 0),  endAt: atTime(7, 19, 30),  status: 'upcoming', notes: '', seriesId: SERIES_CORAL, recurrence: null, createdAt: daysAgo(40) },
];

// ---------- Invoices ----------
const li = (desc, qty, unit) => ({
  id: seedId('li', `${desc.slice(0, 4)}-${qty}-${unit}`),
  description: desc,
  qty,
  unitPrice: unit,
});

const invoices = [
  { id: `${INVOICE_PREFIX}-1001`, clientId: clients[0].id, billingContactId: contacts[0].id, siteId: siteFor('evgrn-main').id, jobIds: [], issueDate: daysAgo(3),  dueDate: atTime(27, 12, 0), lineItems: [li('Weekly janitorial. Main Hospital', 4, 350)], taxRate: 0, status: 'paid',    payments: [{ id: seedId('pay', 'p1'), date: daysAgo(1), amount: 1400, method: 'ACH',   note: '' }],         attachment: null, notes: '', createdAt: daysAgo(3) },
  { id: `${INVOICE_PREFIX}-1002`, clientId: clients[1].id, billingContactId: contacts[1].id, siteId: siteFor('lake-main').id,  jobIds: [], issueDate: daysAgo(4),  dueDate: atTime(26, 12, 0), lineItems: [li('Monthly floor care', 1, 650)],                  taxRate: 0, status: 'paid',    payments: [{ id: seedId('pay', 'p2'), date: daysAgo(2), amount: 650,  method: 'Card',  note: '' }],         attachment: null, notes: '', createdAt: daysAgo(4) },
  { id: `${INVOICE_PREFIX}-1003`, clientId: clients[4].id, billingContactId: contacts[4].id, siteId: siteFor('pac-tower').id,  jobIds: [], issueDate: daysAgo(6),  dueDate: atTime(24, 12, 0), lineItems: [li('Bi-weekly janitorial. Tower A', 2, 475)],      taxRate: 0, status: 'pending', payments: [],                                                                                            attachment: null, notes: '', createdAt: daysAgo(6) },
  { id: `${INVOICE_PREFIX}-1004`, clientId: clients[5].id, billingContactId: contacts[5].id, siteId: siteFor('oly-main').id,   jobIds: [], issueDate: daysAgo(8),  dueDate: atTime(22, 12, 0), lineItems: [li('Weekly restroom sanitation', 4, 195)],          taxRate: 0, status: 'pending', payments: [],                                                                                            attachment: null, notes: '', createdAt: daysAgo(8) },
  { id: `${INVOICE_PREFIX}-1005`, clientId: clients[3].id, billingContactId: contacts[3].id, siteId: siteFor('mtb-clbhs').id,  jobIds: [], issueDate: daysAgo(10), dueDate: atTime(20, 12, 0), lineItems: [li('Monthly window cleaning. Clubhouse', 1, 285)], taxRate: 0, status: 'paid',    payments: [{ id: seedId('pay', 'p3'), date: daysAgo(5), amount: 285,  method: 'Check', note: '#1042' }],   attachment: null, notes: '', createdAt: daysAgo(10) },
  { id: `${INVOICE_PREFIX}-1006`, clientId: clients[2].id, billingContactId: contacts[2].id, siteId: siteFor('csc-main').id,   jobIds: [], issueDate: daysAgo(20), dueDate: daysAgo(5),        lineItems: [li('Quarterly pressure washing', 1, 1500)],         taxRate: 0, status: 'overdue', payments: [],                                                                                            attachment: null, notes: '', createdAt: daysAgo(20) },
  { id: `${INVOICE_PREFIX}-1007`, clientId: clients[6].id, billingContactId: contacts[6].id, siteId: siteFor('sal-main').id,   jobIds: [], issueDate: daysAgo(30), dueDate: daysAgo(15),       lineItems: [li('Post-construction cleanup', 1, 950)],           taxRate: 0, status: 'overdue', payments: [],                                                                                            attachment: null, notes: '', createdAt: daysAgo(30) },
  { id: `${INVOICE_PREFIX}-1008`, clientId: clients[0].id, billingContactId: contacts[0].id, siteId: siteFor('evgrn-main').id, jobIds: [], issueDate: daysAgo(14), dueDate: atTime(16, 12, 0), lineItems: [li('Weekly janitorial. Main Hospital wing', 4, 320)],   taxRate: 0, status: 'paid',    payments: [{ id: seedId('pay', 'p4'), date: daysAgo(7), amount: 1280, method: 'ACH',   note: '' }],         attachment: null, notes: '', createdAt: daysAgo(14) },
  // Edge case: a VOID invoice whose payment carries forward as account credit
  // (a duplicate the owner voided after it was paid). Shows the void badge + the
  // "paid to credit" treatment, and puts Las Olas Medical Group in credit.
  { id: `${INVOICE_PREFIX}-1009`, clientId: clients[0].id, billingContactId: contacts[0].id, siteId: siteFor('evgrn-main').id, jobIds: [], issueDate: daysAgo(25), dueDate: daysAgo(10), lineItems: [li('Weekly janitorial (duplicate)', 1, 400)], taxRate: 0, status: 'void', payments: [{ id: seedId('pay', 'p5'), date: daysAgo(20), amount: 400, method: 'ACH', note: '' }], attachment: null, notes: 'Voided: duplicate of CS-1001. Payment carried as account credit.', createdAt: daysAgo(25) },
  // Edge case: an OVERPAYMENT (a check came in over the total), leaving Lakeside
  // Office Park in credit. Exercises the negative-balance / credit path.
  { id: `${INVOICE_PREFIX}-1010`, clientId: clients[1].id, billingContactId: contacts[1].id, siteId: siteFor('lake-main').id, jobIds: [], issueDate: daysAgo(9), dueDate: atTime(21, 12, 0), lineItems: [li('Monthly floor care', 1, 650)], taxRate: 0, status: 'paid', payments: [{ id: seedId('pay', 'p6'), date: daysAgo(4), amount: 700, method: 'Check', note: '#2087' }], attachment: null, notes: 'Customer overpaid by $50; carried as credit.', createdAt: daysAgo(9) },
];

// ---------- Snippets ----------
const snippets = [
  { id: seedId('sn', 'welcome'),       label: 'Welcome reply',         channel: 'all',   body: `Hi there. Thanks for reaching out to ${BRAND_NAME}! Someone from our team will follow up shortly.` },
  { id: seedId('sn', 'intro-crew'),    label: 'Intro from crew',       channel: 'sms',   body: `Hi, this is ${BRAND_NAME}. Your crew is prepping for the visit. Let us know if anything changes.` },
  { id: seedId('sn', 'arrival-eta'),   label: 'Arrival ETA',           channel: 'sms',   body: 'Your crew is on the way. ETA ~15 minutes.' },
  { id: seedId('sn', 'reschedule'),    label: 'Reschedule offer',      channel: 'all',   body: 'Happy to reschedule. Could you share a couple of windows that work this week?' },
  { id: seedId('sn', 'booking-conf'),  label: 'Booking confirmed',     channel: 'all',   body: "All set. We've confirmed the visit. You'll get a reminder the day before." },
  { id: seedId('sn', 'walkthrough'),   label: 'Walkthrough scheduling',channel: 'all',   body: "Great. Let's get a walkthrough on the calendar. What day and time works for you this week?" },
  { id: seedId('sn', 'invoice-sent'),  label: 'Invoice sent',          channel: 'email', body: "Hi. The invoice is on its way to your inbox. Let us know if anything needs adjusting." },
  { id: seedId('sn', 'net30-reminder'),label: 'Net-30 reminder',       channel: 'all',   body: 'Quick reminder: your invoice is due in 7 days per our Net-30 terms. Happy to resend a copy.' },
  { id: seedId('sn', 'pay-received'),  label: 'Payment received',      channel: 'all',   body: 'Thanks. Payment received. Receipt incoming shortly.' },
  { id: seedId('sn', 'past-due'),      label: 'Past due notice',       channel: 'email', body: "Hi. Your invoice is now past due. Could we set up a quick call to sort out payment options?" },
  { id: seedId('sn', 'thanks-prompt'), label: 'Thanks for prompt pay', channel: 'all',   body: 'Thanks for taking care of that so quickly. We really appreciate it!' },
];

// ---------- Conversations ----------
// Two seeded internal channels (per Q14, Q6): Time Off Requests + Accounting Handoffs.
// allActiveStaffIds is the default member set for seeded internal threads — visible to
// every active staff user in the seed data, so the inbox isn't empty for newcomers.
const allActiveStaffIds = users.filter((u) => u.status === 'active').map((u) => u.id);
// Default-current-user pin set — assigning previously-starred threads to Matt
// (the seeded current user) so his pinned section keeps its content. Switching
// to another user starts them with an empty pinned section, which is correct
// per-user behavior for the demo.
const defaultPinSet = [users[0].id];
const conversations = [
  // External
  { id: seedId('cv', 'c1'), clientId: clients[0].id, contactId: contacts[0].id, channel: 'sms',   title: null, createdAt: daysAgo(7),  lastMessageAt: hoursAgo(3),  createdByUserId: users[3].id, starredByUserIds: [],             mutedByUserIds: [] },
  { id: seedId('cv', 'c2'), clientId: clients[1].id, contactId: contacts[1].id, channel: 'email', title: null, createdAt: daysAgo(10), lastMessageAt: hoursAgo(18), createdByUserId: users[3].id, starredByUserIds: [],             mutedByUserIds: defaultPinSet }, // snoozed (notifications off) for the demo current user
  { id: seedId('cv', 'c3'), clientId: clients[3].id, contactId: contacts[3].id, channel: 'sms',   title: null, createdAt: daysAgo(20), lastMessageAt: daysAgo(2),   createdByUserId: users[2].id, starredByUserIds: [],             mutedByUserIds: [] },
  { id: seedId('cv', 'c4'), clientId: clients[4].id, contactId: contacts[4].id, channel: 'sms',   title: null, createdAt: daysAgo(2),  lastMessageAt: daysAgo(1),   createdByUserId: users[2].id, starredByUserIds: defaultPinSet,  mutedByUserIds: [] },
  { id: seedId('cv', 'c5'), clientId: clients[2].id, contactId: contacts[2].id, channel: 'sms',   title: null, createdAt: daysAgo(5),  lastMessageAt: daysAgo(4),   createdByUserId: users[2].id, starredByUserIds: [],             mutedByUserIds: [] },
  { id: seedId('cv', 'c6'), clientId: clients[5].id, contactId: contacts[5].id, channel: 'email', title: null, createdAt: daysAgo(6),  lastMessageAt: daysAgo(5),   createdByUserId: users[2].id, starredByUserIds: [],             mutedByUserIds: [] },
  { id: seedId('cv', 'c7'), clientId: null,          contactId: contacts[7].id, channel: 'sms',   title: null, createdAt: daysAgo(2),  lastMessageAt: daysAgo(2),   createdByUserId: users[3].id, starredByUserIds: [],             mutedByUserIds: [] }, // Jamie (lead)
  { id: seedId('cv', 'c8'), clientId: null,          contactId: contacts[8].id, channel: 'email', title: null, createdAt: daysAgo(5),  lastMessageAt: daysAgo(3),   createdByUserId: users[2].id, starredByUserIds: [],             mutedByUserIds: [] }, // Robin (lead)
  { id: seedId('cv', 'c9'), clientId: null,          contactId: contacts[11].id, channel: 'sms',  title: null, createdAt: daysAgo(1),  lastMessageAt: hoursAgo(2),  createdByUserId: users[2].id, starredByUserIds: defaultPinSet,  mutedByUserIds: [] }, // Morgan Hayes (lead)

  // Internal — pinned (starred) channels per Q14 & Q6
  // createdByUserId is the thread creator — only they (or a Super Admin) can hard-delete.
  // participantUserIds gates visibility — only listed members see the thread in their Threads inbox.
  { id: seedId('cv', 'time-off'),     clientId: null, contactId: null, channel: 'internal', title: 'Time Off Requests',  createdAt: daysAgo(60), lastMessageAt: hoursAgo(8),  createdByUserId: users[2].id, participantUserIds: allActiveStaffIds, starredByUserIds: defaultPinSet, mutedByUserIds: [] },
  { id: seedId('cv', 'accounting'),   clientId: null, contactId: null, channel: 'internal', title: 'Accounting Handoffs', createdAt: daysAgo(60), lastMessageAt: daysAgo(1),   createdByUserId: users[2].id, participantUserIds: allActiveStaffIds, starredByUserIds: defaultPinSet, mutedByUserIds: [] },
  // Internal — incident channels (transactional)
  { id: seedId('cv', 'evgrn-coord'),  clientId: null, contactId: null, channel: 'internal', title: 'Las Olas Medical access coordination', createdAt: daysAgo(3), lastMessageAt: hoursAgo(22), createdByUserId: users[3].id, participantUserIds: allActiveStaffIds, starredByUserIds: [], mutedByUserIds: [] },
  { id: seedId('cv', 'pac-badge'),    clientId: null, contactId: null, channel: 'internal', title: 'Tower A badge handoff',         createdAt: daysAgo(4), lastMessageAt: daysAgo(3),   createdByUserId: users[3].id, participantUserIds: allActiveStaffIds, starredByUserIds: [], mutedByUserIds: [] },

  // DM — 1:1 between Heather (admin) and Lauren (admin). Privacy is gated to participants;
  // owners/other admins/crew not in participantUserIds will not see this thread.
  { id: seedId('cv', 'dm-heather-lauren'), clientId: null, contactId: null, channel: 'dm', title: null, createdAt: daysAgo(2), lastMessageAt: hoursAgo(6), createdByUserId: users[2].id, starredByUserIds: [], mutedByUserIds: [], participantUserIds: [users[2].id, users[3].id].sort() },
];

// Per-user read state. `allActiveStaffIds` on a message means the whole org
// has caught up on it (used for older / clearly-handled messages). `[]` means
// nobody has read it yet — the author is still excluded from unread counts via
// the `authorUserId !== uid` guard in selectUnreadForConversation, so we don't
// need to include the author here. For DMs, we narrow the read list to the
// participant pair so a non-participant can't end up "having read" a private
// thread (defensive: participants gate visibility too).
const dmHLParticipants = [users[2].id, users[3].id];
const messages = [
  // c1 Las Olas Medical (SMS)
  { id: seedId('m', 'c1-m1'), conversationId: conversations[0].id, direction: 'in',       authorUserId: null,        snippetId: null, text: 'Hey, confirming the 8am cleaning tomorrow.',                                     sentAt: daysAgo(1),   readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c1-m2'), conversationId: conversations[0].id, direction: 'out',      authorUserId: users[3].id, snippetId: null, text: 'Confirmed! Andre will be there by 7:55 AM.',                              sentAt: daysAgo(1),   readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c1-m3'), conversationId: conversations[0].id, direction: 'in',       authorUserId: null,        snippetId: null, text: 'Perfect, thanks.',                                                               sentAt: daysAgo(1),   readByUserIds: [] },

  // c2 Lakeside (Email)
  { id: seedId('m', 'c2-m1'), conversationId: conversations[1].id, direction: 'in',  authorUserId: null,        snippetId: null,                            text: 'Can we reschedule Thursday to Friday?',                                          sentAt: daysAgo(2),   readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c2-m2'), conversationId: conversations[1].id, direction: 'out', authorUserId: users[2].id, snippetId: seedId('sn', 'reschedule'),       text: 'Happy to reschedule. Could you share a couple of windows that work this week?', sentAt: daysAgo(2),   readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c2-m3'), conversationId: conversations[1].id, direction: 'in',  authorUserId: null,        snippetId: null,                            text: 'Friday 10 AM works great, thanks!',                                              sentAt: hoursAgo(18), readByUserIds: [] },

  // c3 Coral Bay HOA (SMS)
  { id: seedId('m', 'c3-m1'), conversationId: conversations[2].id, direction: 'in',  authorUserId: null,        snippetId: null, text: 'Invoice received, paying this week.',                                            sentAt: daysAgo(3),   readByUserIds: [] },
  { id: seedId('m', 'c3-m2'), conversationId: conversations[2].id, direction: 'out', authorUserId: users[2].id, snippetId: null, text: 'Great, appreciate it! Let us know if you need another copy.',                    sentAt: daysAgo(2),   readByUserIds: allActiveStaffIds },

  // c4 Palmetto Ridge (SMS)
  { id: seedId('m', 'c4-m1'), conversationId: conversations[3].id, direction: 'out', authorUserId: users[3].id, snippetId: null, text: 'Reminder: cleaning scheduled for tomorrow 1 PM.', sentAt: daysAgo(1), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c4-m2'), conversationId: conversations[3].id, direction: 'in',  authorUserId: null,        snippetId: null, text: 'Got it, thanks!',                                  sentAt: daysAgo(1), readByUserIds: allActiveStaffIds },

  // c5 Gulfstream Logistics (SMS)
  { id: seedId('m', 'c5-m1'), conversationId: conversations[4].id, direction: 'out', authorUserId: users[3].id, snippetId: null,                            text: 'Scheduling the quarterly pressure wash for next Friday at 1 PM. Loading bay OK?', sentAt: daysAgo(4), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c5-m2'), conversationId: conversations[4].id, direction: 'in',  authorUserId: null,        snippetId: null,                            text: 'Yes. Use bay 3. Gate code is still #4421.',                                     sentAt: daysAgo(4), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c5-m3'), conversationId: conversations[4].id, direction: 'out', authorUserId: users[3].id, snippetId: seedId('sn', 'booking-conf'),     text: "All set. We've confirmed the visit. You'll get a reminder the day before.",     sentAt: daysAgo(4), readByUserIds: allActiveStaffIds },

  // c6 Bayshore Senior Living (Email)
  { id: seedId('m', 'c6-m1'), conversationId: conversations[5].id, direction: 'in',  authorUserId: null,        snippetId: null, text: `Net-30 on ${INVOICE_PREFIX}-1004. Can we push the due date to May 15?`, sentAt: daysAgo(6), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c6-m2'), conversationId: conversations[5].id, direction: 'out', authorUserId: users[2].id, snippetId: null, text: 'Let me check with Dana and confirm.',                    sentAt: daysAgo(5), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c6-m3'), conversationId: conversations[5].id, direction: 'out', authorUserId: users[2].id, snippetId: null, text: `Approved. I've updated ${INVOICE_PREFIX}-1004 with a May 15 due date.`, sentAt: daysAgo(5), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c6-m4'), conversationId: conversations[5].id, direction: 'in',  authorUserId: null,        snippetId: null, text: 'Thank you!',                                                sentAt: daysAgo(5), readByUserIds: [] },

  // c7 Jamie Park (lead, SMS)
  { id: seedId('m', 'c7-m1'), conversationId: conversations[6].id, direction: 'out',      authorUserId: users[3].id, snippetId: seedId('sn', 'welcome'), text: `Hi Jamie. Thanks for reaching out to ${BRAND_NAME}! Someone from our team will follow up shortly.`, sentAt: daysAgo(2), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c7-m2'), conversationId: conversations[6].id, direction: 'in',       authorUserId: null,        snippetId: null,                    text: 'Thursday afternoon works for a walkthrough.',                                                                       sentAt: daysAgo(2), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c7-m3'), conversationId: conversations[6].id, direction: 'out',      authorUserId: users[3].id, snippetId: null,                    text: `Thursday 2 PM. ${OWNER_FIRST} will be there for the walkthrough. We'll send a confirmation by EOD.`,                          sentAt: daysAgo(2), readByUserIds: allActiveStaffIds },

  // c8 Robin Vega (lead, Email)
  { id: seedId('m', 'c8-m1'), conversationId: conversations[7].id, direction: 'in',  authorUserId: null,        snippetId: null, text: 'Need common-area cleaning for an 84-unit complex. Can you send a proposal?',                                                  sentAt: daysAgo(5), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c8-m2'), conversationId: conversations[7].id, direction: 'out', authorUserId: users[2].id, snippetId: null, text: "Absolutely. Sending a walkthrough form now. Reply with photos and we'll follow up with a scoped proposal.",                  sentAt: daysAgo(5), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c8-m3'), conversationId: conversations[7].id, direction: 'in',  authorUserId: null,        snippetId: null, text: 'Walkthrough notes attached. Looking for weekly lobby + quarterly deep clean.',                                                sentAt: daysAgo(3), readByUserIds: [] },

  // c9 Morgan Hayes (lead, SMS)
  { id: seedId('m', 'c9-m1'), conversationId: conversations[8].id, direction: 'out', authorUserId: users[3].id, snippetId: null, text: 'Quote went out this morning. Let me know if anything needs tweaking.', sentAt: daysAgo(1),   readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'c9-m2'), conversationId: conversations[8].id, direction: 'in',  authorUserId: null,        snippetId: null, text: 'Reviewing with ownership tomorrow. Will circle back.',                  sentAt: hoursAgo(20), readByUserIds: [] },

  // c9 Morgan Hayes (lead, Email reply in same thread)
  { id: seedId('m', 'c9-m3'), conversationId: conversations[8].id, direction: 'in', authorUserId: null, snippetId: null, text: `Hi ${OWNER_FIRST},\n\nOwnership reviewed the quote and we are good to move forward with all three locations. A few things before we sign off:\n\n1. Can we start with the Northgate shop first? That one needs it the worst.\n2. Is there any flexibility on the bi-weekly rate if we commit to a 12-month contract?\n3. We would need after-hours service (ideally 6-9 PM) -- is that doable?\n\nLet me know and we can get the paperwork rolling.\n\nBest,\nMorgan Hayes\nOperations Manager\nNorthside Auto Group\n(754) 555-0305`, sentAt: hoursAgo(2), readByUserIds: [], emailSubject: `Re: ${BRAND_NAME} - Cleaning Quote for Northside Auto Group`, fromEmail: 'morgan.hayes@nsauto.com', toInboxEmail: OWNER.email, emailHeaders: { messageId: '<seed-c10-m1@nsauto.com>', inReplyTo: null, references: null } },

  // Time Off Requests (internal, pinned)
  { id: seedId('m', 'to-m1'), conversationId: conversations[9].id, direction: 'internal', authorUserId: users[5].id, snippetId: null, text: 'Requesting next Friday off. Got a family thing. Can someone cover the Lakeside floor care?', sentAt: daysAgo(2),  readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'to-m2'), conversationId: conversations[9].id, direction: 'internal', authorUserId: users[3].id, snippetId: null, text: 'Approved. Keisha will swap in.',                                                       sentAt: daysAgo(2),  readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'to-m3'), conversationId: conversations[9].id, direction: 'internal', authorUserId: users[7].id, snippetId: null, text: 'Out the 24th for a doctor appointment. Back the 25th.',                                  sentAt: hoursAgo(8), readByUserIds: [] },

  // Accounting Handoffs (internal, pinned)
  { id: seedId('m', 'ah-m1'), conversationId: conversations[10].id, direction: 'internal', authorUserId: users[3].id, snippetId: null, text: 'New client just signed: Northside Auto Group, 3 locations. Setting up billing. Yolanda, FYI.', sentAt: daysAgo(1),  readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'ah-m2'), conversationId: conversations[10].id, direction: 'internal', authorUserId: users[2].id, snippetId: null, text: 'Got it. Will send onboarding paperwork today.',                                                  sentAt: daysAgo(1),  readByUserIds: allActiveStaffIds },

  // Las Olas Medical access coordination (internal, transactional)
  { id: seedId('m', 'ec-m1'), conversationId: conversations[11].id, direction: 'internal', authorUserId: users[2].id, snippetId: null, text: "Heads up. Las Olas Medical's loading dock B is closed for repair next week. Route through the main entrance.", sentAt: daysAgo(2),  readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'ec-m2'), conversationId: conversations[11].id, direction: 'internal', authorUserId: users[3].id, snippetId: null, text: "Thanks. I'll brief the Friday crew at the morning huddle.",                                          sentAt: daysAgo(2),  readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'ec-m3'), conversationId: conversations[11].id, direction: 'internal', authorUserId: users[4].id, snippetId: null, text: 'Updated job notes on all three Las Olas Medical jobs this week.',                                            sentAt: hoursAgo(22), readByUserIds: allActiveStaffIds },

  // Tower A badge handoff (internal, transactional)
  { id: seedId('m', 'pb-m1'), conversationId: conversations[12].id, direction: 'internal', authorUserId: users[3].id, snippetId: null, text: 'We need a badge for the new crew member. Who can pick it up from the front desk?', sentAt: daysAgo(3), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'pb-m2'), conversationId: conversations[12].id, direction: 'internal', authorUserId: users[7].id, snippetId: null, text: "I'm at Tower A tomorrow. Can grab it.",                                              sentAt: daysAgo(3), readByUserIds: allActiveStaffIds },
  { id: seedId('m', 'pb-m3'), conversationId: conversations[12].id, direction: 'internal', authorUserId: users[3].id, snippetId: null, text: 'Perfect, thanks Luis.',                                                              sentAt: daysAgo(3), readByUserIds: allActiveStaffIds },

  // DM Heather ↔ Lauren — 1:1 staff direct message. direction='internal' (DMs aren't external);
  // authorUserId distinguishes the sender. The last Lauren message has empty readByUserIds so
  // Heather sees a demo unread badge when the user switches to her seat.
  { id: seedId('m', 'dm-hl-m1'), conversationId: conversations[13].id, direction: 'internal', authorUserId: users[2].id, snippetId: null, text: 'Hey. Quick Q on the Lakeside swap. Was the substitute supposed to be Andre or Tomas?', sentAt: daysAgo(2),  readByUserIds: dmHLParticipants },
  { id: seedId('m', 'dm-hl-m2'), conversationId: conversations[13].id, direction: 'internal', authorUserId: users[3].id, snippetId: null, text: 'Tomas. Andre is on the Gulfstream route Friday.',                                            sentAt: daysAgo(2),  readByUserIds: dmHLParticipants },
  { id: seedId('m', 'dm-hl-m3'), conversationId: conversations[13].id, direction: 'internal', authorUserId: users[3].id, snippetId: null, text: "Also, can you confirm the new badge for Luis is here? I'll grab it on my way in.",       sentAt: hoursAgo(6), readByUserIds: [] },
];

// ---------- Reminder templates ----------
// Automated customer reminders are DISABLED (Daniel, 2026-07-02) — never a
// planned feature. The scheduler component is unmounted (see App.jsx) AND every
// template is seeded `enabled: false`, so nothing fires even if the component is
// ever re-mounted. Kept as scaffolding for a future deliberate rebuild if a
// client requests it. lib/reminderScheduler.js consumes these `key` values.
const reminderTemplates = [
  // welcome_email has no fire trigger in the scheduler (shouldFire only handles the
  // job-lifecycle keys), so it's seeded DISABLED — flip on only once a trigger is
  // wired (e.g. on client creation), otherwise it's a phantom that never sends.
  { id: seedId('rt', 'we'),  key: 'welcome_email',         channel: 'email', subject: `Welcome to ${BRAND_NAME}`,   body: `Hi {client_contact},\n\nWelcome aboard. We're glad to have you as a client. You'll receive a confirmation the day before each cleaning, and we'll check in after your first visit.\n\nQuestions? Reply to this email or call us at ${BRAND_PHONE}.\n\nThe ${BRAND_NAME} team`, enabled: false  },
  { id: seedId('rt', 'bc'),  key: 'booking_confirmation',  channel: 'email', subject: 'Your cleaning is booked',                  body: "Hi {client_contact}, your {service} at {site_name} is booked for {date} at {time}.\n\n{company}",                                                                                                                                                                                                                                                  enabled: false  },
  { id: seedId('rt', 'r24'), key: 'reminder_24h',          channel: 'sms',   subject: '',                                         body: "Reminder: {company} will be at {site_name} tomorrow at {time} for {service}.",                                                                                                                                                                                                                                                                  enabled: false  },
  { id: seedId('rt', 'doe'), key: 'day_of_eta',            channel: 'sms',   subject: '',                                         body: "Reminder: {company} is scheduled at {site_name} today at {time} for your {service}.",                                                                                                                                                                                                                                                             enabled: false  },
  { id: seedId('rt', 'fcr'), key: 'post_service',          channel: 'email', subject: 'How did your first clean go?',             body: `Hi {client_contact},\n\nThanks for letting {company} handle {site_name} today. We hope it went well! We always like to check in after a first visit. Reply with anything we should adjust for the next time, and we'll make sure your crew sees it.\n\nThe ${BRAND_NAME} team`,                                                                       enabled: false  },
];

// Past reminder events for triage realism.
const reminderEvents = (() => {
  const evts = [];
  const tplKeys = reminderTemplates.map((t) => t.key);
  for (let i = 0; i < 28; i += 1) {
    const ageDays = 30 - i;
    evts.push({
      id: seedId('re', `e${i}`),
      templateKey: tplKeys[i % tplKeys.length],
      jobId: jobs[i % jobs.length].id,
      clientId: jobs[i % jobs.length].clientId,
      channel: i % 2 === 0 ? 'sms' : 'email',
      status: i % 13 === 0 ? 'failed' : 'sent',
      sentAt: daysAgo(ageDays),
      readAt: ageDays > 7 ? daysAgo(ageDays - 1) : null,
    });
  }
  return evts;
})();

const contactActivities = [];
const userPermissionOverrides = [];
// Persistent in-app notifications surfaced through the bell. Per-user, capped
// at NOTIFICATION_LIMIT in the reducer so we don't grow unbounded over time.
const notifications = [];

// ---------- Marketing (v37) ----------
// Email marketing: one live cold-outreach sequence sending from a two-inbox
// rotation pool, with a played-out enrollment history so the Marketing tab shows
// real activity (enrolled / sent / replied) out of the box. The sequence is
// MANUAL-audience and every enrollment is terminal (completed or replied), so the
// demo scheduler never auto-enrolls or re-sends: getDueSends only walks 'active'
// enrollments and getDueEnrollments only runs for 'auto' sequences.
//
// marketingSettings is a single object (not an array) with the defaults new
// sequences inherit; replyRouting.pipelineId/stageKey stay null until the user picks.
const mSeqId = seedId('mseq', 'newlead');
const mStepId = (k) => seedId('mstep', k);
const marketingSteps = [
  { id: mStepId('intro'), order: 0, delayMinutes: 0, daysAfterPrevious: 0, sendHourStart: 9, sendHourEnd: 17,
    subject: 'Keeping {company} spotless',
    body: `<p>Hi {firstName},</p><p>I run ${BRAND_NAME}, a commercial cleaning company in South Florida, and I wanted to reach out about {company}.</p><p>We handle nightly janitorial, floor care, and post-construction cleanups for offices, medical suites, and property groups. Our crews clock in on site with GPS, so you always know the work actually happened.</p><p>Would a quick 15-minute call make sense this week?</p><p>Best,<br>{senderName}</p>`,
    attachments: [] },
  { id: mStepId('followup'), order: 1, delayMinutes: 4320, daysAfterPrevious: 3, sendHourStart: 9, sendHourEnd: 17,
    subject: 'Quick question, {firstName}',
    body: '<p>Hi {firstName},</p><p>Just following up on my note about cleaning for {company}. I know facilities decisions rarely happen overnight.</p><p>Happy to send a sample scope and a ballpark quote, no obligation. Want me to put one together?</p><p>{senderName}</p>',
    attachments: [] },
  { id: mStepId('offer'), order: 2, delayMinutes: 5760, daysAfterPrevious: 4, sendHourStart: 9, sendHourEnd: 17,
    subject: 'A free walkthrough for {company}?',
    body: `<p>Hi {firstName},</p><p>I would love to walk your space and show you exactly what a ${BRAND_NAME} program would look like for {company}. The walkthrough is free and takes about 20 minutes.</p><p>I have openings Thursday and Friday. Which works better?</p><p>{senderName}</p>`,
    attachments: [] },
  { id: mStepId('breakup'), order: 3, delayMinutes: 10080, daysAfterPrevious: 7, sendHourStart: 9, sendHourEnd: 17,
    subject: 'Should I close your file?',
    body: '<p>Hi {firstName},</p><p>I have reached out a couple of times about cleaning for {company} with no reply, which is completely fine. I do not want to crowd your inbox.</p><p>I will close out your file for now. If your cleaning needs change, just reply here and we will pick right back up.</p><p>All the best,<br>{senderName}</p>',
    attachments: [] },
];

const mInboxMatt = seedId('mi', 'marcus');
const mInboxSales = seedId('mi', 'sales');
const marketingInboxes = [
  { id: mInboxMatt, provider: 'google', email: OWNER.email, displayName: OWNER.name, senderName: OWNER.name,
    status: 'active', connectedAt: daysAgo(60), connectedByUserId: users[0].id, lastSyncAt: daysAgo(0), lastError: null, enabled: true,
    rotationOrder: 0, dailySendLimit: 50, signature: `${OWNER.name}\n${BRAND_NAME}\n(754) 555-0101\n${BRAND_DOMAIN}`,
    inboundCapability: 'pubsub', inboundEnabled: true, workspaceId: null },
  { id: mInboxSales, provider: 'google', email: `sales@${BRAND_DOMAIN}`, displayName: `${BRAND_NAME} Sales`, senderName: `${BRAND_NAME}`,
    status: 'active', connectedAt: daysAgo(45), connectedByUserId: users[0].id, lastSyncAt: daysAgo(0), lastError: null, enabled: true,
    rotationOrder: 1, dailySendLimit: 50, signature: `The ${BRAND_NAME} Team\n${BRAND_PHONE}\n${BRAND_DOMAIN}`,
    inboundCapability: 'pubsub', inboundEnabled: true, workspaceId: null },
];

const marketingSequences = [{
  id: mSeqId, name: 'New Lead Outreach', status: 'active', plainText: false, nextInboxIndex: 1,
  audienceMode: 'manual', enrollmentSources: [], onStageExit: 'continue', haltOnReply: true,
  replyRouting: { enabled: false, pipelineId: null, stageKey: null }, replyTags: [],
  notifyOnReplyUserId: null, notifyOnReplyChannels: { inApp: false },
  createdAt: daysAgo(20), createdByUserId: users[0].id, updatedAt: daysAgo(1), steps: marketingSteps,
}];

// Played-out enrollment + send history from a compact spec: sent = how many steps
// went out; replied = they answered (which halts the drip). All terminal, so the
// scheduler leaves them untouched.
const mSendDayForStep = [14, 11, 7, 0];   // step i went out this many days ago
const mEnrollSpecs = [
  { c: seedId('ct', 'jamiep'), sent: 4, replied: false },
  { c: seedId('ct', 'robin'), sent: 2, replied: true },
  { c: seedId('ct', 'taylor'), sent: 4, replied: false },
  { c: seedId('ct', 'morganns'), sent: 4, replied: false },
  { c: seedId('ct', 'sambrew'), sent: 1, replied: true },
  { c: seedId('ct', 'quinn'), sent: 4, replied: false },
];
const mEmailOf = (cid) => (contacts.find((c) => c.id === cid)?.email || '');
const marketingEnrollments = [];
const marketingSends = [];
let mSendN = 0;
mEnrollSpecs.forEach((spec, ei) => {
  const enrId = seedId('menr', `${ei}`);
  const lastStep = Math.min(spec.sent - 1, 3);
  marketingEnrollments.push({
    id: enrId, sequenceId: mSeqId, contactId: spec.c, enrolledAt: daysAgo(14),
    source: 'manual',
    currentStepIndex: spec.sent, status: spec.replied ? 'replied' : 'completed',
    lastSentAt: daysAgo(mSendDayForStep[lastStep]),
    repliedAt: spec.replied ? daysAgo(mSendDayForStep[lastStep] - 1) : null,
  });
  for (let si = 0; si < spec.sent; si++) {
    const step = marketingSteps[si];
    const inbox = (mSendN % 2 === 0) ? mInboxMatt : mInboxSales;
    const sentAt = daysAgo(mSendDayForStep[si]);
    marketingSends.push({
      id: seedId('msnd', `${ei}-${si}`), enrollmentId: enrId, sequenceId: mSeqId, stepId: step.id,
      inboxId: inbox, contactId: spec.c, toEmail: mEmailOf(spec.c),
      subject: step.subject, bodyPreview: '', status: 'sent',
      attemptedAt: sentAt, sentAt, providerMessageId: `seed-msg-${ei}-${si}`, failureReason: null, marketingHeaders: null,
    });
    mSendN += 1;
  }
});

const marketingReplies = [
  { id: seedId('mrep', 'robin'), enrollmentId: seedId('menr', '1'), sequenceId: mSeqId, contactId: seedId('ct', 'robin'),
    fromEmail: 'robin@biscayneharbor.co', subject: 'Re: Quick question, Robin',
    body: 'Thanks for following up. We are reviewing our common-area cleaning contract next month. Can you send that sample scope and a quote? Robin',
    receivedAt: daysAgo(10), status: 'new', category: 'human' },
  { id: seedId('mrep', 'sambrew'), enrollmentId: seedId('menr', '4'), sequenceId: mSeqId, contactId: seedId('ct', 'sambrew'),
    fromEmail: 'sam@riverwalkbrewing.com', subject: 'Re: Keeping Riverwalk Brewing Co spotless',
    body: 'Interesting timing. Our taproom needs a more reliable crew. What does bi-weekly run for a space our size? Sam',
    receivedAt: daysAgo(13), status: 'new', category: 'human' },
];
// Email addresses globally opted out of marketing (CAN-SPAM suppression list).
// Honored as a hard gate in getDueSends, getDueEnrollments, and ENROLL_CONTACTS.
const marketingSuppressions = [];
const marketingSettings = {
  replyRouting: {
    enabled: false,
    pipelineId: null,
    stageKey: null,
  },
  plainTextDefault: false,
  defaultSendWindow: { start: 9, end: 17 },
  // null = fall back to the COMPANY timezone (company.timezone, then the app
  // default) — never the device. The send cron runs TZ=UTC, so a device fallback
  // fired the window at the wrong local hours. An IANA string pins it explicitly.
  sendTimezone: null,
  // Minutes each rotation inbox waits between sends — a per-inbox throttle
  // so sends trickle out instead of firing in a burst.
  sendIntervalMinutes: 5,
  // Calendar days (YYYY-MM-DD, in the sending timezone) the scheduler skips
  // entirely — holidays / blackout dates. Sends resume the next allowed day.
  excludedDates: [],
  // Unsubscribe footer (CAN-SPAM + Gmail/Yahoo bulk-sender). Appended to every
  // marketing send server-side; the link is HMAC-signed in the send path.
  // `message` supports {unsubscribe} (the link) and {company} tokens.
  unsubscribe: {
    enabled: true,
    message: 'Not interested? {unsubscribe} from these emails.',
    linkText: 'Unsubscribe',
    includeAddress: true,
    address: '',   // blank → company.address
    baseUrl: '',   // blank → the app's domain (INBOX_INBOUND_BASE_URL)
  },
};

// ---------- Google Workspaces (multi-Workspace OAuth registry) ----------
// Each entry is one Google Workspace org wired to its own Internal OAuth app
// (no Google verification / CASA / annual fees). Mailboxes — per-user
// connectedInboxes and marketing rotation inboxes — are attributed to a
// Workspace via workspaceId. The client_secret NEVER lives here: the backend
// holds it encrypted at rest; the frontend tracks display metadata + setup
// status only. status: 'active' (live) | 'pending' (awaiting the Google-admin
// Trusted-app approval) | 'setup' (registered, creds incomplete) | 'error'.
const oauthWorkspaces = [
  {
    id: 'ws_seed_primary',
    label: `${BRAND_NAME}`,
    domains: [`${BRAND_DOMAIN}`],
    clientId: '847206315582-r9k4m1.apps.googleusercontent.com',
    clientSecretLast4: 'Xa7Q',
    status: 'active',
    isPrimary: true,
    connectedAt: daysAgo(120),
    lastError: null,
  },
  {
    id: 'ws_seed_cascade',
    label: `${BRAND_NAME} West Palm`,
    domains: [`wpb.${BRAND_DOMAIN}`],
    clientId: '529114870043-h2m8x0.apps.googleusercontent.com',
    clientSecretLast4: 'p4Lm',
    status: 'pending',
    isPrimary: false,
    connectedAt: daysAgo(3),
    lastError: null,
  },
];

// Sample per-user mailboxes attributed to the primary Workspace so the
// super-admin org-wide roll-up + each user's Connected Inboxes page render
// populated in the demo. Real deployments start empty (see BLANK_BUSINESS_DATA).
const seedInboxUser = (re, fallbackIdx) =>
  (users.find((u) => re.test(u.name) || re.test(u.email)) || users[fallbackIdx] || users[0]);
const _kyle = users[0];
const _heather = seedInboxUser(/heather/i, 1);
const _lauren = seedInboxUser(/lauren/i, 2);
const connectedInboxes = [
  {
    id: 'ci_seed_kyle', userId: _kyle.id, provider: 'google',
    email: _kyle.email, displayName: _kyle.name, status: 'active',
    workspaceId: 'ws_seed_primary', connectedAt: daysAgo(110),
    lastSyncAt: null, lastError: null, isDefault: true,
    smtpHost: null, smtpPort: null, smtpSecurity: null,
    imapHost: null, imapPort: null, imapSecurity: null,
    inboundCapability: 'gmail_poll', inboundEnabled: true,
  },
  {
    id: 'ci_seed_heather', userId: _heather.id, provider: 'google',
    email: _heather.email, displayName: _heather.name, status: 'active',
    workspaceId: 'ws_seed_primary', connectedAt: daysAgo(64),
    lastSyncAt: null, lastError: null, isDefault: true,
    smtpHost: null, smtpPort: null, smtpSecurity: null,
    imapHost: null, imapPort: null, imapSecurity: null,
    inboundCapability: 'gmail_poll', inboundEnabled: true,
  },
  {
    id: 'ci_seed_lauren', userId: _lauren.id, provider: 'google',
    email: _lauren.email, displayName: _lauren.name, status: 'active',
    workspaceId: 'ws_seed_primary', connectedAt: daysAgo(40),
    lastSyncAt: null, lastError: null, isDefault: true,
    smtpHost: null, smtpPort: null, smtpSecurity: null,
    imapHost: null, imapPort: null, imapSecurity: null,
    inboundCapability: 'gmail_poll', inboundEnabled: true,
  },
];

// ---------- Supplies (S58) ----------
// Per-LOCATION approved-supply catalog (supplyItems) + the request queue
// (supplyRequests). "Location" is the customer (one location per customer). A
// supervisor requests approved items by qty; the office marks the batch complete.
// Request LINES snapshot name + unitPrice at submit, so a later catalog edit never
// rewrites a submitted request (money-per-record law). unitPrice is DOLLARS
// (round2); `unit` is a free label ('' reads as "each"). Additive, default-safe
// slices ([] when absent) — NO store-version bump. Seeded for two accounts whose
// supervisors are on the roster (Las Olas → Renata; Palmetto Ridge → Yolanda) so
// the queue + Approved-items tab render populated on a fresh load / ?demo=reset.
const supplyItems = [
  // Las Olas Medical Group (supervisor: Renata Cruz)
  { id: seedId('si', 'lomg-glass'),  clientId: seedId('cl', 'evergreen'), name: 'Glass cleaner 32 oz',        unit: 'each',         unitPrice: 6.80,  createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-disin'),  clientId: seedId('cl', 'evergreen'), name: 'Disinfectant concentrate',   unit: 'gallon',       unitPrice: 24.50, createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-liner'),  clientId: seedId('cl', 'evergreen'), name: 'Trash liners 33 gal',        unit: 'case of 250',  unitPrice: 32.90, createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-towel'),  clientId: seedId('cl', 'evergreen'), name: 'Paper towels',               unit: 'case of 12',   unitPrice: 28.40, createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-tp'),     clientId: seedId('cl', 'evergreen'), name: 'Toilet paper',               unit: 'case of 36',   unitPrice: 41.20, createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-glove'),  clientId: seedId('cl', 'evergreen'), name: 'Nitrile gloves (L)',         unit: 'box of 100',   unitPrice: 11.90, createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-cloth'),  clientId: seedId('cl', 'evergreen'), name: 'Microfiber cloths',          unit: 'pack of 24',   unitPrice: 14.60, createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-floor'),  clientId: seedId('cl', 'evergreen'), name: 'Neutral floor cleaner',      unit: 'gallon',       unitPrice: 19.80, createdAt: daysAgo(200) },
  { id: seedId('si', 'lomg-soap'),   clientId: seedId('cl', 'evergreen'), name: 'Hand soap refill',           unit: 'each',         unitPrice: 9.40,  createdAt: daysAgo(200) },
  // Palmetto Ridge Corp (supervisor: Yolanda Reyes)
  { id: seedId('si', 'prc-glass'),   clientId: seedId('cl', 'pacridge'),  name: 'Glass cleaner 32 oz',        unit: 'each',         unitPrice: 6.80,  createdAt: daysAgo(160) },
  { id: seedId('si', 'prc-liner'),   clientId: seedId('cl', 'pacridge'),  name: 'Trash liners 33 gal',        unit: 'case of 250',  unitPrice: 32.90, createdAt: daysAgo(160) },
  { id: seedId('si', 'prc-towel'),   clientId: seedId('cl', 'pacridge'),  name: 'Paper towels',               unit: 'case of 12',   unitPrice: 28.40, createdAt: daysAgo(160) },
  { id: seedId('si', 'prc-glove'),   clientId: seedId('cl', 'pacridge'),  name: 'Nitrile gloves (L)',         unit: 'box of 100',   unitPrice: 11.90, createdAt: daysAgo(160) },
  { id: seedId('si', 'prc-urinal'),  clientId: seedId('cl', 'pacridge'),  name: 'Urinal screens',             unit: 'pack of 10',   unitPrice: 18.30, createdAt: daysAgo(160) },
  { id: seedId('si', 'prc-floor'),   clientId: seedId('cl', 'pacridge'),  name: 'Neutral floor cleaner',      unit: 'gallon',       unitPrice: 19.80, createdAt: daysAgo(160) },
  { id: seedId('si', 'prc-soap'),    clientId: seedId('cl', 'pacridge'),  name: 'Hand soap refill',           unit: 'each',         unitPrice: 9.40,  createdAt: daysAgo(160) },
];
const supplyRequests = [
  {
    id: seedId('sr', 'lomg-open'), clientId: seedId('cl', 'evergreen'),
    requestedByUserId: seedId('u', 'mgr1'), status: 'open',
    note: 'Out of glass cleaner by Friday.',
    lines: [
      { itemId: seedId('si', 'lomg-glass'), name: 'Glass cleaner 32 oz', qty: 4, unitPrice: 6.80 },
      { itemId: seedId('si', 'lomg-liner'), name: 'Trash liners 33 gal', qty: 2, unitPrice: 32.90 },
      { itemId: seedId('si', 'lomg-towel'), name: 'Paper towels',        qty: 1, unitPrice: 28.40 },
    ],
    createdAt: daysAgo(1), completedAt: null, completedByUserId: null,
  },
  {
    id: seedId('sr', 'prc-done'), clientId: seedId('cl', 'pacridge'),
    requestedByUserId: seedId('u', 'heather'), status: 'completed',
    note: '',
    lines: [
      { itemId: seedId('si', 'prc-floor'), name: 'Neutral floor cleaner', qty: 2, unitPrice: 19.80 },
      { itemId: seedId('si', 'prc-towel'), name: 'Paper towels',          qty: 2, unitPrice: 28.40 },
    ],
    createdAt: daysAgo(6), completedAt: daysAgo(5), completedByUserId: seedId('u', 'kyler'),
  },
];

// Default current user is Matt (super admin). Switcher in UI changes this.
const currentUserId = users[0].id;

export const INITIAL_STATE = {
  // v57: the location-wide default checklist is retired (R3) — the customer field that
  // held it is gone, and a checklist reaches a cleaner only through crewChecklists.
  // Lockstep with persist.js STORAGE_KEY (pp.store.v57) + migrateV56toV57.
  version: 57,
  company,
  currentUserId,
  users,
  services,
  frequencies,
  clients,
  sites,
  jobs,
  invoices,
  // Quotes feature (Supabase-backed; mirrored here for the admin list + the
  // payment→invoice sync ledger). Readers default to [] so existing persisted
  // state without these slices is safe (no store-version migration needed).
  quotes: [],
  syncedPayments: [],
  // External financial snapshot (Google Sheet → webhook). Null = use computed.
  financialSnapshot: null,
  conversations,
  messages,
  reminderTemplates,
  reminderEvents,
  // Client review layer (shared): the client's sign-offs on the build — per-nav
  // "in review / approved" markers, per-draft accept/changes/note, and design-decision
  // "picks" (Dashboard + Payroll layout choices) with notes. Lives in org_state so
  // CleanSpace's selections + notes are visible to the whole org (both sides), not
  // trapped in one browser. Additive + default-safe (readers go through
  // selectClientReview) — NO store-version bump. See lib/clientReview.js.
  clientReview: { sections: {}, drafts: {}, picks: {}, decisions: {} },
  permissions: seedPermissions(),
  contacts,
  tags,
  contactActivities,
  clientActivities: [],
  userPermissionOverrides,
  snippets,
  pipelines,
  activePipelineId: pipelines[0].id,
  opportunities,
  invitations: [],
  // Two same-day call-outs against today's scheduled cleans (Andre users[5] + Keisha
  // users[7] are on today's board) so Reports › Called out has real data. A call-out
  // is a time-off entry booked for today (HR › PTO / a team member's Time-off card).
  timeOff: [
    { id: seedId('to', 'andre-out'), userId: users[5].id, startDate: todayKey(), endDate: todayKey(), reason: 'Called out sick', kind: 'callout', createdBy: users[0].id, createdAt: atTime(0, 7, 10) },
    { id: seedId('to', 'keisha-out'), userId: users[7].id, startDate: todayKey(), endDate: todayKey(), reason: 'Family emergency', kind: 'callout', createdBy: users[0].id, createdAt: atTime(0, 6, 45) },
  ],
  // Per-user mailbox connections for the email channel inside Messaging
  // (Phase 3 of the email build). Each row pairs a userId with a provider
  // (google / microsoft / smtp). Tokens + SMTP passwords NEVER live here —
  // backend holds them encrypted at rest. Frontend tracks status + metadata
  // only. New users start with zero connections; the email channel in
  // Messaging is gated on having at least one active connection.
  oauthWorkspaces,
  connectedInboxes,
  notifications,
  // ---------- Marketing (v37) ----------
  // Company-shared rotation pool for outbound marketing email. Distinct from
  // connectedInboxes (which are per-user Messaging mailboxes). Sequences pick
  // from this pool in round-robin order via sequence.nextInboxIndex.
  marketingInboxes,
  marketingSequences,
  marketingEnrollments,
  marketingSends,
  marketingReplies,
  marketingSuppressions,
  marketingSettings,
  // ---------- Keys (check-in / check-out) ----------
  keys,
  keyEvents,
  reviews: { indeedActual: 0 },
  // ---------- Operations / Swept replacement (v49 ops) ----------
  // Per-account ops config (security, cleaning instructions, expected time,
  // standing crew, geofence, day/night shifts) rides on the client/site objects
  // and is read with null-safe selectors. These top-level slices hold QC templates
  // + ops tunables (config — survive a real deploy) and the account-media metadata
  // mirror (business data — reset on a real deploy). Heavy records (time_entries,
  // inspections, media bytes) live in Supabase backend tables, NOT here. Additive
  // default-safe slices, NO store-version bump — same convention as quotes/
  // syncedPayments above (the shared org_state blob hydrates raw, so readers must
  // default; see CLEANSPACE_SWEPT.md §2.3).
  opsSettings: {
    defaultGeofenceRadiusM: DEFAULT_GEOFENCE_RADIUS_M,   // 250 ft default (clock-in fence; stored in meters, shown in feet — see lib/geo.js)
    autoCloseGraceMins: 120,         // forgotten clock-out auto-closes at scheduled_end + this grace (api/time auto-close cron)
    offlineReplayWindowHours: 12,    // buffered offline clock punch: asserted time accepted only if within this window of replay, else server-stamped + flagged (§5.4)
    varianceFlagOverMins: 15,
    varianceFlagUnderMins: 15,
    expectedBasis: 'labor',          // 'labor' (per-cleaner clocked time, summed) | 'wallclock' (elapsed)
    attributionModel: 'per_cleaner',
    // NO keyOverdueDays — keys have no return window / due-back date (removed 2026-07-22).
    // Paid drive time BETWEEN jobs (clock-out at one clean → clock-in at the next).
    // The gap cap is what separates "drove to the next site" from "went home" —
    // the first and last legs of a day are unrepresentable by construction.
    driveMaxGapMins: DEFAULT_DRIVE_MAX_GAP_MINS,       // 180 — longer gaps aren't drives
    driveVarianceFlagPct: DEFAULT_DRIVE_FLAG_PCT,      // 15 — flag when actual exceeds the mapped estimate by this %
    driveVarianceGraceMins: DEFAULT_DRIVE_GRACE_MINS,  // 5 — absolute cushion so short hops don't false-flag
    // ---------- Payroll config (additive, default-safe; readers hard-default) ----------
    otMultiplier: 1.5,              // OT pay = OT hours × rate × this (US FLSA 1.5×)
    payPeriodCadence: 'semimonthly', // 'weekly' | 'biweekly' | 'semimonthly' (1st–15th, 16th–end-of-month) — Clean Space runs semi-monthly; weekly 40h OT is day-attributed across the split (lib/payroll payrollByUserClipped)
    payWeekStartDay: 0,             // 0 = Sunday (matches the hours engine default)
    payDriveTime: true,             // paid drive time between jobs counts toward paid hours
    // ---------- Operational alerts / reminders config (additive, default-safe) ----------
    // Tunable in Settings > Operations. Readers hard-default via lib/opsAlerts, so an
    // older blob without these keys still behaves; NO store-version bump.
    lateAlertGraceMins: 10,         // #2: minutes past scheduled start with no clock-in → "late"
    missedShiftGraceMins: 15,       // #2: minutes past scheduled end with no clock-in → "missed"
    shiftAlertLookbackHours: 24,    // #2: only shifts this recent can alert (back-blast guard)
    checklistReminderGraceMins: 60, // #3: after start with no checklist logged → nudge the crew
    checklistEscalateGraceMins: 60, // #3: after end with still no checklist → escalate to supervisor
    inspectionReminderDays: 14,     // #3: an account not inspected within this many days is due
  },
  // One-off pay lines (bonus / reimbursement / tip / deduction), keyed per user +
  // pay-period start day. Additive, default-safe ([] when absent) — NO store-version
  // bump (same convention as quotes/timeOff; selectPayrollLines defaults to EMPTY_ARRAY).
  payrollLines: [],
  // HR — reimbursement requests (receipt image + amount; approved → a payroll
  // reimbursement line) and per-employee document metadata (bytes live in the
  // lib/hrFiles demo stub / go-live Storage, never here). Additive, default-safe
  // ([] when absent) — NO store-version bump.
  reimbursements: [],
  employeeDocuments: [],
  inspectionTemplates: [],
  checklistTemplates: [],
  accountMedia: [],
  // Per-inspection follow-up (assignee + done) for failed/needs-follow-up records.
  // Keyed by inspection id; the inspection RECORDS live relationally in Supabase,
  // only this lightweight triage state rides the shared blob. Additive, default-safe
  // ([] when absent) — NO store-version bump (CLEANSPACE_SWEPT.md §2.3 convention).
  inspectionFollowUps: [],
  // Once-fired markers for operational alerts (late/missed shift; checklist/inspection
  // reminders land here too). Deterministic ids (lib/opsAlerts.opsAlertId) make each
  // fire at most once. Additive, default-safe ([] when absent) — NO store-version bump.
  opsAlertEvents: [],
  // ---------- Supplies (S58) ----------
  // Per-location approved catalog + the request queue. Additive, default-safe ([] when
  // absent) — NO store-version bump. See lib/supplies.js + brain/modules/supplies.md.
  supplyItems,
  supplyRequests,
};

// Empty operational/business data — everything a brand-new live org should NOT
// start with. Used to seed the shared Supabase document on first login so a
// real deployment begins blank (no sample customers/jobs/invoices) rather than
// with the demo dataset above.
const BLANK_BUSINESS_DATA = {
  clients: [],
  sites: [],
  jobs: [],
  invoices: [],
  contacts: [],
  opportunities: [],
  contactActivities: [],
  clientActivities: [],
  conversations: [],
  messages: [],
  notifications: [],
  invitations: [],
  timeOff: [],
  oauthWorkspaces: [],
  connectedInboxes: [],
  quotes: [],
  syncedPayments: [],
  financialSnapshot: null,
  marketingInboxes: [],
  marketingSequences: [],
  marketingEnrollments: [],
  marketingSends: [],
  marketingReplies: [],
  marketingSuppressions: [],
  keys: [],
  keyEvents: [],
  reviews: { indeedActual: 0 },
  accountMedia: [],
  // Supplies (S58): a real deployment starts with no approved lists or requests —
  // the office builds each location's list in-app. Config lists nothing to keep.
  supplyItems: [],
  supplyRequests: [],
};

// First-login seed for a real (authed) deployment: KEEPS team + logins/roles,
// company settings, and structural config (services, frequencies, pipelines,
// tags, snippets, reminder + marketing settings); EMPTIES all customer/job/
// invoice/message data. Local-only dev mode still uses the demo INITIAL_STATE.
export function productionInitialState() {
  return { ...INITIAL_STATE, ...BLANK_BUSINESS_DATA };
}
