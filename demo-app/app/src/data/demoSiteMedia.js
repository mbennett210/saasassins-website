// Demo placeholder SITE PHOTOS + VIDEO stand-ins. In demo mode the account-media API
// keeps bytes as data URLs in localStorage (see app/src/lib/accountMediaApi.js — stub
// store); the account Photos tab, the crew's read-only "Reference photos" on a job,
// and a job's "Before / after photos" all read from it. That store starts EMPTY, so
// this seeds self-contained SVG placeholders (no network, so a pitch works offline):
// REFERENCE shots (scope 'cleaning_instruction', per site → the Photos tab) plus
// BEFORE/AFTER shots on one completed clean (scope 'clean', keyed to the job id →
// that job's detail). Written by demoBootstrap.ensureDemoData(), then persisted. Light
// illustrations on purpose — clearly stand-ins, not real Clean Space sites.
import { seedId } from '../lib/ids';

// The localStorage key accountMediaApi's demo stub reads. Mirror of its private
// STUB_KEY — keep in lockstep if that ever changes.
export const MEDIA_STUB_KEY = 'cleanspace_account_media_stub_v1';

const enc = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const FONT = 'font-family="system-ui,Segoe UI,Arial,sans-serif"';

// Grid of little rectangles — reused for building windows.
function grid(x, y, cols, rows, w, h, gap, fill) {
  let s = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      s += `<rect x="${x + c * (w + gap)}" y="${y + r * (h + gap)}" width="${w}" height="${h}" rx="2" fill="${fill}"/>`;
    }
  }
  return s;
}
// Caption ribbon along the bottom.
const label = (t) => `<rect x="0" y="250" width="400" height="50" fill="rgba(15,23,42,0.5)"/>`
  + `<text x="16" y="283" ${FONT} font-size="19" font-weight="600" fill="#ffffff">${t}</text>`;

const SCENES = {
  exterior: (t) => enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">`
    + `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#93c5fd"/><stop offset="1" stop-color="#dbeafe"/></linearGradient></defs>`
    + `<rect width="400" height="300" fill="url(#sky)"/>`
    + `<circle cx="338" cy="52" r="28" fill="#fef08a"/>`
    + `<rect y="214" width="400" height="86" fill="#86efac"/>`
    + `<rect x="54" y="98" width="150" height="128" fill="#e2e8f0"/><rect x="54" y="98" width="150" height="16" fill="#64748b"/>`
    + grid(72, 126, 3, 3, 30, 22, 10, '#38bdf8')
    + `<rect x="112" y="188" width="34" height="38" fill="#6d28d9"/>`
    + `<rect x="222" y="134" width="118" height="92" fill="#cbd5e1"/><rect x="222" y="134" width="118" height="14" fill="#64748b"/>`
    + grid(238, 158, 3, 2, 26, 22, 10, '#0ea5e9')
    + label(t) + `</svg>`),
  lobby: (t) => enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">`
    + `<rect width="400" height="300" fill="#e7e5e4"/>`
    + `<rect y="200" width="400" height="100" fill="#d6d3d1"/>`
    + `<rect x="40" y="112" width="150" height="82" fill="#cbd5e1" stroke="#94a3b8" stroke-width="3"/>`
    + `<circle cx="300" cy="58" r="9" fill="#fde68a"/><circle cx="338" cy="58" r="9" fill="#fde68a"/>`
    + `<rect x="228" y="150" width="132" height="50" rx="6" fill="#0f766e"/><rect x="228" y="150" width="132" height="14" rx="6" fill="#115e59"/>`
    + `<rect x="70" y="150" width="12" height="50" fill="#166534"/><circle cx="76" cy="146" r="22" fill="#22c55e"/>`
    + label(t) + `</svg>`),
  pool: (t) => enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">`
    + `<rect width="400" height="300" fill="#bae6fd"/>`
    + `<rect y="110" width="400" height="60" fill="#e7e5e4"/>`
    + `<rect y="170" width="400" height="130" fill="#38bdf8"/>`
    + `<path d="M0 192 Q100 180 200 192 T400 192" stroke="#7dd3fc" stroke-width="4" fill="none"/>`
    + `<path d="M0 222 Q100 210 200 222 T400 222" stroke="#7dd3fc" stroke-width="4" fill="none"/>`
    + `<rect x="298" y="120" width="72" height="12" rx="6" fill="#f59e0b"/>`
    + `<rect x="300" y="132" width="12" height="26" fill="#b45309"/><rect x="356" y="132" width="12" height="26" fill="#b45309"/>`
    + label(t) + `</svg>`),
  corridor: (t) => enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">`
    + `<rect width="400" height="300" fill="#e2e8f0"/>`
    + `<polygon points="0,0 400,0 300,90 100,90" fill="#f1f5f9"/>`
    + `<polygon points="0,300 400,300 300,210 100,210" fill="#cbd5e1"/>`
    + `<polygon points="0,0 100,90 100,210 0,300" fill="#94a3b8"/>`
    + `<polygon points="400,0 300,90 300,210 400,300" fill="#94a3b8"/>`
    + `<rect x="132" y="112" width="136" height="88" fill="#dbeafe"/>`
    + `<rect x="150" y="132" width="38" height="68" fill="#6d28d9" opacity="0.7"/>`
    + `<rect x="212" y="132" width="38" height="68" fill="#6d28d9" opacity="0.7"/>`
    + label(t) + `</svg>`),
};

