// Single source of truth for the inspection REPORT document — the scored QC result
// with per-section photos, in the "Scorecard" design (score gauge hero + stat tiles +
// per-section rows). One self-contained HTML string (its own <style>) so it renders
// identically in three places: the in-app report modal, the public tokened report
// (/inspect/:token), and the server-side chromium PDF (api/_lib/qc/reportPdf.js).
// Mirrors the quoteTemplate.js pattern — layout lives in one place.
//
//   buildInspectionReportHtml(report, opts) -> string
//     report: { inspection: { templateName, schema, ratingScale, siteName, clientName,
//                             inspectorName, overallScore, result, performedAt },
//               items:  [{ itemKey, label, rating, comment }],
//               photos: [{ id, kind, url, caption, areaId }] }   // url = signed URL or data: URI
//     opts:   { forPdf }   // forPdf swaps <video> for a poster <img> (a PDF can't play video)
//
// Browser-dep-free (imported by the serverless PDF route) — no window/DOM, explicit imports.
import { getOrgTimezone } from './dates.js';
import { DOC_LOGO } from '../brand/logo.js';
import { DOC, alpha } from '../brand/doc.js';
import { IDENTITY } from '../brand/identity.generated.js';

// Colours come from the brand's document palette (src/brand/doc.js): the report follows the app brand,
// so a re-skin changes it with the app. No colour literals in this file.

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Report date line — the performed_at instant in the org's zone, en-US long form with
// time, e.g. "August 4, 2026 · 9:32 PM". Rendered the same in-browser and in the PDF
// (chromium runs under UTC, so the explicit org zone keeps the day/time identical).
function fmtReportDate(iso, tz = getOrgTimezone()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  return `${date} · ${time}`;
}

// Record-level result → gauge arc colour + label. The arc is a resolved palette value (it feeds an
// SVG stroke attribute, which can't read a CSS var); the label colour is class-driven.
function resultMeta(result) {
  if (result === 'pass') return { cls: 'pass', label: 'Pass', arc: DOC.good };
  if (result === 'fail') return { cls: 'fail', label: 'Fail', arc: DOC.bad };
  if (result === 'needs_follow_up') return { cls: 'follow', label: 'Needs follow-up', arc: DOC.warn };
  return { cls: 'draft', label: 'Draft', arc: DOC.line };
}

// A single item's rating → { cls, text }. pass/fail/na are the fixed vocabulary; a
// numeric scale renders "4 / 5" against the frozen max; an unrated item shows a dash.
function ratingInfo(rating, scale) {
  if (rating == null || rating === '') return { cls: 'none', text: '—' };
  if (rating === 'pass') return { cls: 'pass', text: 'Pass' };
  if (rating === 'fail') return { cls: 'fail', text: 'Fail' };
  if (rating === 'na') return { cls: 'na', text: 'N/A' };
  const max = scale && Number.isFinite(scale.max) ? scale.max : null;
  return { cls: 'num', text: max ? `${esc(rating)} / ${max}` : esc(rating) };
}

function photoCard(p, forPdf) {
  const cap = p.caption ? `<figcaption class="ir-cap">${esc(p.caption)}</figcaption>` : '';
  // On screen a video plays inline; in the PDF it can only be a poster image (the
  // renderer inlines the thumbnail as the url and drops videos that have none).
  if (!forPdf && p.kind === 'video') {
    return `<figure class="ir-photo"><video class="ir-media" src="${esc(p.url)}" controls preload="metadata"></video>${cap}</figure>`;
  }
  const badge = p.kind === 'video' ? '<span class="ir-vidtag">▶ Video</span>' : '';
  return `<figure class="ir-photo"><img class="ir-media" src="${esc(p.url)}" alt="${esc(p.caption || 'Inspection photo')}" loading="lazy" />${badge}${cap}</figure>`;
}

function photoGrid(photos, forPdf) {
  if (!photos || !photos.length) return '';
  return `<div class="ir-photos">${photos.map((p) => photoCard(p, forPdf)).join('')}</div>`;
}

