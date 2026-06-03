# E2E Health + Security Check

A reusable checklist for verifying this app (or any shell clone) is healthy and reasonably hardened before delivery, post-deploy, or after a major change.

**Time budget:** ~1 hr for the smoke pass + ~1 hr for the security pass. Skip nothing — every check below has caught a real issue at least once on a similar shell.

**When to run:**
- Before handing a clone to a client (delivery gate)
- After a storage-shape bump (`INITIAL_STATE.version` + `STORAGE_KEY` change)
- After upgrading React, Vite, or `react-router-dom`
- After touching `lib/twilio.js`, `lib/email.js`, `lib/reminderScheduler.js`, or anything in `store/`
- Quarterly, even if nothing changed (catches new CVEs in deps)

---

## Pre-flight

```bash
git status                 # working tree clean? if not, stash before testing
git fetch && git status    # synced with origin?
npm --prefix app install   # deps fresh
npm --prefix app run dev   # → http://localhost:5173 (or pick a port)
```

Open the dev server in a browser and DevTools → Console. Keep Console open through the whole pass — if anything turns red, capture it.

---

## Part 1 — App Health (E2E smoke)

### 1.1 Routes load with no console errors

Drive every primary route. Each should render its heading with no red console output.

| Route | Expected heading |
|---|---|
| `/` | Dashboard |
| `/schedule` | Schedule |
| `/contacts` | Contacts |
| `/clients` | Contacts (alias) |
| `/pipeline` | Pipeline |
| `/invoices` | Invoices |
| `/reminders` | (redirects to `/settings/notifications`) |
| `/messaging` | Messaging |
| `/settings/account` | Settings |
| `/settings/company` | Settings |
| `/settings/services` | Settings |
| `/settings/tags` | Settings |
| `/settings/team` | Settings |
| `/settings/roles` | Settings |
| `/settings/notifications` | Settings |
| `/settings/integrations` | Settings |

Quick automation (paste in DevTools console):
```js
(async () => {
  const routes = ['/', '/schedule', '/contacts', '/clients', '/pipeline', '/invoices', '/messaging',
    '/settings/account', '/settings/company', '/settings/services', '/settings/tags', '/settings/team',
    '/settings/roles', '/settings/notifications', '/settings/integrations'];
  for (const p of routes) {
    history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await new Promise(r => setTimeout(r, 300));
    const h = document.querySelector('h1, h2')?.textContent?.trim() || '(no heading)';
    console.log(p, '→', h);
  }
})();
```

### 1.2 Detail routes load

Pull seed IDs from localStorage and visit each detail page. None should throw.

```js
(async () => {
  const KEY = Object.keys(localStorage).find(k => k.startsWith('pp.store.v'));
  const s = JSON.parse(localStorage.getItem(KEY));
  const paths = [
    `/contacts/${s.contacts[0].id}`,
    `/clients/${s.clients[0].id}`,
    `/schedule/${s.jobs[0].id}`,
    `/invoices/${s.invoices[0].id}`,
    `/settings/team/${s.users[0].id}`,
  ];
  for (const p of paths) {
    history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await new Promise(r => setTimeout(r, 350));
    console.log(p, '→', document.querySelector('h1')?.textContent?.trim() || '(no heading)');
  }
})();
```

### 1.3 Permission gating across roles

Switch users via the UserSwitcher chip (sidebar footer). Verify the no-access screen appears for each gated route.

| Role | Should see | Should be blocked from |
|---|---|---|
| **Owner** (Kyle, Steve) | Everything | Nothing |
| **Admin** (Heather, Lauren) | Schedule, Contacts, Pipeline, Messaging | Invoices, Reminders, `/settings/roles`, `/settings/integrations` |
| **Crew** (Marcus, Riley, Jamie, Casey) | Schedule, Contacts, Messaging | Pipeline, Invoices, Reminders, all sensitive `/settings/*` |

Detection in console: blocked page renders `<div class="no-access">…</div>`.

### 1.4 Reseed cycle

Confirm storage-version bumps trigger a clean reseed (not a stale-state crash).

1. Note the current `STORAGE_KEY` in `app/src/store/persist.js` (e.g. `pp.store.v14`).
2. In DevTools: `localStorage.removeItem('pp.store.v14')` then reload.
3. App should rehydrate from `INITIAL_STATE` with no errors. Counts should match `data/seed.js`.
4. Default user should be the seed's first owner (Alex Morgan in the shell baseline).

### 1.5 Reminder scheduler

Open `/settings/notifications` and switch to the Delivery Inbox tab. It should show events with mixed `sent` / `failed` / `pending` statuses. Failed rows should have a clear `failureReason` string. The retry button on a failed row should re-dispatch and either succeed or fail with a fresh reason — never silently no-op.

### 1.6 Production build

```bash
npm --prefix app run build
```

Must complete with zero errors. The 500 KB chunk-size warning is acceptable for now. If `tsc` or `eslint` complains, fix before shipping.

### 1.7 Mobile layout sanity

Resize the viewport to 375px (or use DevTools device emulation). Key checks:
- Sidebar collapses to a hamburger
- Dashboard cards stack 1-column
- Tables don't horizontally overflow the viewport
- Modals fit in viewport with no scroll-trap

---

## Part 2 — Security audit

### 2.1 Dependency vulnerabilities

```bash
npm --prefix app audit
```

Pass: 0 high/critical. Moderate is a judgment call — read the advisory and decide. If blocked: `npm audit fix` first, manual upgrade second. Never ship with a known critical.

### 2.2 No tracked secrets

```bash
git ls-files | grep -E '\.(env|pem|key|p12|pfx)$'   # → empty
```

If anything shows up: stop, rotate the credential, scrub from history with `git filter-repo`, then continue.

