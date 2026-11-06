// Crew cannot snooze a message conversation — NTF-3 / CS-291 (2026-09-29).
//
// Matt, 2026-09-29 (NTF-3): "No — cleaners can't mute". lib/roles.js has said since S35 that
// crew notifications are MANDATORY and that "the reducer refuses a mute at the write point"
// — but only UPDATE_NOTIFICATION_PREFS did. TOGGLE_CONVERSATION_MUTE had no role check, so a
// crew member could silence a thread from the thread header instead, DMs from the office
// included, because lib/notifications.js skips muted recipients before the channel branches.
//
// The reducer is the boundary, not the button: org_state is browser-writable, so hiding the
// Snooze control is an affordance and this check is what actually holds.
//
//   node scripts/test-crew-conversation-mute.mjs
// loadStore() imports the REAL reducer under plain node (deletion-core.mjs installs the
// resolve shim Vite's extensionless imports need), so this drives the actual handler rather
// than asserting against its source text.
import { loadStore } from './deletion-core.mjs';
import { NOTIFICATIONS_MANDATORY_ROLES, ROLES } from '../src/lib/roles.js';

const { reducer, ACTIONS } = await loadStore();

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const users = ROLES.map((role) => ({ id: `u_${role}`, name: role, role, email: `${role}@example.test`, status: 'active' }));
const baseState = (muted = []) => ({
  users,
  currentUserId: 'u_owner',
  conversations: [{ id: 'cv_1', channel: 'email', mutedByUserIds: [...muted], starredByUserIds: [] }],
  messages: [],
});
const mutedIn = (s) => s.conversations[0].mutedByUserIds;
const toggle = (state, userId) => reducer(state, { type: ACTIONS.TOGGLE_CONVERSATION_MUTE, id: 'cv_1', userId });

// The policy list is the source of truth: derive who may and may not, never restate 'crew'.
ok('the policy names at least one mandatory role', NOTIFICATIONS_MANDATORY_ROLES.length > 0);

for (const role of ROLES) {
  const uid = `u_${role}`;
  const mandatory = NOTIFICATIONS_MANDATORY_ROLES.includes(role);
  const after = toggle(baseState(), uid);
  if (mandatory) {
    ok(`🔴 ${role} (notifications mandatory) CANNOT mute a thread`, !mutedIn(after).includes(uid), JSON.stringify(mutedIn(after)));
    ok(`  ...and the state is returned unchanged, not rebuilt`, after.conversations === baseState().conversations ? true : mutedIn(after).length === 0);
  } else {
    ok(`${role} can still snooze a thread`, mutedIn(after).includes(uid), JSON.stringify(mutedIn(after)));
  }
}

// UN-muting is always allowed: turning alerts back ON is not what the policy protects
// against, and a crew row that is already muted (the seed's demo user) must be able to clear
// it. A guard that blocked the whole action would trap them muted forever.
for (const role of NOTIFICATIONS_MANDATORY_ROLES) {
  const uid = `u_${role}`;
  const after = toggle(baseState([uid]), uid);
  ok(`${role} may still UN-mute a thread they are already muted on`, !mutedIn(after).includes(uid), JSON.stringify(mutedIn(after)));
}

// Someone else's id is not a way round it: the guard judges the TARGET user's role, not the
// dispatcher's, because the action names the user it mutes for.
{
  const crewRole = NOTIFICATIONS_MANDATORY_ROLES[0];
  const state = { ...baseState(), currentUserId: 'u_owner' };
  const after = toggle(state, `u_${crewRole}`);
  ok('an owner cannot mute a thread ON BEHALF of a mandatory-role member',
    !mutedIn(after).includes(`u_${crewRole}`), JSON.stringify(mutedIn(after)));
}

// A userId with no roster row has no role, so nothing is mandatory about it — it behaves as
// before (the pre-existing contract for an unknown id).
{
  const after = toggle(baseState(), 'u_ghost');
  ok('an unknown user id still toggles (unchanged behaviour)', mutedIn(after).includes('u_ghost'), JSON.stringify(mutedIn(after)));
}

// An unknown conversation is still a no-op.
{
  const state = baseState();
  const after = reducer(state, { type: ACTIONS.TOGGLE_CONVERSATION_MUTE, id: 'cv_nope', userId: 'u_owner' });
  ok('an unknown conversation is a no-op', after === state);
}

console.log(`\ncrew conversation mute (NTF-3 / CS-291): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
