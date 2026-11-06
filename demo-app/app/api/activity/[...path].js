// Activity log API (CS-379; Matt's LOG-1..8). READ-ONLY: nothing here writes a row — the
// log is written only by api/_lib/activityLog.js at each action's own write point, under the
// service role, so a browser can neither forge nor edit an entry.
//
//   GET /api/activity/list    [?fromIso&toIso&clientId&actorUserId&group&offset&limit]
//                             -> { entries, total, offset, limit, scope }  newest first, paged
//   GET /api/activity/export  ?format=csv|pdf [&clientId&fromIso&toIso]
//                             -> the dispute pack for one customer over a date range (LOG-6),
//                                read COMPLETE (paged to the count, never a capped page)
//
// AUTH: `activity.view` from the committed matrix (requirePermission), and then LOG-4's
// visibility applied to the DATA: the owner sees everything; an admin everything except pay
// and money changes; a manager only the customers they supervise; crew nothing at all.
// Crew's "nothing" is a ROLE FLOOR, not a key — `can()` puts no key out of a per-user
// grant's reach, so a granted cleaner would otherwise read the whole company's trail
// (the same reasoning as canEndAccess and time.clockRules). See src/lib/activityLog.js
// logVisibilityFor; the scope is applied as a SQL predicate, so `total` never lies.
import { requirePermission } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { isoParam, idParam, intParam } from '../_lib/queryParams.js';
import {
  countActivity, pageActivity, listActivityAll, activityScopeFor,
} from '../_lib/activityLog.js';
import { mapActivityRow, ACTION_GROUPS, actionsForGroup } from '../../src/lib/activityLog.js';
import {
  activityCsv, buildActivityLogHtml, activityExportFilename,
  ACTIVITY_PRINT_HEADER, ACTIVITY_PRINT_FOOTER,
} from '../../src/lib/activityLogExport.js';
import { DEFAULT_ORG_TIMEZONE } from '../../src/lib/dates.js';

// The PDF launches headless chromium; the CSV pages a year of entries. Both need more than
// the platform default (mirrors the qc + quotes routes).
export const config = { maxDuration: 60 };

const PAGE_MAX = 200;            // one screen page of the report
const OFFSET_MAX = 1000000;
const EXPORT_MAX_DAYS = 400;     // a dispute reaches back a year; the backstop is a bit more
const EXPORT_MAX_ROWS = 50000;   // a complete read, bounded so a function can finish it
const LIST_MAX_DAYS = 400;

// The window + filters, every value checked: malformed is a 400, never a filter silently
// dropped (which would WIDEN the read) and never raw text handed to PostgREST.
function filterParams(req, res, { maxDays }) {
  const bad = (error) => { res.status(400).json({ error }); return false; };
  const fromIso = isoParam(req.query.fromIso);
  const toIso = isoParam(req.query.toIso);
  if (fromIso === undefined || toIso === undefined) return bad('fromIso / toIso must be ISO-8601 timestamps');
  if (fromIso && toIso) {
    const span = Date.parse(toIso) - Date.parse(fromIso);
    if (span < 0) return bad('The date range must run forward');
    if (span > maxDays * 86400000) return bad(`The date range must span at most ${maxDays} days`);
  }
  const clientId = idParam(req.query.clientId);
  if (clientId === undefined) return bad('clientId is malformed');
  const actorUserId = idParam(req.query.actorUserId);
  if (actorUserId === undefined) return bad('actorUserId is malformed');
  // `group` is one of the report's Action-type options; its member actions come from the
  // shared registry, so the screen and the route can't drift on what a group means.
  const group = req.query.group ? String(req.query.group) : null;
  if (group && !ACTION_GROUPS.some((g) => g.id === group)) {
    return bad(`group must be one of ${ACTION_GROUPS.map((g) => g.id).join(', ')}`);
  }
  return { fromIso, toIso, clientId, actorUserId, actions: group ? actionsForGroup(group) : null };
}

export default function handler(req, res) {
  // One request, one blob read: the scope needs the customers slice and the export needs the
  // company timezone, and both reads go through the request cache.
  return withRequestCache(() => activityHandler(req, res));
}

