// A TEAM MEMBER'S PHOTO AS A CUSTOMER SEES IT (HUB-19; Matt's "Your Account Manager", 2026-11-02):
// the account manager's photo beside "Your Account Manager", and the cleaners' photos beside their
// names on Today's Visit and the checklists. ONE shape for every place a face reaches a customer,
// shared by the server (api/hub/[...path].js) and the login-free demo (lib/hubDemo.js), so the two
// can never answer differently.
//
// 🔴 THE VERSION, NEVER A LINK, A PATH OR AN ID. A member's photo is a private object filed under
// their member id (api/_lib/avatars.js, UI_RULES §141), and a signed link to it would carry that
// path, the id included — while the hub serves no cleaner's id at all. So an answer names a face
// only by HUB_FACE_FIELDS: the version of the person's CURRENT photo (`users[].photo.v`, a random
// 128-bit id the server minted, lib/userPhoto.js), and only for a person that answer already names
// (the building's manager, the cleaners it lists, a checklist's cleaner). The screen then asks the
// hub's own `GET /api/hub/face` for the image by that version (lib/clientHubApi fetchHubFace),
// signed in as the customer: no link, path or id ever reaches the page, and a replaced photo's
// version simply stops answering.
//
// PURE and node-safe (explicit .js imports, no browser globals): the server imports it.
import { isPhotoVersion, photoVersionOf } from './userPhoto.js';

export const HUB_FACE_FIELDS = Object.freeze(['v']);

// A roster row's face as a customer is served it: { v } of their current photo, or null (no photo,
// or a value that is not one). Nothing else of the row is read.
export function hubFaceOf(user) {
  const v = photoVersionOf(user);
  return v ? { v } : null;
}

// A face handed on (a projection re-reading another's output, or a caller's `photoOf`): exactly
// { v } when `v` is a version the server could have minted, else null.
export function projectHubFace(face) {
  return face && typeof face === 'object' && isPhotoVersion(face.v) ? { v: face.v } : null;
}

// "Carlos M." → "CM", "Cher" → "C": the letters under a face, from the PROJECTED name only (first
// name + last initial, lib/clientHub hubPersonName), so no surname ever reaches them.
export function hubInitials(name) {
  const parts = String(name ?? '').replace(/\./g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return `${first}${last}`.toUpperCase();
}
