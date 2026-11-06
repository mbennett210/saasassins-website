// Reading an Excel workbook (.xlsx) and writing a small one, with no library — in the browser and
// in Node alike (task 257: Supplies → Catalog → Import items reads Matt's spreadsheet, pictures
// included; the translator sheet's tools, scripts/xlsx-lib.mjs, read their cells through the same
// reader, so the repo has ONE cell reader).
//
// An .xlsx is a ZIP of XML parts. What this module understands is what spreadsheet programs write:
//   · CELLS — shared strings (`t="s"`, Excel's and Google Sheets' norm), inline strings
//     (`t="inlineStr"`), formula string results (`t="str"`), rich-text runs, numbers, booleans,
//     sparse rows and skipped cells. A formula's live value is its cached result; dates are numbers.
//   · PICTURES, each tied to a cell (readWorkbook):
//       - Excel 365's "Place in Cell" picture: the cell carries `vm` (its value metadata), which
//         leads metadata.xml → richData/rdrichvalue.xml (a `_localImage` value) →
//         richData/richValueRel.xml → the picture in xl/media/;
//       - a picture floating over the sheet: drawings/drawingN.xml anchors it by the cell its
//         top-left corner sits in (`from` col / row) → xl/media/;
//       - and as LINKS, not bytes: an `IMAGE("https://…")` formula, a picture Excel keeps as a web
//         image (`_webimage`), a picture linked rather than embedded, and a hyperlinked cell.
// Entries are found from the ZIP's central directory and inflated with the platform's own
// DecompressionStream('deflate-raw') (every current browser, Node 18+). ZIP64 is refused with a
// clear message rather than misread.

// ── ZIP ─────────────────────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const asBytes = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input || []));
// A ZIP starts with a local file header ("PK\3\4"); an .xlsx is a ZIP. The old binary .xls is not.
export function isZip(input) {
  const b = asBytes(input);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04;
}
// The old binary Excel format (.xls, an OLE compound file): read nothing, say to save it as .xlsx.
export function isLegacyXls(input) {
  const b = asBytes(input);
  return b.length >= 8 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;
}

export class XlsxError extends Error {
  constructor(code, message) { super(message); this.name = 'XlsxError'; this.code = code; }
}
// A part bigger than this once inflated is not a catalog (a ZIP bomb only hurts the reader's own
// tab, but it should still stop rather than hang it).
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

// The ZIP's directory: name → { method, compSize, size, start }. Sync: offsets only.
export function zipDirectory(input) {
  const b = asBytes(input);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i -= 1) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('not_xlsx', 'not a spreadsheet file (no ZIP directory found)');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (p === 0xFFFFFFFF || count === 0xFFFF) throw new XlsxError('zip64', 'ZIP64 spreadsheets are not supported');
  const out = new Map();
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) throw new XlsxError('damaged', 'damaged spreadsheet (bad ZIP directory)');
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localAt = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (localAt + 30 > b.length || v.getUint32(localAt, true) !== 0x04034b50) throw new XlsxError('damaged', 'damaged spreadsheet (bad ZIP entry)');
    const start = localAt + 30 + v.getUint16(localAt + 26, true) + v.getUint16(localAt + 28, true);
    out.set(name, { method, compSize, size, start });
  }
  return out;
}

