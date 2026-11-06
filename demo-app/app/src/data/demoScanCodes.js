// The demo's QR codes (QR-6): one for each of Coral Bay HOA's three Clubhouse areas — Round
// 1's demo areas, which data/demoStubs.js seeds as one area cleaned a few hours ago, one last
// cleaned more than a day ago (read the same calm way since QR-28) and one never cleaned — so
// `/scan/<token>` on the login-free demo shows all three answers a code on a wall can give.
//
// Rows are shaped EXACTLY like backend `area_scan_codes` rows. The tokens are fixed so a
// link to them keeps working across ?demo=reset (scripts/app-routes.mjs sweeps all three),
// and they are well-formed (32 URL-safe characters) so they pass the same shape check a real
// one does.
//
// 🔴 A FUNCTION, NOT A CONSTANT, AND IMPORTED ONLY BY lib/scanCodesApi's DEMO BRANCH. That
// branch is dead in a production build (a static `import.meta.env.MODE` gate), and with
// nothing at this module's top level but declarations, the bundler drops the rows with it:
// a top-level `Object.freeze([...])` is a call it cannot prove pure, and it kept these tokens
// in the shipped bundle until check-bundle-stubs.mjs (scan-demo-codes) caught it.
import { seedId } from '../lib/ids';

export function demoScanCodes() {
  const siteId = seedId('st', 'mtb-clbhs');
  const row = (areaId, token) => ({
    id: `sc_demo_${areaId}`,
    site_id: siteId,
    area_id: areaId,
    token,
    created_at: '2026-10-01T12:00:00.000Z',
    created_by: null,
    revoked_at: null,
    revoked_by: null,
  });
  return [
    row('area_lobby', 'demoCoralBayLobby000000000000001'),
    row('area_rest', 'demoCoralBayRestrooms00000000001'),
    row('area_floors', 'demoCoralBayFloors00000000000001'),
  ];
}
