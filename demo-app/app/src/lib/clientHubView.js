// THE CLIENT HUB'S PROJECTIONS — everything a customer login is shown about a building, as
// ALLOWLISTS, shared by the server (api/hub/[...path].js) and the login-free demo
// (src/lib/hubDemo.js) so the two can never answer differently.
//
// Round 2 of the hub (Phase 2 Wave 2), Matt's answers of 2026-09-29 / 2026-09-30:
//   HUB-5   who is on site now — first name + last initial, time on site, a location check
//   HUB-6   the full inspection report, item comments included
//   HUB-7   a failed inspection flagged, with what we are doing about it (the redo)
//   HUB-8   every checklist item, checked or not, with the cleaner's notes
//   HUB-9   one year of history
//   HUB-13  every message a client sends is a ticket with its own conversation
//   HUB-15  checklist photos in the hub
//   WO-4    the client may mark a ticket urgent      WO-8  four stages, in their words
//   WO-9    internal notes stay internal             WO-11 reopen within 7 days
//   LOG-1 / LOG-9  the service events (not the activity log itself)
//
// 🔴 EVERY PROJECTION HERE BUILDS A NEW OBJECT FROM A DECLARED LIST and copies nothing else
// (the posture Round 1 set with HUB_BUILDING_FIELDS). The rows these read carry pay, phone
// numbers, coordinates, internal notes, share tokens, storage keys and staff ids; a projection
// that deleted the sensitive ones would leak the next column somebody adds. The suites compare
// every served object's keys against these constants (test-client-hub-view.mjs,
// test-client-hub-routes.mjs, test-client-login-isolation.mjs).
//
// 🔴 THE INTERNAL NOTE IS NEVER AN INPUT. An inspection's office-only note lives in its own
// column the hub never selects, and `projectHubInspection` re-picks the report through its own
// allowlists, so even a report object carrying extra keys cannot pass them on. An internal
// ticket note is excluded in the hub's QUERY (api/_lib/clientHub/reads.js) and dropped again
// here (hubVisibleMessages) — the second belt, never the only one.
//
// PURE and node-safe (explicit .js imports, no browser globals), because the server imports it.
import { hubPersonName } from './clientHub.js';
import { projectHubFace } from './hubFaces.js';
import { projectChecklistResult, isCleanedState, ITEM_STATE } from './checklistResultView.js';
import { isChecklistComplete } from './crewChecklist.js';
import { cleanedCountsOf } from './checklistCount.js';
import { redoAreasFor, resultLabel } from './inspections.js';
import { english, renderText } from '../i18n/core.js';
import {
  normalizePriority, normalizeCategory, woTypeLabel, woCategoryLabel, WO_TYPES, WO_CATEGORIES, RAISABLE_WO_TYPES,
  woClientStage, ticketReopenRefusal, ticketReopenDeadline,
} from './workOrders.js';

const DAY_MS = 86400000;
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const pick = (obj, fields) => {
  const out = {};
  for (const f of fields) out[f] = obj && obj[f] !== undefined ? obj[f] : null;
  return out;
};

// ── windows and paging ────────────────────────────────────────────────────────
// HUB-9: "How far back should clients see their history? — (b) 1 year." EVERY hub read is
// bounded by it — the lists, the detail pages (a record older than this is not found) and the
// history — so a client cannot page past the window by asking for an old id.
export const HUB_HISTORY_DAYS = 365;
// An open punch older than this is a forgotten clock-out, not someone "on site now" (the
// auto-close cron closes those; until it does, the hub must not show a cleaner on site for a day).
export const HUB_ON_SITE_HOURS = 24;
// The app's one page size (usePagedRows DEFAULT_PAGE_SIZE, UI_RULES §72). The hub pages on the
// SERVER — a building's year of history is thousands of rows — so the number lives here too,
// and test-client-hub-view.mjs holds the two equal.
export const HUB_PAGE_SIZE = 20;
export const HUB_PAGE_MAX = 50;
export const HUB_OFFSET_MAX = 100000;