async function inflateRaw(bytes, expected) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > Math.max(expected, 0) + 1024 || total > MAX_ENTRY_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new XlsxError('damaged', 'damaged spreadsheet (a part is larger than it says)');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// One entry's bytes, inflated (null when the ZIP has no such entry).
export async function zipEntry(input, dir, name) {
  const e = dir.get(name);
  if (!e) return null;
  if (e.size > MAX_ENTRY_BYTES) throw new XlsxError('too_large', `${name} is too large`);
  const b = asBytes(input);
  const data = b.subarray(e.start, e.start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRaw(data, e.size);
  throw new XlsxError('damaged', `unsupported compression in ${name}`);
}

// A ZIP of STORED entries (no compression): enough for a template of a few kilobytes, and needs no
// deflate in the browser. entries: [{ name, data: string | Uint8Array }] → Uint8Array.
export function storedZip(entries) {
  const enc = new TextEncoder();
  const files = entries.map(({ name, data }) => {
    const nameBytes = enc.encode(name);
    const raw = typeof data === 'string' ? enc.encode(data) : asBytes(data);
    return { nameBytes, raw, crc: crc32(raw) };
  });
  const size = files.reduce((n, f) => n + 30 + f.nameBytes.length + f.raw.length + 46 + f.nameBytes.length, 22);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let at = 0;
  const offsets = [];
  // 2026-01-01 00:00 as a DOS date: a fixed stamp, so the same template is the same bytes.
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    offsets.push(at);
    v.setUint32(at, 0x04034b50, true); v.setUint16(at + 4, 20, true); v.setUint16(at + 6, 0x0800, true);
    v.setUint16(at + 8, 0, true); v.setUint16(at + 10, DOS_TIME, true); v.setUint16(at + 12, DOS_DATE, true);
    v.setUint32(at + 14, f.crc, true); v.setUint32(at + 18, f.raw.length, true); v.setUint32(at + 22, f.raw.length, true);
    v.setUint16(at + 26, f.nameBytes.length, true); v.setUint16(at + 28, 0, true);
    out.set(f.nameBytes, at + 30);
    out.set(f.raw, at + 30 + f.nameBytes.length);
    at += 30 + f.nameBytes.length + f.raw.length;
  }
  const centralAt = at;
  files.forEach((f, i) => {
    v.setUint32(at, 0x02014b50, true); v.setUint16(at + 4, 20, true); v.setUint16(at + 6, 20, true);
    v.setUint16(at + 8, 0x0800, true); v.setUint16(at + 10, 0, true); v.setUint16(at + 12, DOS_TIME, true);
    v.setUint16(at + 14, DOS_DATE, true); v.setUint32(at + 16, f.crc, true); v.setUint32(at + 20, f.raw.length, true);
    v.setUint32(at + 24, f.raw.length, true); v.setUint16(at + 28, f.nameBytes.length, true);
    v.setUint32(at + 42, offsets[i], true);
    out.set(f.nameBytes, at + 46);
    at += 46 + f.nameBytes.length;
  });
  v.setUint32(at, 0x06054b50, true);
  v.setUint16(at + 8, files.length, true); v.setUint16(at + 10, files.length, true);
  v.setUint32(at + 12, at - centralAt, true); v.setUint32(at + 16, centralAt, true);
  return out;
}

// ── XML ─────────────────────────────────────────────────────────────────────────────────────
export const escXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Control characters are not legal XML 1.0; a pasted one must not corrupt the file.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // eslint-disable-line no-control-regex
export const unescXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

export function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
// "B12" → { row: 11, col: 1 } (0-based), or null.
export function cellRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref || '').trim());
  return m ? { row: Number(m[2]) - 1, col: colIndex(m[1]) } : null;
}

