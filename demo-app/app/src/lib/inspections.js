// Pure inspection scoring + result vocabulary — shared by the server QC route
// (api/_lib/qc/store.js) and the demo stub (qcApi.js) so a score computed
// server-side and client-side can never disagree (the lib/geo / lib/variance
// pattern). Browser-dep-free, explicit imports only. See CLEANSPACE_SWEPT.md §5.6.
import { msg, english } from '../i18n/core.js';
import { itemAllowsNa } from './checklistCount.js';

// The cap on an inspection HISTORY list: the Quality hub's list and a customer's own
// Inspections tab hold the newest this-many records THAT MATCH their filters (applied in
// the query, never to an org-wide slice) and say "showing the newest N" when there are
// more (UI_RULES §117 — a list may stay newest-N; anything that COUNTS reads a complete
// window instead). ONE number for the server read (api/_lib/qc/store.js listInspections)
// and the demo stub (qcApi.js), so both cap, and flag `truncated`, at the same row.
export const INSPECTION_LIST_LIMIT = 200;

// The same cap on the Quality hub's CHECKLISTS list (CS-335): the newest this-many
// submissions, and how many there are in all once the list is full (the server's
// `total` / `truncated`, api/_lib/qc/store.js listChecklists + countChecklists; the demo
// stub, qcApi.js listChecklistsNewest), so the tab can say "Showing the newest N of M".
export const CHECKLIST_LIST_LIMIT = 200;

// The result vocabulary (inspection_records.result's CHECK constraint).
export const INSPECTION_RESULTS = ['pass', 'fail', 'needs_follow_up'];

// What an inspection filter MEANS, for the demo stub; the server applies the same filters
// in its query (api/_lib/qc/store.js applyInspectionFilters) and the offline suite holds
// the two to one answer. Absent (null/undefined) = no constraint. A list keeps records
// whose field is one of its values, so an EMPTY list keeps nothing (SQL's IN ()), never
// everything. Date bounds are inclusive ISO instants on performed_at.
export function inspectionMatchesFilters(r, { fromIso, toIso, clientId, siteIds, inspectorIds, results, submittedOnly = false } = {}) {
  if (!r) return false;
  const t = Date.parse(r.performed_at);
  if (fromIso && !(t >= Date.parse(fromIso))) return false;
  if (toIso && !(t <= Date.parse(toIso))) return false;
  if (clientId && r.client_id !== clientId) return false;
  if (siteIds && !siteIds.includes(r.site_id)) return false;
  if (inspectorIds && !inspectorIds.includes(r.inspector_user_id)) return false;
  if (results && !results.includes(r.result)) return false;
  if (submittedOnly && r.status === 'draft') return false;
  return true;
}

