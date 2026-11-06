// QR-2 / QR-3 / QR-15 / QR-28 / QR-31, HUB-15 — what a QR code on a wall tells whoever scans it.
//
// PURE / node-safe (explicit `.js` imports, no browser globals at load), so the public route
// (api/public/scan), the demo adapter (lib/scanCodesApi), the scan page (pages/PublicAreaScan) and
// the customer hub's area page (api/hub GET area, pages/hub/HubArea) all answer from this ONE module.
//
// Matt (2026-09-29): anyone can scan, no login (QR-3); the page shows when the area was last
// cleaned and the checklist items done there (QR-2), plus the newest checklist photo (HUB-15).
// Matt (2026-10-16): it NEVER warns — the next scheduled clean instead (QR-28, superseding QR-5's
// 24-hour warning); it says when the building was last inspected (his note on QR-15); and it gives a
// phone number for urgent problems (QR-31).
//
// 🔴 THE PROJECTION IS AN ALLOWLIST. Whatever `projectAreaScan` returns, a stranger with a
// phone reads, so it is BUILT key by key from the allowlist below and never spreads a row.
// The server's area row (api/_lib/qc/store.areaStatusForSite → lib/checklistAreas) carries
// who cleaned the area, the result it came from, the checklist's name, the cleaner's notes,
// the photo's id, item key and caption — none of it may reach the page, and none of it can,
// because nothing here copies a key it does not name. The photo travels as a TIME only: its
// signed Storage URL would carry the storage path (org / location / file), so the page
// fetches the bytes through the public route's own `/photo`, keyed by the token the scanner
// already holds. `app/scripts/test-area-scan.mjs` feeds every secret in and looks for it in
// what comes out; `test-area-scan-route.mjs` does the same over the real handler.
import { ITEM_STATE } from './checklistResultView.js';
import { DEFAULT_ORG_TIMEZONE, dayKey, addDaysKey } from './dates.js';
import { JOB_STATUS, isCompletedJobStatus } from './jobStatus.js';
import { telHref } from './telHref.js';

