// THE CLEANER'S SCAN — a fill-in gets the checklist; no checklist, the building's last inspection
// and open tickets (QR Wave 2, 2026-10-17; UI_RULES §176). Matt's answers, Daniel: "go with his note":
//   QR-14 "sometimes we might send cleaners as a filler for someone that was not able to make it to
//         work today. They also have to be able to scan and do the checklist."
//   QR-12 "Just open the checklist; they clock in separately … my checklist for that area (if there
//         is any), or the last inspection done, or any open tickets."
//   QR-13 "No: GPS only." — a scan writes nothing about time.
//
// The REAL handlers over fake-supabase.mjs (no network, no credentials, no live project —
// BUILD_INTEGRITY §6b), plus the pure rules the phone, the demo and the server share.
//
//   P. the pure rules (src/lib/scanFillIn.js, lib/clockInWindow isOnTodayList): what a scan finds
//      (fillInPlan: scheduled / offer / everyone in / no clean / done / ask the manager), the
//      decision (fillInDecision: every refusal, the repeat), the swap (applyFillIn: R8's cover,
//      the one-off crew mark), and checklistFor reading the covered cleaner's checklist after it
//   R. EP-386 now answers a cleaner OUTSIDE their schedule (a dead code still 404s); EP-420 the
//      cleaner's area read (crew-only, the preview, the offer's states and allowlist, the info
//      view's allowlist — a visitor's name and contact never reach it); EP-419 the fill-in (each
//      refusal, the repeat, the write as the server's own, the activity row, the account
//      manager's bell, the rate limit)
//   D. where the scan lands (lib/scanLanding staffScanDestination + crewAreaDestination)
//   T. a scan writes no time data (QR-13)
//   W. the wiring: the page, the adapters, the store's adoption, the catalog lines, the bell
//
// REGRESSION (THE LAW II.3): on the tree before this change (90d7ca9e) EP-386 refuses a cleaner
// outside their schedule and none of the modules, branches or exports exist.
//
//   node app/scripts/test-qr-fill-in.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\{\/\*[\s\S]*?\*\/\}/g, ''))).join('\n');

