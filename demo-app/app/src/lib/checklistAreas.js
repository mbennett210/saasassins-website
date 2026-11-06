// QR-1 / HUB-15 — WHEN each AREA of a building was last cleaned, what was done in it, and
// the newest photo of it. PURE / node-safe, so the server read, the demo stub and the
// Round-2 public QR page all answer from one rule.
//
// 🔴 WHY TWO KINDS OF "AREA", AND HOW THEY MEET.
//   · `site.cleaningAreas[]` — the BUILDING's physical areas ("First floor", "Restrooms",
//     "Garbage area"), edited on the location (components/CleaningAreasEditor). This is
//     where a QR code is stuck to a wall, and it is what a scan has to answer about.
//   · `template_snapshot.schema.areas[]` — the CHECKLIST's sections, frozen at submit.
// They are different lists written at different times, so they are joined by an EXPLICIT
// link the office makes once, never by matching labels: a checklist section carries
// `siteAreaId`, chosen in the template editor from that customer's own cleaning areas. A
// section with no link simply answers for no QR code — which is honest, and visible in the
// editor — where a fuzzy label match would quietly tell a client that the restrooms were
// cleaned because someone typed "Restroom " with a trailing space.
//
// 🔴 THE TIME IS THE CLEANER'S OWN STAMP, CLAMPED. Matt: an area counts as cleaned "when
// the cleaner completes that area's part of the checklist", so the only clock that can
// answer is the phone that was in the building. A device clock can be wrong, so every
// stamp is held inside [submit - MAX_ITEM_AGE_MS, submit] and anything outside falls back
// to the submission's own instant — which the server stamps. That makes a wrong phone
// clock show the clean as finishing when it was filed, never tomorrow and never last year.
//
// 🔴 AN AREA IS "CLEANED" ONLY WHEN EVERY ITEM IN IT IS DONE. A half-finished section has
// NO entry rather than a time, because "last cleaned 9:40pm" on a wall that nobody touched
// is the one wrong answer a QR code must never give. "Done" is `lib/checklistCount`'s
// definition — ticked (with its photo, where the office requires one) or marked N/A where
// the office allowed it — read through `projectChecklistResult` (`isCleanedState`) so this
// module holds no second copy of it. A task the cleaner marked NOT COMPLETED (Matt,
// 2026-10-13) counts toward their clock-out but was NOT cleaned, so an area holding one
// records no time (D2 of docs/plans/2026-10-13-cleaner-hub.md).
import { projectChecklistResult, isCleanedState } from './checklistResultView.js';

// How far before the submission an item stamp may claim to be. A clean runs for hours and
// a cleaner may fill a checklist well after starting; a day is generous for the longest
// shift and still catches a phone whose clock is a year out.
export const MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// One item stamp, held inside the submission's own window. Returns a millisecond instant.
// `performedMs` is the fallback AND the ceiling, so nothing this returns is ever in the
// future of the row it is stored on.
function clampStamp(raw, performedMs) {
  const t = ms(raw);
  if (t == null) return performedMs;
  if (t > performedMs) return performedMs;
  if (t < performedMs - MAX_ITEM_AGE_MS) return performedMs;
  return t;
}