// ── the token: a code's whole capability ────────────────────────────────────
// 24 random bytes from a CSPRNG (node:crypto on the server, Web Crypto in the demo) =
// 192 bits, written as 32 URL-safe base64 characters with no padding. Never Math.random():
// the token IS the capability (THE LAW II.6). The database holds the same shape with a
// CHECK (migration 20261004110000), so no writer can store a weaker one.
export const SCAN_TOKEN_BYTES = 24;
export const SCAN_TOKEN_LENGTH = 32;
export const SCAN_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function isScanToken(v) {
  return typeof v === 'string' && SCAN_TOKEN_RE.test(v);
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Random bytes → the token. Takes the bytes rather than drawing them, so the server and the
// demo each bring their own CSPRNG and this stays pure. 24 bytes are 8 whole 3-byte groups,
// so the output is exactly 32 characters and never needs padding.
export function encodeScanToken(bytes) {
  if (!bytes || bytes.length !== SCAN_TOKEN_BYTES) {
    throw new Error(`A scan token needs exactly ${SCAN_TOKEN_BYTES} random bytes.`);
  }
  let out = '';
  for (let i = 0; i < SCAN_TOKEN_BYTES; i += 3) {
    const n = ((bytes[i] & 255) << 16) | ((bytes[i + 1] & 255) << 8) | (bytes[i + 2] & 255);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  return out;
}

// ── the address a printed code points at ────────────────────────────────────
// A code on a wall outlives every deploy and every alias, so it encodes the app's PERMANENT
// address, from configuration — the office route passes api/_lib/appUrl appPublicUrl()
// (APP_PUBLIC_URL, else APP_BASE_URL, else the brand pack's own address), the emailed links'
// rule — and never a host written into the code. The origin the office's own request came
// from is only the last resort, when no address is configured at all (and the demo, which has
// no deployment, prints its page's own origin). Only an http(s) origin is accepted — never a
// path, never another scheme — so a hostile Origin header can at worst produce no code, never
// a code that points somewhere else.
export const SCAN_PATH = '/scan/';

function webOrigin(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  let u;
  try { u = new URL(v.trim()); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
  return u.origin;
}

// ── a code scanned by the app's own camera (the Cleaner Hub, D5, 2026-10-13) ──
// What a camera reads off a label is the URL printed into it — `<any origin>/scan/<token>`: a label
// outlives a deploy and the app moves to its own domain, so the ORIGIN is never checked, only the
// path — or, should a label ever carry it, the bare token. The token must be one the minter could
// have written (SCAN_TOKEN_RE: encodeScanToken's alphabet and length); anything else is null —
// "That isn't a site code". Shared by the cleaner's scan page and the customer's (one parser).
const SCAN_TEXT_MAX = 2048;
export function scanTokenFromText(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s || s.length > SCAN_TEXT_MAX) return null;
  if (isScanToken(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const m = /^\/scan\/([^/]+)\/?$/.exec(u.pathname);
  if (!m) return null;
  let tok;
  try { tok = decodeURIComponent(m[1]); } catch { return null; }
  return isScanToken(tok) ? tok : null;
}

export function scanBaseUrl({ appPublicUrl = null, origin = null } = {}) {
  return webOrigin(appPublicUrl) || webOrigin(origin);
}

export function scanUrl(base, token) {
  const b = webOrigin(base);
  return b && isScanToken(token) ? `${b}${SCAN_PATH}${token}` : null;
}

// ── QR-28: never a warning ──────────────────────────────────────────────────
// Matt (2026-10-16), asked what an area's page should say on the days between its cleans:
// "Never warn; show the next scheduled clean instead." (It supersedes QR-5's 24-hour warning,
// which told the public "Not cleaned in the last 24 hours" on every day off of a building cleaned
// three times a week.) So a recorded clean reads the same calm way however old it is — the time
// and "how long ago" say when — and the page adds the building's next scheduled clean, below.

// The org's zone, as the page will be read in it: a real IANA zone, else the org default.
// The page boots no store, so it cannot read the zone the app sets ambiently (lib/dates
// setOrgTimezone); the server hands it over with the answer instead, and a zone the
// browser cannot use is replaced here rather than throwing in the visitor's hand.
export function scanTimeZone(tz) {
  const z = typeof tz === 'string' ? tz.trim() : '';
  if (z) {
    try {
      Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions();
      return z;
    } catch { /* not a zone this runtime knows */ }
  }
  return DEFAULT_ORG_TIMEZONE;
}

// "Fri, Oct 2 · 11:30 PM", in the org's zone. English on purpose: documents and pages for
// clients are English (LANG-8), so the date words never switch language mid-sentence.
export function formatScanWhen(iso, tz) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const zone = scanTimeZone(tz);
  const d = new Date(t);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
  return `${day} · ${time}`;
}

// "3 hours ago". Hours up to two days ("30 hours ago"), then days.
export function scanAge(iso, nowMs = Date.now()) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  return `${Math.floor(hrs / 24)} days ago`;
}

// The page's words for its two states, in ONE place. The badge variants are the kit's
// (components/Badge): green is a STATUS colour here, never a button (UI_RULES §11). There is no
// third, warning state (QR-28): a clean on record is "Cleaned" however long ago it was.
export function scanStatusCopy(lastCleanedAt) {
  if (instant(lastCleanedAt)) return { badge: 'Cleaned', variant: 'green' };
  // No clean on record yet: almost always a new label before the area's first clean. A neutral
  // note, never a warning (Daniel, 2026-10-16), so a building's first day of labels does not
  // tell everyone who scans that its areas were never cleaned.
  return { badge: 'Cleaning records start soon', variant: 'slate' };
}

// ── QR-28: the building's NEXT scheduled clean, as a DATE ────────────────────
// The earliest clean at the location that is still to happen — not done (or the legacy
// "completed"), not cancelled, not marked missed — starting today in the ORG's zone or later, within
// SCAN_NEXT_CLEAN_DAYS. Today's clean counts while it isn't done. A DAY KEY (`YYYY-MM-DD`) and never
// a time: the public must not learn when cleaners are on site at night. `jobs` are job payloads
// (api/_lib/jobsTable getJobsAtSite's `data`, or the demo store's jobs) — read for their site,
// status and start only; `siteId` re-checks each payload's own location (the read filters on the
// column; a payload is the truth). Nothing in range → null, and the page shows no line.
//
// `lastCleanedAt` is THIS AREA's last recorded clean (the orchestrator's ruling, 2026-10-17): a clean
// that STARTED at or before it is the visit that already did this area, so it is not the next one —
// the page never says "Last cleaned 5 hours ago · Next clean: Today"; the visit after it shows. An
// area with no clean on record (or an unreadable time) skips nothing. ONE function for every home:
// the public read, the hub's area page and the demo each pass their area's own last clean.
export const SCAN_NEXT_CLEAN_DAYS = 45;
const NOT_A_COMING_CLEAN = new Set([JOB_STATUS.CANCELLED, JOB_STATUS.MISSED]);
export function scanNextCleanDay({ jobs = [], siteId = null, timeZone = null, nowMs = Date.now(), lastCleanedAt = null } = {}) {
  const zone = scanTimeZone(timeZone);
  const today = dayKey(nowMs, zone);
  const lastDay = addDaysKey(today, SCAN_NEXT_CLEAN_DAYS);
  const doneAt = typeof lastCleanedAt === 'string' ? Date.parse(lastCleanedAt) : NaN;
  let best = null;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || typeof j !== 'object') continue;
    if (siteId && j.siteId !== siteId) continue;
    if (isCompletedJobStatus(j.status) || NOT_A_COMING_CLEAN.has(j.status)) continue;
    const t = typeof j.startAt === 'string' ? Date.parse(j.startAt) : NaN;
    if (!Number.isFinite(t)) continue;
    if (Number.isFinite(doneAt) && t <= doneAt) continue;   // the visit that already did this area
    const day = dayKey(t, zone);
    if (day < today || day > lastDay) continue;
    if (!best || t < best.t || (t === best.t && String(j.id) < String(best.id))) best = { t, id: j.id, day };
  }
  return best ? best.day : null;
}

