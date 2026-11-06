// Team PROFILE PHOTOS (UI_RULES §141): the bytes in Storage, the record a version id on the
// member's roster row. Library: api/_lib/avatars.js. Client: src/lib/avatarApi.js.
//
//   POST /api/avatars/upload  { dataUrl, userId? } → { v }                      (EP-282)
//   POST /api/avatars/remove  { userId? }          → { ok: true }               (EP-283)
//   POST /api/avatars/urls    { userIds: [...] }   → { urls: { [id]: { v, url, expiresAt } } }  (EP-284)
//
// AUTH STANCE: requireAuthority — every STAFF login (a customer-hub login is refused inside it,
// a disabled member too), then per action:
//   · upload / remove: yourself always (every person owns their photo, so no key); ANOTHER
//     member only with `settings.team.edit` (the Team page's key — owner, admin and manager by
//     default — read claims-first from the COMMITTED matrix + overrides, failing closed), and
//     the member must be on the committed roster. Decided by `avatarTargetDecision` (pure).
//   · urls: any staff login, crew included (crew see their coworkers' and supervisors' faces),
//     for ≤ PHOTO_URLS_MAX ids; signed only for the roster's CURRENT `v`.
// A photo grants no authority, so the shared record's field (`users[].photo`) rides outside
// orgStateGuard's fingerprint, like a member's name: the boundary that matters is HERE — with no
// upload there is no object for a `v` to point at, and every path is built from (userId, v).
//
// ⚠️ NO PATH IS EVER ACCEPTED FROM THE BODY. A caller names at most a member id, which must be
// one safe segment before anything is concatenated (AUTHORIZATION_AUDIT #5).
//
// The upload does NOT write the shared record: the device dispatches SET_USER_PHOTO with the
// returned `v` through the normal guarded save, so an offline-queued or refused save never
// leaves the record pointing at nothing. Retention runs here instead (THE LAW II.8): after a
// store, the member's folder keeps only the new object and the one the committed row names; the
// daily reap clears what a save that never came leaves behind.
import { requireAuthority, holdsPermission, readRosterUsers } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { allow } from '../_lib/rateLimit.js';
import {
  validateAvatarUpload, avatarTargetDecision, avatarUrlRequests, putAvatar, pruneAvatars,
  removeAvatarFolder, signAvatarUrls,
} from '../_lib/avatars.js';
import { PHOTO_URLS_MAX } from '../../src/lib/userPhoto.js';

// A 320 px JPEG is about 20 KB (≈27 KB as base64); the cap is 200 KB decoded. 1 MB keeps a
// readable error ahead of the platform's opaque 413.
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// Who sets someone ELSE's photo: the Team page's own key.
export const AVATAR_OTHERS_PERMISSION = 'settings.team.edit';

// An office member setting up a team may do a few dozen in a sitting; nobody needs more.
const UPLOAD_RATE = { limit: 60, windowMs: 10 * 60 * 1000 };

export default function handler(req, res) {
  return withRequestCache(() => avatarsHandler(req, res));
}

async function avatarsHandler(req, res) {
  // A signed link is a bearer token for a private object: never in a shared cache.
  res.setHeader('Cache-Control', 'private, no-store');
  const path = (typeof req.query?.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query?.path) ? req.query.path
      : (req.query?.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  if (!['upload', 'remove', 'urls'].includes(action) || path.length !== 1) {
    return res.status(404).json({ error: 'Unknown route.', code: 'not-found' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'method' });

  const a = await requireAuthority(req, res);
  if (!a) return undefined; // 401 / 403 already written
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  let roster;
  try {
    roster = await readRosterUsers();
  } catch (e) {
    console.error('[avatars] roster unreadable:', e?.message || e);
    return res.status(503).json({ error: 'The team could not be read just now. Try again.', code: 'roster-unreadable' });
  }

  try {
    if (action === 'urls') {
      const requests = avatarUrlRequests({ roster, userIds: body.userIds });
      if (requests === undefined) {
        return res.status(400).json({ error: `Ask for at most ${PHOTO_URLS_MAX} team members by id.`, code: 'bad-request' });
      }
      return res.status(200).json({ urls: await signAvatarUrls(requests) });
    }

    // upload / remove: whose photo?
    const named = body.userId !== undefined && body.userId !== null && body.userId !== '';
    const holdsTeamEdit = named && body.userId !== a.orgUserId
      ? await holdsPermission(a, AVATAR_OTHERS_PERMISSION) // fails closed on an unreadable matrix
      : false;
    const who = avatarTargetDecision({ callerId: a.orgUserId, requestedUserId: body.userId, roster, holdsTeamEdit });
    if (!who.ok) return res.status(who.status).json({ error: who.error, code: who.code });

    if (action === 'remove') {
      await removeAvatarFolder(who.userId);
      return res.status(200).json({ ok: true });
    }

    if (!allow(req, res, { bucket: 'avatar-upload', id: a.orgUserId, ...UPLOAD_RATE, code: 'rate-limited' })) return undefined;
    const photo = validateAvatarUpload(body.dataUrl);
    if (!photo.ok) return res.status(400).json({ error: photo.error, code: 'bad-photo' });
    const v = await putAvatar(who.userId, photo);
    try {
      await pruneAvatars(who.userId, [v, who.committedV]);
    } catch (e) {
      // The photo is stored and the answer is right; an old object left behind is the daily
      // reap's to clear. Never fail an upload the person can see succeeded.
      console.error('[avatars] retention after upload failed:', e?.message || e);
    }
    return res.status(200).json({ v });
  } catch (e) {
    console.error(`[avatars] ${action} failed:`, e?.message || e);
    const error = action === 'urls' ? 'Team photos could not be loaded just now.'
      : action === 'remove' ? 'The photo could not be removed just now. Try again.'
        : 'The photo could not be saved just now. Try again.';
    return res.status(502).json({ error, code: 'storage-failed' });
  }
}
