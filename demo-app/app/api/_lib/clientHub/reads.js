// THE CLIENT HUB'S READS (Phase 2 Wave 2 Round 2) — every relational read /api/hub makes for a
// building, and nothing else. Service-role only; never import client-side.
//
// THE THREE RULES EVERY FUNCTION HERE KEEPS (the route depends on all three):
//
//   1. 🔴 THE BUILDING IS IN THE QUERY. Each read is filtered by `client_id` = the building the
//      route has ALREADY checked against the login's `allowedIds` — and a detail read by id is
//      filtered by that building too, so an id from another building comes back as nothing
//      (the route answers 404) rather than as a row the route must remember to compare.
//   2. 🔴 A DECLARED COLUMN LIST, NEVER select(*). The lists below are exported so the suites
//      can read them: none names `internal_note` (HUB-16), a share token, a storage key the
//      browser could use, pay, or a distance or coordinate. A column added to a table tomorrow
//      is not read here until someone adds it to a list.
//   3. BOUNDED AND ORDERED (lint:paging, CS-248). Every list is a page (`range`) or a `limit`,
//      ordered by its time column and then `id`, and a year back at most (HUB-9:
//      clientHubView.HUB_HISTORY_DAYS — the route passes the window start in).
//
// Errors THROW with the provider's words in the message, for the server log only: the route
// answers the caller a sentence and a code (CS-077 class) and never forwards `e.message`.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { exactCount, selectAll } from '../pagedSelect.js';
import { signMediaRow } from '../accountMedia/store.js';
import { HUB_VISIT_PHOTO_SCOPE, HUB_VISIT_PHOTO_AREAS, HUB_VISIT_PHOTO_SCAN, hubVisitPhotoPick } from '../../../src/lib/hubVisit.js';
import { HUB_TREND_MAX, HUB_TILE_CHECKLIST_MAX } from '../../../src/lib/hubHome.js';
import { ticketAreaColumnReady } from '../qc/ticketColumns.js';

const org = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID);

function must(res, what) {
  if (res?.error) {
    const err = new Error(`${what}: ${res.error.message || res.error.code || 'read failed'}`);
    err.code = res.error.code || null;
    throw err;
  }
  return res;
}

// ── column lists (rule 2) ─────────────────────────────────────────────────────
export const HUB_ON_SITE_COLUMNS = 'id,user_id,user_name,clock_in_at,clock_out_at,status,geofence_result';
// `template_name` is the snapshot's name as a JSON value (`->`, which supabase-js hands back as
// a plain string for a JSON string), so a list row never carries the whole frozen schema.
// `items` rides on the list, the visit and the Home tile reads (each bounded: a page, ≤ 100 rows)
// so a task the cleaner marked "not completed" reads as not done there too (cleanedCountsOf, D2);
// the projections serve the counts only, never the items.
export const HUB_CHECKLIST_ROW_COLUMNS = 'id,template_name:template_snapshot->name,completed_by_user_id,completed_count,total_count,items,performed_at';
export const HUB_CHECKLIST_COLUMNS = 'id,client_id,template_snapshot,items,completed_count,total_count,completed_by_user_id,client_submit_id,performed_at';
export const HUB_INSPECTION_ROW_COLUMNS = 'id,template_name:template_snapshot->name,overall_score,result,performed_at';
// Exactly what projectReport (api/_lib/qc/store.js) and the PDF renderer read, plus the scope
// columns. 🔴 No `internal_note` (HUB-16) and no `public_token`.
export const HUB_INSPECTION_COLUMNS = 'id,client_id,site_id,status,template_snapshot,site_name,client_name,inspector_name,overall_score,result,performed_at';
export const HUB_INSPECTION_ITEM_COLUMNS = 'id,item_key,label,rating,comment';
export const HUB_TICKET_ROW_COLUMNS = 'id,title,type,category,priority,status,created_at';
// `assignee_user_id` is read for the office's bell when the customer replies (notifyClientReplied:
// the assignee first) and is never served — the projection has no place for it.
export const HUB_TICKET_COLUMNS = 'id,client_id,client_name,site_id,origin,title,description,type,category,priority,status,assignee_user_id,created_at,resolved_at,raised_by_client_user_id,raised_by_client_name';
// QR-16 / QR-23 (2026-10-17): the AREA a request is about (`site_area_id`, with its location so the
// route names it from that location's own list) joins the customer's own requests once the column
// exists — migration 20261017110000 is written, not applied, and until it is, these reads select
// exactly what they did (../qc/ticketColumns.js probes). Never a visitor's name or contact: no list
// here names them, and a visitor's ticket is not origin portal anyway (QR-26).
export const HUB_TICKET_AREA_COLUMN = 'site_area_id';
const ticketRowColumns = async (db) => ((await ticketAreaColumnReady(db)) ? `${HUB_TICKET_ROW_COLUMNS},site_id,${HUB_TICKET_AREA_COLUMN}` : HUB_TICKET_ROW_COLUMNS);
const ticketColumns = async (db) => ((await ticketAreaColumnReady(db)) ? `${HUB_TICKET_COLUMNS},${HUB_TICKET_AREA_COLUMN}` : HUB_TICKET_COLUMNS);
export const HUB_MESSAGE_COLUMNS = 'id,problem_id,author_role,author_name,author_client_user_id,body,translated_body,created_at';
const HUB_MEDIA_COLUMNS = 'id,kind,caption,area_id,ref_id,storage_path,thumb_path,created_at';

