// Single source of truth for the proposal + service-agreement document: the layout (the stylesheet, the
// running bars, the fields, the signing) here, the pages in the brand's own words in its brand pack
// (brands/<id>/quote.html, generated into QUOTE_BODY: UI_RULES §129). Used by BOTH the in-app editor/public
// view (browser) and the server-side chromium renderer (api/_lib/quotes/render.js), so the layout lives in
// exactly one place.
//
//   buildQuoteHtml(fields, opts) -> string
//     fields: { clientName, companyName, date, amount, frequency, dayOfWeek, restrooms }
//             (back-compat: amount falls back to the legacy `fee`; legacy `area` ignored)
//     opts:   { locked, adminSigDataUrl, clientSigDataUrl, clientPrintedName,
//               adminDate, clientDate }
//
// The 7 editable values render as <span class="qfield" data-field="KEY">…</span> —
// the ONLY editable atoms. Everything else is fixed boilerplate that reflows. CSS
// is scoped under .qdoc so it's safe to inject inline into the app.
import { DOC_LOGO } from '../brand/logo.js';
import { getOrgTimezone } from './dates.js';
import { DOC, solidPng } from '../brand/doc.js';
import { IDENTITY } from '../brand/identity.generated.js';
import { QUOTE_BODY } from '../brand/quote.generated.js';

// Colours come from the brand's document palette (src/brand/doc.js): the quote follows the app brand,
// so a re-skin changes it with the app. No colour literals in this file.

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// The brand's identity (brands/<id>/brand.json, UI_RULES §129), escaped for the document's HTML: the name,
// the letterhead lines and the signatory come from the brand file, never a literal here.
const CO = IDENTITY.company;
const NAME = esc(IDENTITY.name);
// the cover's two-line wordmark: the name's first word, then the rest, in capitals
const COVER = ((w) => [w[0], w.slice(1).join(' ')])(IDENTITY.name.split(/\s+/)).map((s) => esc(s.toUpperCase()));

// Signature-date formatter — the single source of truth for how a signed date is
// shown on the Date line, used by BOTH the on-screen surfaces (via
// signOptsFromQuote) and the server PDF (render.js). en-US long form, e.g.
// "June 29, 2026". Returns null for missing/invalid input so callers can omit it.
export function fmtSignDate(iso, tz = getOrgTimezone()) {
  if (!iso) return null;
  const d = new Date(iso);
  // *_signed_at is an instant; render the signed DATE in the org's zone so the PDF
  // (rendered under UTC on the server) and the on-screen surfaces show the same day.
  // Without a timeZone this rendered the server's/browser's local date — off by one
  // for a signature captured near midnight in a negative-offset zone.
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
}

// The cover-letter "date" field is a real date picker in edit mode (<input type=date>,
// which speaks YYYY-MM-DD) but prints as MM/DD/YY in the document. These convert
// between the two; both are tolerant of legacy free-text values.
export function isoFromDateField(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;                       // already ISO
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/); // MM/DD/YY(YY)
  if (m) {
    const [, mm, dd, yy] = m;
    const yyyy = yy.length === 2 ? `20${yy}` : yy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  const d = new Date(s);                                            // legacy free text
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function mmddyyFromISO(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : (iso || '');
}

// Build the signature/date opts for the ON-SCREEN surfaces (admin editor + public
// review page) from a quote row that already carries browser-loadable signed URLs
// for the signature PNGs (admin_signature_url / client_signature_url). This mirrors
// exactly what render.js bakes into the PDF: each signature's Date line is the
// formatted *_signed_at, shown only when that side's signature image is present.
export function signOptsFromQuote(quote = {}) {
  const q = quote || {};
  const adminSig = q.admin_signature_url || null;
  const clientSig = q.client_signature_url || null;
  return {
    adminSigDataUrl: adminSig,
    clientSigDataUrl: clientSig,
    clientPrintedName: q.client_signer_name || null,
    adminDate: adminSig ? fmtSignDate(q.admin_signed_at) : null,
    clientDate: clientSig ? fmtSignDate(q.client_signed_at) : null,
  };
}

// The brand's quote pages with their tokens filled (brands/<id>/quote.html; the tokens are listed in
// scripts/brand.mjs). A {{#token}}…{{/token}} section keeps its inside only when the token has a value, and
// {{field.<key>|<hint>}} is an editable field. The generator refuses an unknown token, so none is left.
function fill(body, values, field) {
  return body
    .replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, inside) => (values[k] ? inside : ''))
    .replace(/\{\{field\.(\w+)\|([^{}]*)\}\}|\{\{([\w.]+)\}\}/g, (_, key, hint, k) => (key ? field(key, hint) : values[k] ?? ''));
}

