// QR-22..QR-26 and QR-30 (Matt, 2026-10-16) — the PURE rules of a visitor's report and rating,
// held to their sources of truth (lib/workOrders' deadlines and categories, the org's zone),
// never to restated literals:
//   W. the work-order vocabulary: origin `visitor`, QR-26's one question, the reporter fields
//      taken off a cleaner's row, a ticket's area checked against its location, `damage`;
//   V. QR-26 — a visitor's report is not the customer's ticket volume (ticketCountsByClient);
//   T. QR-24 — what each of the four choices opens, by lib/workOrders' own deadline rule;
//   I. every refusal of the report's input, the contact, the honeypot;
//   P. the photo: the data URL's shape, the bytes' type and size;
//   L. the durable limits' verdict and windows; the ticket a report opens;
//   R. a rating: input, limits, the org's day, the phone's memory, the office's by-building report.
//
// REGRESSION (THE LAW II.3): on the tree before the visitor reports (90d7ca9e) neither module
// exists and workOrders has no visitor origin, so nearly every check below reports what it wanted.
//
//   node app/scripts/test-visitor-reports.mjs
import { isDeepStrictEqual } from 'node:util';

const wo = await import('../src/lib/workOrders.js').catch(() => ({}));
const vr = await import('../src/lib/visitorReports.js').catch(() => ({}));
const ar = await import('../src/lib/areaRatings.js').catch(() => ({}));
const dates = await import('../src/lib/dates.js');

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
// STRICT: a missing expected value (a source constant that does not exist yet) never passes, and
// undefined is not null — so no check below can pass on a tree without the rules it holds.
const eq = (label, got, want) => ok(label, want !== undefined && isDeepStrictEqual(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const every = (list, pred) => Array.isArray(list) && list.length > 0 && list.every(pred);
const call = (fn, ...args) => { try { return typeof fn === 'function' ? fn(...args) : undefined; } catch (e) { return { threw: e.message }; } };

// ── W. the work-order vocabulary ────────────────────────────────────────────
{
  ok('W1 origin visitor is one of the ticket origins', (wo.WO_ORIGINS || []).includes('visitor'));
  eq('W1 …named once', wo.VISITOR_ORIGIN, 'visitor');
  eq('W1 …and the office reads it as "Reported by a visitor"', wo.WO_ORIGIN_META?.visitor?.label, 'Reported by a visitor');
  eq('W1 …the view-model keeps it (no fold to internal)', call(wo.toWorkOrder, { origin: 'visitor' })?.origin, 'visitor');
  ok('W2 QR-26\'s question: a visitor ticket is one', call(wo.isVisitorReport, { origin: 'visitor' }) === true);
  ok('W2 …a customer\'s is not', call(wo.isVisitorReport, { origin: 'portal' }) === false);
  ok('W2 …nor the office\'s, nor nothing', call(wo.isVisitorReport, { origin: 'internal' }) === false && call(wo.isVisitorReport, null) === false);
  const row = { id: 'p1', title: 'Lobby: Out of supplies', reporter_name: 'Ana', reporter_contact: 'ana@example.test', origin: 'visitor' };
  const crew = call(wo.withoutVisitorReporter, row) || {};
  ok('W3 a cleaner\'s row has no reporter name or contact', crew.id === 'p1' && !('reporter_name' in crew) && !('reporter_contact' in crew), JSON.stringify(crew));
  eq('W3 …and keeps everything else', [crew.id, crew.title, crew.origin], ['p1', 'Lobby: Out of supplies', 'visitor']);
  eq('W3 …the fields named once', wo.VISITOR_REPORTER_FIELDS, ['reporter_name', 'reporter_contact']);
  ok('W3 …and the office\'s row is left as it was', row.reporter_name === 'Ana');
  const site = { id: 'st_1', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: ' area_rest ', label: 'Restrooms' }] };
  eq('W4 a ticket\'s area: none is fine', call(wo.ticketAreaInput, undefined, site), { value: null });
  eq('W4 …one of the location\'s areas is kept', call(wo.ticketAreaInput, 'area_lobby', site), { value: 'area_lobby' });
  eq('W4 …trimmed, as the area list is read', call(wo.ticketAreaInput, 'area_rest', site), { value: 'area_rest' });
  eq('W4 …another location\'s area is refused', call(wo.ticketAreaInput, 'area_pool', site), { refused: wo.AREA_CODES?.unknown });
  eq('W4 …and so is a non-string', call(wo.ticketAreaInput, { id: 'area_lobby' }, site), { refused: wo.AREA_CODES?.unknown });
  ok('W4 …with a sentence', typeof wo.AREA_MESSAGES?.[wo.AREA_CODES?.unknown] === 'string');
  eq('W5 the area\'s name for a ticket, from the live location', call(wo.ticketAreaLabel, { site_area_id: 'area_lobby' }, site), 'Lobby');
  eq('W5 …an area since removed names nothing', call(wo.ticketAreaLabel, { site_area_id: 'area_gone' }, site), null);
  ok('W6 QR-23 (c) files under its own category: damage', (wo.WO_CATEGORIES || []).includes('damage') && wo.normalizeCategory?.('damage') === 'damage');
  eq('W6 …"Other" stays last', (wo.WO_CATEGORIES || []).slice(-1)[0], 'other');
  ok('W6 …with a label and a hint like the rest', !!wo.WO_CATEGORY_META?.damage?.label && !!wo.WO_CATEGORY_META?.damage?.hint);
}