export function hubWindowStartIso(now = Date.now()) {
  return new Date(now - HUB_HISTORY_DAYS * DAY_MS).toISOString();
}
export function isWithinHubWindow(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= now - HUB_HISTORY_DAYS * DAY_MS;
}
// ?offset&limit → a bounded page. Malformed or negative falls back; past the max is held to it.
export function hubPage({ offset, limit } = {}) {
  const o = Number.parseInt(offset, 10);
  const l = Number.parseInt(limit, 10);
  return {
    offset: Number.isFinite(o) && o > 0 ? Math.min(o, HUB_OFFSET_MAX) : 0,
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, HUB_PAGE_MAX) : HUB_PAGE_SIZE,
  };
}

// ── photos ────────────────────────────────────────────────────────────────────
// A photo as a client sees it: a short-lived signed URL (minted for this request, for a photo
// that is actually shown), its thumbnail and its caption. Never the storage key, the uploader
// or the record it is filed under.
export const HUB_PHOTO_FIELDS = Object.freeze(['id', 'url', 'thumbUrl', 'caption']);
export function projectHubPhoto(p) {
  return { id: p?.id ?? null, url: p?.url ?? null, thumbUrl: p?.thumbUrl ?? null, caption: str(p?.caption) };
}

// ── who is on site now (HUB-5) ────────────────────────────────────────────────
// `photo` is the cleaner's profile photo's version, { v }, or null (HUB-19, lib/hubFaces.js).
export const HUB_ON_SITE_FIELDS = Object.freeze(['name', 'since', 'minutesOnSite', 'locationVerified', 'photo']);
// A deleted punch and a no-show are never a visit: not "on site", not an arrival, not a check-out.
// ONE rule, read here and by the crew status (lib/hubVisit.js).
export const HUB_NOT_A_PUNCH = Object.freeze(['voided', 'no_show']);
export const isRealPunch = (e) => !!e && !HUB_NOT_A_PUNCH.includes(e.status);

// On the clock now: clocked in, not out, a real punch (a deleted punch and a no-show never
// count), inside the on-site window, and not stamped in the future beyond a little skew.
export function isOnSiteNow(e, now = Date.now()) {
  if (!e || e.clock_out_at) return false;
  if (!isRealPunch(e)) return false;
  const t = Date.parse(e.clock_in_at);
  if (!Number.isFinite(t)) return false;
  return t <= now + 5 * 60000 && now - t <= HUB_ON_SITE_HOURS * 3600000;
}

// The location check is the clock-in's geofence verdict, and only 'inside' is verified: an
// override, an off-site punch, a phone with no location and an unknown verdict all read
// "not verified" — the client is told whether we KNOW, never why we don't. `photoOf(userId)` is
// the caller's face for that person (lib/hubFaces.js hubFaceOf over the roster); without it, none.
export function projectOnSite(e, now = Date.now(), { photoOf = null } = {}) {
  const t = Date.parse(e?.clock_in_at);
  return {
    name: hubPersonName(e?.user_name) || 'A cleaner',
    since: e?.clock_in_at ?? null,
    minutesOnSite: Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : 0,
    locationVerified: e?.geofence_result === 'inside',
    photo: typeof photoOf === 'function' && e?.user_id ? projectHubFace(photoOf(e.user_id)) : null,
  };
}

// One row per PERSON (two open punches — two cleans back to back — are one cleaner on site, at
// their earlier arrival), earliest arrival first. The user id is used to group (and to ask
// `photoOf` for the person's photo) and never served.
export function hubOnSiteList(entries, now = Date.now(), { photoOf = null } = {}) {
  const first = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isOnSiteNow(e, now)) continue;
    const k = e.user_id || e.id;
    const prev = first.get(k);
    if (!prev || Date.parse(e.clock_in_at) < Date.parse(prev.clock_in_at)) first.set(k, e);
  }
  return [...first.values()]
    .sort((a, b) => Date.parse(a.clock_in_at) - Date.parse(b.clock_in_at))
    .map((e) => projectOnSite(e, now, { photoOf }));
}

