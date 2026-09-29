// Google Business Profile REST client. Four API surfaces, one Bearer token:
//   accounts   — mybusinessaccountmanagement.googleapis.com/v1
//   locations  — mybusinessbusinessinformation.googleapis.com/v1
//   reviews    — mybusiness.googleapis.com/v4 (the legacy surface still hosts
//                reviews + review replies; the v1 APIs never got them)
//   metrics    — businessprofileperformance.googleapis.com/v1
// All four must be ENABLED on the Google Cloud project (console step). Auth
// rides the same Internal OAuth app as the Gmail integration with the
// business.manage scope; tokens refresh via api/_lib/google.js.
import { refreshAccessToken } from '../google.js';

async function gapi(token, url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GBP ${method} ${url.split('?')[0]} failed (${res.status}): ${data.error?.message || res.statusText}`);
    err.status = res.status; // routes map 429 (quota) to an honest client message
    throw err;
  }
  return data;
}

// `creds` = the GBP OAuth client (see gmbCreds() in api/reviews). A refresh
// token is bound to the client that issued it — refreshing with the Gmail
// client's id would 401, so the caller must pass the same creds throughout.
export async function accessTokenFor(refreshToken, creds = {}) {
  const t = await refreshAccessToken(refreshToken, creds);
  return t.access_token || t.accessToken || t;
}

export async function listAccounts(token) {
  const data = await gapi(token, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  return data.accounts || [];
}

export async function listLocations(token, accountName) {
  const params = new URLSearchParams({ readMask: 'name,title', pageSize: '100' });
  const data = await gapi(token, `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?${params}`);
  return data.locations || [];
}

// v4 star ratings arrive as enum strings.
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export const starToInt = (s) => (typeof s === 'number' ? s : STARS[s] ?? null);

// Pure — unit-tested. One v4 review resource → one gmb_reviews row.
export function reviewToRow(r, organizationId, locationName) {
  return {
    review_name: r.name,
    organization_id: organizationId,
    location_name: locationName,
    reviewer_name: r.reviewer?.displayName || null,
    reviewer_photo: r.reviewer?.profilePhotoUrl || null,
    star_rating: starToInt(r.starRating),
    comment: r.comment || null,
    create_time: r.createTime || null,
    update_time: r.updateTime || r.createTime || null,
    reply_comment: r.reviewReply?.comment || null,
    reply_update_time: r.reviewReply?.updateTime || null,
    raw: r,
    synced_at: new Date().toISOString(),
  };
}

// One page of reviews; caller loops on nextPageToken. The v4 path needs the
// numeric account AND location segments: accounts/{a}/locations/{l}/reviews.
export async function listReviewsPage(token, accountName, locationName, pageToken = null) {
  const locId = locationName.split('/').pop();
  const params = new URLSearchParams({ pageSize: '50' });
  if (pageToken) params.set('pageToken', pageToken);
  const data = await gapi(token, `https://mybusiness.googleapis.com/v4/${accountName}/locations/${locId}/reviews?${params}`);
  return { reviews: data.reviews || [], nextPageToken: data.nextPageToken || null, totalReviewCount: data.totalReviewCount ?? null };
}

export async function putReply(token, reviewName, comment) {
  return gapi(token, `https://mybusiness.googleapis.com/v4/${reviewName}/reply`, { method: 'PUT', body: { comment } });
}

export async function deleteReply(token, reviewName) {
  return gapi(token, `https://mybusiness.googleapis.com/v4/${reviewName}/reply`, { method: 'DELETE' });
}

// The four Reviews-page tiles, trailing ~30 days, summed:
//   Profile views — impressions across surfaces · Searches — the search subset
//   Calls — CALL_CLICKS · Directions — BUSINESS_DIRECTION_REQUESTS
const IMPRESSION_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
];
export async function fetchInsights(token, locationName) {
  const locId = locationName.split('/').pop();
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 86400000);
  const params = new URLSearchParams();
  for (const m of [...IMPRESSION_METRICS, 'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS']) {
    params.append('dailyMetrics', m);
  }
  params.set('dailyRange.start_date.year', String(start.getUTCFullYear()));
  params.set('dailyRange.start_date.month', String(start.getUTCMonth() + 1));
  params.set('dailyRange.start_date.day', String(start.getUTCDate()));
  params.set('dailyRange.end_date.year', String(now.getUTCFullYear()));
  params.set('dailyRange.end_date.month', String(now.getUTCMonth() + 1));
  params.set('dailyRange.end_date.day', String(now.getUTCDate()));
  const data = await gapi(token, `https://businessprofileperformance.googleapis.com/v1/locations/${locId}:fetchMultiDailyMetricsTimeSeries?${params}`);
  return summarizeInsights(data);
}

