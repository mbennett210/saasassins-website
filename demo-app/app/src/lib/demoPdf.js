// A one-page placeholder PDF, made in the browser — DEMO ONLY. The login-free demo keeps no files
// (a 10 MB certificate does not fit in localStorage), so "View" on a seeded document, or on one
// picked in an earlier session, opens this page instead: it says what the real file would be.
//
// Reached only from the demo branches of lib/customerDocumentsApi.js and lib/hubDemo.js, which a
// production build drops; nothing here runs at import, so the module tree-shakes out of
// `npm run build` with them.
//
// A hand-built PDF 1.4: one page, Helvetica, the lines given. ASCII only (anything else becomes
// "?"), so a character is a byte and the cross-reference offsets are the string's own indexes.
export function placeholderPdfBlob(lines) {
  const esc = (s) => String(s).replace(/[\\()]/g, (m) => `\\${m}`).replace(/[^\x20-\x7E]/g, '?');
  const text = (Array.isArray(lines) ? lines : [lines])
    .map((l, i) => `BT /F1 ${i === 0 ? 18 : 12} Tf 72 ${720 - i * 28} Td (${esc(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([out], { type: 'application/pdf' });
}

// An object URL for it (the caller opens it in a new tab).
export function placeholderPdfUrl(lines) {
  return URL.createObjectURL(placeholderPdfBlob(lines));
}