// Newest first, ties by id — the order the server's list query asks for.
const performedMs = (r) => { const t = Date.parse(r.performed_at); return Number.isFinite(t) ? t : -Infinity; };
export function newestInspectionFirst(a, b) {
  const ta = performedMs(a);
  const tb = performedMs(b);
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// The Quality hub's figures over a set of records: how many there are (drafts included,
// as the list holds them) plus the scored roll-up. The server tallies EVERY matching
// record with this (qc/store.js); the demo stub runs it over its local records. Sorted
// first so a tie on performed_at splits the trend's halves by id, whatever order the
// records arrived in (the server's pages come oldest-first, the stub's newest-first).
export function inspectionFigures(records) {
  const sorted = (records || []).slice().sort(newestInspectionFirst);
  return { total: sorted.length, ...summarizeInspections(sorted) };
}

// One export row: what the CSV writes (plus the id, which the paged read dedupes on, and
// the client/site ids its location label falls back to), with the template's name read
// out of the frozen snapshot (which can run to kilobytes). The server selects the same
// fields (qc/store.js INSPECTION_EXPORT_COLUMNS) so both answer one shape.
export function toInspectionExportRow(r) {
  return {
    id: r.id, performed_at: r.performed_at ?? null,
    client_id: r.client_id ?? null, site_id: r.site_id ?? null,
    client_name: r.client_name ?? null, site_name: r.site_name ?? null,
    template_name: r.template_snapshot?.name ?? null,
    overall_score: r.overall_score ?? null, result: r.result ?? null, inspector_name: r.inspector_name ?? null,
  };
}

// items: [{ rating, ... }]. scale: { type:'passfail'|'numeric', max?, passThreshold? }.
// 'na' / null / '' ratings are excluded from the denominator. passfail = % pass;
// numeric = average as a % of max. result = pass when score >= threshold (default 80).
export function scoreInspection(items, scale = {}) {
  const scored = (items || []).filter((it) => it.rating != null && it.rating !== '' && it.rating !== 'na');
  if (!scored.length) return { overallScore: null, result: 'needs_follow_up' };
  const threshold = Number.isFinite(scale.passThreshold) ? scale.passThreshold : 80;
  let pct;
  if (scale.type === 'numeric') {
    const max = Number.isFinite(scale.max) ? scale.max : 5;
    const avg = scored.reduce((s, it) => s + (Number(it.rating) || 0), 0) / scored.length;
    pct = max > 0 ? Math.round((avg / max) * 100) : 0;
  } else {
    const pass = scored.filter((it) => String(it.rating) === 'pass').length;
    pct = Math.round((pass / scored.length) * 100);
  }
  return { overallScore: pct, result: pct >= threshold ? 'pass' : 'fail' };
}

// ── The New Inspection form as drawn (Matt's board; Daniel, 2026-10-09) ──────
//
// A PASS/FAIL template is a TICK LIST: a ticked item is a pass, an item left unticked is a
// FAIL when the inspection is submitted (the board's "5 of 7 · 71%"), and N/A — only on an
// item the template allows it for (lib/checklistCount itemAllowsNa, the one N/A rule) —
// leaves the count. A NUMERIC template keeps its 1–max picker: an unpicked item is unrated
// and out of the count, as it always was.
//
// ONE builder for what the form POSTS (`inspectionFillItems`) and ONE for the score card
// (`inspectionFillScore`), which runs the very `scoreInspection` the server runs on the
// posted items (api/_lib/qc/store.js submitInspection, the demo stub likewise), so the
// number on the card is the number that is stored — test-inspection-fill.mjs drives both.
//
// `answers` = { [itemId]: { ticked?: true, na?: true, rating?: 1..max, comment?: string } }.
// Each item posts the OFFICE's English "<Area>. <Item>" (the report and the client read
// English; the screen shows the reader's line through checklistLabel).
//
// `{ draft: true }` is what a DRAFT stores (an inspection left open to finish later, Matt
// 2026-10-06; lib/inspectionDrafts): an unticked box is NOT a fail yet — it is a box nobody has
// got to — so it is stored as no rating, and an item with neither a rating nor a comment is not
// stored at all. Submit still runs the plain call, where unticked is a fail.
export function inspectionFillItems(snapshot, answers = {}, { draft = false } = {}) {
  const numeric = snapshot?.rating_scale?.type === 'numeric';
  const max = Number.isFinite(snapshot?.rating_scale?.max) ? snapshot.rating_scale.max : 5;
  const out = [];
  for (const area of snapshot?.schema?.areas || []) {
    for (const it of area?.items || []) {
      if (!it || !it.id) continue;
      const a = (answers && answers[it.id]) || {};
      let rating;
      if (a.na === true && itemAllowsNa(it)) rating = 'na';
      else if (numeric) {
        const n = Number(a.rating);
        rating = Number.isInteger(n) && n >= 1 && n <= max ? n : null;
      } else rating = a.ticked === true ? 'pass' : (draft ? null : 'fail');
      const comment = typeof a.comment === 'string' && a.comment.trim() ? a.comment.trim() : null;
      if (draft && rating == null && !comment) continue;
      out.push({
        item_key: it.id,
        label: `${area.label || english('inspectionFill.areaFallback')}. ${it.label || english('inspectionFill.itemFallback')}`,
        rating,
        comment,
      });
    }
  }
  return out;
}

// The score card: `done` of `applies` (ticked of the items that apply; for a numeric
// template, rated of the items that apply) and the server's own percent and result.
export function inspectionFillScore(snapshot, answers = {}) {
  const numeric = snapshot?.rating_scale?.type === 'numeric';
  const scale = snapshot?.rating_scale || { type: 'passfail', passThreshold: 80 };
  const items = inspectionFillItems(snapshot, answers);
  const applies = items.filter((i) => i.rating !== 'na').length;
  const done = numeric
    ? items.filter((i) => i.rating != null && i.rating !== 'na').length
    : items.filter((i) => i.rating === 'pass').length;
  const { overallScore, result } = scoreInspection(items, scale);
  return { done, applies, overallScore, result, numeric };
}

// A NEW inspection's photos are a BEFORE / AFTER pair (account_media scope `inspection`,
// `area_id` 'before' / 'after' — the cleaner's visit convention). Older inspections filed
// their photos under the template's AREA ids and keep reading that way on the report
// (lib/inspectionReportTemplate): history never drifts.
export const INSPECTION_PHOTO_PHASES = Object.freeze({ BEFORE: 'before', AFTER: 'after' });

// ── HUB-7: which AREAS a failed inspection sends back to be redone ──────────
//
// Matt, 2026-10-02: "Does not have to create a work order… Once the inspection failed,
// there should be some sort of a tool where the cleaners on site receive a notification
// that an area needs to be done."
//
// 🔴 THE TRIGGER IS FAILING ITEMS, NOT THE OVERALL RESULT. An inspection can score 88%
// and still have the restrooms marked fail; the cleaners are in the building now and the
// restrooms still need doing. The manager bell (`inspectionFailed`) stays keyed on the
// RESULT, because that one is about the account's trend — these are two different
// questions and they deliberately fire on different conditions.
//
// An item fails when its rating is the pass/fail scale's 'fail', or when a NUMERIC rating
// falls under the same threshold the whole inspection is judged by (`scoreInspection`'s
// passThreshold, as a percent of `max`) — so "what counts as failing" is one definition,
// the office's own, and not a second opinion invented here. An unrated item and an 'na'
// are not failures: `scoreInspection` leaves both out of the score, and a cleaner must not
// be sent back over a box nobody ticked.
export function isFailingRating(rating, scale = {}) {
  if (rating == null || rating === '' || rating === 'na') return false;
  const threshold = Number.isFinite(scale.passThreshold) ? scale.passThreshold : 80;
  if (scale.type === 'numeric') {
    const max = Number.isFinite(scale.max) ? scale.max : 5;
    const n = Number(rating);
    if (!Number.isFinite(n) || max <= 0) return false;
    return (n / max) * 100 < threshold;
  }
  return String(rating) === 'fail';
}

// The areas to redo, as the crew will read them: [{ id, label, items: [label] }], in the
// frozen schema's own order. An item whose key the snapshot does not name still counts —
// it goes under an "Other" bucket with a null id — because a failing item is work owed
// whether or not the structure can place it.
//
// `snapshot` is `inspection_records.template_snapshot` (the frozen template), `items` the
// submitted `[{ item_key, label, rating }]`.
// A message (CS-193): the alert renders it in each cleaner's own language.
export const REDO_OTHER_LABEL = msg('alerts.redo.otherItems');
export function redoAreasFor(snapshot, items) {
  const scale = snapshot?.rating_scale || { type: 'passfail', passThreshold: 80 };
  const failed = (Array.isArray(items) ? items : []).filter((it) => isFailingRating(it?.rating, scale));
  if (!failed.length) return [];
  // item key → its area, from the frozen schema.
  const areaOf = new Map();
  const order = [];
  for (const area of snapshot?.schema?.areas || []) {
    const id = typeof area?.id === 'string' && area.id.trim() ? area.id.trim() : null;
    const label = typeof area?.label === 'string' && area.label.trim() ? area.label.trim() : null;
    order.push({ id, label });
    for (const item of Array.isArray(area?.items) ? area.items : []) {
      const key = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : null;
      if (key) areaOf.set(key, id);
    }
  }
  const byArea = new Map();
  for (const it of failed) {
    const key = typeof it?.item_key === 'string' ? it.item_key : null;
    const areaId = (key && areaOf.has(key)) ? areaOf.get(key) : null;
    if (!byArea.has(areaId)) byArea.set(areaId, []);
    // The submitted label is "<Area>. <Item>" (InspectionFill), so the area prefix is
    // dropped — it is already the heading this item sits under.
    const label = String(it?.label || key || 'item').replace(/^[^.]*\.\s*/, '').trim() || 'item';
    byArea.get(areaId).push(label);
  }
  const out = [];
  for (const a of order) {
    if (!byArea.has(a.id)) continue;
    out.push({ id: a.id, label: a.label || REDO_OTHER_LABEL, items: byArea.get(a.id) });
    byArea.delete(a.id);
  }
  // Anything left over — a failing item the schema cannot place (null area, or an area id
  // the loop above never saw). Never dropped.
  for (const [, labels] of byArea) {
    const existing = out.find((o) => o.id === null);
    if (existing) existing.items.push(...labels);
    else out.push({ id: null, label: REDO_OTHER_LABEL, items: labels });
  }
  return out;
}

// The redo alert's sentence ("Please redo: Restrooms and Break room") is a catalog message
// now (CS-193, `alerts.redo.title` with the area names as a list), so each cleaner reads it
// in their own language — api/_lib/qc/store.notifyCleanersToRedo builds it.

export function resultBadgeVariant(result) {
  if (result === 'pass') return 'green';
  if (result === 'fail') return 'red';
  if (result === 'needs_follow_up') return 'amber';
  return 'slate';
}

export function resultLabel(result) {
  if (result === 'pass') return 'Pass';
  if (result === 'fail') return 'Fail';
  if (result === 'needs_follow_up') return 'Needs follow-up';
  return '—';
}

// Roll a set of inspection records into an average score + a simple recent-vs-prior
// trend (delta of the newer half's avg minus the older half's). Records are sorted
// performed_at-desc; only submitted records with a numeric overall_score count toward
// the average. failCount tallies fail/needs_follow_up results. Shared by the account
// Operations tab and the Quality hub so both read the same math. Browser-dep-free.
export function summarizeInspections(records) {
  const list = records || [];
  const scored = list
    .filter((r) => r.status === 'submitted' && r.overall_score != null)
    .slice()
    .sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at));
  const failCount = list.filter((r) => r.result === 'fail' || r.result === 'needs_follow_up').length;
  const count = scored.length;
  if (!count) return { count: 0, avgScore: null, recentAvg: null, priorAvg: null, delta: null, failCount };
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, r) => s + Number(r.overall_score), 0) / arr.length) : null);
  const avgScore = avg(scored);
  let recentAvg = null; let priorAvg = null; let delta = null;
  if (count >= 2) {
    const half = Math.floor(count / 2);
    recentAvg = avg(scored.slice(0, count - half)); // newer half
    priorAvg = avg(scored.slice(count - half));      // older half
    if (recentAvg != null && priorAvg != null) delta = recentAvg - priorAvg;
  }
  return { count, avgScore, recentAvg, priorAvg, delta, failCount };
}