const ORG = '00000000-0000-0000-0000-000000000176';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const F = await import('../src/lib/scanFillIn.js').catch(() => ({}));
const W = await import('../src/lib/clockInWindow.js').catch(() => ({}));
const L = await import('../src/lib/scanLanding.js').catch(() => ({}));
const { checklistFor } = await import('../src/lib/crewChecklist.js');
const { crewPaths } = await import('../src/lib/crewPaths.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { dayKey, addDaysKey, startOfDayKey } = await import('../src/lib/dates.js');
const notif = await import('../src/lib/notifications.js');
const { EVENT_META } = await import('../src/lib/notificationMeta.js');
const activity = await import('../src/lib/activityLog.js');
const codesLib = await import('../src/lib/scanCodes.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const handler = (await import('../api/scan-codes/[...path].js').catch(() => ({}))).default || null;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 320)}`;
async function section(name, f) {
  try { await f(); } catch (e) { fails.push(`§${name} stopped: ${String((e && e.message) || e).split('\n')[0]}`); }
}

// Today in the org's zone, and instants on it — a clean at noon is "today" at any hour the suite
// runs (its own day is today's), while yesterday's noon clean has closed and tomorrow's has not begun.
const TZ = 'America/New_York';
const NOW = Date.now();
const TODAY = dayKey(new Date(NOW), TZ);
const at = (key, h, m = 0) => new Date(startOfDayKey(key, TZ).getTime() + (h * 60 + m) * 60000).toISOString();
const NOON = at(TODAY, 12);
const NOON_END = at(TODAY, 14);
const YESTERDAY = addDaysKey(TODAY, -1);
const TOMORROW = addDaysKey(TODAY, 1);
const S = F.FILL_IN_STATE || { OFFER: 'offer', EVERYONE_IN: 'everyoneIn', NO_CLEAN: 'noClean', DONE: 'done', ASK_MANAGER: 'askManager' };
const R = F.FILL_IN_REFUSAL || {};

// ── P. the pure rules ────────────────────────────────────────────────────────
await section('P', async () => {
  const today = fn(W, 'isOnTodayList');
  ok('P1 today\'s rule is ONE shared function (lib/clockInWindow isOnTodayList)', typeof W.isOnTodayList === 'function');
  eq('P1 …a clean starting today (the org\'s day) is today\'s', today({ id: 'a', startAt: NOON, endAt: NOON_END, status: 'upcoming' }, TODAY, NOW, 120, TZ), true);
  eq('P1 …a cancelled one never is', today({ id: 'a', startAt: NOON, status: 'cancelled' }, TODAY, NOW, 120, TZ), false);
  eq('P1 …tomorrow\'s is not', today({ id: 'a', startAt: at(TOMORROW, 12), status: 'upcoming' }, TODAY, NOW, 120, TZ), false);
  eq('P1 …yesterday\'s noon clean has closed (CS-052\'s window ends at its end + the grace)', today({ id: 'a', startAt: at(YESTERDAY, 12), endAt: at(YESTERDAY, 14), status: 'upcoming' }, TODAY, NOW, 120, TZ), false);
  const lateNight = { id: 'a', startAt: new Date(NOW - 90 * 60000).toISOString(), endAt: new Date(NOW + 60 * 60000).toISOString(), status: 'in_progress' };
  eq('P1 …a clean under way since before midnight stays today\'s while its window is open', today(lateNight, dayKey(new Date(NOW + 3 * 3600000), TZ), NOW, 120, TZ) || today(lateNight, TODAY, NOW, 120, TZ), true);
  ok('P1 …and My Day reads the same function (the selectors\' private copy is gone, II.5)', /import \{ isOnTodayList \} from '\.\.\/lib\/clockInWindow'/.test(read('src/store/selectors.js'))
    && !/function isOnTodayList/.test(read('src/store/selectors.js')));

  const plan = fn(F, 'fillInPlan');
  const J = (id, crewIds, extra = {}) => ({ id, siteId: 's1', clientId: 'c1', startAt: NOON, endAt: NOON_END, status: 'upcoming', crewIds, ...extra });
  const base = { siteId: 's1', clientId: 'c1', todayKey: TODAY, nowMs: NOW, graceMins: 120, timeZone: TZ };
  const mine = plan({ ...base, jobs: [J('j1', ['u_me', 'u_a'])], userId: 'u_me' });
  ok('P2 on today\'s clean there → that clean, nothing else asked (QR-12: the checklist)', mine?.onClean?.id === 'j1' && mine.state === null, JSON.stringify(mine));
  const offer = plan({ ...base, jobs: [J('j1', ['u_a', 'u_b', 'u_c', 'u_gone'])], userId: 'u_me', punchedByJob: new Map([['j1', new Set(['u_b'])]]), activeUserIds: ['u_me', 'u_a', 'u_b', 'u_c'] });
  ok('P3 🔴 not on it → the OFFER: the scheduled cleaners who haven\'t clocked in (QR-14)', offer?.state === S.OFFER && offer.onClean === null
    && JSON.stringify(offer.candidates.map((c) => c.userId)) === JSON.stringify(['u_a', 'u_c']), JSON.stringify(offer));
  ok('P3 …someone clocked in, and a departed cleaner, are never offered', !offer?.candidates?.some((c) => c.userId === 'u_b' || c.userId === 'u_gone'));
  ok('P3 …each offer names its clean and its times', offer?.candidates?.[0]?.jobId === 'j1' && offer.candidates[0].startAt === NOON && offer.candidates[0].endAt === NOON_END, JSON.stringify(offer?.candidates?.[0]));
  const allIn = plan({ ...base, jobs: [J('j1', ['u_a', 'u_b'])], userId: 'u_me', punchedByJob: { j1: ['u_a', 'u_b'] } });
  eq('P4 everyone scheduled has clocked in → "nobody to cover"', allIn?.state, S.EVERYONE_IN);
  eq('P5 no clean there today → "no clean scheduled"', plan({ ...base, jobs: [J('j1', ['u_a'], { startAt: at(TOMORROW, 12), endAt: at(TOMORROW, 14) })], userId: 'u_me' })?.state, S.NO_CLEAN);
  eq('P5 …a cancelled clean is no clean', plan({ ...base, jobs: [J('j1', ['u_a'], { status: 'cancelled' })], userId: 'u_me' })?.state, S.NO_CLEAN);
  eq('P5 …another location\'s clean is not this one\'s', plan({ ...base, jobs: [J('j1', ['u_a'], { siteId: 's2' })], userId: 'u_me' })?.state, S.NO_CLEAN);
  eq('P6 today\'s cleans there all done → "already done"', plan({ ...base, jobs: [J('j1', ['u_a'], { status: 'done' })], userId: 'u_me' })?.state, S.DONE);
  const tpl = plan({ ...base, jobs: [J('j1', ['u_a'], { seriesId: 'ser1', recurrence: { frequency: 'weekly' } })], userId: 'u_me' });
  eq('P7 🔴 the only clean waiting is a series\' unpinned TEMPLATE row → "ask your manager" (its crew is every future visit\'s)', tpl?.state, S.ASK_MANAGER);
  const pinned = plan({ ...base, jobs: [J('j1', ['u_a'], { seriesId: 'ser1', recurrence: { frequency: 'weekly', crewOverride: ['u_a'] } })], userId: 'u_me' });
  eq('P7 …a template whose crew the series pins (crewOverride) is just a visit: offered', pinned?.state, S.OFFER);

  const decide = fn(F, 'fillInDecision');
  const loc = { siteId: 's1', clientId: 'c1' };
  const dec = (job, extra = {}) => decide({ job, loc, userId: 'u_me', coverFor: 'u_a', punched: [], activeUserIds: ['u_me', 'u_a', 'u_b'], ...base, ...extra });
  const code = (d) => (d?.kind === 'refuse' ? d.code : d?.kind);
  eq('P8 no such clean', code(dec(null)), R.NOT_FOUND || 'fill-in-not-found');
  eq('P8 another location\'s clean', code(dec(J('j1', ['u_a'], { siteId: 's2' }))), R.WRONG_LOCATION || 'fill-in-wrong-location');
  eq('P8 a cancelled clean', code(dec(J('j1', ['u_a'], { status: 'cancelled' }))), R.CANCELLED || 'fill-in-cancelled');
  eq('P8 not today', code(dec(J('j1', ['u_a'], { startAt: at(TOMORROW, 12) }))), R.NOT_TODAY || 'fill-in-not-today');
  eq('P8 done', code(dec(J('j1', ['u_a'], { status: 'done' }))), R.DONE || 'fill-in-done');
  eq('P8 a series\' unpinned template row', code(dec(J('j1', ['u_a'], { seriesId: 'ser1', recurrence: { frequency: 'weekly' } }))), R.TEMPLATE || 'fill-in-template');
  eq('P8 nobody covers themselves', code(dec(J('j1', ['u_a']), { coverFor: 'u_me' })), R.SELF || 'fill-in-self');
  eq('P8 the person named is not on the clean', code(dec(J('j1', ['u_b']))), R.NOT_ON_CLEAN || 'fill-in-not-on-clean');
  eq('P8 …nor someone who left the team', code(dec(J('j1', ['u_a']), { activeUserIds: ['u_me'] })), R.NOT_ON_CLEAN || 'fill-in-not-on-clean');
  eq('P8 the person named has already clocked in', code(dec(J('j1', ['u_a']), { punched: new Set(['u_a']) })), R.CLOCKED_IN || 'fill-in-clocked-in');
  eq('P9 🔴 already on it → a REPEAT (success, nothing written)', code(dec(J('j1', ['u_me', 'u_b']))), 'repeat');
  const w = dec(J('j1', ['u_a', 'u_b'], { coverFor: { u_x: 'u_gone' }, _rv: 7 }));
  ok('P10 🔴 the write is R8\'s swap: the person who didn\'t come leaves, the filler joins, coverFor says who covers whom', w?.kind === 'write'
    && JSON.stringify(w.job.crewIds) === JSON.stringify(['u_b', 'u_me']) && JSON.stringify(w.job.coverFor) === JSON.stringify({ u_me: 'u_a' }), JSON.stringify(w));
  ok('P10 …a stale cover entry is pruned by the model\'s own rule, and the sync layer\'s _rv never rides the payload', w?.kind === 'write' && !('u_x' in (w.job.coverFor || {})) && !('_rv' in w.job));
  const s1 = fn(F, 'applyFillIn')(J('j1', ['u_a'], { seriesId: 'ser1', oneOff: { time: true } }), { userId: 'u_me', coverFor: 'u_a' });
  eq('P11 a SERIES visit is marked a one-off crew (keeping a one-off time), so a "this & all future" crew change skips it', s1?.oneOff, { crew: true, time: true });
  const s2 = fn(F, 'applyFillIn')(J('j1', ['u_a']), { userId: 'u_me', coverFor: 'u_a' });
  ok('P11 …a one-off clean gets no mark', s2 && !('oneOff' in s2), JSON.stringify(s2));
  const client = { id: 'c1', crewChecklists: { u_a: 'tpl_a', u_me: 'tpl_mine' } };
  eq('P12 🔴 after the fill-in checklistFor gives the filler the COVERED cleaner\'s checklist', checklistFor({ client, job: w?.job, userId: 'u_me' }), 'tpl_a');
  eq('P12 …and before it, their own', checklistFor({ client, job: J('j1', ['u_me']), userId: 'u_me' }), 'tpl_mine');
  eq('P12 …a cover for someone with none keeps the filler\'s own (R1: no checklist is normal)', checklistFor({ client: { id: 'c1', crewChecklists: { u_me: 'tpl_mine' } }, job: w?.job, userId: 'u_me' }), 'tpl_mine');

  const info = fn(F, 'projectCrewAreaInfo')({
    inspection: { id: 'i1', performed_at: NOON, result: 'fail', status: 'submitted', inspector_name: 'Ivy Inspector', internal_note: 'SECRET NOTE' },
    tickets: [{ id: 't1', title: 'Lobby: Out of supplies', type: 'request', site_area_id: 'area_lobby', created_at: NOON, description: 'VISITOR WORDS', reporter_name: 'Vince Visitor', reporter_contact: 'vince@example.test', raised_by_client_name: 'Pat Customer' }],
    site: { id: 's1', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }] },
    ticketsTotal: 1,
  });
  ok('P13 the info view is the allowlist, key by key', !!info && JSON.stringify(Object.keys(info.lastInspection || {})) === JSON.stringify(F.CREW_AREA_INSPECTION_KEYS || ['?'])
    && JSON.stringify(Object.keys(info.tickets?.[0] || {})) === JSON.stringify(F.CREW_AREA_TICKET_KEYS || ['?']), JSON.stringify(info));
  ok('P13 🔴 …never a visitor\'s name or contact, a description, a customer\'s name, an inspector\'s note or a ticket id', !/Vince|vince@|VISITOR WORDS|Pat Customer|SECRET NOTE|Ivy|"t1"|"i1"/.test(JSON.stringify(info)), JSON.stringify(info));
  ok('P13 …a ticket\'s area is named by its EXPLICIT id against the location\'s areas', info?.tickets?.[0]?.area === 'Lobby');
  const many = fn(F, 'projectCrewAreaInfo')({ tickets: Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, type: 'issue', created_at: NOON })), ticketsTotal: 30 });
  ok('P14 the view lists at most the newest N and says how many there are', many?.tickets?.length === F.CREW_AREA_TICKETS_MAX && many.ticketsTotal === 30 && F.CREW_AREA_TICKETS_MAX > 0, JSON.stringify({ n: many?.tickets?.length, total: many?.ticketsTotal }));
});

