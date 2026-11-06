// THE CLIENT HUB'S RULES, PURE — what a customer login may be shown, in which words, for how long.
//
// Round 2 of the client hub (Phase 2 Wave 2) puts six things in front of a property manager:
// who is on site now (HUB-5), each checklist item by item with the cleaner's notes and photos
// (HUB-8, HUB-15), each inspection with the redo the cleaners were sent (HUB-6, HUB-7), their
// tickets in four stages they can reopen for seven days (HUB-13, WO-4, WO-8, WO-11), a year of
// service history (HUB-9, LOG-1, LOG-9) and the emails that tell them something changed (HUB-11).
//
// Every one of those is a PROJECTION the server and the login-free demo both run, so this suite
// drives the projections themselves, away from any transport:
//   · each projection is an ALLOWLIST: the served keys are exactly its declared constant, and a
//     field added to a source row tomorrow does not ride along;
//   · a person is "first name + last initial", whoever they are;
//   · an internal ticket note is never in a client-facing thread, even if a query forgot it;
//   · the four WO-8 stages, the seven-day reopen (WO-11) and the 365-day window (HUB-9) are
//     single constants, and the checks below read those constants rather than restating them.
//
// REGRESSION (THE LAW II.3): on the pre-change tree none of these modules or exports exist, so
// every check below that names one fails.
//
//   node app/scripts/test-client-hub-view.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };

