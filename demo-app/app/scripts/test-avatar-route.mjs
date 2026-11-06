// Team PROFILE PHOTOS — the server half (UI_RULES §141): /api/avatars/{upload,remove,urls}
// through the REAL handler and the REAL supabase-js (Storage included) against the loopback
// fake (scripts/fake-supabase-server.mjs). Offline by construction: a fetch guard refuses
// every host but the fake.
//
// What it pins:
//   A. the path is BUILT from (userId, v) — never taken from a caller — and a traversal id or a
//      malformed `v` throws before anything is concatenated (AUTHORIZATION_AUDIT #5's lesson);
//   B. the bytes: a JPEG or PNG by magic bytes, ≤ PHOTO_MAX_BYTES decoded; a GIF, an SVG and a
//      JPEG declared as PNG are refused;
//   C. who may set whose photo: yourself always (no key needed); another member only with
//      `settings.team.edit` (committed matrix + overrides), and only someone on the roster;
//   D. retention at the write point: after an upload the member's folder holds exactly the new
//      object and the one the committed roster row points at;
//   E. remove empties the member's folder, on the same rule;
//   F. links: any staff login, ≤ PHOTO_URLS_MAX ids, signed only for the roster's CURRENT `v`
//      of a member who has one, private and uncached.
//
//   node app/scripts/test-avatar-route.mjs
import { randomUUID } from 'node:crypto';
import { startFakeSupabase } from './fake-supabase-server.mjs';
import * as roles from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── offline rig: env first (the clients are built on first use), then the handler ───────
const ORG = '00000000-0000-0000-0000-0000000a7a12';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_ANON_KEY: 'fake-anon',
  FORMS_ORG_ID: ORG,
  CLEANSPACE_ORG_ID: ORG,
});
const realFetch = globalThis.fetch;
const strays = [];
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!u.startsWith(fake.url)) { strays.push(u); return Promise.reject(new Error(`offline suite: refused ${u}`)); }
  return realFetch(input, init);
};
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};

// Missing before the feature: the checks then FAIL instead of the suite crashing.
const lib = await import('../api/_lib/avatars.js').catch(() => ({}));
const photo = await import('../src/lib/userPhoto.js').catch(() => ({}));
const route = (await import('../api/avatars/[...path].js').catch(() => ({}))).default;
const BUCKET = 'ops-media';
const MAX = photo.PHOTO_MAX_BYTES ?? 200 * 1024;
const URLS_MAX = photo.PHOTO_URLS_MAX ?? 200;
const TTL = photo.PHOTO_URL_TTL_SECONDS ?? 6 * 3600;

// ── A. the path ──────────────────────────────────────────────────────────────────────────
const V1 = 'a1b2c3d4e5f6g7h8i9j0k1l2m';
const V2 = 'zz00yy11xx22ww33vv44uu55t';
const V3 = 'qq99pp88oo77nn66mm55ll44k';
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
ok('A1: avatarPathFor builds <org>/_avatars/<userId>/<v>.jpg',
  typeof lib.avatarPathFor === 'function' && lib.avatarPathFor('u_ana', V1) === `${ORG}/_avatars/u_ana/${V1}.jpg`);
ok('A2: a traversal user id throws (../, a slash, a dot, empty)', typeof lib.avatarPathFor === 'function'
  && ['../u_ana', 'u/ana', 'u.ana', '', null, 'u_ana%2f..'].every((id) => throws(() => lib.avatarPathFor(id, V1))));
ok('A3: a malformed v throws (traversal, upper case, too short, too long, an object)', typeof lib.avatarPathFor === 'function'
  && ['../x', 'ABCDEFGHIJKLMNOPQ', 'abc', 'a'.repeat(33), { v: V1 }, `${V1}.jpg`].every((v) => throws(() => lib.avatarPathFor('u_ana', v))));
{
  const minted = typeof lib.mintPhotoVersion === 'function' ? [lib.mintPhotoVersion(), lib.mintPhotoVersion()] : [];
  ok('A4: a minted v is a valid photo version, and two mints differ',
    minted.length === 2 && minted.every((v) => photo.isPhotoVersion?.(v)) && minted[0] !== minted[1]);
}