const daysAgoIso = (n) => new Date(Date.now() - n * 86400000).toISOString();

let seq = 0;
function photo(siteKey, clientKey, scene, caption, ageDays, { scope = 'cleaning_instruction', refKey = null } = {}) {
  const iso = daysAgoIso(ageDays);
  seq += 1;
  return {
    id: `am_seed_${seq}`,
    site_id: seedId('st', siteKey),
    client_id: seedId('cl', clientKey),
    // scope 'cleaning_instruction' = account reference photos (Photos tab); scope
    // 'clean' + ref_id (a job id) = that clean's before/after shots on the job.
    scope, area_id: null, ref_id: refKey ? seedId('j', refKey) : null,
    kind: 'image', mimeType: 'image/svg+xml', sizeBytes: 42000 + seq * 900,
    caption, url: SCENES[scene](caption),
    createdAt: iso, created_at: iso,
  };
}

// A few sites carry photos (varied counts), the rest stay empty — so the glance
// "Photos #" column shows both filled and gap states.
export function buildDemoSiteMedia() {
  seq = 0;
  return {
    media: [
      // Coral Bay HOA
      photo('mtb-clbhs', 'mtbaker', 'exterior', 'Clubhouse entrance', 12),
      photo('mtb-clbhs', 'mtbaker', 'lobby', 'Main lobby', 9),
      photo('mtb-clbhs', 'mtbaker', 'corridor', 'East corridor', 4),
      photo('mtb-clbhs', 'mtbaker', 'pool', 'Pool deck', 8),
      photo('mtb-clbhs', 'mtbaker', 'exterior', 'Pool house', 3),
      // Las Olas Medical Group
      photo('evgrn-main', 'evergreen', 'exterior', 'Main entrance', 15),
      photo('evgrn-main', 'evergreen', 'lobby', 'Reception', 10),
      photo('evgrn-main', 'evergreen', 'corridor', 'Ward corridor', 6),
      photo('evgrn-main', 'evergreen', 'lobby', 'Waiting room', 5),
      // Palmetto Ridge Corp
      photo('pac-tower', 'pacridge', 'lobby', 'Tower A lobby', 7),
      photo('pac-tower', 'pacridge', 'corridor', 'Elevator bank', 2),
      // Before / after — a completed Las Olas clean (scope 'clean', keyed to the job
      // evgrn-w1). These show on THAT JOB's "Before / after photos", not the account
      // Photos tab (which reads the 'cleaning_instruction' set above).
      photo('evgrn-main', 'evergreen', 'lobby',    'Before — reception',     1, { scope: 'clean', refKey: 'evgrn-w1' }),
      photo('evgrn-main', 'evergreen', 'lobby',    'After — reception',      1, { scope: 'clean', refKey: 'evgrn-w1' }),
      photo('evgrn-main', 'evergreen', 'corridor', 'Before — ward corridor', 1, { scope: 'clean', refKey: 'evgrn-w1' }),
      photo('evgrn-main', 'evergreen', 'corridor', 'After — ward corridor',  1, { scope: 'clean', refKey: 'evgrn-w1' }),
    ],
  };
}