// { "<schema area id>": "<ISO instant>" } for the areas of THIS submission that are fully
// done — what `checklist_results.area_completions` stores.
//
//   schema      the PUBLISHED schema the submission is counted against
//   items       the submission, each entry optionally carrying `completedAt`
//   performedAt the submission's own instant (the server's `nowIso()`)
//   photoKeys   which item keys actually have a photo (CS-547) — read, never claimed
//
// An area's time is the LATEST stamp among its items, because the area finished when its
// last item did. An item with no usable stamp contributes the submission's instant, so a
// fill from a device that never stamped (an older build replaying from its queue) still
// records a time rather than silently dropping the area.
export function areaCompletionTimes(schema, items, { performedAt = null, photoKeys = null } = {}) {
  const performedMs = ms(performedAt) ?? Date.now();
  // One row-shaped object is all `projectChecklistResult` needs, and using it means the
  // "is this item done" question is asked of the SAME rule the stored counts came from.
  // Deliberately NO stored counts on it: this module reads per-item STATE and nothing
  // else, and spelling the two count columns out anywhere but `lib/checklistCount` is
  // exactly the second-copy-of-the-rule shape CS-494's enumeration keeps out.
  const view = projectChecklistResult({ template_snapshot: { schema }, items }, { photoKeys });
  if (!view.hasSchema) return {};
  const stampBy = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const key = str(it?.key) || str(it?.item_key);
    if (!key) continue;
    const at = clampStamp(it?.completedAt ?? it?.completed_at, performedMs);
    const prev = stampBy.get(key);
    if (prev == null || at > prev) stampBy.set(key, at);
  }
  const out = {};
  for (const area of view.areas) {
    if (!area.id || !area.items.length) continue;
    if (area.items.some((i) => !isCleanedState(i.state))) continue;   // not finished (or not completed) → no claim
    let latest = -Infinity;
    for (const i of area.items) latest = Math.max(latest, stampBy.get(i.key) ?? performedMs);
    out[area.id] = new Date(Number.isFinite(latest) ? latest : performedMs).toISOString();
  }
  return out;
}

// The physical area a checklist SECTION covers, or null. One reader, so nothing else has
// to know how the link is spelled.
export function siteAreaIdOf(schemaArea) {
  return str(schemaArea?.siteAreaId) || str(schemaArea?.site_area_id);
}

// Every building area ONE submission finished: siteAreaId → { at (ms), sectionId }, the
// latest `area_completions` stamp among its sections linked to that area (a section's own
// stamp is when its last item was done). The ONE reading of a stored row's completions:
// siteAreaStatus joins a building through it, and the server's search for an area's last
// clean past the newest page (api/_lib/qc/store areaStatusForSite, CS-701) judges every row
// it reads with it, so the two can never disagree about whether a submission cleaned an area.
export function siteAreaCompletions(row) {
  const out = new Map();
  const completions = row?.area_completions && typeof row.area_completions === 'object' ? row.area_completions : {};
  const schemaAreas = row?.template_snapshot?.schema?.areas;
  for (const schemaArea of Array.isArray(schemaAreas) ? schemaAreas : []) {
    const siteAreaId = siteAreaIdOf(schemaArea);
    if (!siteAreaId) continue;
    const at = ms(completions[str(schemaArea.id)]);
    if (at == null) continue;
    const prev = out.get(siteAreaId);
    if (!prev || at > prev.at) out.set(siteAreaId, { at, sectionId: str(schemaArea.id) });
  }
  return out;
}

// ── An area's last clean, however old (CS-701) ──────────────────────────────
// The server reads a building's newest page of submissions first. A page cannot answer every
// area: one that only a weekly or monthly checklist covers falls out of it within days at a
// busy building, and "never cleaned" on its wall would be a lie. So the areas the page cannot
// SETTLE are searched for further back, one by one.
//
// 🔴 What settles an area: a stamp is never later than its own submission (areaCompletionTimes
// clamps every one to `performed_at`), so a row not yet read — none newer than the page's
// oldest submission — can only beat a finish older than that. An area is settled when the
// page was not full (every row has been read) or its newest finish on the page is LATER than
// the page's oldest submission. Everything else is searched: areas with no finish on the page,
// and the rare one whose only finish there was stamped well before its submission.
//
//   areaIds   the building's area ids (site.cleaningAreas, in the office's order)
//   results   the page, newest first
//   full      whether the page came back as long as it was asked for
// → [{ areaId, bestAt (ms | null), before (ISO: search submissions at or before it) }]
// `before` is the page's oldest instant plus one millisecond: the database keeps microseconds
// and a parsed instant keeps milliseconds, so the margin keeps a row at that very instant in
// reach; any page row it brings back again is skipped by id.
export function areasPastThePage({ areaIds = [], results = [], full = false } = {}) {
  if (!full) return [];
  const rows = (Array.isArray(results) ? results : []).filter(Boolean);
  let oldest = Infinity;
  for (const r of rows) {
    const t = ms(r.performed_at);
    if (t != null && t < oldest) oldest = t;
  }
  if (!Number.isFinite(oldest)) return [];
  const best = new Map();
  for (const r of rows) {
    for (const [id, done] of siteAreaCompletions(r)) {
      if (!best.has(id) || done.at > best.get(id)) best.set(id, done.at);
    }
  }
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(areaIds) ? areaIds : []) {
    const areaId = str(raw);
    if (!areaId || seen.has(areaId)) continue;
    seen.add(areaId);
    const at = best.has(areaId) ? best.get(areaId) : null;
    if (at != null && at > oldest) continue;
    out.push({ areaId, bestAt: at, before: new Date(oldest + 1).toISOString() });
  }
  return out;
}