const view = await tryImport('../src/lib/clientHubView.js');
const hub = await tryImport('../src/lib/clientHub.js');
const wo = await tryImport('../src/lib/workOrders.js');
const act = await tryImport('../src/lib/activityLog.js');
const mail = await tryImport('../src/lib/clientHubEmails.js');
const { projectChecklistResult } = await tryImport('../src/lib/checklistResultView.js');
const { redoAreasFor } = await tryImport('../src/lib/inspections.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail) — this repo's suites disagree on it, and a swapped
// call "passes" on a truthy label. Every check here reads a label first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const sameKeys = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).sort().join(',') === [...list].sort().join(',');
const keysWithin = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).every((k) => list.includes(k));
const DAY = 86400000;
const NOW = Date.parse('2026-10-04T15:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// ── 1. a person, as a client sees them (HUB-5) ───────────────────────────────
ok('N1 first name + last initial', () => hub.hubPersonName('Maria Gonzalez') === 'Maria G.');
ok('N2 …the LAST word of a long name gives the initial', () => hub.hubPersonName('Tomas Rivera Diaz') === 'Tomas D.');
ok('N3 …padding and doubled spaces do not change it', () => hub.hubPersonName('  Andre   Baptiste ') === 'Andre B.');
ok('N4 …a single name stays a single name', () => hub.hubPersonName('Cher') === 'Cher');
ok('N5 …nothing in, nothing out (never "undefined")', () => hub.hubPersonName(null) === '' && hub.hubPersonName('') === '' && hub.hubPersonName(42) === '42');

// ── 2. the windows (HUB-9) and paging ────────────────────────────────────────
ok('W1 a client sees one year: HUB_HISTORY_DAYS is 365', () => view.HUB_HISTORY_DAYS === 365);
ok('W2 the window starts exactly HUB_HISTORY_DAYS before now',
  () => view.hubWindowStartIso(NOW) === iso(NOW - view.HUB_HISTORY_DAYS * DAY));
ok('W3 a record inside the window is in it, one a day older is not',
  () => view.isWithinHubWindow(iso(NOW - (view.HUB_HISTORY_DAYS - 1) * DAY), NOW)
    && !view.isWithinHubWindow(iso(NOW - (view.HUB_HISTORY_DAYS + 1) * DAY), NOW)
    && !view.isWithinHubWindow('not a date', NOW));
{
  const src = readFileSync(path.join(APP, 'src/hooks/usePagedRows.js'), 'utf8').replace(/\r\n/g, '\n');
  const def = Number(/export const DEFAULT_PAGE_SIZE = (\d+);/.exec(src)?.[1]);
  ok(`P1 a hub list pages at the app's one page size (usePagedRows ${def})`, () => view.HUB_PAGE_SIZE === def);
}
ok('P2 a page with no size asks for the default; a huge one is held to the max',
  () => view.hubPage({}).limit === view.HUB_PAGE_SIZE && view.hubPage({ limit: '5000' }).limit === view.HUB_PAGE_MAX
    && view.hubPage({ offset: '-4' }).offset === 0 && view.hubPage({ offset: 'x', limit: 'y' }).offset === 0);

// ── 3. who is on site now (HUB-5) ────────────────────────────────────────────
{
  const punch = (id, user, name, minsAgo, extra = {}) => ({
    id, user_id: user, user_name: name, clock_in_at: iso(NOW - minsAgo * 60000), clock_out_at: null,
    status: 'in_progress', geofence_result: 'inside', clock_in_distance_m: 12, clock_in_lat: 26.1, clock_in_lng: -80.1,
    phone: '(754) 555-0199', pay: { hourlyRate: 22 }, ...extra,
  });
  const rows = [
    punch('t1', 'u_tomas', 'Tomas Rivera', 70),
    punch('t2', 'u_keisha', 'Keisha Bryant', 25, { geofence_result: 'unavailable' }),
    punch('t3', 'u_tomas', 'Tomas Rivera', 20),                              // a second punch, same person
    punch('t4', 'u_luis', 'Luis Ferrer', 30, { clock_out_at: iso(NOW - 60000) }), // left
    punch('t5', 'u_x', 'Voided Person', 30, { status: 'voided' }),
    punch('t6', 'u_y', 'No Show', 30, { status: 'no_show' }),
    punch('t7', 'u_z', 'Forgot Toclockout', 60 * 30),                       // 30 hours: not "now"
    punch('t8', 'u_o', 'Override Person', 10, { geofence_result: 'override' }),
  ];
  const list = view.hubOnSiteList?.(rows, NOW) || [];
  ok('O1 only the people still on the clock, within the on-site window',
    () => list.map((p) => p.name).join('|') === 'Tomas R.|Keisha B.|Override P.', JSON.stringify(list));
  ok('O2 …each served with EXACTLY the on-site allowlist', () => list.length && list.every((p) => sameKeys(p, view.HUB_ON_SITE_FIELDS)));
  ok('O3 a person with two open punches is one person, at their EARLIER arrival', () => list[0]?.minutesOnSite === 70);
  ok('O4 the location check is "inside" and nothing else — no reason, override or missing signal passes',
    () => list[0]?.locationVerified === true && list[1]?.locationVerified === false && list[2]?.locationVerified === false);
  const blob = String(JSON.stringify(list) ?? "");
  ok('O5 🔴 never the full name, the distance, coordinates, a phone, pay or an internal id',
    () => list.length > 0 && !/Rivera|Bryant|clock_in_distance|26\.1|-80\.1|555-0199|hourlyRate|u_tomas|"t1"/.test(blob), blob);
  ok('O6 the on-site window is HUB_ON_SITE_HOURS (a forgotten punch from yesterday is not "now")',
    () => Number.isFinite(view.HUB_ON_SITE_HOURS) && !view.isOnSiteNow(punch('t9', 'u_q', 'Q Q', view.HUB_ON_SITE_HOURS * 60 + 1), NOW)
      && view.isOnSiteNow(punch('t10', 'u_q', 'Q Q', view.HUB_ON_SITE_HOURS * 60 - 1), NOW));
}

// ── 4. a checklist, item by item (HUB-8, HUB-15) ─────────────────────────────
{
  const schema = { areas: [
    { id: 'a1', label: 'Floors', items: [
      { id: 'f_sweep', label: 'Swept' },
      { id: 'f_mop', label: 'Mopped', photoRequired: true },
      { id: 'f_spot', label: 'Spots treated', naAllowed: true },
      { id: 'f_edges', label: 'Edges detailed' },
    ] },
  ] };
  const row = {
    id: 'cr_1', client_id: 'cl_a', site_id: 's_a', job_id: 'j_secret', client_submit_id: 'cs_secret_ref',
    completed_by_user_id: 'u_andre', template_id: 'it_x', template_version_id: 'iv_x',
    template_snapshot: { name: 'Floor Care', kind: 'checklist', schema },
    items: [
      { key: 'f_sweep', checked: true, note: 'Muddy boots from the pool deck — swept twice.' },
      { key: 'f_mop', checked: true },
      { key: 'f_spot', na: true },
      { key: 'f_edges', checked: false, note: 'Ran out of time on the stairs.' },
    ],
    completed_count: 3, total_count: 4, performed_at: iso(NOW - DAY),
  };
  const photos = [{ id: 'm1', areaId: 'f_mop', url: 'https://x/f.jpg', thumbUrl: 'https://x/t.jpg', caption: 'After', storage_path: 'org/s/secret.jpg', uploaded_by_user_id: 'u_andre' }];
  const out = view.projectHubChecklist?.(row, { cleanerName: 'Andre Baptiste', photos });
  ok('C1 a checklist is served with EXACTLY the checklist allowlist', () => sameKeys(out, view.HUB_CHECKLIST_FIELDS), JSON.stringify(out && Object.keys(out)));
  ok('C2 …its areas and items with exactly theirs', () => out.areas.every((a) => sameKeys(a, view.HUB_CHECKLIST_AREA_FIELDS)
    && a.items.every((i) => sameKeys(i, view.HUB_CHECKLIST_ITEM_FIELDS) && i.photos.every((p) => sameKeys(p, view.HUB_PHOTO_FIELDS)))));
  const office = projectChecklistResult?.(row, { photoKeys: ['f_mop'] });
  ok('C3 the item states are the OFFICE pop-up\'s rule (checklistResultView), never a second copy',
    () => out.areas.flatMap((a) => a.items).map((i) => i.state).join(',') === office.items.map((i) => i.state).join(','));
  ok('C4 every item, checked or not, with the cleaner\'s notes (HUB-8)',
    () => out.areas[0].items.length === 4 && out.areas[0].items[0].note.startsWith('Muddy boots') && out.areas[0].items[3].state === 'notdone');
  ok('C5 the item photo sits under the item it proves (HUB-15)', () => out.areas[0].items[1].photos[0]?.url === 'https://x/f.jpg');
  ok('C6 the cleaner is first name + last initial', () => out.cleaner === 'Andre B.');
  ok('C7 the stored counts are the headline, as on the office pop-up', () => out.done === 3 && out.total === 4 && out.complete === false);
  const blob = String(JSON.stringify(out) ?? "");
  ok('C8 🔴 nothing internal rides along: no user id, job id, submission ref, storage path or template ids',
    () => !!out && !/u_andre|j_secret|cs_secret_ref|org\/s\/secret|it_x|iv_x|Baptiste/.test(blob), blob.slice(0, 300));
  const r = view.projectHubChecklistRow?.(row, { cleanerName: 'Andre Baptiste' });
  ok('C9 a list row is EXACTLY the row allowlist', () => sameKeys(r, view.HUB_CHECKLIST_ROW_FIELDS) && r.cleaner === 'Andre B.' && r.name === 'Floor Care');
}

// ── 5. an inspection, its report and the redo (HUB-6, HUB-7, HUB-16) ─────────
{
  const SECRET = 'ZZINTERNALZZ the supervisor covered for a late crew';
  const snapshot = { name: 'Restroom QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 85 }, schema: { areas: [
    { id: 'a_fix', label: 'Fixtures', items: [{ id: 'i1', label: 'Toilets' }, { id: 'i2', label: 'Sinks' }] },
    { id: 'a_sup', label: 'Supplies', items: [{ id: 'i3', label: 'Soap' }] },
  ] } };
  const items = [
    { item_key: 'i1', label: 'Fixtures. Toilets', rating: 'fail', comment: 'Scale under the rims.' },
    { item_key: 'i2', label: 'Fixtures. Sinks', rating: 'pass', comment: null },
    { item_key: 'i3', label: 'Supplies. Soap', rating: 'fail', comment: 'Two dispensers empty.' },
  ];
  const report = {
    inspection: {
      templateName: 'Restroom QC', schema: snapshot.schema, ratingScale: snapshot.rating_scale, siteName: 'Clubhouse',
      clientName: 'Coral Bay HOA', inspectorName: 'Priya Nair', overallScore: 33, result: 'fail', performedAt: iso(NOW - DAY),
      id: 'ir_1', status: 'submitted', publicToken: 'tok_secret_link', internal_note: SECRET,
    },
    items: items.map((i) => ({ itemKey: i.item_key, label: i.label, rating: i.rating, comment: i.comment, secret: SECRET })),
    photos: [{ id: 'p1', kind: 'image', url: 'https://x/p.jpg', caption: null, areaId: 'a_fix', storage_path: 'org/s/x.jpg' }],
  };
  const out = view.projectHubInspection?.({ id: 'ir_1', report, snapshot, items, internalNote: SECRET });
  ok('I1 an inspection is served with EXACTLY the inspection allowlist', () => sameKeys(out, view.HUB_INSPECTION_FIELDS), JSON.stringify(out && Object.keys(out)));
  ok('I2 …its report re-picked through the report allowlists (the authed path\'s id/status/token cannot ride along)',
    () => keysWithin(out.report.inspection, view.HUB_REPORT_INSPECTION_FIELDS)
      && out.report.items.every((i) => keysWithin(i, view.HUB_REPORT_ITEM_FIELDS))
      && out.report.photos.every((p) => keysWithin(p, view.HUB_REPORT_PHOTO_FIELDS)));
  ok('I3 the FULL report, item comments included (HUB-6)', () => out.report.items.some((i) => i.comment === 'Scale under the rims.'));
  const blob = String(JSON.stringify(out) ?? "");
  ok('I4 🔴 never the internal note (HUB-16), the share token or a storage path', () => !!out && !blob.includes(SECRET) && !blob.includes('tok_secret_link') && !blob.includes('org/s/x.jpg'), blob.slice(0, 400));
  ok('I5 the redo is the SAME areas the cleaners were sent (redoAreasFor), in the same sentence (HUB-7)',
    () => out.redo && out.redo.areas.map((a) => a.label).join(',') === redoAreasFor(snapshot, items).map((a) => a.label).join(',')
      && out.redo.areas.map((a) => a.label).join(',') === 'Fixtures,Supplies');
  // The hub is English (LANG-8) while the cleaners' notice is in their language (CS-193): the
  // sentence is the catalog's English list, and the "Other items" bucket — a catalog message
  // since Round 3 — reads as English words, never an object.
  ok('I5b …in plain English: "Fixtures and Supplies"', () => out.redo && out.redo.sentence === 'Fixtures and Supplies', JSON.stringify(out?.redo?.sentence));
  const stray = view.projectHubInspection({ id: 'ir_3', report, snapshot, items: [{ item_key: 'zz_not_in_schema', label: 'Mystery item', rating: 'fail' }] });
  ok('I5c an item outside every section lands under "Other items", in English words', () => !!stray?.redo && stray.redo.areas.some((a) => a.label === 'Other items') && typeof stray.redo.sentence === 'string' && !stray.redo.sentence.includes('[object'), JSON.stringify(stray?.redo));
  ok('I6 a clean pass sends nobody back: redo is null',
    () => view.projectHubInspection({ id: 'ir_2', report, snapshot, items: items.map((i) => ({ ...i, rating: 'pass' })) }).redo === null);
  const row = view.projectHubInspectionRow?.({ id: 'ir_1', template_name: 'Restroom QC', overall_score: 33, result: 'needs_follow_up', performed_at: iso(NOW), public_token: 'tok_x', internal_note: SECRET });
  ok('I7 a list row is EXACTLY the row allowlist, in words', () => sameKeys(row, view.HUB_INSPECTION_ROW_FIELDS) && row.resultLabel === 'Needs follow-up' && !JSON.stringify(row).includes(SECRET));
}

