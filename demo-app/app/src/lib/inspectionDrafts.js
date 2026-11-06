// An inspection LEFT OPEN AND FINISHED LATER — the pure rules, shared by the server
// (api/_lib/qc/store.js + api/qc/[...path].js), the demo stub (lib/qcApi.js) and the form
// (components/InspectionFill.jsx), so the three cannot answer the same question differently.
//
// Matt, on the 2026-10-06 call: "if I'm walking a site right now, and then I have to go look at
// another site, for whatever reason, I might leave that inspection open. So it would be great if
// we have the Save or Submit button, and when the Save or Submit button is hit … then it creates
// whatever work order it picked up from a failed inspection." Plan
// docs/plans/2026-10-11-oct-6-call-additions.md §3, decisions D7–D9:
//   D7  a draft saves AS YOU GO (ticks, N/A, ratings, comments, the office-only note), to the
//       server and to the device; "Save and finish later"; Continue / Discard on a draft; a new
//       inspection where you have one open offers to continue it.
//   D8  a draft NEVER scores, alerts, opens a ticket, emails a client, shows on the hub or the
//       public link, or counts in a report. All of that happens once, on Submit (unchanged).
//   D9  a draft untouched for 30 days is deleted at the write point, with its items and photos.
//
// Before this, `start()` created the record as a draft and the ticks lived ONLY in the form's
// memory until Submit, so closing the form lost every one of them (production, 2026-10-10: two
// drafts started with 0 items saved).
import { inspectionFillItems, countSchemaItems } from './inspections.js';

export const DRAFT_STATUS = 'draft';
// D9: a draft nobody has touched for this long is deleted (its items and photos with it).
export const DRAFT_RETENTION_DAYS = 30;
// …at most this many per sweep, so the sweep on `inspections/create` stays one cheap step.
export const DRAFT_RETENTION_SWEEP_MAX = 25;
// D7: the form saves this long after the last change (and at once on close / "Save and finish later").
export const DRAFT_SAVE_DEBOUNCE_MS = 1500;
// A failed save is tried again after this long (and the moment the connection comes back).
export const DRAFT_RETRY_MS = 10000;
// The caller's own open drafts, newest first — the "Continue the one you started" prompt.
export const DRAFT_LIST_MAX = 50;
// A save-draft body never carries more items than this (a template has tens).
export const MAX_DRAFT_ITEMS = 1000;
// One item's comment, trimmed and capped (the client reads it on the report once submitted).
export const MAX_DRAFT_ITEM_COMMENT_LEN = 2000;

// The refusal codes the routes answer with and the stub throws, so the form can tell them apart.
export const DRAFT_CODES = Object.freeze({
  notADraft: 'not-a-draft',       // 409: submitted (or no longer open) — nothing was written
  notYours: 'not-your-draft',     // 403: another inspector's draft
});

// ── WHO may continue, save, submit or discard a draft ────────────────────────
// The inspector who started it, or the office (owner / admin). A manager cannot continue another
// manager's draft. `role` and `userId` come from the LOGIN's claim on the server (never a body),
// and from the signed-in user on the screen, which mirrors it (THE LAW II.11). A missing role or
// id never passes (fail closed).
export const DRAFT_OFFICE_ROLES = Object.freeze(['owner', 'admin']);
export function mayWorkDraft({ role = null, userId = null } = {}, rec) {
  if (!rec) return false;
  if (userId && rec.inspector_user_id && rec.inspector_user_id === userId) return true;
  return DRAFT_OFFICE_ROLES.includes(role);
}

// ── What a draft stores, and the answers it reopens as ───────────────────────
// The form's answers from stored items: `{ [itemKey]: { ticked?, na?, rating?, comment? } }`.
// Only keys the frozen schema names are read (first one wins), so a body can never invent an
// item; the same reading turns a draft's saved rows back into the form's state on Continue.
function schemaItemIds(snapshot) {
  const ids = new Set();
  for (const area of snapshot?.schema?.areas || []) {
    for (const it of area?.items || []) if (it && typeof it.id === 'string' && it.id) ids.add(it.id);
  }
  return ids;
}
export function answersFromItems(snapshot, items) {
  const numeric = snapshot?.rating_scale?.type === 'numeric';
  const known = schemaItemIds(snapshot);
  const answers = {};
  for (const it of (Array.isArray(items) ? items : []).slice(0, MAX_DRAFT_ITEMS)) {
    const key = typeof it?.item_key === 'string' ? it.item_key : null;
    if (!key || !known.has(key) || answers[key]) continue;
    const a = {};
    const r = it.rating;
    if (r === 'na') a.na = true;
    else if (numeric) {
      const n = Number(r);
      if (r != null && r !== '' && Number.isInteger(n)) a.rating = n;
    } else if (String(r) === 'pass') a.ticked = true;
    if (typeof it.comment === 'string' && it.comment.trim()) a.comment = it.comment.trim().slice(0, MAX_DRAFT_ITEM_COMMENT_LEN);
    answers[key] = a;
  }
  return answers;
}

