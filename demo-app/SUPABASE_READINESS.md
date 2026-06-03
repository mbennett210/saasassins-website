# Supabase Readiness — Audit & Migration Plan

**Status:** Living doc. Read alongside [`SHELL_MOBILE_RESPONSIVE.md`](SHELL_MOBILE_RESPONSIVE.md). Originated during the shell's localStorage-to-Supabase migration audit.

**Goal:** Replace the current `localStorage`-backed reducer cache with Supabase (Postgres + Auth + Realtime + RLS) without breaking any existing UI surface. The current store remains as a hot client-side cache; mutations become optimistic + remote-confirmed.

---

## Table of contents

1. [Current architecture](#1-current-architecture)
2. [Schema audit — every entity → table mapping](#2-schema-audit--every-entity--table-mapping)
3. [ID strategy](#3-id-strategy)
4. [Timestamp + soft-delete coverage](#4-timestamp--soft-delete-coverage)
5. [Foreign key + cascade contract](#5-foreign-key--cascade-contract)
6. [Auth + permissions → RLS](#6-auth--permissions--rls)
7. [Mutation pattern — optimistic + confirmed](#7-mutation-pattern--optimistic--confirmed)
8. [Realtime sync](#8-realtime-sync)
9. [Storage strategy](#9-storage-strategy)
10. [Migration plan — phased rollout](#10-migration-plan--phased-rollout)
11. [Pre-migration cleanup checklist](#11-pre-migration-cleanup-checklist)

---

## 1. Current architecture

```
┌─────────────────────────────────────────────────┐
│                React + Vite SPA                  │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │   Pages    │→ │  useStore  │→ │ Selectors │  │
│  │ Components │  │ useDispatch│  │           │  │
│  └────────────┘  └────────────┘  └───────────┘  │
│                        ↓                         │
│                  ┌──────────┐                    │
│                  │ reducer  │  (sync)            │
│                  └──────────┘                    │
│                        ↓                         │
│                ┌──────────────┐                  │
│                │ localStorage │  (hot cache)     │
│                │  pp.store.v14│                  │
│                └──────────────┘                  │
└─────────────────────────────────────────────────┘
```

- **Single source of truth:** `state` in React context. Mutations are synchronous: `dispatch → reducer → setState`.
- **Persistence:** entire state JSON → `localStorage` keyed by `STORAGE_KEY` (currently `pp.store.v14`).
- **Reseed:** version mismatch in stored state forces fresh INITIAL_STATE from `seed.js`.
- **No network:** zero remote dependencies. Twilio + email "send" through stub adapters that branch on `VITE_*_BACKEND_URL`.

**Implication for Supabase migration:** the reducer + selectors stay; they become the **client cache layer**. The boundary moves to the dispatch site — every dispatch becomes an async optimistic update that syncs through Supabase.

---

## 2. Schema audit — every entity → table mapping

Every entity in `state` should map 1:1 to a Supabase table. Embedded subdocuments (e.g. `invoice.lineItems[]`, `invoice.payments[]`) become their own tables.

| Entity (state key) | Postgres table | Notes |
|---|---|---|
| `company` (singleton) | `company` (single row, or `tenant` if multi-tenant) | Currently a flat object; in multi-tenant Supabase, every other table needs a `tenant_id` FK. |
| `users` | `users` (mirrors `auth.users` 1:1 with extra app fields) | `id` becomes the Supabase `auth.uid()`. `role` lives here. |
| `services` | `services` | |
| `frequencies` | `frequencies` | |
| `clients` | `clients` | `archivedAt` for soft delete. |
| `contacts` | `contacts` | `tagIds[]` becomes a join table `contact_tags`. |
| `tags` | `tags` | |
| `contact_tags` (NEW) | `contact_tags(contact_id, tag_id)` | Many-to-many join. Replaces the array column. |
| `sites` | `sites` | |
| `jobs` | `jobs` | `crewIds[]` becomes a join table `job_crew`. `recurrence` JSON column. |
| `job_crew` (NEW) | `job_crew(job_id, user_id)` | Many-to-many. |
| `invoices` | `invoices` | |
| `invoice_line_items` (was embedded) | `invoice_line_items(invoice_id, ...)` | One-to-many. |
| `invoice_payments` (was embedded) | `invoice_payments(invoice_id, ...)` | One-to-many. |
| `invoice_jobs` (was `invoice.jobIds[]`) | `invoice_jobs(invoice_id, job_id)` | Many-to-many. |
| `conversations` | `conversations` | `followedUserIds[]` → `conversation_followers` join. |
| `conversation_followers` (NEW) | `conversation_followers(conversation_id, user_id)` | |
| `messages` | `messages` | |
| `reminderTemplates` | `reminder_templates` | |
| `reminderEvents` | `reminder_events` | |
| `pipelineStages` | `pipeline_stages` | `position` int for ordering (replaces array index). |
| `contactActivities` | `contact_activities` | |
| `userPermissionOverrides` | `user_permission_overrides` | |
| `permissions` (matrix) | `role_permissions(role, perm_key)` | Each (role, perm) is a row; presence = granted. |
| `snippets` | `snippets` | |
| `snippet_folders` | `snippet_folders` | |
| `deals` (if present) | `deals` | Currently embedded in `contact.stage / dealValue / expectedCloseDate`. Decision: keep on contact OR split — see §11. |

**Six new join tables** must be introduced before migration: `contact_tags`, `job_crew`, `invoice_line_items`, `invoice_payments`, `invoice_jobs`, `conversation_followers`. Each replaces a JSON array column today.

---

## 3. ID strategy

**Current:** human-readable string IDs from `seed.js` (`'ct_pat'`, `'cl_evergreen'`) and runtime IDs from `newId()` (`'ct_<random>'`, `'cl_<random>'`).

**Target:** UUIDs (`gen_random_uuid()` in Postgres). Human-readable IDs work for seeded demo data but won't work in production.

**Migration approach:**
- Keep the prefixed pattern for app-generated IDs but switch the suffix to UUID v4: `ct_<uuid>` → still searchable in logs / network panels / db rows, while being globally unique.
- OR drop the prefix entirely and use raw UUIDs — Postgres-native, no string ops.
- Recommend: **drop the prefix.** Postgres FKs are cleaner with raw UUIDs. The prefix was only useful for distinguishing entity types in localStorage debugging — the table name does that in Postgres.

**Action for shell now (pre-migration):**
- Centralize all ID generation through `lib/ids.js` (currently `newId()` in `reducer.js`). One place to swap to `crypto.randomUUID()`.
- Keep the seed.js human-readable IDs only for DEV; flag a warning that they must not be referenced in production.

**Specific IDs to audit:**
- `invoice.id` is currently `'PP-1001'` style (human-friendly invoice number, prefixed via `company.invoicePrefix`). This is **not** a Postgres PK — it's an `invoice_number` column. Add a separate `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and keep `invoice_number` as a unique secondary key.
- Similar for any other "human-friendly" ID.

---

## 4. Timestamp + soft-delete coverage

**Required columns on every table:**
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()` + trigger to auto-update on UPDATE
- `deleted_at timestamptz NULL` for soft-deletable entities (clients, contacts, conversations, jobs)

**Current state:**
- Most entities have `createdAt`. Some have `updatedAt`. Coverage is patchy — see grep results below.
- Soft delete is inconsistent:
  - Clients use `status === 'inactive'` + `archivedAt`
  - Contacts use `lifecycle === 'archived'` + `archivedAt`
  - Conversations use `archived: true` (boolean only, no timestamp)
  - Jobs use `status === 'cancelled'` (no archivedAt)

**Action for shell now (pre-migration):**
- Standardize: every soft-deletable entity gets a `deletedAt` (or `archivedAt`) timestamp column. Status enums stay for app-level workflow but the deletion pattern is the timestamp.
- Audit every reducer ADD / UPDATE to ensure `updatedAt: nowIso()` is set on UPDATE. Currently only contacts do this consistently.

**Audit findings (run `grep updatedAt app/src/store/reducer.js` to confirm):**
- ✅ Contacts: every UPDATE sets `updatedAt`
- ⚠️ Clients: APPEND_CLIENT_NOTE doesn't update `updatedAt`
- ❌ Invoices, jobs, sites, services, frequencies, conversations: `updatedAt` not set on most UPDATE actions
- **Fix:** wrap every UPDATE in a helper that always stamps `updatedAt`.

---

## 5. Foreign key + cascade contract

The cascade behavior shipped this session in the reducer **must map directly to Postgres FK constraints** so the database enforces the same invariants if a mutation goes around the app code.

**Cascade contract (from this session's reducer patches):**

| Delete | Cascades to |
|---|---|
| `services` | `clients.service_id → SET NULL`, `jobs.service_id → SET NULL` |
| `frequencies` | `clients.frequency_id → SET NULL` |
| `users` | `contacts.owner_user_id → SET NULL`, `job_crew(user_id) → DELETE row`, `conversations.assigned_user_id → SET NULL`, `conversation_followers(user_id) → DELETE row`, `messages.author_user_id → SET NULL`, `contact_activities.author_user_id → SET NULL`, `user_permission_overrides(user_id) → DELETE row` |
| `contacts` | `clients.primary_contact_id → SET NULL`, `invoices.billing_contact_id → SET NULL`, `sites.site_contact_id → SET NULL`, `conversations.contact_id → SET NULL`, `contact_activities → DELETE row`, `contact_tags → DELETE row` |
| `tags` | `contact_tags → DELETE row` |
| `sites` | `jobs.site_id → SET NULL`, `invoices.site_id → SET NULL` |
| `jobs` | `invoice_jobs(job_id) → DELETE row`, `reminder_events(job_id) → DELETE row` |
| `invoices` | `invoice_line_items → DELETE`, `invoice_payments → DELETE`, `invoice_jobs(invoice_id) → DELETE` |
| `pipeline_stages` | **REFUSE** if any contact references the stage (current reducer behavior). In Postgres: `ON DELETE RESTRICT`. |

**Postgres column definition example:**

```sql
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  company_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- ...
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
```

The reducer cascades become **redundant safety nets** once Postgres FKs enforce them. Keep both for defense in depth.

---

## 6. Auth + permissions → RLS

**Current:** `state.currentUserId` is set from `seed.js`; user-switcher in dev. No real auth.

**Target:**
- Supabase Auth (email + magic link, or OAuth).
- Every authenticated request includes the JWT.
- `auth.uid()` in Postgres = `users.id` in app.

**Permission system → RLS mapping:**

The current `can(user, permKey, permissions, overrides)` checker is the source of truth for app-side permission gating. Postgres RLS policies must mirror it for any direct-DB access (REST + Realtime channels).

**Pattern: one helper function per permission key, called from RLS policies.**

```sql
-- Helper: does the calling user have a permission?
CREATE OR REPLACE FUNCTION user_has_perm(perm_key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH user_role AS (
    SELECT role FROM users WHERE id = auth.uid()
  ),
  -- Check role default
  role_grant AS (
    SELECT EXISTS (
      SELECT 1 FROM role_permissions rp, user_role ur
      WHERE rp.role = ur.role AND rp.perm_key = $1
    ) AS granted
  ),
  -- Check per-user overrides (revoke beats grant)
  override AS (
    SELECT
      $1 = ANY(grants) AS has_grant,
      $1 = ANY(revokes) AS has_revoke
    FROM user_permission_overrides
    WHERE user_id = auth.uid()
  )
  SELECT
    COALESCE(NOT (SELECT has_revoke FROM override), true)
    AND (
      COALESCE((SELECT has_grant FROM override), false)
      OR (SELECT granted FROM role_grant)
    );
$$;

-- Example policy: only users with 'contacts.view' can SELECT contacts
CREATE POLICY contacts_select ON contacts
  FOR SELECT
  USING (user_has_perm('contacts.view'));

CREATE POLICY contacts_insert ON contacts
  FOR INSERT
  WITH CHECK (user_has_perm('contacts.edit'));

CREATE POLICY contacts_update ON contacts
  FOR UPDATE
  USING (user_has_perm('contacts.edit'))
  WITH CHECK (user_has_perm('contacts.edit'));

CREATE POLICY contacts_delete ON contacts
  FOR DELETE
  USING (user_has_perm('contacts.delete'));
```

**Visibility scope (`contacts.view.all` vs own-only):**

```sql
CREATE POLICY contacts_select_scoped ON contacts
  FOR SELECT
  USING (
    user_has_perm('contacts.view.all')
    OR (
      user_has_perm('contacts.view')
      AND owner_user_id = auth.uid()
    )
  );
```

**Action for shell now (pre-migration):**
- Document every permission key + its CRUD effect (already done in `lib/roles.js`). Each one becomes one or more RLS policies.
- Add `staff.assignRoles`, `staff.editOverrides`, `settings.roles.edit` policies on the `users` and `user_permission_overrides` tables — these are the highest-leverage policies (a privilege escalation here = total compromise).

---

## 7. Mutation pattern — optimistic + confirmed

**Current:** synchronous dispatch. The reducer mutates state immediately; localStorage flushes on the next idle.

**Target:** every mutation becomes a 3-phase flow:

1. **Optimistic dispatch:** apply the mutation locally with a temporary client UUID + status flag.
2. **Remote write:** send to Supabase via `supabase.from('contacts').insert(...)`.
3. **Confirmation dispatch:** on success, reconcile (replace temp ID with server-returned UUID, clear status flag). On failure, revert + toast.

**Recommended:** wrap every mutation in a thin `useMutation` hook (TanStack Query, or our own). Example:

```jsx
function useAddContact() {
  const dispatch = useDispatch();
  const supabase = useSupabase();

  return async function addContact(contact) {
    const tempId = `temp_${crypto.randomUUID()}`;
    dispatch({ type: ACTIONS.ADD_CONTACT, contact: { ...contact, id: tempId, _pending: true } });

    const { data, error } = await supabase.from('contacts').insert(contact).select().single();
    if (error) {
      dispatch({ type: ACTIONS.DELETE_CONTACT, id: tempId });
      throw error;
    }
    dispatch({ type: ACTIONS.RECONCILE_CONTACT, tempId, server: data });
  };
}
```

**Action for shell now (pre-migration):**
- Add a `_pending` and `_error` field convention on every entity. The reducer ignores them but the UI can render them (loading spinners, retry buttons).
- Add a `RECONCILE_*` action for each entity. Today this is unnecessary (no remote); pre-wiring keeps the migration mechanical.

**Conflict resolution:** when remote returns a different value than local (someone else edited), surface to the user — don't silently overwrite. `updatedAt` comparison is the canonical signal.

---

## 8. Realtime sync

Supabase Realtime publishes table changes to subscribed clients. The store's reducer can consume these events as if they were local dispatches.

```js
useEffect(() => {
  const ch = supabase
    .channel('contacts-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, (payload) => {
      // payload.new / payload.old / payload.eventType
      if (payload.eventType === 'INSERT') dispatch({ type: ACTIONS.RECONCILE_CONTACT, server: payload.new });
      if (payload.eventType === 'UPDATE') dispatch({ type: ACTIONS.RECONCILE_CONTACT, server: payload.new });
      if (payload.eventType === 'DELETE') dispatch({ type: ACTIONS.DELETE_CONTACT, id: payload.old.id });
    })
    .subscribe();
  return () => supabase.removeChannel(ch);
}, []);
```

**RLS interacts with realtime:** subscribers only receive payloads they're allowed to read. So RLS must be correct **before** realtime is wired, or users will silently lose change events for records they shouldn't see.

**Performance:** subscribing to every table for every user is expensive. Scope subscriptions to what the user is currently viewing (e.g. only subscribe to `contacts` while on `/contacts`).

---

## 9. Storage strategy

**Current:** entire `state` JSON in `localStorage` under `pp.store.v14`. Reseed on version mismatch.

**Target hybrid:**
- Supabase = source of truth.
- IndexedDB (via `localforage` or `idb-keyval`) = local cache for offline + fast reload.
- localStorage continues to hold session-scoped UI state (filter selections, last-viewed records) — but never entity data.

**Why IndexedDB over localStorage:**
- localStorage caps at ~5MB. With invoice line items, messages, activity logs, and reminder events, a real client will blow past that.
- IndexedDB is async (non-blocking) and supports indexed queries.

**Action for shell now (pre-migration):**
- Audit `localStorage.setItem` calls. Anything that's session-scoped (filter state, last route) stays in localStorage. Anything that's entity data moves to IndexedDB at migration time.
- Document the schema version bump cadence: `pp.store.v14` becomes irrelevant once entity storage moves to IndexedDB; the version contract becomes "schema migrations applied to your local cache."

---

## 10. Migration plan — phased rollout

Sequence designed so each phase is shippable and reversible without breaking the live UI.

### Phase 0 — Pre-migration cleanup (this doc + this session's work)
- Reducer FK cascades (✅ done this session).
- Filter dropdown orphan pruning (✅ done).
- Tag CRUD UI (✅ done).
- Dead reducer actions removed (✅ done).
- Schema audit complete (✅ this doc).

### Phase 1 — Shape the data for migration (1–2 sessions)
- Centralize ID generation in `lib/ids.js`. Introduce `genUuid()` alongside `newId()`. Default switch flag.
- Add `updated_at` stamping helper. Audit every UPDATE action to use it.
- Standardize soft delete: every soft-deletable entity gets `archivedAt`. Audit reducer.
- Split embedded subdocs into top-level state arrays:
  - `invoice.lineItems` → `state.invoiceLineItems` (with `invoiceId` FK)
  - `invoice.payments` → `state.invoicePayments`
  - `invoice.jobIds[]` → `state.invoiceJobs` join
  - `contact.tagIds[]` → `state.contactTags` join
  - `job.crewIds[]` → `state.jobCrew` join
  - `conversation.followedUserIds[]` → `state.conversationFollowers` join
- Update all selectors to read from join tables.
- Bump `STORAGE_KEY` to `pp.store.v15` after the shape change.

### Phase 2 — Supabase project setup (no app changes)
- Create Supabase project (one per client; per `CLAUDE.md` deployment model).
- Apply schema migrations matching §2.
- Apply RLS policies matching §6.
- Seed dev/staging databases with the existing seed.js data (one-off script).
- No app code changes — purely infra.

### Phase 3 — Wire auth (gated rollout)
- Add Supabase JS SDK. Initialize client in `main.jsx`.
- Replace user-switcher with Supabase magic-link login.
- `currentUserId` resolves to `supabase.auth.user().id`.
- Local state still wins; Supabase is read-only at this stage.

### Phase 4 — Read-through cache (parallel mode)
- For each entity: on app load, fetch from Supabase, hydrate state, mark as authoritative.
- localStorage stays as fast cache; Supabase fetch is background refresh.
- All mutations still local-only (no remote writes yet).

### Phase 5 — Optimistic write-through (per entity)
- Roll out the optimistic pattern (§7) one entity at a time. Suggested order:
  1. `tags` (smallest, lowest risk)
  2. `services` / `frequencies` (small, settings-only)
  3. `users` (auth-adjacent, careful)
  4. `clients` / `contacts` (core CRM)
  5. `sites` / `jobs` / `invoices`
  6. `conversations` / `messages` / `reminderEvents`
- Each rollout is a feature flag — can revert per-entity.

### Phase 6 — Realtime subscriptions
- Add per-page realtime subscriptions (§8). Roll out in same entity order.
- Now every browser tab + every team member sees changes live.

### Phase 7 — Sunset localStorage entity store
- Once Supabase has been the source of truth for ≥30 days with no incidents, switch the cache to IndexedDB and drop the localStorage `pp.store.v*` key.

---

## 11. Pre-migration cleanup checklist

Things to land in the shell **before** Phase 2. None of these block app function today; all become hard blockers later.

- [x] **FK cascade in reducer** — every DELETE prunes orphans (this session).
- [x] **Filter orphan pruning** — dropdowns exclude deleted/archived (this session).
- [x] **Tag CRUD UI** — full create/edit/delete (this session).
- [x] **Dead reducer actions removed** — `SET_CONTACT_LIFECYCLE` (this session).
- [ ] **Centralize ID generation** — single `lib/ids.js` exporting `genId(prefix?)`. Replace all inline `newId()` calls. Easy swap to UUID later.
- [ ] **Standardize `updatedAt` stamping** — helper that wraps every UPDATE, ensures the field is always set.
- [ ] **Standardize soft-delete** — `archivedAt` timestamp on clients, contacts, conversations, jobs. (Status enums stay for workflow.)
- [ ] **Decide deals model** — keep `stage` / `dealValue` / `expectedCloseDate` on `contact`, OR split into a `deals` table. Recommendation: split — a contact can have multiple deals over time.
- [ ] **Decide multi-tenancy** — single tenant per Supabase project (per CLAUDE.md), OR multi-tenant with `tenant_id` everywhere. Recommendation: single tenant per project (matches deployment model). Saves the column on every table.
- [ ] **Split embedded subdocs** — line items, payments, joins (see Phase 1).
- [ ] **Document every permission's RLS effect** — extend `lib/roles.js` `PERMISSIONS` entries with a `rls_tables` array so the migration knows which policies to generate.
- [ ] **Reseed script** — extract `seed.js` data into a `.sql` file or a Supabase seed JS script. Same data, ready to insert.
- [ ] **Move stub adapters to env-flagged backends** — `lib/twilio.js` and `lib/email.js` already branch on `VITE_*_BACKEND_URL`. Confirm those backends exist and are wired before Phase 5.
- [ ] **Audit `JSON.stringify` of entire state** — `persist.js` does this on every save. Becomes a perf problem at scale; refactor to per-entity persistence in Phase 7 (when we move to IndexedDB).
- [ ] **Test fixture for Postgres** — set up a `dev_seed.sql` that mirrors the current seed data so RLS policies can be tested against realistic data.

---

## Notes for the shell maintainer

- Land Phase 0 + 1 work into the shell baseline. Phases 2–7 are per-client.
- Per-client Supabase projects mean **each client carries their own data**; backups, billing, and compliance all scoped per project.
- The first per-client deployment will be the proving ground for Phase 2–4 once Phase 1 is done in shell.
- This doc, [`SHELL_MOBILE_RESPONSIVE.md`](SHELL_MOBILE_RESPONSIVE.md), and `CLAUDE.md` should always travel together when copying the shell forward.

---

*Generated 2026-05-03. Canonical home: shell repo (`Kronelius/shell-build`). Backport when migrating shell forward.*