// ── Publishing a template ────────────────────────────────────────────────────
// How many items a template's schema holds, across every area.
export function countSchemaItems(schema) {
  return (schema?.areas || []).reduce((n, a) => n + (Array.isArray(a?.items) ? a.items.length : 0), 0);
}

// Why this template may NOT be published, or null. ONE rule, shared by the server store,
// the demo stub and the editor, so the three cannot drift.
//
// A CHECKLIST with ZERO items can never be complete: completion is
// `total_count > 0 && completed_count >= total_count` (lib/crewChecklist.isChecklistComplete),
// and an item-less checklist submits 0/0. Its holders would be nudged and then escalated on
// every clean for ever, and step 4's clock-out block would lock them out with nothing to
// tick. Inspection templates are left alone — they are scored, not ticked.
export const NO_ITEMS_MESSAGE = 'Add at least one item before publishing';
export function publishRefusal({ kind, schema } = {}) {
  if (kind === 'checklist' && countSchemaItems(schema) === 0) return NO_ITEMS_MESSAGE;
  return null;
}

// ── A PUBLISHED template's draft keeps its own name and pass mark (CS-669) ─────
// The template ROW's `name` and `rating_scale` are the PUBLISHED ones: a new inspection
// snapshots `tpl.rating_scale` with the published version's items. "Save draft" used to write
// both onto the row at once while only the items waited in the draft version, so a draft's pass
// mark scored live inspections (92% filed as Fail — a ticket, the office rung, the customer
// emailed). Now a draft of a PUBLISHED template carries them in its own version, under
// `schema[PENDING_TEMPLATE_KEY]`, and Publish moves them onto the row and strips the key from the
// frozen version. A template NEVER published has no live inspection to protect, so its row
// still takes them at once. ONE rule for the store, the demo stub and the editor.
export const PENDING_TEMPLATE_KEY = 'pendingTemplate';
// What a save writes where: `rowPatch` onto the template row, `pending` into the draft version.
export function templateDraftSave({ isPublished = false, name, ratingScale, previous = null } = {}) {
  const asked = {
    ...(name !== undefined ? { name } : {}),
    ...(ratingScale !== undefined ? { ratingScale } : {}),
  };
  if (!isPublished) {
    return { rowPatch: { ...(asked.name !== undefined ? { name: asked.name } : {}), ...(asked.ratingScale !== undefined ? { rating_scale: asked.ratingScale } : {}) }, pending: null };
  }
  const pending = { ...(previous || {}), ...asked };
  return { rowPatch: {}, pending: Object.keys(pending).length ? pending : null };
}
// The pending name / pass mark a DRAFT version carries, or null.
export function pendingTemplateOf(version) {
  if (!version || version.status === 'published') return null;
  const p = version.schema && version.schema[PENDING_TEMPLATE_KEY];
  return p && typeof p === 'object' ? p : null;
}
export function withPendingTemplate(schema, pending) {
  const base = withoutPendingTemplate(schema);
  return pending ? { ...base, [PENDING_TEMPLATE_KEY]: pending } : base;
}
export function withoutPendingTemplate(schema) {
  if (!schema || typeof schema !== 'object' || !(PENDING_TEMPLATE_KEY in schema)) return schema || { areas: [] };
  const { [PENDING_TEMPLATE_KEY]: _pending, ...rest } = schema;
  return rest;
}
// Does a published template have changes nobody has published yet? (its latest version is a draft)
export function hasUnpublishedChanges(template, latestVersion) {
  return !!template?.is_published && !!latestVersion && latestVersion.status === 'draft'
    && latestVersion.id !== template.published_version_id;
}
// What the editor shows: the draft's own name and pass mark when it has them, else the row's.
export function effectiveTemplateMeta(template, latestVersion) {
  const pending = pendingTemplateOf(latestVersion);
  return {
    name: pending && pending.name !== undefined ? pending.name : (template?.name ?? ''),
    ratingScale: pending && pending.ratingScale !== undefined ? pending.ratingScale : (template?.rating_scale ?? null),
    hasUnpublishedChanges: hasUnpublishedChanges(template, latestVersion),
  };
}

