// WHOSE data a Cleaner Hub read serves (plan docs/plans/2026-10-13-cleaner-hub.md §3 D8). The
// cleaner's screens are SELF-SCOPED by the login's claim: a crew login always reads itself,
// whatever it sends. The owner's "View as" a cleaner (hooks/useCrewPreview) draws that person's
// screens while the server still sees the owner, so such a read names the person (`?userId=`) —
// and that is honoured ONLY for an OFFICE login holding the screen's office key (My Hours:
// `time.view`; Client Requests: `problems.manage`), the key that already lets them read that
// person's data on the office's own screens. An office login without it is refused (403), never
// quietly answered with its own data under someone else's name.
//
// → { userId, preview } | { status, error, code } (the route writes that answer).
import { OFFICE_ROLES, holdsPermission } from './authz.js';
import { idParam } from './queryParams.js';

export const CREW_PREVIEW_FORBIDDEN = 'preview-forbidden';

export async function crewReadSubject(authority, rawUserId, officeKey) {
  const self = authority?.orgUserId || null;
  const asked = idParam(rawUserId);
  if (asked === undefined) return { status: 400, error: 'userId is malformed', code: 'bad-user-id' };
  // Nobody named, or themselves: their own data.
  if (!asked || asked === self) return { userId: self, preview: false };
  // 🔴 Crew are always themselves (so is a login whose role the server could not resolve).
  if (!authority?.role || !OFFICE_ROLES.includes(authority.role)) return { userId: self, preview: false };
  if (!(await holdsPermission(authority, officeKey))) {
    return { status: 403, error: 'You can’t view this person’s screen.', code: CREW_PREVIEW_FORBIDDEN };
  }
  return { userId: asked, preview: true };
}
