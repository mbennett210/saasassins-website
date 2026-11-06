// QR-6 — the printable codes as a PDF: the label sheet (one label per area) or the one-page
// sheet (every code of the building on one page). The document is the SAME HTML the demo
// hands the browser's print dialog (src/lib/scanCodes.buildScanSheetHtml); here Chromium
// prints it through the shared launcher (`_lib/pdf/chromium.js`, the inspection report's).
//
// OFFICE ONLY: api/scan-codes is the one caller, behind sites.edit and a crew floor. The
// public scan route never reaches this module — no Chromium per anonymous hit (CS-073).
import { launchBrowser } from '../pdf/chromium.js';
import { buildScanSheetHtml, QR_ERROR_CORRECTION } from '../../../src/lib/scanCodes.js';

// codes: [{ label, url }] in the office's order (one code: Print label's one label). The QR matrices
// are drawn here, from each code's own URL, so what is printed is exactly what the codes screen and
// the database say. `position`: the label of the sheet the first one goes on (QR-9).
export async function buildSheetHtml({ layout, format, building, location, codes, position }) {
  const QRCode = (await import('qrcode')).default;
  const drawn = (codes || []).map((c) => ({ ...c, qr: QRCode.create(c.url, { errorCorrectionLevel: QR_ERROR_CORRECTION }) }));
  return buildScanSheetHtml({ layout, format, building, location, codes: drawn, position });
}

// The document's own @page rule sets US letter with no margin, and preferCSSPageSize makes
// Chromium honour it, so the labels land where the sheet's die-cuts are.
export async function renderScanSheetPdf(html) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // Every asset is inline (the QR codes are SVG paths), so 'load' is enough.
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }
}