// ── V. QR-26: not the customer's ticket volume ──────────────────────────────
{
  const now = Date.parse('2026-10-17T15:00:00Z');
  const at = (h) => new Date(now - h * 3600e3).toISOString();
  const rows = [
    { id: 'a', client_id: 'cl_1', created_at: at(1), origin: 'portal' },
    { id: 'b', client_id: 'cl_1', created_at: at(2), origin: 'internal' },
    { id: 'c', client_id: 'cl_1', created_at: at(3), origin: 'visitor' },
    { id: 'd', client_id: 'cl_1', created_at: at(4), origin: 'visitor' },
    { id: 'e', client_id: 'cl_2', created_at: at(5), origin: 'visitor' },
  ];
  const counts = call(wo.ticketCountsByClient, rows, { now }) || new Map();
  eq('V1 a customer\'s volume counts their own and the office\'s tickets, never a visitor\'s', counts.get?.('cl_1'), 2);
  ok('V1 …a customer with only visitor reports has none', !counts.has?.('cl_2'));
  // The flag reads the same tally: ten visitor reports never flag a customer.
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, client_id: 'cl_3', created_at: at(i + 1), origin: 'visitor' }));
  ok('V2 ten visitor reports never raise the "complaining too much" flag', !call(wo.isTicketFlagged, (call(wo.ticketCountsByClient, ten, { now }) || new Map()).get?.('cl_3') || 0, {}));
}

