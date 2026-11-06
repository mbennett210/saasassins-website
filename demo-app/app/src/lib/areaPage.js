// THE AREA PAGE (QR Wave 2, UI_RULES §175) — what the office sees when it scans a code: one area of
// one location. Matt (QR-17, 2026-10-16): "A page for that area: the last clean with the cleaner's
// name and checklist, the photo, open requests at the building, who's on site now, and buttons for
// Start inspection, New request and Open customer." QR-20: an Admin and the Super Admin get the same.
// Open customer went on 2026-11-03 (task 467 from Clean Corner's queue).
// QR-18: a manager's scan is not saved anywhere — nothing here writes.
//
// The page (pages/AreaPage.jsx) reads only what already exists, each read through its owner:
//   · the last clean and its photo — EP-200 (`GET /api/qc/areas/status?siteId=`, qcApi.areaStatus),
//     one row per area from the ONE area rule (lib/checklistAreas siteAreaStatus);
//   · the open requests — every open ticket (qcApi.listOpenProblems, CS-640), narrowed to the
//     location on the server and here, each with the queue's own clock (lib/clientRequests);
//   · who is on site — the punch read Shift Check-in uses (timeApi.entriesAll, time.view), narrowed
//     to the location and the window below.
// This module holds what the page decides from those answers. PURE and node-safe (explicit `.js`
// imports): the suite runs it under node.
import { clientRequestRows } from './clientRequests.js';
import { NOT_A_PUNCH } from './attendanceReport.js';
import { scanShowsPhoto } from './areaScan.js';

const HOUR = 3600 * 1000;
const ms = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : NaN; };

// ── where ───────────────────────────────────────────────────────────────────
// The location, its customer and the area, from the shared record — or null when the location or
// the area is gone (a removed area's code answers "no longer active" on the public page too).
export function areaPageWhere({ siteId, areaId, sites = [], clients = [] } = {}) {
  const site = (Array.isArray(sites) ? sites : []).find((s) => s && s.id === siteId) || null;
  if (!site) return null;
  const area = (Array.isArray(site.cleaningAreas) ? site.cleaningAreas : []).find((a) => a && a.id === areaId) || null;
  if (!area) return null;
  const client = site.clientId ? (Array.isArray(clients) ? clients : []).find((c) => c && c.id === site.clientId) || null : null;
  return { site, client, area };
}

// ── the last clean (EP-200's row) ───────────────────────────────────────────
// The area's row when it HAS a recorded clean, else null ("No clean recorded yet"). An area whose
// last checklist left a task undone or marked not completed records no clean (the area rule), so it
// reads as none here too.
export function areaLastClean(answer, areaId) {
  const row = (Array.isArray(answer?.areas) ? answer.areas : []).find((a) => a && a.areaId === areaId) || null;
  return row && Number.isFinite(ms(row.lastCleanedAt)) ? row : null;
}

// That clean's items for the page: done · N/A · not completed (with the cleaner's reason) · not done
// (an item the office asked a photo for whose photo could not be read reads not done — the
// fail-closed default of lib/checklistResultView).
export function areaItemsView(row) {
  return (Array.isArray(row?.items) ? row.items : []).filter(Boolean).map((i) => ({
    key: i.key || null,
    label: i.label || '',
    state: i.state || null,
    reason: i.state === 'notcompleted' && typeof i.reason === 'string' && i.reason.trim() ? i.reason.trim() : null,
    note: typeof i.note === 'string' && i.note.trim() ? i.note.trim() : null,
  }));
}

// The photo, beside a recorded clean only (lib/areaScan scanShowsPhoto — the public page's question:
// a photo under "No clean recorded yet" reads as a contradiction), else null.
export function areaPhoto(row) {
  return scanShowsPhoto(row) ? row.photo : null;
}

// "Open the full checklist": the clean's row by its id, from the rows the checklist list answered.
export function checklistRowFor(rows, resultId) {
  return (Array.isArray(rows) ? rows : []).find((r) => r && r.id === resultId) || null;
}

// ── open requests at this location ──────────────────────────────────────────
// Every open ticket at the location (resolved ones dropped), each the queue's own row —
// lib/clientRequests clientRequestRows: the work order, its type and priority, and `left`, the clock
// Client Requests counts down (the first reply, then the fix). NEWEST first: the page asks "what is
// open here", not "what is due first" (that is the queue's order).
export function areaPageRequests({ problems = [], siteId, now = Date.now(), settings = {} } = {}) {
  const here = (Array.isArray(problems) ? problems : []).filter((p) => p && p.site_id === siteId);
  return clientRequestRows(here, { now, settings }).sort((a, b) => {
    const d = (ms(b.created_at) || 0) - (ms(a.created_at) || 0);
    return d || String(b.id).localeCompare(String(a.id));
  });
}

// ── who is on site now ──────────────────────────────────────────────────────
// Someone is ON SITE when they hold an OPEN punch here: clocked in, not out (the predicate the
// server's "who is in this building right now" and Variance's "On the clock now" use, `clock_out_at`
// unset), never a punch the office deleted or marked a no-show (the attendance report's own set,
// lib/attendanceReport NOT_A_PUNCH), started inside the window. A punch left open longer than
// ON_SITE_WINDOW_HOURS is a forgotten clock-out (the office closes it on Approvals), not a person in
// the building — no clean runs that long. One row a person, since their first open clock-in here;
// who arrived last comes first.
export const ON_SITE_WINDOW_HOURS = 24;
// A minute ahead of now, so a phone whose clock runs a little fast is still read.
const FUTURE_PAD_MS = 60 * 1000;
export function onSiteReadWindow(nowMs = Date.now()) {
  return { fromIso: new Date(nowMs - ON_SITE_WINDOW_HOURS * HOUR).toISOString(), toIso: new Date(nowMs + FUTURE_PAD_MS).toISOString() };
}
export function onSiteNow({ entries = [], siteId, users = [], now = Date.now() } = {}) {
  const fromMs = now - ON_SITE_WINDOW_HOURS * HOUR;
  const toMs = now + FUTURE_PAD_MS;
  const byUser = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.site_id !== siteId || e.clock_out_at || NOT_A_PUNCH.has(e.status)) continue;
    const userId = typeof e.user_id === 'string' && e.user_id ? e.user_id : null;
    const inMs = ms(e.clock_in_at);
    if (!userId || !Number.isFinite(inMs) || inMs < fromMs || inMs > toMs) continue;
    const prev = byUser.get(userId);
    if (!prev || inMs < prev.inMs) byUser.set(userId, { inMs, entry: e });
  }
  const roster = new Map((Array.isArray(users) ? users : []).filter(Boolean).map((u) => [u.id, u]));
  return [...byUser.entries()].map(([userId, { inMs, entry }]) => {
    const user = roster.get(userId) || null;
    return { userId, user, name: user?.name || entry.user_name || '', since: new Date(inMs).toISOString() };
  }).sort((a, b) => (ms(b.since) - ms(a.since)) || a.name.localeCompare(b.name));
}

// ── New request ─────────────────────────────────────────────────────────────
// The office's ticket form (components/WorkOrderModal) opened on this location and this area: the
// area travels as `siteAreaId` (Wave 2's builder R makes the server store it; until then the route
// builds the ticket field by field and leaves it out), and the title starts as the area's name.
export function areaRequestPrefill({ siteId, area } = {}) {
  return { presetSiteId: siteId || '', presetSiteAreaId: area?.id || null, presetTitle: area?.label || '' };
}