const CSS = `
.ir{--doc-brand:${DOC.brand};--doc-good:${DOC.good};--doc-good-ink:${DOC.goodInk};--doc-ink:${DOC.ink};--doc-muted:${DOC.muted};--doc-line:${DOC.line};
  max-width:8.5in;margin:0 auto;background:${DOC.paper};color:var(--doc-ink);
  font-family:'Helvetica Neue',Arial,sans-serif;font-size:11pt;line-height:1.5;}
.ir *{box-sizing:border-box;}
.ir-hd{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 34px 14px;}
.ir-logo{height:60px;width:auto;display:block;}
.ir-kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--doc-muted);font-weight:700;margin-top:12px;white-space:nowrap;}
.ir-hero{display:flex;gap:24px;align-items:center;padding:2px 34px 20px;border-bottom:1px solid var(--doc-line);}
.ir-gauge{position:relative;width:128px;height:128px;flex:none;}
.ir-gauge svg{display:block;}
.ir-gauge-t{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;}
.ir-gauge-t b{font-size:26px;font-weight:800;color:var(--doc-brand);}
.ir-gauge-r{font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-top:5px;max-width:78px;text-align:center;line-height:1.2;}
.ir-gauge-r.pass{color:var(--doc-good-ink);}
.ir-gauge-r.fail{color:${DOC.badInk};}
.ir-gauge-r.follow{color:${DOC.warnInk};}
.ir-gauge-r.draft{color:var(--doc-muted);}
.ir-hero-b{min-width:0;}
.ir-hero-b h1{margin:0;font-size:21px;color:var(--doc-ink);letter-spacing:-.01em;line-height:1.15;}
.ir-where{margin:6px 0 1px;font-weight:600;color:${DOC.pen};font-size:13px;}
.ir-when{margin:0;color:var(--doc-muted);font-size:11px;}
.ir-stats{display:flex;gap:12px;margin-top:13px;}
.ir-tile{width:74px;height:74px;flex:none;background:${DOC.wash};border:1px solid var(--doc-line);border-radius:9px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;}
.ir-tile b{font-size:21px;color:var(--doc-brand);line-height:1;margin-bottom:4px;}
.ir-tile span{font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--doc-muted);font-weight:700;}
.ir-tile.flag b{color:${DOC.bad};}
.ir-sec{padding:15px 34px 6px;}
.ir-sec-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.ir-sec-h h2{margin:0;font-size:14px;color:var(--doc-brand);font-weight:800;break-after:avoid;}
.ir-chip{font-size:11px;font-weight:700;color:var(--doc-muted);background:${DOC.soft};border-radius:999px;padding:3px 11px;}
.ir-row{display:flex;align-items:flex-start;gap:11px;padding:6px 0;border-bottom:1px solid ${DOC.soft};break-inside:avoid;}
.ir-row:last-child{border-bottom:0;}
.ir-dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:5px;}
.ir-dot.pass{background:var(--doc-good);}
.ir-dot.fail{background:${DOC.bad};}
.ir-dot.na,.ir-dot.none{background:${DOC.line};}
.ir-dot.num{background:var(--doc-brand);}
.ir-item{flex:1;font-size:12px;}
.ir-cmt{display:block;font-style:italic;color:var(--doc-muted);font-size:10.5px;margin-top:2px;}
.ir-rate{font-weight:700;font-size:11px;white-space:nowrap;}
.ir-rate.pass{color:var(--doc-good-ink);}
.ir-rate.fail{color:${DOC.badInk};}
.ir-rate.na,.ir-rate.none{color:${DOC.muted};}
.ir-rate.num{color:var(--doc-brand);}
.ir-empty{color:${DOC.muted};font-style:italic;font-size:11px;padding:4px 0;}
.ir-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin:11px 0 4px;}
.ir-photo{margin:0;border-radius:9px;overflow:hidden;box-shadow:0 2px 9px ${alpha(DOC.ink, 0.13)};break-inside:avoid;position:relative;background:${DOC.wash};}
.ir-media{display:block;width:100%;height:150px;object-fit:cover;}
.ir-vidtag{position:absolute;top:6px;left:6px;background:${alpha(DOC.ink, 0.78)};color:${DOC.paper};font-size:8.5px;font-weight:700;padding:2px 7px;border-radius:5px;}
.ir-cap{font-size:9.5px;color:${DOC.muted};padding:5px 8px;background:${DOC.paper};}
.ir-foot{margin-top:14px;border-top:1px solid var(--doc-line);padding:11px 34px;color:${DOC.muted};font-size:9px;text-align:center;}
@media print{.ir{max-width:none;}}
`;

