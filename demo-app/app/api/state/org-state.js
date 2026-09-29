// POST /api/state/org-state  { state, baseVersion, build, tab } → { ok, version }
//
// Server-mediated org_state CAS write (REMEDIATION_PLAN.md Increment 1d). The
// browser used to UPDATE this row directly under `to authenticated using(true)
// with check(true)` — the policy Increment 1e revokes. Routing the write here
// first is what makes that revoke possible without breaking saves.
//
// WHAT THE SERVER OWNS (never trusted from the body): the organization, the
// `updated_by` author (taken from the caller's verified JWT claim), and the
// fleet-gate check. WHAT THE CLIENT STILL OWNS: the document itself and the CAS
// base version — the browser is still the author of the blob until the slice
// extractions land.
//
// BODY SIZE: the blob is ~600-800 KB today. Vercel enforces a ~4.5 MB
// request-body cap at the PLATFORM layer and returns 413 before this handler
// runs, so the sizeLimit below can only ever be LOWER than that, never higher —
// honest-small framing: a bigger number reads as headroom that doesn't exist
// (the platform cap silently 413'd base64 uploads once, HANDOFF 2026-07-19).
//
// If the residual blob ever approaches this, that is a decomposition emergency,
// not a limit to raise. Note the client falls back to a direct write on a 413
// rather than losing the edit — see lib/stateApi.js.
import { requireAuthority, OFFICE_ROLES, crewAssignedScope } from '../_lib/authz.js';
import {
  writeOrgStateFromClient, describeWriteMiss, readProtectedFingerprint, readProtectedSlices, isDigestCurrent, parseStoredDigest, readOrgState,
} from '../_lib/orgState.js';
import { protectedFieldViolations, protectedFingerprint, removedMemberIds, PROTECTED_SELECT } from '../_lib/orgStateGuard.js';
import { removalPayFacts } from '../_lib/memberRemoval.js';
import { oversizedImageUsers, oversizedImageMessage, MAX_STATE_BYTES } from '../_lib/blobBudget.js';
import { syncAssignmentsFromState } from '../_lib/crewAssignments.js';
import { syncLoginBansFromState, banRemovedLogins } from '../_lib/loginBanSync.js';
import { getCrewJobs } from '../_lib/jobsTable.js';
import { mergeCrewChanges } from '../_lib/crewMerge.js';
import { dispatchDue } from '../_lib/push/dispatch.js';
import { pushConfigured } from '../_lib/push/store.js';
import { reportError } from '../_lib/monitor.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

// Well under the platform cap, so we reject with a readable error rather than letting
// the platform return an opaque one. Imported rather than declared: the SERVER write
// path (api/_lib/orgState.js writeOrgState) enforces the same ceiling, and it did not
// used to — see the note on the constant.

