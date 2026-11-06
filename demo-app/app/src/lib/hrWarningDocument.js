// The printed EMPLOYEE WARNING — Matt's own form (HR-1 "b", 2026-10-05), filled in. One
// self-contained HTML string (its own <style>), handed to the browser's print dialog, which
// offers "Save as PDF". The inspection report's pattern (lib/inspectionReportTemplate.js): the
// document palette `DOC` (src/brand/doc.js), the letterhead mark and the brand's name from the
// brand layer, so a re-skin changes it with the app and no colour literal lives here.
//
// 🔴 IT IS HIS FORM, TWICE, the way his own paper is: the logo, then his ENGLISH page, then
// his team's SPANISH page with the same answers, each closed by its signature block. Every
// line is a catalog key rendered in that page's language (`translate(lang, key)`): the form's
// questions and reasons have his Spanish (catalog/es.js); a line his form does not have (the
// level, "refused to sign", "voided") shows the app's own Spanish since S129 (Google Cloud
// Translation's line, held to the term list), and its English only if the Spanish catalog lacks
// the line. The people's own words — the details, the corrective action, "Other", the comment,
// the names — are printed AS TYPED on both pages, never translated (LANG-7).
//
// The caller must have the Spanish catalog loaded (i18n/runtime ensureCatalog('es')) before
// building it, or the second page falls back to English.
//
// Browser-dep-free (no window/DOM), explicit .js imports.
import { getOrgTimezone } from './dates.js';
import { translate } from '../i18n/core.js';
import { LANGUAGE_INFO, intlLocale } from '../i18n/languages.js';
import { DOC_LOGO } from '../brand/logo.js';
import { DOC } from '../brand/doc.js';
import { IDENTITY } from '../brand/identity.generated.js';
import {
  WARNING_LEVEL_KEYS, WARNING_REASONS, WARNING_REASON_KEYS, WARNING_STATUS, WARNING_REASON, WARNING_FORM_KEYS,
} from './hrWarnings.js';

// The two pages, in his form's order.
export const WARNING_DOCUMENT_LANGUAGES = Object.freeze(['en', 'es']);

export const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const esc = escapeHtml;
// Paragraphs keep the writer's line breaks.
const para = (v) => esc(v).replace(/\r?\n/g, '<br/>');
// Only a PNG data URL ever reaches an <img> here (the server checked its shape on the way in).
const safeSig = (v) => (typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v) ? v : null);

// Intl gets the base locale, never a private-use tag (i18n/languages intlLocale).
const localeOf = (lang) => intlLocale((LANGUAGE_INFO[lang] || LANGUAGE_INFO.en).dateLocale);
// A day key read as that calendar day, in the page's language (noon UTC cannot cross a date line).
function fmtDay(key, lang) {
  if (!key) return '';
  const d = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(key);
  return new Intl.DateTimeFormat(localeOf(lang), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
}
// A moment's calendar day in the org's zone, in the page's language.
function fmtMomentDay(iso, lang, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeOf(lang), { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz }).format(d);
}

