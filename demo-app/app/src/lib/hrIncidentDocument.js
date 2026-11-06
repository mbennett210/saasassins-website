// The printed ACCIDENT / INCIDENT REPORT — Matt's own form (task #258), filled in. One
// self-contained HTML string (its own <style>), handed to the browser's print dialog, which offers
// "Save as PDF". The warning form's pattern (lib/hrWarningDocument.js): the document palette `DOC`
// (src/brand/doc.js), the letterhead mark and the brand's name from the brand layer, so a re-skin
// changes it with the app and no colour literal lives here.
//
// 🔴 IT IS HIS FORM: his two pages, his headings and their numbers, his questions in his order,
// his tick boxes ticked, his header ("Complete as soon as possible…", PAGE 1 OF 2) and his
// footer ("CONFIDENTIAL | For authorized company use"). Page one carries sections 01 to 03, page
// two 04 to 07, as his does. His form is English only, so this is too (every line is the catalog's
// English); the people's own words — what happened, the injury, the actions, the names — are
// printed AS TYPED (LANG-7). "Supporting documentation attached" ticks each kind of file the
// report holds, and names the files under the ticks.
//
// Browser-dep-free (no window/DOM), explicit .js imports.
import { english } from '../i18n/core.js';
import { DOC_LOGO } from '../brand/logo.js';
import { DOC } from '../brand/doc.js';
import { IDENTITY } from '../brand/identity.generated.js';
import {
  INCIDENT_FORM_KEYS, INCIDENT_SECTIONS, INCIDENT_TYPES, INCIDENT_TYPE_KEYS, INCIDENT_TYPE, ANSWERS, POLICE_ANSWERS,
  ANSWER_KEYS, TREATMENTS, TREATMENT_KEYS, NOTIFIED_LIST, NOTIFIED_KEYS, NOTIFIED, DOC_KINDS, DOC_KIND_KEYS,
  PERSON_KIND_KEYS, INCIDENT_STATUS, normalizePeople, docKindsOf, incidentCaseNo, timeAmPm,
} from './hrIncidents.js';

export const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const esc = escapeHtml;
// Paragraphs keep the writer's line breaks.
const para = (v) => esc(v).replace(/\r?\n/g, '<br/>');
// Only a PNG data URL ever reaches an <img> here (the server checked its shape on the way in).
const safeSig = (v) => (typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v) ? v : null);

// A day key read as that calendar day (noon UTC cannot cross a date line).
function fmtDay(key) {
  if (!key) return '';
  const d = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(key);
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
}

const CSS = `
.ir{max-width:8.5in;margin:0 auto;background:${DOC.paper};color:${DOC.ink};
  font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5pt;line-height:1.4;}
.ir *{box-sizing:border-box;}
.ir-page{padding:0 0 14px;}
.ir-page + .ir-page{break-before:page;page-break-before:always;margin-top:28px;border-top:1px dashed ${DOC.line};}
.ir-hd{display:flex;align-items:center;gap:18px;padding:20px 34px 12px;border-bottom:2px solid ${DOC.brand};}
.ir-logo{height:56px;width:auto;display:block;flex:none;}
.ir-hd h1{margin:0;font-size:21px;letter-spacing:.01em;color:${DOC.ink};font-weight:500;}
.ir-hd p{margin:4px 0 0;font-size:11px;color:${DOC.muted};}
.ir-lead{display:flex;justify-content:space-between;gap:12px;padding:8px 34px 0;font-size:9.5px;color:${DOC.muted};}
.ir-lead span:last-child{white-space:nowrap;}
.ir-void{margin:10px 34px 0;padding:10px 14px;border:1px solid ${DOC.bad};border-radius:8px;background:${DOC.badBg};color:${DOC.badInk};font-size:11px;}
.ir-sec{margin:14px 34px 0;break-inside:avoid;}
.ir-sec h2{margin:0 0 8px;padding:7px 12px;font-size:12px;font-weight:500;letter-spacing:.03em;color:${DOC.ink};
  background:${DOC.tint};border-left:4px solid ${DOC.brand};border-radius:4px;}
.ir-row{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px;}
.ir-q{flex:1 1 180px;min-width:0;}
.ir-q.wide{flex:2 1 320px;}
.ir-q.full{flex:1 1 100%;}
.ir-q b{display:block;font-size:9.5px;font-weight:400;color:${DOC.muted};margin-bottom:2px;}
.ir-q span{display:block;min-height:1.35em;border-bottom:1px solid ${DOC.line};padding:0 2px 2px;font-size:11px;word-break:break-word;}
.ir-q p{margin:0;min-height:2.8em;border-bottom:1px solid ${DOC.line};padding:0 2px 3px;font-size:11px;word-break:break-word;}
.ir-ticks{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:4px;font-size:11px;}
.ir-ticks.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));}
.ir-inline{display:flex;align-items:center;flex-wrap:wrap;gap:6px 20px;margin-top:8px;font-size:11px;}
.ir-inline > b{font-size:9.5px;font-weight:400;color:${DOC.muted};min-width:150px;}
.ir-tick{display:inline-flex;align-items:center;gap:6px;}
.ir-box{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;flex:none;
  border:1.2px solid ${DOC.pen};border-radius:2px;font-size:10px;font-weight:800;line-height:1;}
.ir-box.on{background:${DOC.brand};border-color:${DOC.brand};color:${DOC.onBrand};}
.ir-words{flex:1;min-width:120px;border-bottom:1px solid ${DOC.line};padding:0 2px 1px;}
.ir-people{width:100%;border-collapse:collapse;margin-top:2px;font-size:11px;}
.ir-people td{border-bottom:1px solid ${DOC.line};padding:2px 2px 3px;vertical-align:top;}
.ir-people td + td{width:34%;}
.ir-files{margin:6px 0 0;padding:0 0 0 16px;font-size:10px;color:${DOC.muted};}
.ir-sigimg{display:block;height:54px;width:auto;max-width:100%;border-bottom:1px solid ${DOC.line};}
.ir-sigline{height:54px;border-bottom:1px solid ${DOC.line};}
.ir-foot{display:flex;justify-content:space-between;gap:12px;margin:16px 34px 0;padding-top:8px;border-top:1px solid ${DOC.line};color:${DOC.muted};font-size:9px;}
@media print{.ir{max-width:none;}.ir-page + .ir-page{margin-top:0;border-top:0;}}
`;