// What the guard's removal pay rule needs (the pay slices + the time ledger), read only
// when this save removes a member: removals are rare. A read that fails leaves the facts
// out, so the guard REFUSES the removal (a 403 with violations, which the client reverts
// on) instead of this route answering 500: a 5xx sends the client to its direct-write
// fallback (lib/stateApi.js), which skips this guard wherever 1e is not applied.
async function removalFacts(prev, state, a) {
  const removed = removedMemberIds(prev, state);
  if (!removed.length) return {};
  try {
    return { removal: await removalPayFacts(prev, removed) };
  } catch (e) {
    reportError('org_state.removal_pay_check_failed', e, { caller: a.orgUserId || a.email || null, removed: removed.length });
    return { removal: null };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let a;
  try {
    a = await requireAuthority(req, res);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Authority check failed' });
  }
  if (!a) return; // 401 already written

  const body = req.body || {};
  const { state, baseVersion, build, tab } = body;
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state is required' });
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return res.status(400).json({ error: 'baseVersion must be a non-negative integer' });

  // Measure from content-length rather than re-serializing the blob: the client
  // already stringified it once and the platform limit is about the REQUEST
  // size anyway. Falls back to a serialize only if the header is missing.
  const declared = Number(req.headers['content-length']);
  const bytes = Number.isFinite(declared) && declared > 0
    ? declared
    : Buffer.byteLength(JSON.stringify(state), 'utf8');
  if (bytes > MAX_STATE_BYTES) {
    return res.status(413).json({ error: `body is ${Math.round(bytes / 1024)} KB, over the ${Math.round(MAX_STATE_BYTES / 1024)} KB limit` });
  }

  // ── EMBEDDED-IMAGE BUDGET ────────────────────────────────────────────────
  // Signature images USED TO live as base64 inside this blob behind nothing but a
  // client-side `file.size > 1MB` check: a 1 MB image is ~1.37 MB once base64'd against
  // ~2.58 MB of headroom, so TWO users adopting a documented feature pushed the blob
  // past MAX_STATE_BYTES — and then every save in the org 413s, for everyone, with an
  // error naming nothing ("body is 3700 KB…").
  //
  // C07 moved the bytes to Storage (`signaturePrefs.imagePath`) and the cap is now 36 KB,
  // enforced on BOTH sides. This guard stays because the legacy `imageDataUrl` shape
  // remains readable forever, so a pre-C07 row can still carry base64.
  //
  // ⚠️ SCOPED TO THE CALLER'S OWN ROW, DELIBERATELY. The blob is shared, so once an
  // oversized signature is committed EVERY tab's save carries it. Rejecting on mere
  // presence would therefore wedge the whole fleet on data they did not write and
  // cannot fix — the same shape as the echo problem that made the jobs guard sanitize
  // instead of reject. Rejecting only when the offender is the CALLER means it fires
  // exactly once, on the person who just picked the file, at the moment they can still
  // choose a smaller one.
  //
  // A manager uploading on someone else's behalf is therefore not caught here. That is
  // an accepted gap: the alternative is a fleet-wide wedge. C07 (signatures → Storage)
  // removes the whole class.
  const offenders = oversizedImageUsers(state);
  const mine = offenders.filter((o) => o.id && o.id === a.orgUserId);
  if (mine.length) {
    return res.status(413).json({ error: oversizedImageMessage(mine), field: 'signaturePrefs' });
  }
  if (offenders.length) {
    // Not this caller's doing — let the write through, but make it visible. Silence
    // here is how the blob would drift to the cliff with nobody noticing.
    console.warn(`[state/org-state] oversized signature image(s) already committed: ${offenders.map((o) => `${o.id}=${Math.round(o.bytes / 1024)}KB`).join(', ')}`);
  }

  const buildNum = Number.isFinite(Number(build)) ? Number(build) : 0;
  const tabId = typeof tab === 'string' ? tab.slice(0, 64) : null;

  // ── CREW WRITE MERGE (CS-002) ───────────────────────────────────────────────
  // A crew (or any non-office) session holds only a PROJECTION of the blob (GET
  // /api/state/view), so committing its posted document would ERASE every slice the
  // projection omitted. So the server does NOT commit what was posted: it reads the full
  // committed blob, MERGES only allowlisted crew changes into it (crewMerge), and writes
  // THAT under the same CAS. Role is the LIVE claim-first role (requireAuthority), never the
  // token alone. Office roles (owner/admin/manager) fall through to the unchanged path below.
  if (!OFFICE_ROLES.includes(a.role)) {
    return await handleCrewWrite(res, { a, posted: state, baseVersion, buildNum, tabId });
  }

  // ── FIELD-LEVEL AUTHORIZATION ────────────────────────────────────────────
  // The blob carries authority (users[].role, the permission matrix, per-user
  // overrides, standing crew assignments) alongside ordinary business data.
  // Increment 1e revokes the browser's direct write policy, which routes every
  // write here — so if this endpoint commits whatever it is handed, 1e moves
  // the proven self-escalation behind a service-role proxy instead of closing
  // it. This is the check that makes 1e actually mean something.
  //
  // Cost is kept off the hot path by a digest: computing one from the incoming
  // state is free, comparing it to the digest stored at the last commit is a
  // ~100-byte read, and only a genuine authority change pays the ~314 KB
  // protected-slice read. Saves overwhelmingly do not touch authority.
  //
  // ── JUDGED AGAINST THE VERSION THIS WRITE REPLACES ───────────────────────
  // The CAS below replaces exactly one version, `baseVersion`. Both reads carry the
  // version they saw and are checked against it before anything is judged; any other
  // version is answered as the CAS miss it is (answerMiss): 409 with the current version,
  // or `gated`. Nothing is judged or written on that path.
  //   · A STALE base (someone saved in between) sends a document that lacks the newer
  //     changes. Judged against the latest state, a teammate's newer protected edit
  //     (a pay rate, a role, a manager's overrides, the timezone, a member added since,
  //     which reads as one this save removes...) read as this save REVERTING it, and the
  //     guard answered 403, which store/sync.js treats as final: it drops every pending
  //     action in the save. Every role hit it, crew included (S77 review, fixed
  //     2026-09-23). A 409 makes the client adopt the latest state, replay those actions
  //     and save again from the new base, where this guard judges the replay against
  //     fresh state.
  //   · A base AHEAD of the committed version (a buggy or hostile client) is no safer to
  //     wave through as "can't commit": a teammate's commit landing before the CAS makes
  //     that version real, and the CAS then accepts a document nothing judged (a crew
  //     save could make its sender owner). Judging it against the version read is no
  //     better, since that is not the version it replaces.
  // The two reads now see one version, so C6 below no longer alarms on a write landing
  // between them.
  //
  // ── AND THE DIGEST MUST DESCRIBE THAT COMMIT ─────────────────────────────
  // The stored digest names the commit it was stored in (`<digest>@<version>/<updated_at>`,
  // see _lib/orgState.js), and the fast path trusts it only while the row is still that
  // commit at `baseVersion` (isDigestCurrent). The route stores it with every commit, and
  // writeOrgState does after checking the stored one still describes the row it replaces;
  // any other write that moves `version` or `updated_at` (an operator script, the pre-1e
  // browser fallback, a direct write) leaves a tag that no longer matches, so the next save
  // takes the full check. Until 2026-09-23 the digest was
  // untagged and only this route refreshed it: after reconcile-self appended a roster row,
  // a crew save that removed it again matched the older digest and committed with no
  // guard run (200; judged, it is a 403). A digest stored before tagging vouches for
  // nothing: one full check, then a tagged one.
  let fingerprint;
  let authorityChanged = false;
  // The committed protected slices (incl. users), captured in handler scope so the
  // post-commit login-ban sync can diff status against the just-committed state. Set only
  // when authority changed (a status change always moves the fingerprint) and the pre-write
  // reads confirmed the row is exactly `baseVersion` — the version this write replaces.
  let prevProtected = null;
  try {
    fingerprint = protectedFingerprint(state);
    const committed = await readProtectedFingerprint();
    // A failed read (null) falls through to the full read, which checks the version too.
    if (committed && committed.version !== baseVersion) return await answerMiss(res, baseVersion, buildNum);
    // Unknown deliberately falls through to the full check rather than being treated as
    // "unchanged" — fail closed, not open: no digest, a failed read, or a digest stored
    // for another commit than the one this write replaces.
    authorityChanged = !isDigestCurrent(committed, baseVersion) || committed.fingerprint !== fingerprint;
    if (authorityChanged) {
      // The stored digest comes back in the SAME read as the slices, so the baseline check
      // below compares one snapshot and still runs when the cheap read above failed.
      const prev = await readProtectedSlices(`${PROTECTED_SELECT},protected_fingerprint,updated_at`);
      // Again here: a save can land between the two reads. No row at all is a miss too
      // (answered "not found"), never a write with nothing judged.
      if (!prev || prev.version !== baseVersion) return await answerMiss(res, baseVersion, buildNum);
      prevProtected = prev; // the validated pre-write state, for the post-commit login-ban sync
      // ── BASELINE INTEGRITY (C6) ──────────────────────────────────────────
      // `protected_fingerprint` is a STORED column, written by the server writers (this
      // endpoint, and writeOrgState when the digest it replaces was current). A write to
      // `state` from anywhere else (an operator script, the pre-1e fallback, a direct write
      // under the still-open RLS policy, which can also write this column) therefore leaves
      // it describing the content before that write — and because `prev` is read from the
      // already-modified blob, a poisoned baseline compares equal to a poisoned proposal
      // and NO violation fires. The tamper launders itself through the next legitimate save.
      //
      // Recomputing the fingerprint from the baseline we just read costs nothing
      // (we are already on the expensive path) and detects exactly that. The owner's
      // rule (2026-09-23): it alarms whenever the committed protected fields differ from
      // the digest a server writer last stored, i.e. something outside the server paths
      // changed a role, the matrix, an override, the timezone…, and it says which commit
      // that digest was stored for (digestVersion vs rowVersion). A server write doesn't hide
      // an outside write (writeOrgState vouches only after checking the stored digest still
      // describes the row), so a script that changes a protected field alarms on the next
      // save that reaches here; a server write alarms itself only when it couldn't check
      // (its digest read failed) after changing a protected field. Not caught: a write that
      // also forges or blanks this column, which the pre-1e RLS policy lets any session do.
      //
      // It ALARMS rather than refuses, deliberately. The pre-1e fallback in
      // stateApi writes directly whenever the server is unreachable, and those
      // writes legitimately do not update the fingerprint — so refusing here would
      // turn a transient outage into a permanently unsaveable blob. Detection is
      // what is achievable before 1e; 1e is what actually closes it, because the
      // hole is "the baseline is writable", not "the digest is stale".
      const stored = parseStoredDigest(prev.protected_fingerprint);
      if (stored.fingerprint != null) {
        const baselineFp = protectedFingerprint(prev);
        if (baselineFp !== stored.fingerprint) {
          const since = stored.taggedVersion;
          const sameCommit = since === prev.version && stored.taggedAt === Date.parse(prev.updated_at);
          const how = since == null
            ? 'and the stored digest names no commit (it predates version tags)'
            : since < prev.version
              ? `since v${since}, the last commit a server writer vouched for (an operator script, the pre-1e browser fallback or a direct RLS write since then, or a server write that could not check the row)`
              : sameCommit
                ? `within v${since} itself (a direct write that kept the version and updated_at, or a deploy that changed the digest's format)`
                : `and the stored digest names v${since}, a commit the row no longer is (a restore that rewound the version?)`;
          reportError(
            'org_state.baseline_mismatch',
            new Error(`committed blob authority fields do not match the digest a server writer last stored, ${how}; `
              + 'the field guard below is comparing against an UNTRUSTED baseline'),
            { caller: a.orgUserId || a.email || null, role: a.role || null, digestVersion: since, rowVersion: prev.version },
          );
        }
      }
      const violations = protectedFieldViolations(prev, state, a.role, a.orgUserId, await removalFacts(prev, state, a));
      if (violations.length) {
        return res.status(403).json({
          error: `Your access level does not allow you to ${violations.join(', or ')}.`,
          violations,
        });
      }
    }
  } catch (e) {
    // A guard that cannot run must not silently pass the write through.
    return res.status(500).json({ error: e.message || 'Authorization check failed' });
  }

  try {
    const r = await writeOrgStateFromClient({
      state,
      baseVersion,
      userId: a.user.id, // Auth UUID — matches the uuid column AND the echo-suppression key
      fingerprint,
      build: buildNum,
      tab: tabId,
    });
    if (r.ok) {
      // Authority changed and the write committed, so the derived assignment
      // table must follow. Only reached when the digest moved or could not vouch for
      // the replaced version (rare: e.g. the first save after an operator script, which
      // may have changed standing crew itself), and only
      // AFTER a successful commit — best-effort so a sync failure can never
      // undo a save the user already made. sync-crew-assignments.mjs is the
      // repair tool if this ever drifts.
      //
      // A failure here is NOT cosmetic: crew_assignments is what every site gate
      // reads, so a stale table means a revoked crew member keeps access until the
      // next authority change. The sync is add-then-remove, so a partial failure
      // leaves a SUPERSET (stale, never empty) — bounded, but still wrong.
      //
      // It stays best-effort because the write has already committed and failing the
      // request now would tell the user their save was lost when it was not. But it is
      // retried once, logged at ERROR (a console.warn here was invisible), and
      // REPORTED in the response body so the condition is observable rather than
      // silently absorbed. Repair tool: app/scripts/sync-crew-assignments.mjs.
      let assignmentsSynced = true;
      if (authorityChanged) {
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try { await syncAssignmentsFromState(state); lastErr = null; break; }
          catch (e) { lastErr = e; }
        }
        if (lastErr) {
          assignmentsSynced = false;
          reportError(
            'crew_assignments.sync_failed',
            lastErr,
            { note: 'assignment table is STALE until the next authority change or a manual sync-crew-assignments run', caller: a.orgUserId || a.email || null },
          );
        }
      }
      // Tie the Supabase login ban to roster STATUS. A member the just-committed save moved
      // INTO a no-access status must have their login banned too (and un-banned on the way
      // back), or a raw org_state save that bypassed the Team UI would end their ROUTE access
      // (S93) while leaving their LOGIN able to reach Supabase directly (open read RLS + the
      // buckets that admit any authenticated user). Same post-commit, best-effort, reported
      // contract as the assignment sync above: the write has already committed, so a ban
      // failure never undoes it. Only status transitions do any GoTrue work, and it never
      // bans the last active owner. See _lib/loginBanSync.js. A failed ban is re-reconciled
      // by that member's next status change (each transition reconciles at the write point).
      let loginBansSynced = true;
      let removedLoginsSynced = true;
      if (authorityChanged && prevProtected) {
        try {
          const ban = await syncLoginBansFromState(prevProtected.users, state.users);
          if (ban.failures.length) {
            loginBansSynced = false;
            reportError(
              'login_ban.sync_failed',
              new Error(ban.failures.map((f) => `${f.op} ${f.email}: ${f.message}`).join('; ')),
              { note: 'a member changed to/from a no-access status but their Supabase login ban was NOT reconciled — they may keep (or be denied) DIRECT Supabase access until the next status change re-reconciles', caller: a.orgUserId || a.email || null },
            );
          }
          if (ban.skippedLastOwner) {
            // Not a failure: banning would leave the org with no active Super Admin login.
            // Surfaced so a disabled-but-still-signed-in owner login is observable, not silent.
            reportError(
              'login_ban.last_owner_not_banned',
              new Error(`${ban.skippedLastOwner} owner login(s) set to a no-access status were left ACTIVE — banning would leave the org with no active Super Admin login`),
              { caller: a.orgUserId || a.email || null },
            );
          }
        } catch (e) {
          // syncLoginBansFromState collects per-member errors and does not throw, so a throw
          // here is unexpected — still never fail the committed save.
          loginBansSynced = false;
          reportError('login_ban.sync_failed', e, { caller: a.orgUserId || a.email || null });
        }
        // Belt to the status sync above: a member the committed save REMOVED from the roster
        // (not merely disabled) also keeps a usable Supabase login unless it is banned. The
        // normal Team path DELETES the login (/api/settings/users/delete), but a RAW org_state
        // save that drops a roster row bypasses that route — and authz.js keeps a claimed login
        // with no roster row VALID (the orphan-login recovery fallback), so the removed member's
        // login and its JWT claim would keep FULL route authority (S93's status check never fires
        // for a row that no longer exists). BAN (reversible), never delete; a genuine orphan (an
        // auth login in neither the prev nor the next roster) is never a removal, so it is left
        // signable-in to self-heal via reconcile-self. Same post-commit, best-effort, idempotent,
        // reported contract; never the last active owner. See _lib/loginBanSync.js.
        try {
          const rem = await banRemovedLogins(prevProtected.users, state.users);
          if (rem.failures.length) {
            removedLoginsSynced = false;
            reportError(
              'login_ban.removed_sync_failed',
              new Error(rem.failures.map((f) => `${f.op} ${f.email}: ${f.message}`).join('; ')),
              { note: 'a member was REMOVED from the roster but their Supabase login ban FAILED — their login (and its JWT claim) keeps DIRECT Supabase + route access. A removal is not in any later save\'s roster diff, so this is NOT auto-retried: this alert is the signal to ban or delete the login by hand.', caller: a.orgUserId || a.email || null },
            );
          }
          if (rem.skippedLastOwner) {
            // Not a failure: banning the org's last active owner login would strand it off a
            // service-role script. Surfaced so a removed-but-still-signed-in owner is observable.
            reportError(
              'login_ban.removed_last_owner_not_banned',
              new Error(`${rem.skippedLastOwner} removed owner login(s) were left ACTIVE — banning would leave the org with no active Super Admin login`),
              { caller: a.orgUserId || a.email || null },
            );
          }
        } catch (e) {
          // banRemovedLogins collects per-member errors and does not throw, so a throw here is
          // unexpected — still never fail the committed save.
          removedLoginsSynced = false;
          reportError('login_ban.removed_sync_failed', e, { caller: a.orgUserId || a.email || null });
        }
      }
      return res.status(200).json({
        ok: true,
        version: r.version,
        ...(assignmentsSynced ? {} : { assignmentsSynced: false }),
        ...(loginBansSynced ? {} : { loginBansSynced: false }),
        ...(removedLoginsSynced ? {} : { removedLoginsSynced: false }),
      });
    }

    return await answerMiss(res, baseVersion, buildNum);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Write failed' });
  }
}