// ── B. the bytes ─────────────────────────────────────────────────────────────────────────
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]);
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
const pad = (buf, n) => Buffer.concat([buf, Buffer.alloc(Math.max(0, n - buf.length))]);
const check = (v) => (typeof lib.validateAvatarUpload === 'function' ? lib.validateAvatarUpload(v) : { ok: 'missing' });
ok('B1: a JPEG is accepted', check(dataUrl('image/jpeg', JPG)).ok === true);
ok('B2: a PNG is accepted', check(dataUrl('image/png', PNG)).ok === true);
ok('B3: a GIF is refused', check(dataUrl('image/gif', GIF)).ok === false);
ok('B4: an SVG is refused', check(dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).ok === false);
ok('B5: a JPEG declared as PNG is refused', check(dataUrl('image/png', JPG)).ok === false);
ok('B6: bytes that are no image, declared as JPEG, are refused', check(dataUrl('image/jpeg', Buffer.from('<html>not an image</html>'))).ok === false);
ok('B7: over the cap (decoded) is refused', check(dataUrl('image/jpeg', pad(JPG, MAX + 1))).ok === false);
ok('B8: exactly at the cap is accepted', check(dataUrl('image/jpeg', pad(JPG, MAX))).ok === true);
ok('B9: nothing, a number, an object, a URL are refused without throwing',
  [undefined, null, '', 42, { dataUrl: 'x' }, 'https://example.com/me.jpg', 'data:image/jpeg;base64,'].every((v) => check(v).ok === false));

// ── the world ────────────────────────────────────────────────────────────────────────────
const matrix = roles.seedPermissions();
const PEOPLE = {
  owner: 'owner', admin: 'admin', mgr: 'manager', mgrpared: 'manager', crew: 'crew', crew2: 'crew', crewgrant: 'crew',
};
const idOf = (k) => `u_${k}`;
function world({ photos = {}, objects = {} } = {}) {
  const authUsers = [];
  const tokens = {};
  const users = [];
  for (const [k, role] of Object.entries(PEOPLE)) {
    users.push({ id: idOf(k), role, status: 'active', name: k, email: `${k}@cs.test`, initials: k.slice(0, 2).toUpperCase(), avatar: 1, ...(photos[k] ? { photo: { v: photos[k] } } : {}) });
    const authId = randomUUID();
    authUsers.push({ id: authId, email: `${k}@cs.test`, app_metadata: { provider: 'email', role, org_user_id: idOf(k), org_id: ORG }, user_metadata: {}, banned_until: null });
    tokens[`tok_${k}`] = authId;
  }
  return {
    authUsers,
    tokens,
    objects,
    orgState: {
      organization_id: ORG,
      version: 3,
      protected_fingerprint: null,
      min_client_build: null,
      state: {
        users,
        permissions: matrix,
        // A manager pared off the key, and a cleaner granted it.
        userPermissionOverrides: [
          { userId: idOf('mgrpared'), grants: [], revokes: ['settings.team.edit'] },
          { userId: idOf('crewgrant'), grants: ['settings.team.edit'], revokes: [] },
        ],
        company: { name: 'Clean Space', timezone: 'America/New_York' },
      },
    },
  };
}
const mockRes = () => ({
  statusCode: 0, body: null, headers: {},
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  end() { return this; },
});
async function call(k, action, body, { method = 'POST' } = {}) {
  const req = { method, headers: k ? { authorization: `Bearer tok_${k}`, host: '127.0.0.1' } : { host: '127.0.0.1' }, query: { subpath: action }, body };
  const res = mockRes();
  if (typeof route !== 'function') return { ...res, statusCode: -1 };
  try { await route(req, res); } catch (e) { res.statusCode = -2; res.body = { thrown: e.message }; }
  return res;
}
// `k` is a person's key in PEOPLE (or an id-less name); the folder is their `u_<k>` id's.
const folderOf = (k) => `${BUCKET}/${ORG}/_avatars/${idOf(k)}/`;
const objectsIn = (k) => [...fake.db.objects.keys()].filter((key) => key.startsWith(folderOf(k))).map((key) => key.slice(folderOf(k).length)).sort();
const JPEG_URL = dataUrl('image/jpeg', JPG);
const committedV = (k) => fake.db.orgState.state.users.find((u) => u.id === idOf(k))?.photo?.v ?? null;

ok('the route module exists (api/avatars/[...path].js)', typeof route === 'function');

