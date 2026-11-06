// QR-2 / QR-3 / QR-6 / QR-15 / QR-28 / QR-31, HUB-15 — the rules behind a QR code on a wall:
// what a scan shows anyone (no login), that it never warns, what a code's token is, where a
// printed code points, and how the label sheets are laid out.
//
// WHY THIS SUITE. The scan page is PUBLIC: whatever the projection returns, a stranger
// with a phone reads. So its keys are enumerated against an allowlist rather than checked
// one by one, and every secret the server knows about an area (who cleaned it, the result
// it came from, the cleaner's notes, the photo's caption, the ids) is fed IN and looked for
// in what comes OUT. QR-28 took the 24-hour warning away ("Never warn; show the next scheduled
// clean instead"), so a clean of any age is checked to read the same, and the next clean and the
// last inspection are checked to be DATES only, in the org's zone, with the server's job and
// inspection secrets fed in. A token IS the capability, so its strength and
// its source of randomness are checked mechanically. A printed code outlives every deploy,
// so the address it encodes may never be a host written into the code. And a label sheet
// that is a sixteenth of an inch out wastes a pack of labels, so the geometry is asserted
// against Avery's published layouts.
//
// Halves:
//   §1  the public allowlist projection (lib/areaScan.projectAreaScan)
//   §2  no warning at any age (QR-28); the time shown in the org's zone
//   §2b the next clean (QR-28), the last inspection (QR-15), the urgent line (QR-31)
//   §3  tokens: shape, strength, source of randomness
//   §4  the address a code points at (the app's configured address — the route passes
//       appPublicUrl() — else, as the last resort, the request's own origin)
//   §5  label geometry per format, the one-page sheet, the printable HTML (QR-6)
//   §6  who may manage codes (one rule, the server's and the screen's)
//   §7  which areas still need a code (the idempotent mint)
//   §8  the demo: a recent, an older and a never-cleaned area through the SAME projection
//   §9  wiring that a screen cannot show: the public route, the stub gate, the rewrites
//
// REGRESSION (THE LAW II.3): on the pre-change tree (ab55e180) none of the modules exist,
// so every import below falls back to "nothing" and every check reports what it wanted. QR Wave 2
// (2026-10-17): on 90d7ca9e §2's no-warning checks, §2b and the new keys of §1 fail.
//
//   node app/scripts/test-area-scan.mjs
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

// The app's own imports omit the extension (Vite resolves them) and a few read
// import.meta.env; the demo seed (§8) needs both to load under bare node.
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec)) {
        for (const ext of ['.js', '.jsx', '/index.js']) { try { return next(spec + ext, ctx); } catch { /* next */ } }
      }
      throw e;
    }
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (/\/app\/src\//.test(url) && r.source && String(r.source).includes('import.meta.env')) {
      r.source = `if (!import.meta.env) import.meta.env = { MODE: 'test', PROD: false, DEV: true };\n${r.source}`;
    }
    return r;
  },
});
const imp = (rel) => import(pathToFileURL(path.join(APP, rel)).href).catch(() => ({}));

