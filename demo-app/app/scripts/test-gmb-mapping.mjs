// Offline units for the GBP client's pure exports: star-rating enum mapping,
// review-resource → gmb_reviews row, the insights payload summarizer, the
// local-post builder/validator, media + keyword mappers, and review trends.
// api/_lib/gmb/client.js imports only api/_lib/google.js (no supabase) — safe offline.
import {
  starToInt, reviewToRow, summarizeInsights,
  buildLocalPost, localPostToItem, mediaItemToItem, validateGbpPhoto,
  keywordRowsFrom, computeReviewTrends,
} from '../api/_lib/gmb/client.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; } else { fail += 1; console.error(`✖ ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

// ── starToInt ──────────────────────────────────────────────────────────────
check('starToInt FIVE', starToInt('FIVE'), 5);
check('starToInt ONE', starToInt('ONE'), 1);
check('starToInt passes numbers through', starToInt(4), 4);
check('starToInt unknown enum → null', starToInt('STAR_RATING_UNSPECIFIED'), null);
check('starToInt undefined → null', starToInt(undefined), null);

// ── reviewToRow ────────────────────────────────────────────────────────────
const ORG = '00000000-0000-0000-0000-000000000001';
const LOC = 'locations/123';
const full = {
  name: 'accounts/1/locations/123/reviews/abc',
  reviewer: { displayName: 'Jane D', profilePhotoUrl: 'https://p/x.jpg' },
  starRating: 'FOUR',
  comment: 'Great crew!',
  createTime: '2026-07-01T00:00:00Z',
  updateTime: '2026-07-02T00:00:00Z',
  reviewReply: { comment: 'Thanks Jane!', updateTime: '2026-07-03T00:00:00Z' },
};
const row = reviewToRow(full, ORG, LOC);
check('row review_name', row.review_name, full.name);
check('row org', row.organization_id, ORG);
check('row reviewer', row.reviewer_name, 'Jane D');
check('row rating', row.star_rating, 4);
check('row reply', row.reply_comment, 'Thanks Jane!');
check('row update_time', row.update_time, '2026-07-02T00:00:00Z');
check('row raw is the resource', row.raw, full);

const minimal = reviewToRow({ name: 'accounts/1/locations/123/reviews/x', starRating: 'FIVE', createTime: '2026-07-05T00:00:00Z' }, ORG, LOC);
check('minimal: nulls not undefined', [minimal.reviewer_name, minimal.comment, minimal.reply_comment], [null, null, null]);
check('minimal: update_time falls back to createTime', minimal.update_time, '2026-07-05T00:00:00Z');

// ── summarizeInsights ──────────────────────────────────────────────────────
const series = (metric, values) => ({ dailyMetric: metric, timeSeries: { datedValues: values.map((v) => (v == null ? {} : { value: String(v) })) } });
const payload = {
  multiDailyMetricTimeSeries: [
    { dailyMetricTimeSeries: [
      series('BUSINESS_IMPRESSIONS_DESKTOP_MAPS', [1, 2, null]),   // missing value = 0 (Google omits zero days)
      series('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', [10]),
      series('BUSINESS_IMPRESSIONS_MOBILE_MAPS', [3]),
      series('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', [20, 5]),
    ] },
    { dailyMetricTimeSeries: [
      series('CALL_CLICKS', [2, 2]),
      series('BUSINESS_DIRECTION_REQUESTS', [7]),
    ] },
  ],
};
const s = summarizeInsights(payload);
check('profileViews = all four impression metrics', s.profileViews, 1 + 2 + 10 + 3 + 20 + 5);
check('searches = the search subset', s.searches, 10 + 25);
check('calls', s.calls, 4);
check('directions', s.directions, 7);
check('empty payload → zeros', summarizeInsights({}), { profileViews: 0, searches: 0, calls: 0, directions: 0, windowDays: 30 });