// ── the world (R, T) ─────────────────────────────────────────────────────────
const T32 = (c) => c.repeat(32);
const TOK = { club: T32('C'), pool: T32('P'), tower: T32('T'), empty: T32('E'), full: T32('F'), tpl: T32('M'), dead: T32('D'), unknown: T32('U') };
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true, name: 'Olive Owner' },
  mgr: { id: 'u_mgr', role: 'manager', claim: false, name: 'Mia Manager' },
  filler: { id: 'u_filler', role: 'crew', claim: true, name: 'Fran Filler' },
  keisha: { id: 'u_keisha', role: 'crew', claim: true, name: 'Keisha K' },
  andre: { id: 'u_andre', role: 'crew', claim: true, name: 'Andre A' },
  tomas: { id: 'u_tomas', role: 'crew', claim: true, name: 'Tomas T' },
  crew2: { id: 'u_crew2', role: 'crew', claim: true, name: 'Cass Two' },
};
const roster = [
  ...Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: `${k}@example.test`, role: p.role, status: 'active', name: p.name })),
  { id: 'u_gone', email: 'gone@example.test', role: 'crew', status: 'inactive', name: 'Gone Person' },
];
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `00000000-0000-4000-8000-0000000000${String(Object.keys(PEOPLE).indexOf(k)).padStart(2, '0')}`,
  email: `${k}@example.test`, app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const SITES = [
  { id: 's_club', clientId: 'cl_coral', name: 'Clubhouse', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }] },
  { id: 's_pool', clientId: 'cl_coral', name: 'Pool house', cleaningAreas: [{ id: 'area_deck', label: 'Deck' }] },
  { id: 's_tower', clientId: 'cl_harbor', name: 'Harbor Tower', cleaningAreas: [{ id: 'area_hall', label: 'Hall' }] },
  { id: 's_empty', clientId: 'cl_harbor', name: 'Harbor Annex', cleaningAreas: [{ id: 'area_x', label: 'Annex' }] },
  { id: 's_full', clientId: 'cl_harbor', name: 'Harbor Garage', cleaningAreas: [{ id: 'area_g', label: 'Garage' }] },
  { id: 's_tpl', clientId: 'cl_harbor', name: 'Harbor Pier', cleaningAreas: [{ id: 'area_p', label: 'Pier' }] },
];
const CLIENTS = [
  { id: 'cl_coral', name: 'Coral Bay HOA', supervisorId: 'u_mgr', crewChecklists: { u_andre: 'tpl_andre', u_tomas: 'tpl_tomas' } },
  { id: 'cl_harbor', name: 'Harbor Tower', supervisorId: null },
];
const jobRow = (id, siteId, crewIds, { clientId = 'cl_coral', startAt = NOON, endAt = NOON_END, status = 'upcoming', rv = 10, ...extra } = {}) => ({
  id, organization_id: ORG, client_id: clientId, site_id: siteId, series_id: extra.seriesId || null, status, start_at: startAt, row_version: rv,
  updated_by_tab: 'tab-office', updated_via: 'server',
  data: { id, clientId, siteId, crewIds, startAt, endAt, status, ...extra },
});
const codeRow = (id, siteId, areaId, token, extra = {}) => ({
  id, organization_id: ORG, site_id: siteId, area_id: areaId, token, created_at: NOON, created_by: 'u_owner', revoked_at: null, revoked_by: null, ...extra,
});
const punch = (id, jobId, userId, extra = {}) => ({
  id, organization_id: ORG, job_id: jobId, user_id: userId, clock_in_at: NOON, clock_out_at: null, status: 'open', approval_status: 'pending', ...extra,
});
function seed() {
  __resetRateLimit?.();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 7,
        state: {
          company: { name: 'Clean Space', timezone: TZ },
          users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
          clients: CLIENTS.map((c) => ({ ...c })), sites: SITES.map((s) => ({ ...s, accessNotes: 'door code 4411 SECRET' })),
          opsSettings: { autoCloseGraceMins: 120 }, notifications: [],
        },
      }],
      area_scan_codes: [
        codeRow('c1', 's_club', 'area_rest', TOK.club), codeRow('c2', 's_pool', 'area_deck', TOK.pool),
        codeRow('c3', 's_tower', 'area_hall', TOK.tower), codeRow('c4', 's_empty', 'area_x', TOK.empty),
        codeRow('c5', 's_full', 'area_g', TOK.full), codeRow('c6', 's_tpl', 'area_p', TOK.tpl),
        codeRow('c7', 's_club', 'area_lobby', TOK.dead, { revoked_at: NOON, revoked_by: 'u_owner' }),
      ],
      jobs: [
        // Coral Bay's Clubhouse today: Tomas is in, Andre hasn't come (his voided punch counts for nobody).
        jobRow('j_club', 's_club', ['u_tomas', 'u_andre', 'u_gone'], { notes: 'Gate code 7788 JOBNOTE' }),
        jobRow('j_club_cancel', 's_club', ['u_andre'], { status: 'cancelled' }),
        jobRow('j_club_tomorrow', 's_club', ['u_andre'], { startAt: at(TOMORROW, 12), endAt: at(TOMORROW, 14) }),
        jobRow('j_club_series', 's_club', ['u_crew2'], { startAt: at(TODAY, 18), endAt: at(TODAY, 20), seriesId: 'ser_club' }),
        // The Pool house: Keisha is on it, clocked in (she has no checklist at Coral Bay).
        jobRow('j_pool', 's_pool', ['u_keisha'], { status: 'in_progress' }),
        // Harbor: the Tower's clean is done; the Annex has none today; the Garage's crew are all in;
        // the Pier's only clean is an old series' template row.
        jobRow('j_tower', 's_tower', ['u_crew2'], { clientId: 'cl_harbor', status: 'done' }),
        jobRow('j_annex_tmrw', 's_empty', ['u_crew2'], { clientId: 'cl_harbor', startAt: at(TOMORROW, 9), endAt: at(TOMORROW, 10) }),
        jobRow('j_full', 's_full', ['u_crew2', 'u_tomas'], { clientId: 'cl_harbor' }),
        jobRow('j_tpl', 's_tpl', ['u_crew2'], { clientId: 'cl_harbor', seriesId: 'ser_pier', recurrence: { frequency: 'weekly', daysOfWeek: [1] } }),
        // The filler cleans somewhere else today.
        jobRow('j_elsewhere', 's_far', ['u_filler'], { clientId: 'cl_harbor', startAt: at(TODAY, 6), endAt: at(TODAY, 7), status: 'done' }),
      ],
      time_entries: [
        punch('te1', 'j_club', 'u_tomas'),
        punch('te2', 'j_club', 'u_andre', { status: 'voided' }),
        punch('te3', 'j_pool', 'u_keisha'),
        punch('te4', 'j_full', 'u_crew2', { clock_out_at: NOON_END, status: 'completed' }),
        punch('te5', 'j_full', 'u_tomas'),
      ],
      inspection_records: [
        { id: 'ir1', organization_id: ORG, site_id: 's_pool', client_id: 'cl_coral', performed_at: at(addDaysKey(TODAY, -2), 10), result: 'fail', status: 'submitted', inspector_name: 'Ivy Inspector', internal_note: 'SECRET NOTE', public_token: 'PUBLICTOKEN' },
        { id: 'ir2', organization_id: ORG, site_id: 's_pool', client_id: 'cl_coral', performed_at: at(TODAY, 8), result: 'pass', status: 'draft' },
        { id: 'ir3', organization_id: ORG, site_id: 's_pool', client_id: 'cl_coral', performed_at: at(addDaysKey(TODAY, -9), 10), result: 'pass', status: 'submitted' },
      ],
      problem_reports: [
        { id: 'pr1', organization_id: ORG, site_id: 's_pool', client_id: 'cl_coral', title: 'Deck: Out of supplies', type: 'request', status: 'open', site_area_id: 'area_deck', created_at: at(TODAY, 9), origin: 'visitor', reporter_name: 'Vince Visitor', reporter_contact: 'vince@example.test', description: 'VISITOR WORDS' },
        { id: 'pr2', organization_id: ORG, site_id: 's_pool', client_id: 'cl_coral', title: 'Pool gate sticks', type: 'issue', status: 'in_progress', created_at: at(YESTERDAY, 9), raised_by_client_name: 'Pat Customer', description: 'CUSTOMER WORDS' },
        { id: 'pr3', organization_id: ORG, site_id: 's_pool', client_id: 'cl_coral', title: 'Old and resolved', type: 'complaint', status: 'resolved', created_at: at(YESTERDAY, 8) },
        { id: 'pr4', organization_id: ORG, site_id: 's_club', client_id: 'cl_coral', title: 'Another building', type: 'complaint', status: 'open', created_at: at(TODAY, 7) },
      ],
      activity_log: [], activity_log_baseline: [], crew_assignments: [],
    },
    logins,
  });
}

