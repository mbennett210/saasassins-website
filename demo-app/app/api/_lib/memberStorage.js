// A member's IMAGES in Storage after they leave (UI_RULES §141; also CS-627) — the two cleanup
// halves of the team photos and the signature images, both in the private `ops-media` bucket:
//
//   · deleteMemberStorage(ids): called by the member-removal route (/api/settings/users/delete →
//     _lib/users.js deleteUserAccount) once the login is gone. Their photo folder
//     `<org>/_avatars/<id>/` AND their signature `<org>/_signatures/<id>.*` go: a removed
//     member's signature image was never deleted before (CS-627).
//   · sweepMemberStorage({ users }): the daily reap's bounded step (api/cron/reap.js) for what a
//     removal could not clean, a raw roster save that dropped a row, or an upload whose
//     SET_USER_PHOTO save never came.
//
// Paths are BUILT here (avatars.js builds the photo ones), never taken from a caller; an id that
// is not one safe segment is skipped.
import { getSupabase } from './supabase.js';
import { CLEANSPACE_ORG_ID } from './constants.js';
import { isSafeSegment, isValidStoragePath } from './storagePaths.js';
import { SIGNATURE_BUCKET, SIGNATURE_EXTS } from './signatureUpload.js';
import {
  AVATAR_FOLDER, listLevel, listAvatarObjects, removeAvatarNames, removeAvatarFolder,
} from './avatars.js';
import { photoVersionOf } from '../../src/lib/userPhoto.js';

const SIGNATURE_FOLDER = '_signatures';
const DAY_MS = 24 * 60 * 60 * 1000;
const bucket = () => getSupabase().storage.from(SIGNATURE_BUCKET);

/**
 * A REMOVED member's images: their photo folder and their signature image. Best-effort per id:
 * a Storage failure is logged and counted, never thrown — the login is already gone by the time
 * this runs, so the removal must not look failed; the daily sweep picks up what is left.
 * → { avatars, signatures, failed }
 */
export async function deleteMemberStorage(userIds) {
  const out = { avatars: 0, signatures: 0, failed: 0 };
  const ids = [...new Set((userIds || []).filter(isSafeSegment))];
  for (const id of ids) {
    try {
      out.avatars += await removeAvatarFolder(id);
    } catch (e) {
      out.failed += 1;
      console.error(`[memberStorage] removed member ${id}: photo cleanup failed: ${e?.message || e}`);
    }
    try {
      // Storage deletes exact names and ignores missing ones, so the closed extension set is the
      // whole of this id's signature — no list needed.
      const { data, error } = await bucket().remove(SIGNATURE_EXTS.map((ext) => `${CLEANSPACE_ORG_ID}/${SIGNATURE_FOLDER}/${id}.${ext}`));
      if (error) throw new Error(error.message);
      out.signatures += Array.isArray(data) ? data.length : 0;
    } catch (e) {
      out.failed += 1;
      console.error(`[memberStorage] removed member ${id}: signature cleanup failed: ${e?.message || e}`);
    }
  }
  return out;
}

// The daily sweep's bounds: pages of names read per folder level, member folders opened, objects
// deleted. 30 pages × 100 = 3,000 folder names, twice the 1,500 cleaners planned for.
export const SWEEP_LIMITS = Object.freeze({ folderPages: 30, foldersOpened: 200, removals: 500 });

/**
 * The reap cron's step: images that outlived their reason. BOUNDED and idempotent (tomorrow's run
 * continues where this one stopped):
 *   · `_avatars/<id>/` whose id is NOT on the roster → every object in it;
 *   · on-roster folders, a slice that rotates by the day → objects whose version is not the
 *     roster's current one AND that are older than a day (a younger one may be an upload whose
 *     save is still on its way);
 *   · `_signatures/<id>.*` whose id is not on the roster.
 * An absent or empty roster sweeps NOTHING: an unreadable roster must never read as "nobody is on
 * the team". → { skipped, foldersSeen, orphanFolders, foldersOpened, avatarsRemoved,
 *   signaturesRemoved, more }
 */
export async function sweepMemberStorage({ users, now = Date.now(), limits = SWEEP_LIMITS } = {}) {
  const out = { skipped: null, foldersSeen: 0, orphanFolders: 0, foldersOpened: 0, avatarsRemoved: 0, signaturesRemoved: 0, more: false };
  const roster = Array.isArray(users) ? users.filter((u) => u && typeof u.id === 'string' && u.id) : [];
  if (!roster.length) { out.skipped = 'no-roster'; return out; }
  const current = new Map(roster.map((u) => [u.id, photoVersionOf(u)]));
  let budget = limits.removals;

  // ── photo folders ──
  const level = await listLevel(`${CLEANSPACE_ORG_ID}/${AVATAR_FOLDER}`, limits.folderPages);
  if (level.more) out.more = true;
  const folders = level.entries.filter((e) => e && e.id === null && isSafeSegment(e.name)).map((e) => e.name);
  out.foldersSeen = folders.length;
  const orphans = folders.filter((id) => !current.has(id));
  const onRoster = folders.filter((id) => current.has(id));
  out.orphanFolders = orphans.length;
  const orphanSlice = orphans.slice(0, limits.foldersOpened);
  if (orphans.length > orphanSlice.length) out.more = true;
  // What is left of the folder budget goes to a slice of the roster's folders that moves on by
  // a slice each day, so every folder is looked at within (folders / slice) days.
  const sliceSize = Math.max(0, limits.foldersOpened - orphanSlice.length);
  const day = Math.floor(now / DAY_MS);
  const start = onRoster.length && sliceSize ? (day * sliceSize) % onRoster.length : 0;
  const rotating = onRoster.length <= sliceSize ? onRoster
    : [...onRoster.slice(start), ...onRoster.slice(0, start)].slice(0, sliceSize);
  for (const id of [...orphanSlice, ...rotating]) {
    if (budget <= 0) { out.more = true; break; }
    out.foldersOpened += 1;
    const keep = current.has(id) ? current.get(id) : null;
    const stale = (await listAvatarObjects(id)).filter((o) => {
      if (!current.has(id)) return true;                 // off the team: all of it
      if (o.v && o.v === keep) return false;             // the photo they show
      const t = Date.parse(o.createdAt || '');
      return Number.isFinite(t) && now - t > DAY_MS;     // an old version, or junk
    }).map((o) => o.name);
    if (stale.length > budget) out.more = true;
    const take = stale.slice(0, budget);
    if (take.length) {
      out.avatarsRemoved += await removeAvatarNames(id, take);
      budget -= take.length;
    }
  }

  // ── signature images ──
  if (budget <= 0) { out.more = true; return out; }
  const sigs = await listLevel(`${CLEANSPACE_ORG_ID}/${SIGNATURE_FOLDER}`, limits.folderPages);
  if (sigs.more) out.more = true;
  const gone = sigs.entries
    .filter((e) => e && e.id !== null && typeof e.name === 'string')
    .map((e) => ({ name: e.name, id: e.name.replace(/\.[a-z]+$/, '') }))
    .filter((e) => isSafeSegment(e.id) && !current.has(e.id))
    .map((e) => `${CLEANSPACE_ORG_ID}/${SIGNATURE_FOLDER}/${e.name}`)
    .filter(isValidStoragePath);
  if (gone.length > budget) out.more = true;
  const take = gone.slice(0, budget);
  if (take.length) {
    const { data, error } = await bucket().remove(take);
    if (error) throw new Error(`signature sweep failed: ${error.message}`);
    out.signaturesRemoved += Array.isArray(data) ? data.length : 0;
  }
  return out;
}
