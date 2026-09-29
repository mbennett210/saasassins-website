// Shared headless-chromium launcher for the server-side PDF renderers. On Vercel the
// binary comes from @sparticuz/chromium; locally it uses the system Chrome (set
// CHROME_PATH to override). The heavy libs are imported lazily so a serverless
// function that never renders a PDF doesn't pay the load cost.
//
// Extracted from api/_lib/quotes/render.js so the inspection-report renderer shares
// the exact same launch path (the quote renderer keeps its own copy to avoid churn
// on the live signed-agreement flow; new PDF code launches through here).
const LOCAL_CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launchBrowser() {
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