### 2.3 No hardcoded credentials in source

```bash
# From app/app/src
grep -rEni "(api[_-]?key|secret|password|token|sk_live|sk_test|AKIA|AIza|ghp_|gho_)\s*[:=]\s*['\"][^'\"]+['\"]" .
```

Pass: zero matches in source files. Test fixtures and seed data are OK if they're obviously fake.

### 2.4 No XSS vectors

```bash
# From app/app/src
grep -rEn "dangerouslySetInnerHTML|innerHTML|outerHTML|document\.write|eval\(|new Function\(" .
```

Pass: zero matches. If new matches appear, every one needs a defensible reason and input must be sanitized at the source.

### 2.5 No PII / token logging

```bash
# From app/app/src
grep -rEn "console\.(log|info|warn|error|debug)" .
```

Pass: zero in production code paths. Dev-only logs (gated on `import.meta.env.DEV`) are OK but should be reviewed — never log full phone numbers, email bodies, auth tokens, or contact PII even in dev.

### 2.6 Adapter credential handling (Twilio + Email)

Read `app/src/lib/twilio.js` and `app/src/lib/email.js`. Verify:
- Auth tokens / API keys are accepted only as function arguments
- Tokens are forwarded to `BACKEND` via `fetch` — never stored in module scope, never written to `state`, never persisted to localStorage
- The reducer action that follows a successful connection (e.g. `CONNECT_TWILIO`) stores ONLY masked or non-sensitive identifiers (`accountSidLast4`, `phoneNumber`, etc.)
- Stub mode (no `BACKEND` set) is clearly labeled in UI so a deployer can't accidentally ship believing real credentials are flowing

Read `app/src/components/ConnectTwilioModal.jsx`:
- Auth Token input has `type="password"`
- Token lives in component-local React state only — confirm by tracing the submit handler

### 2.7 localStorage content review

In DevTools console:
```js
const KEY = Object.keys(localStorage).find(k => k.startsWith('pp.store.v'));
const blob = localStorage.getItem(KEY);
console.log('size:', (blob.length / 1024).toFixed(1), 'KB');
const obj = JSON.parse(blob);
// Things that should NEVER appear:
JSON.stringify(obj).match(/authToken|password|sk_live|sk_test|AKIA/i);
```

Last line should return `null`. The localStorage payload is the user's browser — they own it — but auth tokens still don't belong there because they grant network capability beyond the user's session.

### 2.8 Backend env-var posture (when deploying)

When `VITE_TWILIO_BACKEND_URL` or `VITE_EMAIL_BACKEND_URL` is set for a real deployment:
- Backend lives at a domain you control (not the SPA origin if possible — at minimum a path under it)
- Backend validates the SPA's origin and rejects cross-origin without explicit allowlist
- Backend holds the real Twilio Account SID + Auth Token in server-only env vars (never `VITE_*` — those ship to the browser)
- Backend logs requests with PII redacted (mask phones, never log message bodies)
- Backend rate-limits per-IP on `/twilio/sms` and `/email/send` (blast radius if a token leaks via XSS)

The shell ships disconnected — these checks only apply once a deployment wires real credentials.

### 2.9 Hosting headers (post-deploy)

When the SPA is hosted (Vercel, Netlify, S3 + CloudFront, etc.), verify response headers on the entry HTML:

| Header | Recommended value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://<backend>` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | minimal — at least disable `camera`, `microphone`, `geolocation` if not used |

Tool: `curl -I https://<deployed-url>` or https://securityheaders.com.

### 2.10 Auth posture (note for future builds)

This shell currently has **no real auth** — the UserSwitcher is a role-simulation control, and the app trusts `state.currentUserId`. That is appropriate for the demo / single-tenant deployment model. **Do not let a client believe this provides security.** Anyone with the URL has full access. If a client needs real multi-user access:
- Adding auth is an add-on engagement, not Core
- Minimum: provider-backed (Auth0, Clerk, Supabase) login → server-issued user ID → server validates every backend call against that user
- Client-side `can()` checks remain UX-only; server is the trust boundary

---

## Part 3 — Findings template

Copy this into a per-run report (e.g. `HEALTH_AUDIT_YYYY-MM-DD.md`) when running the check:

```
# Health + Security Audit — YYYY-MM-DD

**Audited by:** <name>
**Branch / commit:** <hash>
**Storage version:** pp.store.vN
**Deps:** <vite v?>, <react v?>

## Health
- Routes: PASS / FAIL — <details>
- Detail pages: PASS / FAIL
- Permissions: PASS / FAIL
- Reseed cycle: PASS / FAIL
- Reminder scheduler: PASS / FAIL
- Production build: PASS / FAIL
- Mobile layout: PASS / FAIL

## Security
- npm audit: <0 critical, 0 high, N moderate>
- Tracked secrets: PASS
- Hardcoded credentials: PASS
- XSS vectors: PASS
- PII logging: PASS
- Adapter handling: PASS
- localStorage review: PASS
- Backend posture (if deployed): N/A or PASS / FAIL — <details>
- Hosting headers (if deployed): N/A or PASS / FAIL — <details>

## Findings
1. <Severity> <Title> — <File:line> — <Description> — <Fix>
...

## Sign-off
- [ ] All findings addressed or accepted with rationale
- [ ] HANDOFF.md updated with relevant context
```

---

## Appendix — Out-of-scope items (don't run unless asked)

These take real time and aren't included in the standard delivery audit:

- **Automated E2E suite (Playwright):** add when the app has paying users and regressions hurt
- **Penetration testing:** appropriate when a real backend is wired and live
- **PII / GDPR audit:** when storing EU resident data
- **Load / scale testing:** when the app exits demo phase
- **Accessibility (WCAG 2.1 AA) audit:** when a client requires it
