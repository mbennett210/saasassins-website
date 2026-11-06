// THE APP'S PUBLIC ADDRESS — where a link a person follows out of an email lands (DEV_PLAYBOOK 3.4.18,
// UI_RULES §129): an invite's or a password reset's set-password page, a quote's signing page, the client
// hub's ticket and report links.
//
// From configuration only: the deploy's APP_PUBLIC_URL, else APP_BASE_URL, else the brand pack's own
// address (IDENTITY.appUrl, brands/<id>/brand.json `appUrl` — Clean Space's is https://www.cleancorner.app).
// NEVER the request's Host: the old alias (cleanspace-gilt.vercel.app) still serves the app, so an office
// user signed in there would otherwise send a customer or a new member to it, where they sign in again on a
// second origin (a session lives per origin) — and a Host header is the caller's to choose [SEC-40].
//
// OAuth redirect URIs are not links in an email: they must come back to the origin the consent started on
// (the inbox connect; QuickBooks reads its own QBO_REDIRECT_URI), and a printed QR code
// keeps its own rule (UI_RULES §139). test-app-links.mjs holds the split.
import { IDENTITY } from '../../src/brand/identity.generated.js';

/** The app's public address, without a trailing slash. `env` is for tests; the routes read process.env. */
export function appPublicUrl(env = process.env) {
  for (const v of [env.APP_PUBLIC_URL, env.APP_BASE_URL, IDENTITY.appUrl]) {
    const s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '';
    if (s) return s;
  }
  return '';
}