// ── T. QR-24: what each choice opens ────────────────────────────────────────
{
  const C = vr.VISITOR_CHOICES || {};
  eq('T1 the four choices, in Matt\'s order', vr.VISITOR_CHOICE_KEYS, ['supplies', 'cleaning', 'broken', 'other']);
  const hours = (k) => wo.deadlineHours?.({ type: C[k]?.type });
  eq('T2 out of supplies opens a request: 24 hours (TYPE_DEADLINE_HOURS.request)', [C.supplies?.type, hours('supplies')], ['request', wo.TYPE_DEADLINE_HOURS?.request]);
  eq('T2 needs cleaning opens a complaint: 2 hours', [C.cleaning?.type, hours('cleaning')], ['complaint', wo.TYPE_DEADLINE_HOURS?.complaint]);
  eq('T2 broken opens a complaint: 2 hours', [C.broken?.type, hours('broken')], ['complaint', wo.TYPE_DEADLINE_HOURS?.complaint]);
  eq('T2 something else opens a request (our default): 24 hours', [C.other?.type, hours('other')], ['request', wo.TYPE_DEADLINE_HOURS?.request]);
  eq('T3 categories: restock · spill · damage · other', vr.VISITOR_CHOICE_KEYS?.map((k) => C[k]?.category), ['restock', 'spill', 'damage', 'other']);
  ok('T3 …each one the work orders know', every(vr.VISITOR_CHOICE_KEYS, (k) => !!C[k]?.category && wo.normalizeCategory?.(C[k].category) === C[k].category));
  ok('T3 …and each a type a person may raise', every(vr.VISITOR_CHOICE_KEYS, (k) => (wo.RAISABLE_WO_TYPES || []).includes(C[k]?.type)));
  ok('T4 only "Something else" needs words', every(vr.VISITOR_CHOICE_KEYS, (k) => !!C[k] && !!C[k].textRequired === (k === 'other')));
  ok('T4 every choice has a label, examples and a hint for its text box', every(vr.VISITOR_CHOICE_KEYS, (k) => C[k]?.label && C[k]?.examples && C[k]?.hint));
}

