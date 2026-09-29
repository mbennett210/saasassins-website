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

**44 endpoints** · 14 catch-all domains · 13 distinct stances

| Route | Auth stance |
|---|---|
| `/account-media/[...path]` | requireAuthority |
| `/cron/ops-alerts` | cron-secret (fails closed) |
| `/cron/reap` | cron-secret (fails closed) |
| `/email/health` | requireAuthority |
| `/email/send` | requireAuthority |
| `/geo` | requireAuthority |
| `/hr-files/[...path]` | requireRoleOrPermission (domain gate) |
| `/inbox/[id]/disconnect` | requirePermission (domain gate) |
| `/inbox/[id]/send` | requireInboxOwner (domain gate) |
| `/inbox/[id]/test` | requireInboxOwner (domain gate) |
| `/inbox/connect/start` | requirePermission (domain gate) |
| `/inbox/inbound` | requireAuthority |
| `/inbox/ingest` | cron-secret (fails closed) |
| `/inbox/oauth/google/callback` | signed OAuth state (HMAC, 10-min TTL) |
| `/invoice-attachments/[...path]` | requirePermission (domain gate) |
| `/marketing/run` | cron-secret (fails closed) |
| `/public/pay/[...path]` | public, token-scoped |
| `/public/qc/[...path]` | declared PUBLIC (see header) |
| `/push/devices` | requireAuthority |
| `/push/dispatch` | cron-secret (fails closed) |
| `/push/flush` | requireAuthority |
| `/push/status` | requireRole([owner, admin, manager]) |
| `/push/subscribe` | requireAuthority |
| `/push/test` | requireAuthority |
| `/qc/[...path]` | requirePermission (domain gate) |
| `/quotes/[...path]` | requirePermission (domain gate) |
| `/reminders/run` | cron-secret (fails closed) |
| `/reviews/[...path]` | cron-secret (fails closed) |
| `/settings/[...path]` | requireAuthority |
| `/settings/signature-upload` | requireAuthority |
| `/settings/signature-url` | requireAuthority |
| `/site-security/[...path]` | requireSiteAssignment |
| `/state/heartbeat` | requireAuthority |
| `/state/jobs-delta` | requireAuthority |
| `/state/org-state` | requireAuthority |
| `/state/seed` | requireAuthority |
| `/state/view` | requireAuthority |
| `/support/report` | requireAuthority |
| `/support/upload` | requireAuthority |
| `/time/[...path]` | requireAuthority |
| `/unsubscribe` | signed-token (public, token-scoped) |
| `/variance/[...path]` | requirePermission (domain gate) |
| `/webhooks/[...path]` | per-endpoint bearer / HMAC |
| `/workspaces/[...path]` | requireOwner (domain gate) |
