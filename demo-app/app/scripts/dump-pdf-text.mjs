// Dump text items (string + x,y baseline in PDF user space + width) for the
// template pages we stamp, so FIELD_MAP coordinates are exact, not guessed.
// pdfjs transform[4]=x, transform[5]=y are bottom-left origin — same as pdf-lib.
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const bytes = readFileSync(new URL('../api/_lib/quotes/assets/cleanspace_quote_v1.pdf', import.meta.url));
const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;

const WANT = /Client|Name|Company|month|Insert|Frequency|many|Area|Representative|Print|agree|^I,|_/i;
const PAGES = [2, 3, 4, 5, 10];

for (const n of PAGES) {
  const page = await doc.getPage(n);
  const { width, height } = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  console.log(`\n===== PAGE ${n}  (${Math.round(width)}x${Math.round(height)}) =====`);
  for (const it of tc.items) {
    const s = (it.str || '').trim();
    if (!s) continue;
    if (!WANT.test(s)) continue;
    const x = it.transform[4], y = it.transform[5];
    console.log(`  x=${x.toFixed(1)} y=${y.toFixed(1)} w=${(it.width || 0).toFixed(1)} h=${(it.height || 0).toFixed(1)}  "${s}"`);
  }
}