// Pure — unit-tested. Collapses the multiDailyMetricTimeSeries payload into
// the four tile totals for the trailing window.
export function summarizeInsights(data) {
  const totals = {};
  for (const outer of data.multiDailyMetricTimeSeries || []) {
    for (const series of outer.dailyMetricTimeSeries || []) {
      const metric = series.dailyMetric;
      let sum = 0;
      for (const point of series.timeSeries?.datedValues || []) sum += Number(point.value || 0);
      totals[metric] = (totals[metric] || 0) + sum;
    }
  }
  const impressions = IMPRESSION_METRICS.reduce((a, m) => a + (totals[m] || 0), 0);
  const searches = (totals.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0) + (totals.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0);
  return {
    profileViews: impressions,
    searches,
    calls: totals.CALL_CLICKS || 0,
    directions: totals.BUSINESS_DIRECTION_REQUESTS || 0,
    windowDays: 30,
  };
}

// ---------- Google Posts (v4 localPosts) ----------

export const POST_TOPIC_TYPES = ['STANDARD', 'EVENT', 'OFFER'];
export const CTA_ACTION_TYPES = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];

// The v4 schedule wants Date {year,month,day} + TimeOfDay {hours,minutes}
// objects. Built from 'YYYY-MM-DD' / 'HH:mm' string parts — never new Date()
// parsing (org-zone law).
function parseDateParts(dateStr, timeStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const out = { date: { year, month, day } };
  if (typeof timeStr === 'string' && /^\d{2}:\d{2}$/.test(timeStr)) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (hours < 24 && minutes < 60) out.time = { hours, minutes };
  }
  return out;
}
const partsTuple = (p) => [p.date.year, p.date.month, p.date.day, p.time?.hours ?? 0, p.time?.minutes ?? 0];
function comparePartsTuples(a, b) {
  const ta = partsTuple(a); const tb = partsTuple(b);
  for (let i = 0; i < 5; i += 1) { if (ta[i] !== tb[i]) return ta[i] - tb[i]; }
  return 0;
}

// Pure — unit-tested. UI input → a valid v4 LocalPost body, or a human error.
// Every rule here exists because Google 400s (or silently mangles) otherwise:
//   · OFFER must NOT carry a callToAction — Google adds "View offer" itself.
//   · EVENT and OFFER both require event.title + schedule start/end.
//   · CALL buttons take no url (the listing's phone number is used).
export function buildLocalPost(input = {}) {
  const topicType = input.topicType;
  if (!POST_TOPIC_TYPES.includes(topicType)) {
    return { ok: false, error: "Post type must be What's New, Event, or Offer." };
  }
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length > 1500) return { ok: false, error: 'Post text is too long (1500 characters max).' };
  if (topicType === 'STANDARD' && !summary) return { ok: false, error: 'Post text is required.' };
  const post = { languageCode: 'en-US', topicType };
  if (summary) post.summary = summary;

  if (topicType === 'EVENT' || topicType === 'OFFER') {
    const title = typeof input.eventTitle === 'string' ? input.eventTitle.trim() : '';
    if (!title) return { ok: false, error: `${topicType === 'EVENT' ? 'Event' : 'Offer'} title is required.` };
    const start = parseDateParts(input.startDate, input.startTime);
    const end = parseDateParts(input.endDate, input.endTime);
    if (!start) return { ok: false, error: 'Start date is required (YYYY-MM-DD).' };
    if (!end) return { ok: false, error: 'End date is required (YYYY-MM-DD).' };
    if (comparePartsTuples(end, start) < 0) return { ok: false, error: 'End must be on or after the start.' };
    post.event = {
      title,
      schedule: {
        startDate: start.date,
        endDate: end.date,
        ...(start.time ? { startTime: start.time } : {}),
        ...(end.time ? { endTime: end.time } : {}),
      },
    };
  }

  const cta = input.cta && input.cta.actionType ? input.cta : null;
  if (cta) {
    if (topicType === 'OFFER') {
      return { ok: false, error: 'Offers get a "View offer" button automatically — remove the custom button.' };
    }
    if (!CTA_ACTION_TYPES.includes(cta.actionType)) return { ok: false, error: 'Unknown button type.' };
    if (cta.actionType !== 'CALL' && !/^https?:\/\//.test(cta.url || '')) {
      return { ok: false, error: 'The button needs a valid https:// link.' };
    }
    post.callToAction = { actionType: cta.actionType, ...(cta.actionType !== 'CALL' ? { url: cta.url } : {}) };
  }

  if (topicType === 'OFFER') {
    const offer = {};
    if (input.couponCode) offer.couponCode = String(input.couponCode).trim();
    if (input.redeemOnlineUrl) {
      if (!/^https?:\/\//.test(input.redeemOnlineUrl)) return { ok: false, error: 'Redeem link must be a valid https:// URL.' };
      offer.redeemOnlineUrl = input.redeemOnlineUrl;
    }
    if (input.termsConditions) offer.termsConditions = String(input.termsConditions).trim();
    if (Object.keys(offer).length) post.offer = offer;
  } else if (input.couponCode || input.redeemOnlineUrl || input.termsConditions) {
    return { ok: false, error: 'Coupon fields only apply to Offer posts.' };
  }

  if (input.photoUrl) post.media = [{ mediaFormat: 'PHOTO', sourceUrl: input.photoUrl }];
  return { ok: true, post };
}