// NOTE: the field-span builder `f` is defined INSIDE buildQuoteHtml (below) so it
// can bake `contenteditable` straight into edit-mode spans — editability must not
// depend on any post-mount JS, which is what previously failed in the prod build.

const HEADER_TEXT = `${NAME}&nbsp; |&nbsp; ${esc(CO.tagline)}. ${esc(CO.services)}`;
const FOOTER_TEXT = `${NAME}&nbsp; |&nbsp; ${esc(CO.phone)}&nbsp; |&nbsp; ${esc(CO.website)}`;

// A signature cell: two ruled lines, each with the value ABOVE the line and the
// label beneath — signature over "…Signature", date over "Date" — so the date is
// arranged exactly like the signature. Missing value → a blank spacer keeps the
// line at the same height whether signed or left for a wet signature.
function sigCell(dataUrl, caption, printedName, date) {
  const sig = dataUrl
    ? `<img class="sigimg" src="${dataUrl}" alt="signature" />`
    : '<div class="sigblank"></div>';
  const dateVal = date ? `<div class="sigdateval">${esc(date)}</div>` : '<div class="sigblank"></div>';
  return `
    <div class="sigrow">${printedName ? `<div class="sigprinted">${esc(printedName)}</div>` : ''}${sig}<div class="sigline"></div><div class="sigcap">${caption}</div></div>
    <div class="sigrow">${dateVal}<div class="sigline"></div><div class="sigcap">Date</div></div>`;
}

