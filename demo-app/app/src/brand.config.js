// Single source of truth for brand-level constants that need to reach
// non-CSS surfaces: index.html, public/manifest.json (via build-manifest.mjs),
// the PWA icon generator, and any runtime code that needs the brand name.
//
// To re-skin the shell for a new client:
//   1. Edit this file (name, hex, etc.)
//   2. Edit / replace `app/src/theme-<client>.css` and update the @import in `app/src/index.css`
//   3. Drop the new logo PNG into app/public/ and update BRAND.logoFile
//   4. Re-run `node scripts/gen-pwa-icons.mjs`
//   5. `npm run dev` (the prebuild step regenerates public/manifest.json from
//      manifest.template.json + this file; the Vite plugin templates index.html)
//
// No CSS variables are used here — by definition, the consumers can't read CSS.
// CSS-side brand color still lives in theme-<client>.css; this file is the
// shared anchor that keeps non-CSS surfaces consistent with the CSS palette.

export const BRAND = {
  name: 'PolishPoint',
  shortName: 'PolishPoint',
  description: 'Operations CRM — schedule, message, invoice.',
  titleSuffix: 'PolishPoint CRM',
  logoFile: 'polishpoint-logo.png',
  primaryHex: '#1E8FE8',                                  // PolishPoint Blue 500 (matches theme-polishpoint.css --color-brand-primary-500)
  primaryRgb: { r: 0x1E, g: 0x8F, b: 0xE8, alpha: 1 },
};