// ── bounds (rule 3) ───────────────────────────────────────────────────────────
// One ticket's conversation: the newest this many, shown oldest first. A real thread is a
// handful of lines; the bound exists so no thread is ever an unbounded read (CS-248).
export const HUB_THREAD_MAX = 200;
// Photos signed per page, in parallel — never a serial loop over a long list (CS-248).
export const HUB_PHOTO_MAX = 40;
// A checklist's photo ROWS read to learn which items carry one (the "photo required" rule
// needs every key, not just the signed ones). One submission's photos; ~one per item.
const CHECKLIST_PHOTO_SCAN = 300;
// The tickets read for the history's "ticket raised" rows and its ticket filter. A building
// raises a handful a month; a year is far inside this.
const HISTORY_TICKET_MAX = 5000;

// A client ticket is one the CUSTOMER raised from the hub (origin 'portal'). The office's own
// internal tickets (origin 'internal') are its working notes about the building and are never
// a client's to read, list, count or be emailed about.
export const CLIENT_TICKET_ORIGIN = 'portal';

// ── who is on site now (HUB-5) ────────────────────────────────────────────────
// Read as part of the visit's punches (visitPunches, below: every punch clocked in since the
// start of yesterday, open and closed); the pure rule (clientHubView hubOnSiteList) keeps the
// open ones inside the on-site window, drops voided / no-show rows and folds one person's two
// punches into one.

// The building's client tickets that are not completed, inside the window (the same window
// the list pages through, so the count can never name a ticket the list cannot show).
export async function openTicketCount({ clientId, sinceIso }, db = getSupabase()) {
  const { count } = must(await org(db.from('problem_reports').select('id', { count: 'exact', head: true }))
    .eq('client_id', clientId)
    .eq('origin', CLIENT_TICKET_ORIGIN)
    .neq('status', 'resolved')
    .gte('created_at', sinceIso), 'open ticket count failed');
  return exactCount(count);
}