// An attribute's value on one tag, any namespace prefix on the attribute ("r:id", "id").
export function xmlAttr(tag, name) {
  const m = String(tag).match(new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? unescXml(m[1]) : null;
}
// Every element `local` (any namespace prefix) as [whole, attributes, inner].
function elements(xml, local) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${local}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${local}>)`, 'g');
  return [...String(xml || '').matchAll(re)].map((m) => ({ whole: m[0], attrs: m[1] || '', inner: m[2] || '' }));
}
const firstText = (xml, local) => {
  const m = String(xml || '').match(new RegExp(`<(?:[\\w.-]+:)?${local}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${local}>`));
  return m ? m[1] : null;
};

// The text of a string item: plain <t>, or rich-text runs <r><t>…</t></r> concatenated. Phonetic
// runs (<rPh>) are not the cell's text and are skipped.
export function xmlItemText(xml) {
  const noPhonetic = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [...noPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => unescXml(m[1] || '')).join('');
}

// ── cells ───────────────────────────────────────────────────────────────────────────────────
export function sharedStrings(xml) {
  const out = [];
  if (xml) for (const m of String(xml).matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) out.push(xmlItemText(m[1] || ''));
  return out;
}

// One worksheet's XML → { rows, cells }. `rows[r][c]` is each cell's text ('' for none; a row with
// nothing is []), exactly as the translator's reader has always read it. `cells` lists the cells
// that carry more than text: { row, col, vm, formula, type } — a picture placed in a cell (`vm`) or
// a formula (`IMAGE(…)`).
export function readSheetXml(xml, shared = []) {
  const rows = [];
  const cells = [];
  for (const rm of String(xml || '').matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rAttr = xmlAttr(`<row ${rm[1] || rm[3] || ''}>`, 'r');
    const rowIndex = rAttr ? Number(rAttr) - 1 : rows.length;
    const line = [];
    let nextCol = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const open = `<c ${cm[1]}>`;
      const ref = xmlAttr(open, 'r');
      const col = ref ? colIndex(ref.replace(/\d+$/, '').replace(/\$/g, '')) : nextCol;
      nextCol = col + 1;
      const type = xmlAttr(open, 't');
      const inner = cm[2] || '';
      let value = '';
      if (type === 's') {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? (shared[Number(v[1])] ?? '') : '';
      } else if (type === 'inlineStr') {
        const is = inner.match(/<is>([\s\S]*?)<\/is>/);
        value = is ? xmlItemText(is[1]) : '';
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? unescXml(v[1]) : '';
        if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
      }
      line[col] = value;
      const vm = xmlAttr(open, 'vm');
      const f = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
      if (vm || f) cells.push({ row: rowIndex, col, vm: vm ? Number(vm) : null, formula: f ? unescXml(f[1]) : null, type });
    }
    rows[rowIndex] = Array.from({ length: line.length }, (_, i) => line[i] ?? '');
  }
  return { rows: Array.from({ length: rows.length }, (_, i) => rows[i] || []), cells };
}

// ── parts and their relationships ───────────────────────────────────────────────────────────
// "xl/worksheets/sheet1.xml" → "xl/worksheets/_rels/sheet1.xml.rels"
export const relsPathOf = (part) => part.replace(/([^/]*)$/, '_rels/$1.rels');
// A relationship's target against the part it belongs to ("../media/image1.png" from
// "xl/drawings/drawing1.xml" → "xl/media/image1.png"; "/xl/media/x.png" → "xl/media/x.png").
export function resolvePart(fromPart, target) {
  const t = String(target || '');
  if (t.startsWith('/')) return t.slice(1);
  const base = fromPart.split('/').slice(0, -1);
  for (const seg of t.split('/')) {
    if (seg === '..') base.pop();
    else if (seg && seg !== '.') base.push(seg);
  }
  return base.join('/');
}
// A .rels part → Map id → { target, type, external }.
export function readRels(xml) {
  const out = new Map();
  for (const m of String(xml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    out.set(xmlAttr(m[0], 'Id'), {
      target: xmlAttr(m[0], 'Target') || '',
      type: xmlAttr(m[0], 'Type') || '',
      external: /^external$/i.test(xmlAttr(m[0], 'TargetMode') || ''),
    });
  }
  return out;
}
// The workbook's sheets, in order: [{ name, path }].
export function workbookSheets(workbookXml, workbookRelsXml) {
  const rels = readRels(workbookRelsXml);
  const out = [];
  for (const m of String(workbookXml || '').matchAll(/<sheet\b[^>]*\/?>/g)) {
    const rel = rels.get(xmlAttr(m[0], 'r:id'));
    if (!rel) continue;
    out.push({ name: xmlAttr(m[0], 'name') || '', path: resolvePart('xl/workbook.xml', rel.target) });
  }
  return out;
}

// ── links ───────────────────────────────────────────────────────────────────────────────────
// An http(s) address as a picture's link may be written: trimmed, one line, at most 2,000 characters.
export function webLink(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 2000 || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}
// The address an IMAGE("…") formula shows (Excel writes `_xlfn.IMAGE`), or null.
export function imageFormulaLink(formula) {
  const m = /\bIMAGE\(\s*"((?:[^"]|"")*)"/i.exec(String(formula || ''));
  return m ? webLink(m[1].replace(/""/g, '"')) : null;
}

// ── pictures ────────────────────────────────────────────────────────────────────────────────
// A picture's kind from its first bytes (what the browser can draw), else from its name.
export function pictureType(bytes, name = '') {
  const b = asBytes(bytes);
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1] || '';
  return { emf: 'image/x-emf', wmf: 'image/x-wmf', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml' }[ext.toLowerCase()] || 'application/octet-stream';
}
// The kinds every browser draws (and so the import can shrink and store).
export const DRAWABLE_PICTURES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

// Pictures placed IN cells (Excel 365 "Place in Cell", and IMAGE() web images): value-metadata
// index (1-based, the cell's `vm`) → { media: part } | { link: url }.
async function inCellPictures(textOf, workbookRels) {
  const partOfType = (suffix, fallback) => {
    for (const rel of workbookRels.values()) if (rel.type.toLowerCase().endsWith(suffix.toLowerCase())) return resolvePart('xl/workbook.xml', rel.target);
    return fallback;
  };
  const metadataXml = await textOf(partOfType('/sheetMetadata', 'xl/metadata.xml'));
  if (!metadataXml) return new Map();
  const valuesPart = partOfType('/rdRichValue', 'xl/richData/rdrichvalue.xml');
  const structuresPart = partOfType('/rdRichValueStructure', 'xl/richData/rdrichvaluestructure.xml');
  const relsPart = partOfType('/richValueRel', 'xl/richData/richValueRel.xml');
  const webPart = partOfType('/rdRichValueWebImage', 'xl/richData/rdRichValueWebImage.xml');
  const [valuesXml, structuresXml, relXml] = await Promise.all([textOf(valuesPart), textOf(structuresPart), textOf(relsPart)]);
  if (!valuesXml || !structuresXml) return new Map();

  // metadataTypes (1-based) → which is the rich value type; futureMetadata XLRICHVALUE bk → rv index.
  const types = elements(firstText(metadataXml, 'metadataTypes') || '', 'metadataType').map((t) => xmlAttr(`<x ${t.attrs}>`, 'name'));
  const richType = types.indexOf('XLRICHVALUE') + 1;
  const future = elements(metadataXml, 'futureMetadata').find((f) => xmlAttr(`<x ${f.attrs}>`, 'name') === 'XLRICHVALUE');
  const rvbOf = future ? elements(future.inner, 'bk').map((bk) => {
    const rvb = elements(bk.inner, 'rvb')[0];
    return rvb ? Number(xmlAttr(`<x ${rvb.attrs}>`, 'i')) : null;
  }) : [];
  const valueMeta = elements(firstText(metadataXml, 'valueMetadata') || '', 'bk').map((bk) => {
    const rc = elements(bk.inner, 'rc')[0];
    return rc ? { t: Number(xmlAttr(`<x ${rc.attrs}>`, 't')), v: Number(xmlAttr(`<x ${rc.attrs}>`, 'v')) } : null;
  });

  const structures = elements(structuresXml, 's').map((s) => ({
    type: xmlAttr(`<x ${s.attrs}>`, 't') || '',
    keys: elements(s.inner, 'k').map((k) => xmlAttr(`<x ${k.attrs}>`, 'n') || ''),
  }));
  const values = elements(valuesXml, 'rv').map((rv) => ({
    s: Number(xmlAttr(`<x ${rv.attrs}>`, 's')),
    v: elements(rv.inner, 'v').map((x) => unescXml(x.inner)),
  }));
  const relIds = relXml ? elements(relXml, 'rel').map((r) => xmlAttr(`<x ${r.attrs}>`, 'r:id')) : [];
  const relTargets = readRels(relXml ? await textOf(relsPathOf(relsPart)) : '');
  let webAddresses = null;
  const webLinks = async () => {
    if (webAddresses) return webAddresses;
    const xml = await textOf(webPart);
    const rels = readRels(xml ? await textOf(relsPathOf(webPart)) : '');
    webAddresses = elements(xml || '', 'webImageSrd').map((w) => {
      const address = elements(w.inner, 'address')[0];
      const rel = address ? rels.get(xmlAttr(`<x ${address.attrs}>`, 'r:id')) : null;
      return rel ? webLink(rel.target) : null;
    });
    return webAddresses;
  };

  const out = new Map();
  for (let i = 0; i < valueMeta.length; i += 1) {
    const rc = valueMeta[i];
    if (!rc || rc.t !== richType) continue;
    const rvIndex = rvbOf[rc.v];
    const rv = Number.isInteger(rvIndex) ? values[rvIndex] : null;
    const st = rv ? structures[rv.s] : null;
    if (!st) continue;
    const local = st.keys.indexOf('_rvRel:LocalImageIdentifier');
    if (local >= 0) {
      const rel = relTargets.get(relIds[Number(rv.v[local])]);
      if (rel && !rel.external) out.set(i + 1, { media: resolvePart(relsPart, rel.target) });
      continue;
    }
    const web = st.keys.indexOf('WebImageIdentifier');
    if (web >= 0) {
      const url = (await webLinks())[Number(rv.v[web])];
      if (url) out.set(i + 1, { link: url });
    }
  }
  return out;
}

// Pictures floating over the sheet, by the cell their top-left corner sits in.
async function floatingPictures(textOf, sheetPath, sheetRels) {
  const out = [];
  for (const rel of sheetRels.values()) {
    if (!/\/drawing$/i.test(rel.type) || rel.external) continue;
    const drawingPath = resolvePart(sheetPath, rel.target);
    const xml = await textOf(drawingPath);
    if (!xml) continue;
    const rels = readRels(await textOf(relsPathOf(drawingPath)));
    for (const kind of ['twoCellAnchor', 'oneCellAnchor']) {
      for (const anchor of elements(xml, kind)) {
        const from = elements(anchor.inner, 'from')[0];
        if (!from) continue;
        const col = Number(firstText(from.inner, 'col'));
        const row = Number(firstText(from.inner, 'row'));
        if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
        for (const pic of elements(anchor.inner, 'pic')) {
          const blip = elements(pic.inner, 'blip')[0];
          if (!blip) continue;
          const embed = xmlAttr(`<x ${blip.attrs}>`, 'r:embed');
          const link = xmlAttr(`<x ${blip.attrs}>`, 'r:link');
          const relOf = rels.get(embed || link);
          if (!relOf) continue;
          if (relOf.external) {
            const url = webLink(relOf.target);
            if (url) out.push({ row, col, link: url, source: 'floating' });
          } else {
            out.push({ row, col, media: resolvePart(drawingPath, relOf.target), source: 'floating' });
          }
        }
      }
    }
  }
  // One picture written twice (an mc:AlternateContent's Choice and its Fallback) is one picture.
  const seen = new Set();
  return out.filter((p) => {
    const k = `${p.row}|${p.col}|${p.media || p.link}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Hyperlinked cells: [{ row, col, link }] (http and https only).
