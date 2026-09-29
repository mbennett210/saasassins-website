import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import EmptyState from '../../components/EmptyState';
import { useStore } from '../../store';
import { selectCurrentUser } from '../../store/selectors';
import { usePermissionChecker } from '../../hooks/usePermission';
import { MARKETING_ENABLED } from '../../lib/features';
import { IDENTITY } from '../../brand/identity.generated.js';

// ─────────────────────────────────────────────────────────────────────────────
// Quick Start Guide — Settings → Quick Start
//
// Two audiences, one renderer. GUIDES.admin covers Super Admin + Admin (their
// day-to-day is the same toolkit); GUIDES.crew is the field-level guide and is
// the only one a crew login sees. All copy lives in the data below — keep
// on-screen labels in "double quotes" exactly as they appear in the UI, and
// keep crew content limited to what the crew role defaults can actually reach
// (see lib/roles.js).
// ─────────────────────────────────────────────────────────────────────────────

// Shared across both guides — installing the PWA is the same on every phone
// regardless of role, so it's authored once and surfaced at the top of each
// guide's module list. No `to`/`perm`: it's pure how-to, not a link to a route.
const PHONE_INSTALL = {
  id: 'install-app', icon: 'phone', title: 'Install the app on your phone',
  where: `Add ${IDENTITY.name} to your home screen (iPhone & Android)`,
  blurb: `Add ${IDENTITY.name} to your home screen and it opens like a real app. Full-screen, with its own icon and push notifications. No App Store or Play Store needed; you install it straight from your browser.`,
  body: [
    { h: 'iPhone & iPad (Safari)', steps: [
      `Open ${IDENTITY.name} in Safari. Use the same web address you sign in with. It has to be Safari: on an iPhone, Chrome and other browsers can’t install it (an Apple limitation).`,
      'Tap the Share button (the square with an arrow pointing up) in Safari’s toolbar (bottom of the screen on iPhone, top on iPad).',
      'Scroll down the share sheet and tap "Add to Home Screen".',
      `Tap "Add" in the top corner. The ${IDENTITY.name} icon now sits on your home screen. Open it from there and the app runs full-screen with no browser bars.`,
    ] },
    { h: 'Android (Chrome)', steps: [
      `Open ${IDENTITY.name} in Chrome and sign in.`,
      'Tap the ⋮ menu in the top-right corner.',
      'Tap "Install app" (some phones label it "Add to Home screen").',
      `Confirm "Install" / "Add". The ${IDENTITY.name} icon lands on your home screen and in your app drawer. Open it from there for the full-screen app.`,
    ] },
    { tip: `After installing, always open ${IDENTITY.name} from the new home-screen icon (not the browser tab). Then go to Settings → Account, turn on mobile push and "Subscribe this device", so schedule changes and messages reach your phone.` },
    { warn: 'On iPhone you must install from Safari. The "Add to Home Screen" option doesn’t appear in Chrome or other iOS browsers.' },
  ],
};

