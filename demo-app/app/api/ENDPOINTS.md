# API endpoint inventory

> **Generated — do not hand-edit.** `npm --prefix app run lint:endpoints -- --write`
>
> This file is the artifact playbook II.6 requires: "maintain a live endpoint inventory…
> diff against the previous inventory — anything added needs auth + docs; anything removed
> needs its callers swept." `endpoint-lint` fails the build when this file and `app/api/`
> disagree, or when a route carries no detectable auth stance.
>
> Stances are detected BY CAPABILITY, not by helper name — a hand-rolled bearer/HMAC check
> counts, because "a grep for requireRole structurally cannot find the route that rolled
> its own check."

**64 endpoints** · 32 catch-all domains · 17 distinct stances

| Route | Auth stance |
|---|---|
| `/account-media/[...path]` | requireAuthority |
| `/activity/[...path]` | requirePermission (domain gate) |
| `/avatars/[...path]` | requireAuthority |
| `/client-messages/[...path]` | requirePermission (domain gate) |
| `/client-users/[...path]` | requirePermission (domain gate) |
| `/contracts/[...path]` | requirePermission (domain gate) |
| `/cron/ops-alerts` | cron-secret (fails closed) |
| `/cron/qbo-refresh` | cron-secret (fails closed) |
| `/cron/reap` | cron-secret (fails closed) |
| `/customer-documents/[...path]` | requirePermission (domain gate) |
| `/email/health` | requireAuthority |
| `/email/send` | requireAnyPermission (domain gate) |
| `/email/system-sender` | requireRole([owner]) |
| `/geo` | requireAuthority |
| `/hr-files/[...path]` | requirePermission (domain gate) |
| `/hr-incidents/[...path]` | requireAuthority |
| `/hr-terminations/[...path]` | requireAuthority |
| `/hr-warnings/[...path]` | requireAuthority |
| `/hub/[...path]` | requireHubCaller (domain gate) |
| `/i18n/[...path]` | requireAuthority |
| `/inbox/[id]/disconnect` | requireInboxAdmin (domain gate) |
| `/inbox/[id]/send` | requireInboxOwner (domain gate) |
| `/inbox/[id]/test` | requireInboxOwner (domain gate) |
| `/inbox/connect/start` | requirePermission (domain gate) |
| `/inbox/inbound` | requireAuthority |
| `/inbox/ingest` | cron-secret (fails closed) |
| `/inbox/oauth/google/callback` | signed OAuth state (HMAC, 10-min TTL) |
| `/invoice-attachments/[...path]` | requirePermission (domain gate) |
| `/marketing/run` | cron-secret (fails closed) |
| `/payroll/[...path]` | requireAuthority |
| `/public/auth/[...path]` | declared PUBLIC (see header) |
| `/public/pay/[...path]` | public, token-scoped |
| `/public/qc/[...path]` | declared PUBLIC (see header) |
| `/public/scan/[...path]` | declared PUBLIC (see header) |
| `/push/devices` | requireAuthority |
| `/push/dispatch` | cron-secret (fails closed) |
| `/push/flush` | requireAuthority |
| `/push/status` | requireRole (domain gate) |
| `/push/subscribe` | requireAuthority |
| `/push/test` | requireAuthority |
| `/qc/[...path]` | requireAuthority |
| `/quickbooks/[...path]` | requireRole([owner]) |
| `/quotes/[...path]` | requirePermission (domain gate) |
| `/reminders/run` | cron-secret (fails closed) |
| `/scan-codes/[...path]` | requireAuthority |
| `/settings/[...path]` | requireAuthority |
| `/settings/signature-upload` | requireAuthority |
| `/settings/signature-url` | requireAuthority |
| `/site-attachments/[...path]` | requireSiteAssignment |
| `/site-security/[...path]` | requireSiteAssignment |
| `/sms/[...path]` | requireTwilioSignature (domain gate) |
| `/state/heartbeat` | requireAuthority |
| `/state/jobs-delta` | requireAuthority |
| `/state/org-state` | requireAuthority |
| `/state/seed` | requireAuthority |
| `/state/view` | requireAuthority |
| `/supplies/[...path]` | requirePermission (domain gate) |
| `/support/report` | requireAuthority |
| `/support/upload` | requireAuthority |
| `/time/[...path]` | requireAuthority |
| `/unsubscribe` | signed-token (public, token-scoped) |
| `/variance/[...path]` | requirePermission (domain gate) |
| `/webhooks/[...path]` | per-endpoint bearer / HMAC |
| `/workspaces/[...path]` | requireOwner (domain gate) |