// ── I. the report's input ───────────────────────────────────────────────────
const DEVICE = 'dev_abcdefghijklmnop0123';
const base = { category: 'supplies', deviceId: DEVICE };
const inp = (patch) => call(vr.visitorReportInput, { ...base, ...patch });
const code = (patch) => inp(patch)?.code ?? null;
const RC = vr.VISITOR_REPORT_CODES || {};
{
  const v = inp({ text: '  Out of soap in the men’s room  ', name: '  Ana   Ruiz ', contact: ' (305) 555-0142 ' })?.value || {};
  eq('I1 a whole report reads back cleaned', [v.choice, v.text, v.name, v.contact], ['supplies', 'Out of soap in the men’s room', 'Ana Ruiz', '(305) 555-0142']);
  eq('I1 …the phone\'s id kept for its HMAC', v.deviceId, DEVICE);
  eq('I1 …nothing optional is required', inp({})?.value ? [inp({}).value.text, inp({}).value.name, inp({}).value.contact, inp({}).value.photo] : 'refused', [null, null, null, null]);
  eq('I2 no choice is refused', code({ category: undefined }), RC.choice);
  eq('I2 …nor one of the office\'s own words', code({ category: 'restock' }), RC.choice);
  eq('I3 "Something else" needs words', code({ category: 'other', text: '' }), RC.textRequired);
  eq('I3 …at least three characters of them', code({ category: 'other', text: ' ab ' }), RC.textRequired);
  ok('I3 …three is enough', !!inp({ category: 'other', text: 'abc' })?.value);
  eq(`I4 text over ${vr.VISITOR_TEXT_MAX} characters is refused`, code({ text: 'x'.repeat((vr.VISITOR_TEXT_MAX || 0) + 1) }), RC.textLong);
  ok('I4 …exactly the limit is fine', !!inp({ text: 'x'.repeat(vr.VISITOR_TEXT_MAX || 0) })?.value);
  eq(`I5 a name over ${vr.VISITOR_NAME_MAX} is refused`, code({ name: 'n'.repeat((vr.VISITOR_NAME_MAX || 0) + 1) }), RC.nameLong);
  eq('I6 a contact that is neither a phone nor an email is refused', code({ contact: 'call me maybe' }), RC.contact);
  eq('I6 …too few digits', code({ contact: '555-01' }), RC.contact);
  eq('I6 …two plus signs', code({ contact: '+1 +305 555 0142' }), RC.contact);
  eq('I6 …an address with no domain', code({ contact: 'ana@' }), RC.contact);
  eq(`I6 …over ${vr.VISITOR_CONTACT_MAX} characters`, code({ contact: `${'a'.repeat(vr.VISITOR_CONTACT_MAX || 0)}@example.test` }), RC.contact);
  eq('I6 …a phone reads as one', call(vr.visitorContactKind, '+1 (305) 555-0142'), 'phone');
  eq('I6 …an email as one', call(vr.visitorContactKind, 'ana.ruiz@example.test'), 'email');
  eq('I7 the office\'s reply link for a phone: digits and a leading + only', call(vr.visitorContactHref, '+1 (305) 555-0142'), 'tel:+13055550142');
  eq('I7 …for an email: the address as checked', call(vr.visitorContactHref, 'ana@example.test'), 'mailto:ana@example.test');
  eq('I7 …nothing for anything else', call(vr.visitorContactHref, 'javascript:alert(1)'), null);
  eq('I8 no phone id is refused', code({ deviceId: undefined }), RC.device);
  eq('I8 …nor a malformed one', code({ deviceId: 'short' }), RC.device);
  eq('I8 …nor one carrying a path', code({ deviceId: '../../etc/passwd/xxxxxxxx' }), RC.device);
  eq('I9 a caller-minted id must be a uuid', code({ id: 'pr_123' }), RC.id);
  eq('I9 …a uuid is kept, lower-cased', inp({ id: 'ABCDEF01-2345-4678-9ABC-DEF012345678' })?.value?.id, 'abcdef01-2345-4678-9abc-def012345678');
  eq('I10 a body that is not an object is refused', call(vr.visitorReportInput, 'category=supplies')?.code, RC.body);
  eq('I10 …nor an array', call(vr.visitorReportInput, [base])?.code, RC.body);
  eq('I10 …a text that is not words', code({ text: { $ne: 1 } }), RC.body);
  const ctl = inp({ text: 'a\u0000b\u0007c', name: 'A\tB\nC' })?.value || {};
  eq('I11 control characters never reach the ticket', [ctl.text, ctl.name], ['abc', 'A B C']);
  ok('I12 the honeypot: filled is a script', call(vr.visitorHoneypotFilled, { hp: 'http://spam.example' }) === true);
  ok('I12 …empty is a person', call(vr.visitorHoneypotFilled, { hp: '' }) === false && call(vr.visitorHoneypotFilled, {}) === false);
  ok('I12 …whitespace is a person', call(vr.visitorHoneypotFilled, { hp: '   ' }) === false);
  ok('I13 every refusal is a sentence', every(Object.values(RC), (c) => typeof vr.VISITOR_REPORT_MESSAGES?.[c] === 'string' && vr.VISITOR_REPORT_MESSAGES[c].length > 5));
  ok('I13 …that never repeats what was sent', every(Object.values(vr.VISITOR_REPORT_MESSAGES || {}), (m) => !/\{|undefined|null/.test(m)));
  eq('I14 statuses: limits 429, the body 413 / 415, unavailable 503, the rest 400',
    ['limitPhone', 'limitCode', 'tooLarge', 'contentType', 'unavailable', 'choice'].map((k) => vr.visitorReportStatus?.(RC[k])), [429, 429, 413, 415, 503, 400]);
}

// ── P. the photo ────────────────────────────────────────────────────────────
{
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49]);
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56]);
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 0]);
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  eq('P1 JPEG, PNG and WebP by their bytes', [jpeg, png, webp].map((b) => call(vr.sniffVisitorPhoto, b)), ['image/jpeg', 'image/png', 'image/webp']);
  eq('P1 …a GIF or a page is no photo', [gif, html].map((b) => call(vr.sniffVisitorPhoto, b)), [null, null]);
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const url = (type, u8) => `data:${type};base64,${b64(u8)}`;
  const pv = call(vr.visitorPhotoInput, url('image/jpeg', jpeg))?.value;
  eq('P2 a data URL\'s shape is read: the type and the base64', [pv?.mimeType, pv?.base64], ['image/jpeg', b64(jpeg)]);
  eq('P2 …no photo is fine', call(vr.visitorPhotoInput, undefined), { value: null });
  eq('P3 another type is refused before decoding', call(vr.visitorPhotoInput, url('image/gif', gif))?.code, RC.photo);
  eq('P3 …an SVG too', call(vr.visitorPhotoInput, 'data:image/svg+xml;base64,PHN2Zz4=')?.code, RC.photo);
  eq('P3 …so is a link', call(vr.visitorPhotoInput, 'https://example.test/x.jpg')?.code, RC.photo);
  eq('P3 …or a stray character in the base64', call(vr.visitorPhotoInput, 'data:image/jpeg;base64,/9j/4AAQ"><script>')?.code, RC.photo);
  const tooLong = `data:image/jpeg;base64,${'A'.repeat((vr.VISITOR_PHOTO_MAX_BASE64 || 0) + 4)}`;
  eq('P4 a photo longer than the limit is refused by its LENGTH, unread', call(vr.visitorPhotoInput, tooLong)?.code, RC.photoLarge);
  eq('P5 the bytes must be the declared type', call(vr.visitorPhotoBytesRefusal, png, 'image/jpeg')?.code, RC.photo);
  eq('P5 …a page named a JPEG is refused', call(vr.visitorPhotoBytesRefusal, html, 'image/jpeg')?.code, RC.photo);
  eq('P5 …a real JPEG passes', call(vr.visitorPhotoBytesRefusal, jpeg, 'image/jpeg'), null);
  const big = new Uint8Array((vr.VISITOR_PHOTO_MAX_BYTES || 0) + 16);
  big.set(jpeg);
  eq(`P6 more than ${vr.VISITOR_PHOTO_MAX_BYTES} bytes decoded is refused`, call(vr.visitorPhotoBytesRefusal, big, 'image/jpeg')?.code, RC.photoLarge);
  eq('P6 …the limit is 2 MB', vr.VISITOR_PHOTO_MAX_BYTES, 2 * 1024 * 1024);
  ok('P7 the body cap leaves room for the photo, inside the platform\'s 4.5 MB',
    (vr.VISITOR_BODY_MAX_BYTES || 0) > (vr.VISITOR_PHOTO_MAX_BASE64 || Infinity) && (vr.VISITOR_BODY_MAX_BYTES || Infinity) < 4.5 * 1024 * 1024);
}