const CSS = `
.qdoc{--doc-brand:${DOC.brand};--doc-good:${DOC.good};max-width:8.5in;margin:0 auto;background:${DOC.paper};color:${DOC.ink};
  font-family:'Helvetica Neue',Arial,sans-serif;font-size:11pt;line-height:1.5;}
.qdoc *{box-sizing:border-box;}
.qdoc .bar{background:var(--doc-brand);color:${DOC.onBrand};text-align:center;font-size:9pt;font-weight:600;padding:7px 10px;letter-spacing:.01em;}
.qdoc .page{padding:34px 54px 40px;}
.qdoc .pb{page-break-before:always;}
.qdoc .serif{font-family:Georgia,'Times New Roman',serif;}
.qdoc h1.title{font-family:Georgia,'Times New Roman',serif;font-size:30pt;font-weight:700;color:${DOC.ink};margin:6px 0 2px;}
.qdoc .subtitle{font-style:italic;color:${DOC.muted};font-size:11.5pt;margin:0 0 16px;}
.qdoc .seclabel{color:var(--doc-brand);font-weight:700;font-size:9.5pt;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid ${DOC.line};padding-bottom:5px;margin:22px 0 12px;}
.qdoc p{margin:0 0 11px;}
.qdoc .muted{color:${DOC.muted};}
.qdoc ul.bullets{margin:0 0 12px;padding-left:20px;}
.qdoc ul.bullets li{margin:3px 0;}
.qdoc table{width:100%;border-collapse:collapse;margin:4px 0 14px;font-size:10.5pt;}
.qdoc td,.qdoc th{border:1px solid ${DOC.line};padding:8px 11px;text-align:left;vertical-align:top;}
.qdoc .pricing td:first-child{font-weight:700;color:var(--doc-brand);background:${DOC.tint};width:38%;}
.qdoc .addon th{background:var(--doc-brand);color:${DOC.onBrand};font-weight:700;}
.qdoc .addon td:first-child{font-weight:700;color:var(--doc-brand);}
.qdoc .addon tr:nth-child(even) td{background:${DOC.wash};}
.qdoc .badges td{text-align:center;background:${DOC.tint};}
.qdoc .badges .bt{font-weight:700;color:var(--doc-brand);}
.qdoc .card{border:1px solid ${DOC.line};padding:10px 14px;margin:0 0 9px;display:flex;gap:12px;align-items:flex-start;background:${DOC.wash};}
.qdoc .card .ic{font-size:15pt;line-height:1.2;width:26px;text-align:center;flex:none;color:var(--doc-brand);}
.qdoc .card .ct{min-width:0;}
.qdoc .card .ch{font-weight:700;color:var(--doc-brand);margin-bottom:2px;}
.qdoc .callout{border:1px solid var(--doc-good);background:${DOC.goodBg};color:${DOC.goodInk};font-style:italic;padding:11px 14px;margin:14px 0;border-radius:3px;}
.qdoc .note{border:1px solid ${DOC.accent};background:${DOC.accentBg};color:${DOC.ink};font-style:italic;padding:11px 14px;margin:14px 0;border-radius:3px;}
.qdoc .cover{text-align:center;}
.qdoc .cover .big{font-family:Georgia,'Times New Roman',serif;font-weight:800;letter-spacing:.04em;line-height:1.04;}
.qdoc .cover .r1{font-size:44pt;color:var(--doc-brand);}
.qdoc .cover .r2{font-size:30pt;color:${DOC.accentText};}
.qdoc .cover .rule{border-top:1px solid ${DOC.rule};margin:14px 18%;}
.qdoc .cover .logo{width:190px;margin:34px auto 0;display:block;}
.qdoc .center{text-align:center;}
.qdoc .ksig{font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:20pt;color:var(--doc-brand);margin:6px 0 10px;}
.qdoc ol.steps{margin:6px 0 0;padding-left:20px;}
.qdoc ol.steps li{margin:5px 0;}
.qdoc .ic-green{color:var(--doc-good);}
.qdoc .agree-lead{margin:10px 0 14px;}
.qdoc .sigtable{display:flex;gap:48px;margin-top:24px;}
.qdoc .sigtable > div{flex:1;}
.qdoc .sigrow{margin-bottom:18px;}
.qdoc .sigblank{height:34px;}
.qdoc .sigimg{display:block;max-height:48px;max-width:272px;margin-bottom:-6px;}
.qdoc .sigprinted{font-size:11pt;margin-bottom:2px;}
.qdoc .sigline{border-bottom:1px solid ${DOC.pen};height:1px;}
.qdoc .sigcap{font-size:9pt;color:${DOC.muted};margin-top:3px;}
.qdoc .sigsub{margin-top:-12px;}
.qdoc .sigdateval{height:34px;display:flex;align-items:flex-end;padding-bottom:2px;font-size:12pt;color:${DOC.ink};}
.qdoc .blank{display:inline-block;min-width:230px;border-bottom:1px solid ${DOC.pen};}
.qdoc .qfield{background:${DOC.accentSoft};border-radius:2px;padding:0 2px;white-space:pre-wrap;}
.qdoc .qfield:empty::before{content:attr(data-ph);color:${DOC.muted};}
.qdoc.locked .qfield{background:transparent;padding:0;}
.qdoc.locked .qfield:empty::before{content:'';}
.qdoc .qdatefield{font:inherit;color:inherit;background:${DOC.accentSoft};border:none;border-radius:2px;padding:0 2px;cursor:pointer;}
.qdoc.locked .qdatefield{background:transparent;}
@media print{.qdoc .screen-only{display:none!important;}.qdoc{max-width:none;}.qdoc .page{padding:0 16px;}}
`;

