// Server-side PDF rendering for the e-signature quote flow — in-repo, no external
// service. Renders the SAME HTML the in-app editor/public view use (template.js)
// through headless chromium, so the PDF matches what everyone saw on screen.
//
// On Vercel the chromium binary comes from @sparticuz/chromium; locally it uses
// the system Chrome (set CHROME_PATH to override). The heavy libs are imported
// lazily inside launchBrowser() so non-render routes through the same serverless
// function don't pay the load cost.
// Shared layout lives in src/lib so the browser imports a clean Vite module (the
// dev server's /api/* proxy would otherwise intercept a src→api import). Vercel's
// function bundler traces this relative import into the serverless bundle fine.
import { buildQuoteHtml, PRINT_HEADER, PRINT_FOOTER, fmtSignDate } from '../../../src/lib/quoteTemplate.js';

const LOCAL_CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function launchBrowser() {
  const onServerless = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL || process.env.VERCEL_ENV);
  const puppeteer = (await import('puppeteer-core')).default;
  if (onServerless) {
    const chromium = (await import('@sparticuz/chromium')).default;
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  return puppeteer.launch({
    executablePath: LOCAL_CHROME,
    headless: true,
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
}

const fmtDate = fmtSignDate; // shared formatter — keeps PDF + on-screen dates identical
const toDataUrl = (buf) => (buf ? `data:image/png;base64,${Buffer.from(buf).toString('base64')}` : null);

// Render the quote document to PDF bytes. Pass the admin/client signature PNGs
// (Buffer/Uint8Array) when available; omit one to render an intermediate state.
// Identical contract to the retired pdf-lib renderSignedPdf(quote, {adminPng, clientPng}).
export async function renderQuotePdf(quote, { adminSig = null, clientSig = null, clientPrintedName = null } = {}) {
  const html = buildQuoteHtml(quote?.fields || {}, {
    locked: true,
    adminSigDataUrl: toDataUrl(adminSig),
    clientSigDataUrl: toDataUrl(clientSig),
    clientPrintedName: clientPrintedName || quote?.client_signer_name || null,
    adminDate: adminSig ? (fmtDate(quote?.admin_signed_at) || fmtDate(new Date().toISOString())) : null,
    clientDate: clientSig ? (fmtDate(quote?.client_signed_at) || fmtDate(new Date().toISOString())) : null,
  });
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=816"></head><body>${html}</body></html>`;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // All assets are inline data-URIs (logo, signatures) — no network — so 'load'
    // is enough and far faster than waiting on networkidle.
    await page.setContent(doc, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: PRINT_HEADER,
      footerTemplate: PRINT_FOOTER,
      margin: { top: '0.55in', bottom: '0.5in', left: '0', right: '0' },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

// Decode a data URL ("data:image/png;base64,…") or bare base64 to a Buffer.
// Kept here so call sites can drop the retired pdf.js entirely.
export function pngFromDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(b64, 'base64');
}