// ── A CHECKLIST BELONGS TO ONE CUSTOMER (R2, plan step 5) ────────────────────
// `inspection_templates.client_id` names the customer a CHECKLIST is filed under; NULL is a
// STARTER, offered under "Start from…" and never assigned directly. INSPECTION templates
// stay company-wide and never carry one. The rules below are the ONE place that says so,
// shared by the server store + route (api/_lib/qc/store.js, api/qc/[...path].js), the demo
// stub (lib/qcApi.js) and the UI — the same shape publishRefusal above already uses, so the
// three cannot answer the same question differently.

// The refusals, as the office reads them: plain sentences, never a field name or a status.
export const CHECKLIST_NEEDS_CUSTOMER = 'Choose the customer this checklist belongs to.';
export const INSPECTION_TAKES_NO_CUSTOMER = 'Inspection templates are company-wide, so they are not filed under a customer.';
export const TEMPLATE_FILTER_CONFLICT = 'Ask for one customer\'s checklists or for the starters, not both.';
export const COPY_SOURCE_MUST_BE_CHECKLIST = 'Only a checklist can be copied to a customer.';

// The kind a template row actually gets, normalized exactly as the insert normalizes it —
// so a refusal decided here can never disagree with the row that would be written.
export function templateKind(kind) {
  return kind === 'checklist' ? 'checklist' : 'inspection';
}

