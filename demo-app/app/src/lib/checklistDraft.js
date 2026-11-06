// The cleaner's checklist, saved ON THE PHONE as they go (UI_RULES §154, §166; Brief B of the
// Cleaner Hub, docs/plans/2026-10-13-cleaner-hub.md).
//
// WHY. The checklist page (pages/crew/CrewChecklist) is filled over a whole clean — a tick
// here, a photo there, a "not completed" when the closet is locked — and saved to the server
// ONCE, at the end ("Save checklist"). Between the first tick and that Save the phone is the
// only place the work exists, so every change is written here at once: a reload, a dead
// battery or a lost signal loses nothing, and the page reopens where the cleaner left it.
//
// ONE DRAFT PER (clean, checklist, cleaner), each under its own localStorage key
//     cleanspace_crew_checklist_draft_v1:<jobId>:<templateId>:<userId>
// holding { submissionId, checks, photos, schema?, name?, savedAt }:
//   submissionId  minted when the draft is born and NEVER changed: it is the submission's
//                 idempotency key (`clientSubmitId`) AND the `ref_id` every photo of this fill
//                 is filed under (CS-547 — one id, so a photo can never prove a different
//                 submission than the one it unlocked);
//   checks        { [itemKey]: { checked?, na?, notCompleted?, reason?, note?, at? } }
//   photos        { [itemKey]: how many photos this phone has put on it (uploaded or queued) }
//   schema, name  the published checklist as it was loaded, so the page reopens offline.
//
// RETENTION AT THE WRITE POINT (THE LAW II.8): every write drops drafts past the age ceiling
// (CHECKLIST_DRAFT_MAX_AGE_MS) and keeps at most CHECKLIST_DRAFT_MAX, newest first. A draft
// is cleared when its checklist is saved, and EVERY draft is cleared on sign-out (beside the
// gate memo in auth/AuthProvider): on a shared phone a draft names who did what.
// Every read and write is guarded: storage that throws (private mode, quota, a locked-down
// phone) degrades to "nothing saved", never to a crash.
//
// Pure except for the injected `store` (localStorage by default), so the whole rule runs in a
// node suite (scripts/test-checklist-not-completed.mjs). Node-safe imports only.
import { DAY_MS } from './retention.js';
import { newChecklistId } from './checklistQueue.js';
import { english } from '../i18n/core.js';

export const CHECKLIST_DRAFT_PREFIX = 'cleanspace_crew_checklist_draft_v1';
export const CHECKLIST_DRAFT_MAX = 30;
export const CHECKLIST_DRAFT_MAX_AGE_MS = 3 * DAY_MS;

const defaultStore = () => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};
const pick = (store) => (store === undefined ? defaultStore() : store);
const isDraftKey = (k) => typeof k === 'string' && k.startsWith(`${CHECKLIST_DRAFT_PREFIX}:`);

export function checklistDraftKey({ jobId = null, templateId = null, userId = null } = {}) {
  return `${CHECKLIST_DRAFT_PREFIX}:${jobId || ''}:${templateId || ''}:${userId || ''}`;
}

// A fresh draft, its submission id minted now.
export function newChecklistDraft() {
  return { submissionId: newChecklistId(), checks: {}, photos: {}, savedAt: null };
}

function parse(raw) {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || typeof d.submissionId !== 'string' || !d.submissionId) return null;
    return {
      ...d,
      checks: d.checks && typeof d.checks === 'object' ? d.checks : {},
      photos: d.photos && typeof d.photos === 'object' ? d.photos : {},
    };
  } catch { return null; }
}

const expired = (d, now) => {
  const t = Date.parse(d?.savedAt);
  return Number.isFinite(t) && t < now - CHECKLIST_DRAFT_MAX_AGE_MS;
};

// Every draft key this phone holds. Reads the store's own index; a store that refuses to be
// listed yields none (and retention then simply has nothing to prune).
function draftKeys(s) {
  const out = [];
  try {
    const n = s.length;
    for (let i = 0; i < n; i += 1) {
      const k = s.key(i);
      if (isDraftKey(k)) out.push(k);
    }
  } catch { /* a store that cannot be listed */ }
  return out;
}

// The draft for this clean, checklist and cleaner, or null (none, unreadable, or past the age
// ceiling).
export function readChecklistDraft(id, { store, now = Date.now() } = {}) {
  const s = pick(store);
  if (!s) return null;
  let raw = null;
  try { raw = s.getItem(checklistDraftKey(id)); } catch { return null; }
  const d = parse(raw);
  if (!d || expired(d, now)) return null;
  return d;
}