// ── lists: one page and the exact total ───────────────────────────────────────
async function page(db, table, { columns, filters, timeCol, offset, limit }, what) {
  const base = (cols, opts) => filters(org(db.from(table).select(cols, opts)));
  const [counted, rows] = await Promise.all([
    base('id', { count: 'exact', head: true }),
    base(columns)
      .order(timeCol, { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + limit - 1),
  ]);
  must(counted, `${what} count failed`);
  must(rows, `${what} read failed`);
  return { rows: rows.data || [], total: exactCount(counted.count) };
}

export function pageChecklists({ clientId, sinceIso, offset, limit }, db = getSupabase()) {
  return page(db, 'checklist_results', {
    columns: HUB_CHECKLIST_ROW_COLUMNS, timeCol: 'performed_at', offset, limit,
    filters: (q) => q.eq('client_id', clientId).gte('performed_at', sinceIso),
  }, 'checklists');
}

// SUBMITTED only: a draft is the inspector's unfinished work, never the client's to read.
export function pageInspections({ clientId, sinceIso, offset, limit }, db = getSupabase()) {
  return page(db, 'inspection_records', {
    columns: HUB_INSPECTION_ROW_COLUMNS, timeCol: 'performed_at', offset, limit,
    filters: (q) => q.eq('client_id', clientId).eq('status', 'submitted').gte('performed_at', sinceIso),
  }, 'inspections');
}

export async function pageTickets({ clientId, sinceIso, offset, limit }, db = getSupabase()) {
  return page(db, 'problem_reports', {
    columns: await ticketRowColumns(db), timeCol: 'created_at', offset, limit,
    filters: (q) => q.eq('client_id', clientId).eq('origin', CLIENT_TICKET_ORIGIN).gte('created_at', sinceIso),
  }, 'tickets');
}

// The history page's checklists, by id AND building: their items and counts, so the page's lines
// read a "not completed" task as not done (activityLog.checklistEventDetail). Only the ids on the
// page asked for (≤ HUB_PAGE_MAX) — the year's window itself is read without items.
export const HUB_HISTORY_CHECKLIST_COLUMNS = 'id,completed_count,total_count,items';
export async function checklistItemsByIds({ clientId, ids }, db = getSupabase()) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x))];
  if (!clientId || !list.length) return new Map();
  const { data } = must(await org(db.from('checklist_results').select(HUB_HISTORY_CHECKLIST_COLUMNS))
    .eq('client_id', clientId).in('id', list), 'history checklists read failed');
  return new Map((data || []).map((r) => [r.id, r]));
}

// ── one record, by id AND building (rule 1) ───────────────────────────────────
export async function getChecklist({ clientId, id, sinceIso }, db = getSupabase()) {
  const { data } = must(await org(db.from('checklist_results').select(HUB_CHECKLIST_COLUMNS))
    .eq('id', id).eq('client_id', clientId).gte('performed_at', sinceIso)
    .maybeSingle(), 'checklist read failed');
  return data || null;
}

export async function getInspection({ clientId, id, sinceIso }, db = getSupabase()) {
  const { data } = must(await org(db.from('inspection_records').select(HUB_INSPECTION_COLUMNS))
    .eq('id', id).eq('client_id', clientId).eq('status', 'submitted').gte('performed_at', sinceIso)
    .maybeSingle(), 'inspection read failed');
  return data || null;
}

// The items the report and the redo read. An inspection's own items: a schema's worth.
export async function inspectionItems(inspectionId, db = getSupabase()) {
  const { data } = must(await db.from('inspection_items').select(HUB_INSPECTION_ITEM_COLUMNS)
    .eq('inspection_id', inspectionId)
    .order('id', { ascending: true })
    .limit(1000), 'inspection items read failed');
  return data || [];
}

export async function getTicket({ clientId, id, sinceIso }, db = getSupabase()) {
  const { data } = must(await org(db.from('problem_reports').select(await ticketColumns(db)))
    .eq('id', id).eq('client_id', clientId).eq('origin', CLIENT_TICKET_ORIGIN).gte('created_at', sinceIso)
    .maybeSingle(), 'ticket read failed');
  return data || null;
}

// A ticket read by id ALONE — for the create path's replay check, where the caller-minted id
// may already name a ticket (this person's double-tap, or someone else's record entirely).
// The route compares every field it relies on before treating it as a replay.
export async function ticketById(id, db = getSupabase()) {
  const { data } = must(await org(db.from('problem_reports').select(await ticketColumns(db)))
    .eq('id', id).maybeSingle(), 'ticket read failed');
  return data || null;
}

// 🔴 WO-9: THE CLIENT'S VIEW OF A THREAD. `internal = false` is IN THE QUERY, so an office note
// is never fetched for a client at all (test-client-hub-routes.mjs reads the query log). The
// newest HUB_THREAD_MAX lines, returned oldest first.
export async function ticketThread(problemId, db = getSupabase()) {
  const { data } = must(await org(db.from('work_order_messages').select(HUB_MESSAGE_COLUMNS))
    .eq('problem_id', problemId)
    .eq('internal', false)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(HUB_THREAD_MAX), 'thread read failed');
  return (data || []).slice().reverse();
}