// ── QR-15 (his note): WHEN the building was last inspected, as a DATE ────────
// Matt: "Clients can scan it to see … When was the last inspection done." The newest submitted
// inspection of the location — never a draft (D8) — as its day in the org's zone; no score, no
// result, no inspector: he asked when. The server reads ONE row (api/_lib/scanCodes/store, by
// `site_id`, newest `performed_at` first, these statuses); the demo hands its rows to the same rule.
export const SCAN_INSPECTION_STATUSES = Object.freeze(['submitted', 'shared']);
export function scanLastInspectionDay(rows, timeZone = null) {
  let best = NaN;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !SCAN_INSPECTION_STATUSES.includes(r.status)) continue;
    const t = typeof r.performed_at === 'string' ? Date.parse(r.performed_at) : NaN;
    if (Number.isFinite(t) && !(t <= best)) best = t;
  }
  return Number.isFinite(best) ? dayKey(best, scanTimeZone(timeZone)) : null;
}

// ── QR-31: a phone number for urgent problems ───────────────────────────────
// Matt picked "a phone number for urgent problems" for the page's one line about the company: the
// company's own number from Settings → Company (`org_state.company.phone`), shown as written and
// dialled through the app's one click-to-dial (components/PhoneLink over lib/telHref: digits only,
// a leading + kept). A number with no digit to dial (blank, "TBD") is no line at all.
const PHONE_MAX = 40;
export function scanUrgentPhone(phone) {
  const s = typeof phone === 'string' ? phone.trim().slice(0, PHONE_MAX) : '';
  return s && telHref(s) ? s : null;
}