// What a draft STORES: the touched items only, unticked = no rating yet (lib/inspections
// inspectionFillItems `{ draft: true }` — the ONE builder Submit also uses).
export function draftItemsFromAnswers(snapshot, answers = {}) {
  return inspectionFillItems(snapshot, answers, { draft: true });
}

// The server's half: a save-draft body's items rebuilt against the record's OWN frozen schema —
// the labels are the schema's, a rating is held to the scale (and N/A to the items that allow
// it), an unknown key is dropped. The caller's text is never stored as a label.
export function sanitizeDraftItems(snapshot, items) {
  return draftItemsFromAnswers(snapshot, answersFromItems(snapshot, items));
}

// "6 of 13 answered": how many of the frozen schema's items carry an answer (ticked, N/A or a
// rating) — a comment alone is not an answer.
export function draftProgress(snapshot, items) {
  const known = schemaItemIds(snapshot);
  const answered = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !known.has(it.item_key)) continue;
    if (it.rating != null && it.rating !== '' && it.rating !== 'fail') answered.add(it.item_key);
  }
  return { answered: answered.size, total: countSchemaItems(snapshot?.schema) };
}

// ── The date an inspection carries (CS-699) ──────────────────────────────────────────────
// A draft's `performed_at` is when it was STARTED (its list row's "Started …"). The FIRST Submit
// dates the inspection NOW, the moment it was finished — the list's order, the failed ticket's
// title, the report, the hub's list, the Reports window, the inspection-due reminder and the
// ticket's week of cleans all read this date — and an edit of an inspection already submitted
// keeps its date. The start stays in `created_at`. A draft begun Oct 9 and submitted Oct 12 was
// filed under Oct 9, below newer ones, its ticket titled "Failed inspection Oct 9".
export function submittedPerformedAt(rec, nowIso = new Date().toISOString()) {
  if (!rec || rec.status === DRAFT_STATUS || !rec.performed_at) return nowIso;
  return rec.performed_at;
}

// ── D9: retention ───────────────────────────────────────────────────────────
// A draft is stale once its last save (`updated_at`, else when it was started) is older than
// DRAFT_RETENTION_DAYS. Anything that is not a draft is never stale here.
export function draftStaleBeforeIso(now = Date.now()) {
  return new Date(now - DRAFT_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
}
export function isStaleDraft(rec, now = Date.now()) {
  if (!rec || rec.status !== DRAFT_STATUS) return false;
  const t = Date.parse(rec.updated_at || rec.performed_at || rec.created_at || '');
  return Number.isFinite(t) && t < Date.parse(draftStaleBeforeIso(now));
}

// ── The device copy (D7: "survives a lost signal") ───────────────────────────
// Every change is written to this device at once, keyed by the record's id:
//   { savedAt   — when this device last changed it (device clock),
//     serverAt  — the server's `updated_at` this device last saw (its last good save or the load),
//     dirty     — this device holds changes the server has not acknowledged,
//     answers, internalNote }
// A clean copy is cleared (the server has it all), so only unsent work is kept on the phone.
export const DRAFT_DEVICE_PREFIX = 'cleanspace_inspection_draft_v1:';
export const draftDeviceKey = (id) => `${DRAFT_DEVICE_PREFIX}${id}`;
const storageOf = (s) => (s !== undefined ? s : (typeof localStorage !== 'undefined' ? localStorage : null));
export function readDraftDevice(id, storage) {
  try {
    const raw = storageOf(storage)?.getItem(draftDeviceKey(id));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && v.answers && typeof v.answers === 'object' ? v : null;
  } catch { return null; }
}
export function writeDraftDevice(id, copy, storage) {
  try { storageOf(storage)?.setItem(draftDeviceKey(id), JSON.stringify(copy)); return true; } catch { return false; }
}
export function clearDraftDevice(id, storage) {
  try { storageOf(storage)?.removeItem(draftDeviceKey(id)); } catch { /* storage unavailable */ }
}

// On open, the newer of the server's draft and the device's copy wins (D7). A device copy that
// holds nothing unsent never wins (the server has it all, and may be newer from another phone).
// One that does wins when the server has not moved since this device last saw it — compared on
// the SERVER's own clock, so a phone whose clock is off cannot lose its work — and otherwise by
// timestamp. → 'device' | 'server'.
export function pickDraftSource({ serverUpdatedAt = null, device = null } = {}) {
  if (!device || device.dirty !== true) return 'server';
  const server = Date.parse(serverUpdatedAt || '');
  if (!Number.isFinite(server)) return 'device';
  const seen = Date.parse(device.serverAt || '');
  if (Number.isFinite(seen) && server <= seen) return 'device';
  const mine = Date.parse(device.savedAt || '');
  return Number.isFinite(mine) && mine > server ? 'device' : 'server';
}

// The caller's open draft at a building, newest saved first (the "Continue the one you started"
// prompt), or null.
export function draftAtSite(drafts, siteId) {
  if (!siteId) return null;
  const at = (Array.isArray(drafts) ? drafts : []).filter((d) => d && d.status === DRAFT_STATUS && d.site_id === siteId);
  at.sort((a, b) => Date.parse(b.updated_at || b.performed_at || 0) - Date.parse(a.updated_at || a.performed_at || 0));
  return at[0] || null;
}
