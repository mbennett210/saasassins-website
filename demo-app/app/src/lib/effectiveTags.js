// Company-level tag resolution, shared by the CRM hub + detail pages.
//
// Tags are company-level: a person inherits their COMPANY's tags; a company-less
// contact carries its own. Kept here (a pure read) rather than in the big
// store/selectors.js so the CRM sync needs no edit to that shared file.
import { selectClientById } from '../store/selectors';

export function selectEffectiveTagIdsForContact(state, contact) {
  if (!contact) return [];
  if (contact.companyId) return selectClientById(state, contact.companyId)?.tagIds || [];
  return contact.tagIds || [];
}

// Add a tag to a CLIENT (company) via an UPDATE_CLIENT read-modify-write — the
// demo has no dedicated TAG_CLIENT action. `dispatch` + `ACTIONS` are passed in
// so this stays a pure helper with no store import cycle.
export function applyClientTag(dispatch, ACTIONS, client, tagId) {
  if (!client) return;
  const merged = [...new Set([...(client.tagIds || []), tagId])];
  dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch: { tagIds: merged } });
}

export function removeClientTag(dispatch, ACTIONS, client, tagId) {
  if (!client) return;
  const next = (client.tagIds || []).filter((t) => t !== tagId);
  dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch: { tagIds: next } });
}
