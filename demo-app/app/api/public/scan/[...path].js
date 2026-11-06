// PUBLIC — the QR code on a wall (QR-2, QR-3, QR-15, QR-28, QR-31, HUB-15). Anyone may scan it;
// nobody signs in, and no session is read.
//
// AUTH STANCE: public — the unguessable CSPRNG scan token (192 bits, area_scan_codes.token)
// IS the capability, and the office can revoke it at any time (Replace). The answer is the
// ALLOWLIST projection in src/lib/areaScan.projectAreaScan and nothing else: no user ids or
// names, no notes, no result, customer or location ids, no URL. Rate-limited per visitor IP
// and per code (_lib/rateLimit.js, CS-073); never launches a browser; reads ONE location out
// of the shared record (`area_scan_site`), never the whole document; never cached
// (`no-store` — the answer is "as of now"). Failures are a sentence plus a stable code,
// never the provider's words (CS-077). The answer also carries the location's next scheduled
// clean and its last inspection as DATES only (QR-28, QR-15 — no time, so the public never learns
// when cleaners are on site) and the company's phone for urgent problems (QR-31).
//
//   GET /api/public/scan/area?token=<token>   → the projection (EP-263)
//   GET /api/public/scan/photo?token=<token>  → that area's newest checklist photo, image bytes (EP-264)
//
// ── A VISITOR'S TWO WRITES (QR-22..QR-26, QR-30; UI_RULES §174) — the only writes on this page ──
//   POST /api/public/scan/report  { token, category, text?, name?, contact?, photo?, deviceId, id?, hp }
//        → { ok, message, photoSaved }: a ticket at the code's location and area, through the
//          office's own path (EP-414). `category` is one of the four choices; `photo` a data URL.
//   POST /api/public/scan/rate    { token, value: 'up' | 'down', deviceId } → { ok, vote, message } (EP-415)
// AUTH STANCE (both): public — the scan token is the capability, exactly as for the reads; the
// code (never the body) names the location, the customer and the area. Each is held, in order:
// per visitor IP (in-process), `application/json` and a capped body (415 / 413), the honeypot (a
// filled one answers the same thanks and writes nothing), the token's shape, per code
// (in-process), the input (lib/visitorReports / lib/areaRatings), the photo's BYTES (its type by
// magic number, ≤ 2 MB), then in the database the DURABLE limits (per phone, per code, the same
// report twice — api/_lib/scanCodes/visitor.js; the phone is an HMAC of the page's random id, never
// an IP) and the code's liveness through the shared location rule. Every refusal is a sentence and
// a stable code, never the visitor's own words back; `no-store`. No session is read.
//
// An unknown, malformed, replaced or orphaned code (its area or its location removed), and a
// code at an ARCHIVED customer's building (QR-27), all answer the SAME 404 "This code is no longer
// active." — the answer never says whether a token ever existed.
import { allow, clientIp } from '../../_lib/rateLimit.js';
import { withRequestCache } from '../../_lib/requestCache.js';
import { scanAreaStatus, scanPhoto } from '../../_lib/scanCodes/store.js';
import { fileVisitorReport, rateScannedArea } from '../../_lib/scanCodes/visitor.js';
import {
  isScanToken, projectAreaScan, SCAN_RATE, SCAN_RATE_LIMITED_CODE,
  SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE, SCAN_UNAVAILABLE_CODE, SCAN_UNAVAILABLE_MESSAGE, SCAN_PHOTO_NONE_CODE,
} from '../../../src/lib/areaScan.js';
import {
  visitorReportInput, visitorPhotoBytesRefusal, visitorHoneypotFilled, visitorReportStatus,
  VISITOR_REPORT_CODES, VISITOR_REPORT_MESSAGES, VISITOR_REPORT_THANKS, VISITOR_REPORT_ALREADY,
  VISITOR_BODY_MAX_BYTES, VISITOR_POST_RATE,
} from '../../../src/lib/visitorReports.js';
import {
  areaRatingInput, areaRatingStatus, AREA_RATING_CODES, AREA_RATING_MESSAGES, AREA_RATING_THANKS,
  AREA_RATING_BODY_MAX_BYTES,
} from '../../../src/lib/areaRatings.js';

// A report may carry one photo (≤ 2 MB decoded, ~2.7 MB as base64): the body parser's ceiling sits
// just above the route's own (lib/visitorReports VISITOR_BODY_MAX_BYTES, which answers in words),
// and well inside the platform's 4.5 MB.
export const config = { api: { bodyParser: { sizeLimit: '3mb' } } };

// The photo is the same until the next clean, so the viewer may keep it a few minutes; the
// ANSWER is never kept (it says how old the last clean is).
const PHOTO_MAX_AGE_S = 300;