// ── buildLocalPost ─────────────────────────────────────────────────────────
const okStd = buildLocalPost({ topicType: 'STANDARD', summary: 'We now serve Tacoma!' });
check('STANDARD post builds', okStd.ok, true);
check('STANDARD carries languageCode + summary', [okStd.post.languageCode, okStd.post.summary], ['en-US', 'We now serve Tacoma!']);
check('unknown type rejected', buildLocalPost({ topicType: 'ALERT', summary: 'x' }).ok, false);
check('STANDARD without text rejected', buildLocalPost({ topicType: 'STANDARD' }).ok, false);
check('1501-char summary rejected', buildLocalPost({ topicType: 'STANDARD', summary: 'x'.repeat(1501) }).ok, false);
check('1500-char summary accepted', buildLocalPost({ topicType: 'STANDARD', summary: 'x'.repeat(1500) }).ok, true);

const okEvent = buildLocalPost({
  topicType: 'EVENT', summary: 'Open house', eventTitle: 'Open House',
  startDate: '2026-08-10', startTime: '17:00', endDate: '2026-08-10', endTime: '19:00',
});
check('EVENT builds with Date/TimeOfDay parts', okEvent.ok, true);
check('EVENT schedule shape', okEvent.post.event.schedule, {
  startDate: { year: 2026, month: 8, day: 10 }, endDate: { year: 2026, month: 8, day: 10 },
  startTime: { hours: 17, minutes: 0 }, endTime: { hours: 19, minutes: 0 },
});
check('EVENT without title rejected', buildLocalPost({ topicType: 'EVENT', startDate: '2026-08-10', endDate: '2026-08-11' }).ok, false);
check('EVENT without end date rejected', buildLocalPost({ topicType: 'EVENT', eventTitle: 'X', startDate: '2026-08-10' }).ok, false);
check('EVENT end before start rejected', buildLocalPost({ topicType: 'EVENT', eventTitle: 'X', startDate: '2026-08-10', endDate: '2026-08-09' }).ok, false);
check('EVENT same-day no-times accepted', buildLocalPost({ topicType: 'EVENT', eventTitle: 'X', startDate: '2026-08-10', endDate: '2026-08-10' }).ok, true);
check('garbage date rejected', buildLocalPost({ topicType: 'EVENT', eventTitle: 'X', startDate: '08/10/2026', endDate: '2026-08-11' }).ok, false);

const okCta = buildLocalPost({ topicType: 'STANDARD', summary: 'x', cta: { actionType: 'LEARN_MORE', url: 'https://cleanspace.example' } });
check('CTA builds', okCta.post.callToAction, { actionType: 'LEARN_MORE', url: 'https://cleanspace.example' });
check('CTA without url rejected', buildLocalPost({ topicType: 'STANDARD', summary: 'x', cta: { actionType: 'LEARN_MORE' } }).ok, false);
check('CALL CTA needs no url', buildLocalPost({ topicType: 'STANDARD', summary: 'x', cta: { actionType: 'CALL' } }).post.callToAction, { actionType: 'CALL' });
check('OFFER with CTA rejected (Google adds its own)', buildLocalPost({
  topicType: 'OFFER', summary: 'x', eventTitle: 'Deal', startDate: '2026-08-01', endDate: '2026-08-31',
  cta: { actionType: 'LEARN_MORE', url: 'https://x.example' },
}).ok, false);

const okOffer = buildLocalPost({
  topicType: 'OFFER', summary: '20% off first clean', eventTitle: 'First Clean Deal',
  startDate: '2026-08-01', endDate: '2026-08-31', couponCode: 'CLEAN20', redeemOnlineUrl: 'https://cleanspace.example/deal',
});
check('OFFER builds with coupon fields', [okOffer.ok, okOffer.post.offer.couponCode], [true, 'CLEAN20']);
check('coupon fields on STANDARD rejected', buildLocalPost({ topicType: 'STANDARD', summary: 'x', couponCode: 'NOPE' }).ok, false);
check('photoUrl becomes media[]', buildLocalPost({ topicType: 'STANDARD', summary: 'x', photoUrl: 'https://pub.example/p.jpg' }).post.media,
  [{ mediaFormat: 'PHOTO', sourceUrl: 'https://pub.example/p.jpg' }]);

