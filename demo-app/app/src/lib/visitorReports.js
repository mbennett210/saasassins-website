// QR-22..QR-26 (Matt, 2026-10-16) — a VISITOR reports a problem from the public scan page.
//
// A visitor is anyone who scans an area's QR code without signing in (QR-22: "report a problem" is
// on, for anyone who scans, no login). What they may report (QR-23, all six): out of supplies,
// needs cleaning, something broken or damaged, something else in their own words, one photo if
// they want, and their name and a phone or email if they want a reply. What it opens (QR-24): out
// of supplies → a REQUEST (24 hours); needs cleaning or broken → a COMPLAINT (2 hours); something
// else → a request (our default — Matt's answer names the other three). Where it goes (QR-25):
// "like any other ticket" — the building's Account Manager first, the same deadlines and bells.
// Who sees it (QR-26): the office only.
//
// PURE / node-safe (explicit `.js` imports, no browser globals at load), so the public route
// (api/public/scan EP-414), its demo twin (lib/scanCodesApi) and the visitor's form
// (components/ScanVisitorReport) answer from this ONE module. Every word here is ENGLISH on
// purpose: a stranger reads it on a public page (LANG-8), like lib/areaScan's.
import { VISITOR_ORIGIN, DEFAULT_WO_PRIORITY } from './workOrders.js';

// ── the four choices (QR-23 a–d) and what each opens (QR-24) ────────────────────────────────
// `type` sets the deadline by lib/workOrders' one rule (TYPE_DEADLINE_HOURS: complaint 2 h,
// request 24 h); `category` is the reporting axis (WO-12, WO_CATEGORIES). `hint` is the text box's
// prompt for that choice; only "Something else" needs words.
export const VISITOR_CHOICES = Object.freeze({
  supplies: Object.freeze({
    label: 'Out of supplies', examples: 'Paper towels, toilet paper, soap',
    hint: 'What ran out? (optional)', type: 'request', category: 'restock', icon: 'box', textRequired: false,
  }),
  cleaning: Object.freeze({
    label: 'Needs cleaning', examples: 'A spill, a mess, a full trash can',
    hint: 'What needs cleaning? (optional)', type: 'complaint', category: 'spill', icon: 'droplet', textRequired: false,
  }),
  broken: Object.freeze({
    label: 'Something broken or damaged', examples: 'A fixture, a door, a light',
    hint: 'What is broken or damaged? (optional)', type: 'complaint', category: 'damage', icon: 'wrench', textRequired: false,
  }),
  other: Object.freeze({
    label: 'Something else', examples: 'Tell us in your own words',
    hint: 'Tell us what’s wrong', type: 'request', category: 'other', icon: 'messaging', textRequired: true,
  }),
});
export const VISITOR_CHOICE_KEYS = Object.freeze(['supplies', 'cleaning', 'broken', 'other']);
export const isVisitorChoice = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(VISITOR_CHOICES, v);