// A message read by id — the send path's replay check (same reason as ticketById).
export async function messageById(id, db = getSupabase()) {
  const { data } = must(await org(db.from('work_order_messages').select(`${HUB_MESSAGE_COLUMNS},internal`))
    .eq('id', id).maybeSingle(), 'message read failed');
  return data || null;
}

// ── photos ────────────────────────────────────────────────────────────────────
async function mediaRows({ refId, scope, imagesOnly, limit }, db) {
  let q = org(db.from('account_media').select(HUB_MEDIA_COLUMNS)).eq('ref_id', refId).eq('scope', scope);
  if (imagesOnly) q = q.eq('kind', 'image');
  const { data } = must(await q
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .limit(limit), 'photo read failed');
  return data || [];
}

// Sign at most HUB_PHOTO_MAX rows, all at once. signMediaRow is best-effort per URL (a missing
// object comes back with a null url, and the screen shows the row without it).
const signAll = (rows) => Promise.all(rows.slice(0, HUB_PHOTO_MAX).map((r) => signMediaRow(r)));

// A record's photos, signed for this request: a ticket's (the client's own, scope
// 'client_ticket'; the office's completion photos, 'problem_report') or an inspection's.
export async function signedPhotos({ refId, scope, imagesOnly = true }, db = getSupabase()) {
  if (!refId) return [];
  return signAll(await mediaRows({ refId, scope, imagesOnly, limit: HUB_PHOTO_MAX }, db));
}

// How many photos the CLIENT has attached to one ticket (the per-ticket cap).
export async function clientPhotoCount(ticketId, db = getSupabase()) {
  const { count } = must(await org(db.from('account_media').select('id', { count: 'exact', head: true }))
    .eq('ref_id', ticketId).eq('scope', 'client_ticket'), 'photo count failed');
  return exactCount(count);
}

// A checklist's item photos (HUB-15): account_media scope 'checklist', ref_id = the
// submission's own client_submit_id, area_id = the ITEM key. `keys` is every item that HAS a
// photo — what the office's "photo required" rule counts — and `photos` the ones signed.
export async function checklistPhotos(submissionId, db = getSupabase()) {
  if (!submissionId) return { keys: [], photos: [] };
  const rows = await mediaRows({ refId: submissionId, scope: 'checklist', imagesOnly: false, limit: CHECKLIST_PHOTO_SCAN }, db);
  const keys = [...new Set(rows.map((r) => r.area_id).filter((k) => typeof k === 'string' && k))];
  return { keys, photos: await signAll(rows.filter((r) => r.kind === 'image')) };
}

// ── history (HUB-9) ───────────────────────────────────────────────────────────
// The building's CLIENT tickets in the window — the history's "ticket raised" rows and the
// filter that keeps an internal ticket's status changes out of it.
export async function historyTickets({ clientId, sinceIso }, db = getSupabase()) {
  const filters = (q) => org(q).eq('client_id', clientId).eq('origin', CLIENT_TICKET_ORIGIN).gte('created_at', sinceIso);
  return selectAll({
    count: async () => exactCount(must(await filters(db.from('problem_reports').select('id', { count: 'exact', head: true })), 'ticket count failed').count),
    page: async (from, to) => must(await filters(db.from('problem_reports').select('id,client_id,title,created_at'))
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(from, to), 'ticket read failed').data || [],
    maxRows: HISTORY_TICKET_MAX,
  });
}