// ── checklists (HUB-8, HUB-15) ────────────────────────────────────────────────
// `cleanerPhoto` is the cleaner's profile photo's version, { v } (HUB-19, lib/hubFaces.js), or null:
// no photo, or no cleaner named.
export const HUB_CHECKLIST_ROW_FIELDS = Object.freeze(['id', 'name', 'performedAt', 'cleaner', 'cleanerPhoto', 'done', 'total', 'complete']);
// A task the cleaner marked "not completed" (D2) is NOT done here, as on the checklist's own page
// below: the row reads its `items` (the list's read carries them, bounded by the page) through
// `cleanedCountsOf`, and serves the counts only — never the items, never a reason.
export function projectHubChecklistRow(row, { cleanerName = null, cleanerPhoto = null } = {}) {
  const counts = cleanedCountsOf(row);
  const cleaner = hubPersonName(cleanerName) || null;
  return {
    id: row?.id ?? null,
    name: str(row?.template_name) || str(row?.template_snapshot?.name) || 'Checklist',
    performedAt: row?.performed_at ?? null,
    cleaner,
    cleanerPhoto: cleaner ? projectHubFace(cleanerPhoto) : null,
    done: counts.done,
    total: counts.total,
    // The clock-out gate's own verdict over the STORED counts, so the hub can never call a
    // checklist finished that the office's screens call unfinished — and never one a task of
    // which the cleaner could not do.
    complete: isChecklistComplete(row) && counts.notCompleted === 0,
  };
}

export const HUB_CHECKLIST_FIELDS = Object.freeze([
  'id', 'name', 'performedAt', 'cleaner', 'cleanerPhoto', 'done', 'total', 'naCount', 'notDone', 'complete', 'hasSchema', 'countsDisagree', 'areas',
]);
export const HUB_CHECKLIST_AREA_FIELDS = Object.freeze(['id', 'label', 'done', 'total', 'na', 'items']);
export const HUB_CHECKLIST_ITEM_FIELDS = Object.freeze(['key', 'label', 'state', 'note', 'needsPhoto', 'photos']);

// ONE checklist, item by item. The item states are the OFFICE pop-up's rule
// (checklistResultView.projectChecklistResult — the same function components/
// ChecklistResultModal renders from), so a property manager and a manager reading the same
// clean can never be told different things. `photos` are the photos actually shown, each filed
// under its item key (account_media scope 'checklist', area_id = the item key); an item with a
// photo counts that photo for the office's "photo required" rule, exactly as the office's does.
// `photoKeys` (optional) is EVERY item key that has a photo, when the caller read more rows
// than it signed — so an item whose photo is not among the shown ones still reads done.
//
// 🔴 A TASK THE CLEANER MARKED "NOT COMPLETED" (Matt, 2026-10-13) IS NOT DONE HERE, AND ITS
// REASON NEVER LEAVES THE OFFICE. It counted toward the cleaner's clock-out (so the office's
// stored count calls it resolved), but the work did not happen — the customer reads it as
// "Not done", exactly like a missed task, and the headline, the area tally and `complete` say
// the same. The reason is the cleaner's note to the office ("supply closet locked, no key"),
// so no field of this projection carries it: the item state is mapped to NOT_DONE and the
// allowlists above have no room for it.
const hubItemState = (state) => (state === ITEM_STATE.NOT_COMPLETED ? ITEM_STATE.NOT_DONE : state);
export function projectHubChecklist(row, { cleanerName = null, cleanerPhoto = null, photos = [], photoKeys = null } = {}) {
  const byItem = new Map();
  for (const p of Array.isArray(photos) ? photos : []) {
    const k = p?.areaId ?? p?.area_id ?? null;
    if (!k) continue;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(projectHubPhoto(p));
  }
  const keys = new Set([...byItem.keys(), ...(Array.isArray(photoKeys) ? photoKeys : [])]);
  const view = projectChecklistResult(row, { photoKeys: [...keys] });
  const notCompleted = view.counts.notCompleted || 0;
  const cleaner = hubPersonName(cleanerName) || null;
  return {
    id: row?.id ?? null,
    name: view.name,
    performedAt: row?.performed_at ?? null,
    cleaner,
    cleanerPhoto: cleaner ? projectHubFace(cleanerPhoto) : null,
    // The STORED counts are the headline, as on the office's pop-up — the count the clean was
    // judged by when it was submitted — less the tasks the cleaner could not do, which the
    // stored count resolved for the clock-out but the customer reads as not done.
    done: Math.max(0, view.stored.done - notCompleted),
    total: view.stored.total,
    naCount: view.counts.na,
    notDone: view.counts.notDone + notCompleted,
    complete: view.complete && notCompleted === 0,
    hasSchema: view.hasSchema,
    countsDisagree: view.countsDisagree,
    areas: view.areas.map((a) => ({
      id: a.id,
      label: a.label,
      done: a.items.filter((i) => isCleanedState(i.state)).length,
      total: a.total,
      na: a.na,
      items: a.items.map((i) => ({
        key: i.key,
        label: i.label,
        state: hubItemState(i.state),
        note: i.note,
        needsPhoto: i.needsPhoto,
        photos: byItem.get(i.key) || [],
      })),
    })),
  };
}

