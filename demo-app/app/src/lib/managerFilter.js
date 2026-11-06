// The Manager filter of a page that opens on the viewer's OWN buildings — Client Requests and
// Messaging → Customers (CS-705, 2026-10-13: a manager's Home said "3 messages waiting" for their
// buildings and the Waiting view it opened listed every manager's). ONE rule, so the two pages
// cannot open differently. PURE and node-safe.
//
// The value lives in the URL (`?mgr=`, the parameter every manager-scoped page reads, so the
// owner's Manager view can carry its pick into them — CS-702):
//   ?mgr=all   → ''  (All managers)
//   ?mgr=team  → 'team' (an Operations Manager's whole team, S131 — lib/teamScope); with `?om=<an OM>`
//                for the owner or an admin, THAT Operations Manager's team (the Home's tiles carry it
//                from the Operations view — lib/teamScope teamLeadFor, the routes' own rule)
//   ?mgr=<id>  → that manager
//   no ?mgr    → an OPERATIONS MANAGER whose team holds buildings: 'team'; a MANAGER who
//                supervises buildings: themselves ("Renata Cruz (me)"); anyone else — the owner,
//                an admin, a manager with no buildings yet — All managers (a "(me)" over no
//                buildings would open on nothing).
// A pick is written back as the manager, as `all` when it is All managers over a default of "me"
// (an empty value would snap straight back to the default), or as nothing.
import { TEAM, isOpsManager, teamClientIds, teamMemberIds, teamLeadFor } from './teamScope.js';

export const ALL_MANAGERS_PARAM = 'all';
export const TEAM_PARAM = TEAM;

export function defaultManagerFor(viewer, clients, users = null) {
  if (!viewer || viewer.role !== 'manager' || !viewer.id) return '';
  if (isOpsManager(viewer) && Array.isArray(users)) return teamClientIds(users, clients, viewer.id).size ? TEAM : '';
  return (Array.isArray(clients) ? clients : []).some((c) => c && c.supervisorId === viewer.id) ? viewer.id : '';
}

export function managerFilterValue({ viewer = null, clients = [], mgrParam = null, users = null } = {}) {
  if (mgrParam === ALL_MANAGERS_PARAM) return '';
  if (mgrParam != null && mgrParam !== '') return String(mgrParam);
  return defaultManagerFor(viewer, clients, users);
}

export function managerFilterParam(value, defaultManager = '') {
  if (value) return value;
  return defaultManager ? ALL_MANAGERS_PARAM : null;
}

// The filter's value as the managers it keeps, for a page that filters in the browser
// (lib/clientRequests clientRequestRows): `team` → the team lib/teamScope teamLeadFor names — the
// viewer's own (their own id when they lead none), or for the owner or an admin the Operations
// Manager in `omParam`; an id → that id; '' → everyone. A page that asks the SERVER sends the value as
// it is, with the `om` of teamPickLead below: the route runs the same rule from the caller's claim.
export function managerFilterIds(value, { viewer = null, users = [], omParam = null } = {}) {
  if (value === TEAM) {
    const lead = teamLeadFor({ role: viewer?.role || null, selfId: viewer?.id || null, users, om: omParam });
    return lead ? teamMemberIds(users, lead) : [];
  }
  return value || '';
}

// WHOSE team the owner opened (S131 Wave 2, the Operations view's tiles): when the filter is `team`
// and `omParam` names another person's team the viewer may name (teamLeadFor: the owner or an admin,
// an active Operations Manager), that Operations Manager's roster row — the page labels its filter
// "{name}'s team" and sends `om` with its reads; else null (the viewer's own team, or no team at all).
export function teamPickLead({ viewer = null, users = [], value = '', omParam = null } = {}) {
  if (value !== TEAM || !viewer) return null;
  const lead = teamLeadFor({ role: viewer.role || null, selfId: viewer.id || null, users, om: omParam });
  if (!lead || lead === viewer.id) return null;
  return (Array.isArray(users) ? users : []).find((u) => u && u.id === lead) || null;
}