// Drop the drafts past the age ceiling, then the oldest past the cap. `keep` is the key being
// written, never dropped here.
function prune(s, now, keep) {
  const rows = [];
  for (const k of draftKeys(s)) {
    if (k === keep) continue;
    let d = null;
    try { d = parse(s.getItem(k)); } catch { d = null; }
    if (!d || expired(d, now)) { try { s.removeItem(k); } catch { /* ignore */ } continue; }
    rows.push({ k, t: Date.parse(d.savedAt) || 0 });
  }
  rows.sort((a, b) => b.t - a.t);
  for (const r of rows.slice(Math.max(0, CHECKLIST_DRAFT_MAX - 1))) {
    try { s.removeItem(r.k); } catch { /* ignore */ }
  }
}

// Remember a draft. Returns true when it was written, false when the phone refused.
export function writeChecklistDraft(id, draft, { store, now = Date.now() } = {}) {
  const s = pick(store);
  if (!s || !draft || typeof draft.submissionId !== 'string' || !draft.submissionId) return false;
  const key = checklistDraftKey(id);
  try {
    prune(s, now, key);
    s.setItem(key, JSON.stringify({ ...draft, savedAt: new Date(now).toISOString() }));
    return true;
  } catch { return false; }
}

export function clearChecklistDraft(id, { store } = {}) {
  const s = pick(store);
  if (!s) return;
  try { s.removeItem(checklistDraftKey(id)); } catch { /* nothing to clear */ }
}

// Sign-out on a shared phone: every draft names who did what.
export function clearAllChecklistDrafts({ store } = {}) {
  const s = pick(store);
  if (!s) return;
  for (const k of draftKeys(s)) { try { s.removeItem(k); } catch { /* ignore */ } }
}

// The item list a draft POSTS: one entry per schema task, in schema order — exactly the shape
// the server counts (lib/checklistCount) and stores. `label` is the OFFICE's English, always
// (the record is read in the office; the count never reads a label). `completedAt` is when the
// tick or N/A was MADE (QR-1, an area's finish time); a "not completed" task carries its flag
// and reason instead, and is never a finish time (lib/checklistAreas).
export function draftItems(schema, draft) {
  const checks = draft?.checks || {};
  const out = [];
  for (const area of Array.isArray(schema?.areas) ? schema.areas : []) {
    for (const it of Array.isArray(area?.items) ? area.items : []) {
      if (!it || !it.id) continue;
      const c = checks[it.id] || {};
      const checked = !!c.checked;
      const na = !checked && !!c.na;
      const notCompleted = !checked && !na && !!c.notCompleted;
      out.push({
        key: it.id,
        label: `${area.label || english('checklist.fill.areaFallback')}. ${it.label || english('checklist.fill.itemFallback')}`,
        checked,
        na,
        note: (typeof c.note === 'string' && c.note.trim()) ? c.note.trim() : null,
        completedAt: (checked || na) ? (c.at || null) : null,
        notCompleted,
        notCompletedReason: notCompleted ? (c.reason || null) : null,
      });
    }
  }
  return out;
}

// The item keys this draft has a photo on — what the page counts by (the server re-counts the
// rows that actually landed).
export function draftPhotoKeys(draft) {
  const photos = draft?.photos || {};
  return Object.keys(photos).filter((k) => Number(photos[k]) > 0);
}

// Send the draft as ONE checklist submission, under the id it minted first, then clear it.
// Returns what the API answered (a row, or `{ pending_sync }` when the phone kept it for later —
// qcApi queues an offline submission), or null when there is no draft to send. A failed send
// THROWS and keeps the draft, so nothing is lost and the next try sends the same id.
// `submit` defaults to qcApi.submitChecklist (loaded only when called, so this module stays
// node-safe); the integration pass's "Save checklist & clock out" calls it with a partial
// draft for a cleaner whose lock is off.
//
// `draft` (optional) is the caller's own copy — the page passes what is on screen, so a phone
// that refused to store the draft still sends exactly what the cleaner did.
export async function submitChecklistDraft({ job, templateId, userId, schema, store, submit = null, draft: given = null } = {}) {
  if (!job?.id || !templateId) return null;
  const id = { jobId: job.id, templateId, userId };
  const draft = (given && typeof given.submissionId === 'string' && given.submissionId) ? given : readChecklistDraft(id, { store });
  if (!draft) return null;
  const send = submit || (await import('./qcApi.js')).submitChecklist;
  const res = await send({
    templateId,
    siteId: job.siteId || null,
    clientId: job.clientId || null,
    jobId: job.id,
    items: draftItems(schema || draft.schema, draft),
    completedByUserId: userId || null,
    clientSubmitId: draft.submissionId,
  });
  clearChecklistDraft(id, { store });
  return res ?? null;
}
