# Shell Completion Roadmap

## Context

This repo (`Kronelius/shell-build`) is the **master shell** — a reusable foundation we deploy to every client. Core is shipped in the shell baseline; add-on modules below are listed for shell continuity and built per-client when sold.

**Out of scope here:** per-client branded websites are built and live in separate repos.

## Deployment model

1. Commit the finished shell to `Kronelius/shell-build` as the canonical baseline.
2. For each new client: create a repo under the **client's GitHub credentials**, push shell as initial commit, add **Kronelius as collaborator** with admin/write access.
3. Per-client work is config + data only (theme, services, users, content, migrations) — never code forks.

Bug fixes and feature backports flow shell → client repos as PRs from Kronelius.

## Build depth expectation

Build production-shaped, not placeholder-shaped. Every module ships with full entity + reducer + selectors + every UI surface + permissions + activity logging in one pass.

## Status legend

`[ ]` open · `[~]` in progress · `[x]` done

---

# CORE — shell baseline

Every item here ships in the shell baseline (`Kronelius/shell-build` main). Per-client clones inherit Core for free; add-ons are sold and built à la carte.

## `[x]` Operations Dashboard `[Core]`

Built as `Dashboard.jsx`. Audit + finish:
- Greeting + role-aware view
- Today's schedule (own jobs for crew, all for admin) — **[x]**
- Week revenue chart — **[x]**
- Top clients — **[x]**
- Overdue invoice list — **[x]**
- Follow-ups card (stale leads + unanswered threads) — **[x]**
- Mobile-friendly layout audit — **[x]** (`minmax(0, 1fr)` grid fixes; verified at 375/768/desktop)
- Client-specific dashboard cards — **per-client repo** (not shell)

## `[x]` Scheduling & Calendar `[Core]`

Built as `Schedule.jsx`. Audit:
- [x] Day / week / month views
- [x] Drag-drop reschedule (week view DnD + day view Reschedule button)
- [x] RRULE recurrence (daily / weekly / biweekly / monthly / custom)
- [x] Conflict detection (overlapping cleaner assignments)

## `[x]` Client Database `[Core]`

Largely built. Audit:
- Contacts/Accounts split — **[x]**
- Tagging system — **[x]**
- Per-contact visibility — **[x]**
- Owner assignment — **[x]**
- Activity timeline — **[x]**
- ContactDetail / ClientDetail tabs — **[x]**
- Email uniqueness — **[x]**
- **Migration tooling** — **[x]** Contacts-only CSV import (GHL-style — accounts derive from contacts, not imported separately): file upload + paste, auto-mapping by header name, column-to-field mapping UI, preview with email-keyed dedup + identifier-presence validation, batch dispatch. Any one of email / phone / firstName / lastName / company is enough to accept a row; rows with no email surface a "dedup skipped" note. Unknown company names auto-create accounts (case-insensitive, batch-deduped) so contact-imports populate Accounts as a side effect. Built-in "Download sample CSV" link in the upload step. (Per-client data import billed separately as $200 add-on.)

## `[x]` Automated Reminders (staff/clients) `[Core]`

Customer-facing reminder scheduler — fully wired, no operator UI.

- `[x]` 24-hour reminder template (auto-fires when job startAt is 12–30h away)
- `[x]` Day-of reminder template (auto-fires when startAt is 0–12h away)
- `[x]` Booking confirmation template (auto-fires immediately on `ADD_JOB` for upcoming jobs)
- `[x]` Post-service template (auto-fires when job status flips to `completed`)

**Architecture:** `lib/reminderScheduler.js` exposes pure functions (`shouldFire`, `getDueReminders`, `interpolate`, `buildTokens`). `components/ReminderScheduler.jsx` mounts at app root, ticks every 60s, dispatches `ADD_REMINDER_EVENT` (status `pending`) → calls `lib/twilio.sendSMS` or `lib/email.sendEmail` → dispatches `UPDATE_REMINDER_EVENT` with final status. Token interpolation: `{client_contact} {company} {service} {site_name} {date} {time}`. Module-level `inFlight` Set + state-based `hasFired()` handle dedup.