async function activityHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;

  try {
    if (action === 'list' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'activity.view');
      if (!g) return;
      const filters = filterParams(req, res, { maxDays: LIST_MAX_DAYS });
      if (!filters) return;
      const scope = await scopeFor(g);
      if (scope.refused) return refuseVisibility(res);
      const limit = intParam(req.query.limit, 50, 1, PAGE_MAX);
      const offset = intParam(req.query.offset, 0, 0, OFFSET_MAX);
      const [total, rows] = await Promise.all([
        countActivity(filters, scope),
        pageActivity(filters, scope, { offset, limit }),
      ]);
      return res.status(200).json({
        entries: rows.map(mapActivityRow),
        total, offset, limit,
        scope: { visibility: scope.visibility, customers: scope.clientIds ? scope.clientIds.length : null },
      });
    }

    // LOG-6: one customer, one date range, a PDF and a spreadsheet. The read is COMPLETE
    // (selectAll pages to the count and throws rather than serving a short set) — a dispute
    // pack that quietly stops at 1,000 rows is worse than no pack at all.
    if (action === 'export' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'activity.view');
      if (!g) return;
      const format = req.query.format === 'pdf' ? 'pdf' : 'csv';
      const filters = filterParams(req, res, { maxDays: EXPORT_MAX_DAYS });
      if (!filters) return;
      const { scope, clients, users, tz } = await scopeAndCompany(g);
      if (scope.refused) return refuseVisibility(res);
      const entries = (await listActivityAll(filters, scope, { maxRows: EXPORT_MAX_ROWS })).map(mapActivityRow);
      // The customer's name for the document head + the file name. A row's own client_name is
      // the write-time snapshot; the current roster name is what the reader recognizes today.
      const clientName = filters.clientId
        ? (clients.find((c) => c.id === filters.clientId)?.name || entries.find((e) => e.clientName)?.clientName || filters.clientId)
        : null;
      const named = { clientName, fromIso: filters.fromIso, toIso: filters.toIso, tz };
      const usersById = new Map(users.map((u) => [u.id, u]));
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${activityExportFilename('csv', named)}"`);
        return res.status(200).send(activityCsv(entries, { tz, usersById }));
      }
      const { launchBrowser } = await import('../_lib/pdf/chromium.js');
      const html = buildActivityLogHtml({
        entries, clientName, fromIso: filters.fromIso, toIso: filters.toIso, tz, usersById,
        generatedAt: new Date().toISOString(),
        // Say so on the document when the reader was not served everything, so a pack can
        // never be mistaken for the complete record.
        viewerNote: scope.noMoney && scope.visibility === 'no-money'
          ? 'Pay and money changes are not included at your access level.'
          : null,
      });
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        const pdf = await page.pdf({
          format: 'letter',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: ACTIVITY_PRINT_HEADER,
          footerTemplate: ACTIVITY_PRINT_FOOTER,
          margin: { top: '0.4in', bottom: '0.5in', left: '0.35in', right: '0.35in' },
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${activityExportFilename('pdf', named)}"`);
        return res.status(200).send(Buffer.from(pdf));
      } finally {
        await browser.close();
      }
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    // A short or oversized complete read answers 503 / 413 with its own meaning rather than
    // an opaque 500 (pagedSelect readErrorStatus).
    const status = readErrorStatus(e);
    if (status) return res.status(status).json({ error: e.message, code: status === 413 ? 'too-many-rows' : 'incomplete-read' });
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}

// LOG-4's visibility for this caller. Only a MANAGER's scope needs the customers slice (who
// they supervise), so the list read pays for it only for a manager — an owner or admin gets
// their scope with no blob read at all, and crew are refused before any read.
//
// A failed read leaves `clients` empty, which for a manager means an EMPTY scope: they see
// nothing rather than everything. Fail closed.
async function scopeFor(g) {
  if (g.role !== 'manager') return activityScopeFor(g, []);
  // The roster rides along so an Operations Manager reads their TEAM's customers (S131); a failed
  // read leaves both empty — an empty scope, never everything.
  const { clients, users } = await readClientsAndUsers();
  return activityScopeFor(g, clients, users);
}

async function readClientsAndUsers() {
  try {
    const slices = await readProtectedSlices('clients:state->clients,users:state->users');
    return {
      clients: Array.isArray(slices?.clients) ? slices.clients : [],
      users: Array.isArray(slices?.users) ? slices.users : [],
    };
  } catch { return { clients: [], users: [] }; }
}

// The export needs the customers (the document's heading and file name) and the org's
// timezone whatever the role, so it reads both in one go.
async function scopeAndCompany(g) {
  let slices = null;
  try { slices = await readProtectedSlices('clients:state->clients,users:state->users,company:state->company'); } catch { slices = null; }
  const clients = Array.isArray(slices?.clients) ? slices.clients : [];
  const users = Array.isArray(slices?.users) ? slices.users : [];
  return {
    scope: activityScopeFor(g, clients, users),
    clients,
    // The roster, so a row whose actor name was not denormalized (the hot jobs path, which
    // must not pay a name lookup per schedule change) still names the person in the document.
    users,
    tz: slices?.company?.timezone || DEFAULT_ORG_TIMEZONE,
  };
}

function refuseVisibility(res) {
  res.status(403).json({ error: 'The activity log is not available at your access level.', code: 'activity-hidden' });
  return null;
}