function hyperlinks(sheetXml, sheetRels) {
  const out = [];
  for (const h of elements(sheetXml, 'hyperlink')) {
    const tag = `<x ${h.attrs}>`;
    const rel = sheetRels.get(xmlAttr(tag, 'r:id'));
    const url = rel && rel.external ? webLink(rel.target) : null;
    const at = cellRef((xmlAttr(tag, 'ref') || '').split(':')[0]);
    if (url && at) out.push({ ...at, link: url });
  }
  return out;
}

// READ A WORKBOOK'S FIRST SHEET: bytes → {
//   sheet,                           its name
//   rows,                            string[][] by sheet row (0 = the first row)
//   pictures: [{ row, col, source: 'cell' | 'floating', bytes, type, name }]
//   links:    [{ row, col, source: 'image-formula' | 'web-image' | 'floating' | 'hyperlink', url }]
// }. Throws XlsxError('not_xlsx' | 'damaged' | 'zip64' | 'too_large' | 'no_sheet').
export async function readWorkbook(input) {
  const bytes = asBytes(input);
  if (!isZip(bytes)) throw new XlsxError('not_xlsx', 'not an .xlsx workbook');
  const dir = zipDirectory(bytes);
  const dec = new TextDecoder('utf-8');
  const textCache = new Map();
  const textOf = async (name) => {
    if (!name) return null;
    if (!textCache.has(name)) textCache.set(name, zipEntry(bytes, dir, name).then((b) => (b ? dec.decode(b) : null)));
    return textCache.get(name);
  };
  const workbookXml = await textOf('xl/workbook.xml');
  if (!workbookXml) throw new XlsxError('not_xlsx', 'not an .xlsx workbook (xl/workbook.xml is missing)');
  const workbookRelsXml = await textOf('xl/_rels/workbook.xml.rels');
  const [first] = workbookSheets(workbookXml, workbookRelsXml);
  const sheetXml = first ? await textOf(first.path) : null;
  if (!sheetXml) throw new XlsxError('no_sheet', 'the workbook has no sheet');
  const shared = sharedStrings(await textOf('xl/sharedStrings.xml'));
  const { rows, cells } = readSheetXml(sheetXml, shared);
  const sheetRels = readRels(await textOf(relsPathOf(first.path)));

  const pictures = [];
  const links = [];
  const mediaBytes = new Map();
  const loadMedia = async (part) => {
    if (!mediaBytes.has(part)) mediaBytes.set(part, zipEntry(bytes, dir, part));
    return mediaBytes.get(part);
  };
  const addPicture = async (at, part, source) => {
    const data = await loadMedia(part);
    if (data && data.length) pictures.push({ ...at, source, bytes: data, type: pictureType(data, part), name: part.split('/').pop() });
  };

  const inCell = cells.some((c) => c.vm) ? await inCellPictures(textOf, readRels(workbookRelsXml)) : new Map();
  for (const c of cells) {
    const at = { row: c.row, col: c.col };
    const pic = c.vm ? inCell.get(c.vm) : null;
    if (pic && pic.media) await addPicture(at, pic.media, 'cell');
    else if (pic && pic.link) links.push({ ...at, source: 'web-image', url: pic.link });
    else {
      const url = imageFormulaLink(c.formula);
      if (url) links.push({ ...at, source: 'image-formula', url });
    }
    // A cell holding a picture shows an error value (#VALUE!) as its text; the picture is its value.
    if ((pic || imageFormulaLink(c.formula)) && rows[c.row]) rows[c.row][c.col] = '';
  }
  for (const f of await floatingPictures(textOf, first.path, sheetRels)) {
    if (f.media) await addPicture({ row: f.row, col: f.col }, f.media, 'floating');
    else links.push({ row: f.row, col: f.col, source: 'floating', url: f.link });
  }
  for (const h of hyperlinks(sheetXml, sheetRels)) links.push({ ...h, source: 'hyperlink', url: h.link });
  return { sheet: first.name, rows, pictures, links };
}

// ── writing a small workbook ────────────────────────────────────────────────────────────────
// One sheet: a bold header row (frozen), then empty rows `rowHeight` points tall so a pasted
// picture fits its cell. columns: [{ header, width, text?: true (the column is formatted as Text, so
// "00123" keeps its zeros), money?: true }] → Uint8Array (.xlsx).
export function templateWorkbook({ sheet = 'Sheet1', columns, rowHeight = 60 }) {
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const styleOf = (c) => (c.text ? 2 : c.money ? 3 : 0);
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" style="${styleOf(c)}" customWidth="1"/>`).join('');
  const head = `<row r="1" ht="22" customHeight="1">${columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${escXml(c.header)}</t></is></c>`).join('')}</row>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="${rowHeight}" customHeight="1"/>
<cols>${cols}</cols>
<sheetData>${head}</sheetData>
</worksheet>`;
  const name = escXml(String(sheet).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  return storedZip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ]);
}