// ── 6. tickets: the four stages (WO-8), the seven-day reopen (WO-11) ─────────
{
  ok('T1 four stages, in the order the client lives them (WO-8)',
    () => (wo.WO_CLIENT_STAGES || []).map((s) => s.key).join(',') === 'received,working,needs_info,completed');
  ok('T2 …each office status lands on exactly one stage',
    () => (wo.WO_STATUSES || []).map((s) => wo.woClientStage(s).key).join(',') === 'received,working,needs_info,completed');
  ok('T3 …a legacy "ack" is "working on it"; an unknown status reads as received, never as completed',
    () => wo.woClientStage('ack').key === 'working' && wo.woClientStage('weird').key === 'received');
  ok('T4 the stage names are the client\'s words, not the office queue\'s',
    () => wo.woClientStage('awaiting_client').label === 'We need more information from you' && wo.woClientStage('resolved').label === 'Completed');
  const REOPEN = wo.TICKET_REOPEN_DAYS;
  ok('T5 reopening is allowed for TICKET_REOPEN_DAYS (Matt: 7)', () => REOPEN === 7);
  const resolvedAgo = (ms) => ({ status: 'resolved', resolvedAt: iso(NOW - ms), now: NOW });
  ok('T6 …inside the window a completed ticket can be reopened', () => wo.ticketReopenRefusal(resolvedAgo(REOPEN * DAY - 60000)) === null);
  ok('T7 …at the edge it still can; a minute past, it cannot',
    () => wo.ticketReopenRefusal(resolvedAgo(REOPEN * DAY)) === null && wo.ticketReopenRefusal(resolvedAgo(REOPEN * DAY + 60000)) === 'reopen-window-closed');
  ok('T8 …a ticket that is not completed is not "reopened"', () => wo.ticketReopenRefusal({ status: 'in_progress', resolvedAt: null, now: NOW }) === 'not-completed');
  ok('T9 …a completed ticket with no completion time fails CLOSED', () => wo.ticketReopenRefusal({ status: 'resolved', resolvedAt: null, now: NOW }) === 'reopen-window-closed');
  ok('T10 the deadline the client is shown is the same arithmetic', () => wo.ticketReopenDeadline(iso(NOW)) === iso(NOW + REOPEN * DAY));

  const SECRET = 'ZZINTERNALNOTEZZ quote this as an add-on first';
  const ticket = {
    id: 'pr_1', client_id: 'cl_a', site_id: 's_a', origin: 'portal', title: 'Coffee stain', description: 'Big stain by the board table.',
    type: 'complaint', category: 'spill', priority: 'high', status: 'resolved', created_at: iso(NOW - 3 * DAY), resolved_at: iso(NOW - 2 * DAY),
    raised_by_client_user_id: 'cu_me', raised_by_client_name: 'Sasha Lin', assignee_user_id: 'u_priya', reported_by_user_id: null, escalated_at: null, due_at: iso(NOW),
  };
  const messages = [
    { id: 'm1', author_role: 'client', author_name: 'Sasha Lin', author_client_user_id: 'cu_me', author_user_id: null, body: 'Can it be treated?', created_at: iso(NOW - 3 * DAY), internal: false },
    { id: 'm2', author_role: 'office', author_name: 'Renata Cruz', author_client_user_id: null, author_user_id: 'u_mgr1', body: SECRET, created_at: iso(NOW - 3 * DAY + 60000), internal: true },
    { id: 'm3', author_role: 'crew', author_name: 'Priya Nair', author_user_id: 'u_priya', body: 'Treated and extracted.', translated_body: null, created_at: iso(NOW - 2 * DAY), internal: false },
    { id: 'm4', author_role: 'client', author_name: 'Jordan Wells', author_client_user_id: 'cu_other', body: 'Thank you!', created_at: iso(NOW - DAY), internal: false },
  ];
  const out = view.projectHubTicket?.(ticket, { messages, viewerClientUserId: 'cu_me', now: NOW, photos: [], completionPhotos: [{ id: 'cp1', url: 'https://x/after.jpg', thumbUrl: null, caption: 'After', storage_path: 'secret/path.jpg' }] });
  ok('T11 a ticket is served with EXACTLY the ticket allowlist', () => sameKeys(out, view.HUB_TICKET_FIELDS), JSON.stringify(out && Object.keys(out)));
  ok('T12 …its messages with exactly theirs', () => out.messages.every((m) => sameKeys(m, view.HUB_MESSAGE_FIELDS)));
  ok('T13 🔴 an INTERNAL note never reaches the client thread, even when a query let one through (WO-9)',
    () => !JSON.stringify(out).includes(SECRET) && out.messages.length === 3);
  ok('T14 the viewer\'s own messages read "You"; another client user and our team are first name + last initial',
    () => out.messages.map((m) => `${m.from}:${m.author}`).join('|') === 'you:You|team:Priya N.|client:Jordan W.');
  ok('T15 the stage, the retired "high" read as urgent (WO-18), and the completion photo',
    () => out.stage === 'completed' && out.urgent === true && out.completionPhotos[0]?.url === 'https://x/after.jpg');
  ok('T16 can reopen, until the deadline the rule computes (WO-11)', () => out.canReopen === true && out.reopenUntil === wo.ticketReopenDeadline(ticket.resolved_at));
  ok('T17 nothing internal rides along: no assignee, office user ids, storage paths or the raiser\'s id',
    () => !!out && !/u_priya|u_mgr1|secret\/path|cu_me|due_at|assignee/.test(JSON.stringify(out)));
  const row = view.projectHubTicketRow?.(ticket);
  ok('T18 a list row is EXACTLY the row allowlist', () => sameKeys(row, view.HUB_TICKET_ROW_FIELDS) && row.stageLabel === 'Completed');

  // The client's form, validated by ONE rule the route and the demo both run.
  const good = view.hubTicketInput?.({ type: 'complaint', category: 'spill', description: '  Spill in the lobby by the mailboxes.\nPlease send someone.  ', urgent: true, admin: true });
  ok('T19 a ticket the client may raise: type, category, description, urgent (WO-4, WO-12)',
    () => good?.value && good.value.type === 'complaint' && good.value.category === 'spill' && good.value.urgent === true
      && good.value.title === 'Spill in the lobby by the mailboxes.' && !('admin' in good.value));
  ok('T20 …a missing type, an unknown category or an empty description is refused with a code',
    () => view.hubTicketInput({ category: 'spill', description: 'x' }).code === 'ticket-type'
      && view.hubTicketInput({ type: 'request', category: 'gold', description: 'x' }).code === 'ticket-category'
      && view.hubTicketInput({ type: 'request', category: 'other', description: '   ' }).code === 'ticket-description');
  ok('T21 …and so is one past the length cap', () => view.hubTicketInput({ type: 'issue', category: 'other', description: 'x'.repeat(view.HUB_TICKET_TEXT_MAX + 1) }).code === 'ticket-too-long');
  ok('T22 "urgent" is only the literal true (a string is not a priority escalation)', () => view.hubTicketInput({ type: 'issue', category: 'other', description: 'x', urgent: 'yes' }).value.urgent === false);
  ok('T23 a long first line becomes a title within the cap',
    () => view.hubTicketTitle('y'.repeat(300)).length <= view.HUB_TICKET_TITLE_MAX);
  ok('T24 a message is text within the same cap', () => view.hubMessageInput({ body: '  hello  ' }).value.body === 'hello' && view.hubMessageInput({ body: '' }).code === 'message-empty');
}