// ── L. the limits, the ticket ───────────────────────────────────────────────
{
  const L = vr.VISITOR_LIMITS || {};
  eq('L1 the limits Matt was told of: 3 a code an hour, 10 a day per phone, 20 a code an hour, 10 minutes',
    [L.perPhonePerCodeHour, L.perPhonePerDay, L.perCodePerHour, L.sameReportMinutes], [3, 10, 20, 10]);
  const verdict = (c) => call(vr.visitorLimitVerdict, c) || {};
  ok('L2 under every limit: go', verdict({ phoneCodeHour: (L.perPhonePerCodeHour || 0) - 1, phoneDay: (L.perPhonePerDay || 0) - 1, codeHour: (L.perCodePerHour || 0) - 1 }).ok === true);
  eq('L2 the phone at its limit on this code', verdict({ phoneCodeHour: L.perPhonePerCodeHour }).code, RC.limitPhone);
  eq('L2 the phone at its day\'s limit', verdict({ phoneDay: L.perPhonePerDay }).code, RC.limitPhone);
  eq('L2 the code at its hour\'s limit', verdict({ codeHour: L.perCodePerHour }).code, RC.limitCode);
  ok('L3 the same report again is "already have it", before any limit', verdict({ sameRecent: 1, phoneCodeHour: 99, codeHour: 99 }).duplicate === true);
  const now = Date.parse('2026-10-17T15:00:00Z');
  const w = call(vr.visitorLimitWindows, now) || {};
  eq('L4 the windows: an hour, a day, the dedupe minutes, the ledger\'s retention',
    [w.hourAgoIso, w.dayAgoIso, w.sameSinceIso, w.retentionCutoffIso],
    [new Date(now - 3600e3).toISOString(), new Date(now - 86400e3).toISOString(), new Date(now - (L.sameReportMinutes || 0) * 60e3).toISOString(), new Date(now - (L.ledgerRetentionDays || 0) * 86400e3).toISOString()]);
  const t = call(vr.visitorTicketInput, { choice: 'supplies', text: 'No soap', areaLabel: 'Lobby' }) || {};
  eq('L5 the ticket: "Lobby: Out of supplies"', t.title, `Lobby: ${vr.VISITOR_CHOICES?.supplies?.label}`);
  eq('L5 …the visitor\'s words as its details', t.description, 'No soap');
  eq('L5 …the choice\'s type and category, origin visitor, the ordinary urgency',
    [t.type, t.category, t.origin, t.priority], ['request', 'restock', wo.VISITOR_ORIGIN, wo.DEFAULT_WO_PRIORITY]);
  eq('L5 …no words: no details', call(vr.visitorTicketInput, { choice: 'cleaning', areaLabel: 'Restrooms' })?.description, null);
  { const cut = call(vr.visitorTicketInput, { choice: 'broken', areaLabel: 'A'.repeat(300) })?.title || ''; ok('L5 …a long area name is cut to fit', cut.length > 0 && cut.length <= (vr.VISITOR_TITLE_MAX || 0) && cut.endsWith('…'), cut.slice(-20)); }
  eq('L5 …an unknown choice opens nothing', call(vr.visitorTicketInput, { choice: 'restock' }), null);
}