const inactive = (res) => res.status(404).json({ error: SCAN_INACTIVE_MESSAGE, code: SCAN_INACTIVE_CODE });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;

  // ── the visitor's two writes (EP-414, EP-415) — request-scoped cache: one shared-record read ──
  if (action === 'report' || action === 'rate') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST is supported here.', code: 'method-not-allowed' });
    return withRequestCache(() => visitorWrite(req, res, action));
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET is supported here.', code: 'method-not-allowed' });
  if (action !== 'area' && action !== 'photo') return res.status(404).json({ error: 'Not found.', code: 'not-found' });

  // Per visitor first, before anything is looked up; then per code, so one code on a busy
  // wall cannot be hammered from many addresses either. A malformed token costs no read.
  if (!allow(req, res, { bucket: 'scan_ip', id: clientIp(req), ...SCAN_RATE.perIp, code: SCAN_RATE_LIMITED_CODE })) return undefined;
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!isScanToken(token)) return inactive(res);
  if (!allow(req, res, { bucket: 'scan_token', id: token, ...SCAN_RATE.perToken, code: SCAN_RATE_LIMITED_CODE })) return undefined;

  try {
    if (action === 'area') {
      const nowMs = Date.now();
      const st = await scanAreaStatus(token, undefined, { nowMs });
      if (!st) return inactive(res);
      return res.status(200).json(projectAreaScan({
        building: st.clientName || st.siteName,
        location: st.siteName,
        area: st.row,
        timeZone: st.timeZone,
        nowMs,
        nextCleanOn: st.nextCleanOn,
        lastInspectionOn: st.lastInspectionOn,
        phone: st.phone,
      }));
    }
    const p = await scanPhoto(token);
    if (p.inactive) return inactive(res);
    if (!p.bytes) return res.status(404).json({ error: 'There is no photo of this area yet.', code: SCAN_PHOTO_NONE_CODE });
    res.setHeader('Cache-Control', `private, max-age=${PHOTO_MAX_AGE_S}`);
    res.setHeader('Content-Type', p.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(p.bytes);
  } catch (e) {
    // The detail is logged here; the visitor gets a sentence and a code (CS-077).
    console.error('[api/public/scan]', action, e?.code || e?.name || 'error', e?.message || '');
    return res.status(503).json({ error: SCAN_UNAVAILABLE_MESSAGE, code: SCAN_UNAVAILABLE_CODE });
  }
}

// ── the visitor's two writes (see the header) ───────────────────────────────────────────────
const isJsonRequest = (req) => String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';
const declaredLength = (req) => {
  const n = Number(req.headers?.['content-length']);
  return Number.isFinite(n) ? n : 0;
};
// The parsed body (the platform parses JSON); a body it handed over as text is parsed here. Anything
// that is not one JSON object is null.
function jsonBody(req) {
  let b;
  try { b = req.body; } catch { return null; }
  if (typeof b === 'string' || Buffer.isBuffer(b)) {
    try { b = JSON.parse(String(b)); } catch { return null; }
  }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

async function visitorWrite(req, res, action) {
  const report = action === 'report';
  const CODES = report ? VISITOR_REPORT_CODES : AREA_RATING_CODES;
  const MESSAGES = report ? VISITOR_REPORT_MESSAGES : AREA_RATING_MESSAGES;
  const statusOf = report ? visitorReportStatus : areaRatingStatus;
  const maxBytes = report ? VISITOR_BODY_MAX_BYTES : AREA_RATING_BODY_MAX_BYTES;
  const refuse = (code, status) => res.status(status || statusOf(code)).json({ error: MESSAGES[code], code });

  // Per visitor first, before anything is read (one allowance for both writes).
  if (!allow(req, res, { bucket: 'scan_post_ip', id: clientIp(req), ...VISITOR_POST_RATE.perIp, code: SCAN_RATE_LIMITED_CODE })) return undefined;
  if (!isJsonRequest(req)) return refuse(CODES.contentType);
  if (declaredLength(req) > maxBytes) return refuse(CODES.tooLarge);
  const body = jsonBody(req);
  if (!body) return refuse(CODES.body);
  if (Buffer.byteLength(JSON.stringify(body)) > maxBytes) return refuse(CODES.tooLarge);
  // A filled honeypot is a script: the same thanks a person gets, and nothing written.
  if (report && visitorHoneypotFilled(body)) return res.status(200).json({ ok: true, message: VISITOR_REPORT_THANKS, photoSaved: null });

  const token = typeof body.token === 'string' ? body.token : '';
  if (!isScanToken(token)) return inactive(res);
  if (!allow(req, res, { bucket: 'scan_post_token', id: token, ...VISITOR_POST_RATE.perToken, code: SCAN_RATE_LIMITED_CODE })) return undefined;

  const input = report ? visitorReportInput(body) : areaRatingInput(body);
  if (input.refused) return refuse(input.code);
  // The photo's BYTES, before anything is read: the declared type is the sender's word.
  let photo = null;
  if (report && input.value.photo) {
    const bytes = Buffer.from(input.value.photo.base64, 'base64');
    const bad = visitorPhotoBytesRefusal(bytes, input.value.photo.mimeType);
    if (bad) return refuse(bad.code);
    photo = { bytes, mimeType: input.value.photo.mimeType };
  }

  try {
    if (report) {
      const r = await fileVisitorReport({ token, input: input.value, photo, nowMs: Date.now() });
      if (r.outcome === 'inactive') return inactive(res);
      if (r.outcome === 'refused') return refuse(r.code, r.status);
      if (r.outcome === 'duplicate') return res.status(200).json({ ok: true, duplicate: true, message: VISITOR_REPORT_ALREADY, photoSaved: null });
      return res.status(200).json({ ok: true, message: VISITOR_REPORT_THANKS, photoSaved: r.photoSaved ?? null });
    }
    const r = await rateScannedArea({ token, input: input.value, nowMs: Date.now() });
    if (r.outcome === 'inactive') return inactive(res);
    if (r.outcome === 'refused') return refuse(r.code);
    return res.status(200).json({ ok: true, vote: r.vote, message: AREA_RATING_THANKS });
  } catch (e) {
    // The provider's words (or a missing secret's name) go to the log; the visitor gets a sentence
    // and a code (CS-077). Nothing was written, or what was written stands.
    console.error('[api/public/scan]', action, e?.code || e?.name || 'error');
    return refuse(CODES.unavailable);
  }
}