// ── 7. history: the service events (HUB-9, LOG-1, LOG-9) ─────────────────────
{
  const events = act.selectServiceEvents?.({
    timeEntries: [
      { id: 't1', status: 'completed', clock_in_at: iso(NOW - 5 * 3600000), clock_out_at: iso(NOW - 3 * 3600000), client_id: 'cl_a', site_id: 's', user_name: 'Andre Baptiste' },
    ],
    activity: [
      { action: 'ticket.status_changed', occurredAt: iso(NOW - 3600000), clientId: 'cl_a', entityId: 'pr_portal', after: { status: 'resolved' } },
      { action: 'ticket.status_changed', occurredAt: iso(NOW - 3600000), clientId: 'cl_a', entityId: 'pr_internal', after: { status: 'in_progress' } },
    ],
    tickets: [{ id: 'pr_portal', created_at: iso(NOW - 2 * DAY), title: 'Spill in the lobby' }],
    ticketIds: ['pr_portal'],
  }) || [];
  ok('H1 🔴 the service events carry first name + last initial, never the full name',
    () => events.filter((e) => e.kind === 'arrival' || e.kind === 'departure').every((e) => e.detail === 'Andre B.') && !JSON.stringify(events).includes('Baptiste'));
  ok('H2 ticket progress is only the tickets the viewer may see (an office-only ticket stays out)',
    () => events.filter((e) => e.kind === 'ticket').length === 1);
  ok('H3 …a ticket the client raised shows up as raised', () => events.some((e) => e.kind === 'ticket_raised' && e.detail === 'Spill in the lobby'));
  const projected = events.map((e) => view.projectHubEvent?.(e));
  ok('H4 every history row is EXACTLY the event allowlist', () => projected.length && projected.every((e) => sameKeys(e, view.HUB_EVENT_FIELDS)));
  ok('H5 a ticket update reads in the client\'s stage words', () => projected.some((e) => e.kind === 'ticket' && e.detail === 'Completed'));
  const page = view.hubHistoryPage?.(projected, { offset: 1, limit: 2 });
  ok('H6 history pages server-side with the full total', () => page.total === projected.length && page.events.length === Math.min(2, projected.length - 1));
}