const scan = await imp('src/lib/areaScan.js');
const codes = await imp('src/lib/scanCodes.js');
const tokenMod = await imp('api/_lib/scanCodes/token.js');
const { DEFAULT_ORG_TIMEZONE } = await imp('src/lib/dates.js');
const { PERMISSIONS } = await imp('src/lib/roles.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600 * 1000;

const projectAreaScan = fn(scan, 'projectAreaScan');
const formatScanWhen = fn(scan, 'formatScanWhen');
const scanTimeZone = fn(scan, 'scanTimeZone');
const isScanToken = fn(scan, 'isScanToken');
const scanShowsPhoto = fn(scan, 'scanShowsPhoto');
const encodeScanToken = fn(scan, 'encodeScanToken');
const scanBaseUrl = fn(scan, 'scanBaseUrl');
const scanUrl = fn(scan, 'scanUrl');
const scanStatusCopy = fn(scan, 'scanStatusCopy');
const mintScanToken = fn(tokenMod, 'mintScanToken');
const scanNextCleanDay = fn(scan, 'scanNextCleanDay');
const scanLastInspectionDay = fn(scan, 'scanLastInspectionDay');
// The app's ONE dial rule (UI_RULES §28), read by PhoneLink and by the projection (QR-31).
const telMod = await imp('src/lib/telHref.js');
const dialHref = fn(telMod, 'telHref');
const scanNextCleanText = fn(scan, 'scanNextCleanText');
const scanLastInspectionText = fn(scan, 'scanLastInspectionText');
const KEYS = scan.PUBLIC_SCAN_KEYS || [];
const ITEM_KEYS = scan.PUBLIC_SCAN_ITEM_KEYS || [];
const PHOTO_KEYS = scan.PUBLIC_SCAN_PHOTO_KEYS || [];
// The never-cleaned state's words (Daniel, 2026-10-16), the one state with no clean on record.
const NEVER_COPY = { badge: 'Cleaning records start soon', variant: 'slate' };

// ── §1 the public allowlist projection ──────────────────────────────────────
// A `siteAreaStatus` row as the server holds it, carrying EVERYTHING it knows about the
// area — plus keys a careless caller might spread in. None of the secret values may reach
// the page.
const NOW = Date.parse('2026-10-03T03:30:00.000Z');
const SECRETS = {
  userId: 'u_seed_andre_secret',
  resultId: 'cr_result_secret',
  checklistName: 'Full Facility Deep-Clean SECRET',
  note: 'Cleaner note: stall 3 is broken SECRET',
  caption: 'internal caption SECRET',
  mediaId: 'am_media_secret',
  itemKey: 'fi_rest_toilet_secret',
  internal: 'internal note SECRET',
  clientId: 'cl_client_secret',
  siteId: 'st_site_secret',
  areaId: 'area_rest_secret',
  instructions: 'Check the baby-change table SECRET',
};
const FULL_ROW = {
  areaId: SECRETS.areaId,
  label: 'Restrooms',
  instructions: SECRETS.instructions,
  lastCleanedAt: iso(NOW - 4 * HOUR),
  lastCleanedByUserId: SECRETS.userId,
  resultId: SECRETS.resultId,
  checklistName: SECRETS.checklistName,
  items: [
    { key: SECRETS.itemKey, label: 'Toilets sanitized', state: 'done', note: SECRETS.note, needsPhoto: false, hasPhoto: false },
    { key: 'fi_rest_spot_secret', label: 'Spots treated', state: 'na', note: null, needsPhoto: false, hasPhoto: false },
    { key: 'fi_rest_mop_secret', label: 'Floors mopped', state: 'notdone', note: null, needsPhoto: true, hasPhoto: false },
  ],
  photo: {
    id: SECRETS.mediaId, itemKey: SECRETS.itemKey, createdAt: iso(NOW - 5 * HOUR),
    url: 'https://storage.example/sign/a.jpg?token=t', thumbUrl: 'https://storage.example/sign/a.thumb.jpg?token=t',
    caption: SECRETS.caption, kind: 'image',
  },
  internal_note: SECRETS.internal,
  internalNote: SECRETS.internal,
  clientId: SECRETS.clientId,
  siteId: SECRETS.siteId,
};
// The two dates and the phone the route adds (QR-28, QR-15, QR-31): what the store hands the
// projection. The next clean is the day of a 9:30 PM clean two days on; the inspection's day is
// from its record; the phone as Settings → Company holds it.
const NEXT_DAY = '2026-10-04';
const INSPECTED_DAY = '2026-09-29';
const PHONE = '(555) 010-4477';
const out = projectAreaScan({
  building: 'Coral Bay HOA', location: 'Clubhouse', area: FULL_ROW, timeZone: 'America/New_York', nowMs: NOW,
  nextCleanOn: NEXT_DAY, lastInspectionOn: INSPECTED_DAY, phone: PHONE,
}) || {};
ok('the projection module exists and exports the projection and its allowlists',
  typeof scan.projectAreaScan === 'function' && KEYS.length > 0 && ITEM_KEYS.length > 0 && PHOTO_KEYS.length > 0);
ok('the top-level keys are EXACTLY the allowlist', sameSet(Object.keys(out), KEYS), `got ${Object.keys(out).join(',')}`);
ok('every item carries only allowlisted keys', Array.isArray(out.items) && out.items.length > 0
  && out.items.every((i) => Object.keys(i).every((k) => ITEM_KEYS.includes(k))), JSON.stringify(out.items));
ok('the photo carries only allowlisted keys', out.photo && Object.keys(out.photo).every((k) => PHOTO_KEYS.includes(k)), JSON.stringify(out.photo));
{
  const FORBIDDEN_KEYS = ['id', 'key', 'userId', 'lastCleanedByUserId', 'resultId', 'checklistName', 'note', 'notes',
    'internal_note', 'internalNote', 'clientId', 'siteId', 'areaId', 'itemKey', 'caption', 'instructions',
    'completed_by_user_id', 'client_id', 'site_id', 'public_token', 'token'];
  const keysIn = (v, acc = []) => {
    if (Array.isArray(v)) v.forEach((x) => keysIn(x, acc));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.push(k); keysIn(x, acc); }
    return acc;
  };
  const found = keysIn(out).filter((k) => FORBIDDEN_KEYS.includes(k));
  ok('no forbidden KEY appears at any depth (ids, names, notes, internal_note)', found.length === 0, found.join(','));
}
{
  const wire = JSON.stringify(out);
  for (const [what, secret] of Object.entries(SECRETS)) ok(`no ${what} on the wire`, !wire.includes(secret));
  // `lastInspectionOn` is the one inspection key, and it is a DATE (QR-15, §2b); nothing of a report.
  ok('nothing from projectReport rides along (no inspection, rating, score or inspector)',
    !/inspection|rating|overall|inspector|score/i.test(Object.keys(out).filter((k) => k !== 'lastInspectionOn').join(',')));
}
eq('the area is named in words', out.area, 'Restrooms');
eq('the building is the customer\'s name', out.building, 'Coral Bay HOA');
eq('…and the location rides beside it', out.location, 'Clubhouse');
ok('a NOT-DONE item is never listed (the page lists what was done)', Array.isArray(out.items) && !out.items.some((i) => i.label === 'Floors mopped'));
eq('a done item reads done', out.items?.find((i) => i.label === 'Toilets sanitized')?.state, 'done');
eq('an item that did not apply reads na', out.items?.find((i) => i.label === 'Spots treated')?.state, 'na');
eq('the photo keeps its time', out.photo?.takenAt, FULL_ROW.photo.createdAt);
// The photo's signed Storage URL carries the storage path (org / site / file), so it never
// rides the projection: the page fetches the bytes through the public route's own /photo,
// keyed by the token the scanner already holds.
ok('…and no URL at all: a storage path can never reach the page', !/https?:\/\//.test(JSON.stringify(out)) && !JSON.stringify(out).includes('storage.example'));
{
  const vid = projectAreaScan({ building: 'B', area: { ...FULL_ROW, photo: { ...FULL_ROW.photo, kind: 'video' } }, nowMs: NOW }) || {};
  eq('a video is not shown as the area\'s photo', vid.photo, null);
  const none = projectAreaScan({ building: 'B', area: { ...FULL_ROW, photo: null }, nowMs: NOW }) || {};
  eq('no photo is null, not an empty object', none.photo, null);
}
{
  const never = projectAreaScan({ building: 'B', area: { label: 'Lobby', lastCleanedAt: null, items: [], photo: null }, nowMs: NOW }) || {};
  ok('an area with no recorded clean reads the neutral never state', JSON.stringify(scanStatusCopy(never.lastCleanedAt)) === JSON.stringify(NEVER_COPY), JSON.stringify(scanStatusCopy(never.lastCleanedAt)));
  eq('…with no time', never.lastCleanedAt, null);
  ok('…and no items', Array.isArray(never.items) && never.items.length === 0);
  // A photo was taken on an item there, but no clean of the area was ever FINISHED (another
  // item was left undone). Round 1's area status keeps that photo (evidence of the place, which
  // the office's card wants); the public page must not put it under "no record of this area
  // being cleaned", so the answer and the photo route ask ONE question (S113, 2026-10-04).
  const neverWithPhoto = projectAreaScan({ building: 'B', area: { label: 'Floors', lastCleanedAt: null, items: [], photo: FULL_ROW.photo }, nowMs: NOW }) || {};
  eq('an area never recorded shows NO photo, even when one was taken on an item there', neverWithPhoto.photo, null);
  ok('…one exported rule, scanShowsPhoto, says so', scanShowsPhoto({ lastCleanedAt: null, photo: FULL_ROW.photo }) === false && scanShowsPhoto(FULL_ROW) === true);
  ok('…and the photo route asks the same rule before it reads a byte', read('api/_lib/scanCodes/store.js').includes('if (!scanShowsPhoto(st.row)) return { none: true };'));
  const unnamed = projectAreaScan({ building: '', area: { label: '  ', items: [] }, nowMs: NOW }) || {};
  ok('a blank area name still reads as words, never empty', typeof unnamed.area === 'string' && unnamed.area.trim().length > 0, JSON.stringify(unnamed.area));
}

// ── §2 no warning at any age (QR-28) ────────────────────────────────────────
// Matt (2026-10-16): "Never warn; show the next scheduled clean instead." It supersedes QR-5's
// 24-hour warning, so a clean of ANY age reads exactly the same: the time says when.
{
  const T = Date.parse('2026-10-02T23:30:00.000Z');
  const calm = scanStatusCopy(iso(T));
  ok('a recorded clean reads one calm state: a green "Cleaned" badge', calm?.badge === 'Cleaned' && calm?.variant === 'green', JSON.stringify(calm));
  for (const [what, ms] of [['a minute', 60000], ['exactly 24 hours', 24 * HOUR], ['24 hours and a millisecond', 24 * HOUR + 1],
    ['30 hours', 30 * HOUR], ['a week', 7 * 24 * HOUR], ['a year', 366 * 24 * HOUR]]) {
    const c = scanStatusCopy(iso(T - ms)) || {};
    ok(`🔴 a clean ${what} old reads the same — no amber, no red, no warning line`, JSON.stringify(c) === JSON.stringify(calm)
      && c.variant !== 'amber' && c.variant !== 'red' && !('warning' in c), JSON.stringify(c));
  }
  ok('a stamp in the future (a wrong phone clock) reads the same too', JSON.stringify(scanStatusCopy(iso(T + HOUR))) === JSON.stringify(calm));
  ok('🔴 the never state is unchanged: Daniel\'s slate "Cleaning records start soon", no warning', JSON.stringify(scanStatusCopy(null)) === JSON.stringify(NEVER_COPY));
  ok('…an unreadable time is the never state, not a clean', JSON.stringify(scanStatusCopy('not a date')) === JSON.stringify(NEVER_COPY));
  // What the old rule needed is gone (II.5), and nothing reads it.
  ok('🔴 the 24-hour rule is deleted: no SCAN_STALE_AFTER_* / SCAN_FRESHNESS / scanFreshness export', !('SCAN_STALE_AFTER_HOURS' in scan)
    && !('SCAN_STALE_AFTER_MS' in scan) && !('SCAN_FRESHNESS' in scan) && !('scanFreshness' in scan), Object.keys(scan).filter((k) => /STALE|FRESH/i.test(k)).join(','));
  ok('…the answer carries no freshness and no stale-hours key', !KEYS.includes('freshness') && !KEYS.includes('staleAfterHours') && !('freshness' in out) && !('staleAfterHours' in out));
  const feature = ['src/lib/areaScan.js', 'src/components/AreaScanCard.jsx', 'src/pages/PublicAreaScan.jsx', 'src/lib/scanCodesApi.js', 'api/public/scan/[...path].js', 'api/_lib/scanCodes/store.js'];
  const stale = feature.filter((f) => /callout-warning|scan-warning|staleAfterHours|scanFreshness|Not cleaned in the last|more than \$\{?hours/.test(stripComments(read(f))));
  ok('…and no file of the page draws a warning any more (no callout, no "Not cleaned in the last …")', stale.length === 0, stale.join(', '));
  ok('…nor does the stylesheet keep its rule', !/\.scan-warning\b/.test(read('src/index.css')));
}
{
  const norm = (s) => String(s || '').replace(/[\u00a0\u202f]/g, ' ');
  const late = '2026-10-03T03:30:00.000Z'; // 11:30 PM Oct 2 in New York; 3:30 AM Oct 3 in UTC
  const shown = norm(formatScanWhen(late, 'America/New_York'));
  ok('a late-night clean shows the ORG\'s date and time (Oct 2, 11:30 PM), not UTC\'s', /Oct 2\b/.test(shown) && /11:30/.test(shown) && /PM/.test(shown), shown);
  ok('…the zone passed is the zone used (UTC would read Oct 3, 3:30 AM)', /Oct 3\b/.test(norm(formatScanWhen(late, 'UTC'))) && /3:30/.test(norm(formatScanWhen(late, 'UTC'))));
  eq('an unknown zone falls back to the org default', scanTimeZone('Mars/Olympus_Mons'), DEFAULT_ORG_TIMEZONE);
  eq('a blank zone falls back to the org default', scanTimeZone(''), DEFAULT_ORG_TIMEZONE);
  eq('a real zone is kept', scanTimeZone('America/Chicago'), 'America/Chicago');
  eq('the projection carries the zone it will be read in', out.timeZone, 'America/New_York');
  const bogus = projectAreaScan({ building: 'B', area: FULL_ROW, timeZone: 'Not/AZone', nowMs: NOW }) || {};
  eq('…and never a zone the browser cannot use', bogus.timeZone, DEFAULT_ORG_TIMEZONE);
  eq('the projection says when it was checked', out.checkedAt, iso(NOW));
}

// ── §2b the next clean (QR-28), the last inspection (QR-15), the urgent line (QR-31) ─────────
{
  const TZ = 'America/New_York';
  // 2026-10-17, 8:00 PM in New York (00:00 UTC on the 18th): "today" is the 17th in the org's zone.
  const N = Date.parse('2026-10-18T00:00:00.000Z');
  const SITE = 'st_site';
  const J = (id, startAt, status = 'upcoming', extra = {}) => ({
    id, siteId: SITE, clientId: 'cl_x', startAt, endAt: startAt, status, crewIds: ['u_crew_SECRET'], notes: 'gate code 9911 SECRET', ...extra,
  });
  const next = (jobs, extra = {}) => scanNextCleanDay({ jobs, siteId: SITE, timeZone: TZ, nowMs: N, ...extra });
  ok('the next-clean rule exists, with its bounded window', typeof scan.scanNextCleanDay === 'function' && Number.isInteger(scan.SCAN_NEXT_CLEAN_DAYS) && scan.SCAN_NEXT_CLEAN_DAYS > 0, String(scan.SCAN_NEXT_CLEAN_DAYS));
  const tonight = J('j_tonight', '2026-10-18T01:30:00.000Z');            // 9:30 PM Oct 17 in New York
  eq('🔴 today\'s clean (org zone) is the next clean, even when UTC already says tomorrow', next([tonight, J('j_tomorrow', '2026-10-19T01:30:00.000Z')]), '2026-10-17');
  eq('…while it is in progress too', next([J('j_live', '2026-10-17T22:00:00.000Z', 'in_progress'), J('j_t2', '2026-10-19T01:30:00.000Z')]), '2026-10-17');
  eq('…and still while it has not started past its time (it is not done)', next([J('j_late', '2026-10-17T14:00:00.000Z')]), '2026-10-17');
  eq('🔴 today\'s clean once DONE is not next: tomorrow\'s is', next([J('j_done', '2026-10-17T22:00:00.000Z', 'done'), J('j_tom', '2026-10-19T01:30:00.000Z')]), '2026-10-18');
  eq('…nor the legacy "completed"', next([J('j_c', '2026-10-17T22:00:00.000Z', 'completed'), J('j_tom', '2026-10-19T01:30:00.000Z')]), '2026-10-18');
  eq('a cancelled clean is never next', next([J('j_x', '2026-10-18T01:30:00.000Z', 'cancelled'), J('j_w', '2026-10-21T01:30:00.000Z')]), '2026-10-20');
  eq('…nor one the office marked missed', next([J('j_m', '2026-10-18T01:30:00.000Z', 'missed'), J('j_w', '2026-10-21T01:30:00.000Z')]), '2026-10-20');
  eq('yesterday\'s unfinished clean is not "next"', next([J('j_y', '2026-10-17T01:30:00.000Z', 'in_progress'), J('j_w', '2026-10-21T01:30:00.000Z')]), '2026-10-20');
  eq('the EARLIEST of several, whatever their order', next([J('b', '2026-10-25T01:30:00.000Z'), J('a', '2026-10-22T01:30:00.000Z'), J('c', '2026-10-23T01:30:00.000Z')]), '2026-10-21');
  eq('another location\'s clean is not this one\'s (the payload is re-checked)', next([J('j_o', '2026-10-18T01:30:00.000Z', 'upcoming', { siteId: 'st_other' })]), null);
  // (Pre-fix the constant does not exist; the fallback only keeps the fixture shaped — the checks still go red.)
  const WINDOW = Number.isInteger(scan.SCAN_NEXT_CLEAN_DAYS) ? scan.SCAN_NEXT_CLEAN_DAYS : 45;
  const lastIn = new Date(Date.parse('2026-10-17T16:00:00.000Z') + WINDOW * 24 * HOUR).toISOString();
  ok(`a clean on the window's last day counts; one past it (beyond ${WINDOW} days) does not`, next([J('j_edge', lastIn)]) !== null
    && next([J('j_far', new Date(Date.parse(lastIn) + 24 * HOUR).toISOString())]) === null, `${next([J('j_edge', lastIn)])}`);
  eq('an unreadable start is skipped', next([J('j_bad', 'tomorrow evening')]), null);
  // The orchestrator's ruling (2026-10-17, on builder P's open question): a clean that STARTED at or
  // before the area's last recorded clean is the visit that already did this area, so it is not the
  // next one — "Last cleaned 5 hours ago · Next clean: Today" never happens; the one after it shows.
  const cleanedAt = '2026-10-17T22:40:00.000Z';                        // 6:40 PM in New York, tonight
  const did = J('j_did', '2026-10-17T22:00:00.000Z', 'in_progress');   // tonight's visit, started 6 PM
  const tom = J('j_tom', '2026-10-19T01:30:00.000Z');                   // tomorrow, 9:30 PM
  eq('🔴 tonight\'s visit that already cleaned this area is not "next": the one after it is', next([did, tom], { lastCleanedAt: cleanedAt }), '2026-10-18');
  eq('🔴 …a clean starting exactly at the last clean is that visit too (at or before)', next([J('j_at', cleanedAt), tom], { lastCleanedAt: cleanedAt }), '2026-10-18');
  eq('…a clean starting AFTER the last clean still counts (a later visit tonight)', next([J('j_later', '2026-10-18T01:30:00.000Z'), tom], { lastCleanedAt: cleanedAt }), '2026-10-17');
  eq('…an area never cleaned skips nothing (today\'s visit is next)', next([did, tom], { lastCleanedAt: null }), '2026-10-17');
  eq('…nor does an unreadable last clean', next([did, tom], { lastCleanedAt: 'not a date' }), '2026-10-17');
  // ONE pure function on all three homes: the public read, the hub's area page and the demo each
  // hand it the area's own last clean.
  const callers = {
    'api/_lib/scanCodes/store.js': read('api/_lib/scanCodes/store.js'),
    'api/hub/[...path].js': read('api/hub/[...path].js'),
    'src/lib/scanCodesApi.js': read('src/lib/scanCodesApi.js'),
  };
  for (const [f, src] of Object.entries(callers)) {
    ok(`🔴 ${f} gives the next-clean rule the area's own last clean`, /scanNextCleanDay\(\{[^}]*lastCleanedAt/.test(stripComments(src)) || /lastCleanedAt: row\.lastCleanedAt/.test(stripComments(src)), f);
  }
  eq('no cleans: null, and the page shows no line', next([]), null);
  // The secrets check: what the rule reads is a job PAYLOAD with crew, notes and a night start time.
  const day = next([tonight]);
  ok('🔴 the answer is a DATE only — no time, crew, notes or job id ever leaves the rule', day === '2026-10-17' && /^\d{4}-\d{2}-\d{2}$/.test(day));
  const withNext = projectAreaScan({ building: 'B', area: FULL_ROW, timeZone: TZ, nowMs: N, nextCleanOn: day }) || {};
  eq('the projection carries it as nextCleanOn', withNext.nextCleanOn, '2026-10-17');
  const wire = JSON.stringify(withNext);
  for (const secret of ['01:30', '9:30', 'T01', 'u_crew_SECRET', 'gate code', 'j_tonight']) ok(`no next-clean secret "${secret}" on the wire`, !wire.includes(secret));
  ok('🔴 an INSTANT handed to the projection is refused: only a day key passes, so no time can ride along',
    (projectAreaScan({ building: 'B', area: FULL_ROW, nowMs: N, nextCleanOn: tonight.startAt }) || {}).nextCleanOn === null
    && (projectAreaScan({ building: 'B', area: FULL_ROW, nowMs: N, nextCleanOn: '2026-02-30' }) || {}).nextCleanOn === null);
  // The page's words, relative to the answer's own checkedAt in the org's zone.
  const at = (nextCleanOn, extra = {}) => scanNextCleanText({ nextCleanOn, checkedAt: iso(N), timeZone: TZ, ...extra });
  eq('"Next clean: Today"', at('2026-10-17'), 'Today');
  eq('"Next clean: Tomorrow"', at('2026-10-18'), 'Tomorrow');
  eq('"Next clean: Wednesday, Oct 21" further on', at('2026-10-21'), 'Wednesday, Oct 21');
  ok('…"today" is the ORG\'s: read in UTC (already the 18th) the 17th is not "Today"', at('2026-10-17', { timeZone: 'UTC' }) !== 'Today', at('2026-10-17', { timeZone: 'UTC' }));
  eq('no next clean: no words', at(null), null);

  // The last inspection: the newest submitted one, never a draft, its org-zone DAY only.
  const I = (id, performed_at, status = 'submitted') => ({ id, status, performed_at, overall_score: 61, result: 'fail', inspector_name: 'Inspector SECRET', public_token: 'tok_SECRET' });
  const rows = [I('i1', '2026-10-10T15:00:00.000Z'), I('i2', '2026-10-15T03:30:00.000Z', 'shared'), I('i3', '2026-10-17T15:00:00.000Z', 'draft')];
  eq('🔴 the last inspection is the newest SUBMITTED one (a draft is no inspection), as its org-zone day', scanLastInspectionDay(rows, TZ), '2026-10-14');
  eq('…a late-night one keeps the org\'s day, not UTC\'s', scanLastInspectionDay([I('i4', '2026-10-15T03:30:00.000Z')], 'UTC'), '2026-10-15');
  eq('none: null, and no line', scanLastInspectionDay([I('i5', '2026-10-17T15:00:00.000Z', 'draft')], TZ), null);
  const withInsp = projectAreaScan({ building: 'B', area: FULL_ROW, timeZone: TZ, nowMs: N, lastInspectionOn: scanLastInspectionDay(rows, TZ) }) || {};
  eq('the projection carries it as lastInspectionOn', withInsp.lastInspectionOn, '2026-10-14');
  const iw = JSON.stringify(withInsp);
  for (const secret of ['61', 'fail', 'Inspector SECRET', 'tok_SECRET', 'i2', '03:30']) ok(`no inspection secret "${secret}" on the wire (he asked WHEN, not how it went)`, !iw.includes(`"${secret}"`) && !iw.includes(secret === '61' ? ':61' : secret));
  eq('"Last inspection: Oct 14"', scanLastInspectionText({ lastInspectionOn: '2026-10-14', checkedAt: iso(N), timeZone: TZ }), 'Oct 14');
  eq('…with the year when it is another year\'s', scanLastInspectionText({ lastInspectionOn: '2025-12-30', checkedAt: iso(N), timeZone: TZ }), 'Dec 30, 2025');
  eq('…nothing when there is none', scanLastInspectionText({ lastInspectionOn: null, checkedAt: iso(N), timeZone: TZ }), null);

  // The urgent line (QR-31): the company's phone as written, dialled by digits.
  eq('🔴 the answer carries the company\'s phone as written', out.urgentPhone, PHONE);
  eq('🔴 its tel: href is digits only', dialHref(PHONE), 'tel:5550104477');
  eq('…a leading + is kept (an international number)', dialHref(' +1 (555) 010-4477 '), 'tel:+15550104477');
  eq('…a + anywhere else is not', dialHref('555+010+4477'), 'tel:5550104477');
  ok('…and nothing but digits and that + ever reaches the href', /^tel:\+?\d+$/.test(dialHref('call (555) 010-4477 ext. 2; javascript:alert(1)') || ''), dialHref('call (555) 010-4477 ext. 2; javascript:alert(1)'));
  for (const none of [null, '', '   ', 'TBD', 42]) {
    eq(`no phone to dial (${JSON.stringify(none)}) → no line`, (projectAreaScan({ building: 'B', area: FULL_ROW, nowMs: N, phone: none }) || {}).urgentPhone, null);
  }
  ok('a phone is cut to a sane length', ((projectAreaScan({ building: 'B', area: FULL_ROW, nowMs: N, phone: `555 ${'1'.repeat(200)}` }) || {}).urgentPhone || '').length <= 40);
  const bare = projectAreaScan({ building: 'B', area: FULL_ROW, nowMs: N }) || {};
  eq('nothing passed: no next clean, no inspection, no phone — each key present and null (the old RPC, the hub page)', JSON.stringify(['nextCleanOn', 'lastInspectionOn', 'urgentPhone'].map((k) => (k in bare ? bare[k] : 'missing'))), JSON.stringify([null, null, null]));
}

// ── §3 tokens ───────────────────────────────────────────────────────────────
ok('the token rules exist', typeof scan.isScanToken === 'function' && typeof tokenMod.mintScanToken === 'function');
ok('≥128 bits of randomness per token', (scan.SCAN_TOKEN_BYTES || 0) * 8 >= 128, String(scan.SCAN_TOKEN_BYTES));
{
  const seen = new Set();
  let shaped = 0;
  for (let i = 0; i < 5000; i += 1) {
    const t = mintScanToken();
    if (isScanToken(t)) shaped += 1;
    seen.add(t);
  }
  eq('5,000 minted tokens are all well-formed', shaped, 5000);
  eq('…and all distinct', seen.size, 5000);
  const chars = new Set([...seen].join(''));
  ok('…spread over the whole URL-safe alphabet (64 symbols seen)', chars.size === 64, `saw ${chars.size}`);
  ok('…with nothing a URL would need to escape', [...seen].every((t) => encodeURIComponent(t) === t));
}
ok('a token is exactly 32 URL-safe characters', isScanToken('A'.repeat(31) + '_') && isScanToken('-'.repeat(32)));
ok('a short token is refused', !isScanToken('abc'));
ok('a long token is refused', !isScanToken('a'.repeat(33)));
ok('a slash, a dot or base64 padding is refused', !isScanToken('a'.repeat(31) + '/') && !isScanToken('a'.repeat(31) + '.') && !isScanToken('a'.repeat(31) + '='));
ok('a non-string is refused', !isScanToken(null) && !isScanToken(undefined) && !isScanToken(12345) && !isScanToken(['a'.repeat(32)]));
{
  let threw = false;
  try { encodeScanToken(new Uint8Array(8)); } catch { threw = true; }
  ok('encoding refuses fewer bytes than the rule demands', threw);
  eq('24 bytes encode to a 32-character token', encodeScanToken(new Uint8Array(24).fill(255)), '_'.repeat(32));
}
{
  const SCAN_FILES = [
    'src/lib/areaScan.js', 'src/lib/scanCodes.js', 'src/lib/scanCodesApi.js', 'src/data/demoScanCodes.js',
    'api/_lib/scanCodes/token.js', 'api/_lib/scanCodes/store.js', 'api/_lib/scanCodes/sheetPdf.js',
    'api/scan-codes/[...path].js', 'api/public/scan/[...path].js',
    'src/pages/PublicAreaScan.jsx', 'src/components/AreaScanCodes.jsx',
  ];
  const present = SCAN_FILES.filter((f) => read(f));
  eq('every file of the feature is present', present.length, SCAN_FILES.length);
  const mathRandom = present.filter((f) => /Math\.random/.test(stripComments(read(f))));
  ok('no file of the feature calls Math.random', mathRandom.length === 0, mathRandom.join(', '));
  ok('the server minter draws from node:crypto', /from 'node:crypto'/.test(read('api/_lib/scanCodes/token.js')) && /randomBytes\(/.test(read('api/_lib/scanCodes/token.js')));
  ok('the demo minter draws from Web Crypto', /getRandomValues\(/.test(read('src/lib/scanCodesApi.js')));

  // ── §4 (mechanical half) no host is written into the feature ─────────────
  const HOSTS = [/cleanspace-gilt/i, /cleancorner/i, /vercel\.app/i, /IDENTITY\.appUrl/, /https?:\/\/(?!www\.w3\.org\/)[a-z0-9.-]+\.[a-z]{2,}/i];
  const hosted = present.filter((f) => HOSTS.some((re) => re.test(stripComments(read(f)))));
  ok('no file of the feature names a host (the code points wherever the app is served)', hosted.length === 0, hosted.join(', '));
}

// ── §4 the address a code points at ─────────────────────────────────────────
eq('the app\'s configured address wins (the route passes appPublicUrl())', scanBaseUrl({ appPublicUrl: 'https://app-one.example/', origin: 'https://other.example' }), 'https://app-one.example');
eq('…else, with no address configured, the request\'s own origin (the last resort; the demo\'s page origin)', scanBaseUrl({ origin: 'https://preview-42.example' }), 'https://preview-42.example');
eq('…a path on APP_PUBLIC_URL is reduced to its origin (the app is served at the root)', scanBaseUrl({ appPublicUrl: 'https://app-one.example/some/path' }), 'https://app-one.example');
eq('…a port is kept (local and preview hosts)', scanBaseUrl({ origin: 'http://localhost:5214' }), 'http://localhost:5214');
eq('a non-web scheme is refused', scanBaseUrl({ origin: 'javascript:alert(1)' }), null);
eq('a malformed APP_PUBLIC_URL falls back to the origin rather than printing garbage', scanBaseUrl({ appPublicUrl: 'not a url', origin: 'https://ok.example' }), 'https://ok.example');
eq('nothing at all is null (the route then refuses to print a code to nowhere)', scanBaseUrl({}), null);
{
  const T = 'Ab-_'.repeat(8);
  eq('a scan URL is the base + /scan/ + the token', scanUrl('https://app-one.example', T), `https://app-one.example/scan/${T}`);
  eq('…a malformed token makes no URL', scanUrl('https://app-one.example', 'nope'), null);
  eq('…nor does a missing base', scanUrl(null, T), null);
}

// ── §5 label geometry (QR-6) ────────────────────────────────────────────────
const FORMATS = codes.LABEL_FORMATS || {};
// Avery's published layouts — the external source of truth, restated here on purpose. (Avery 22805,
// 1½″ squares, was removed 2026-10-17: it cannot hold a 1¼″ code with the name under it — QR-10,
// test-qr-label-size.mjs.)
const AVERY = {
  avery5163: { perSheet: 10, wIn: 4, hIn: 2 },
  avery5164: { perSheet: 6, wIn: 4, hIn: 10 / 3 },
};
const labelPages = fn(codes, 'labelPages');
const close = (a, b) => Math.abs(a - b) < 1e-6;
eq('the default label sheet is Avery 5163 / 8163 (2" x 4")', codes.DEFAULT_LABEL_FORMAT, 'avery5163');
ok('the two formats the office can pick are offered', sameSet(Object.keys(FORMATS), Object.keys(AVERY)), Object.keys(FORMATS).join(','));
for (const [key, want] of Object.entries(AVERY)) {
  const f = FORMATS[key] || {};
  eq(`${key}: labels per sheet`, (f.cols || 0) * (f.rows || 0), want.perSheet);
  eq(`${key}: the count it advertises is the grid's`, f.perSheet, want.perSheet);
  ok(`${key}: label size ${want.wIn}" x ${want.hIn.toFixed(3)}"`, close(f.wIn, want.wIn) && close(f.hIn, want.hIn), `${f.wIn} x ${f.hIn}`);
  const pages = labelPages(key, want.perSheet) || [];
  eq(`${key}: one full sheet is one page`, pages.length, 1);
  const rects = pages.flat();
  eq(`${key}: …holding every label`, rects.length, want.perSheet);
  ok(`${key}: every label sits on the US-letter page`, rects.length > 0 && rects.every((r) => r.xIn >= 0 && r.yIn >= 0
    && r.xIn + r.wIn <= codes.LETTER?.widthIn + 1e-9 && r.yIn + r.hIn <= codes.LETTER?.heightIn + 1e-9));
  const overlap = rects.some((a, i) => rects.some((b, j) => j > i
    && a.xIn < b.xIn + b.wIn - 1e-9 && b.xIn < a.xIn + a.wIn - 1e-9 && a.yIn < b.yIn + b.hIn - 1e-9 && b.yIn < a.yIn + a.hIn - 1e-9));
  ok(`${key}: no two labels overlap`, rects.length > 0 && !overlap);
  const more = labelPages(key, want.perSheet + 3) || [];
  ok(`${key}: three more codes than a sheet holds spill onto a second page of three`, more.length === 2 && more[0].length === want.perSheet && more[1].length === 3);
}
ok('the US-letter page is 8.5" x 11"', codes.LETTER?.widthIn === 8.5 && codes.LETTER?.heightIn === 11);
ok('Avery 5163 starts half an inch down and steps 4.1875" across (gLabels\' published layout)',
  close(FORMATS.avery5163?.y0In, 0.5) && close(FORMATS.avery5163?.dxIn, 4.1875) && close(FORMATS.avery5163?.dyIn, 2));
eq('an unknown saved format reads as the default', fn(codes, 'labelFormatKey')('avery9999'), 'avery5163');
eq('…a missing one too', fn(codes, 'labelFormatKey')(undefined), 'avery5163');
eq('…a real one is kept', fn(codes, 'labelFormatKey')('avery5164'), 'avery5164');
ok('the strict check refuses what the lenient reader forgives (the route 400s on it)',
  fn(codes, 'isLabelFormat')('avery5164') === true && fn(codes, 'isLabelFormat')('avery9999') === false);
eq('the office\'s choice is remembered under one opsSettings key', codes.LABEL_FORMAT_SETTING, 'scanLabelFormat');
{
  const grid = fn(codes, 'sheetGrid');
  const sheetPages = fn(codes, 'sheetPages');
  ok('the one-page sheet grows its grid with the building, to four across (QR-10)', grid(4)?.cols === 2 && grid(9)?.cols === 3 && grid(16)?.cols === 4 && grid(25)?.cols === 4);
  eq('a nine-area building fits ONE page ("one sheet with all the QR codes in it")', (sheetPages(9) || []).length, 1);
  eq('…so does a sixteen-area one', (sheetPages(16) || []).length, 1);
  eq('…past 16 a second page follows', (sheetPages(30) || []).length, 2);
  const cells = (sheetPages(9) || []).flat();
  ok('every cell of the sheet sits inside the page margins', cells.length === 9 && cells.every((r) => r.xIn >= 0.25 && r.yIn >= 0.25
    && r.xIn + r.wIn <= 8.25 + 1e-9 && r.yIn + r.hIn <= 10.75 + 1e-9));
}
// The printable document: the QR in it IS the matrix of that label's own URL.
{
  const QRCode = (await import('qrcode').catch(() => ({}))).default || {};
  const qrPathData = fn(codes, 'qrPathData');
  const buildScanSheetHtml = fn(codes, 'buildScanSheetHtml');
  const base = 'https://app-one.example';
  const list = ['Lobby & entrance', 'Restrooms', '<script>alert(1)</script>'].map((label, i) => {
    const token = String.fromCharCode(65 + i).repeat(32);
    const url = `${base}/scan/${token}`;
    return { label, url, qr: QRCode.create ? QRCode.create(url, { errorCorrectionLevel: 'M' }) : null };
  });
  const html = String(buildScanSheetHtml({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA', location: 'Clubhouse', codes: list }) || '');
  ok('the label document sets a US-letter page with no printer margin', /@page\s*\{[^}]*size:\s*8\.5in 11in[^}]*margin:\s*0/.test(html));
  eq('one label per code', (html.match(/class="lbl /g) || []).length, 3);
  ok('every label names its area', html.includes('Lobby &amp; entrance') && html.includes('Restrooms'));
  ok('…and the building', (html.match(/Coral Bay HOA/g) || []).length >= 3);
  ok('…and carries the line QR-6 asks for', (html.match(/Scan to see when this area was last cleaned/g) || []).length === 3);
  ok('an area name cannot inject markup into the document', !html.includes('<script>alert(1)') && html.includes('&lt;script&gt;'));
  const d0 = list[0].qr ? qrPathData(list[0].qr)?.d : null;
  ok('the QR drawn on the lobby label is the matrix of the LOBBY\'s own URL', !!d0 && html.includes(d0));
  const d1 = list[1].qr ? qrPathData(list[1].qr)?.d : null;
  ok('…and the restrooms label carries the restrooms code, not the lobby\'s', !!d1 && d1 !== d0 && html.includes(d1));
  const sheet = String(buildScanSheetHtml({ layout: 'sheet', format: 'avery5163', building: 'Coral Bay HOA', codes: list }) || '');
  eq('the one-page sheet draws every code once', (sheet.match(/class="cell /g) || []).length, 3);
  ok('…on ONE page', (sheet.match(/class="pg /g) || []).length === 1);
  ok('the document reads no colour literal: it is built from the document palette', !/#[0-9a-f]{3,8}\b/i.test(stripComments(read('src/lib/scanCodes.js'))));
  const tall = String(buildScanSheetHtml({ layout: 'labels', format: 'avery5164', building: 'Coral Bay HOA', codes: list }) || '');
  ok('the tall label carries the area, the building and the line too', tall.includes('Restrooms') && tall.includes('Coral Bay HOA') && tall.includes('Scan to see when this area was last cleaned'));
}

// ── §6 who may manage codes ─────────────────────────────────────────────────
{
  const allowed = fn(codes, 'scanCodesAllowed');
  const key = codes.SCAN_CODES_PERMISSION;
  ok('the gate is a real permission key', !!key && !!PERMISSIONS?.[key], String(key));
  ok('…one crew do not hold by default', !!PERMISSIONS?.[key] && !PERMISSIONS[key].defaultRoles.includes('crew'));
  ok('an office role holding it may', allowed('manager', true) === true && allowed('owner', true) === true && allowed('admin', true) === true);
  ok('crew NEVER, even with the key granted to them', allowed('crew', true) === false);
  ok('nobody without the key', allowed('owner', false) === false);
  ok('an unresolved role never', allowed(null, true) === false && allowed('client', true) === false);
}

// ── §7 which areas still need a code ────────────────────────────────────────
{
  const plan = fn(codes, 'planScanCodes');
  const areas = [{ id: 'a1', label: 'One' }, { id: 'a2', label: 'Two' }, { id: 'a3', label: 'Three' }];
  const rows = [
    { area_id: 'a1', token: 'T1'.repeat(16), revoked_at: null, created_at: '2026-10-01T00:00:00Z' },
    { area_id: 'a2', token: 'T2'.repeat(16), revoked_at: '2026-10-02T00:00:00Z', created_at: '2026-10-01T00:00:00Z' },
    { area_id: 'gone', token: 'T9'.repeat(16), revoked_at: null, created_at: '2026-10-01T00:00:00Z' },
  ];
  const p = plan({ areas, codes: rows }) || {};
  ok('an area with a live code keeps it', p.live?.get?.('a1')?.token === 'T1'.repeat(16));
  ok('an area whose only code was replaced needs a new one, as does an area with none', sameSet(p.missing || [], ['a2', 'a3']), JSON.stringify(p.missing));
  ok('a code for an area no longer on the location is not handed back', !p.live?.has?.('gone'));
  const again = plan({ areas, codes: [...rows, { area_id: 'a2', token: 'T3'.repeat(16), revoked_at: null }, { area_id: 'a3', token: 'T4'.repeat(16), revoked_at: null }] }) || {};
  eq('once every area has a live code, nothing is minted (idempotent)', (again.missing || ['x']).length, 0);
  const areasOf = fn(codes, 'scanAreasOf');
  const got = areasOf({ cleaningAreas: [{ id: 'a1', label: ' One ' }, { label: 'no id' }, null, { id: 'a2', label: '' }] }) || [];
  ok('the areas a code can be minted for are the ones with an id, in the office\'s order', got.length === 2 && got[0].id === 'a1' && got[0].label === 'One' && got[1].id === 'a2' && got[1].label === null, JSON.stringify(got));
}

// ── §8 the demo story, through the SAME projection ──────────────────────────
{
  const demo = await imp('src/data/demoScanCodes.js');
  const { buildDemoStubs, QC_CHECKLISTS_STUB_KEY } = await imp('src/data/demoStubs.js');
  const { buildDemoSiteMedia } = await imp('src/data/demoSiteMedia.js');
  const { INITIAL_STATE } = await imp('src/data/seed.js');
  const { siteAreaStatus } = await imp('src/lib/checklistAreas.js');
  const seeded = typeof demo.demoScanCodes === 'function' ? demo.demoScanCodes() : [];
  ok('the demo seeds a code for each of the Clubhouse\'s three areas', sameSet(seeded.map((c) => c.area_id), ['area_lobby', 'area_rest', 'area_floors']));
  ok('…each a well-formed token', seeded.length === 3 && seeded.every((c) => isScanToken(c.token)));
  const site = (INITIAL_STATE?.sites || []).find((s) => s.id === seeded[0]?.site_id);
  ok('…on the Clubhouse location the seed declares', !!site && (site.cleaningAreas || []).length === 3);
  const stubs = typeof buildDemoStubs === 'function' ? buildDemoStubs() : {};
  const results = (stubs[QC_CHECKLISTS_STUB_KEY]?.checklists || []).filter((r) => r.site_id === site?.id);
  const media = (typeof buildDemoSiteMedia === 'function' ? buildDemoSiteMedia().media : [])
    .filter((m) => m.scope === 'checklist' && m.site_id === site?.id);
  const rows = typeof siteAreaStatus === 'function' ? siteAreaStatus({ cleaningAreas: site?.cleaningAreas || [], results, media }) : [];
  const client = (INITIAL_STATE?.clients || []).find((c) => c.id === site?.clientId);
  const now = Date.now();
  const at = (areaId) => projectAreaScan({ building: client?.name, location: site?.name, area: rows.find((r) => r.areaId === areaId), timeZone: INITIAL_STATE?.company?.timezone, nowMs: now }) || {};
  ok('the demo lobby reads as cleaned (a recorded clean)', !!at('area_lobby').lastCleanedAt && scanStatusCopy(at('area_lobby').lastCleanedAt)?.badge === 'Cleaned');
  ok('…with its newest checklist photo (HUB-15)', !!at('area_lobby').photo?.takenAt);
  ok('…which the demo can show (the stub hands the page the photo itself)', rows.find((r) => r.areaId === 'area_lobby')?.photo?.url?.startsWith('data:image/'));
  ok('…and the items done there', (at('area_lobby').items || []).length > 0);
  const rest = at('area_rest');
  ok('🔴 the demo restrooms, last cleaned over a day ago, read the SAME calm way (QR-28: no warning)', !!rest.lastCleanedAt
    && Date.now() - Date.parse(rest.lastCleanedAt) > 24 * HOUR && JSON.stringify(scanStatusCopy(rest.lastCleanedAt)) === JSON.stringify(scanStatusCopy(at('area_lobby').lastCleanedAt)), JSON.stringify(rest.lastCleanedAt));
  ok('the demo hall floors read the never state', at('area_floors').lastCleanedAt === null && JSON.stringify(scanStatusCopy(at('area_floors').lastCleanedAt)) === JSON.stringify(NEVER_COPY));
  eq('…with no photo, although the hub’s example checklist photographed its mop item', at('area_floors').photo, null);
}

// ── §9 wiring a screen cannot show ──────────────────────────────────────────
{
  const app = read('src/App.jsx');
  const authed = app.indexOf('<Route element={<AuthedShell');
  const scanRoute = app.indexOf('path="/scan/:token"');
  ok('/scan/:token is a public route, declared OUTSIDE the signed-in shell', scanRoute > 0 && authed > 0 && scanRoute < authed);
  const page = stripComments(read('src/pages/PublicAreaScan.jsx'));
  ok('the scan page boots no store (it reads only the sign-in session, to send a signed-in person on — UI_RULES §172)', !!page
    && !/from '\.\.\/store'|useStore|useDispatch|useAuth|AppLayout/.test(page) && /useSession\(\)/.test(page));
  ok('the scan page reads through the shared adapter', /getPublicAreaScan/.test(page));
  ok('🔴 the page draws the ONE area card (components/AreaScanCard), the hub\'s area page\'s too', /import AreaScanCard from '\.\.\/components\/AreaScanCard'/.test(page) && /<AreaScanCard scan=\{scan\} photoUrl=\{photoUrl\}>/.test(page));
  const cardSrc = stripComments(read('src/components/AreaScanCard.jsx'));
  ok('the card says "Next clean:" and "Last inspection:" through the one rule\'s words', /Next clean:/.test(cardSrc) && /Last inspection:/.test(cardSrc) && /scanNextCleanText\(scan\)/.test(cardSrc) && /scanLastInspectionText\(scan\)/.test(cardSrc));
  ok('🔴 the urgent line dials through the app\'s ONE click-to-dial (PhoneLink, §28), shown only when the answer has a number', /For urgent problems, call/.test(cardSrc)
    && /<PhoneLink phone=\{scan\.urgentPhone\}/.test(cardSrc) && /\{scan\.urgentPhone && \(/.test(cardSrc) && !/href=\{?["'`]?tel:/.test(cardSrc));
  ok('…whose href is that one rule\'s (lib/telHref: digits and a leading + only)', /import \{ telHref \} from '\.\.\/lib\/telHref'/.test(read('src/components/PhoneLink.jsx'))
    && /href=\{href\}/.test(read('src/components/PhoneLink.jsx')) && /const href = telHref\(phone\)/.test(read('src/components/PhoneLink.jsx')));
  ok('…a link in running text (.linklike), a thumb-sized target on a phone', /className="linklike scan-urgent-link"/.test(cardSrc) && /\.scan-urgent-link \{ min-height: var\(--control-height-lg\);/.test(read('src/index.css')));
  ok('the card boots no store either (a public page draws it)', !/from '\.\.\/store'|useStore|useDispatch|useAuth/.test(cardSrc));
  const api = read('src/lib/scanCodesApi.js');
  ok('the demo adapter is gated on the STATIC build mode, so a production build drops it',
    /import\.meta\.env\.MODE === 'demo'/.test(api) && /markStub\('cs-stub:scanCodes'\)/.test(api));
  ok('the bundle gate knows the sentinel', /scanCodes/.test(read('scripts/check-bundle-stubs.mjs')));
  ok('the demo codes are imported by the adapter only (demoStubs ships in every build; the adapter\'s demo branch does not)',
    !/from '\.\/demoScanCodes'/.test(read('src/data/demoStubs.js')) && /from '\.\.\/data\/demoScanCodes'/.test(api));
  const vercel = read('vercel.json');
  ok('the office domain has its rewrite', vercel.includes('"/api/scan-codes/:rest*"') && vercel.includes('/api/scan-codes/_?subpath=:rest*'));
  ok('the public domain has its rewrite', vercel.includes('"/api/public/scan/:rest*"') && vercel.includes('/api/public/scan/_?subpath=:rest*'));
  const pub = read('api/public/scan/[...path].js');
  ok('the public route declares its stance', /AUTH STANCE: public/.test(pub));
  ok('the public route rate-limits through the shared limiter', /from '\.\.\/\.\.\/_lib\/rateLimit\.js'/.test(pub) && /allow\(req, res/.test(pub));
  ok('the public route never launches a browser', !/chromium|launchBrowser|puppeteer/i.test(stripComments(pub)));
  ok('the public route never reads the whole shared record', !/readOrgState/.test(stripComments(pub)) && !/readOrgState/.test(stripComments(read('api/_lib/scanCodes/store.js'))));
  const card = read('src/components/CleaningInstructionsCard.jsx');
  ok('the codes live on the location\'s Cleaning instructions card', /AreaScanCodes/.test(card) && /scanCodesAllowed\(/.test(card));
  const panel = read('src/components/AreaScanCodes.jsx');
  ok('the office\'s label choice is saved for everyone through opsSettings', /UPDATE_OPS_SETTINGS/.test(panel) && /LABEL_FORMAT_SETTING/.test(panel));
  ok('…by a holder of the Operations settings key the server checks', /usePermission\('time\.config'\)/.test(panel));
  const routes = read('scripts/app-routes.mjs');
  ok('the responsive sweep has a demo token for /scan/:token', /'\/scan\/:token':\s*\[\s*'\/scan\//.test(routes));
}

if (fails.length) { console.error('\narea-scan FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\narea-scan: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
