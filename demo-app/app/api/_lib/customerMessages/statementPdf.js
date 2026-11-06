// THE MONTHLY STATEMENT'S PDF — the attachment the approved statement email names ("Attached is
// your monthly account statement…"). One page or more of plain text tables, built with pdf-lib in
// the function itself (no headless browser: up to 750 of them go out on the 1st, a few per run).
// Colours come from the document palette (src/brand/doc.js DOC), never a literal (UI_RULES §121).
// Money is integer cents, shown in dollars. Text is Helvetica (WinAnsi): anything it cannot draw
// is written as "?" rather than failing the statement.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DOC } from '../../../src/brand/doc.js';

const toRgb = (hex) => {
  const h = String(hex || '').replace('#', '');
  const n = (i) => parseInt(h.length === 3 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16) / 255;
  return Number.isFinite(n(0)) ? rgb(n(0), n(1), n(2)) : undefined;
};
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?');
const dollars = (c) => (Number(c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const dayText = (k) => {
  const d = new Date(`${k}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? safe(k) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

// statement: { customer, month, periodStart, periodEnd, balanceCents, invoices: [{ number,
// issuedDay, totalCents, balanceCents }], payments: [{ day, amountCents }] }, company: { name,
// phone, email }. → base64 of the PDF.
export async function statementPdfBase64(statement, company = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = toRgb(DOC.ink);
  const muted = toRgb(DOC.muted);
  const brand = toRgb(DOC.brand);
  let page = pdf.addPage([612, 792]);
  let y = 740;
  const line = (text, { size = 11, f = font, color = ink, x = 56 } = {}) => {
    if (y < 64) { page = pdf.addPage([612, 792]); y = 740; }
    page.drawText(safe(text), { x, y, size, font: f, color });
    y -= size + 7;
  };
  const row = (cells, { f = font, color = ink } = {}) => {
    if (y < 64) { page = pdf.addPage([612, 792]); y = 740; }
    const xs = [56, 230, 380, 470];
    cells.forEach((c, i) => page.drawText(safe(c), { x: xs[i], y, size: 10, font: f, color }));
    y -= 17;
  };
  line(company.name || '', { size: 18, f: bold, color: brand });
  line([company.phone, company.email].filter(Boolean).join('  ·  '), { size: 10, color: muted });
  y -= 10;
  line('Account statement', { size: 14, f: bold });
  line(statement.customer || '', { size: 12 });
  line(`${dayText(statement.periodStart)} to ${dayText(statement.periodEnd)}`, { size: 10, color: muted });
  y -= 8;
  line('Invoices this period', { size: 12, f: bold });
  if (statement.invoices?.length) {
    row(['Invoice', 'Date', 'Amount', 'Open'], { f: bold, color: muted });
    for (const inv of statement.invoices) row([inv.number, dayText(inv.issuedDay), dollars(inv.totalCents), dollars(inv.balanceCents)]);
  } else line('None', { size: 10, color: muted });
  y -= 8;
  line('Payments this period', { size: 12, f: bold });
  if (statement.payments?.length) {
    row(['Date', '', 'Amount', ''], { f: bold, color: muted });
    for (const p of statement.payments) row([dayText(p.day), '', dollars(p.amountCents), '']);
  } else line('None', { size: 10, color: muted });
  y -= 12;
  line(`Current balance: ${dollars(statement.balanceCents)}`, { size: 13, f: bold });
  const bytes = await pdf.save();
  return Buffer.from(bytes).toString('base64');
}

export const statementFilename = (month) => `statement-${String(month || '').replace(/[^0-9-]/g, '')}.pdf`;