// ── localPostToItem / mediaItemToItem ──────────────────────────────────────
const item = localPostToItem({
  name: 'accounts/1/locations/2/localPosts/9', topicType: 'STANDARD', state: 'LIVE',
  summary: 'hi', searchUrl: 'https://g/x', media: [{ googleUrl: 'https://lh3/x' }],
});
check('post item maps name/state/photo', [item.name, item.state, item.photoUrl], ['accounts/1/locations/2/localPosts/9', 'LIVE', 'https://lh3/x']);
const media = mediaItemToItem({
  name: 'accounts/1/locations/2/media/7', locationAssociation: { category: 'INTERIOR' },
  googleUrl: 'https://lh3/full', thumbnailUrl: 'https://lh3/t', insights: { viewCount: '1234' },
  dimensions: { widthPixels: 800, heightPixels: 600 },
});
check('media item maps category/views/dims', [media.category, media.viewCount, media.width, media.height], ['INTERIOR', 1234, 800, 600]);
check('media without insights → 0 views', mediaItemToItem({ name: 'x' }).viewCount, 0);

// ── validateGbpPhoto ───────────────────────────────────────────────────────
check('jpeg in range ok', validateGbpPhoto({ mimeType: 'image/jpeg', sizeBytes: 500_000 }).ok, true);
check('webp rejected (Google is JPG/PNG only)', validateGbpPhoto({ mimeType: 'image/webp', sizeBytes: 500_000 }).ok, false);
check('below 10KB floor rejected', validateGbpPhoto({ mimeType: 'image/png', sizeBytes: 9_000 }).ok, false);
check('above 10MB cap rejected', validateGbpPhoto({ mimeType: 'image/png', sizeBytes: 11_000_000 }).ok, false);

// ── keywordRowsFrom ────────────────────────────────────────────────────────
const kw = keywordRowsFrom({
  searchKeywordsCounts: [
    { searchKeyword: 'janitorial tacoma', insightsValue: { value: '182' } },
    { searchKeyword: 'office cleaning', insightsValue: { threshold: '15' } },
    { searchKeyword: 'cleanspace facility', insightsValue: {} },
    { insightsValue: { value: '9' } }, // no keyword → dropped
  ],
}, '2026-06', ORG);
check('keyword rows count (nameless dropped)', kw.length, 3);
check('exact value row', [kw[0].keyword, kw[0].impressions, kw[0].thresholded], ['janitorial tacoma', 182, false]);
check('thresholded row keeps flag', [kw[1].impressions, kw[1].thresholded], [15, true]);
check('missing insightsValue → 0 + thresholded', [kw[2].impressions, kw[2].thresholded], [0, true]);
check('rows carry month + org', [kw[0].month, kw[0].organization_id], ['2026-06', ORG]);
check('empty payload → []', keywordRowsFrom({}, '2026-06', ORG), []);

// ── computeReviewTrends ────────────────────────────────────────────────────
const trendRows = [
  { star_rating: 5, create_time: '2026-07-28T00:00:00Z', reply_comment: 'thanks' },
  { star_rating: 4, create_time: '2026-07-02T00:00:00Z', reply_comment: null },
  { star_rating: 5, create_time: '2026-05-12T00:00:00Z', reply_comment: 'appreciated' },
  { star_rating: 1, create_time: '2024-01-01T00:00:00Z', reply_comment: null }, // outside window: coverage yes, buckets no
];
const trends = computeReviewTrends(trendRows, '2026-07-31T00:00:00Z');
check('12 month buckets ending at now-month', [trends.months.length, trends.months[11].month, trends.months[0].month], [12, '2026-07', '2025-08']);
check('July bucket count + avg', [trends.months[11].count, trends.months[11].avg], [2, 4.5]);
check('May bucket', [trends.months[9].month, trends.months[9].count, trends.months[9].avg], ['2026-05', 1, 5]);
check('empty month avg is null', trends.months[10].avg, null);
check('coverage counts ALL rows incl. out-of-window', trends.replyCoverage, { replied: 2, total: 4 });
check('year boundary keys roll correctly', computeReviewTrends([], '2026-01-15T00:00:00Z').months[0].month, '2025-02');

console.log(`\ntest-gmb-mapping: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
