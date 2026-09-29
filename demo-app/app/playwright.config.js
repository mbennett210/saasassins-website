import { defineConfig, devices } from '@playwright/test';

// Visual-regression config for the mobile-uniformity gate (see MOBILE_QA.md).
// Device matrix mirrors the fit-sweep's viewports (375 phone · 820 real-iPad seam ·
// 1024 landscape). baseURL points at a --mode demo dev server (seeded, no login);
// webServer starts one if none is running.
const PORT = process.env.APP_PORT || 5193;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/visual',
  // One baseline tree per device project; names stay stable across OS via the
  // template (Playwright still appends the platform, e.g. -linux — see MOBILE_QA.md
  // on why the committed baselines must be generated in ONE environment/Docker).
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  expect: {
    toHaveScreenshot: {
      // Absorb subpixel/font-AA noise; tighten once baselines are Docker-generated.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      scale: 'css',
    },
  },
  use: {
    baseURL: APP_URL,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
  },
  // Width-regression projects (Chromium/Blink ≈ Android Chrome) + real-engine device
  // projects so the suite covers BOTH iPhone (WebKit/Safari) and Android (Chrome).
  projects: [
    { name: 'phone-375', use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: 'ipad-820', use: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: 'landscape-1024', use: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 } },
    // iPhone rendered in Safari's engine (WebKit) — needs `npx playwright install webkit`.
    { name: 'iphone-safari', use: { ...devices['iPhone 13'] } },
    // Android rendered in Chrome (real Pixel UA / touch / DPR).
    { name: 'android-chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: `npm run dev -- --mode demo --port ${PORT}`,
    url: APP_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