// ── what a report may carry ─────────────────────────────────────────────────────────────────
export const VISITOR_TEXT_MAX = 500;
export const VISITOR_TEXT_MIN = 3;          // "Something else" needs at least this many characters
export const VISITOR_NAME_MAX = 80;
export const VISITOR_CONTACT_MAX = 120;
export const VISITOR_TITLE_MAX = 120;
// The photo (QR-23 e): one, made on the phone (the form redraws it as a JPEG at most this many
// pixels on its long edge) and checked again by the server: JPEG, PNG or WebP by its BYTES, at
// most this many bytes decoded.
export const VISITOR_PHOTO_MAX_EDGE = 1600;
export const VISITOR_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const VISITOR_PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const VISITOR_PHOTO_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
// Base64 carries 3 bytes in 4 characters.
export const VISITOR_PHOTO_MAX_BASE64 = Math.ceil(VISITOR_PHOTO_MAX_BYTES / 3) * 4;
// The request body: the base64 photo and the few short fields, with room for the JSON around them.
// Inside the platform's 4.5 MB ceiling, so an oversized body is OUR sentence, never an opaque 413.
export const VISITOR_BODY_MAX_BYTES = 3 * 1024 * 1024;
// The page's own random id for this phone (kept in its storage; never a cookie). The server stores
// only its HMAC.
export const VISITOR_DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── the abuse limits (QR-25's note: "we limit how many reports one phone can send") ─────────
// DURABLE — counted in the database (public.visitor_reports) before anything is written, because
// the in-process limiter (api/_lib/rateLimit.js) resets on every serverless instance:
//   · one phone, one code: at most `perPhonePerCodeHour` reports in an hour;
//   · one phone: at most `perPhonePerDay` in 24 hours, whatever it scanned;
//   · one code: at most `perCodePerHour` visitor reports in an hour, from every phone together;
//   · the same phone, code and choice again inside `sameReportMinutes` → "we already have this
//     one", and no second ticket.
// The ledger keeps `ledgerRetentionDays` and the route deletes older rows at the write point.
export const VISITOR_LIMITS = Object.freeze({
  perPhonePerCodeHour: 3,
  perPhonePerDay: 10,
  perCodePerHour: 20,
  sameReportMinutes: 10,
  ledgerRetentionDays: 30,
});
// IN-PROCESS, before any of that (api/_lib/rateLimit `allow`): per visitor IP and per code, each a
// sliding minute, shared by the two visitor writes (report and rate). Generous for a person at a
// wall, tight for a loop; per instance and fail-open by that module's design.
export const VISITOR_POST_RATE = Object.freeze({
  perIp: Object.freeze({ limit: 20, windowMs: 60 * 1000 }),
  perToken: Object.freeze({ limit: 40, windowMs: 60 * 1000 }),
});

const HOUR = 3600 * 1000;
// The instants each durable count starts from, for a request at `nowMs`.
export function visitorLimitWindows(nowMs = Date.now()) {
  return {
    hourAgoIso: new Date(nowMs - HOUR).toISOString(),
    dayAgoIso: new Date(nowMs - 24 * HOUR).toISOString(),
    sameSinceIso: new Date(nowMs - VISITOR_LIMITS.sameReportMinutes * 60 * 1000).toISOString(),
    retentionCutoffIso: new Date(nowMs - VISITOR_LIMITS.ledgerRetentionDays * 24 * HOUR).toISOString(),
  };
}

// ── every answer: a sentence and a stable code (CS-077), never the visitor's own words ───────
export const VISITOR_REPORT_CODES = Object.freeze({
  choice: 'report-choice',
  textRequired: 'report-text-required',
  textLong: 'report-text-long',
  nameLong: 'report-name-long',
  contact: 'report-contact',
  device: 'report-device',
  id: 'report-id',
  photo: 'report-photo',
  photoLarge: 'report-photo-large',
  body: 'report-body',
  contentType: 'report-content-type',
  tooLarge: 'report-too-large',
  limitPhone: 'report-limit-phone',
  limitCode: 'report-limit-code',
  unavailable: 'report-unavailable',
});
const C = VISITOR_REPORT_CODES;
export const VISITOR_REPORT_MESSAGES = Object.freeze({
  [C.choice]: 'Choose what’s wrong.',
  [C.textRequired]: 'Tell us what’s wrong in a few words.',
  [C.textLong]: `Keep it under ${VISITOR_TEXT_MAX} characters.`,
  [C.nameLong]: `Keep your name under ${VISITOR_NAME_MAX} characters.`,
  [C.contact]: 'Enter a phone number or an email address, or leave it blank.',
  [C.device]: 'Please reload this page and try again.',
  [C.id]: 'Please reload this page and try again.',
  [C.photo]: 'Add a photo (JPG, PNG or WebP), or send without one.',
  [C.photoLarge]: 'That photo is too large. Try another, or send without one.',
  [C.body]: 'That could not be sent. Please try again.',
  [C.contentType]: 'That could not be sent. Please try again.',
  [C.tooLarge]: 'That is too large to send. Try a smaller photo, or send without one.',
  [C.limitPhone]: 'You’ve sent several reports from this phone. Thank you — the team has them.',
  [C.limitCode]: 'This area has had a lot of reports in the last hour. The team has been told.',
  [C.unavailable]: 'Reporting isn’t available just now. Please try again in a minute.',
});
// The status each refusal answers with.
export const VISITOR_REPORT_STATUS = Object.freeze({
  [C.contentType]: 415,
  [C.tooLarge]: 413,
  [C.id]: 400,
  [C.limitPhone]: 429,
  [C.limitCode]: 429,
  [C.unavailable]: 503,
});
export const visitorReportStatus = (code) => VISITOR_REPORT_STATUS[code] || 400;
export const VISITOR_REPORT_THANKS = 'Thanks. We’ve let the team know.';
export const VISITOR_REPORT_ALREADY = 'Thanks — we already have this one.';

const refuse = (code) => ({ refused: VISITOR_REPORT_MESSAGES[code], code });

// ── text, cleaned ───────────────────────────────────────────────────────────────────────────
// Control characters out (a newline and a tab stay in the visitor's own words); a name or a contact
// is one line. Nothing is ever rewritten beyond that: a visitor's words are theirs (LANG-7).
// (By code point rather than a regex of control characters, which the linter rightly distrusts.)
const keepChar = (ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || (c >= 32 && c !== 127); };
const stripControls = (s) => Array.from(s).filter(keepChar).join('');
const words = (v) => (typeof v === 'string' ? stripControls(v.replace(/\r\n?/g, '\n')).trim() : '');
const oneLine = (v) => words(v).replace(/\s+/g, ' ');

// ── the reply contact: a plausible phone or email ───────────────────────────────────────────
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"'`]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
const PHONE_RE = /^\+?[\d\s().-]{7,25}$/;
// 'email' | 'phone' | null
export function visitorContactKind(contact) {
  const s = oneLine(contact);
  if (!s || s.length > VISITOR_CONTACT_MAX) return null;
  if (s.includes('@')) return EMAIL_RE.test(s) ? 'email' : null;
  if (!PHONE_RE.test(s) || (s.match(/\+/g) || []).length > 1) return null;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? 'phone' : null;
}
// The office's link to reply (the drawer): `tel:` with digits and a leading + only, `mailto:` with
// the address as validated — never the text as typed.
export function visitorContactHref(contact) {
  const kind = visitorContactKind(contact);
  const s = oneLine(contact);
  if (kind === 'email') return `mailto:${s}`;
  if (kind === 'phone') return `tel:${s.trim().startsWith('+') ? '+' : ''}${s.replace(/\D/g, '')}`;
  return null;
}

// ── the photo ───────────────────────────────────────────────────────────────────────────────
// What its first bytes say it is — 'image/jpeg' | 'image/png' | 'image/webp' | null. Any byte array
// (a Node Buffer, a Uint8Array): the declared type is the sender's word, the bytes are the truth.
export function sniffVisitorPhoto(b) {
  if (!b || typeof b.length !== 'number' || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
// The photo field's SHAPE (a data URL of one of the three types, within the size): → { value: null }
// for none, { value: { mimeType, base64 } }, or a refusal. The route then decodes it and holds the
// bytes to `sniffVisitorPhoto` and VISITOR_PHOTO_MAX_BYTES (visitorPhotoBytesRefusal).
const PHOTO_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
export function visitorPhotoInput(v) {
  if (v === undefined || v === null || v === '') return { value: null };
  if (typeof v !== 'string') return refuse(C.photo);
  const head = v.slice(0, 40);
  if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(head)) return refuse(C.photo);
  if (v.length - v.indexOf(',') - 1 > VISITOR_PHOTO_MAX_BASE64) return refuse(C.photoLarge);
  const m = PHOTO_DATA_URL_RE.exec(v);
  if (!m) return refuse(C.photo);
  return { value: { mimeType: m[1], base64: m[2] } };
}
// The decoded bytes, judged: null when they are a photo of the declared type within the size.
export function visitorPhotoBytesRefusal(bytes, mimeType) {
  if (!bytes || !bytes.length) return refuse(C.photo);
  if (bytes.length > VISITOR_PHOTO_MAX_BYTES) return refuse(C.photoLarge);
  const sniffed = sniffVisitorPhoto(bytes);
  if (!sniffed || sniffed !== mimeType) return refuse(C.photo);
  return null;
}

// ── the honeypot ────────────────────────────────────────────────────────────────────────────
// A field no person sees or fills (the form keeps it off-screen, out of the tab order). Filled =
// a script: the route answers the same thanks and writes nothing, so it learns nothing.
export function visitorHoneypotFilled(body) {
  const v = body && typeof body === 'object' ? body.hp : undefined;
  if (v === undefined || v === null || v === false) return false;
  return typeof v === 'string' ? v.trim() !== '' : true;
}

// ── ONE validation, before anything is read or written ──────────────────────────────────────
// Only the named fields are read: a body carrying an origin, a type, a priority or a building
// changes nothing — the server takes the location and area from the CODE.
//   { token, category, text?, name?, contact?, photo?, deviceId, id?, hp }
// → { value: { choice, text, name, contact, photo, deviceId, id } } | { refused, code }
export function visitorReportInput(body = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return refuse(C.body);
  if (b.id !== undefined && b.id !== null && !(typeof b.id === 'string' && UUID_RE.test(b.id))) return refuse(C.id);
  if (!(typeof b.deviceId === 'string' && VISITOR_DEVICE_ID_RE.test(b.deviceId))) return refuse(C.device);
  if (!isVisitorChoice(b.category)) return refuse(C.choice);
  const choice = b.category;
  if (b.text !== undefined && b.text !== null && typeof b.text !== 'string') return refuse(C.body);
  const text = words(b.text);
  if (text.length > VISITOR_TEXT_MAX) return refuse(C.textLong);
  if (VISITOR_CHOICES[choice].textRequired && text.length < VISITOR_TEXT_MIN) return refuse(C.textRequired);
  if (b.name !== undefined && b.name !== null && typeof b.name !== 'string') return refuse(C.body);
  const name = oneLine(b.name);
  if (name.length > VISITOR_NAME_MAX) return refuse(C.nameLong);
  if (b.contact !== undefined && b.contact !== null && typeof b.contact !== 'string') return refuse(C.contact);
  const contact = oneLine(b.contact);
  if (contact && (contact.length > VISITOR_CONTACT_MAX || !visitorContactKind(contact))) return refuse(C.contact);
  const photo = visitorPhotoInput(b.photo);
  if (photo.refused) return photo;
  return {
    value: {
      choice,
      text: text || null,
      name: name || null,
      contact: contact || null,
      photo: photo.value,
      deviceId: b.deviceId,
      id: typeof b.id === 'string' ? b.id.toLowerCase() : null,
    },
  };
}

// ── what the durable counts decide ──────────────────────────────────────────────────────────
// `counts`: { sameRecent, phoneCodeHour, phoneDay, codeHour } from the ledger. The same report again
// is answered as received (no second ticket) before any limit, so a phone at its limit that sends
// the same thing twice still hears "we already have this one".
// → { ok: true } | { duplicate: true } | { refused, code }
export function visitorLimitVerdict(counts = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (n(counts.sameRecent) > 0) return { duplicate: true };
  if (n(counts.phoneCodeHour) >= VISITOR_LIMITS.perPhonePerCodeHour) return refuse(C.limitPhone);
  if (n(counts.phoneDay) >= VISITOR_LIMITS.perPhonePerDay) return refuse(C.limitPhone);
  if (n(counts.codeHour) >= VISITOR_LIMITS.perCodePerHour) return refuse(C.limitCode);
  return { ok: true };
}

// ── the ticket a report opens (QR-24, QR-25) ────────────────────────────────────────────────
// Titled by the area and the choice ("Lobby: Out of supplies"), the visitor's words as its details,
// the type and category the choice names, the ordinary urgency (WO-18: the deadline is the TYPE's,
// WO-20), origin `visitor`. The location, the customer and the area are the CODE's, set by the
// route — never anything the visitor sent.
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
export function visitorTicketInput({ choice, text = null, areaLabel = null } = {}) {
  const c = VISITOR_CHOICES[choice];
  if (!c) return null;
  const area = typeof areaLabel === 'string' ? areaLabel.trim() : '';
  return {
    title: clip(area ? `${area}: ${c.label}` : c.label, VISITOR_TITLE_MAX),
    description: typeof text === 'string' && text.trim() ? text.trim() : null,
    type: c.type,
    category: c.category,
    priority: DEFAULT_WO_PRIORITY,
    origin: VISITOR_ORIGIN,
  };
}
