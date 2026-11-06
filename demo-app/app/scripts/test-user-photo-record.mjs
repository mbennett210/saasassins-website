// Team PROFILE PHOTOS — the shared record (UI_RULES §141). A member's photo is `users[].photo =
// { v }` (src/lib/userPhoto.js), absent or null when they show initials. The server's link route
// signs whatever `v` it finds there, so every WRITE point checks the value, and only a valid one
// from an allowed writer lands:
//   A. the reducer (SET_USER_PHOTO): `{ v }` and null land, anything else is ignored (never
//      repaired), an unchanged value is a no-op, and `users[].avatar` (the colour) is untouched;
//   B. the crew projection (api/_lib/crewView.js) serves `photo` on EVERY row — a cleaner sees
//      coworkers' and supervisors' faces — and nothing more of anyone else's row;
//   C. the crew save path (api/_lib/crewMerge.js §a): a cleaner's OWN row merges a valid photo
//      change (or its removal); a malformed one is dropped and reported; another member's row
//      never merges; the merged state passes the protected-field guard.
//
// Offline. Run: node scripts/test-user-photo-record.mjs
import { register } from 'node:module';
// reducer.js uses extensionless relative imports; resolve them as .js under plain node.
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const { mergeCrewChanges } = await import('../api/_lib/crewMerge.js');
const { projectCrewView } = await import('../api/_lib/crewView.js');
const { protectedFieldViolations } = await import('../api/_lib/orgStateGuard.js');
const { reducer, ACTIONS } = await import('../src/store/reducer.js');

const V1 = 'a1b2c3d4e5f6g7h8i9j0k1l2m';
const V2 = 'zz00yy11xx22ww33vv44uu55t';
const ME = 'u_crew_me';
const MATE = 'u_crew_mate';
const BOSS = 'u_owner';
const baseState = () => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [
    { id: BOSS, name: 'Owner', initials: 'OW', avatar: 2, role: 'owner', status: 'active', email: 'o@x.test', phone: '111', photo: { v: V1 } },
    { id: ME, name: 'Ana', initials: 'AN', avatar: 3, role: 'crew', status: 'active', email: 'ana@x.test' },
    { id: MATE, name: 'Luis', initials: 'LU', avatar: 4, role: 'crew', status: 'active', email: 'luis@x.test', photo: { v: V2 } },
  ],
  jobs: [], clients: [], sites: [], contacts: [], notifications: [], conversations: [], messages: [],
});
const self = (state, id = ME) => state.users.find((u) => u.id === id);
const BAD = [
  [{ v: 'short' }, 'a short v'], [{ v: 'A1B2C3D4E5F6G7H8I9J0' }, 'an upper-case v'], [{ v: '../../x/y/z/aaaaaaaaaaaa' }, 'a traversal v'],
  [{ v: V1, url: 'https://evil.test/x.jpg' }, 'an extra key'], [{ path: 'org/_avatars/u/x.jpg' }, 'a path'], ['https://evil.test/x.jpg', 'a URL string'],
  [[V1], 'an array'], [42, 'a number'], [{}, 'an empty object'],
];

// ── A. the reducer ────────────────────────────────────────────────────────────────────────
{
  ok('A0: the action exists', typeof ACTIONS.SET_USER_PHOTO === 'string');
  const s0 = baseState();
  const s1 = reducer(s0, { type: ACTIONS.SET_USER_PHOTO, userId: ME, photo: { v: V2 } });
  ok('A1: { v } lands on the member\'s row', self(s1).photo?.v === V2 && Object.keys(self(s1).photo).length === 1);
  ok('A2: …and the colour number (users[].avatar) is untouched', self(s1).avatar === 3);
  ok('A3: …and nobody else\'s row moved', self(s1, MATE) === self(s0, MATE) && self(s1, BOSS) === self(s0, BOSS));
  const s2 = reducer(s1, { type: ACTIONS.SET_USER_PHOTO, userId: ME, photo: null });
  ok('A4: null removes the photo (the field is gone, so the row reads "no photo")', !('photo' in self(s2)) && self(s2).avatar === 3);
  ok('A5: removing a photo nobody has is a no-op (same state)', reducer(s0, { type: ACTIONS.SET_USER_PHOTO, userId: ME, photo: null }) === s0);
  ok('A6: setting the same v again is a no-op (no needless save)', reducer(s1, { type: ACTIONS.SET_USER_PHOTO, userId: ME, photo: { v: V2 } }) === s1);
  for (const [bad, label] of BAD) {
    ok(`A7: ${label} is ignored, never repaired`, reducer(s1, { type: ACTIONS.SET_USER_PHOTO, userId: ME, photo: bad }) === s1);
  }
  ok('A8: a photo key missing from the action is ignored', reducer(s1, { type: ACTIONS.SET_USER_PHOTO, userId: ME }) === s1);
  ok('A9: an unknown member is a no-op', reducer(s0, { type: ACTIONS.SET_USER_PHOTO, userId: 'u_nobody', photo: { v: V1 } }) === s0);
  const s3 = reducer(s0, { type: ACTIONS.SET_USER_PHOTO, userId: MATE, photo: { v: V1 } });
  ok('A10: the office can point another member\'s row at a new v (the route decided who may upload)', self(s3, MATE).photo.v === V1);
  ok('A11: the stored photo is a fresh object, not the action\'s', (() => { const p = { v: V1 }; const s = reducer(s0, { type: ACTIONS.SET_USER_PHOTO, userId: ME, photo: p }); return self(s).photo !== p; })());
}