// ── R. a rating ─────────────────────────────────────────────────────────────
{
  const RCo = ar.AREA_RATING_CODES || {};
  eq('R1 thumbs up is +1, down is -1', ar.AREA_RATING_VALUES, { up: 1, down: -1 });
  eq('R1 a vote reads back', call(ar.areaRatingInput, { value: 'down', deviceId: DEVICE })?.value, { vote: 'down', value: -1, deviceId: DEVICE });
  eq('R1 …anything else is refused', call(ar.areaRatingInput, { value: 1, deviceId: DEVICE })?.code, RCo.value);
  eq('R1 …and the phone id is checked', call(ar.areaRatingInput, { value: 'up', deviceId: 'x' })?.code, RCo.device);
  const RL = ar.AREA_RATING_LIMITS || {};
  ok('R2 under its limits: go', call(ar.areaRatingLimitVerdict, { codeHour: (RL.perCodePerHour || 0) - 1, phoneDay: (RL.perPhonePerDay || 0) - 1 })?.ok === true);
  eq('R2 a phone at its day\'s limit', call(ar.areaRatingLimitVerdict, { phoneDay: RL.perPhonePerDay })?.code, RCo.limitPhone);
  eq('R2 a code at its hour\'s limit', call(ar.areaRatingLimitVerdict, { codeHour: RL.perCodePerHour })?.code, RCo.limitCode);
  // 02:30 UTC on Oct 17 is still Oct 16 in New York: the vote is that org day's.
  const late = Date.parse('2026-10-17T02:30:00Z');
  eq('R3 a vote belongs to the ORG\'s day (New York), not UTC\'s', call(ar.ratingDay, late, 'America/New_York'), dates.dayKey(new Date(late), 'America/New_York'));
  eq('R3 …which is the day before UTC\'s here', call(ar.ratingDay, late, 'America/New_York'), '2026-10-16');
  eq('R3 …a zone this runtime cannot use falls back to the org default, never throws', typeof call(ar.ratingDay, late, 'Not/AZone'), 'string');
  let mem = {};
  mem = call(ar.rememberVote, mem, 'TOK1', '2026-10-17', 'up') || {};
  eq('R4 the phone remembers today\'s vote', call(ar.rememberedVote, mem, 'TOK1', '2026-10-17'), 'up');
  eq('R4 …not tomorrow', call(ar.rememberedVote, mem, 'TOK1', '2026-10-18'), null);
  mem = call(ar.rememberVote, mem, 'TOK1', '2026-10-17', 'down') || {};
  eq('R4 …and the change', call(ar.rememberedVote, mem, 'TOK1', '2026-10-17'), 'down');
  let many = {};
  for (let i = 0; i < 80; i += 1) many = call(ar.rememberVote, many, `T${i}`, '2026-10-17', 'up') || many;
  ok(`R5 at most ${ar.RATING_MEMORY_MAX} remembered (retention at the write point)`, Object.keys(many).length === ar.RATING_MEMORY_MAX);
  const next = call(ar.rememberVote, many, 'NEW', '2026-10-18', 'up') || {};
  eq('R5 …and yesterday\'s go on the next day\'s first write', Object.keys(next), ['NEW']);
  eq('R6 the periods: 7 / 30 / 90, 30 by default', [ar.RATING_PERIODS, ar.DEFAULT_RATING_PERIOD], [[7, 30, 90], 30]);
  eq('R6 …a period not offered is refused', [call(ar.ratingPeriodDays, '45'), call(ar.ratingPeriodDays, undefined), call(ar.ratingPeriodDays, '7')], [null, 30, 7]);
  eq('R6 …30 days are today and the 29 before, in the org\'s days',
    call(ar.ratingPeriodWindow, { days: 30, nowMs: late, timeZone: 'America/New_York' }), { fromDay: '2026-09-17', toDay: '2026-10-16' });

  const sites = [
    { id: 'st_cb', clientId: 'cl_cb', name: 'Clubhouse', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }] },
    { id: 'st_cb2', clientId: 'cl_cb', name: 'Pool house', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }] },
    { id: 'st_fl', clientId: 'cl_fl', name: 'Flagler', cleaningAreas: [{ id: 'area_gym', label: 'Gym' }] },
  ];
  const clients = [{ id: 'cl_cb', name: 'Coral Bay HOA' }, { id: 'cl_fl', name: 'Flagler Tower', statusOverride: 'archived' }];
  const v = (site, area, value, client = null) => ({ site_id: site, area_id: area, value, client_id: client });
  const rows = [
    v('st_cb', 'area_lobby', 1), v('st_cb', 'area_lobby', 1), v('st_cb', 'area_lobby', -1),
    v('st_cb', 'area_rest', -1), v('st_cb', 'area_rest', -1),
    v('st_cb2', 'area_lobby', 1),
    v('st_fl', 'area_gym', 1), v('st_fl', 'area_gym', 1),
    v('st_gone', 'area_x', -1, 'cl_cb'),
    v('st_cb', 'area_gone', 1),
    { site_id: 'st_cb', area_id: 'area_lobby', value: 0 },
  ];
  const rep = call(ar.visitorRatingsReport, rows, { sites, clients }) || { buildings: [], totals: {} };
  eq('R7 one row per BUILDING (the customer), worst first', rep.buildings.map((b) => b.name), ['Coral Bay HOA', 'Flagler Tower']);
  const cb = rep.buildings[0] || {};
  eq('R7 …its thumbs: a vote that is neither is no vote', [cb.up, cb.down, cb.total], [4, 4, 8]);
  eq('R7 …% positive, whole', cb.pctPositive, Math.round((4 / 8) * 100));
  eq('R8 its areas, worst first', (cb.areas || []).map((a) => a.label), ['Restrooms', 'Removed area', 'Lobby', 'Lobby', 'Removed area']);
  eq('R8 …the restrooms: 0 up, 2 down', [(cb.areas || [])[0]?.up, (cb.areas || [])[0]?.down, (cb.areas || [])[0]?.pctPositive], [0, 2, 0]);
  ok('R8 …a building with two locations names each area\'s location', (cb.areas || []).some((a) => a.location === 'Pool house') && (cb.areas || []).some((a) => a.location === 'Clubhouse'));
  ok('R8 …a location since removed keeps its votes under its old customer', (cb.areas || []).some((a) => a.siteId === 'st_gone' && a.label === 'Removed area' && a.down === 1));
  const fl = rep.buildings[1] || {};
  eq('R9 an archived customer stays in its own history, marked', [fl.archived, fl.up, fl.pctPositive], [true, 2, 100]);
  ok('R9 …a one-location building names no location', every(fl.areas, (a) => a.location === null));
  eq('R10 the totals', [rep.totals.up, rep.totals.down, rep.totals.total, rep.totals.buildings], [6, 4, 10, 2]);
  eq('R10 …nothing rated: no buildings, no percent', call(ar.visitorRatingsReport, [], { sites, clients })?.totals, { up: 0, down: 0, total: 0, pctPositive: null, buildings: 0 });
}