// ── the client hub redesign (2026-10-08): Home, Today's Visit, the view's extras ───
// The same three rules as everything above: the building is in the query, a declared column
// list, bounded and ordered. The crew status these feed is the pure rule in src/lib/hubVisit.js.
//
// A job is read as its indexed columns plus four named fields of its payload — never the whole
// `data` (notes, access codes and pay notes live there). `crew_ids` and `cover_for` decide only
// whether a checklist is expected (crewChecklist.checklistFor) and are never served.
export const HUB_VISIT_JOB_COLUMNS = 'id,start_at,status,client_id,end_at:data->>endAt,crew_ids:data->crewIds,cover_for:data->coverFor';
export const HUB_VISIT_PUNCH_COLUMNS = `${HUB_ON_SITE_COLUMNS},job_id`;
export const HUB_VISIT_CHECKLIST_COLUMNS = 'id,job_id,completed_by_user_id,completed_count,total_count,items,performed_at';
export const HUB_TILE_CHECKLIST_COLUMNS = 'id,completed_count,total_count,items,performed_at';
export const HUB_GROUP_COLUMNS = 'id,name';

// One building's two days of visits, punches and saves: a crew, a few cleans — never a crowd.
export const HUB_VISIT_JOB_MAX = 200;
export const HUB_VISIT_PUNCH_MAX = 200;
export const HUB_VISIT_CHECKLIST_MAX = 100;
// The groups one login is assigned (a city's facility director: a few), and their buildings —
// read COMPLETE (CS-675): a `.limit(5000)` came back at PostgREST's 1,000, so a login holding two
// regions saw part of their buildings listed. The bound only keeps a broken loop from running on.
const HUB_GROUP_MAX = 200;
const HUB_GROUP_MEMBER_MAX = 20000;

// The building's jobs starting in [fromIso, toIso) (hubVisitWindow: yesterday and today, so a
// night clean that began before midnight is still its own visit).
export async function visitJobs({ clientId, fromIso, toIso }, db = getSupabase()) {
  const { data } = must(await org(db.from('jobs').select(HUB_VISIT_JOB_COLUMNS))
    .eq('client_id', clientId)
    .gte('start_at', fromIso).lt('start_at', toIso)
    .order('start_at', { ascending: true }).order('id', { ascending: true })
    .limit(HUB_VISIT_JOB_MAX), 'visit jobs read failed');
  return data || [];
}

// The building's next upcoming visits after `afterIso`, soonest first.
export async function upcomingJobs({ clientId, afterIso, limit }, db = getSupabase()) {
  const { data } = must(await org(db.from('jobs').select(HUB_VISIT_JOB_COLUMNS))
    .eq('client_id', clientId)
    .eq('status', 'upcoming')
    .gt('start_at', afterIso)
    .order('start_at', { ascending: true }).order('id', { ascending: true })
    .limit(limit), 'upcoming jobs read failed');
  return data || [];
}

// The building's punches clocked in since `sinceIso` — open AND closed (the status rule needs the
// day's check-outs as well as who is on site now). The 7 HUB-5 columns plus the job it names.
export async function visitPunches({ clientId, sinceIso }, db = getSupabase()) {
  const { data } = must(await org(db.from('time_entries').select(HUB_VISIT_PUNCH_COLUMNS))
    .eq('client_id', clientId)
    .gte('clock_in_at', sinceIso)
    .order('clock_in_at', { ascending: true }).order('id', { ascending: true })
    .limit(HUB_VISIT_PUNCH_MAX), 'visit punches read failed');
  return data || [];
}

// The building's checklist saves since `sinceIso`: who saved, how many items, when — never the
// items themselves (the Checklists page reads one by id).
export async function visitChecklists({ clientId, sinceIso }, db = getSupabase()) {
  const { data } = must(await org(db.from('checklist_results').select(HUB_VISIT_CHECKLIST_COLUMNS))
    .eq('client_id', clientId)
    .gte('performed_at', sinceIso)
    .order('performed_at', { ascending: true }).order('id', { ascending: true })
    .limit(HUB_VISIT_CHECKLIST_MAX), 'visit checklists read failed');
  return data || [];
}