// ── inspections (HUB-6, HUB-7, HUB-10) ────────────────────────────────────────
export const HUB_INSPECTION_ROW_FIELDS = Object.freeze(['id', 'name', 'performedAt', 'score', 'result', 'resultLabel']);
export function projectHubInspectionRow(rec) {
  return {
    id: rec?.id ?? null,
    name: str(rec?.template_name) || str(rec?.template_snapshot?.name) || 'Inspection',
    performedAt: rec?.performed_at ?? null,
    score: Number.isFinite(rec?.overall_score) ? rec.overall_score : null,
    result: rec?.result ?? null,
    resultLabel: resultLabel(rec?.result),
  };
}

// The report is `projectReport`'s shape (api/_lib/qc/store.js — the ONE client-facing
// projection the public page and the PDF are built from), re-picked here through these lists
// so a key the authed path adds beside it — an id, a status, a share token — cannot ride along.
export const HUB_REPORT_INSPECTION_FIELDS = Object.freeze([
  'templateName', 'schema', 'ratingScale', 'siteName', 'clientName', 'inspectorName', 'overallScore', 'result', 'performedAt',
]);
export const HUB_REPORT_ITEM_FIELDS = Object.freeze(['itemKey', 'label', 'rating', 'comment']);
export const HUB_REPORT_PHOTO_FIELDS = Object.freeze(['id', 'kind', 'url', 'caption', 'areaId']);
export const HUB_INSPECTION_FIELDS = Object.freeze(['id', 'performedAt', 'report', 'redo']);

// HUB-7, "what we are doing about it": the AREAS the cleaners on site were sent back to redo,
// in the very sentence their notice led with (store.notifyCleanersToRedo reads redoAreasFor
// over the same frozen snapshot and items). Null when nothing failed — a clean pass sends
// nobody back. `items` are the raw inspection_items rows ({ item_key, label, rating }).
//
// The hub is ENGLISH (LANG-8: what a client reads stays English), while the cleaners' notice is
// written in each cleaner's language (CS-193). So an area label that is a catalog message (the
// "Other items" bucket, `REDO_OTHER_LABEL`) is rendered in English here, and the names are
// joined by the catalog's own English list rule (`common.listAnd`, the rule the notice's
// `{areas, list}` uses), so the hub's sentence and the English notice cannot drift apart.
function englishList(names) {
  if (names.length <= 1) return names[0] || '';
  return english('common.listAnd', { first: names.slice(0, -1).join(', '), last: names[names.length - 1] });
}
export function hubRedo(snapshot, items) {
  const areas = redoAreasFor(snapshot, items);
  if (!areas.length) return null;
  const named = areas.map((a) => ({ label: renderText(a.label, 'en'), items: a.items.slice() }));
  return {
    sentence: englishList(named.map((a) => a.label).filter(Boolean)),
    areas: named,
  };
}