const CSS = `
.hw{max-width:8.5in;margin:0 auto;background:${DOC.paper};color:${DOC.ink};
  font-family:'Helvetica Neue',Arial,sans-serif;font-size:11pt;line-height:1.45;}
.hw *{box-sizing:border-box;}
.hw-page{padding:0 0 18px;}
.hw-page + .hw-page{break-before:page;page-break-before:always;margin-top:28px;border-top:1px dashed ${DOC.line};}
.hw-hd{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 34px 12px;border-bottom:2px solid ${DOC.brand};}
.hw-logo{height:54px;width:auto;display:block;}
.hw-level{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${DOC.muted};font-weight:700;margin-top:12px;white-space:nowrap;}
.hw-title{padding:14px 34px 0;}
.hw-title h1{margin:0;font-size:22px;color:${DOC.brand};}
.hw-void{margin:10px 34px 0;padding:10px 14px;border:1px solid ${DOC.bad};border-radius:8px;background:${DOC.badBg};color:${DOC.badInk};font-size:12px;}
.hw-line{display:flex;gap:18px;flex-wrap:wrap;padding:10px 34px 0;font-size:12px;}
.hw-q{display:flex;align-items:baseline;gap:8px;flex:1 1 260px;min-width:0;}
.hw-q b{white-space:nowrap;color:${DOC.pen};font-weight:700;}
.hw-q span{flex:1;min-width:60px;border-bottom:1px solid ${DOC.pen};padding:0 2px 1px;}
.hw-q.date{flex:0 1 220px;}
.hw-q .hw-blank{display:block;height:1.2em;}
.hw-sec{padding:14px 34px 0;break-inside:avoid;}
.hw-sec h2{margin:0 0 6px;font-size:12px;color:${DOC.pen};font-weight:700;}
.hw-sec p{margin:0;font-size:11.5px;padding:6px 8px;border:1px solid ${DOC.line};border-radius:6px;min-height:3.2em;}
.hw-reasons{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 14px;font-size:11.5px;}
.hw-reason{display:flex;align-items:center;gap:7px;}
.hw-tick{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;flex:none;
  border:1.5px solid ${DOC.pen};border-radius:3px;font-size:11px;font-weight:800;line-height:1;}
.hw-tick.on{background:${DOC.brand};border-color:${DOC.brand};color:${DOC.onBrand};}
.hw-other{grid-column:1 / -1;display:flex;align-items:baseline;gap:7px;}
.hw-other em{font-style:normal;flex:1;border-bottom:1px solid ${DOC.pen};padding:0 2px 1px;}
.hw-note{margin:14px 34px 0;font-size:10.5px;color:${DOC.muted};font-style:italic;}
.hw-sign{margin:12px 34px 0;padding:12px 14px;border:1px solid ${DOC.line};border-radius:8px;break-inside:avoid;}
.hw-sign-row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;}
.hw-sign-cell{flex:1 1 200px;min-width:0;font-size:11px;}
.hw-sign-cell b{display:block;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:${DOC.muted};margin-top:4px;}
.hw-sigimg{display:block;height:64px;width:auto;max-width:100%;border-bottom:1px solid ${DOC.pen};}
.hw-sigline{height:64px;border-bottom:1px solid ${DOC.pen};}
.hw-sigtext{min-height:1.4em;border-bottom:1px solid ${DOC.pen};padding:0 2px 2px;}
.hw-sign p{margin:8px 0 0;font-size:11px;}
.hw-foot{margin-top:16px;border-top:1px solid ${DOC.line};padding:10px 34px 0;color:${DOC.muted};font-size:9px;text-align:center;}
@media print{.hw{max-width:none;}.hw-page + .hw-page{margin-top:0;border-top:0;}}
`;