const GUIDES = {
  admin: {
    label: 'Admin',
    subtitle: 'Set up the workspace and run every module. If something below isn’t in your sidebar, your role doesn’t include it.',
    setupTitle: 'Set up in 10 steps',
    setupIntro: 'Work top to bottom once and the whole app is live. Every step is optional. Skip what doesn’t apply.',
    setup: [
      { title: 'Set up your company profile', detail: 'Name, invoice prefix, tax rate, and address. They flow onto invoices and emails.', to: '/settings/company', perm: 'settings.company', linkLabel: 'Settings → Company' },
      { title: 'Add services and frequencies', detail: 'The service types and cadences used by companies, jobs, and invoices.', to: '/settings/services', perm: 'settings.services', linkLabel: 'Settings → Services' },
      { title: 'Invite your team', detail: 'Click "Invite Member" and pick a role. Invitees get an email to set a password.', to: '/settings/team', perm: 'settings.team.view', linkLabel: 'Settings → Team' },
      { title: 'Tune roles and permissions', detail: 'Adjust role defaults, or override single permissions per person from their Team page.', to: '/settings/roles', perm: 'settings.roles.edit', linkLabel: 'Settings → Roles & Permissions' },
      { title: 'Create your tags', detail: 'Filter and segment contacts by lead source, VIP, Net-30…', to: '/settings/tags', perm: 'tags.manage', linkLabel: 'Settings → Tags & Variables' },
      { title: 'Connect your personal mailbox', detail: 'Send and receive email in Messaging as yourself. Each teammate connects their own.', to: '/settings/inboxes', perm: 'messaging.use', linkLabel: 'Settings → Connected Inboxes' },
      { title: 'Wire up SMS and system email', detail: 'Twilio + A2P registration powers texting; the email provider + domain verification powers system sends.', to: '/settings/integrations', perm: 'integrations.view', linkLabel: 'Settings → Integrations' },
      { title: 'Review your pipeline', detail: 'Rename or reorder the deal stages. The app ships with a single Master pipeline (New Lead through Won/Lost).', to: '/pipeline', perm: 'pipeline.view', linkLabel: 'Pipeline' },
      { title: 'Bring in your contacts', detail: '"Import CSV" upserts (GHL-style): it matches existing people by email → phone (or a Contact ID column), fills in their blanks without overwriting, adds anyone new, and links companies to existing accounts by name or email domain. "Add Customer" for one-offs.', to: '/contacts', perm: 'contacts.view', linkLabel: 'Customers' },
      { title: 'Schedule your first job', detail: '"New Job". Company, site, service, time, crew. It shows up on the Dashboard.', to: '/schedule', perm: 'schedule.view', linkLabel: 'Schedule' },
    ],
    modules: [
      PHONE_INSTALL,
      {
        id: 'dashboard', icon: 'dashboard', title: 'Dashboard', where: 'Sidebar → Dashboard',
        to: '/', perm: 'dashboard.view',
        blurb: 'Your day at a glance. Jobs, money, goals, and the follow-ups that need a human.',
        body: [
          { h: 'Work it daily', steps: [
            '"Today’s Schedule" lists every job with its status. Click through to the job.',
            '"Follow-ups" surfaces leads quiet for 7+ days and threads unanswered for 24+ hours, oldest first.',
            'Goal and financial cards track collected, recurring revenue, receivables, and review targets.',
            'Quick-action buttons jump to Schedule, Invoices, Customers, and Messages.',
          ] },
        ],
      },
      {
        id: 'schedule', icon: 'schedule', title: 'Schedule', where: 'Sidebar → Schedule',
        to: '/schedule', perm: 'schedule.view',
        blurb: 'Plan jobs by day, week, month, or cleaner; assign crew; drive every job to Done.',
        body: [
          { h: 'Plan and run jobs', steps: [
            '"New Job": company, optional site, service, date and times, crew chips, notes.',
            'Four views across the top: Day, Week, Month, and "Cleaner" (each crew member’s lane. A multi-cleaner clean appears in every assigned cleaner’s lane).',
            'Open a job and drive its status: "Start", "Mark Done", "Cancel Job", or "Reset to Upcoming" (returns a still-future clean to Upcoming; needs the "Reset a job to Upcoming" role permission).',
            '"Reschedule" moves a job; in Week view you can drag a card to another day (date only).',
            'Recurring jobs ask "Just this one" or all future when you edit or delete. Pick the scope you mean.',
            'Filter by status, service, or team member. Crew logins only ever see their own jobs.',
          ] },
          { warn: 'An orange dot on a job card means a crew member is double-booked. Two of their jobs overlap.' },
        ],
      },
      {
        id: 'messaging', icon: 'messaging', title: 'Messaging', where: 'Sidebar → Messaging',
        to: '/messaging', perm: 'messaging.use',
        blurb: 'One inbox for SMS, email, and internal team chat.',
        body: [
          { h: 'Run the inbox', steps: [
            'Toggle between Inbox (SMS + email with contacts), Channels (internal), and DMs.',
            '"New conversation" starts an external thread. Pick SMS or Email and the mailbox you’re "Sending as".',
            'Thread header: snooze, star, mute, and status (open / snoozed / closed).',
            'Filter by channel, tag, date, status, or starred; search covers names and message text.',
            'Select threads for bulk mark read/unread or delete. Deletes are permanent for everyone.',
          ] },
          { warn: 'SMS needs Twilio connected + A2P approved (Settings → Integrations). Email needs a mailbox under Settings → Connected Inboxes.' },
        ],
      },
      {
        id: 'contacts', icon: 'clients', title: 'Customers', where: 'Sidebar → Customers',
        to: '/contacts', perm: 'contacts.view',
        blurb: 'The CRM: unified contact list with people and companies. Filter by contact type, then click a company name to view its details, sites, and service history. Email is a contact’s unique ID.',
        body: [
          { h: 'Build and work the book', steps: [
            '"Add Customer" for one-offs. "Import CSV" is an upsert (GHL-style): it maps your columns, matches each row to an existing person by email → phone (or a Contact ID column), and updates matches by filling in blank fields without overwriting what’s already there. Unmatched rows are added. Pick "Create & update" or "Update only" on the preview, which shows per-row whether each will be created, updated, linked to an existing account, or skipped. Companies link to an existing account by name or email domain, or are created on the fly (those born from leads enter as Prospects, not active companies).',
            'Filter by lifecycle (Lead / Prospect / Client / Vendor), tag, or company; select rows to bulk-tag or delete.',
            'A contact’s profile holds their title, tags, notes, and their full job + payment history. Deals belong to the company (Opportunities), shown on the company’s Opportunities tab and the Pipeline board.',
            'A company’s profile holds inline-editable details, linked contacts ("Set as primary"), a Location with its address + access notes + photos on the "Access" tab, an "Operations" tab, activity, and notes.',
            'The "Operations" tab is the account service config crew rely on: expected clean time, assigned cleaners, entry instructions and a reference link, and ops notes. Saving it notifies the assigned crew automatically. (Door/alarm codes live per-location, encrypted.)',
            'Open the Location to set its operational profile: cleaning instructions (broken into areas), a clock-in geofence (located automatically from the address), door/alarm codes (stored masked; revealing them is permission-gated), and photos or video. Everything crew rely on when they arrive.',
          ] },
          { tip: 'The first person attached to a company automatically becomes its primary contact. Winning a deal (on the Pipeline board) flips the company from Lead to Active.' },
        ],
      },
      {
        id: 'lead-webhooks', icon: 'repeat', title: 'Inbound Lead Webhooks', where: 'Sidebar → Settings → Integrations',
        to: '/settings/integrations', perm: 'integrations.view',
        blurb: 'Auto-create contacts from outside tools. Facebook Lead Ads, Zapier, Make, n8n, or any service that can POST JSON. Each webhook upserts the lead and opens a deal for their company on the pipeline.',
        body: [
          { h: 'Create a webhook', steps: [
            'Settings → Integrations → "Inbound Lead Webhooks" → "New lead webhook". Name it for the source ("FB Leads", "Partner referrals").',
            'Choose the Master Pipeline stage a new lead’s deal starts at (default New Lead). Pick a default lifecycle (Lead / Prospect / Client / Vendor) and any source tags to stamp on every lead.',
            'The new row shows a URL and a token. "Copy" the URL and the token. You’ll paste both into your sending tool. "Rotate" mints a new token if one ever leaks (the old one stops working immediately).',
          ] },
          { h: 'Send leads to it', steps: [
            'Leads are upserted exactly like a CSV import: matched to an existing person by email → phone, blank fields filled in (never overwriting), and brand-new people added. So the same lead arriving twice updates rather than duplicates.',
            'Send the token in the request’s "Authorization" header as "Bearer <token>". The body is flat JSON; at least one of email, phone, name, or company is required. Optional: lifecycle, source, tags, notes, and a stage to override the default.',
            'An existing company with an open deal is enriched, not moved. In-flight deals stay put.',
          ] },
          { h: 'Wire up Zapier (or Make / n8n)', steps: [
            'In Zapier: trigger on your lead source, then add a "Webhooks by Zapier → POST" action. URL = the webhook’s URL; add an "Authorization" header of "Bearer <token>"; map your fields to email, phone, firstName, and so on.',
            'The "Setup instructions" panel on the Integrations card has the full payload spec and a copy-paste curl example.',
          ] },
          { tip: '"Webhooks by Zapier" is a paid Zapier feature. Make and n8n send the same generic HTTP request on cheaper tiers. Any of them works.' },
          { tip: 'Want a heads-up on every lead? Turn on "A new inbound lead comes in" under Settings → Account → Notifications (Sales section). It’s off by default, and pings the office (bell + push) whenever a webhook creates a brand-new contact. Crew never see it.' },
        ],
      },
      {
        id: 'pipeline', icon: 'chart', title: 'Pipeline', where: 'Sidebar → Sales → Pipeline',
        to: '/pipeline', perm: 'pipeline.view',
        blurb: 'One sales board, one card per company deal. Company first, primary contact below. Drag a company between stages to advance its deal.',
        body: [
          { p: 'Every card is a company Opportunity on the Master pipeline. Its stages run New Lead through Won/Lost. Deals reflect on each company’s own Opportunities tab.' },
          { h: 'Work the board', steps: [
            'Drag a company card between stages to advance its deal. Dropping on Won marks the company Active; Lost closes the deal out.',
            'Click a card for the deal editor (title, value, expected close, stage), or open the company’s full profile.',
            '"Add deal" picks a company and places a new opportunity at a stage.',
            '"Edit stages" renames, reorders, adds, or deletes stages. A stage holding deals can’t be deleted until you move them out.',
          ] },
        ],
      },
      {
        id: 'marketing', icon: 'mail', title: 'Marketing', where: 'Sidebar → Sales → Marketing',
        to: '/marketing', perm: 'marketing.view',
        blurb: 'Drip email sequences sent from a rotating pool of shared inboxes. With the Google OAuth setup that powers them.',
        body: [
          { p: 'Four tabs: Sequences (campaigns), Inboxes (the shared sending pool), Replies (every inbound answer), Settings (sending defaults). Marketing inboxes are shared team accounts. Separate from the personal mailbox you connect for Messaging.' },
          { h: 'One-time Google setup (before any inbox can connect)', p: 'Gmail connects through a Google OAuth app marked Internal: only members of your Google Workspace can authorize it, connections are permanent (no expiring tokens), and the app only ever stores a Google-issued token. Never a password.' },
          { steps: [
            'A Super Admin registers the Workspace under Settings → Integrations → Google Workspaces → "Add a Workspace": workspace name, sending domains, and the OAuth Client ID + Client secret from its Google Cloud project. "Show Google-side setup steps" inside that modal walks through creating the app.',
            'A Google Workspace super admin then marks the app Trusted so connects aren’t blocked: sign in at admin.google.com → Menu → Security → Access and data control → API controls → "Manage Third-Party App Access" → "Configure new app" → paste the OAuth Client ID (ends in .apps.googleusercontent.com) → select the app → scope "Entire organization" → access level "Trusted: Can access all Google services" → Continue → Finish. Effective within minutes (Google allows up to 24 hours).',
            'Confirm every sending domain is registered to the Workspace: admin.google.com → Account → Domains → Manage domains. Anyone with a mailbox under those domains can then connect.',
            'Each mailbox connect is then just a Google popup: pick the Workspace address and approve the two scopes. Send email, and read messages for reply detection.',
            'If someone hits "Access blocked" or "Error 403: org_internal", their account isn’t in the registered Workspace. Personal @gmail.com addresses can’t connect by design.',
          ] },
          { warn: 'One OAuth app serves exactly one Workspace org. If the OAuth project ever changes (e.g. moving it to a different Workspace), every connected inbox must be disconnected and reconnected. Tokens are scoped to the project that issued them.' },
          { h: 'Connect the sending rotation (Inboxes tab)', steps: [
            '"Connect Gmail" opens the connect modal. The same full OAuth walkthrough is embedded right there, collapsible per section. Sign in as the shared marketing mailbox.',
            '"Set up profile" on each inbox: the sender name recipients see, and a signature. The {signature} variable resolves to whichever inbox sends.',
            'Set each inbox’s daily send limit (default 10/day. A deliverability guardrail) and order the rotation with the arrows; sends walk Position 1 → 2 → … and wrap.',
            'Toggle an inbox out of rotation to rest it without disconnecting; "Disconnect" removes it (send history stays).',
            'If an inbox’s Google connection breaks (its token is revoked or expires), it auto-flags and drops out of the rotation on its own. Reconnect it from this tab to bring it back.',
          ] },
          { h: 'Build and launch sequences (Sequences tab)', steps: [
            '"New sequence" → Auto (pull from a deal stage: the primary contact of every company with an open deal there) or Manual (pick contacts). Add steps with a delay, send window, subject, and body. {firstName}, {signature}, and friends personalize each send.',
            'Reply handling per sequence: halt on reply, advance the company’s deal to a stage, apply tags, notify a teammate.',
            '"Start" launches (needs at least one step). Sends go first-in-first-out across the inbox rotation.',
          ] },
          { h: 'Replies and engine settings', steps: [
            'Replies tab: answer from the same inbox so it threads in the contact’s mailbox, unenroll or resume, then "Mark handled". Open the contact to manage their company’s deal.',
            'Settings tab: sending timezone, default send window, time between sends, excluded dates.',
            'Settings tab also handles compliance: an unsubscribe footer added to the bottom of every marketing email. Toggle it on, write the opt-out wording (use {unsubscribe} for the link and {company} for your company name), set the link text and mailing address, and check the live preview. There is also an Unsubscribes & suppression list. Anyone who clicks the unsubscribe link or replies “unsubscribe” is added automatically and never gets marketing email again; you can also add or remove addresses by hand, and those changes take effect immediately (no Save needed).',
          ] },
          { tip: 'Sends run automatically in the background. You don’t need to keep the app open. The system checks for due emails every minute and sends them through the rotation during each sequence’s send window.' },
        ],
      },
      {
        id: 'variance', icon: 'chart', title: 'Variance', where: 'Sidebar → Operations → Variance',
        to: '/variance', perm: 'variance.view',
        blurb: 'Labor logged vs. expected, clean by clean. The multi-cleaner hours report.',
        body: [
          { h: 'Read the report', steps: [
            'Pick a period (Last night, 7 days…). Each row is one clean: actual labor every cleaner’s time added up against the expected minutes, flagged when it runs over or under the threshold.',
            'Drill into a row for each cleaner’s entry; Approve, Reject, or Correct a time entry, or "Add time entry" by hand.',
            'The "On the clock now" strip lists who’s clocked in this minute.',
            'Act on an outlier without leaving the row: message the crew, or "Assign QC" to open an inspection for that site.',
            '"Export CSV" downloads the period.',
          ] },
          { tip: 'Expected minutes come from each site/company’s Operations tab; the flag threshold is set in settings. Clocking in itself happens on the crew’s My Day.' },
        ],
      },
      {
        id: 'quality', icon: 'check', title: 'Quality', where: 'Sidebar → Operations → Quality',
        to: '/inspections', perm: 'qc.view',
        blurb: 'Inspections, checklists, work orders, and the templates behind them. One hub, four tabs.',
        body: [
          { h: 'Build templates', steps: [
            'Templates tab → "New template": add areas and items (pass/fail or a numeric scale), set the passing threshold, then "Publish" to freeze a version.',
            'Editing a published template forks a fresh draft, so submitted records always point at the exact version they were scored on.',
          ] },
          { h: 'Inspect and resolve', steps: [
            'Inspections tab → "New inspection": pick a published template + site, rate each item, attach photos, and submit. The score and Pass/Fail compute against the threshold.',
            'Checklists tab: the lighter cousin. Tick a published checklist’s items with notes.',
            'Work Orders tab: log a client- or field-raised work order with a type and priority, route it to the right queue, and walk it Open → In progress → Awaiting client → Resolved; attach before/after photos. Crew can report here too.',
            '"Copy link" on a submitted inspection shares a public, read-only report. No login needed.',
          ] },
          { tip: 'Crew can view results and report problems; performing inspections and editing templates stays with managers. "Assign QC" on the Variance report deep-links straight into a new inspection for that site.' },
        ],
      },
      {
        id: 'keys', icon: 'lock', title: 'Keys', where: 'Sidebar → Operations → Keys',
        to: '/keys', perm: 'keys.view',
        blurb: 'The digital key log: every physical key filed under its company and the building (site) it opens, with who holds it and a timestamped trail.',
        body: [
          { p: 'Think of it as the pegboard and the sign-out sheet in one. Each company gets its own card listing its keys; a row shows the key’s label and notes, the site (building) it opens, its master code, its status ("In" in the office, "Out" with someone, or "Unknown" imported with no recorded state), and who currently holds it. A key for a single-site account is filed under that building automatically; multi-site accounts pick which one.' },
          { h: 'Set up the inventory', steps: [
            '"Add key" for each physical key: pick the Company (companies that already have keys are listed first; type a new name to start a group), then the Key label stamped on it (e.g. "SU 9A"), the Master code it belongs to (e.g. "SU 9"), and Notes for what it opens ("front door + alarm").',
            '"Edit" fixes any of those fields later. The change is logged to History (with which fields changed), and the key’s status is never touched.',
            'Deleting a key deletes its history with it. For keys you rarely move, just leave them at "In".',
          ] },
          { h: 'Check keys out and in', steps: [
            'Click "Check out" when a key leaves. The holder defaults to you. Pick a teammate instead, or "Someone else (company contact, contractor…)" with their name, since plenty of keys live with building contacts. Add a note for why ("Friday deep-clean").',
            'The row flips to "Out" and names the holder, so anyone can see who has a key without asking around.',
            'Click "Check in" the moment it’s back. One click, no form, the row flips to "In".',
            '"History" on any key is the full audit trail: created, edited, checked out (to whom), checked in, and marked Unknown, with each entry stamped with who did it and the note.',
          ] },
          { h: 'Find keys and fix statuses', steps: [
            'The bar above the list searches by company, key label, master code, or holder; the All / In / Out / Unknown chips filter by status with live counts.',
            'The status badge on every row is a menu. Set In, Out, or Unknown directly. Marking Unknown asks for an optional note, and every change lands in History.',
            'Key already Out? Choosing "Out" again hands it off: a fresh checkout to the next holder, with no phantom check-in in between.',
          ] },
          { tip: 'Everyone (crew included) can see Keys, check keys in or out, and correct statuses. Adding, editing, and deleting keys stays with Admins.' },
        ],
      },
      {
        id: 'reviews', icon: 'star', title: 'Reviews', where: 'Sidebar → Operations → Reviews',
        to: '/reviews', perm: 'reviews.view',
        blurb: 'Your Google listing HQ. Review feed + public replies, Google Posts, listing photos, search insights, and review-growth tools.',
        body: [
          { h: 'Watch your reputation', steps: [
            'Connect Google Business Profile (owner/admin): sign in with the Workspace account that manages the listing. Reviews sync automatically every few hours; "Sync now" pulls immediately, and owners/admins get a bell alert when a new review lands.',
            'Replies, posts, and photos all publish PUBLICLY on your Google listing. The composers say so, and only owners/admins can send them.',
            'Posts tab: publish What\'s New / Event / Offer updates with a photo and a button. Photos tab: add categorized listing photos and see their view counts.',
            'Insights tab: Profile views / Searches / Calls / Directions, review trends, and what people actually searched to find you (lags about a month. That\'s Google).',
            'Get Reviews tab: copy your review link, download the QR code, and use the ask templates. Indeed still has no public API. Type the count into the Indeed card on the Reviews tab.',
          ] },
        ],
      },
      {
        id: 'quotes', icon: 'tag', title: 'Quotes', where: 'Sidebar → Finances → Quotes',
        to: '/quotes', perm: 'quotes.view',
        blurb: 'Generate a quote from your template, sign it, and send it for e-signature.',
        body: [
          { h: 'Draft → signed', steps: [
            '"New quote" → pick the contact. Fill the template fields. They save as you type.',
            'Sign as the company rep: type your name, draw your signature, "Sign document".',
            '"Send" emails the company contact a public "Review & sign" link (no login). When they sign, the status flips to signed and "Download" gives you the final PDF.',
            '"Copy link" re-shares the signing URL; "Delete" permanently removes the document and its files.',
          ] },
          { warn: 'A sent quote locks. To change terms, delete it and create a fresh one.' },
        ],
      },
      {
        id: 'invoices', icon: 'invoices', title: 'Invoices', where: 'Sidebar → Finances → Invoices',
        to: '/invoices', perm: 'invoices.view',
        blurb: 'Bill companies and record payments. Statuses derive from money: Pending → Overdue → Paid (or Void).',
        body: [
          { h: 'Bill and collect', steps: [
            '"Add Invoice": company, issue/due dates, line items, tax rate, billing contact.',
            '"Record Payment" logs money as it arrives; on an open invoice, "Mark Paid" prefills the remaining balance.',
            'Select rows to bulk "Mark Paid" or "Export CSV".',
            'On the invoice page: "Edit" line items, attach the source PDF, "Void" to cancel without deleting history.',
          ] },
          { warn: 'Attached files live in this device’s browser only. They don’t sync to teammates.' },
        ],
      },
      {
        id: 'settings', icon: 'settings', title: 'Settings', where: 'Sidebar → Settings',
        to: '/settings/account', perm: 'settings.account',
        blurb: 'Your account, the company, the team, and every connection.',
        body: [
          { h: 'The pages', list: [
            'Account. Profile, password, mobile push, email signature, notification toggles.',
            'Company. Name, invoice prefix, tax rate, and address used across the app.',
            'Services. Service types and frequencies for companies, jobs, and invoices.',
            'Tags & Variables. Manage tags; browse the read-only {variables} used in marketing emails.',
            'Team. "Invite Member", manage members, and per-user permission overrides (overrides beat role defaults; revoke beats grant).',
            'Roles & Permissions. The Super Admin–only matrix of what each role can do.',
            'Integrations. Twilio SMS (A2P registration + test send), email domain verification, and the Google Workspaces registry where a Super Admin wires each Workspace’s OAuth app ("Add a Workspace").',
            'Connected Inboxes. Your personal mailboxes for sending email in Messaging; the connect modal embeds the full Google OAuth walkthrough.',
          ] },
          { tip: 'Your account email (login + notifications) and your connected mailboxes (what you send as in Messaging) are stored separately. Changing one never changes the other.' },
        ],
      },
    ],
  },

  crew: {
    label: 'Crew',
    subtitle: 'Find your jobs, update them as you work, and know where everything lives.',
    setupTitle: 'Your first day in 5 steps',
    setupIntro: 'Five minutes of setup and you’re road-ready.',
    setup: [
      { title: 'Set up your account', detail: 'Name, initials, phone, and a password of your own.', to: '/settings/account', perm: 'settings.account', linkLabel: 'Settings → Account' },
      { title: 'Turn on notifications', detail: 'Enable mobile push and "Subscribe this device" so schedule changes reach you.', to: '/settings/account', perm: 'settings.account', linkLabel: 'Settings → Account' },
      { title: 'Find your jobs', detail: 'My Day is your home page. Today’s cleans in order, each with clock-in/out and service notes.', to: '/my-day', perm: 'time.clock', linkLabel: 'My Day' },
      { title: 'Learn where company info lives', detail: 'A company’s Access tab holds the address and access notes for its location.', to: '/contacts', perm: 'contacts.view', linkLabel: 'Customers' },
      { title: 'Say hello in Messaging', detail: 'Reply in team channels or DM a teammate.', to: '/messaging', perm: 'messaging.use', linkLabel: 'Messaging' },
    ],
    modules: [
      PHONE_INSTALL,
      {
        id: 'crew-myday', icon: 'schedule', title: 'My Day', where: 'Sidebar → My Day',
        to: '/my-day', perm: 'time.clock',
        blurb: 'Your whole day on one screen. Today’s cleans, clock in and out, service notes, and what’s coming up. This is your home page.',
        body: [
          { h: 'Run your day', steps: [
            'Today’s cleans are listed in order. Tap one to see the company, site, time window, and its service instructions.',
            'Clock in when you arrive and out when you finish. A running timer sits up top and the office sees your hours live.',
            'Tap "Photos" on a clean to add before/after shots straight from your phone.',
            'The upcoming list shows what’s next so you can plan ahead.',
            'Marking a job Done or Missed is handled by the office. You start the clean and track your time; ask an Admin for any schedule change.',
          ] },
          { warn: 'If you’re too far from the site when you clock in, you’ll see the distance and can confirm to clock in anyway. The office is told it was an override.' },
        ],
      },
      {
        id: 'crew-contacts', icon: 'clients', title: 'Customers', where: 'Sidebar → Customers',
        to: '/contacts', perm: 'contacts.view',
        blurb: 'Look up who to call and how to get in. Read-only for crew, with one exception: site photos.',
        body: [
          { h: 'Find what you need', steps: [
            'Search by name, email, or phone on the Customers list; click a company name to view its details.',
            'On a company, the Access tab shows its location with the address and access notes.',
            'You can add photos to a site. Before/after shots, damage, anything worth documenting.',
            'Activity shows that company’s past and upcoming jobs.',
          ] },
        ],
      },
      {
        id: 'crew-messaging', icon: 'messaging', title: 'Messaging', where: 'Sidebar → Messaging',
        to: '/messaging', perm: 'messaging.use',
        blurb: 'Team channels, DMs, and the customer conversations you’re part of.',
        body: [
          { h: 'Stay in the loop', steps: [
            'Use the toggle to switch between Inbox, Channels (team), and DMs.',
            'Reply in any conversation you’re in; attach photos (up to 25 MB per message).',
            'Snooze a thread to bring it back later; star the ones that matter.',
          ] },
          { tip: 'Starting brand-new customer conversations is an Admin permission by default. If your job needs it, a Super Admin can grant it to your account.' },
        ],
      },
      {
        id: 'crew-quality', icon: 'check', title: 'Quality', where: 'Sidebar → Quality',
        to: '/inspections', perm: 'qc.view',
        blurb: 'See how your sites are scoring, and flag a problem the moment you spot one.',
        body: [
          { h: 'Review and report', steps: [
            'The Inspections and Checklists tabs show recent results for the sites you clean. Open one to see what passed and what got flagged.',
            'Hit a problem on site. Damage, supplies out, an access issue? The Problems tab → "Report a problem": pick the site, describe it, set how urgent. The office sees it right away.',
            'Add photos to a problem so there’s no guessing, and watch it move Open → Acknowledged → Resolved.',
          ] },
          { tip: 'You review results and report problems; running scored inspections and building templates is a manager job.' },
        ],
      },
      {
        id: 'crew-keys', icon: 'lock', title: 'Keys', where: 'Sidebar → Keys',
        to: '/keys', perm: 'keys.view',
        blurb: 'The sign-out sheet for company keys. Check out when you take one, check in the moment it’s back.',
        body: [
          { p: 'Keys are filed under their company. A key’s status is "In" (at the office) or "Out". And when it’s out, the row names exactly who has it.' },
          { h: 'Key custody', steps: [
            'Click "Check out" before a key leaves. The holder defaults to you. Pick a teammate, or "Someone else (company contact, contractor…)" by name, so the log always shows who really has it. Add a note for why ("Friday deep-clean").',
            'Click "Check in" the moment it’s returned. One click, and the key reads "In" again.',
            'Find a key fast with the search box (company, key, master code, or holder) and the In / Out / Unknown chips. The status badge itself is a menu if something needs correcting.',
            '"History" on any key shows every movement: who took it, when, who logged it back in.',
            'Wrong label or note on a key? That’s inventory. Ask an Admin; crew accounts check keys in and out but don’t edit them.',
          ] },
        ],
      },
      {
        id: 'crew-account', icon: 'user', title: 'Your Account', where: 'Sidebar → Settings',
        to: '/settings/account', perm: 'settings.account',
        blurb: 'Your profile, password, and what notifies you.',
        body: [
          { h: 'Make it yours', steps: [
            'Update your name, initials, and phone. Save applies immediately.',
            'Change your password (minimum 8 characters).',
            'Turn on mobile push, "Subscribe this device", then "Send test push" to confirm it works.',
            'Flip the notification toggles to control what pings you.',
          ] },
        ],
      },
    ],
  },
};