// The checklist SECTIONS an area names, in schema order — what the cleaner's checklist page opens
// at when a QR code sends them there (`crewPaths.checklist(jobId, areaId)` → `?area=`). The id may
// be the BUILDING's area (the code's, `site.cleaningAreas[].id`, linked by `siteAreaId`) or a
// section's own id. Unknown, blank or no schema → none, and the page simply opens at the top.
export function schemaAreasFor(schema, areaId) {
  const want = str(areaId);
  if (!want) return [];
  const out = [];
  for (const area of Array.isArray(schema?.areas) ? schema.areas : []) {
    const id = str(area?.id);
    if (id && (id === want || siteAreaIdOf(area) === want)) out.push(id);
  }
  return out;
}

// ── The building's area status (the Round-2 QR page's whole answer) ──────────
//
// ONE pure join, from data a caller has already read:
//   cleaningAreas  site.cleaningAreas — [{ id, label, instructions }], IN ORDER. The answer
//                  has one row per area whether or not anything has ever been recorded for
//                  it, because a QR code on an area nobody has linked still gets scanned
//                  and must say "no record" rather than 404.
//   results        checklist_results rows for that site, ANY order, each carrying
//                  template_snapshot / items / area_completions / client_submit_id /
//                  completed_by_user_id / performed_at / id.
//   media          account_media rows at scope 'checklist' for those submissions:
//                  { id, ref_id (= client_submit_id), area_id (= the ITEM key), created_at,
//                    url?, thumbUrl?, caption?, kind? }. Any order.
//   photoKeysByRef optional Map/object: submission id → the item keys that have a photo,
//                  so each result's items are stated with CS-547 honoured. Derived from
//                  `media` when absent, which is what every real caller wants.
//
// Returns, per area, in `cleaningAreas` order:
//   { areaId, label, instructions,
//     lastCleanedAt, lastCleanedByUserId, resultId, checklistName,
//     items: [{ key, label, state, note, needsPhoto, hasPhoto }],
//     photo: { id, itemKey, createdAt, url, thumbUrl, caption, kind } | null }
//
// `lastCleanedAt` is the NEWEST recorded completion of that area across the results given;
// `items` are the sections's items from THAT submission, so the time and the list always
// describe the same clean. `photo` is the newest checklist photo taken on an item in that
// area, across every result given — a photo is current evidence of the place, so it is not
// pinned to the winning submission.
export function siteAreaStatus({ cleaningAreas = [], results = [], media = [], photoKeysByRef = null } = {}) {
  const rows = Array.isArray(results) ? results.filter(Boolean) : [];
  const shots = Array.isArray(media) ? media.filter(Boolean) : [];

  // submission id → Set(item keys with a photo), for the per-item state.
  const keysByRef = new Map();
  if (photoKeysByRef instanceof Map) for (const [k, v] of photoKeysByRef) keysByRef.set(k, new Set(v || []));
  else if (photoKeysByRef && typeof photoKeysByRef === 'object') {
    for (const k of Object.keys(photoKeysByRef)) keysByRef.set(k, new Set(photoKeysByRef[k] || []));
  } else {
    for (const m of shots) {
      const ref = str(m.ref_id) || str(m.refId);
      const key = str(m.area_id) || str(m.areaId);
      if (!ref || !key) continue;
      if (!keysByRef.has(ref)) keysByRef.set(ref, new Set());
      keysByRef.get(ref).add(key);
    }
  }

  // Per site area: the newest completion, and the submission + section it came from.
  const best = new Map();        // siteAreaId → { at, row, view, areaView }
  // item key → siteAreaId, for the photo join (an item key is unique within a schema).
  const areaOfItem = new Map();
  for (const row of rows) {
    const view = projectChecklistResult(row, { photoKeys: keysByRef.get(str(row.client_submit_id)) || null });
    const schemaAreas = row.template_snapshot?.schema?.areas;
    // Every linked section's items, finished or not, for the photo join below.
    for (const schemaArea of Array.isArray(schemaAreas) ? schemaAreas : []) {
      const siteAreaId = siteAreaIdOf(schemaArea);
      if (!siteAreaId) continue;
      const areaView = view.areas.find((a) => a.id === str(schemaArea.id)) || null;
      for (const i of areaView?.items || []) areaOfItem.set(i.key, siteAreaId);
    }
    // What this submission finished, read once (siteAreaCompletions — the server's search
    // past the newest page judges each row with the same function).
    for (const [siteAreaId, done] of siteAreaCompletions(row)) {
      const prev = best.get(siteAreaId);
      if (!prev || done.at > prev.at) {
        best.set(siteAreaId, { at: done.at, row, view, areaView: view.areas.find((a) => a.id === done.sectionId) || null });
      }
    }
  }

  // Newest photo per site area. Ties are broken by id so the answer is stable.
  const photoFor = new Map();
  for (const m of shots) {
    const itemKey = str(m.area_id) || str(m.areaId);
    const siteAreaId = itemKey ? areaOfItem.get(itemKey) : null;
    if (!siteAreaId) continue;
    const at = ms(m.created_at ?? m.createdAt) ?? -Infinity;
    const prev = photoFor.get(siteAreaId);
    if (!prev || at > prev.at || (at === prev.at && String(m.id) > String(prev.shot.id))) {
      photoFor.set(siteAreaId, { at, shot: m, itemKey });
    }
  }

  return (Array.isArray(cleaningAreas) ? cleaningAreas : []).filter(Boolean).map((area) => {
    const areaId = str(area.id);
    const win = areaId ? best.get(areaId) : null;
    const shot = areaId ? photoFor.get(areaId) : null;
    return {
      areaId,
      label: str(area.label),
      instructions: str(area.instructions),
      lastCleanedAt: win ? new Date(win.at).toISOString() : null,
      lastCleanedByUserId: win ? (str(win.row.completed_by_user_id) || null) : null,
      resultId: win ? (str(win.row.id) || null) : null,
      // The clean that submission was made for (null when filled outside one): the office's area
      // page reads that clean's checklist rows to open the full checklist (QR Wave 2). Staff only:
      // the public projection (lib/areaScan projectAreaScan) builds its answer key by key.
      jobId: win ? (str(win.row.job_id) || null) : null,
      checklistName: win ? win.view.name : null,
      items: win?.areaView?.items?.map((i) => ({
        key: i.key, label: i.label, state: i.state, note: i.note,
        needsPhoto: !!i.needsPhoto, hasPhoto: !!i.hasPhoto,
      })) || [],
      photo: shot ? {
        id: shot.shot.id ?? null,
        itemKey: shot.itemKey,
        createdAt: shot.shot.created_at ?? shot.shot.createdAt ?? null,
        url: shot.shot.url ?? null,
        thumbUrl: shot.shot.thumbUrl ?? null,
        caption: shot.shot.caption ?? null,
        kind: shot.shot.kind ?? null,
      } : null,
    };
  });
}
