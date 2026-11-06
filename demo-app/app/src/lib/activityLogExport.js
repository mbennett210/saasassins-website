// The activity log's two EXPORTS (LOG-6 a: "A PDF for one customer over a date range, plus
// a spreadsheet"). Both are built here, from the same columns, so the document and the
// spreadsheet can never disagree about what a dispute pack contains.
//
// Browser-dep-free (the serverless export route imports it): no window, no DOM, explicit
// imports, and every date formatted in the ORG's timezone passed in — never the server's
// (THE LAW II.8; a Vercel function runs in UTC, so a device-local date would name the wrong
// day for a late-evening entry).
//
// The CSV uses the SHARED csvCell escaper (src/lib/payroll.js): a dispute pack is opened in
// Excel, so a summary that begins `=` must import as text, not run as a formula.
import { csvCell } from './payroll.js';
import { DOC } from '../brand/doc.js';
import { DOC_LOGO } from '../brand/logo.js';
import { IDENTITY } from '../brand/identity.generated.js';
// fmtStampIn / fmtDayIn / beforeAfterText live in the pure vocabulary module so the SCREENS
// share them without pulling this file's PDF template and csvCell into their chunk.
import { actorLabel, actionLabel, fmtStampIn, fmtDayIn, beforeAfterText } from './activityLog.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── the columns (both exports) ──────────────────────────────────────────────
export const ACTIVITY_EXPORT_COLUMNS = Object.freeze([
  { key: 'when', label: 'When', value: (e, tz) => fmtStampIn(e.occurredAt, tz) },
  { key: 'who', label: 'Who', value: (e, tz, usersById) => actorLabel(e, usersById) },
  { key: 'role', label: 'Access level', value: (e) => (e.auto ? 'system' : (e.actorRole || '')) },
  { key: 'action', label: 'Action', value: (e) => actionLabel(e.action) },
  { key: 'customer', label: 'Customer', value: (e) => e.clientName || '' },
  { key: 'what', label: 'What happened', value: (e) => e.summary },
  { key: 'change', label: 'Before → after', value: (e, tz) => beforeAfterText(e, tz) },
  { key: 'record', label: 'Record', value: (e) => [e.entityType, e.entityId].filter(Boolean).join(' ') },
]);

// ── the spreadsheet ─────────────────────────────────────────────────────────
export function activityCsv(entries, { tz = 'UTC', usersById = null } = {}) {
  const lines = [ACTIVITY_EXPORT_COLUMNS.map((c) => csvCell(c.label)).join(',')];
  for (const e of entries || []) {
    lines.push(ACTIVITY_EXPORT_COLUMNS.map((c) => csvCell(c.value(e, tz, usersById))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// A file name a dispute folder can read at a glance.
export function activityExportFilename(ext, { clientName, fromIso, toIso, tz = 'UTC' }) {
  const slug = String(clientName || 'all-customers').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'all-customers';
  const day = (iso) => {
    if (!iso) return 'start';
    try {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
      return p.replace(/\//g, '-');
    } catch { return String(iso).slice(0, 10); }
  };
  return `activity-${slug}-${day(fromIso)}-to-${day(toIso)}.${ext}`;
}

// ── the PDF document ────────────────────────────────────────────────────────
// One self-contained HTML string (its own <style>), rendered by headless chromium exactly
// like the inspection report. Colours come from DOC (the document palette generated from
// the theme), so a re-skin changes this document with the app — no colour literal here.
export function buildActivityLogHtml({
  entries = [], clientName = null, fromIso = null, toIso = null, tz = 'UTC', generatedAt = null, viewerNote = null,
  usersById = null,
} = {}) {
  const rows = entries.map((e) => `
      <tr>
        <td class="nw">${esc(fmtStampIn(e.occurredAt, tz))}</td>
        <td>${esc(actorLabel(e, usersById))}${e.auto ? '' : (e.actorRole ? `<span class="sub">${esc(e.actorRole)}</span>` : '')}</td>
        <td class="nw">${esc(actionLabel(e.action))}</td>
        <td>${esc(e.summary)}${beforeAfterText(e, tz) ? `<span class="sub">${esc(beforeAfterText(e, tz))}</span>` : ''}</td>
      </tr>`).join('');

  const range = `${fromIso ? fmtDayIn(fromIso, tz) : 'the beginning'} – ${toIso ? fmtDayIn(toIso, tz) : 'today'}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=816">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 10pt 'Helvetica Neue', Arial, sans-serif; color: ${DOC.body}; background: ${DOC.paper}; }
  .wrap { padding: 28px 34px; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 2px solid ${DOC.brand}; padding-bottom: 12px; margin-bottom: 16px; }
  .head img { height: 34px; }
  h1 { margin: 0 0 2px; font-size: 16pt; color: ${DOC.ink}; }
  .meta { font-size: 9pt; color: ${DOC.muted}; text-align: right; }
  .meta strong { color: ${DOC.ink}; display: block; font-size: 10pt; }
  .card { border: 1px solid ${DOC.line}; border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; background: ${DOC.wash}; font-size: 9pt; }
  .card b { color: ${DOC.ink}; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: ${DOC.brand}; color: ${DOC.onBrand}; text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px; }
  tbody td { border-bottom: 1px solid ${DOC.line}; padding: 6px 8px; vertical-align: top; font-size: 9pt; }
  tbody tr:nth-child(even) td { background: ${DOC.wash}; }
  .nw { white-space: nowrap; }
  .sub { display: block; color: ${DOC.muted}; font-size: 8pt; margin-top: 2px; }
  .none { padding: 18px; text-align: center; color: ${DOC.muted}; border: 1px dashed ${DOC.rule}; border-radius: 6px; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
</style></head><body><div class="wrap">
  <div class="head">
    <div>
      <img src="${DOC_LOGO}" alt="${esc(IDENTITY.name)}">
      <h1>Activity record</h1>
      <div style="font-size:9pt;color:${DOC.muted}">${esc(clientName || 'All customers')}</div>
    </div>
    <div class="meta">
      <strong>${esc(range)}</strong>
      ${esc(entries.length)} ${entries.length === 1 ? 'entry' : 'entries'}<br>
      Prepared ${esc(fmtStampIn(generatedAt || new Date().toISOString(), tz))}
    </div>
  </div>
  <div class="card">
    <b>What this is.</b> Every recorded action on this account over the period above, in ${esc(tz)} time,
    newest last. Entries are written by the system when the action happens and cannot be edited or
    deleted.${viewerNote ? ` ${esc(viewerNote)}` : ''}
  </div>
  ${entries.length ? `<table>
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>What happened</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<div class="none">No recorded activity in this period.</div>'}
</div></body></html>`;
}

// Chromium draws the running footer from its own template (no page CSS applies).
export const ACTIVITY_PRINT_HEADER = '<div></div>';
export const ACTIVITY_PRINT_FOOTER =
  `<div style="width:100%;font:8pt 'Helvetica Neue',Arial,sans-serif;color:${DOC.muted};padding:0 40px;display:flex;justify-content:space-between;">`
  + `<span>${esc(IDENTITY.name)} — activity record</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