const E = (key, params) => english(key, params);
const F = (field, params) => E(INCIDENT_FORM_KEYS[field], params);
const box = (on) => `<span class="ir-box${on ? ' on' : ''}">${on ? '✓' : ''}</span>`;
const tick = (on, label) => `<span class="ir-tick">${box(on)}${esc(label)}</span>`;
const q = (label, value, cls = '') => `<div class="ir-q${cls ? ` ${cls}` : ''}"><b>${esc(label)}</b><span>${value || '&nbsp;'}</span></div>`;
const qp = (label, value) => `<div class="ir-q full"><b>${esc(label)}</b><p>${value ? para(value) : '&nbsp;'}</p></div>`;
const heading = (n) => {
  const s = INCIDENT_SECTIONS.find((x) => x.n === n);
  return `<h2>${esc(n)}&nbsp;&nbsp;${esc(E(s.key))}</h2>`;
};

function header(page, pages) {
  return `<header class="ir-hd">
    <img class="ir-logo" src="${DOC_LOGO}" alt="${esc(IDENTITY.name)}" />
    <div><h1>${esc(F('title'))}</h1><p>${esc(F('subtitle', { company: IDENTITY.name }))}</p></div>
  </header>
  <div class="ir-lead"><span>${esc(F('lead'))}</span><span>${esc(F('page', { page, pages }))}</span></div>`;
}
const footer = () => `<footer class="ir-foot"><span>${esc(F('footer'))}</span><span>${esc(IDENTITY.name)}</span></footer>`;

