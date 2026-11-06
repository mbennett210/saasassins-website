// PUBLIC, token-scoped inspection report (the shareable QC results link — the
// quotes public-link pattern). NO requireAuth: the unguessable public_token
// IS the capability. Returns a safe projection only; draft records 404; a failure is a
// sentence and a code, never the provider's words (CS-648).
//
// AUTH STANCE: public — no requireAuth; the unguessable CSPRNG public_token is the capability (getInspectionByToken); safe projection only, draft records 404.
// The satisfaction survey (Matt's approved messages, 2026-10-19) rides the same public domain: the
// 256-bit CSPRNG token in the customer's email is the capability (only its SHA-256 is stored), a
// malformed one is the same 404 with no read, per-IP and per-token limits, and the answer may be
// changed a few times while the link works (a compare-and-swap on the row).
//
//   GET  /api/public/qc/inspection?token=<token>      ->  { inspection, items, photos }
//   GET  /api/public/qc/inspection-pdf?token=<token>  ->  application/pdf (attachment)
//   GET  /api/public/qc/survey?token=<token>          ->  { state, company, rating, comment }   (EP-424)
//   POST /api/public/qc/survey { token, rating, comment } -> { ok, state }                      (EP-425)
import { getInspectionByToken, getInspectionRawByToken } from '../../_lib/qc/store.js';
import { surveyByToken, surveyState, surveyAnswer, answerSurvey, SURVEY_TOKEN_RE } from '../../_lib/customerMessages/surveys.js';
import { readProtectedSlices } from '../../_lib/orgState.js';
import { hit, clientIp, tooMany } from '../../_lib/rateLimit.js';

// The survey's limits: per visitor IP (reads and answers together), and answers per link.
export const SURVEY_IP_RATE = { limit: 30, windowMs: 60 * 1000 };
export const SURVEY_TOKEN_RATE = { limit: 10, windowMs: 60 * 60 * 1000 };
const SURVEY_NOT_FOUND = Object.freeze({ status: 404, code: 'survey-not-found', error: 'This survey link isn’t valid.' });

// What the page shows: whether it may be answered, and the company's name. Never an id, the
// customer's name, the token or anything the office wrote.
async function surveyView(row) {
  let company = '';
  try { company = (await readProtectedSlices('company:state->company'))?.company?.name || ''; } catch { /* the page has a default */ }
  return { state: surveyState(row), company, rating: row.rating ?? null, comment: row.comment ?? null };
}
import { renderInspectionReportPdf, inspectionPdfFilename } from '../../_lib/qc/reportPdf.js';

// maxDuration: the inspection-pdf action launches headless chromium — cold-start +
// render can exceed the default limit. Mirrors the quote + pay routes.
export const config = { maxDuration: 60 };

// 🔴 CS-648 (the CS-077 class): this route answers ANYONE holding a link, so a failure is a
// sentence and a stable code, never the provider's words (a table or column name, a renderer's
// path) — the detail is logged, as the public scan page does (api/public/scan). Both actions are
// reads, so it is "try again" (503).
export const PUBLIC_REPORT_UNAVAILABLE = Object.freeze({
  status: 503,
  code: 'report-unavailable',
  error: 'This report could not be loaded just now. Please try again in a minute.',
});

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;

  try {
    if (action === 'inspection' && req.method === 'GET') {
      const token = (req.query.token || '').toString();
      if (!token) return res.status(400).json({ error: 'token is required' });
      const r = await getInspectionByToken(token);
      if (!r) return res.status(404).json({ error: 'Report not found' });
      return res.status(200).json(r);
    }
    // Same report, rendered to PDF — the "Download PDF" button on the shared link.
    // Token IS the capability (submitted-only); drafts 404 exactly like the HTML view.
    if (action === 'inspection-pdf' && req.method === 'GET') {
      const token = (req.query.token || '').toString();
      if (!token) return res.status(400).json({ error: 'token is required' });
      const raw = await getInspectionRawByToken(token);
      if (!raw) return res.status(404).json({ error: 'Report not found' });
      const pdf = await renderInspectionReportPdf(raw.rec, raw.items);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${inspectionPdfFilename(raw.rec)}"`);
      return res.status(200).send(Buffer.from(pdf));
    }
    if (action === 'survey' && (req.method === 'GET' || req.method === 'POST')) {
      res.setHeader('Cache-Control', 'no-store');
      const ip = hit(`survey:ip:${clientIp(req)}`, SURVEY_IP_RATE);
      if (!ip.ok) return tooMany(res, ip.retryAfterMs, 'rate-limited');
      const token = String((req.method === 'GET' ? req.query.token : req.body?.token) || '');
      const { status, code, error } = SURVEY_NOT_FOUND;
      if (!SURVEY_TOKEN_RE.test(token)) return res.status(status).json({ error, code });
      const row = await surveyByToken(token);
      if (!row) return res.status(status).json({ error, code });
      if (req.method === 'GET') return res.status(200).json(await surveyView(row));
      if (!/application\/json/i.test(String(req.headers?.['content-type'] || ''))) return res.status(415).json({ error: 'Send JSON.', code: 'survey-body' });
      if (req.body?.website) return res.status(200).json({ ok: true, state: surveyState(row) });   // a honeypot: nothing written
      const per = hit(`survey:token:${row.id}`, SURVEY_TOKEN_RATE);
      if (!per.ok) return tooMany(res, per.retryAfterMs, 'rate-limited');
      const answer = surveyAnswer(req.body || {});
      if (answer.error) return res.status(400).json({ error: answer.error, code: answer.code });
      let outcome = await answerSurvey(row, answer);
      if (outcome === 'conflict') {
        const fresh = await surveyByToken(token);
        outcome = fresh ? await answerSurvey(fresh, answer) : 'conflict';
      }
      if (outcome === 'expired') return res.status(410).json({ error: 'This survey has closed. Thank you all the same.', code: 'survey-expired' });
      if (outcome === 'limit') return res.status(429).json({ error: 'This survey’s answer can’t be changed again.', code: 'survey-limit' });
      if (outcome !== 'saved') return res.status(409).json({ error: 'Your answer didn’t save. Please try again.', code: 'survey-conflict' });
      return res.status(200).json({ ok: true, state: 'answered' });
    }
    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    // The detail is logged here; the visitor gets a sentence and a code (CS-648, CS-077).
    console.error('[api/public/qc]', action || '?', e?.code || e?.name || 'error', e?.message || '');
    const { status, code, error } = PUBLIC_REPORT_UNAVAILABLE;
    return res.status(status).json({ error, code });
  }
}