// 🔴 THE VISIT'S BEFORE/AFTER PHOTOS — the cleaner's own (components/CrewJobVisit.jsx steps 2 and 4:
// scope 'clean', ref_id = the job, area_id 'before' | 'after'). The BUILDING is in the query as well
// as the job ids, so a job id from another building comes back as nothing. Images only (the
// design says photos; videos stay office-side). At most HUB_VISIT_PHOTO_MAX are signed, picked by
// hubVisitPhotoPick; `total` counts them all for the "+N".
export async function visitPhotos({ clientId, jobIds }, db = getSupabase()) {
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).filter((x) => typeof x === 'string' && x))];
  if (!clientId || !ids.length) return { photos: [], total: 0 };
  const filters = (q) => org(q).eq('client_id', clientId).eq('scope', HUB_VISIT_PHOTO_SCOPE)
    .in('ref_id', ids).in('area_id', [...HUB_VISIT_PHOTO_AREAS]).eq('kind', 'image');
  const [counted, rows] = await Promise.all([
    filters(db.from('account_media').select('id', { count: 'exact', head: true })),
    filters(db.from('account_media').select(HUB_MEDIA_COLUMNS))
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .limit(HUB_VISIT_PHOTO_SCAN),
  ]);
  must(counted, 'visit photo count failed');
  must(rows, 'visit photo read failed');
  const picked = hubVisitPhotoPick(rows.data || []);
  return { photos: await Promise.all(picked.map((r) => signMediaRow(r))), total: exactCount(counted.count) };
}

