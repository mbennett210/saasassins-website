// What a termination DOES to the person's Clean Corner access (Super Clippy's idea #513; Matt:
// "when a termination is processed, the employee automatically loses access to Clean Corner").
//
// Daniel's pick (2026-11-05): the login turns off ON the termination date, and at once when that
// date is today or earlier. The route runs `endTerminationAccess` right after filing when the date
// has come; the ops-alerts cron (every 5 minutes, `runTerminationAccess`) runs it for every
// termination whose date has come since, and runs it again for any turn-off that didn't finish.
// A void undoes it (`restoreTerminationAccess`): before the date the login never turns off;
// after it, the login comes back on only if THIS termination turned it off.
//
// "Turned off" is the same two halves Settings → Team's Disabled is (TeamDetail →
// teamApi.applyLoginChanges, then UPDATE_USER):
//   1. THE LOGIN: the Supabase account is banned (users.js setLoginBannedById), so it can't sign
//      in or refresh a session, and can't reach Supabase directly (loginBanSync.js explains why
//      the ban is the part that closes that door);
//   2. THE TEAM: the member's roster row in the shared record reads `status: 'disabled'` with
//      `disabledAt`, as the reducer stamps it, so every app route refuses them at once (authz.js
//      `account-disabled`) and the pay run keeps them on the periods they worked.
// The login goes FIRST, as on Team (its undo is always allowed), and the roster is written by a
// CAS loop with a re-read on conflict (rosterRemoval.js's pattern), so a tab's save racing it
// replays onto the newer record rather than overwriting it.
//
// 🔴 EVERY STEP IS SAFE TO RUN AGAIN. The row is moved to `ending` (with `access_ended_at`, the
// instant stamped as the roster's `disabledAt`) BEFORE the ban, so a run that dies half-way is
// finished by the next one, and the roster's `disabledAt` is how a later run (and a void) tells
// "this termination's Disabled" from a Disabled set by hand on Team. A Super Admin's login is
// never turned off here (the filing refuses one; a member made Super Admin since is left alone).
import { readOrgState, writeOrgState, readProtectedSlices } from '../orgState.js';
import { findAuthUserByEmail, setLoginBannedById, isLoginBanned } from '../users.js';
import { reportError } from '../monitor.js';
import { dayKey } from '../../../src/lib/dates.js';
import { hasTeamAccess } from '../../../src/lib/teamScope.js';
import {
  ACCESS_STATE, TERMINATION_STATUS, rosterWithAccessEnded, rosterWithAccessRestored,
  terminationAccessDue, terminationRestoreDue,
} from '../../../src/lib/hrTerminations.js';
import { getTermination, moveTermination, dueAccessTerminations, dueRestoreTerminations } from './store.js';

const ROSTER_CAS_RETRIES = 5;
// At most this many turn-offs and give-backs a run (each reads GoTrue's login list).
export const TERMINATION_ACCESS_MAX_PER_RUN = 25;

const IO = { readOrgState, writeOrgState, findAuthUserByEmail, setLoginBannedById, isLoginBanned };

// The org's calendar day (THE LAW II.8: these functions run TZ=UTC; a falsy zone resolves to the
// org default inside lib/dates), as the HR warnings and incidents routes read it.
export async function orgToday(now = Date.now()) {
  try {
    const data = await readProtectedSlices('company:state->company');
    return dayKey(new Date(now), (data && data.company && data.company.timezone) || null);
  } catch {
    return dayKey(new Date(now), null);
  }
}
const rowsOf = (state, id) => (Array.isArray(state?.users) ? state.users : []).filter((u) => u && u.id === id);

// The member's login, banned (`on: false`) or unbanned (`on: true`) — only when it isn't already,
// and never a Super Admin's ban. No login at all (an invite never sent) is nothing to change.
async function setLogin(member, on, { now, io }) {
  const email = typeof member?.email === 'string' ? member.email.trim() : '';
  if (!email) return 'no-login';
  const au = await io.findAuthUserByEmail(email);
  if (!au) return 'no-login';
  const banned = io.isLoginBanned(au, now);
  if (on ? !banned : banned) return 'unchanged';
  if (!on && (member.role === 'owner' || au.app_metadata?.role === 'owner')) return 'owner';
  await io.setLoginBannedById(au.id, !on);
  return on ? 'unbanned' : 'banned';
}

// The roster write, CAS-retried: `change(users)` → { users, changed }. → true once written (or
// nothing to change), throws when the record keeps moving.
async function writeRoster(change, { io }) {
  for (let attempt = 0; attempt < ROSTER_CAS_RETRIES; attempt += 1) {
    const { state, version } = await io.readOrgState();
    if (!version) return false;
    const out = change(state.users);
    if (!out.changed) return true;
    // `prev`: a member's status is a protected field, so the digest is kept current (orgState.js).
    if (await io.writeOrgState({ ...state, users: out.users }, version, { prev: state })) return true;
  }
  throw new Error('org_state write kept conflicting (too much concurrent activity)');
}

/**
 * Turn off the login of a termination whose date has come. → { outcome } where outcome is
 * 'ended' | 'already_off' | 'restored' | 'kept' (voided while it ran: given back) |
 * 'not-due' | 'moved' (another run got there first) | 'skipped-owner'.
 */