The reminder *settings UI* (templates editor, sequence enable/disable, delivery inbox) was deleted in the v28 notifications redesign — operators don't need to edit templates or audit deliveries. The scheduler keeps firing in the background; failures fail silently. `state.reminderTemplates` and `state.reminderEvents` remain in seed/state because the scheduler reads them.

## `[x]` Per-user notification preferences + PWA + Web Push `[Core]`

Replaced the previous "Reminders" settings page with per-user, role-aware notification preferences co-located inside Account, plus a PWA install + Web Push pipeline so staff can receive notifications on their phone when the app is closed.

**State (v27 → v28, additive):**
- `users[i].notificationPrefs` — per-event toggles + `mobilePushEnabled` master flag. All event toggles default on; mobile push defaults off until the user opts in. Migration backfills defaults on existing users.
- New reducer action `UPDATE_NOTIFICATION_PREFS` (`{ userId, patch }`) for partial updates.
- New selectors `selectNotificationPrefs`, `selectVisibleNotificationGroups`, `selectShouldNotifyUser`.
- `selectUnreadForConversation` now respects `mutedByUserIds` — muting a thread silences both badges and the listener.

**Catalog (`lib/notifications.js`):** single source of truth for the toggle list, role allowlists, and permission gates. Three groups: Messaging (new customer message, DM, internal chat), Schedule (job created/rescheduled, job cancelled), Invoices (paid, overdue — gated on `invoices.view`). Crew see Schedule + DMs/internal only. Owner/Admin see everything subject to role allowlist.

**Account → Notifications:** Account page now has a grouped toggle list (`pref-row` styling) plus a Mobile Push card. The mobile push card detects iOS-not-installed-as-PWA and shows install instructions; surfaces stub-mode notice when no backend is wired; lists per-device subscriptions with Remove buttons; includes a "Send test push" button.

**In-app delivery (`components/NotificationListener.jsx` + `lib/documentTitle.js`):** root-mounted listener diffs state for new messages / job changes / invoice status changes. Fires `toast.info()` and updates `document.title` to `(N) <BRAND.titleSuffix>` (e.g. `(N) PolishPoint CRM` in the shell baseline). First-mount guard seeds the "seen" set so existing items don't trigger a flood. Mute respected.

**PWA install:**
- `app/manifest.template.json` (templated via `scripts/build-manifest.mjs` from `app/src/brand.config.js`; emitted to `public/manifest.json` on every dev/build). Includes name + short_name + icons + standalone display + brand theme color.
- Brand icons generated from `<BRAND.logoFile>` (e.g. `polishpoint-logo.png`) via `scripts/gen-pwa-icons.mjs` (one-shot Node + sharp): `favicon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`. Re-run the script when the logo or brand color changes.
- `index.html` head: manifest link, theme-color, apple-touch-icon, iOS PWA meta tags. Brand placeholders (`%BRAND_TITLE%`, `%BRAND_PRIMARY%`, `%BRAND_SHORT_NAME%`) are substituted by `vite-plugin-brand.js`.

**Service worker (`app/public/sw.js`) + registration in `main.jsx`:** hand-rolled, no Workbox. Two handlers — `push` (showNotification with title/body/icon/tag/data.url) and `notificationclick` (focus existing client + navigate, or open new). No offline caching.

**Push adapter (`lib/push.js`):** mirrors `lib/twilio.js` / `lib/email.js`. `enableMobilePush` / `disableMobilePush` / `getCurrentSubscription` / `getDevices` / `removeDevice` / `sendTestPush` / `urlBase64ToUint8Array` / `isPushSupported` / `isStandalonePWA` / `isIOS`. Branches on `VITE_PUSH_BACKEND_URL`; stub mode keeps an in-memory subscription list and fires a local Notification for the test-push path so the dev experience is exercisable without a backend.