// The two kinds `inspection_templates.kind` allows (its CHECK constraint,
// supabase/migrations/20260614120000_qc_backend.sql). A LIST filter is held to them:
// unvalidated, `?kind` went straight into `.eq('kind', …)` as whatever was typed, and a
// typo ("checklists") came back as an empty list that reads exactly like "there are none"
// — the same wrong answer the clientId/starters conflict would give. Absent or empty is
// still "no filter", as it always was.
export const TEMPLATE_KINDS = ['inspection', 'checklist'];
export const TEMPLATE_KIND_MESSAGE = `kind must be one of ${TEMPLATE_KINDS.join(', ')}`;
export function templateKindRefusal(kind) {
  if (kind == null || kind === '') return null;
  return TEMPLATE_KINDS.includes(kind) ? null : TEMPLATE_KIND_MESSAGE;
}

// Why this CREATE may not proceed, or null. A checklist has to say whose it is; an
// inspection may not, because filing one under a customer would quietly narrow a
// company-wide template to one building.
export function createTemplateRefusal({ kind, clientId } = {}) {
  if (templateKind(kind) === 'checklist') return clientId ? null : CHECKLIST_NEEDS_CUSTOMER;
  return clientId ? INSPECTION_TAKES_NO_CUSTOMER : null;
}