// The whole document. `r` is the one-report read (signature included).
export function buildIncidentDocumentHtml(r = {}) {
  const types = new Set(Array.isArray(r.types) ? r.types : []);
  const notified = new Set(Array.isArray(r.notified) ? r.notified : []);
  const kinds = new Set(docKindsOf(r.files));
  const people = normalizePeople(r.people);
  const sig = safeSig(r.submitterSignature);
  const voided = r.status === INCIDENT_STATUS.voided
    ? `<div class="ir-void">${esc(E('hrInc.detail.voided', { name: r.voidedByName || '—', when: r.voidedAt, reason: r.voidReason || '' }))}</div>`
    : '';

  const typeTicks = INCIDENT_TYPES.map((x) => (x === INCIDENT_TYPE.other
    ? `<span class="ir-tick">${box(types.has(x))}${esc(E(INCIDENT_TYPE_KEYS[x]))}${types.has(x) && r.typeOther ? `: ${esc(r.typeOther)}` : ''}</span>`
    : tick(types.has(x), E(INCIDENT_TYPE_KEYS[x])))).join('');
  const peopleRows = people.length
    ? people.map((p) => `<tr><td>${esc(p.name || '—')}</td><td>${esc(E(PERSON_KIND_KEYS[p.kind]))}</td></tr>`).join('')
    : '<tr><td>&nbsp;</td><td>&nbsp;</td></tr>';
  const answerTicks = (list, value) => list.map((a) => tick(value === a, E(ANSWER_KEYS[a]))).join('');

  const page1 = `<section class="ir-page">
  ${header(1, 2)}
  ${voided}
  <section class="ir-sec">${heading('01')}
    <div class="ir-row">${q(F('reportedOn'), esc(fmtDay(r.reportedOn)))}${q(F('reportedBy'), esc(r.reportedByName), 'wide')}${q(F('reporterTitle'), esc(r.reporterTitle))}</div>
  </section>
  <section class="ir-sec">${heading('02')}
    <div class="ir-row">${q(F('incidentDate'), esc(fmtDay(r.incidentDate)))}${q(F('incidentTime'), esc(timeAmPm(r.incidentTime)))}${q(F('property'), esc(r.propertyName))}</div>
    <div class="ir-row">${q(F('exactLocation'), esc(r.exactLocation), 'wide')}${q(F('cityState'), esc(r.cityState))}</div>
    <div class="ir-row"><div class="ir-q full"><b>${esc(F('types'))}</b><div class="ir-ticks grid">${typeTicks}</div></div></div>
    <div class="ir-row">${qp(F('whatHappened'), r.whatHappened)}</div>
  </section>
  <section class="ir-sec">${heading('03')}
    <div class="ir-row"><div class="ir-q full"><b>${esc(F('people'))} · ${esc(F('personKind'))}</b><table class="ir-people"><tbody>${peopleRows}</tbody></table></div></div>
    <div class="ir-inline"><b>${esc(F('injured'))}</b>${answerTicks(ANSWERS, r.injured)}</div>
    <div class="ir-row">${q(F('injury'), esc(r.injuryDescription), 'full')}</div>
    <div class="ir-inline"><b>${esc(F('treatment'))}</b>${TREATMENTS.map((x) => tick(r.treatment === x, E(TREATMENT_KEYS[x]))).join('')}</div>
    <div class="ir-row">${q(F('provider'), esc(r.treatmentProvider), 'full')}</div>
  </section>
  ${footer()}
</section>`;

  const notifiedTicks = NOTIFIED_LIST.map((x) => (x === NOTIFIED.other
    ? `<span class="ir-tick">${box(notified.has(x))}${esc(E(NOTIFIED_KEYS[x]))}${notified.has(x) && r.notifiedOther ? `: ${esc(r.notifiedOther)}` : ''}</span>`
    : tick(notified.has(x), E(NOTIFIED_KEYS[x])))).join('');
  const files = Array.isArray(r.files) && r.files.length
    ? `<ul class="ir-files">${r.files.map((f) => `<li>${esc(E(DOC_KIND_KEYS[f.kind] || DOC_KIND_KEYS.other))}: ${esc(f.name)}</li>`).join('')}</ul>`
    : '';

  const page2 = `<section class="ir-page">
  ${header(2, 2)}
  <section class="ir-sec">${heading('04')}
    <div class="ir-inline"><b>${esc(F('witnesses'))}</b>${answerTicks(ANSWERS, r.witnesses)}</div>
    <div class="ir-row">${q(F('witnessNames'), esc(r.witnessNames), 'wide')}${q(F('witnessContact'), esc(r.witnessContact))}</div>
    <div class="ir-inline"><b>${esc(F('police'))}</b>${answerTicks(POLICE_ANSWERS, r.police)}</div>
    <div class="ir-row">${q(F('policeDetails'), esc(r.policeDetails), 'full')}</div>
    <div class="ir-row"><div class="ir-q full"><b>${esc(F('notified'))}</b><div class="ir-ticks">${notifiedTicks}</div></div></div>
  </section>
  <section class="ir-sec">${heading('05')}
    <div class="ir-row">${qp(F('actions'), r.actionsTaken)}</div>
    <div class="ir-row"><div class="ir-q full"><b>${esc(F('docs'))}</b><div class="ir-ticks">${DOC_KINDS.map((k) => tick(kinds.has(k), E(DOC_KIND_KEYS[k]))).join('')}</div>${files}</div></div>
  </section>
  <section class="ir-sec">${heading('06')}
    <div class="ir-row">${q(F('printedName'), esc(r.submittedByName), 'wide')}<div class="ir-q wide"><b>${esc(F('signature'))}</b>${sig ? `<img class="ir-sigimg" src="${sig}" alt="${esc(E('hrInc.detail.signatureAlt', { name: r.submittedByName || '' }))}" />` : '<div class="ir-sigline"></div>'}</div></div>
    <div class="ir-row">${q(F('signedOn'), esc(fmtDay(r.signedOn)))}${q(F('contact'), esc(r.submitterContact), 'wide')}</div>
  </section>
  <section class="ir-sec">${heading('07')}
    <div class="ir-row">${q(F('reviewedBy'), esc(r.reviewedByName), 'wide')}${q(F('receivedOn'), esc(fmtDay(r.receivedOn)))}${q(F('caseNo'), esc(incidentCaseNo(r)))}</div>
  </section>
  ${footer()}
</section>`;

  return `<style>${CSS}</style><div class="ir">${page1}${page2}</div>`;
}