**Backend contract (deployment companion repo, not this repo):**
- `POST /api/push/subscribe` — `{ userId, subscription, deviceLabel }` → upsert in `push_subscriptions`.
- `DELETE /api/push/subscribe` — `{ userId, endpoint }` → drop row.
- `GET /api/push/devices?userId=` → device list for the per-device UI.
- `POST /api/push/test` → `{ delivered, failed, expired }`.
- Push fan-out service called from existing event sources (Twilio webhook, email inbound, etc.) using `web-push` + VAPID.

**Env (`.env.example`):** new `VITE_PUSH_BACKEND_URL`, `VITE_VAPID_PUBLIC_KEY` (frontend); `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (backend). Generate keypair with `npx web-push generate-vapid-keys`.

**Removed:**
- `pages/settings/Notifications.jsx` (deleted; 467 lines).
- `Notifications` pill + reminder badge wiring in `SettingsLayout.jsx`.
- `/settings/notifications` route now redirects to `/settings/account`; `/reminders` redirects to `/`.

## `[x]` Messaging Suite `[Core]`

Built. Audit:
- GHL-style inbox — **[x]**
- Snippets — **[x]**
- Assignment + contact linkage — **[x]**
- Pinned threads — **[x]**
- Context panel with inline editing — **[x]**
- Mobile-friendly behavior — **[x]** Single-pane mobile pattern: inbox by default, tap thread → message panel with back button, tap back → inbox. No auto-select on mobile.
- User-to-user DMs — **[x]** Third inbox bucket alongside Inbox + Internal Chat. Channel `dm` + `participantUserIds: [a, b]` on `conversations`; privacy gated to participants in `selectConversationsForInbox` (owners/admins do NOT see DMs they aren't party to). `NewDmModal` reuses the AssignMenu-style picker. Storage bumped v19 → v20.

## `[x]` Marketing (cold-email sequences) `[Core]`

Backported from the Rainier proving build (2026-06). Multi-step email drip
sequences with company-shared rotation inboxes, AI-routed inbound replies, and
per-contact enrollments. Distinct from Messaging (which is per-user, 1:1). Runs
**fully in stub mode on the shell** — no backend required; the `api/inbox/*`
Vercel routes + Supabase migrations are the deferred backend workstream.

**Architecture:** the send path routes through `lib/connectedInboxes.sendViaInbox()`
(simulates locally when `VITE_EMAIL_BACKEND_URL` is unset). `lib/marketingScheduler.js`
is pure-compute (due-step selection, send-window + daily-cap + inbox-rotation
rules). `components/MarketingScheduler.jsx` ticks + dispatches sends;
`components/MarketingInboundListener.jsx` polls for replies (no-op offline).
The "Simulate a reply" affordance in the Replies tab exercises the inbound
path in the demo.

**Surfaces (`/marketing`, gated on `marketing.view`):**
- `[x]` Sequences tab — list + create + multi-step drip editor with "On reply" routing + flow graphic
- `[x]` Inboxes tab — connected rotation mailboxes + per-inbox sender name / signature
- `[x]` Replies tab — inbound reply inbox + inline composer + simulate-reply
- `[x]` Settings tab — reply-routing target (pipeline stage) + send window + plain-text default
- `[x]` Gmail connect flow (`ConnectMarketingInboxModal` + de-Rainier-ified `GmailConnectInstructions`)
- `[x]` Permissions: `marketing.view` / `marketing.manage` / `marketing.connectInbox` (owner+admin)
- `[x]` State: marketingInboxes / marketingSequences / marketingEnrollments / marketingSends / marketingReplies / marketingSettings. Storage v37 → v38.

**Deferred (backend workstream):** real Gmail OAuth + send via `api/inbox/*`, inbound webhook delivery, multi-tenant inbox auth. The correlation headers are emitted as `X-PP-Marketing-*` (renamed from Rainier's `X-Rainier-*`); a future backend's inbound webhook must echo these.

## `[x]` SMS via Twilio + A2P setup `[Core]`

Definition of done — all shipped:
- `[x]` Twilio account connection flow (`settings/Integrations.jsx`, `ConnectTwilioModal.jsx`)
- `[x]` Single-number provisioning + display (step 2 of connect flow)
- `[x]` A2P 10DLC registration helper — full form + status tracking + super-admin override (`A2PRegistrationModal.jsx`)
- `[x]` Inbound SMS → Messaging thread routing (`RECEIVE_SMS` action; matches by phone or creates unlinked thread; `TwilioInboundListener` subscribes in production)
- `[x]` Outbound SMS send from Messaging (gated on `selectIsTwilioSendReady`; `SET_MESSAGE_DELIVERY` cycles queued → sent → delivered via `subscribeToDelivery`)
- `[x]` Delivery receipt handling on conversation-messages (`deliveryStatus`, `twilioMessageSid`, `failureReason` on each outbound message)
- `[x]` Number management UI (in connection card; disconnect flow)
- `[x]` Inbound webhook URL display + copy-to-clipboard (for ops to register with Twilio)
- `[x]` Test SMS card on Integrations page (verify outbound without leaving Settings)
- `[x]` Simulate inbound SMS card (dev only — exercises the routing path; auto-hidden when `VITE_TWILIO_BACKEND_URL` is set)
- `[x]` Permission keys (`integrations.view` admin+, `integrations.manage` super-admin only)
- `[x]` Send-readiness blockers card (lists every reason SMS can't send)

**Architecture chosen:** option (b) — frontend-adapter pattern. `lib/twilio.js` exposes the full integration surface (`connectTwilio`, `provisionNumber`, `disconnectTwilio`, `sendSMS`, `subscribeToDelivery`, `subscribeToInbound`, `simulateInbound`, `submitA2P`). When `VITE_TWILIO_BACKEND_URL` env var is set, calls hit the deployment backend; otherwise the adapter simulates locally with realistic timings (queued → sent → delivered, ~8% stub failure rate to exercise failure UI).

Storage bumped v7 → v8 (`pp.store.v8`).

## `[x]` Logging invoices `[Core]`

Built as `Invoices.jsx` + `InvoiceDetail.jsx`. **Note: only logging in Core** — full invoice/payment customization is the IPR add-on (per-client purchase). Audit Core scope:
- Manual invoice creation — **[x]**
- Status tracking (draft / sent / paid / overdue) — **[x]**
- Payment recording (manual entry only in Core) — **[x]**
- Billing-contact picker — **[x]**

## `[x]` Role label naming `[Core]`

Decision: **keep the schema** (`owner / admin / crew`) and rely on `ROLE_LABELS` for UI display ("Super Admin / Admin / Crew"). Documented in `roles.js`. Renaming the schema would touch every reducer/selector/permission check for zero user-visible benefit. If a client wants different labels, update `ROLE_LABELS` only.

## `[x]` Permission defaults audit + Roles editor discoverability `[Core]`

Friday meeting follow-up. Tightened 5 default permissions and restructured the Roles editor so an Owner can land on it cold and configure permission levels for the other two roles in 30 seconds.

**5 default flips** (in `app/src/lib/roles.js`):
- `pipeline.view`: removed from crew (sales pipeline is office-tier)
- `messaging.startConversation`: removed from crew (crew can still reply via `messaging.use`; outbound to clients is a liability)
- `messaging.internalComment`: granted to crew (internal notes are exactly what crew should post)
- `settings.services`: removed from admin (service catalog = pricing; owner-only by default)
- `integrations.view`: removed from admin (reduces blast radius if admin compromised)

**Roles editor restructure** (`app/src/pages/settings/Roles.jsx`):
- 8 grouped tables (Schedule & Jobs / Clients & Sites / Contacts & Pipeline / Invoices & Reminders / Messaging / Settings / Integrations / Super Admin Only) instead of one flat 39-row table
- "Sensitive" pill on 8 high-impact keys (clients.archive, contacts.delete, invoices.edit, invoices.recordPayment, integrations.manage, settings.roles.edit, staff.assignRoles, staff.editOverrides) with warning-toned toast on grant
- Precedence callout above the matrix ("per-user revoke → per-user grant → role default")
- "Reset all to defaults" escape hatch in the page header
- "Other" fallback section catches any new permission keys added to roles.js without grouping

**Discoverability**:
- Settings sidebar relabeled "Roles" → "Roles & Permissions"
- Cross-link from Team page header: "Edit role defaults →" (gated on `settings.roles.edit`)

**Schema bump**: `pp.store.v9` → `pp.store.v10`; `INITIAL_STATE.version` 9 → 10.

Per-user override system at `/settings/team/[user]` was confirmed already production-shaped — no changes needed there.

---

# Done (recent shell work — for reference)

- `[x]` Phase 1 CRM (Contacts/Accounts split, Pipeline, Super Admin permissions)
- `[x]` Phase 2 Messaging (GHL-style inbox, snippets, assignment, contact linkage, focus modal)
- `[x]` Phase 2 cross-module contact linkage (invoices, jobs, messaging)
- `[x]` Pipeline polish (uniform cards, drop indicator, reorder)
- `[x]` Dashboard Follow-ups card
- `[x]` Add-User modal (Settings → Team)
- `[x]` Roles editor (Settings → Roles, editable matrix)
- `[x]` Pipeline bulk actions + stage CRUD
- `[x]` Reminders delivery inbox (per-event read/unread + retry + delivery dashboard)
- `[x]` SMS via Twilio + A2P 10DLC (Settings → Integrations: connect, number provision, A2P registration with super-admin status override, webhook URL display, test SMS, simulate inbound; full adapter pattern in `lib/twilio.js`; outbound wired through Messaging composer with delivery-status tracking; inbound auto-routes to existing or new thread)
- `[x]` Automated Reminders auto-fire (`lib/reminderScheduler.js` + `components/ReminderScheduler.jsx`: booking_confirmation on new upcoming jobs, reminder_24h in 12–30h window, day_of_eta in 0–12h window, post_service on status=completed; routes through `lib/twilio.js` for SMS and `lib/email.js` for email; real retry that re-delivers through the adapter; pending/sent/failed lifecycle visible in Delivery Inbox)
- `[x]` Email System — Phase 1–4 frontend (`Core`)
  - **Phase 1 — System transactional (Resend):** `state.company.integrations.email` slot mirroring `…twilio`; `CONNECT_/DISCONNECT_/UPDATE_EMAIL_*` reducer actions + matching selectors (`selectIsEmailSendReady`, `selectEmailBlockers`, etc.); `lib/email.js` extended with `headers`/`tags` + `getEmailHealth()`; `AddUserModal` reads `selectEmailDefaultFrom` (falls back to `company.email` in dev); `.env.example` documents the full env surface.
  - **Phase 2 — Settings → Integrations Resend card:** Connection · Domain Verification (DKIM rows with copy-row + status polling) · Test Email · blockers banner. `ConnectEmailProviderModal` mirrors `ConnectTwilioModal`. Page subtitle calls out the system/per-user split.
  - **Phase 3 — Connected Inboxes (per-user):** new `state.connectedInboxes` slice (tokens NEVER live in client state); `ADD_/UPDATE_/REMOVE_/SET_DEFAULT_CONNECTED_INBOX` actions + per-user selectors. New `lib/connectedInboxes.js` adapter with `connectGoogle()` / `connectMicrosoft()` (OAuth-popup helper) / `connectSmtp()` / `disconnectInbox()` / `testInboxSend()` / `sendViaInbox()`. New `Settings → Connected Inboxes` page (`/settings/inboxes`, gated on `messaging.use`) with empty-state, per-row actions (Set default / Test send / Disconnect), and `ConnectInboxModal` providing per-ESP help panels (Gmail Workspace admin guidance, Microsoft tenant consent, Yahoo/iCloud/Fastmail/Zoho app-password walk-throughs, custom SMTP guidance) plus a troubleshooting table on failure (auth/connection/timeout/TLS/less-secure-apps).
  - **Phase 4 — Email channel inside Messaging:** compose-pane SMS↔Email segmented toggle (only when contact has both phone + email); Email reveals Subject + "Sending as" inbox dropdown with auto-prefilled `Re:` on replies; inline "Connect your inbox" CTA when no active connection. Toggling channel auto-creates / navigates to the contact's other-channel thread. `Messaging.handleSend` routes Email through `sendViaInbox(inboxId, …)` with `Message-ID` / `In-Reply-To` / `References` headers built from prior messages. `RECEIVE_EMAIL` reducer action mirrors `RECEIVE_SMS` (matches by `In-Reply-To` first, then by from-email contact, then unlinked). `simulateInboundEmail()` dev helper. `Settings → Notifications` boundary banner clarifies system-sender vs per-user sender. Schema bumped `pp.store.v26` → `pp.store.v27` (additive migration).

  Backend `app/api/email/*` and `app/api/inbox/*` routes (Resend wrapper, OAuth, SMTP handshake, Pub/Sub / Graph webhooks, IMAP poll) are documented in the plan + `.env.example` and live in the deployment companion repo — not this repo. Frontend adapters all fall into local stub mode when `VITE_EMAIL_BACKEND_URL` is unset.

---

# Per-client clone checklist (run after every shell clone for a new client)

For each new deployment:

1. Update `app/src/brand.config.js` (name, primaryHex, primaryRgb, logoFile, titleSuffix)
2. Replace `app/src/theme-polishpoint.css` with `theme-<client>.css` and update the `@import` in `app/src/index.css`
3. Drop the client logo PNG into `app/public/<logoFile>`; run `node scripts/gen-pwa-icons.mjs`
4. Update `app/src/data/seed.js` company entity + team users; bump `INITIAL_STATE.version` + `STORAGE_KEY`
5. Optional: tune role permission defaults in `roles.js` for the client's policy preferences
6. Optional: CSV-import existing contacts ($200 migration add-on)
7. Optional: phone line porting (Twilio number provision via Settings → Integrations)

---

# Future add-on modules (per-client purchases — don't build until sold)

Listed here for shell-roadmap continuity only. When a client buys one of these, expand it into full DoDs at that time.

- `[Sold separately]` **Invoice & Payment Routing — $400** — customizable templates, automated invoice reminders, Stripe Connect, recurring billing, tipping, payment routing
- `[Sold separately]` **QuickBooks Integration — $300** — bidirectional sync (customers / invoices / payments), AR aging surfaces
- `[Sold separately]` **Inventory Management — $400** — physical key tracking + general inventory (supplies, equipment, stock alerts)
- `[Sold separately]` **Employee Management System — $800** — document storage with expiration, certifications & training, GPS clock-in/out, ESIGN/UETA-compliant onboarding, supervisor inspections, raise/promotion workflow, time-off requests, Gusto integration
- `[Sold separately]` **Field Ops — $600** — digital cleaning checklists, before/after photos, offline capability, job completion verification (checklist + photos + GPS)

---

# Stretch / unsold (not in any package)

These come up in client questionnaires but typically aren't in initial-package scope. Not promised, not sold. Don't build unless a client explicitly purchases.

- 7-day sales sequence automation (would be a future "Sales Automation" add-on)
- Quotes / Estimates module (most cleaning shops still gut-call quotes)
- Generic client-onboarding workflow with department handoffs
- Lifecycle email engine (welcome / first-clean recap)
- Operational KPI cards (missed cleans / labor / complaints) — *unless rolled into Core dashboard for a specific client*