async function call({ method = 'GET', path: p, who, query = {}, body }) {
  const req = { method, headers: who ? { authorization: `Bearer tok-${who}` } : {}, query: { subpath: p, ...query }, body: body || {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null, headers: {} }), 10000);
      const headers = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler ? handler(req, res) : res.status(404).json({ error: 'no handler' })).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const resolve = (who, token) => call({ path: 'resolve', who, query: { token } });
const area = (who, token, query = {}) => call({ path: 'crew-area', who, query: { token, ...query } });
const fillIn = (who, body) => call({ method: 'POST', path: 'fill-in', who, body });
const INACTIVE = 'scan-code-inactive';
const timeWrites = () => world.log.filter((q) => q.table === 'time_entries' && q.op !== 'select');
const jobData = (id) => world.tables.jobs.find((r) => r.id === id);

// ── R. the routes ────────────────────────────────────────────────────────────
await section('R', async () => {
  // EP-386
  seed();
  const outside = await resolve('filler', TOK.club);
  ok('R1 🔴 EP-386 answers a cleaner OUTSIDE their schedule (a filler may scan anywhere): the location, the minimal allowlist', outside.status === 200
    && outside.body.siteId === 's_club' && outside.body.areaId === 'area_rest' && JSON.stringify(Object.keys(outside.body)) === JSON.stringify(codesLib.SCAN_RESOLVE_KEYS), show(outside));
  ok('R1 …and nothing else (no access notes)', !/4411|SECRET/.test(JSON.stringify(outside.body)), show(outside));
  const deadCrew = await resolve('filler', TOK.dead);
  ok('R2 …a dead (replaced) code is still the public route\'s 404 for a cleaner', deadCrew.status === 404 && deadCrew.body.code === INACTIVE, show(deadCrew));
  const unknownCrew = await resolve('filler', TOK.unknown);
  ok('R2 …and an unknown one', unknownCrew.status === 404 && unknownCrew.body.code === INACTIVE, show(unknownCrew));
  ok('R3 the refusal it used to give is gone (II.5): no not-your-location anywhere', !('SCAN_NOT_YOURS_CODE' in codesLib)
    && !/not-your-location/.test(read('api/scan-codes/[...path].js') + read('src/lib/scanCodesApi.js') + read('src/pages/crew/CrewScan.jsx') + read('src/lib/scanCodes.js')));

  // EP-420
  seed();
  const anon = await area(null, TOK.club);
  eq('R4 EP-420: no login → 401', anon.status, 401);
  const office = await area('owner', TOK.club);
  ok('R4 …an office login on its own → 403 crew-only (the office\'s scan is its own page)', office.status === 403 && office.body.code === 'crew-only', show(office));
  const offer = await area('filler', TOK.club);
  ok('R5 🔴 a filler at a building with cleans today → the OFFER, in start order: Andre at noon, who hasn\'t come (Tomas is in; a voided punch counts for nobody; a departed cleaner never), and the evening visit\'s cleaner', offer.status === 200
    && offer.body.onClean === null && offer.body.info === null && offer.body.fillIn?.state === S.OFFER
    && JSON.stringify(offer.body.fillIn.candidates.map((c) => `${c.jobId}:${c.userId}`)) === JSON.stringify(['j_club:u_andre', 'j_club_series:u_crew2']), show(offer));
  ok('R5 …each offer is the allowlist (its clean and times, never the clean\'s notes or crew list)', offer.status === 200
    && offer.body.fillIn.candidates.every((c) => JSON.stringify(Object.keys(c)) === JSON.stringify(F.FILL_IN_CANDIDATE_KEYS || ['?']))
    && !/7788|JOBNOTE|u_tomas|4411/.test(JSON.stringify(offer.body)), show(offer));
  ok('R5 …never cached', offer.headers['cache-control'] === 'no-store');
  for (const [label, tok, want] of [['done', TOK.tower, S.DONE], ['no clean today', TOK.empty, S.NO_CLEAN], ['everyone in', TOK.full, S.EVERYONE_IN], ['only a template row waiting', TOK.tpl, S.ASK_MANAGER]]) {
    const r = await area('filler', tok);
    ok(`R6 ${label} → ${want}`, r.status === 200 && r.body.fillIn?.state === want && r.body.fillIn.candidates.length === 0, show(r));
  }
  const dead = await area('filler', TOK.dead);
  ok('R7 a dead code → the same 404', dead.status === 404 && dead.body.code === INACTIVE, show(dead));
  const mine = await area('keisha', TOK.pool);
  ok('R8 🔴 a cleaner ON today\'s clean there → that clean (the row, with its version, to adopt) and the building\'s view', mine.status === 200
    && mine.body.onClean?.id === 'j_pool' && mine.body.onClean._rv === 10 && mine.body.fillIn === null && !!mine.body.info, show(mine));
  ok('R9 …the LAST inspection is the newest SUBMITTED one (a newer draft is nobody\'s business): its day and result only', mine.status === 200
    && mine.body.info.lastInspection?.result === 'fail' && mine.body.info.lastInspection.performedAt === at(addDaysKey(TODAY, -2), 10)
    && JSON.stringify(Object.keys(mine.body.info.lastInspection)) === JSON.stringify(F.CREW_AREA_INSPECTION_KEYS || ['?']), show(mine));
  ok('R10 …the OPEN tickets at THIS building, newest first (resolved ones and another building\'s left out)', mine.status === 200
    && JSON.stringify(mine.body.info.tickets.map((t) => t.title)) === JSON.stringify(['Deck: Out of supplies', 'Pool gate sticks']) && mine.body.info.ticketsTotal === 2, show(mine));
  ok('R10 …each with its type, its area (by the ticket\'s explicit area id) and when it opened', mine.status === 200
    && mine.body.info.tickets[0].type === 'request' && mine.body.info.tickets[0].area === 'Deck' && mine.body.info.tickets[0].openedAt === at(TODAY, 9)
    && mine.body.info.tickets[1].area === null, show(mine));
  ok('R11 🔴 a VISITOR\'s name and contact never reach the cleaner — nor a description, a customer\'s name, the inspector\'s note, a share token or an id', mine.status === 200
    && !/Vince|vince@|VISITOR WORDS|CUSTOMER WORDS|Pat Customer|SECRET|PUBLICTOKEN|Ivy|"pr1"|"pr2"|"ir1"/.test(JSON.stringify(mine.body.info)), JSON.stringify(mine.body.info));
  const preview = await area('owner', TOK.pool, { userId: 'u_keisha' });
  ok('R12 the owner\'s View-as Keisha reads Keisha\'s answer (the office key that shows who is on the clock)', preview.status === 200 && preview.body.onClean?.id === 'j_pool', show(preview));
  const crewAsSomeone = await area('filler', TOK.pool, { userId: 'u_keisha' });
  ok('R12 …a cleaner naming someone else still reads themselves (crewReadSubject)', crewAsSomeone.status === 200 && crewAsSomeone.body.onClean === null && crewAsSomeone.body.fillIn?.state === S.EVERYONE_IN, show(crewAsSomeone));
  ok('R13 EP-420 writes nothing at all', !world.log.some((q) => q.op !== 'select' && !['rpc'].includes(q.op) && q.table !== 'auth.admin'),
    JSON.stringify(world.log.filter((q) => q.op !== 'select').map((q) => `${q.op} ${q.table}`)));

  // EP-419: the refusals
  seed();
  const refused = async (label, who, body, status, codeWant) => {
    __resetRateLimit?.();   // each refusal on its own (the allowance is held at R27)
    const r = await fillIn(who, body);
    ok(`R14 ${label} → ${status} ${codeWant}`, r.status === status && r.body?.code === codeWant, show(r));
    return r;
  };
  const anonFill = await fillIn(null, { token: TOK.club, jobId: 'j_club', coverFor: 'u_andre' });
  eq('R14 no login → 401', anonFill.status, 401);
  await refused('🔴 an office login', 'owner', { token: TOK.club, jobId: 'j_club', coverFor: 'u_andre' }, 403, 'crew-only');
  await refused('a manager (claim-less, as live)', 'mgr', { token: TOK.club, jobId: 'j_club', coverFor: 'u_andre' }, 403, 'crew-only');
  await refused('a dead code', 'filler', { token: TOK.dead, jobId: 'j_club', coverFor: 'u_andre' }, 404, INACTIVE);
  await refused('a malformed token', 'filler', { token: 'nope', jobId: 'j_club', coverFor: 'u_andre' }, 404, INACTIVE);
  await refused('no clean named', 'filler', { token: TOK.club, coverFor: 'u_andre' }, 400, 'bad-request');
  await refused('a clean that doesn\'t exist', 'filler', { token: TOK.club, jobId: 'j_nope', coverFor: 'u_andre' }, 404, R.NOT_FOUND);
  await refused('🔴 another location\'s clean (the code is the Clubhouse\'s; the clean the Pool house\'s)', 'filler', { token: TOK.club, jobId: 'j_pool', coverFor: 'u_keisha' }, 409, R.WRONG_LOCATION);
  await refused('a cancelled clean', 'filler', { token: TOK.club, jobId: 'j_club_cancel', coverFor: 'u_andre' }, 409, R.CANCELLED);
  await refused('🔴 not today', 'filler', { token: TOK.club, jobId: 'j_club_tomorrow', coverFor: 'u_andre' }, 409, R.NOT_TODAY);
  await refused('🔴 a done clean', 'filler', { token: TOK.tower, jobId: 'j_tower', coverFor: 'u_crew2' }, 409, R.DONE);
  await refused('a series\' unpinned template row', 'filler', { token: TOK.tpl, jobId: 'j_tpl', coverFor: 'u_crew2' }, 409, R.TEMPLATE);
  await refused('🔴 someone not on the clean', 'filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_keisha' }, 409, R.NOT_ON_CLEAN);
  await refused('🔴 the caller themselves', 'filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_filler' }, 400, R.SELF);
  await refused('🔴 someone already clocked in', 'filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_tomas' }, 409, R.CLOCKED_IN);
  await refused('a departed cleaner', 'filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_gone' }, 409, R.NOT_ON_CLEAN);
  ok('R14 …and none of them wrote a clean, a log row or a bell', JSON.stringify(jobData('j_club').data.crewIds) === JSON.stringify(['u_tomas', 'u_andre', 'u_gone'])
    && world.tables.activity_log.length === 0 && world.tables.org_state[0].state.notifications.length === 0);

  // EP-419: the fill-in
  seed();
  const before = world.log.length;
  const done = await fillIn('filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_andre' });
  const stored = jobData('j_club');
  ok('R15 🔴 the fill-in: 200, changed, and the answer is the clean as written (with its version, for the phone to adopt)', done.status === 200 && done.body.changed === true
    && done.body.job?.id === 'j_club' && Number.isFinite(done.body.job._rv), show(done));
  ok('R16 🔴 …R8\'s cover, as the server wrote it: Andre off today\'s clean, the filler on it, covering him', JSON.stringify(stored.data.crewIds) === JSON.stringify(['u_tomas', 'u_gone', 'u_filler'])
    && JSON.stringify(stored.data.coverFor) === JSON.stringify({ u_filler: 'u_andre' }), JSON.stringify(stored.data));
  ok('R16 …the rest of the clean untouched (its notes, times, status)', stored.data.notes === 'Gate code 7788 JOBNOTE' && stored.data.startAt === NOON && stored.data.status === 'upcoming');
  ok('R17 🔴 …written by the SERVER on the cleaner\'s behalf: its own tab (never a phone\'s echo), the 1e marker, the person\'s Auth id', stored.updated_by_tab === 'server:scan'
    && stored.updated_via === 'server' && stored.updated_by === logins['tok-filler'].id && stored.updated_by_build === null, JSON.stringify({ tab: stored.updated_by_tab, via: stored.updated_via, by: stored.updated_by }));
  const casWrite = world.log.slice(before).find((q) => q.table === 'jobs' && q.op === 'update');
  ok('R17 …a compare-and-swap on the version it read', !!casWrite && (casWrite.ops || []).some((o) => o.op === 'eq' && o.col === 'row_version'), JSON.stringify(casWrite));
  eq('R18 🔴 …so the filler\'s checklist is the COVERED cleaner\'s ("Covering for Andre")', checklistFor({ client: CLIENTS[0], job: stored.data, userId: 'u_filler' }), 'tpl_andre');
  const row = world.tables.activity_log[0];
  ok('R19 the activity log says who filled in for whom, where (job.filled_in, the actor from the claim)', world.tables.activity_log.length === 1
    && row.action === 'job.filled_in' && row.actor_user_id === 'u_filler' && row.entity_id === 'j_club' && row.client_id === 'cl_coral'
    && /Fran Filler filled in for Andre A at Coral Bay HOA/.test(row.summary) && JSON.stringify(row.after?.coverFor) === JSON.stringify({ u_filler: 'u_andre' }), JSON.stringify(row));
  const bells = world.tables.org_state[0].state.notifications;
  ok('R20 🔴 the building\'s account manager is told — and only them (the account-alert fan-out)', bells.length === 1 && bells[0].userId === 'u_mgr'
    && bells[0].eventKey === notif.SCAN_FILL_IN_EVENT && /Fran Filler is filling in for Andre A at Coral Bay HOA today/.test(bells[0].title)
    && bells[0].url === '/schedule/j_club', JSON.stringify(bells));
  eq('R21 🔴 a fill-in writes NO time data (QR-13: GPS only)', timeWrites().length, 0);
  const again = await fillIn('filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_andre' });
  ok('R22 🔴 a repeat answers success and changes nothing (no second write, log row or bell)', again.status === 200 && again.body.changed === false && again.body.job?.id === 'j_club'
    && JSON.stringify(jobData('j_club').data) === JSON.stringify(stored.data) && world.tables.activity_log.length === 1 && world.tables.org_state[0].state.notifications.length === 1, show(again));
  const after = await area('filler', TOK.club);
  ok('R23 after the fill-in the filler\'s scan finds their clean there, with the building\'s view', after.status === 200 && after.body.onClean?.id === 'j_club' && !!after.body.info, show(after));

  // A series visit is marked a one-off crew; the Garage's crew are all in (nothing to fill).
  seed();
  const series = await fillIn('filler', { token: TOK.club, jobId: 'j_club_series', coverFor: 'u_crew2' });
  ok('R24 a SERIES visit filled in is marked a one-off crew (a later "this & all future" crew change skips it)', series.status === 200
    && JSON.stringify(jobData('j_club_series').data.oneOff) === JSON.stringify({ crew: true }), show(series));
  const noSupervisor = await fillIn('filler', { token: TOK.full, jobId: 'j_full', coverFor: 'u_crew2' });
  ok('R25 someone already in at the Garage cannot be covered there', noSupervisor.status === 409 && noSupervisor.body.code === R.CLOCKED_IN, show(noSupervisor));

  // The race: the office changes the clean between the read and the write — the decision is re-made.
  seed();
  let raced = false;
  world.beforeQuery = async (q) => {
    if (!raced && q.table === 'jobs' && q.op === 'update') {
      raced = true;
      const r = jobData('j_club');
      r.data = { ...r.data, crewIds: ['u_tomas'] };   // the office took Andre off meanwhile
      r.row_version = 11;
    }
  };
  const lost = await fillIn('filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_andre' });
  world.beforeQuery = null;
  ok('R26 🔴 a write that lost the race is re-decided on the fresh row (Andre is no longer on it: refused, the office\'s change kept)', lost.status === 409 && lost.body.code === R.NOT_ON_CLEAN
    && JSON.stringify(jobData('j_club').data.crewIds) === JSON.stringify(['u_tomas']), show(lost));

  // The allowance.
  seed();
  const RATE = F.SCAN_FILL_IN_RATE || { limit: 0 };
  let last = null;
  for (let i = 0; i <= RATE.limit; i += 1) last = await fillIn('filler', { token: TOK.club, jobId: 'j_club_tomorrow', coverFor: 'u_andre' });
  ok('R27 the fill-in is rate-limited per login (429 rate-limited)', RATE.limit > 0 && last?.status === 429 && last.body.code === 'rate-limited', last ? show(last) : 'no call');
  const other = await fillIn('keisha', { token: TOK.club, jobId: 'j_club_tomorrow', coverFor: 'u_andre' });
  ok('R27 …another login is not', other.status === 409, show(other));
  const ARATE = F.SCAN_CREW_AREA_RATE || { limit: 0 };
  let lastArea = null;
  for (let i = 0; i <= ARATE.limit; i += 1) lastArea = await area('crew2', TOK.empty);
  ok('R28 the cleaner\'s area read is rate-limited per login too', ARATE.limit > 0 && lastArea?.status === 429, lastArea ? show(lastArea) : 'no call');
});