// Build the full report document as a self-contained HTML string.
export function buildInspectionReportHtml(report = {}, opts = {}) {
  const { forPdf = false } = opts;
  const ins = report.inspection || {};
  const scale = ins.ratingScale || ins.rating_scale || null;
  const numericScale = !!(scale && scale.type === 'numeric');
  const areas = ins.schema?.areas || [];
  const items = report.items || [];
  const photos = report.photos || [];
  const byKey = Object.fromEntries(items.map((i) => [i.itemKey, i]));

  // Roll up item ratings for the stat tiles. Numeric ratings count as "scored".
  let pass = 0; let fail = 0; let na = 0; let scored = 0;
  for (const it of items) {
    const r = it.rating;
    if (r === 'pass') { pass += 1; scored += 1; }
    else if (r === 'fail') { fail += 1; scored += 1; }
    else if (r === 'na') { na += 1; }
    else if (r != null && r !== '') { scored += 1; }
  }

  // Bucket photos under their section; anything with no/unknown areaId falls to "Additional".
  const areaIds = new Set(areas.map((a) => a.id));
  const byArea = new Map();
  const other = [];
  for (const p of photos) {
    if (p.areaId && areaIds.has(p.areaId)) {
      if (!byArea.has(p.areaId)) byArea.set(p.areaId, []);
      byArea.get(p.areaId).push(p);
    } else {
      other.push(p);
    }
  }

  const res = resultMeta(ins.result);
  const scoreText = ins.overallScore != null ? `${esc(ins.overallScore)}%` : '—';
  const R = 54; const CIRC = 2 * Math.PI * R;
  const on = ins.overallScore != null ? (Math.max(0, Math.min(100, Number(ins.overallScore))) / 100) * CIRC : 0;
  const off = CIRC - on;
  const gauge = `<div class="ir-gauge">
    <svg viewBox="0 0 130 130" width="128" height="128">
      <circle cx="65" cy="65" r="${R}" fill="none" stroke="${DOC.divider}" stroke-width="12"/>
      ${ins.overallScore != null ? `<circle cx="65" cy="65" r="${R}" fill="none" stroke="${res.arc}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${on.toFixed(1)} ${off.toFixed(1)}" transform="rotate(-90 65 65)"/>` : ''}
    </svg>
    <div class="ir-gauge-t"><b>${scoreText}</b><span class="ir-gauge-r ${res.cls}">${res.label}</span></div>
  </div>`;

  const tiles = numericScale
    ? [[scored, 'Rated'], [na, 'N/A']]
    : [[pass, 'Passed'], [fail, 'Flagged'], [na, 'N/A']];
  const statsHtml = `<div class="ir-stats">${tiles.map(([n, l]) =>
    `<div class="ir-tile${l === 'Flagged' && n > 0 ? ' flag' : ''}"><b>${n}</b><span>${l}</span></div>`).join('')}</div>`;

  const areaBlocks = areas.map((area) => {
    let sp = 0; let ss = 0;
    const rows = (area.items || []).map((it) => {
      const ans = byKey[it.id] || {};
      const info = ratingInfo(ans.rating, scale);
      if (ans.rating === 'pass') { sp += 1; ss += 1; }
      else if (ans.rating === 'fail') { ss += 1; }
      else if (ans.rating != null && ans.rating !== '' && ans.rating !== 'na') { ss += 1; }
      const comment = ans.comment ? `<em class="ir-cmt">${esc(ans.comment)}</em>` : '';
      return `<div class="ir-row"><span class="ir-dot ${info.cls}"></span><span class="ir-item">${esc(it.label || 'Item')}${comment}</span><span class="ir-rate ${info.cls}">${info.text}</span></div>`;
    }).join('');
    const chip = (!numericScale && ss > 0) ? `<span class="ir-chip">${sp} / ${ss}</span>` : '';
    return `<section class="ir-sec">
      <div class="ir-sec-h"><h2>${esc(area.label || 'Area')}</h2>${chip}</div>
      ${rows ? `<div class="ir-rows">${rows}</div>` : '<div class="ir-empty">No items recorded.</div>'}
      ${photoGrid(byArea.get(area.id), forPdf)}
    </section>`;
  }).join('');

  const otherBlock = other.length
    ? `<section class="ir-sec"><div class="ir-sec-h"><h2>Additional photos</h2></div>${photoGrid(other, forPdf)}</section>`
    : '';

  const where = [ins.clientName].filter(Boolean).map(esc).join(' · ') || '—';
  const metaBits = [
    ins.performedAt ? fmtReportDate(ins.performedAt) : null,
    ins.inspectorName ? `Inspected by ${esc(ins.inspectorName)}` : null,
  ].filter(Boolean).join(' · ');

  const body = `
<div class="ir">
  <header class="ir-hd">
    <img class="ir-logo" src="${DOC_LOGO}" alt="${esc(IDENTITY.name)}" />
    <span class="ir-kicker">Quality Inspection</span>
  </header>
  <section class="ir-hero">
    ${gauge}
    <div class="ir-hero-b">
      <h1>${esc(ins.templateName || 'Inspection')}</h1>
      <p class="ir-where">${where}</p>
      ${metaBits ? `<p class="ir-when">${metaBits}</p>` : ''}
      ${statsHtml}
    </div>
  </section>
  ${areaBlocks || '<section class="ir-sec"><div class="ir-empty">This inspection has no sections.</div></section>'}
  ${otherBlock}
  <footer class="ir-foot">${esc(IDENTITY.name)}&nbsp; ·&nbsp; Quality Inspection Report</footer>
</div>`;

  return `<style>${CSS}</style>${body}`;
}

// Running header/footer for chromium's headerTemplate/footerTemplate (PDF only). The
// page-1 letterhead (logo) IS the header, so the running header is intentionally empty
// — only the footer repeats, carrying the brand line + live page numbers (chromium's
// pageNumber/totalPages classes).
export const REPORT_PRINT_HEADER = '<div></div>';
export const REPORT_PRINT_FOOTER =
  `<div style="width:100%;font:8pt 'Helvetica Neue',Arial,sans-serif;color:${DOC.muted};padding:0 40px;display:flex;justify-content:space-between;">`
  + `<span>${esc(IDENTITY.name)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