// Pure — unit-tested. One v4 LocalPost resource → the UI item shape.
export function localPostToItem(p) {
  return {
    name: p.name,
    topicType: p.topicType,
    state: p.state || null,          // PROCESSING | LIVE | REJECTED
    summary: p.summary || null,
    searchUrl: p.searchUrl || null,
    createTime: p.createTime || null,
    updateTime: p.updateTime || null,
    cta: p.callToAction || null,
    event: p.event || null,
    offer: p.offer || null,
    photoUrl: p.media?.[0]?.googleUrl || p.media?.[0]?.sourceUrl || null,
  };
}

const MAX_POST_PAGES = 3; // 300 posts = years of volume at CleanSpace cadence

export async function listLocalPosts(token, accountName, locationName) {
  const locId = locationName.split('/').pop();
  let pageToken = null;
  let posts = [];
  let pages = 0;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await gapi(token, `https://mybusiness.googleapis.com/v4/${accountName}/locations/${locId}/localPosts?${params}`);
    posts = posts.concat(data.localPosts || []);
    pageToken = data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < MAX_POST_PAGES);
  return { posts, truncated: Boolean(pageToken) };
}

export async function createLocalPost(token, accountName, locationName, post) {
  const locId = locationName.split('/').pop();
  return gapi(token, `https://mybusiness.googleapis.com/v4/${accountName}/locations/${locId}/localPosts`, { method: 'POST', body: post });
}

export async function deleteLocalPost(token, postName) {
  return gapi(token, `https://mybusiness.googleapis.com/v4/${postName}`, { method: 'DELETE' });
}

// ---------- Listing photos (v4 media) ----------

// v4 CategoryType enum — note TEAMS (not TEAM); wrong enum = 400.
export const PHOTO_CATEGORIES = ['COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR', 'TEAMS', 'AT_WORK', 'ADDITIONAL'];

// Google's GBP photo rules: JPG/PNG only, ≥10KB, and ≥250×250px (the pixel
// floor is enforced client-side pre-upload and by Google itself on fetch).
const GBP_PHOTO_MIN_BYTES = 10 * 1024;
const GBP_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export function validateGbpPhoto({ mimeType, sizeBytes } = {}) {
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
    return { ok: false, error: 'Google listing photos must be JPG or PNG.' };
  }
  const size = Number(sizeBytes) || 0;
  if (size < GBP_PHOTO_MIN_BYTES) return { ok: false, error: 'Image is too small — Google requires at least 10 KB.' };
  if (size > GBP_PHOTO_MAX_BYTES) return { ok: false, error: 'Image is too large (10 MB max).' };
  return { ok: true };
}

// Pure — unit-tested. One v4 MediaItem resource → the UI item shape.
export function mediaItemToItem(m) {
  return {
    name: m.name,
    category: m.locationAssociation?.category || null,
    googleUrl: m.googleUrl || null,
    thumbnailUrl: m.thumbnailUrl || m.googleUrl || null,
    createTime: m.createTime || null,
    viewCount: Number(m.insights?.viewCount) || 0,
    width: m.dimensions?.widthPixels || null,
    height: m.dimensions?.heightPixels || null,
  };
}