// ── U. the public page's wiring (UI_RULES §174) ────────────────────────────
// Source checks, as test-area-scan's "boots no store": the visitor's two pieces are their own
// components, mounted once below the ready card, and boot no store either.
{
  const { readFileSync, existsSync } = await import('node:fs');
  const src = (rel) => { const p = new URL(`../${rel}`, import.meta.url); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
  const page = src('src/pages/PublicAreaScan.jsx');
  const rating = src('src/components/ScanAreaRating.jsx');
  const form = src('src/components/ScanVisitorReport.jsx');
  const device = src('src/lib/visitorDevice.js');
  ok('U1 the page mounts the rating and the report, once each', (page.match(/<ScanAreaRating\b/g) || []).length === 1 && (page.match(/<ScanVisitorReport\b/g) || []).length === 1);
  ok('U1 …after the ready card (never on a dead code, a busy or an error state)', page.indexOf('<ScanVisitorReport') > page.indexOf("view.status === 'error'") && page.indexOf('<ScanAreaRating') > page.indexOf('</article>'));
  const noStore = (s) => !!s && !/from '\.\.\/store'|useStore|useDispatch|useAuth|AppLayout/.test(s);
  ok('U2 neither piece, nor the phone\'s id, boots the store (the page stays storeless)', noStore(rating) && noStore(form) && noStore(device));
  ok('U3 the report goes through the adapter with the phone\'s id and a caller-minted id', /sendVisitorReport\(/.test(form) && /deviceId: visitorDeviceId\(\)/.test(form) && /id: idRef\.current/.test(form));
  ok('U3 …the four choices come from the rules, never a list of its own', /VISITOR_CHOICE_KEYS\.map/.test(form) && !/'Out of supplies'/.test(form));
  ok('U4 the honeypot is a field no person reaches (hidden, out of the tab order)', /aria-hidden="true"/.test(form) && /name="website"[^>]*tabIndex=\{-1\}/.test(form) && /\bhp,/.test(form));
  ok('U5 the form is the kit\'s sheet', /<Modal[^>]*size="sheet"/.test(form));
  ok('U5 …its photo is redrawn on the phone within the rule\'s edge', /VISITOR_PHOTO_MAX_EDGE/.test(form) && /drawJpeg\(/.test(form) && /accept="image\/\*"/.test(form));
  ok('U6 the thumbs are the kit\'s pressed chips, through the adapter, remembered for the day', /aria-pressed=\{vote === b\.vote\}/.test(rating) && /className=\{`chip scan-rate-btn/.test(rating) && /rateScanArea\(/.test(rating) && /rememberVote\(/.test(rating));
  ok('U7 the phone\'s id comes from the browser\'s CSPRNG, never Math.random', /crypto\.getRandomValues/.test(device) && !/Math\.random/.test(device) && !/Math\.random/.test(form));
}

console.log(`\ntest-visitor-reports: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