// ── 8. the emails (HUB-11) — copy only; who gets one is the route suite's ────
{
  const status = mail.hubTicketStatusEmail?.({ brandName: 'Clean Space', buildingName: 'Coral Bay HOA', ticketTitle: 'Spill <script>x</script>', stageLabel: 'We\'re working on it', link: 'https://app.test/hub/b/cl_a/tickets/pr_1' });
  ok('E1 a status email names the building, the ticket and the new stage, with the link',
    () => status && /Coral Bay HOA/.test(status.subject) && status.text.includes('We\'re working on it') && status.text.includes('https://app.test/hub/b/cl_a/tickets/pr_1'));
  ok('E2 …its HTML escapes what the client typed', () => status.html.includes('&lt;script&gt;') && !status.html.includes('<script>'));
  const noLink = mail.hubTicketStatusEmail?.({ brandName: 'Clean Space', buildingName: 'Coral Bay HOA', ticketTitle: 'Spill', stageLabel: 'Completed', link: null });
  ok('E3 with no configured app address there is no link at all (never one built from a request Host)', () => noLink && !/https?:\/\//.test(noLink.text) && !/href=/.test(noLink.html));
  const reply = mail.hubTicketReplyEmail?.({ brandName: 'Clean Space', buildingName: 'Coral Bay HOA', ticketTitle: 'Spill', author: 'Priya N.', replyBody: 'On our way.', link: null });
  ok('E4 a reply email carries the reply and who wrote it (first name + last initial)', () => reply && reply.text.includes('On our way.') && reply.text.includes('Priya N.'));
  const insp = mail.hubInspectionEmail?.({ brandName: 'Clean Space', buildingName: 'Coral Bay HOA', inspectionName: 'Restroom QC', resultLabel: 'Fail', score: 67, link: 'https://app.test/hub/b/cl_a/inspections/ir_1' });
  ok('E5 an inspection email names the result and the score, and links to the report', () => insp && insp.text.includes('Fail') && insp.text.includes('67%') && insp.text.includes('/inspections/ir_1'));
  ok('E6 the copy builders take no comment, note or message field at all (nothing internal can be passed in)',
    () => ['hubTicketStatusEmail', 'hubTicketReplyEmail', 'hubInspectionEmail'].every((n) => typeof mail[n] === 'function'
      && !/internal|note|comment/i.test(String(mail[n]).split(')')[0])));
}

console.log(`\nclient hub view rules: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