export async function endTerminationAccess(termination, { today, now = Date.now(), io = IO, db } = {}) {
  let t = termination;
  if (!terminationAccessDue(t, today)) return { outcome: 'not-due' };
  const { state } = await io.readOrgState();
  const rows = rowsOf(state, t.employeeUserId);
  const member = rows[0] || null;
  if (rows.some((u) => u.role === 'owner')) return { outcome: 'skipped-owner' };

  if (t.accessState === ACCESS_STATE.scheduled) {
    if (!member || !rows.every(hasTeamAccess)) {
      // Disabled on Team (or removed) before the date: nothing for this termination to turn off.
      const moved = await moveTermination(t.id, { status: TERMINATION_STATUS.filed, accessStates: [ACCESS_STATE.scheduled] },
        { access_state: ACCESS_STATE.alreadyOff }, db);
      return { outcome: moved ? 'already_off' : 'moved' };
    }
    const moved = await moveTermination(t.id, { status: TERMINATION_STATUS.filed, accessStates: [ACCESS_STATE.scheduled] }, {
      access_state: ACCESS_STATE.ending,
      access_ended_at: new Date(now).toISOString(),
      status_before: member.status === 'invited' ? 'invited' : 'active',
    }, db);
    if (!moved) return { outcome: 'moved' };
    t = moved;
  }

  // `ending`: the login first, then the team.
  const stamp = t.accessEndedAt;
  if (member) {
    const login = await setLogin(member, false, { now, io });
    if (login === 'owner') return { outcome: 'skipped-owner' };
    await writeRoster((users) => rosterWithAccessEnded(users, t.employeeUserId, stamp), { io });
  }
  const after = rowsOf((await io.readOrgState()).state, t.employeeUserId);
  const ours = after.length > 0 && after.every((u) => u.status === 'disabled' && u.disabledAt === stamp);
  const moved = await moveTermination(t.id, { status: TERMINATION_STATUS.filed, accessStates: [ACCESS_STATE.ending] },
    { access_state: ours ? ACCESS_STATE.ended : ACCESS_STATE.alreadyOff }, db);
  if (moved) return { outcome: moved.accessState };
  // Voided while it ran: give it back now (the cron would, next run).
  const again = await getTermination(t.id, db);
  if (again && terminationRestoreDue(again)) return restoreTerminationAccess(again, { now, io, db });
  return { outcome: 'moved' };
}

/**
 * Give the login back after a void, when this termination had begun turning it off. Only a roster
 * row this termination disabled (its `disabledAt`) comes back; one changed on Team since is left
 * as it is ('kept'). → { outcome: 'restored' | 'kept' | 'not-due' | 'moved' }.
 */
export async function restoreTerminationAccess(termination, { now = Date.now(), io = IO, db } = {}) {
  const t = termination;
  if (!terminationRestoreDue(t)) return { outcome: 'not-due' };
  const rows = rowsOf((await io.readOrgState()).state, t.employeeUserId);
  const member = rows[0] || null;
  const ours = rows.length > 0 && rows.every((u) => u.status === 'disabled' && u.disabledAt === t.accessEndedAt);
  // A turn-off that never reached the roster (voided mid-way) may still have banned the login.
  const untouched = t.accessState === ACCESS_STATE.ending && rows.length > 0 && rows.every(hasTeamAccess);
  let state = ACCESS_STATE.kept;
  if (member && (ours || untouched)) {
    await setLogin(member, true, { now, io });
    if (ours) {
      await writeRoster((users) => {
        const out = rosterWithAccessRestored(users, t.employeeUserId, { disabledAt: t.accessEndedAt, statusBefore: t.statusBefore });
        return { users: out.users, changed: out.changed };
      }, { io });
    }
    state = ACCESS_STATE.restored;
  }
  const moved = await moveTermination(t.id, { status: TERMINATION_STATUS.voided, accessStates: [ACCESS_STATE.ending, ACCESS_STATE.ended] }, {
    access_state: state,
    ...(state === ACCESS_STATE.restored ? { access_restored_at: new Date(now).toISOString() } : {}),
  }, db);
  return { outcome: moved ? state : 'moved' };
}

/**
 * The cron's step (api/cron/ops-alerts.js): every termination whose date has come, turned off;
 * every voided one still holding a login, given back. Best-effort per termination (one failure
 * is reported and retried next run, never stops the others). `dryRun` reads and writes nothing
 * but the list of what would run.
 */
export async function runTerminationAccess({ dryRun = false, now = Date.now(), io = IO, db, orgDay = orgToday, report = reportError } = {}) {
  const today = await orgDay(now);
  const due = await dueAccessTerminations({ today, limit: TERMINATION_ACCESS_MAX_PER_RUN }, db);
  const back = await dueRestoreTerminations({ limit: TERMINATION_ACCESS_MAX_PER_RUN }, db);
  if (dryRun) return { wouldEnd: due.map((t) => t.id), wouldRestore: back.map((t) => t.id) };
  const out = { ended: 0, alreadyOff: 0, restored: 0, kept: 0, skipped: 0, failed: 0 };
  const tally = (outcome) => {
    if (outcome === 'ended') out.ended += 1;
    else if (outcome === 'already_off') out.alreadyOff += 1;
    else if (outcome === 'restored') out.restored += 1;
    else if (outcome === 'kept') out.kept += 1;
    else out.skipped += 1;
  };
  for (const t of due) {
    try { tally((await endTerminationAccess(t, { today, now, io, db })).outcome); }
    catch (e) { out.failed += 1; report('hr_terminations.end_failed', e, { id: t.id, note: 'retried on the next ops-alerts run' }); }
  }
  for (const t of back) {
    try { tally((await restoreTerminationAccess(t, { now, io, db })).outcome); }
    catch (e) { out.failed += 1; report('hr_terminations.restore_failed', e, { id: t.id, note: 'retried on the next ops-alerts run' }); }
  }
  return out;
}