// A write that cannot land on `baseVersion`: the CAS missed, or the pre-write reads
// already show another version. One read tells the client WHICH failure it was: a lost
// CAS race (adopt remote + replay) or the fleet gate (reload onto a newer build).
async function answerMiss(res, baseVersion, buildNum) {
  const why = await describeWriteMiss(baseVersion, buildNum);
  if (why.missing) {
    // 500, not 409: a "conflict" answer would send the client into
    // adopt→replay→save against a row that doesn't exist — a hot loop with no
    // backoff. A 5xx routes it to the offline/backoff path instead.
    return res.status(500).json({ error: 'org_state row not found — check CLEANSPACE_ORG_ID matches the client' });
  }
  if (why.gated) {
    return res.status(409).json({ ok: false, gated: true, minClientBuild: why.minClientBuild, version: why.version });
  }
  return res.status(409).json({ ok: false, conflict: true, version: why.version });
}

// CS-002 — the crew (non-office) write path. The caller posted a PROJECTION; we merge only
// its allowlisted changes into the full committed blob and write THAT. Omission never
// deletes: the merge starts from a copy of the full blob and never spreads the posted one.
async function handleCrewWrite(res, { a, posted, baseVersion, buildNum, tabId }) {
  const userId = a.orgUserId;

  // Read the full committed blob (service-role, unaffected by the crew read-split policy).
  // Today's CAS: the crew's view returned this version; if the row moved since, answer the
  // miss (409) so the client adopts + replays, exactly like the office path.
  let full;
  let version;
  try {
    const r = await readOrgState();
    full = r.state;
    version = r.version;
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Read failed' });
  }
  if (version !== baseVersion) return await answerMiss(res, baseVersion, buildNum);

  let scope;
  try {
    const crewJobs = await getCrewJobs(userId); // job-based half of the scope, from the RLS-scoped table
    scope = crewAssignedScope(full, userId, crewJobs);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Scope read failed' });
  }

  let merged;
  try {
    merged = mergeCrewChanges({ full, posted, userId, scope, now: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Crew merge failed' });
  }
  const { next, dropped, pushWorthy } = merged;

  // ── DEFENSE IN DEPTH ──────────────────────────────────────────────────────
  // The merge must NEVER have changed a protected field. If it did, that is a bug in the
  // allowlist, not a user error — refuse (500) and report, never commit. removalFacts is
  // {} unless the merge somehow removed a member (it never does), so the pay rule stays inert.
  try {
    const violations = protectedFieldViolations(full, next, a.role, userId, await removalFacts(full, next, a));
    if (violations.length) {
      reportError('crew_merge.protected_violation', new Error(violations.join('; ')), { caller: userId, role: a.role || null });
      return res.status(500).json({ error: 'Crew merge produced a protected change (refused)' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Authorization check failed' });
  }

  try {
    // Same CAS write as the office path. The fingerprint is unchanged from the committed blob
    // (crew never touch a protected field), so storing it keeps the digest current and the
    // next office save still skips the deep read.
    const r = await writeOrgStateFromClient({
      state: next,
      baseVersion,
      userId: a.user.id,
      fingerprint: protectedFingerprint(next),
      build: buildNum,
      tab: tabId,
    });
    if (!r.ok) return await answerMiss(res, baseVersion, buildNum);

    // Server-derived recipient notifications (a new message, a key checked out to a teammate)
    // must reach devices now, not up to a minute later — flush push through the shared
    // dispatch core, exactly as /api/push/flush does. Best-effort: a push failure never fails
    // the committed save.
    if (pushWorthy) {
      try { if (pushConfigured()) await dispatchDue(); }
      catch (e) { reportError('crew_merge.push_flush_failed', e, { caller: userId }); }
    }

    if (dropped.length) {
      const slices = [...new Set(dropped.map((d) => d.slice))];
      // Log through the monitor helper so a crew client repeatedly posting disallowed changes
      // is observable — never a 403 (a refusal would wedge the save), always a 200 + report.
      reportError('crew_merge.dropped', new Error(`${dropped.length} change(s) dropped: ${slices.join(', ')}`), { caller: userId, dropped });
      return res.status(200).json({ ok: true, version: r.version, dropped: { count: dropped.length, slices } });
    }
    return res.status(200).json({ ok: true, version: r.version });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Write failed' });
  }
}