// One page of his form, in `lang`.
function page(w, lang, tz) {
  const say = (key, params) => translate(lang, key, params, tz);
  const F = (field) => say(WARNING_FORM_KEYS[field]);
  const picked = new Set(Array.isArray(w.reasons) ? w.reasons : []);
  const q = (label, value, cls = '') => `<div class="hw-q${cls ? ` ${cls}` : ''}"><b>${esc(label)}:</b><span>${value || '<i class="hw-blank"></i>'}</span></div>`;
  const tick = (on) => `<span class="hw-tick${on ? ' on' : ''}">${on ? '✓' : ''}</span>`;

  const reasons = WARNING_REASONS.filter((r) => r !== WARNING_REASON.other)
    .map((r) => `<div class="hw-reason">${tick(picked.has(r))}<span>${esc(say(WARNING_REASON_KEYS[r]))}</span></div>`)
    .join('');
  const otherOn = picked.has(WARNING_REASON.other);
  const other = `<div class="hw-reason hw-other">${tick(otherOn)}<span>${esc(say(WARNING_REASON_KEYS.other))}</span><em>${otherOn ? esc(w.reasonOther) : ''}</em></div>`;

  const voided = w.status === WARNING_STATUS.voided
    ? `<div class="hw-void">${esc(say('hrWarn.detail.voided', { name: w.voidedByName || '—', when: w.voidedAt, reason: w.voidReason || '' }))}</div>`
    : '';

  // The signature block that closes the page: the employee's, or HR-3's refusal with the HR
  // manager's — and, either way, the supervisor's name.
  const cell = (top, label) => `<div class="hw-sign-cell">${top}<b>${esc(label)}</b></div>`;
  const text = (v) => `<div class="hw-sigtext">${v ? esc(v) : '&nbsp;'}</div>`;
  const supervisor = cell(text(w.supervisorName), F('supervisorName'));
  const empSig = safeSig(w.employeeSignature);
  const hrSig = safeSig(w.hrManagerSignature);
  let sign;
  if (w.refusedAt || w.hrManagerSignedAt) {
    sign = `<div class="hw-sign">
      <p>${esc(say('hrWarn.detail.refusedBy', { name: w.hrManagerName || '—', when: w.hrManagerSignedAt || w.refusedAt }))}</p>
      <div class="hw-sign-row">
        ${cell(hrSig ? `<img class="hw-sigimg" src="${hrSig}" alt="${esc(say('hrWarn.detail.hrSignatureAlt'))}" />` : '<div class="hw-sigline"></div>', `${say('hrWarn.refuse.hrManager')} · ${w.hrManagerName || ''}`)}
        ${cell(text(fmtMomentDay(w.hrManagerSignedAt || w.refusedAt, lang, tz)), F('date'))}
        ${supervisor}
      </div></div>`;
  } else {
    const signed = !!w.employeeSignedAt;
    sign = `<div class="hw-sign">
      <div class="hw-sign-row">
        ${cell(signed && empSig ? `<img class="hw-sigimg" src="${empSig}" alt="${esc(say('hrWarn.detail.employeeSignatureAlt'))}" />` : '<div class="hw-sigline"></div>', `${F('employeeName')} · ${w.employeeName || ''}`)}
        ${cell(text(signed ? fmtMomentDay(w.employeeSignedAt, lang, tz) : ''), F('date'))}
        ${supervisor}
      </div>
      ${signed && w.signedInPerson ? `<p>${esc(say('hrWarn.detail.signedInPerson'))}</p>` : ''}
      ${w.employeeComment ? `<p><b>${esc(say('hrWarn.detail.comment'))}:</b> ${para(w.employeeComment)}</p>` : ''}
    </div>`;
  }

  return `<section class="hw-page" lang="${lang}">
  <header class="hw-hd">
    <img class="hw-logo" src="${DOC_LOGO}" alt="${esc(IDENTITY.name)}" />
    <span class="hw-level">${esc(say(WARNING_LEVEL_KEYS[w.level] || WARNING_LEVEL_KEYS.first))}</span>
  </header>
  <div class="hw-title"><h1>${esc(F('title'))}</h1></div>
  ${voided}
  <div class="hw-line">${q(F('employeeName'), esc(w.employeeName))}${q(F('date'), esc(fmtDay(w.issuedOn, lang)), 'date')}</div>
  <div class="hw-line">${q(F('supervisorName'), esc(w.supervisorName))}</div>
  <div class="hw-line">${q(F('previousMeeting'), w.previousMeetingDate ? esc(fmtDay(w.previousMeetingDate, lang)) : '')}</div>
  <section class="hw-sec"><h2>${esc(F('reasonsHeading'))}:</h2><div class="hw-reasons">${reasons}${other}</div></section>
  <section class="hw-sec"><h2>${esc(F('details'))}:</h2><p>${para(w.whatHappened)}</p></section>
  <section class="hw-sec"><h2>${esc(F('corrective'))}:</h2><p>${para(w.whatMustChange)}</p></section>
  <p class="hw-note">${esc(F('note'))}</p>
  ${sign}
  <footer class="hw-foot">${esc(IDENTITY.name)} · ${esc(F('title'))}</footer>
</section>`;
}

// The whole document. `w` is the one-warning read (signatures included).
export function buildWarningDocumentHtml(w = {}, { tz = getOrgTimezone() } = {}) {
  return `<style>${CSS}</style><div class="hw">${WARNING_DOCUMENT_LANGUAGES.map((lang) => page(w, lang, tz)).join('')}</div>`;
}