// ── C. who may set whose photo ───────────────────────────────────────────────────────────
fake.reset(world());
{
  const r = await call('crew', 'upload', { dataUrl: JPEG_URL });
  ok('C1: a cleaner uploads their OWN photo (no key needed) → 200 { v }', r.statusCode === 200 && photo.isPhotoVersion?.(r.body?.v));
  const v = r.body?.v;
  ok('C2: …stored at <org>/_avatars/<their id>/<v>.jpg', !!v && objectsIn('crew').includes(`${v}.jpg`));
  const o = v && fake.db.objects.get(`${folderOf('crew')}${v}.jpg`);
  ok('C3: …as a JPEG, cached for a year (the object never changes: a new photo is a new v)',
    !!o && o.contentType === 'image/jpeg' && /31536000/.test(String(o.cacheControl)));
  ok('C4: the upload does NOT write the shared record (the device dispatches SET_USER_PHOTO)', committedV('crew') === null);
  const r2 = await call('crew', 'upload', { dataUrl: JPEG_URL, userId: idOf('crew') });
  ok('C5: naming yourself is the same as naming no one', r2.statusCode === 200);
}
{
  const before = fake.db.objects.size;
  const r = await call('crew', 'upload', { dataUrl: JPEG_URL, userId: idOf('crew2') });
  ok('C6: a cleaner can NOT set a teammate\'s photo → 403', r.statusCode === 403);
  ok('C7: …and nothing is stored', fake.db.objects.size === before && objectsIn('crew2').length === 0);
}
for (const k of ['owner', 'admin', 'mgr', 'crewgrant']) {
  const r = await call(k, 'upload', { dataUrl: JPEG_URL, userId: idOf('crew2') });
  ok(`C8: ${k} (holds settings.team.edit) sets another member's photo → 200`, r.statusCode === 200 && photo.isPhotoVersion?.(r.body?.v));
}
{
  const r = await call('mgrpared', 'upload', { dataUrl: JPEG_URL, userId: idOf('crew') });
  ok('C9: a manager pared off settings.team.edit is refused → 403', r.statusCode === 403);
}
{
  const r = await call('owner', 'upload', { dataUrl: JPEG_URL, userId: 'u_notonteam' });
  ok('C10: the target must be on the committed roster → 404', r.statusCode === 404);
  ok('C11: …and nothing is stored for them', objectsIn('notonteam').length === 0);
}
{
  const r = await call('owner', 'upload', { dataUrl: JPEG_URL, userId: '../u_crew' });
  ok('C12: a traversal user id → 400, nothing stored', r.statusCode === 400 && ![...fake.db.objects.keys()].some((key) => key.includes('..')));
}
{
  const before = new Set(fake.db.objects.keys());
  const r = await call('crew', 'upload', { dataUrl: JPEG_URL, path: `${ORG}/_signatures/u_owner.png`, storagePath: 'x/y.jpg' });
  const added = [...fake.db.objects.keys()].filter((key) => !before.has(key));
  ok('C13: a caller-sent path is ignored: the object lands under the caller\'s own folder only',
    r.statusCode === 200 && added.length === 1 && added[0].startsWith(folderOf('crew')));
}
{
  const r1 = await call('crew', 'upload', { dataUrl: dataUrl('image/gif', GIF) });
  const r2 = await call('crew', 'upload', { dataUrl: dataUrl('image/jpeg', pad(JPG, MAX + 1)) });
  ok('C14: a GIF and an oversize photo are refused with 400', r1.statusCode === 400 && r2.statusCode === 400);
  ok('C15: …with a sentence for the person, not a stack', typeof r1.body?.error === 'string' && typeof r2.body?.error === 'string');
}
{
  const r = await call(null, 'upload', { dataUrl: JPEG_URL });
  ok('C16: no session → 401', r.statusCode === 401);
  const g = await call('crew', 'upload', undefined, { method: 'GET' });
  ok('C17: a GET is not a route (404/405)', g.statusCode === 404 || g.statusCode === 405);
  const u = await call('crew', 'nope', {});
  ok('C18: an unknown action → 404', u.statusCode === 404);
}

// ── D. retention at the write point ──────────────────────────────────────────────────────
{
  const old = '2026-01-01T00:00:00.000Z';
  fake.reset(world({
    photos: { crew: V2 },
    objects: {
      [`${folderOf('crew')}${V1}.jpg`]: { bytes: JPG, created_at: old },
      [`${folderOf('crew')}${V2}.jpg`]: { bytes: JPG, created_at: old },
      [`${folderOf('crew')}${V3}.jpg`]: { bytes: JPG, created_at: old },
      [`${folderOf('crew2')}${V1}.jpg`]: { bytes: JPG, created_at: old },
    },
  }));
  const r = await call('crew', 'upload', { dataUrl: JPEG_URL });
  const v = r.body?.v;
  ok('D1: after an upload the folder holds EXACTLY the new object and the committed one',
    r.statusCode === 200 && JSON.stringify(objectsIn('crew')) === JSON.stringify([`${v}.jpg`, `${V2}.jpg`].sort()));
  ok('D2: …and another member\'s folder is untouched', JSON.stringify(objectsIn('crew2')) === JSON.stringify([`${V1}.jpg`]));
}