// ── B. the crew projection ────────────────────────────────────────────────────────────────
const scope = { clientIds: [] };
{
  const served = projectCrewView(baseState(), { userId: ME, crewJobs: [], scope });
  const boss = served.users.find((u) => u.id === BOSS);
  const mate = served.users.find((u) => u.id === MATE);
  const me = served.users.find((u) => u.id === ME);
  ok('B1: a cleaner is served a SUPERVISOR\'s photo', boss?.photo?.v === V1);
  ok('B2: …a COWORKER\'s photo', mate?.photo?.v === V2);
  ok('B3: …and their own (null when they have none: default-safe)', me && me.photo === null);
  ok('B4: …and still nothing else of a coworker\'s row (no email, no phone for crew)', mate && !('email' in mate) && !('phone' in mate));
}

// ── C. the crew save path ─────────────────────────────────────────────────────────────────
function crewSave(edit, full = baseState()) {
  const served = projectCrewView(full, { userId: ME, crewJobs: [], scope });
  const posted = structuredClone(served);
  edit(posted);
  return { full, ...mergeCrewChanges({ full, posted, userId: ME, scope }) };
}
const setRow = (id, patch) => (posted) => { posted.users = posted.users.map((u) => (u.id === id ? { ...u, ...patch } : u)); };
const droppedFor = (dropped, id = ME) => dropped.some((d) => d.slice === 'users' && d.id === id);
{
  const { full, next, dropped } = crewSave(setRow(ME, { photo: { v: V2 } }));
  ok('C1: a cleaner\'s own new photo merges', self(next).photo?.v === V2);
  ok('C2: …with nothing dropped', dropped.length === 0);
  ok('C3: …and the merged state passes the protected-field guard', protectedFieldViolations(full, next, 'crew', ME).length === 0);
}
{
  const full = baseState();
  full.users = full.users.map((u) => (u.id === ME ? { ...u, photo: { v: V1 } } : u));
  const { next, dropped } = crewSave(setRow(ME, { photo: null }), full);
  ok('C4: a cleaner removes their own photo (the field is gone)', !('photo' in self(next)) && dropped.length === 0);
}
for (const [bad, label] of BAD) {
  const { next, dropped } = crewSave(setRow(ME, { photo: bad }));
  ok(`C5: ${label} on the cleaner's own row does NOT land`, self(next).photo === undefined);
  ok(`C6: …and is reported (${label})`, droppedFor(dropped));
}
{
  const { next, dropped } = crewSave(setRow(MATE, { photo: { v: V1 } }));
  ok('C7: a cleaner can NOT change a coworker\'s photo', self(next, MATE).photo.v === V2);
  ok('C8: …and the attempt is reported', droppedFor(dropped, MATE));
  const r2 = crewSave(setRow(MATE, { photo: null }));
  ok('C9: …nor remove it', self(r2.next, MATE).photo.v === V2 && droppedFor(r2.dropped, MATE));
}
{
  const { next } = crewSave(setRow(ME, { photo: { v: V2 }, avatar: 1, role: 'owner' }));
  ok('C10: a photo riding with an authority change: the photo lands, the role and the colour never do',
    self(next).photo?.v === V2 && self(next).role === 'crew' && self(next).avatar === 3);
}
{
  const full = baseState();
  full.users = full.users.map((u) => (u.id === ME ? { ...u, photo: { v: V1 } } : u));
  const { next, dropped } = crewSave(() => {}, full);
  ok('C11: an untouched save leaves the saved photo as it was', self(next).photo?.v === V1 && dropped.length === 0);
}

console.log(`\ntest-user-photo-record: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