// ── D. where the scan lands ──────────────────────────────────────────────────
await section('D', async () => {
  const dest = (o) => fn(L, 'staffScanDestination')({ token: T32('C'), office: false, canSeeCustomer: false, ...o });
  const loc = { siteId: 's_club', clientId: 'cl_coral', areaId: 'area_rest', siteName: 'Clubhouse', building: 'Coral Bay HOA', area: 'Restrooms' };
  const clean = { id: 'j_club', siteId: 's_club', clientId: 'cl_coral', status: 'in_progress' };
  const scheduled = dest({ loc, clean, hasChecklist: true });
  ok('D1 🔴 scheduled there with a checklist → that checklist at the scanned area, no Clock In step (QR-12)', scheduled?.kind === 'checklist' && scheduled.to === crewPaths.checklist('j_club', 'area_rest'), JSON.stringify(scheduled));
  const noList = dest({ loc, clean, hasChecklist: false });
  ok('D2 scheduled there with NO checklist → ask the server (EP-420) for the building\'s view', noList?.kind === 'crewArea' && noList.place === 'Coral Bay HOA', JSON.stringify(noList));
  const notOn = dest({ loc, clean: null });
  ok('D3 🔴 not on today\'s clean there → ask the server too (never "you\'re not scheduled" on the phone\'s say-so)', notOn?.kind === 'crewArea', JSON.stringify(notOn));
  const after = fn(L, 'crewAreaDestination');
  const onCleanList = after({ loc, answer: { onClean: clean, info: { tickets: [] } }, hasChecklist: true });
  ok('D4 the server says they\'re on it, with a checklist (a fill-in included) → the checklist', onCleanList?.kind === 'checklist' && onCleanList.to === crewPaths.checklist('j_club', 'area_rest') && onCleanList.jobId === 'j_club', JSON.stringify(onCleanList));
  const info = after({ loc, answer: { onClean: clean, info: { lastInspection: null, tickets: [], ticketsTotal: 0 } }, hasChecklist: false });
  ok('D5 🔴 …with no checklist → the info view (last inspection and open tickets)', info?.kind === 'info' && info.place === 'Coral Bay HOA' && info.area === 'Restrooms' && Array.isArray(info.info?.tickets), JSON.stringify(info));
  for (const state of [S.OFFER, S.EVERYONE_IN, S.NO_CLEAN, S.DONE, S.ASK_MANAGER]) {
    const r = after({ loc, answer: { onClean: null, fillIn: { state, candidates: state === S.OFFER ? [{ jobId: 'j', userId: 'u_a' }] : [] } } });
    ok(`D6 not on a clean → the ${state} state, naming the building`, r?.kind === 'fillIn' && r.state === state && r.place === 'Coral Bay HOA'
      && r.candidates.length === (state === S.OFFER ? 1 : 0), JSON.stringify(r));
  }
  const office = fn(L, 'staffScanDestination')({ loc, token: T32('C'), office: true, canSeeCustomer: true });
  ok('D7 an office login is untouched by this (builder O\'s branch: the area page, §175)', office?.kind === 'area' && /^\/areas\//.test(office?.to || ''), JSON.stringify(office));
});

// ── T. a scan is not presence (QR-13) ────────────────────────────────────────
await section('T', async () => {
  seed();
  const before = world.log.length;
  await resolve('filler', TOK.club);
  await area('filler', TOK.club);
  await area('keisha', TOK.pool);
  await fillIn('filler', { token: TOK.club, jobId: 'j_club', coverFor: 'u_andre' });
  const writes = world.log.slice(before).filter((q) => q.table === 'time_entries' && q.op !== 'select');
  eq('T1 🔴 resolve, the area read and a fill-in write nothing to time_entries', writes.length, 0);
  ok('T1 …punches untouched (the same five rows, as they were)', world.tables.time_entries.length === 5 && world.tables.time_entries.every((r) => !('scan' in r)));
  const route = strip(read('api/scan-codes/[...path].js'));
  ok('T2 the route reads punches through ONE read-only helper and calls no punch writer', /punchedUserIdsByJob\(/.test(route)
    && !/clockIn\(|clockOut\(|replayPunch|manualEntry|correctEntryRow|approveEntryRow|time_entries/.test(route));
  const store = read('api/_lib/time/store.js');
  const helper = (store.match(/export async function punchedUserIdsByJob[\s\S]*?\n\}/) || [''])[0];
  ok('T3 …and that helper only selects', /\.select\('job_id,user_id'\)/.test(helper) && !/\.update\(|\.insert\(|\.upsert\(|\.delete\(/.test(helper), helper.slice(0, 120));
  ok('T4 nothing about a scan reaches the variance report or approvals', !/scanCodes|scanFillIn|area_scan|fill-in|fillIn/.test(read('api/_lib/variance/compute.js') + read('api/variance/[...path].js'))
    && !/scanCodes|scanFillIn|fill-in|fillIn|crewArea/.test(read('api/time/[...path].js')));
});

// ── W. the wiring ────────────────────────────────────────────────────────────
await section('W', async () => {
  const page = strip(read('src/pages/crew/CrewScan.jsx'));
  ok('W1 the cleaner\'s scan asks the server through the adapters (EP-420, EP-419)', /crewAreaForScan\(/.test(page) && /fillInFromScan\(/.test(page));
  ok('W2 🔴 …adopts the clean it is handed at once (the jobs loader), re-reading the projection when the phone lacks the clean, its customer or its location', /adoptServerJobs\(\[answer\.onClean\], \{ rescope: true \}\)/.test(page)
    && /adoptServerJobs\(\[r\.job\], \{ rescope: lacksClean\(r\.job, offer\.loc\) \}\)/.test(page) && /answer\?\.onClean && lacksClean\(answer\.onClean, loc\)/.test(page)
    && /selectSiteById\(st, job\.siteId/.test(page));
  ok('W3 …decides with the pure rules (staffScanDestination with hasChecklist, then crewAreaDestination) and checklistFor', /staffScanDestination\(\{/.test(page)
    && /hasChecklist/.test(page) && /crewAreaDestination\(\{/.test(page) && /checklistFor\(\{/.test(page));
  ok('W4 …the offer draws each person with the one Avatar (photo over initials, §141) and the preview disables the tap', /<Avatar\b/.test(page) && /disabled=\{[^}]*previewing/.test(page));
  ok('W5 …every refusal still offers the public page; the old "not scheduled" sentence is gone (II.5)', /publicScanPath\(/.test(page) && !/qrScan\.notScheduled|qrScan\.notYours/.test(page));
  const sync = read('src/store/sync.js');
  const adopt = (sync.match(/async adoptServerJobs\([\s\S]*?\n {4}\},/) || [''])[0];
  ok('W6 🔴 the sync manager adopts a server\'s rows as server-originated: PATCH_JOBS AND the mirror baseline (never re-POSTed)', /ACTIONS\.PATCH_JOBS/.test(adopt) && /advanceJobsBaseline\(list, \[\]\)/.test(adopt));
  ok('W6 …and re-reads a crew login\'s projection first when asked (a clean it joined widens its scope)', /restrictedRead/.test(adopt) && /fetchLatest\(\)/.test(adopt) && /adoptRemote\(remote\)/.test(adopt) && /saving/.test(adopt));
  const store = read('src/store/index.jsx');
  ok('W7 the store\'s jobs loader exposes it, in both modes', /adoptServerJobs: \(rows, opts\) => \(syncRef\.current \? syncRef\.current\.adoptServerJobs\(rows, opts\)/.test(store) && /adoptServerJobs: \(rows\) => \{/.test(store));
  const api = read('src/lib/scanCodesApi.js');
  ok('W8 the demo runs the same rules (fillInPlan, fillInDecision) over the store and the ledger', /fillInPlan\(/.test(api) && /fillInDecision\(/.test(api) && /function stubCrewArea/.test(api) && /function stubFillIn/.test(api));
  const en = read('src/i18n/catalog/en.js');
  const keys = ['qrScan.fillIn.offer', 'qrScan.fillIn.everyoneIn', 'qrScan.fillIn.noClean', 'qrScan.fillIn.done', 'qrScan.fillIn.askManager', 'qrScan.area.lastInspection', 'qrScan.area.openTickets',
    'alerts.fillIn.title', 'alerts.fillIn.body', 'notifPrefs.scanFillIn', 'notifPrefs.scanFillIn.desc'];
  const missing = keys.filter((k) => !en.includes(`'${k}':`));
  ok('W9 every word is a catalog line (§140)', missing.length === 0, missing.join(', '));
  ok('W9 …Matt\'s exact sentences', /'qrScan\.fillIn\.offer': 'You’re not on today’s schedule at \{site\}\. Filling in for someone\?'/.test(en)
    && /'qrScan\.fillIn\.everyoneIn': 'Everyone on today’s schedule here is already clocked in\. Ask your manager to add you to this clean\.'/.test(en)
    && /'qrScan\.fillIn\.noClean': 'There’s no clean scheduled at \{site\} today\.'/.test(en));
  ok('W9 …the dead lines are gone with their screens (II.5)', !/'qrScan\.notScheduled'|'qrScan\.notYours'/.test(en + read('src/i18n/catalog/es.js') + read('src/i18n/catalog/ht.js')));
  const groups = notif.NOTIFICATION_GROUPS || [];
  const item = groups.flatMap((g) => g.items).find((i) => i.key === notif.SCAN_FILL_IN_EVENT);
  ok('W10 the bell: one event, in the catalog for the office tiers, with its look', notif.SCAN_FILL_IN_EVENT === 'scanFillIn' && !!item
    && JSON.stringify(item.roleAllowlist) === JSON.stringify(['owner', 'admin', 'manager']) && !!EVENT_META[notif.SCAN_FILL_IN_EVENT]);
  ok('W11 the log: one action in the vocabulary (schedule)', activity.isKnownAction('job.filled_in') && activity.ACTIONS['job.filled_in'].group === 'schedule');
  const route = read('api/scan-codes/[...path].js');
  ok('W12 both doors are on the catch-all that already has its rewrite (no new domain)', /action === 'crew-area' && req\.method === 'GET'/.test(route)
    && /action === 'fill-in' && req\.method === 'POST'/.test(route) && /"\/api\/scan-codes\/:path\*"|\/api\/scan-codes\//.test(read('vercel.json')));
  ok('W13 the write goes through the jobs table\'s server path, never a crew tab\'s delta', /updateJobByServer\(/.test(route) && !/writeJobsDelta/.test(route));
});

if (fails.length) { console.error('\nqr-fill-in FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nqr-fill-in: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
