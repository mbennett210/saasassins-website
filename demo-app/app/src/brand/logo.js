// The documents' letterhead mark (the quote and the inspection report): the monogram on an accent tile,
// then the name, as an inline SVG data URI, so it renders the same in the browser and in the server's
// chromium PDF (no asset paths to resolve). Its colours come from the document palette, so a re-skin
// recolours it; it is the fallback mark until the brand pack supplies a logo for light backgrounds
// (logos.lockup.color), which brand.mjs rasterizes into logo.generated.js as an inline PNG data URI.
import { DOC } from './doc.js';
import { IDENTITY } from './identity.generated.js';
import { DOC_LOGO_IMAGE } from './logo.generated.js';

// the brand's name and monogram (brands/<id>/brand.json, UI_RULES §129), escaped for the SVG text
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');
const NAME = xml(IDENTITY.name);
const MONOGRAM = xml(IDENTITY.monogram);
const FONT = "font-family='Arial, Helvetica, sans-serif'";

const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='340' height='72' viewBox='0 0 340 72'>"
  + `<rect x='0' y='0' width='72' height='72' rx='14' fill='${DOC.accent}'/>`
  + `<text x='36' y='48' ${FONT} font-size='30' font-weight='800' fill='${DOC.onAccent}' text-anchor='middle'>${MONOGRAM}</text>`
  + `<text x='88' y='44' ${FONT} font-size='26' font-weight='700' fill='${DOC.brand}'>${NAME}</text></svg>`;

// '#' starts a URL fragment, so the colours are percent-encoded inside the data URI; so is '&', because the
// URI sits in an <img src="…"> attribute that decodes the name's &amp; back to a bare & the SVG can't parse
const MONOGRAM_LOGO = `data:image/svg+xml;utf8,${svg.replace(/#/g, '%23').replace(/&/g, '%26')}`;

// The brand pack's own logo for light backgrounds when it has one, else the generated monogram above.
export const DOC_LOGO = DOC_LOGO_IMAGE || MONOGRAM_LOGO;