export function projectHubInspection({ id = null, report = null, snapshot = null, items = [] } = {}) {
  const ins = report?.inspection || {};
  return {
    id,
    performedAt: ins.performedAt ?? null,
    report: {
      inspection: pick(ins, HUB_REPORT_INSPECTION_FIELDS),
      items: (report?.items || []).map((i) => pick(i, HUB_REPORT_ITEM_FIELDS)),
      photos: (report?.photos || []).map((p) => pick(p, HUB_REPORT_PHOTO_FIELDS)),
    },
    redo: hubRedo(snapshot, items),
  };
}

// ── tickets (HUB-13, WO-4, WO-8, WO-9, WO-10, WO-11) ──────────────────────────
// `area` (QR-16 / QR-23, 2026-10-17): the NAME of the building area the request is about — the
// route reads it from the request's location (lib/workOrders ticketAreaLabel) and hands it in;
// never the area's id, and null when the request names none.
export const HUB_TICKET_ROW_FIELDS = Object.freeze([
  'id', 'title', 'type', 'typeLabel', 'category', 'categoryLabel', 'urgent', 'stage', 'stageLabel', 'createdAt', 'area',
]);
export function projectHubTicketRow(p, { area = null } = {}) {
  const stage = woClientStage(p?.status);
  const category = normalizeCategory(p?.category);
  const type = WO_TYPES.includes(p?.type) ? p.type : 'issue';
  return {
    id: p?.id ?? null,
    title: str(p?.title) || 'Request',
    type,
    typeLabel: woTypeLabel(type),
    category,
    categoryLabel: category ? woCategoryLabel(category) : null,
    // WO-18: a legacy 'high' reads as urgent, never quieter (normalizePriority's seam).
    urgent: normalizePriority(p?.priority) === 'urgent',
    stage: stage.key,
    stageLabel: stage.label,
    createdAt: p?.created_at ?? null,
    area: typeof area === 'string' && area.trim() ? area.trim() : null,
  };
}

export const HUB_TICKET_FIELDS = Object.freeze([
  ...HUB_TICKET_ROW_FIELDS, 'description', 'raisedBy', 'resolvedAt', 'reopenUntil', 'canReopen', 'messages', 'photos', 'completionPhotos',
]);
export const HUB_MESSAGE_FIELDS = Object.freeze(['id', 'from', 'author', 'body', 'translation', 'at']);

// WO-9, the second belt: an internal note never reaches a client thread, even if a query let
// one through. (The query is the boundary — reads.js ticketThread selects internal = false.)
export function hubVisibleMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && m.internal !== true);
}

// One message as the client reads it: "You" for the viewer's own; everyone else — our team, or
// another of the customer's own people — as first name + last initial.
export function projectHubMessage(m, { viewerClientUserId = null } = {}) {
  const fromClient = m?.author_role === 'client';
  const mine = fromClient && !!viewerClientUserId && m.author_client_user_id === viewerClientUserId;
  const from = fromClient ? (mine ? 'you' : 'client') : 'team';
  return {
    id: m?.id ?? null,
    from,
    author: mine ? 'You' : (hubPersonName(m?.author_name) || (fromClient ? 'Your team' : 'Our team')),
    body: String(m?.body ?? ''),
    translation: str(m?.translated_body),
    at: m?.created_at ?? null,
  };
}

export function projectHubTicket(p, {
  messages = [], photos = [], completionPhotos = [], viewerClientUserId = null, now = Date.now(), area = null,
} = {}) {
  const row = projectHubTicketRow(p, { area });
  const refusal = ticketReopenRefusal({ status: p?.status, resolvedAt: p?.resolved_at, now });
  const mine = !!viewerClientUserId && p?.raised_by_client_user_id === viewerClientUserId;
  return {
    ...row,
    description: String(p?.description ?? ''),
    raisedBy: mine ? 'You' : (hubPersonName(p?.raised_by_client_name) || null),
    resolvedAt: row.stage === 'completed' ? (p?.resolved_at ?? null) : null,
    reopenUntil: row.stage === 'completed' ? ticketReopenDeadline(p?.resolved_at) : null,
    canReopen: refusal === null,
    messages: hubVisibleMessages(messages)
      .slice()
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .map((m) => projectHubMessage(m, { viewerClientUserId })),
    photos: (Array.isArray(photos) ? photos : []).map(projectHubPhoto),
    completionPhotos: (Array.isArray(completionPhotos) ? completionPhotos : []).map(projectHubPhoto),
  };
}

