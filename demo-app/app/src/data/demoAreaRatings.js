// The demo's visitor ratings (QR-30): a week of thumbs on Coral Bay HOA's three Clubhouse areas —
// the demo's QR-coded areas (data/demoScanCodes.js) — so Reports → Visitor ratings shows a building
// with a mixed record on a fresh demo: the lobby liked, the restrooms not, the floors in between.
// Rows are shaped EXACTLY like backend `area_scan_ratings` rows; each phone is a fixed stand-in for
// the server's HMAC (43 URL-safe characters). Placed relative to `nowMs`, each vote on the ORG's day
// `dayOf(ms)` gives it, so the week never goes stale.
//
// 🔴 A FUNCTION, NOT A CONSTANT, AND IMPORTED ONLY BY lib/scanCodesApi's DEMO BRANCH — the reason
// data/demoScanCodes.js gives: with nothing at this module's top level but declarations, a
// production build drops these rows with that branch (check-bundle-stubs.mjs `scan-demo-ratings`).
import { seedId } from '../lib/ids';

export function demoAreaRatings({ nowMs = Date.now(), dayOf } = {}) {
  const siteId = seedId('st', 'mtb-clbhs');
  const clientId = seedId('cl', 'mtbaker');
  const DAY = 24 * 3600 * 1000;
  const phone = (n) => `demoRatingPhone${String(n).padStart(28, '0')}`;
  // [area, value, days ago, phone]
  const votes = [
    ['area_lobby', 1, 0, 1], ['area_lobby', 1, 1, 2], ['area_lobby', 1, 2, 3], ['area_lobby', 1, 3, 4],
    ['area_lobby', -1, 4, 5], ['area_lobby', 1, 5, 6],
    ['area_rest', -1, 0, 7], ['area_rest', -1, 1, 8], ['area_rest', 1, 2, 9], ['area_rest', -1, 3, 10],
    ['area_rest', -1, 5, 11],
    ['area_floors', 1, 1, 12], ['area_floors', -1, 2, 13], ['area_floors', 1, 4, 14],
  ];
  return votes.map(([areaId, value, ago, n]) => {
    const at = nowMs - ago * DAY - 3 * 3600 * 1000;
    const stamp = new Date(at).toISOString();
    return {
      id: `ar_demo_${n}`,
      code_id: `sc_demo_${areaId}`,
      site_id: siteId,
      client_id: clientId,
      area_id: areaId,
      value,
      device_hash: phone(n),
      day: typeof dayOf === 'function' ? dayOf(at) : stamp.slice(0, 10),
      created_at: stamp,
      updated_at: stamp,
    };
  });
}
