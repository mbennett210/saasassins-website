// The satisfaction survey, from the browser (Matt's approved messages, 2026-10-19):
//   getPublicSurvey / answerPublicSurvey  the customer's page at /survey/:token (no sign-in: the
//                                         link's token is the capability) → EP-424 / EP-425
//   listClientSurveys                     the office's customer page (Activity → Surveys) → EP-426
// The login-free demo has no backend and sends no survey: its customer page says "No surveys yet",
// and ONE sample link (DEMO_SURVEY_TOKEN, the sweeps' /survey/… page) opens an open survey whose
// answer stays in the page (nothing is stored anywhere); any other link is not found.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';

const BACKEND = demoBackendsEngaged()
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

async function call(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? await authHeaders() : {}) };
  const res = await fetch(`${BACKEND}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    if (typeof json?.code === 'string') err.code = json.code;
    throw err;
  }
  return json;
}

export const DEMO_SURVEY_TOKEN = 'demoSurveySampleLink0000000000000000000001';
let demoAnswer = null;
const notFound = () => Object.assign(new Error('This survey link isn’t valid.'), { status: 404, code: 'survey-not-found' });

/** → { state: 'open' | 'answered' | 'expired', company, rating, comment } */
export async function getPublicSurvey(token) {
  if (!BACKEND) {
    if (token !== DEMO_SURVEY_TOKEN) throw notFound();
    return { state: demoAnswer ? 'answered' : 'open', company: '', rating: demoAnswer?.rating ?? null, comment: demoAnswer?.comment ?? null };
  }
  return call(`/public/qc/survey?token=${encodeURIComponent(token)}`);
}

/** → { ok, state } */
export async function answerPublicSurvey(token, { rating, comment }) {
  if (!BACKEND) {
    if (token !== DEMO_SURVEY_TOKEN) throw notFound();
    demoAnswer = { rating, comment: comment || null };
    return { ok: true, state: 'answered' };
  }
  return call('/public/qc/survey', { method: 'POST', body: { token, rating, comment } });
}

/** → { surveys: [{ id, sentAt, expiresAt, rating, comment, answeredAt }] } */
export async function listClientSurveys(clientId) {
  if (!BACKEND) return { surveys: [] };
  return call(`/qc/surveys?clientId=${encodeURIComponent(clientId)}`, { auth: true });
}