// ── E. remove ────────────────────────────────────────────────────────────────────────────
{
  const r = await call('crew2', 'remove', { userId: idOf('crew') });
  ok('E1: a cleaner can NOT remove a teammate\'s photo → 403', r.statusCode === 403 && objectsIn('crew').length === 2);
  const r2 = await call('crew', 'remove', {});
  ok('E2: removing your own photo empties your folder → 200 { ok: true }', r2.statusCode === 200 && r2.body?.ok === true && objectsIn('crew').length === 0);
  const r3 = await call('mgr', 'remove', { userId: idOf('crew2') });
  ok('E3: a manager with settings.team.edit removes another member\'s photo', r3.statusCode === 200 && objectsIn('crew2').length === 0);
}

// ── F. links ─────────────────────────────────────────────────────────────────────────────
{
  fake.reset(world({
    photos: { owner: V1, admin: V3 },
    objects: {
      [`${folderOf('owner')}${V1}.jpg`]: { bytes: JPG },
      [`${folderOf('owner')}${V2}.jpg`]: { bytes: JPG }, // a stray older object
    },
  }));
  const t0 = Date.now();
  const r = await call('crew', 'urls', { userIds: [idOf('owner'), idOf('crew'), idOf('admin'), 'u_notonteam'] });
  const urls = r.body?.urls || {};
  ok('F1: any staff login (a cleaner) may ask → 200', r.statusCode === 200);
  ok('F2: only a member with a photo AND a stored object is answered', JSON.stringify(Object.keys(urls).sort()) === JSON.stringify([idOf('owner')]));
  const e = urls[idOf('owner')];
  ok('F3: the answer carries the roster\'s current v and a signed link to THAT object',
    !!e && e.v === V1 && typeof e.url === 'string' && e.url.includes(`/_avatars/${idOf('owner')}/${V1}.jpg`) && e.url.includes('token='));
  const exp = Date.parse(e?.expiresAt || '');
  ok('F4: expiresAt is the link\'s lifetime from now (6 h)', Number.isFinite(exp) && Math.abs(exp - (t0 + TTL * 1000)) < 60 * 1000);
  ok('F5: the answer is private and never cached', /private/.test(String(r.headers['cache-control'])) && /no-store/.test(String(r.headers['cache-control'])));
  const signReq = fake.requests.filter((q) => /\/storage\/v1\/object\/sign\//.test(q.path));
  // The admin's roster row names V3, whose object is missing: asked for (the roster is the
  // source), answered with an error by Storage, and left out of F2's answer. The owner's stray
  // older object (V2) is never asked for, and nor is anyone without a photo.
  ok('F6: ONE batch signing call, for each member\'s CURRENT v only (never a stray object, never a member with no photo)',
    signReq.length === 1 && JSON.stringify([...(signReq[0].body?.paths || [])].sort()) === JSON.stringify([
      `${ORG}/_avatars/${idOf('admin')}/${V3}.jpg`, `${ORG}/_avatars/${idOf('owner')}/${V1}.jpg`,
    ].sort()));
  ok('F7: …at the link lifetime', signReq[0]?.body?.expiresIn === TTL);
}
{
  const many = Array.from({ length: URLS_MAX + 1 }, (_, i) => `u_x${i}`);
  const r = await call('crew', 'urls', { userIds: many });
  ok(`F8: more than ${URLS_MAX} ids → 400`, r.statusCode === 400);
  const r2 = await call('crew', 'urls', { userIds: [idOf('owner'), '../u_owner'] });
  ok('F9: a malformed id → 400', r2.statusCode === 400);
  const r3 = await call('crew', 'urls', { userIds: Array.from({ length: URLS_MAX }, (_, i) => (i === 0 ? idOf('owner') : `u_x${i}`)) });
  ok(`F10: exactly ${URLS_MAX} ids is fine`, r3.statusCode === 200 && !!r3.body?.urls?.[idOf('owner')]);
  const r4 = await call(null, 'urls', { userIds: [idOf('owner')] });
  ok('F11: no session → 401', r4.statusCode === 401);
}

console.warn = quiet.warn;
console.error = quiet.error;
globalThis.fetch = realFetch;
await fake.close();
ok('nothing left the machine', strays.length === 0);

console.log(`\ntest-avatar-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