// ── the page's words for a day ──────────────────────────────────────────────
// A day key is a calendar date (no zone of its own), so it is formatted in UTC, where it is
// itself; "today" is the answer's own `checkedAt` in the org's zone. English (LANG-8).
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayKeyOrNull = (v) => {
  if (typeof v !== 'string' || !DAY_KEY_RE.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? v : null;
};
const dayOfKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const todayOf = (scan) => {
  const t = typeof scan?.checkedAt === 'string' ? Date.parse(scan.checkedAt) : NaN;
  return dayKey(Number.isFinite(t) ? t : Date.now(), scanTimeZone(scan?.timeZone));
};
// "Today" / "Tomorrow" / "Wednesday, Oct 22" — the answer's next clean, or null.
export function scanNextCleanText(scan) {
  const day = dayKeyOrNull(scan?.nextCleanOn);
  if (!day) return null;
  const today = todayOf(scan);
  if (day === today) return 'Today';
  if (day === addDaysKey(today, 1)) return 'Tomorrow';
  return dayOfKey(day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
// "Oct 14" (this year) / "Oct 14, 2025" — the answer's last inspection, or null.
export function scanLastInspectionText(scan) {
  const day = dayKeyOrNull(scan?.lastInspectionOn);
  if (!day) return null;
  const sameYear = day.slice(0, 4) === todayOf(scan).slice(0, 4);
  return dayOfKey(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

// ── the public answer ───────────────────────────────────────────────────────
// `nextCleanOn` / `lastInspectionOn` are day keys (`YYYY-MM-DD`) and nothing else — never a time —
// and `urgentPhone` the company's number as written (QR-28, QR-15, QR-31; each null when there is
// none). Every key is a check in test-area-scan.mjs, which feeds the server's secrets in.
export const PUBLIC_SCAN_KEYS = Object.freeze([
  'building', 'location', 'area', 'lastCleanedAt', 'timeZone', 'checkedAt', 'items', 'photo',
  'nextCleanOn', 'lastInspectionOn', 'urgentPhone',
]);
export const PUBLIC_SCAN_ITEM_KEYS = Object.freeze(['label', 'state']);
export const PUBLIC_SCAN_PHOTO_KEYS = Object.freeze(['takenAt']);
// What a listed item can say: done, or "did not apply this time". A not-done item is never
// listed — the page is "what was done", and an area only has a last-cleaned time when every
// item in it was done or N/A (lib/checklistAreas), so a not-done item here only means a
// photo could not be read for it, which must not read as undone work on a public wall.
export const PUBLIC_ITEM_STATE = Object.freeze({ DONE: 'done', NA: 'na' });

const ITEM_LABEL_MAX = 160;
const NAME_MAX = 120;
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const instant = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// A PHOTO SHOWS ONLY BESIDE A RECORDED CLEAN. The area status (lib/checklistAreas
// siteAreaStatus) keeps an area's newest checklist photo even when no clean of that area was
// ever finished — a cleaner photographed one item and left another undone — because on the
// office's card a photo is evidence of the place. On a public wall that same photo would sit
// under "Cleaning records start soon", which reads as a contradiction to anyone scanning. So the answer below and the photo route (api/_lib/scanCodes/store
// scanPhoto) ask this ONE question before they show or serve a picture (S113, 2026-10-04).
export function scanShowsPhoto(row) {
  return !!(row && typeof row === 'object' && instant(row.lastCleanedAt) && row.photo && typeof row.photo === 'object');
}

//   building          the customer's name (the building, as the hub names it)
//   location          the location's own name, when it says something the building does not
//   area              one `siteAreaStatus` row (lib/checklistAreas) — read, never spread
//   timeZone          the org's zone, as stored; replaced when unusable
//   nowMs             the server's clock (the demo's, in the demo)
//   nextCleanOn       scanNextCleanDay's answer; only a valid day key passes, never an instant
//   lastInspectionOn  scanLastInspectionDay's answer; the same
//   phone             the company's phone (org_state.company.phone); the hub's page passes none
export function projectAreaScan({
  building = null, location = null, area = null, timeZone = null, nowMs = Date.now(),
  nextCleanOn = null, lastInspectionOn = null, phone = null,
} = {}) {
  const row = area && typeof area === 'object' ? area : {};
  const b = text(building, NAME_MAX);
  const l = text(location, NAME_MAX);
  const lastCleanedAt = instant(row.lastCleanedAt);
  const items = [];
  if (lastCleanedAt) {
    for (const i of Array.isArray(row.items) ? row.items : []) {
      const state = i?.state === ITEM_STATE.DONE ? PUBLIC_ITEM_STATE.DONE
        : i?.state === ITEM_STATE.NA ? PUBLIC_ITEM_STATE.NA : null;
      if (state) items.push({ label: text(i.label, ITEM_LABEL_MAX) || 'Checklist item', state });
    }
  }
  const p = scanShowsPhoto(row) ? row.photo : null;
  const photoAt = p && (p.kind == null || p.kind === 'image') ? instant(p.createdAt) : null;
  return {
    building: b || l,
    location: b && l && l !== b ? l : null,
    area: text(row.label, NAME_MAX) || 'This area',
    lastCleanedAt,
    timeZone: scanTimeZone(timeZone),
    checkedAt: new Date(nowMs).toISOString(),
    items,
    photo: photoAt ? { takenAt: photoAt } : null,
    nextCleanOn: dayKeyOrNull(nextCleanOn),
    lastInspectionOn: dayKeyOrNull(lastInspectionOn),
    urgentPhone: scanUrgentPhone(phone),
  };
}

// ── the customer hub's page for ONE area (QR-16, QR Wave 2, 2026-10-17) ─────
// Matt: "That area's own page: when it was last cleaned, the photo, what was done, and a button to
// make a request about it." EXACTLY the public answer (projectAreaScan, built key by key — no
// cleaner, note, result or checklist name; the hub passes no phone, its own Call is on Home) plus
// where THIS home may fetch the photo: the hub's short-lived signed thumbnail of the winning photo,
// as the hub's checklist pages hand theirs (the public route serves bytes by token instead), and
// only beside a recorded clean (scanShowsPhoto). `row` is the area's siteAreaStatus row, signed.
export const HUB_AREA_KEYS = Object.freeze(['scan', 'photoUrl']);
export function projectHubArea({ building = null, location = null, area = null, timeZone = null, nowMs = Date.now(), nextCleanOn = null, lastInspectionOn = null } = {}) {
  const scan = projectAreaScan({ building, location, area, timeZone, nowMs, nextCleanOn, lastInspectionOn, phone: null });
  const p = scan.photo && area && typeof area === 'object' ? area.photo : null;
  const url = p ? (p.thumbUrl || p.url) : null;
  return { scan, photoUrl: typeof url === 'string' && url ? url : null };
}

// ── what the public route answers when it cannot ────────────────────────────
// One sentence and one stable code each (CS-077: never the provider's words). An unknown,
// replaced, malformed or orphaned code (its area or location removed) all answer the SAME
// "no longer active", so the answer says nothing about whether a token ever existed.
export const SCAN_INACTIVE_CODE = 'scan-code-inactive';
export const SCAN_INACTIVE_MESSAGE = 'This code is no longer active.';
export const SCAN_UNAVAILABLE_CODE = 'scan-unavailable';
export const SCAN_UNAVAILABLE_MESSAGE = 'This page could not load just now. Please try again in a minute.';
export const SCAN_RATE_LIMITED_CODE = 'rate-limited';
export const SCAN_PHOTO_NONE_CODE = 'scan-photo-none';

// The public route's allowance (api/_lib/rateLimit.js `allow`, CS-073): per visitor IP and
// per code, each a sliding minute. A page view is two requests (the answer and its photo),
// so a person reloading by hand never meets it; a script hammering one code or walking
// tokens from one address does. Per-instance and fail-open by that module's design.
export const SCAN_RATE = Object.freeze({
  perIp: Object.freeze({ limit: 60, windowMs: 60 * 1000 }),
  perToken: Object.freeze({ limit: 120, windowMs: 60 * 1000 }),
});