// The Home tile's checklist saves: today's (from the org day's start) and the newest in the window.
export async function tileChecklists({ clientId, dayStartIso, sinceIso }, db = getSupabase()) {
  const base = () => org(db.from('checklist_results').select(HUB_TILE_CHECKLIST_COLUMNS)).eq('client_id', clientId);
  const [today, last] = await Promise.all([
    base().gte('performed_at', dayStartIso)
      .order('performed_at', { ascending: false }).order('id', { ascending: false }).limit(HUB_TILE_CHECKLIST_MAX),
    base().gte('performed_at', sinceIso)
      .order('performed_at', { ascending: false }).order('id', { ascending: false }).limit(1),
  ]);
  must(today, 'checklist tile read failed');
  must(last, 'checklist tile read failed');
  const seen = new Set();
  return [...(today.data || []), ...(last.data || [])].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

// The Home tile's inspections: the newest SUBMITTED ones in the window, newest first.
export async function tileInspections({ clientId, sinceIso }, db = getSupabase()) {
  const { data } = must(await org(db.from('inspection_records').select(HUB_INSPECTION_ROW_COLUMNS))
    .eq('client_id', clientId).eq('status', 'submitted').gte('performed_at', sinceIso)
    .order('performed_at', { ascending: false }).order('id', { ascending: false })
    .limit(HUB_TREND_MAX), 'inspection tile read failed');
  return data || [];
}

// A few of a record's photos, signed, and how many it has in all (the tile's "+N").
export async function photoPeek({ refId, scope, max }, db = getSupabase()) {
  if (!refId) return { photos: [], total: 0 };
  const [rows, counted] = await Promise.all([
    mediaRows({ refId, scope, imagesOnly: true, limit: max }, db),
    org(db.from('account_media').select('id', { count: 'exact', head: true })).eq('ref_id', refId).eq('scope', scope).eq('kind', 'image'),
  ]);
  must(counted, 'photo count failed');
  return { photos: await signAll(rows), total: exactCount(counted.count) };
}

// ── the time-to-resolve tile (Matt, the Oct 6 call; plan 2026-10-11 §4, D10/D11) ──
// EVERY one of the building's CLIENT requests resolved since `resolvedSinceIso`, inside the hub's
// year (`sinceIso` on created_at — the same set the customer's Requests list pages through, so the
// figure can be checked against it). COMPLETE, count-first through selectAll: no page cap that
// silently drops rows (CS-640). The columns are the rule's inputs and nothing else — the deadline
// is derived from type and urgency (lib/resolveTime), so `due_at` is not read either.
export const HUB_RESOLVE_COLUMNS = 'id,type,priority,status,created_at,resolved_at';
// A building's month of requests: a handful. The bound only keeps a broken loop from reading forever.
const HUB_RESOLVE_MAX = 5000;
export async function resolvedTickets({ clientId, sinceIso, resolvedSinceIso }, db = getSupabase()) {
  const filters = (q) => org(q).eq('client_id', clientId).eq('origin', CLIENT_TICKET_ORIGIN).eq('status', 'resolved')
    .gte('resolved_at', resolvedSinceIso).gte('created_at', sinceIso);
  return selectAll({
    count: async () => exactCount(must(await filters(db.from('problem_reports').select('id', { count: 'exact', head: true })), 'resolved ticket count failed').count),
    page: async (from, to) => must(await filters(db.from('problem_reports').select(HUB_RESOLVE_COLUMNS))
      .order('resolved_at', { ascending: false }).order('id', { ascending: false })
      .range(from, to), 'resolved ticket read failed').data || [],
    maxRows: HUB_RESOLVE_MAX,
  });
}

// The client tickets in one set of statuses (the Home tile's "in progress" and "needs your
// reply"; the open total is openTicketCount above).
export async function ticketCountIn({ clientId, sinceIso, statuses }, db = getSupabase()) {
  const { count } = must(await org(db.from('problem_reports').select('id', { count: 'exact', head: true }))
    .eq('client_id', clientId)
    .eq('origin', CLIENT_TICKET_ORIGIN)
    .in('status', statuses)
    .gte('created_at', sinceIso), 'ticket count failed');
  return exactCount(count);
}

// The groups this login is ASSIGNED (never a group they only share a building with), with their
// names and members — the view's "4 locations under Bayside Property Group". The projection
// (clientHub.projectHubGroups) keeps only the buildings in the login's scope.
export async function viewerGroups({ clientUserId }, db = getSupabase()) {
  const assigned = must(await org(db.from('client_user_assignments').select('group_id'))
    .eq('client_user_id', clientUserId)
    .not('group_id', 'is', null)
    .order('group_id', { ascending: true })
    .limit(HUB_GROUP_MAX), 'group assignments read failed').data || [];
  const ids = [...new Set(assigned.map((a) => a.group_id).filter(Boolean))];
  if (!ids.length) return { assignedGroupIds: [], groups: [], members: [] };
  // The membership table's key is (group_id, client_id) — it has no `id` column.
  const memberFilters = (q) => org(q).in('group_id', ids);
  const [groups, members] = await Promise.all([
    org(db.from('client_user_groups').select(HUB_GROUP_COLUMNS)).in('id', ids)
      .order('name', { ascending: true }).order('id', { ascending: true }).limit(HUB_GROUP_MAX),
    selectAll({
      count: async () => exactCount(must(await memberFilters(db.from('client_user_group_members').select('group_id', { count: 'exact', head: true })), 'group member count failed').count),
      page: async (from, to) => must(await memberFilters(db.from('client_user_group_members').select('group_id,client_id'))
        .order('group_id', { ascending: true }).order('client_id', { ascending: true })
        .range(from, to), 'group members read failed').data || [],
      keyOf: (m) => `${m.group_id}|${m.client_id}`,
      maxRows: HUB_GROUP_MEMBER_MAX,
    }),
  ]);
  must(groups, 'groups read failed');
  return {
    assignedGroupIds: ids,
    groups: groups.data || [],
    members: members.map((m) => ({ groupId: m.group_id, clientId: m.client_id })),
  };
}

// 🔴 EVERY BUILDING'S NEXT VISIT IN ONE BOUNDED QUERY (migration 20261008100000): the
// service-role-only function `hub_next_visits` answers `distinct on (client_id)` the soonest
// upcoming job from `fromIso` within 60 days — one row a building, never one query a building
// (a city's facility director sees dozens). → Map clientId → ISO start.
export async function nextVisits({ clientIds, fromIso }, db = getSupabase()) {
  const ids = [...new Set((Array.isArray(clientIds) ? clientIds : []).filter((x) => typeof x === 'string' && x))];
  if (!ids.length) return new Map();
  const { data } = must(await db.rpc('hub_next_visits', { p_org: CLEANSPACE_ORG_ID, p_client_ids: ids, p_from: fromIso }), 'next visits read failed');
  const out = new Map();
  for (const r of Array.isArray(data) ? data : []) {
    const t = Date.parse(r?.start_at);
    if (r?.client_id && Number.isFinite(t) && ids.includes(r.client_id)) out.set(r.client_id, new Date(t).toISOString());
  }
  return out;
}