const MAX_MEDIA_PAGES = 3;

export async function listMediaItems(token, accountName, locationName) {
  const locId = locationName.split('/').pop();
  let pageToken = null;
  let items = [];
  let pages = 0;
  let total = null;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await gapi(token, `https://mybusiness.googleapis.com/v4/${accountName}/locations/${locId}/media?${params}`);
    items = items.concat(data.mediaItems || []);
    total = data.totalMediaItemCount ?? total;
    pageToken = data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < MAX_MEDIA_PAGES);
  return { items, totalMediaItemCount: total, truncated: Boolean(pageToken) };
}

// Google fetches sourceUrl during create and 400s on unfetchable / too-small /
// bad-ratio images — the caller surfaces that message verbatim.
export async function createMediaItem(token, accountName, locationName, { category, sourceUrl }) {
  const locId = locationName.split('/').pop();
  return gapi(token, `https://mybusiness.googleapis.com/v4/${accountName}/locations/${locId}/media`, {
    method: 'POST',
    body: { mediaFormat: 'PHOTO', locationAssociation: { category }, sourceUrl },
  });
}

export async function deleteMediaItem(token, mediaName) {
  return gapi(token, `https://mybusiness.googleapis.com/v4/${mediaName}`, { method: 'DELETE' });
}

// ---------- Search keywords (Performance v1) ----------

const MAX_KEYWORD_PAGES = 5; // 500 keywords/month

// One MONTH per call so rows land in clean monthly buckets for gmb_keywords.
export async function fetchKeywordsMonth(token, locationName, { year, month }) {
  const locId = locationName.split('/').pop();
  let pageToken = null;
  let counts = [];
  let pages = 0;
  do {
    const params = new URLSearchParams();
    params.set('monthlyRange.start_month.year', String(year));
    params.set('monthlyRange.start_month.month', String(month));
    params.set('monthlyRange.end_month.year', String(year));
    params.set('monthlyRange.end_month.month', String(month));
    params.set('pageSize', '100');
    if (pageToken) params.set('pageToken', pageToken);
    const data = await gapi(token, `https://businessprofileperformance.googleapis.com/v1/locations/${locId}/searchkeywords/impressions/monthly?${params}`);
    counts = counts.concat(data.searchKeywordsCounts || []);
    pageToken = data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < MAX_KEYWORD_PAGES);
  return { searchKeywordsCounts: counts };
}

// Pure — unit-tested. Google withholds exact counts under ~15 impressions and
// sends `threshold` instead of `value`; we keep the flag so the UI renders "< N".
export function keywordRowsFrom(payload, monthKey, organizationId) {
  const counts = Array.isArray(payload?.searchKeywordsCounts) ? payload.searchKeywordsCounts : [];
  return counts
    .filter((c) => typeof c.searchKeyword === 'string' && c.searchKeyword)
    .map((c) => {
      const value = c.insightsValue?.value;
      const threshold = c.insightsValue?.threshold;
      return {
        organization_id: organizationId,
        month: monthKey,
        keyword: c.searchKeyword,
        impressions: Number(value ?? threshold ?? 0) || 0,
        thresholded: value == null,
        synced_at: new Date().toISOString(),
      };
    });
}

// ---------- Review trends (derived from OUR gmb_reviews rows) ----------

// Pure — unit-tested. Buckets by 'YYYY-MM' key strings (never Date parsing),
// trailing 12 months ending at nowIso's month.
export function computeReviewTrends(rows, nowIso) {
  const list = Array.isArray(rows) ? rows : [];
  let [y, m] = String(nowIso).slice(0, 7).split('-').map(Number);
  const keys = [];
  for (let i = 0; i < 12; i += 1) {
    keys.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  const buckets = new Map(keys.map((k) => [k, { count: 0, sum: 0 }]));
  let replied = 0;
  for (const r of list) {
    if (r.reply_comment) replied += 1;
    const b = buckets.get(String(r.create_time || '').slice(0, 7));
    if (b) { b.count += 1; b.sum += Number(r.star_rating) || 0; }
  }
  return {
    months: keys.map((k) => {
      const b = buckets.get(k);
      return { month: k, count: b.count, avg: b.count ? Math.round((b.sum / b.count) * 100) / 100 : null };
    }),
    replyCoverage: { replied, total: list.length },
  };
}
