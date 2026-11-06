// The printed TERMINATION — Matt's form (Super Clippy's idea #513, his email "Clean Corner -
// Termination", 2026-11-05), filled in. One self-contained HTML string (its own <style>), handed
// to the browser's print dialog, which offers "Save as PDF". The incident report's pattern
// (lib/hrIncidentDocument.js): the document palette `DOC` (src/brand/doc.js), the letterhead mark
// and the brand's name from the brand layer, so a re-skin changes it with the app and no colour
// literal lives here.
//
// 🔴 IT IS HIS FORM: his lines in his order (Employee's Name, Day of Termination, Reason for
// Termination with his sixteen boxes in his two columns, "Other:" with its words, Direct Account
// Manager), the ticked ones marked. His form is English only, so this is too (every line is the
// catalog's English); the "Other" words and the names are printed AS TYPED (LANG-7).
//
// Browser-dep-free (no window/DOM), explicit .js imports.
import { english } from '../i18n/core.js';
import { DOC_LOGO } from '../brand/logo.js';
import { DOC } from '../brand/doc.js';
import { IDENTITY } from '../brand/identity.generated.js';
import { escapeHtml } from './hrIncidentDocument.js';
import {
  TERMINATION_FORM_KEYS, TERMINATION_REASONS, TERMINATION_REASON_KEYS, TERMINATION_REASON, TERMINATION_STATUS,
  normalizeReasons,
} from './hrTerminations.js';

const esc = escapeHtml;

// A day key read as that calendar day (noon UTC cannot cross a date line).
function fmtDay(key) {
  if (!key) return '';
  const d = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(key);
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
}

const CSS = `
.tr{max-width:8.5in;margin:0 auto;background:${DOC.paper};color:${DOC.ink};
  font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5pt;line-height:1.4;}
.tr *{box-sizing:border-box;}
.tr-hd{display:flex;align-items:center;gap:18px;padding:20px 34px 12px;border-bottom:2px solid ${DOC.brand};}
.tr-logo{height:56px;width:auto;display:block;flex:none;}
.tr-hd h1{margin:0;font-size:21px;letter-spacing:.01em;color:${DOC.ink};font-weight:500;}
.tr-hd p{margin:4px 0 0;font-size:11px;color:${DOC.muted};}
.tr-void{margin:10px 34px 0;padding:10px 14px;border:1px solid ${DOC.bad};border-radius:8px;background:${DOC.badBg};color:${DOC.badInk};font-size:11px;}
.tr-sec{margin:16px 34px 0;break-inside:avoid;}
.tr-row{display:flex;gap:18px;flex-wrap:wrap;}
.tr-q{flex:1 1 220px;min-width:0;}
.tr-q.full{flex:1 1 100%;}
.tr-q b{display:block;font-size:9.5px;font-weight:400;color:${DOC.muted};margin-bottom:2px;}
.tr-q span{display:block;min-height:1.35em;border-bottom:1px solid ${DOC.line};padding:0 2px 2px;font-size:11px;word-break:break-word;}
.tr-h{margin:0 0 8px;padding:7px 12px;font-size:12px;font-weight:500;letter-spacing:.03em;color:${DOC.ink};
  background:${DOC.tint};border-left:4px solid ${DOC.brand};border-radius:4px;}
.tr-ticks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 24px;font-size:11px;}
.tr-tick{display:flex;align-items:center;gap:7px;min-width:0;}
.tr-box{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;flex:none;
  border:1.2px solid ${DOC.pen};border-radius:2px;font-size:10px;font-weight:800;line-height:1;}
.tr-box.on{background:${DOC.brand};border-color:${DOC.brand};color:${DOC.onBrand};}
.tr-words{flex:1;min-width:120px;border-bottom:1px solid ${DOC.line};padding:0 2px 1px;word-break:break-word;}
.tr-filed{margin:18px 34px 0;font-size:9.5px;color:${DOC.muted};}
.tr-foot{display:flex;justify-content:space-between;gap:12px;margin:22px 34px 0;padding-top:8px;border-top:1px solid ${DOC.line};color:${DOC.muted};font-size:9px;}
@media print{.tr{max-width:none;}}
`;

const E = (key, params) => english(key, params);
const F = (field) => E(TERMINATION_FORM_KEYS[field]);
const box = (on) => `<span class="tr-box${on ? ' on' : ''}">${on ? '✓' : ''}</span>`;
const q = (label, value, cls = '') => `<div class="tr-q${cls ? ` ${cls}` : ''}"><b>${esc(label)}</b><span>${value || '&nbsp;'}</span></div>`;

// The whole document. `r` is one termination as the API answers it.
export function buildTerminationDocumentHtml(r = {}) {
  const ticked = new Set(normalizeReasons(r.reasons));
  const voided = r.status === TERMINATION_STATUS.voided
    ? `<div class="tr-void">${esc(E('hrTerm.detail.voided', { name: r.voidedByName || '—', when: r.voidedAt, reason: r.voidReason || '' }))}</div>`
    : '';
  const ticks = TERMINATION_REASONS.map((x) => (x === TERMINATION_REASON.other
    ? `<span class="tr-tick other">${box(ticked.has(x))}${esc(E(TERMINATION_REASON_KEYS[x]))}<span class="tr-words">${ticked.has(x) && r.reasonOther ? esc(r.reasonOther) : '&nbsp;'}</span></span>`
    : `<span class="tr-tick">${box(ticked.has(x))}${esc(E(TERMINATION_REASON_KEYS[x]))}</span>`)).join('');
  const filed = r.filedAt
    ? `<p class="tr-filed">${esc(E('hrTerm.detail.filed', { name: r.filedByName || '—', when: r.filedAt }))}</p>`
    : '';

  return `<style>${CSS}</style><div class="tr">
  <header class="tr-hd">
    <img class="tr-logo" src="${DOC_LOGO}" alt="${esc(IDENTITY.name)}" />
    <div><h1>${esc(F('title'))}</h1><p>${esc(IDENTITY.name)}</p></div>
  </header>
  ${voided}
  <section class="tr-sec"><div class="tr-row">${q(F('employee'), esc(r.employeeName))}${q(F('date'), esc(fmtDay(r.terminationDate)))}</div></section>
  <section class="tr-sec"><h2 class="tr-h">${esc(F('reasons'))}</h2><div class="tr-ticks">${ticks}</div></section>
  <section class="tr-sec"><div class="tr-row">${q(F('manager'), esc(r.managerName), 'full')}</div></section>
  ${filed}
  <footer class="tr-foot"><span>${esc(F('title'))}</span><span>${esc(IDENTITY.name)}</span></footer>
</div>`;
}