// ── what a client may send ────────────────────────────────────────────────────
// ONE rule, run by the route before anything is written and by the demo the same way. Only the
// named fields are read, so a body carrying `origin`, `priority`, `reportedByUserId` or a status
// changes nothing: the server sets origin 'portal' and the raiser from the claim.
export const HUB_TICKET_TEXT_MAX = 2000;
export const HUB_TICKET_TITLE_MAX = 80;
export const HUB_INPUT_REFUSALS = Object.freeze({
  'ticket-type': 'Choose what kind of request this is.',
  'ticket-category': 'Choose what the request is about.',
  'ticket-description': 'Tell us what is going on.',
  'ticket-too-long': `Keep it under ${HUB_TICKET_TEXT_MAX} characters.`,
  'message-empty': 'Write a message first.',
  'message-too-long': `Keep it under ${HUB_TICKET_TEXT_MAX} characters.`,
});
const refuse = (code) => ({ refused: HUB_INPUT_REFUSALS[code], code });

// The ticket's title is its description's first line — the client is asked one question, not
// two — shortened to fit the office's queue.
export function hubTicketTitle(description) {
  const first = String(description ?? '').trim().split(/\r?\n/)[0].trim();
  return first.length > HUB_TICKET_TITLE_MAX ? `${first.slice(0, HUB_TICKET_TITLE_MAX - 1).trimEnd()}…` : first;
}

export function hubTicketInput(body = {}) {
  // A customer raises a complaint, a request or an issue; a failed inspection's ticket is the
  // app's own (WO-19), never one a customer can file.
  const type = RAISABLE_WO_TYPES.includes(body?.type) ? body.type : null;
  if (!type) return refuse('ticket-type');
  const category = WO_CATEGORIES.includes(body?.category) ? body.category : null;
  if (!category) return refuse('ticket-category');
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (!description) return refuse('ticket-description');
  if (description.length > HUB_TICKET_TEXT_MAX) return refuse('ticket-too-long');
  return {
    value: {
      type,
      category,
      description,
      // WO-4: the client may mark it urgent; the office can change it. Only the literal true.
      urgent: body?.urgent === true,
      title: hubTicketTitle(description),
    },
  };
}

export function hubMessageInput(body = {}) {
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) return refuse('message-empty');
  if (text.length > HUB_TICKET_TEXT_MAX) return refuse('message-too-long');
  return { value: { body: text } };
}

// ── history (HUB-9, LOG-1, LOG-9) ─────────────────────────────────────────────
// The rows come from activityLog.selectServiceEvents (the customer-facing selection, which
// already names a person as first name + last initial); this is the hub's allowlist over them
// and its wording for the one field that is a code — a ticket's status, told as a stage. The
// customer's word for a ticket is "request" (Matt's word, decision D6, 2026-10-08), so the two
// ticket rows are re-labelled here; the office's own record keeps "ticket".
export const HUB_EVENT_FIELDS = Object.freeze(['at', 'kind', 'label', 'detail']);
const HUB_EVENT_LABELS = Object.freeze({ ticket_raised: 'Request raised', ticket: 'Request update' });
export function projectHubEvent(e) {
  const detail = e?.kind === 'ticket' ? woClientStage(e?.detail).label : (e?.detail ?? null);
  return { at: e?.at ?? null, kind: e?.kind ?? null, label: HUB_EVENT_LABELS[e?.kind] || e?.label || '', detail };
}
export function hubHistoryPage(events, { offset = 0, limit = HUB_PAGE_SIZE } = {}) {
  const list = Array.isArray(events) ? events : [];
  return { events: list.slice(offset, offset + limit), total: list.length };
}
