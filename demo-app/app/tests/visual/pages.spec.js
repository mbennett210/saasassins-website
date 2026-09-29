import { test, expect } from '@playwright/test';
import { VISUAL_ROUTES } from '../routes.mjs';

// The seed's dates are runtime-relative (see brain/CLIENT.md), so the schedule/date
// labels would break every pixel baseline. Freeze the clock BEFORE navigation so
// `new Date()` is deterministic and the seed bootstraps identically every run.
const FROZEN = new Date('2026-09-12T09:00:00');

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: FROZEN });
});

const slug = (r) => (r === '/' ? 'root' : r.replace(/^\//, '').replace(/\//g, '-'));

for (const route of VISUAL_ROUTES) {
  test(`visual ${route}`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'networkidle' });
    // Wait for the lazy route chunk to paint real content into the shell.
    await page.locator('.main').first().waitFor({ state: 'visible' }).catch(() => {});
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`${slug(route)}.png`, { fullPage: true });
  });
}
