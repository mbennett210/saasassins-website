// POST /api/state/jobs-delta  { changed:[job], removed:[id], build, tab }
//                             → { ok, changed, removed }
//
// Server-mediated public.jobs delta write (REMEDIATION_PLAN.md Increment 1d).
// The browser used to upsert this table directly under the same open policy as
// org_state; Increment 1e revokes that, and this is the replacement path.
//
// The server owns the row shape, the organization, and `updated_by` (from the
// caller's verified JWT claim) — see _lib/jobsTable.js writeJobsDelta. The
// client owns only the payloads and which ids to remove.
//
// SIZE: a delta is normally a handful of rows, but a series operation can touch
// hundreds of occurrences, so the CLIENT chunks its requests (see
// src/store/jobsSync.js MAX_ROWS_PER_REQUEST) and this handler caps what it will
// accept. Without both halves a big series edit would hit Vercel's ~4.5 MB
// platform body limit and 413 before the handler ever runs.
import { requireAuthority, readAuthzSlices } from '../_lib/authz.js';
import { reportError } from '../_lib/monitor.js';
import { writeJobsDelta, getJobsByIds } from '../_lib/jobsTable.js';
import { guardJobsDelta } from '../_lib/jobsGuard.js';
import { jobIdsWithPunches } from '../_lib/time/store.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const MAX_ROWS = 250;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let a;
  try {
    // strictRoster: a manager's role comes from the roster (no role claim), and a failed
    // read there must be this 500, not "no role" and a silently reverted edit.
    a = await requireAuthority(req, res, { strictRoster: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Authority check failed' });
  }
  if (!a) return; // 401 already written

  const body = req.body || {};
  const changed = Array.isArray(body.changed) ? body.changed : [];
  const removed = Array.isArray(body.removed) ? body.removed : [];
  if (!changed.length && !removed.length) return res.status(200).json({ ok: true, changed: 0, removed: 0 });
  if (changed.length + removed.length > MAX_ROWS) {
    return res.status(413).json({ error: `delta of ${changed.length + removed.length} rows exceeds the ${MAX_ROWS}-row limit — chunk it` });
  }

  // ── FIELD-LEVEL AUTHORIZATION ────────────────────────────────────────────
  // Without this the endpoint commits whatever it is handed, so Increment 1e —
  // which revokes the browser's direct write policy and routes every job write
  // here — would move the self-assignment and mass-delete primitives behind a
  // service-role proxy rather than closing them. Same reasoning, same shape, as
  // the org_state guard in ./org-state.js. See _lib/jobsGuard.js.
  //
  // WHO writes whole: owner + admin by role, or a manager holding schedule.edit in the
  // COMMITTED Roles matrix + their per-user overrides (every manager by default, as the
  // app gates it). Crew never, whatever their grant; anyone else is sanitized.
  // Owner/admin short-circuit before any read. A manager pays one small read (the matrix
  // + overrides projection): a holder's write needs no row read, a pared-back one adds
  // it. Everyone else pays the one primary-key fetch of the rows it touches, exactly as
  // before, and never the matrix. See guardJobsDelta. (Outside the guard: every write
  // pays writeJobsDelta's own equality read, and a login without claims, i.e. every
  // manager, also pays resolveAuthority's full roster read until managers get claims.)
  //
  // `a.role` and `a.orgUserId` come from resolveAuthority (claim first; a manager's from
  // the roster, whose read throws on failure rather than reading as "no role"). A null
  // role holds nothing, so an unresolvable caller fails closed onto the sanitizer.
  // ⚠️ IT SANITIZES, IT DOES NOT REJECT — and that is load-bearing, not lenient.
  // Tabs send job rows other people changed: a stale tab or an offline replay carries
  // an old crewIds/siteId, and a patch landing mid-flush is re-sent once. (Routine
  // echoes of every inbound row stopped with the ping-pong fix, store/sync.js
  // advanceJobsBaseline.) A 403 on any of that would be invisible (stateApi treats only
  // 409 as a real answer) and, post-1e, would wedge the tab in a permanent retry loop
  // with the user's own clock-in stuck behind it. Replacing the fields they may not
  // change with the stored values makes a stale row harmless and an escalation attempt
  // a 200 that moves nothing. See _lib/jobsGuard.js.
  let toWrite;
  try {
    const s = await guardJobsDelta({
      role: a.role,
      selfId: a.orgUserId,
      changed,
      removed,
      readAuthz: readAuthzSlices, // the COMMITTED matrix + overrides, never the body
      readRows: getJobsByIds,
    });
    if (s.adjustments.length) {
      // Logged, never surfaced: the caller is overwhelmingly a stale tab sending rows it
      // observed, not an attacker, and there is nothing for them to act on.
      console.warn(`[jobs-delta] neutralized for ${a.orgUserId || a.email} (${a.role}): ${s.adjustments.join(', ')}`);
    }
    toWrite = { changed: s.changed, removed: s.removed };
  } catch (e) {
    // A guard that cannot run must not silently pass the write through.
    return res.status(500).json({ error: e.message || 'Authorization check failed' });
  }

  // ── PUNCH-PROTECTED ROWS ─────────────────────────────────────────────────
  // A clean somebody has clocked into is never hard-deleted here, whoever asks.
  // time_entries.job_id is ON DELETE SET NULL, so the delete would silently orphan
  // payroll rows — and on Sept 2 two "this & future" series edits deleted cleans
  // that crew were on site for, mid-shift (they vanished from My Day within a
  // minute via the tombstone poll). The client-side clamp (lib/seriesScope.js)
  // stops the common path; this is the durable backstop for every path. Skipped
  // ids are reported, not failed: a 4xx here would wedge the tab in a retry loop
  // (see the sanitizer note above), and the next jobs pull re-adds the row locally.
  let protectedIds = [];
  try {
    if (toWrite.removed.length) {
      const punched = await jobIdsWithPunches(toWrite.removed);
      if (punched.size) {
        protectedIds = toWrite.removed.filter((id) => punched.has(id));
        toWrite = { changed: toWrite.changed, removed: toWrite.removed.filter((id) => !punched.has(id)) };
        reportError('jobs.delta_removed_punched_rows', new Error(`refused to delete ${protectedIds.length} clean(s) that have clock-ins`), {
          ids: protectedIds.slice(0, 8),
          authUserId: a.user.id,
          tab: typeof body.tab === 'string' ? body.tab.slice(0, 64) : null,
          build: Number.isFinite(Number(body.build)) ? Number(body.build) : 0,
        });
      }
    }
  } catch (e) {
    // A guard that cannot run must not silently pass the delete through.
    return res.status(500).json({ error: e.message || 'Punch check failed' });
  }

  try {
    const r = await writeJobsDelta({
      changed: toWrite.changed,
      removed: toWrite.removed,
      userId: a.user.id, // Auth UUID (see org-state.js) — never from the body
      orgUserId: a.orgUserId || null, // roster id (u_…) recorded as job_deletes.deleted_by
      build: Number.isFinite(Number(body.build)) ? Number(body.build) : 0,
      tab: typeof body.tab === 'string' ? body.tab.slice(0, 64) : null,
    });
    // BULK-deleting deltas stay loudly observable after the TEMP diag's removal:
    // bulk deletions were the churn-war signature (2026-08-13; 25 rows). The
    // threshold keeps routine single-clean deletions from paging daily — an
    // alert channel that cries wolf trains people to ignore the real one.
    if (r.removed > 0 && r.removed < 10) {
      console.warn(`[jobs-delta] removed ${r.removed} row(s) for ${a.orgUserId || a.user.id}`);
    }
    if (r.removed >= 10) {
      reportError('jobs.delta_removed_rows', new Error(`jobs-delta removed ${r.removed} row(s)`), {
        removed: r.removed,
        changed: r.changed,
        ids: (toWrite.removed || []).slice(0, 4),
        authUserId: a.user.id,
        tab: typeof body.tab === 'string' ? body.tab.slice(0, 64) : null,
        build: Number.isFinite(Number(body.build)) ? Number(body.build) : 0,
      });
    }
    return res.status(200).json({ ok: true, ...r, ...(protectedIds.length ? { protected: protectedIds } : {}) });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Write failed' });
  }
}
