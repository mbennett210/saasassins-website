// Prefix a root-relative public asset (e.g. company.logoUrl '/polishpoint-logo.png')
// with Vite's base path, so it resolves under the demo's '/polishpoint/' base as
// well as a per-client product build's '/' base. Absolute (http/https), data:, and
// blob: URLs pass through untouched.
//
// This mirrors the inline helper the Sidebar uses for the brand logo (see
// components/Sidebar.jsx `brandLogoSrc`) — shared here so the demo top bars
// (landing + checkout) resolve the logo the same way without a 404 under the
// /polishpoint base.
const BASE_URL = import.meta.env.BASE_URL;

export function brandAssetUrl(url) {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return url;
  return `${BASE_URL.replace(/\/$/, '')}${url.startsWith('/') ? url : `/${url}`}`;
}
