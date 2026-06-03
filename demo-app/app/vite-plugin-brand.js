// Vite plugin: templates index.html with values from src/brand.config.js.
//
// Replaces %BRAND_*% placeholders in index.html at dev-serve and build time.
// Manifest.json is handled separately by scripts/build-manifest.mjs (which
// runs as a prebuild step in package.json) because Vite's plugin pipeline
// doesn't naturally handle static JSON files in public/.

import { BRAND } from './src/brand.config.js';

const TOKENS = {
  '%BRAND_NAME%': BRAND.name,
  '%BRAND_SHORT_NAME%': BRAND.shortName,
  '%BRAND_DESCRIPTION%': BRAND.description,
  '%BRAND_TITLE%': BRAND.titleSuffix,
  '%BRAND_PRIMARY%': BRAND.primaryHex,
};

function render(str) {
  return Object.entries(TOKENS).reduce(
    (out, [token, value]) => out.replaceAll(token, value),
    str,
  );
}

export default function brandPlugin() {
  return {
    name: 'brand-config-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return render(html);
      },
    },
  };
}
