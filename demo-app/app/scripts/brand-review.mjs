#!/usr/bin/env node
// brand-review — a brand pack's review page, rendered before anyone applies it (UI_RULES §121, §129).
//
//   npm --prefix app run brand:review -- <id> [--out <file>]
//       writes brands/<id>/review.html (git-ignored): the identity and the logos, the palette (each step
//       derived or pinned), the contrast law with every ratio, the key controls in the palette, and the real
//       quote (its pages in the pack's own words, quote.html), inspection report and sign-request email
//       rendered in the brand.
//
// Nothing on disk changes: the brand's identity and resolved colours are swapped into the app's modules in
// memory (the same load hook test-name-ledger.mjs uses), so the documents are the app's own templates.
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBrand, identityText, quoteText, readQuote, paletteTarget, BRANDS } from './brand.mjs';
import { derivePalette, contrastChecks, channels } from './brand-colors.mjs';
import { buildBrandJs } from './brand-js.mjs';
import { renderBrandImages, renderDocLogo, docLogoModule, logoGrounds, LOGO_GROUND_CONTRAST } from './gen-brand-images.mjs';
import { readCascade } from './design-system-lib.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The review page's HTML for a brand (and the brand's resolved BRAND colours). */
export async function buildReview(brand) {
  const { values, derived, pinned } = derivePalette(brand.colors);
  const checks = contrastChecks(values);
  // the candidate cascade: the client theme with this brand's palette, resolved as brand:js resolves it
  const palette = paletteTarget(brand);
  if (palette.error) throw new Error(palette.error);
  const { text: brandJs, colors: B, errors } = buildBrandJs({ 'theme-cleanspace.css': palette.target[2] });
  if (errors.length) throw new Error(errors.join('; '));

  // the app's own templates, with this brand's identity and colours swapped in
  const IDENTITY_URL = pathToFileURL(path.join(APP, 'src', 'brand', 'identity.generated.js')).href;
  const TOKENS_URL = pathToFileURL(path.join(APP, 'src', 'brand', 'tokens.generated.js')).href;
  const QUOTE_URL = pathToFileURL(path.join(APP, 'src', 'brand', 'quote.generated.js')).href;
  const LOGO_GEN_URL = pathToFileURL(path.join(APP, 'src', 'brand', 'logo.generated.js')).href;
  // the letterhead the documents show: this pack's colour logo (logos.lockup.color) if it has one, else null →
  // the generated monogram. Computed here (async) so the sync load hook can serve it.
  const docLogoModuleText = docLogoModule(await renderDocLogo(brand));
  registerHooks({
    resolve(spec, ctx, next) {
      try { return next(spec, ctx); } catch (e) {
        if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec)) for (const ext of ['.js', '.jsx', '/index.js']) { try { return next(spec + ext, ctx); } catch { /* next */ } }
        throw e;
      }
    },
    load(url, ctx, next) {
      if (url === IDENTITY_URL) return { format: 'module', source: identityText(brand), shortCircuit: true };
      if (url === TOKENS_URL) return { format: 'module', source: brandJs, shortCircuit: true };
      if (url === QUOTE_URL) return { format: 'module', source: quoteText(brand, readQuote(brand.id)), shortCircuit: true };
      if (url === LOGO_GEN_URL) return { format: 'module', source: docLogoModuleText, shortCircuit: true };
      const r = next(url, ctx);
      if (/\/app\/src\//.test(url) && r.source && String(r.source).includes('import.meta.env')) r.source = `if (!import.meta.env) import.meta.env = { MODE: 'review', PROD: false, DEV: true };\n${r.source}`;
      return r;
    },
  });
  const imp = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);
  const { buildQuoteHtml } = await imp('src', 'lib', 'quoteTemplate.js');
  const { buildInspectionReportHtml } = await imp('src', 'lib', 'inspectionReportTemplate.js');
  const quote = buildQuoteHtml({ clientName: 'Northside Auto Group', contactName: 'Morgan Hayes', restrooms: '4', amount: '1160', frequency: '5x/week' }, {});
  const report = buildInspectionReportHtml({
    inspection: { templateName: 'Monthly quality walk', clientName: 'Northside Auto Group', inspectorName: 'Kyler Nguyen', performedAt: '2026-09-22T15:00:00Z', result: 'pass', overallScore: 92,
      schema: { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Floors' }, { id: 'i2', label: 'Glass' }] }] } },
    items: [{ itemKey: 'i1', rating: 'pass' }, { itemKey: 'i2', rating: 'fail', comment: 'Streaks on the east doors' }], photos: [],
  }, {});
  let email = null;
  if (fs.existsSync(path.join(APP, 'api'))) {
    const { signRequestEmail } = await imp('api', '_lib', 'quotes', 'emails.js');
    email = signRequestEmail({ quote: { contact_name: 'Morgan Hayes', fields: { companyName: 'Northside Auto Group' } }, link: `${brand.appUrl}/quote/SAMPLE` });
  }
  const grounds = logoGrounds(new Map(readCascade({ 'theme-cleanspace.css': palette.target[2] }).map((r) => [r.name, r.resolved])));
  const rendered = await renderBrandImages(brand, { primary: B.primary, primaryDeep: B.primaryDeep, onPrimary: B.onPrimary }, { grounds });
  const logoDecision = rendered.logoDecision;
  const images = Object.fromEntries(rendered.map(([file, buf]) => [file, `data:image/png;base64,${buf.toString('base64')}`]));

  const c = brand.company;
  const ratios = (d) => d.grounds.map((g) => `${g.ratio}:1 on ${g.label}`).join(', ');
  const logoNote = logoDecision
    ? (logoDecision.color
      ? `the client's colour logo — reads at ${ratios(logoDecision)} (≥ ${LOGO_GROUND_CONTRAST}:1 graphics floor)`
      : `the white knock-out — the colour logo reads only ${ratios(logoDecision)}, below the ${LOGO_GROUND_CONTRAST}:1 graphics floor`)
    : 'the white knock-out (the pack has no logos.lockup.color)';
  const swatch = (key) => {
    const v = values[key];
    const isPin = pinned.includes(key);
    const onDark = checksContrast(v) < 4.5;
    return `<div class="sw"><div class="chip" style="background:${v};color:${onDark ? '#fff' : '#111'}">${esc(key.replace(/^(neutral|primary|secondary)-/, ''))}</div><div class="meta"><b>${esc(key)}</b><code>${v}</code><span class="${isPin ? 'pin' : 'der'}">${isPin ? `pinned${derived[key] && derived[key].toLowerCase() !== v.toLowerCase() ? ` (derived ${derived[key]})` : ''}` : 'derived'}</span></div></div>`;
  };
  const group = (title, re) => `<h3>${title}</h3><div class="ramp">${[...Object.keys(values)].filter((k) => re.test(k)).map(swatch).join('')}</div>`;
  const rows = checks.map((k) => `<tr class="${k.pass ? '' : 'fail'}"><td>${esc(k.name)}</td><td><span class="sample" style="color:${k.fg};background:${k.bg}">Aa ${esc(brand.shortName)}</span></td><td class="num">${k.ratio.toFixed(2)}:1</td><td class="num">${k.floor}:1</td><td>${esc(k.rule)}</td><td>${k.pass ? '✓ pass' : '✗ FAIL'}</td></tr>`).join('');
  const passed = checks.filter((k) => k.pass).length;
  const v = values;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brand review: ${esc(brand.name)}</title>
<style>
:root{--ink:${v['neutral-900']};--muted:${v['neutral-600']};--line:${v.border};--page:${v['surface-page']};--well:${v['surface-sunken']};--primary:${v['primary-500']};--primary-rgb:${channels(v['primary-500'])};--accent:${v['secondary-500']};--accent-rgb:${channels(v['secondary-500'])};--link:${v.link};--field:${v.field};--zebra:${v.zebra}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--ink);background:var(--page)}
header{background:${v['primary-700']};color:#fff;padding:20px 24px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
header img.lockup{max-height:40px;max-width:100%}header .icons{display:flex;gap:12px;align-items:center;margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:16px}section{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:16px 0}
h1{font-size:20px;margin:0}h2{font-size:17px;margin:0 0 10px}h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 8px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 18px}.summary div{overflow-wrap:anywhere}.summary b{display:block;font-size:12px;color:var(--muted);font-weight:600}
.verdict{font-weight:700}.ok{color:#047857}.bad{color:#b91c1c}
.ramp{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.sw{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}.chip{height:46px;display:flex;align-items:flex-end;padding:4px 8px;font-weight:600;font-size:12px}
.meta{padding:6px 8px;font-size:12px;display:flex;flex-direction:column}.meta code{font-size:12px}.pin{color:#92400e}.der{color:var(--muted)}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line)}
table.checks tr.fail td{background:#fef2f2}.num{font-variant-numeric:tabular-nums;white-space:nowrap}.sample{padding:3px 8px;border-radius:4px;font-weight:600;white-space:nowrap}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.btn{height:32px;padding:0 14px;border-radius:8px;font:600 13px system-ui,sans-serif;border:1px solid transparent;cursor:pointer}
.btn-primary{background:var(--primary);color:#fff}.btn-cta{background:var(--accent);color:var(--primary)}.btn-neutral{background:#fff;color:var(--ink);border-color:var(--line)}
.field{height:40px;padding:0 12px;border-radius:8px;border:1px solid ${v['primary-400']};background:var(--field);font:14px system-ui,sans-serif;color:var(--ink)}
.field.focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.6);outline:none}
.band th{background:var(--primary);color:#fff;text-transform:uppercase;font-size:11px;letter-spacing:.05em}.band tr:nth-child(odd) td{background:var(--zebra)}.band tr.hover td{background:rgba(var(--accent-rgb),.18)}
.ladder{display:flex;gap:0;border-radius:10px;overflow:hidden;border:1px solid var(--line)}.ladder div{flex:1;padding:18px 12px;font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;color:#fff;font-size:12px;font-weight:600}
.frames{display:grid;grid-template-columns:1fr;gap:14px}.frames h3{margin:4px 0 0}iframe{width:100%;height:720px;border:1px solid var(--line);border-radius:8px;background:#fff}
a{color:var(--link)}
@media (max-width:640px){header{padding:16px}main{padding:8px}section{padding:14px}}
</style></head><body>
<header><img class="lockup" src="${images['cleanspace-logo.png']}" alt="${esc(brand.name)} logo on the brand ink">
<div class="icons"><img src="${images['icon-192.png']}" width="56" height="56" alt="app icon"><img src="${images['favicon.png']}" width="24" height="24" alt="favicon"><span style="background:${v['secondary-500']};border-radius:8px;padding:6px"><img src="${images['cleanspace-glyph-ink.png']}" height="26" alt="phone nav mark"></span></div></header>
<main>
<section><h1>${esc(brand.name)} <span class="verdict ${passed === checks.length ? 'ok' : 'bad'}">${passed === checks.length ? `· ready to apply: all ${checks.length} contrast checks pass` : `· not ready: ${checks.length - passed} of ${checks.length} contrast checks fail`}</span></h1>
<p>brands/${esc(brand.id)}/brand.json · apply with <code>npm --prefix app run brand -- ${esc(brand.id)}</code></p>
<div class="summary">
<div><b>App title</b>${esc(brand.appTitle)}</div><div><b>Wordmark / short name / monogram</b>${esc(brand.wordmark)} / ${esc(brand.shortName)} / ${esc(brand.monogram)}</div>
<div><b>App URL</b>${esc(brand.appUrl)}</div><div><b>Company</b>${esc(c.website)} · ${esc(c.email)} · ${esc(c.phone)}</div>
<div><b>Address</b>${esc(c.street)}, ${esc(c.city)}</div><div><b>Tagline · services</b>${esc(c.tagline)} · ${esc(c.services)}</div>
<div><b>Signatory</b>${esc(c.signatory.name)}, ${esc(c.signatory.title)} (${esc(c.signatory.email)})</div><div><b>Senders</b>${esc(brand.email.quotesFrom)}<br>${esc(brand.email.authFrom)}</div>
<div><b>Sidebar &amp; login logo</b>${esc(logoNote)}</div>
</div></section>
<section><h2>Contrast (THEME_CLEANSPACE R1–R7, UI_RULES §119)</h2><div class="table-wrap"><table class="checks"><tr><th>Check</th><th>Sample</th><th>Ratio</th><th>Floor</th><th>Rule</th><th></th></tr>${rows}</table></div></section>
<section><h2>Palette</h2><p>Base colours: primary <code>${brand.colors.primary}</code>, secondary <code>${brand.colors.secondary}</code>, link <code>${brand.colors.link}</code>, neutral <code>${brand.colors.neutral}</code>. ${pinned.length} of ${Object.keys(values).length} steps pinned.</p>
${group('Primary: the brand ink', /^primary-/)}${group('Secondary: the accent', /^secondary-/)}${group('Neutral', /^neutral-/)}${group('Surfaces, lines, link and the upcoming card', /^(surface-|border$|field$|zebra$|bubble$|link$|upcoming-)/)}</section>
<section><h2>Controls</h2>
<div class="controls"><button class="btn btn-primary">Save</button><button class="btn btn-cta">Get a quote</button><button class="btn btn-neutral">Cancel</button>
<input class="field" value="A field"><input class="field focus" value="Focused"><span>A <a href="#">link to a client</a> in text.</span></div>
<h3>A data table: the header band, the zebra, the accent hover</h3>
<div class="table-wrap"><table class="band"><tr><th>Client</th><th>Site</th><th>Status</th></tr><tr><td>Northside Auto Group</td><td>Main lot</td><td><span class="badge" style="background:#059669">Paid</span></td></tr><tr class="hover"><td>Lakeside Office Park (hover)</td><td>Tower A</td><td><span class="badge" style="background:#b45309">Pending</span></td></tr><tr><td>Las Olas Medical</td><td>Suite 400</td><td><span class="badge" style="background:#b91c1c">Overdue</span></td></tr></table></div>
<h3>The surface ladder: well, page, card</h3>
<div class="ladder"><div style="background:${v['surface-sunken']}">L0 well</div><div style="background:${v['surface-page']}">L1 page</div><div style="background:#fff">L2 card</div><div style="background:${v['upcoming-bg']};border-left:3px solid ${v['upcoming-border']}">Upcoming card</div></div>
<p style="color:var(--muted);font-size:12px">An approximation of the kit in this palette; the rendered proof is <code>npm --prefix app run lint:rebrand</code> on the applied build.</p></section>
<section><h2>Documents and email, rendered by the app's own templates</h2><div class="frames">
<h3>The quote</h3><iframe title="The quote" srcdoc="${esc(quote)}"></iframe><h3>The inspection report</h3><iframe title="The inspection report" srcdoc="${esc(report)}"></iframe>${email ? `<h3>The sign-request email: ${esc(email.subject)}</h3><iframe title="The sign-request email" srcdoc="${esc(email.html)}"></iframe>` : ''}
</div></section>
</main></body></html>`;
  return { html, checks, B };
}

// luminance helper for the swatch label: contrast of a colour against black text
function checksContrast(hex) {
  const lin = (x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return (L + 0.05) / 0.05;
}

const invoked = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (invoked) {
  const id = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== arg('--out'));
  if (!id) { console.error('brand-review: name a brand (npm --prefix app run brand:review -- <id>)'); process.exit(1); }
  const { brand, error } = loadBrand(id);
  if (error) { console.error(error); process.exit(1); }
  const out = path.resolve(arg('--out', path.join(BRANDS, id, 'review.html')));
  const { html, checks } = await buildReview(brand);
  fs.writeFileSync(out, html);
  const failing = checks.filter((k) => !k.pass);
  console.log(`brand-review (${id}): ${out}\n  ${failing.length ? `${failing.length} contrast check(s) fail: ${failing.map((k) => k.name).join('; ')}` : `all ${checks.length} contrast checks pass`}`);
}