// Flatten a module's copy for search (precomputed per module id, both guides).
function moduleText(m) {
  const parts = [m.title, m.where, m.blurb];
  for (const b of m.body) {
    if (b.h) parts.push(b.h);
    if (b.p) parts.push(b.p);
    if (b.tip) parts.push(b.tip);
    if (b.warn) parts.push(b.warn);
    if (b.steps) parts.push(...b.steps);
    if (b.list) parts.push(...b.list);
  }
  return parts.join(' ').toLowerCase();
}
const SEARCH_TEXT = Object.fromEntries(
  Object.values(GUIDES).flatMap((g) => g.modules.map((m) => [m.id, moduleText(m)])),
);

function Block({ block }) {
  if (block.tip || block.warn) {
    return (
      <div className={`qs-callout ${block.warn ? 'warn' : ''}`}>
        <Icon name={block.warn ? 'warning' : 'check'} size={14} />
        <span>{block.tip || block.warn}</span>
      </div>
    );
  }
  return (
    <>
      {block.h && <h4 className="qs-h">{block.h}</h4>}
      {block.p && <p className="qs-p">{block.p}</p>}
      {block.steps && (
        <ol className="qs-steps">
          {block.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
      {block.list && (
        <ul className="qs-list">
          {block.list.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
    </>
  );
}

export default function SettingsQuickStart() {
  const state = useStore();
  const check = usePermissionChecker();
  const isCrew = selectCurrentUser(state)?.role === 'crew';

  const [audSel, setAudSel] = useState('admin');
  const aud = isCrew ? 'crew' : audSel; // crew logins only ever see the Crew guide
  const guide = GUIDES[aud];

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [allOpen, setAllOpen] = useState(false);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => {
      // Marketing is dormant (MARKETING_ENABLED, lib/features.js) — drop its card
      // from the guide until the feature is opted back in.
      const modules = guide.modules.filter((m) => MARKETING_ENABLED || m.id !== 'marketing');
      return q ? modules.filter((m) => SEARCH_TEXT[m.id].includes(q)) : modules;
    },
    [q, guide],
  );

  const switchAudience = (next) => {
    setAudSel(next);
    setQuery('');
    setOpen(new Set());
    setAllOpen(false);
  };
  const toggle = (id) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (allOpen) { setOpen(new Set()); setAllOpen(false); }
    else { setOpen(new Set(guide.modules.map((m) => m.id))); setAllOpen(true); }
  };

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Quick Start Guide</h1>
      </div>

      <div className="card detail-card">
        <h3 className="dash-card-title">{guide.setupTitle}</h3>
        <p className="qs-p" style={{ marginTop: 0 }}>{guide.setupIntro}</p>
        <ol className="qs-setup-list">
          {guide.setup.map((s, i) => (
            <li key={i} className="qs-setup-item">
              <span className="qs-setup-num">{i + 1}</span>
              <div>
                <strong>{s.title}</strong>
                {' '}
                {check(s.perm)
                  ? <Link className="qs-setup-link" to={s.to}>{s.linkLabel}</Link>
                  : <span className="qs-setup-link muted">{s.linkLabel}</span>}
                <p>{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="qs-toolbar">
        {!isCrew && (
          <div className="segmented" role="tablist" aria-label="Guide audience">
            {Object.entries(GUIDES).map(([key, g]) => (
              <button
                key={key}
                type="button"
                className={`segmented-btn ${aud === key ? 'active' : ''}`}
                onClick={() => switchAudience(key)}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
        <input
          className="input qs-search"
          type="search"
          placeholder="Search this guide…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the guide"
        />
        <button type="button" className="btn btn-primary" onClick={toggleAll}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {visible.length === 0 && (
        <EmptyState title="No matches" message="No module mentions that. Try a different word." />
      )}

      {visible.map((m) => {
        const isOpen = q ? true : open.has(m.id);
        return (
          <div key={m.id} className={`card qs-card ${isOpen ? 'open' : ''}`}>
            <button type="button" className="qs-card-head" onClick={() => toggle(m.id)} aria-expanded={isOpen}>
              <span className="qs-card-icon"><Icon name={m.icon} size={16} /></span>
              <span className="qs-card-text">
                <span className="qs-card-title">{m.title}</span>
                <span className="qs-card-where">{m.where}</span>
                <span className="qs-card-blurb">{m.blurb}</span>
              </span>
              <span className="qs-card-chevron"><Icon name="chevronDown" size={16} /></span>
            </button>
            {isOpen && (
              <div className="qs-card-body">
                {m.body.map((b, i) => <Block key={i} block={b} />)}
                {m.to && check(m.perm) && (
                  <div className="qs-card-foot">
                    <Link className="btn btn-primary" to={m.to}>Open {m.title}</Link>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