export function buildQuoteHtml(fields = {}, opts = {}) {
  const x = fields || {};
  const clientName = x.clientName || '';
  const companyName = x.companyName || '';
  const date = x.date || '';
  const amount = x.amount ?? x.fee ?? '';
  const frequency = x.frequency || '';
  const dayOfWeek = x.dayOfWeek || '';
  const restrooms = x.restrooms || '';
  const { locked = false, adminSigDataUrl = null, clientSigDataUrl = null, clientPrintedName = null, adminDate = null, clientDate = null } = opts;

  // Field-span builder. In edit mode `contenteditable` is baked straight into the
  // markup so the field is editable the instant it renders — no post-mount JS to
  // activate it (that activation is exactly what failed in the prod build). In
  // locked mode (public review + the PDF) it's plain text.
  const f = (key, value, ph) => {
    const ce = locked ? '' : ' contenteditable="true" spellcheck="false"';
    return `<span class="qfield" data-field="${key}" data-ph="${esc(ph || '')}"${ce}>${esc(value)}</span>`;
  };

  // Cover-letter date: a real date picker in edit mode (prints MM/DD/YY); plain
  // MM/DD/YY text when locked (public review + PDF).
  const dateField = locked
    ? `<span class="qfield" data-field="date" data-ph="Date">${esc(date)}</span>`
    : `<input type="date" class="qdatefield" data-field="date" value="${esc(isoFromDateField(date))}" />`;

  // Signature captions. The client cell mirrors the rep's "Name, Role" line: the
  // signer's name sits in the caption ("Client Signature — <name>"), and the
  // company prints below the Date label like "Clean Space Representative".
  const clientSigName = clientPrintedName || clientName;
  const clientSigCaption = clientSigName ? `Client Signature. ${esc(clientSigName)}` : 'Client Signature';

  // Agreement "I, ___, authorized representative of ___" — filled with the
  // signing client's name + company when known, else a ruled blank.
  const agreeName = clientPrintedName || clientName;
  const iName = agreeName ? `<u>&nbsp;${esc(agreeName)}&nbsp;</u>` : '<span class="blank"></span>';
  const iCompany = companyName ? `<u>&nbsp;${esc(companyName)}&nbsp;</u>` : '<span class="blank"></span>';

  // the values the brand's pages ask for (their tokens), escaped for HTML
  const values = {
    name: NAME, 'wordmark.1': COVER[0], 'wordmark.2': COVER[1], logo: DOC_LOGO, 'doc.ink': DOC.ink,
    'company.street': esc(CO.street), 'company.city': esc(CO.city), 'company.phone': esc(CO.phone), 'company.website': esc(CO.website),
    'company.domain': esc(CO.domain), 'company.email': esc(CO.email), 'company.tagline': esc(CO.tagline), 'company.services': esc(CO.services),
    'signatory.name': esc(CO.signatory.name), 'signatory.title': esc(CO.signatory.title), 'signatory.role': esc(CO.signatory.role), 'signatory.email': esc(CO.signatory.email),
    date: dateField, 'client.company': companyName ? esc(companyName) : '', 'agreement.name': iName, 'agreement.company': iCompany,
    'signature.client': sigCell(clientSigDataUrl, clientSigCaption, null, clientDate),
    'signature.admin': sigCell(adminSigDataUrl, `${CO.signatory.name}, ${CO.signatory.role}`, null, adminDate),
  };
  const fieldValues = { clientName, companyName, amount, frequency, dayOfWeek, restrooms };
  const field = (key, hint) => f(key, fieldValues[key], hint);

  const body = `
<div class="qdoc${locked ? ' locked' : ''}">
  <div class="bar screen-only">${HEADER_TEXT}</div>

${fill(QUOTE_BODY, values, field)}

  <div class="bar screen-only" style="margin-top:8px;">${FOOTER_TEXT}</div>
</div>`;

  return `<style>${CSS}</style>${body}`;
}

// Running-bar HTML for chromium's headerTemplate/footerTemplate (print only).
// Chrome ignores printBackground for header/footer templates, so the brand fill is
// a stretched 1×1 brand-colour <img> (images DO render) with the on-brand text layered on top.
const BAR_PX = solidPng(DOC.brand);
const printBar = (text) =>
  `<div style="position:relative;width:100%;height:24px;font:600 8pt 'Helvetica Neue',Arial,sans-serif;">`
  + `<img src="${BAR_PX}" style="position:absolute;left:0;top:0;width:100%;height:100%;border:0;" />`
  + `<div style="position:relative;color:${DOC.onBrand};text-align:center;line-height:24px;">${text}</div></div>`;
export const PRINT_HEADER = printBar(HEADER_TEXT);
export const PRINT_FOOTER = printBar(FOOTER_TEXT);