// Why this COPY may not proceed, or null. The source is a starter or another customer's
// checklist; an inspection template is never a checklist's source.
export function copyTemplateRefusal({ kind, clientId } = {}) {
  if (kind !== 'checklist') return COPY_SOURCE_MUST_BE_CHECKLIST;
  return clientId ? null : CHECKLIST_NEEDS_CUSTOMER;
}

// Why this LIST filter combination may not proceed, or null. One customer AND the starters
// is a contradiction, and answering it with an empty list would read as "this customer has
// no checklists" — the one answer the screen must never invent.
export function templateFilterRefusal({ clientId, starters } = {}) {
  return clientId && starters ? TEMPLATE_FILTER_CONFLICT : null;
}

// Does this template row match the list's filters? The demo stub's half of the store's
// applyTemplateFilters, held to the same answer by the offline suites. Absent = no
// constraint, as everywhere else here.
//   kind      : 'checklist' | 'inspection'
//   clientId  : that customer's rows only — never the starters
//   starters  : only the rows with no customer
export function templateMatchesFilters(t, { kind, clientId, starters } = {}) {
  if (!t) return false;
  if (kind && t.kind !== kind) return false;
  const owner = t.client_id ?? null;
  if (clientId && owner !== clientId) return false;
  if (starters && owner !== null) return false;
  return true;
}

// What a copy starts from. Version 1 is the source's PUBLISHED schema — the frozen one the
// cleaners actually fill, not a newer draft sitting beside it — falling back to its latest
// draft when it has never been published. It is published at once when the source was AND
// `publishRefusal` allows it: an item-less checklist can never be complete, so a copy of one
// must land as a draft rather than start reminding and blocking its holders on day one.
export function planTemplateCopy({ kind = 'checklist', publishedSchema = null, latestSchema = null, sourcePublished = false } = {}) {
  const schema = publishedSchema || latestSchema || { areas: [] };
  return { schema, publish: !!sourcePublished && !publishRefusal({ kind, schema }) };
}

// The NARROW row step 6's problems summary reads across ~750 customers: no schema, no
// rating scale, no slug — the fields a worklist shows, plus the published version's item
// count. `item_count` is null for an unpublished template AND for a published one whose
// version could not be read: 0 would be a claim ("a checklist with no items"), null is the
// truth ("nothing to count from here").
export function toTemplateSummaryRow(t, itemCount = null) {
  return {
    id: t?.id ?? null,
    name: t?.name ?? null,
    client_id: t?.client_id ?? null,
    is_published: !!t?.is_published,
    published_version_id: t?.published_version_id ?? null,
    updated_at: t?.updated_at ?? null,
    item_count: t?.published_version_id && Number.isFinite(itemCount) ? itemCount : null,
  };
}

// Newest edited first, ties by id descending — the order the template query asks for
// (`updated_at desc, id desc`), so the stub and the server hand back one order.
const updatedMs = (t) => { const v = Date.parse(t?.updated_at); return Number.isFinite(v) ? v : -Infinity; };
export function newestTemplateFirst(a, b) {
  const ta = updatedMs(a);
  const tb = updatedMs(b);
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a?.id < b?.id ? 1 : a?.id > b?.id ? -1 : 0;
}
