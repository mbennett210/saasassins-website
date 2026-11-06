// The browser's Excel reader (src/lib/xlsx.js) — task #257, Supplies → Catalog → Import items: "six
// columns starting with photo" from a spreadsheet, "hundreds of items". Every workbook here is built
// to the file format as Excel writes it (ECMA-376, and Microsoft's richData parts for a picture
// placed in a cell), zipped both ways a workbook comes (deflated, as Excel and Google Sheets write
// it; stored, as the template is):
//
//   A  cells: shared and inline strings, rich-text runs, numbers, booleans, sparse rows and cells
//   B  a picture placed IN a cell (Excel's "Place in Cell": vm → metadata → richData → media)
//   C  a picture FLOATING over the sheet, by the cell its top-left corner sits in (and one written
//      twice as an mc:AlternateContent's Choice and Fallback is one picture)
//   D  links: IMAGE("…") formulas, a web image in a cell, a linked floating picture, hyperlinks
//   E  a picture no browser draws (EMF), two pictures on one row
//   F  the template: written, then read back (the six headers, in the call's order)
//   G  what is not a workbook: an old .xls, a CSV, a damaged ZIP
//
//   node app/scripts/test-xlsx-read.mjs
import { zip } from './xlsx-lib.mjs';
import {
  readWorkbook, isZip, isLegacyXls, storedZip, pictureType, DRAWABLE_PICTURES, templateWorkbook, XlsxError,
} from '../src/lib/xlsx.js';
import { catalogTemplateXlsx, CATALOG_TEMPLATE_HEADERS } from '../src/lib/supplyCatalogImport.js';

let passed = 0;
const failed = [];
function ok(label, cond, detail = '') {
  if (cond) passed += 1;
  else failed.push(`${label}${detail ? ` — ${detail}` : ''}`);
}
const section = (s) => console.log(`\n${s}`);

// ── fixtures ──────────────────────────────────────────────────────────────────────────────
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9]);
const EMF = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6C, 0x00, 0x00, 0x00]);

const rel = (id, type, target, external = false) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
const rels = (list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}">${list.join('')}</Relationships>`;

// A workbook: one sheet named `sheetName` (or two, `secondSheet` after it), optional shared strings,
// and any extra parts (pictures, drawings, rich data) with the workbook's extra relationships.
function book({ sheet, shared = null, sheetRels = [], workbookRels = [], parts = [], sheetName = 'Products', secondSheet = null, stored = false }) {
  const sheetsXml = [`<sheet name="${sheetName}" sheetId="1" r:id="rId1"/>`];
  const wbRels = [rel('rId1', `${R}/worksheet`, 'worksheets/sheet1.xml')];
  if (secondSheet) {
    sheetsXml.push('<sheet name="Other" sheetId="2" r:id="rId2"/>');
    wbRels.push(rel('rId2', `${R}/worksheet`, 'worksheets/sheet2.xml'));
  }
  if (shared) wbRels.push(rel('rIdS', `${R}/sharedStrings`, 'sharedStrings.xml'));
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>` },
    { name: '_rels/.rels', data: rels([rel('rId1', `${R}/officeDocument`, 'xl/workbook.xml')]) },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${R}"><sheets>${sheetsXml.join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([...wbRels, ...workbookRels]) },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${R}">${sheet}</worksheet>` },
  ];
  if (secondSheet) entries.push({ name: 'xl/worksheets/sheet2.xml', data: `<worksheet xmlns="${NS}">${secondSheet}</worksheet>` });
  if (shared) entries.push({ name: 'xl/sharedStrings.xml', data: `<sst xmlns="${NS}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => (s.startsWith('<') ? `<si>${s}</si>` : `<si><t>${s}</t></si>`)).join('')}</sst>` });
  if (sheetRels.length) entries.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels(sheetRels) });
  entries.push(...parts);
  if (stored) return storedZip(entries.map((e) => ({ name: e.name, data: typeof e.data === 'string' ? new TextEncoder().encode(e.data) : new Uint8Array(e.data) })));
  return new Uint8Array(zip(entries));
}
const headerRow = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>';
const SHARED = ['Photo', 'SKU', 'Item'];

// The richData parts for pictures placed in cells: `images` are media names (in order: rich value 0,
// 1, …), `webImages` addresses (rich values after the local images).
function inCellParts(images = [], webImages = []) {
  const n = images.length + webImages.length;
  const bks = Array.from({ length: n }, (_, i) => `<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="${i}"/></ext></extLst></bk>`).join('');
  const vbks = Array.from({ length: n }, (_, i) => `<bk><rc t="1" v="${i}"/></bk>`).join('');
  const RD = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata';
  const parts = [
    { name: 'xl/metadata.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<metadata xmlns="${NS}" xmlns:xlrd="${RD}"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes><futureMetadata name="XLRICHVALUE" count="${n}">${bks}</futureMetadata><valueMetadata count="${n}">${vbks}</valueMetadata></metadata>` },
    { name: 'xl/richData/rdrichvalue.xml', data: `<rvData xmlns="${RD}" count="${n}">${images.map((_, i) => `<rv s="0"><v>${i}</v><v>5</v></rv>`).join('')}${webImages.map((_, i) => `<rv s="1"><v>${i}</v><v>1</v></rv>`).join('')}</rvData>` },
    { name: 'xl/richData/rdrichvaluestructure.xml', data: `<rvStructures xmlns="${RD}" count="2"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s><s t="_webimage"><k n="WebImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>` },
    { name: 'xl/richData/richValueRel.xml', data: `<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="${R}">${images.map((_, i) => `<rel r:id="rId${i + 1}"/>`).join('')}</richValueRels>` },
    { name: 'xl/richData/_rels/richValueRel.xml.rels', data: rels(images.map((m, i) => rel(`rId${i + 1}`, `${R}/image`, `../media/${m}`))) },
  ];
  if (webImages.length) {
    parts.push({ name: 'xl/richData/rdRichValueWebImage.xml', data: `<webImagesSrd xmlns="http://schemas.microsoft.com/office/spreadsheetml/2020/richdatawebimage" xmlns:r="${R}">${webImages.map((_, i) => `<webImageSrd><address r:id="rIdW${i + 1}"/><moreImagesAddress r:id="rIdM${i + 1}"/></webImageSrd>`).join('')}</webImagesSrd>` });
    parts.push({ name: 'xl/richData/_rels/rdRichValueWebImage.xml.rels', data: rels(webImages.flatMap((u, i) => [rel(`rIdW${i + 1}`, `${R}/hyperlink`, u, true), rel(`rIdM${i + 1}`, `${R}/hyperlink`, 'https://www.bing.com/images', true)])) });
  }
  const workbookRels = [
    rel('rIdM', `${R}/sheetMetadata`, 'metadata.xml'),
    rel('rIdRV', 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue', 'richData/rdrichvalue.xml'),
    rel('rIdRS', 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure', 'richData/rdrichvaluestructure.xml'),
    rel('rIdRR', 'http://schemas.microsoft.com/office/2022/10/relationships/richValueRel', 'richData/richValueRel.xml'),
    ...(webImages.length ? [rel('rIdRW', 'http://schemas.microsoft.com/office/2020/07/relationships/rdRichValueWebImage', 'richData/rdRichValueWebImage.xml')] : []),
  ];
  return { parts, workbookRels };
}

// A drawing with floating pictures: [{ col, row, media? (a name in xl/media), link? (external), twice? }].
function drawingParts(pics) {
  const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const pic = (p, i) => `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Picture ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip ${p.link ? `r:link="rIdP${i}"` : `r:embed="rIdP${i}"`}/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
  const anchor = (p, i) => {
    const body = `<xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>9525</xdr:rowOff></xdr:from><xdr:to><xdr:col>${p.col + 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`;
    const inner = p.twice
      ? `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="a14">${pic(p, i)}</mc:Choice><mc:Fallback>${pic(p, i)}</mc:Fallback></mc:AlternateContent>`
      : pic(p, i);
    return `<xdr:twoCellAnchor editAs="oneCell">${body}${inner}<xdr:clientData/></xdr:twoCellAnchor>`;
  };
  return [
    { name: 'xl/drawings/drawing1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">${pics.map(anchor).join('')}</xdr:wsDr>` },
    { name: 'xl/drawings/_rels/drawing1.xml.rels', data: rels(pics.map((p, i) => (p.link ? rel(`rIdP${i}`, `${R}/image`, p.link, true) : rel(`rIdP${i}`, `${R}/image`, `../media/${p.media}`)))) },
  ];
}

// ── A cells ───────────────────────────────────────────────────────────────────────────────
section('A  cells');
for (const stored of [false, true]) {
  const how = stored ? 'stored' : 'deflated';
  const wb = await readWorkbook(book({
    stored,
    shared: [...SHARED, '<r><rPr><b/></rPr><t>Glass </t></r><r><t>cleaner</t></r><rPh sb="0" eb="1"><t>X</t></rPh>', 'Tom &amp; Jerry’s'],
    sheet: `<sheetData>${headerRow}
      <row r="2"><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>3</v></c><c r="D2"><v>12.5</v></c></row>
      <row r="4"><c r="C4" t="inlineStr"><is><t>Mop &lt;large&gt;</t></is></c><c r="E4" t="b"><v>1</v></c></row>
      <row r="5"><c t="inlineStr"><is><t>no ref</t></is></c><c t="str"><f>A5</f><v>formula text</v></c></row>
      <row r="6" spans="1:3"/>
    </sheetData>`,
  }));
  ok(`A1 (${how}) the first sheet's name`, wb.sheet === 'Products', wb.sheet);
  ok(`A2 (${how}) the header row`, JSON.stringify(wb.rows[0]) === JSON.stringify(SHARED), JSON.stringify(wb.rows[0]));
  ok(`A3 (${how}) shared, rich-text (no phonetic run) and escaped strings`, wb.rows[1][1] === 'Tom & Jerry’s' && wb.rows[1][2] === 'Glass cleaner', JSON.stringify(wb.rows[1]));
  ok(`A4 (${how}) a number cell reads as its text`, wb.rows[1][3] === '12.5', wb.rows[1][3]);
  ok(`A5 (${how}) a skipped row is empty, a sparse row keeps its columns`, wb.rows[2].length === 0 && wb.rows[3][2] === 'Mop <large>' && wb.rows[3][0] === '' && wb.rows[3][4] === 'TRUE', JSON.stringify(wb.rows.slice(2, 4)));
  ok(`A6 (${how}) cells with no ref take the next column; a formula's cached text`, wb.rows[4][0] === 'no ref' && wb.rows[4][1] === 'formula text', JSON.stringify(wb.rows[4]));
  ok(`A7 (${how}) no pictures, no links in a plain sheet`, wb.pictures.length === 0 && wb.links.length === 0);
}
{
  const wb = await readWorkbook(book({ sheet: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row></sheetData>`, secondSheet: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>second</t></is></c></row></sheetData>` }));
  ok('A8 only the FIRST sheet is read', wb.rows[0][0] === 'first', JSON.stringify(wb.rows));
}

// ── B in-cell pictures ────────────────────────────────────────────────────────────────────
section('B  a picture placed in a cell');
{
  const { parts, workbookRels } = inCellParts(['image1.png', 'image2.jpeg']);
  const wb = await readWorkbook(book({
    shared: SHARED,
    sheet: `<sheetData>${headerRow}
      <row r="2"><c r="A2" t="e" vm="1"><v>#VALUE!</v></c><c r="B2" t="inlineStr"><is><t>GC-1</t></is></c></row>
      <row r="3"><c r="A3" t="e" vm="2"><v>#VALUE!</v></c><c r="B3" t="inlineStr"><is><t>MP-2</t></is></c></row>
      <row r="4"><c r="A4" t="e" vm="1"><v>#VALUE!</v></c></row>
    </sheetData>`,
    workbookRels,
    parts: [...parts, { name: 'xl/media/image1.png', data: PNG }, { name: 'xl/media/image2.jpeg', data: JPEG }],
  }));
  const at = (row) => wb.pictures.filter((p) => p.row === row);
  ok('B1 each in-cell picture is found, on its own row and column', wb.pictures.length === 3 && at(1).length === 1 && at(1)[0].col === 0 && at(2)[0].col === 0, JSON.stringify(wb.pictures.map(({ row, col, source }) => ({ row, col, source }))));
  ok('B2 its kind is read from its bytes', at(1)[0].type === 'image/png' && at(2)[0].type === 'image/jpeg', `${at(1)[0]?.type} ${at(2)[0]?.type}`);
  ok('B3 it is marked as a picture in a cell, with its bytes', at(1)[0].source === 'cell' && at(1)[0].bytes.length === PNG.length);
  ok('B4 the same picture used twice is found on both rows', at(3).length === 1 && at(3)[0].name === 'image1.png');
  ok('B5 a picture cell\'s #VALUE! text is blanked', wb.rows[1][0] === '' && wb.rows[2][0] === '', JSON.stringify(wb.rows[1]));
  ok('B6 the row\'s other cells are read', wb.rows[1][1] === 'GC-1' && wb.rows[2][1] === 'MP-2');
}
{
  // An in-cell picture whose relationships are named by type only (no default part names).
  const { parts, workbookRels } = inCellParts(['photo.png']);
  const moved = parts.map((p) => ({ ...p, name: p.name.replace('xl/richData/rdrichvalue.xml', 'xl/richData/values.xml') }));
  const wb = await readWorkbook(book({
    sheet: '<sheetData><row r="1"><c r="A1" t="e" vm="1"><v>#VALUE!</v></c></row></sheetData>',
    workbookRels: workbookRels.map((r) => r.replace('richData/rdrichvalue.xml', 'richData/values.xml')),
    parts: [...moved, { name: 'xl/media/photo.png', data: PNG }],
  }));
  ok('B7 the rich-data parts are found by their relationship type', wb.pictures.length === 1 && wb.pictures[0].name === 'photo.png', JSON.stringify(wb.pictures.map((p) => p.name)));
}

// ── C floating pictures ───────────────────────────────────────────────────────────────────
section('C  a picture floating over the sheet');
{
  const wb = await readWorkbook(book({
    shared: SHARED,
    sheet: `<sheetData>${headerRow}<row r="2"><c r="C2" t="inlineStr"><is><t>Glass cleaner</t></is></c></row><row r="3"><c r="C3" t="inlineStr"><is><t>Mop</t></is></c></row></sheetData><drawing r:id="rIdD"/>`,
    sheetRels: [rel('rIdD', `${R}/drawing`, '../drawings/drawing1.xml')],
    parts: [...drawingParts([{ col: 0, row: 1, media: 'image1.png' }, { col: 0, row: 2, media: 'image2.jpeg', twice: true }]), { name: 'xl/media/image1.png', data: PNG }, { name: 'xl/media/image2.jpeg', data: JPEG }],
  }));
  ok('C1 a floating picture belongs to the cell its top-left corner sits in', wb.pictures.some((p) => p.row === 1 && p.col === 0 && p.source === 'floating' && p.type === 'image/png'), JSON.stringify(wb.pictures.map(({ row, col, source, type }) => ({ row, col, source, type }))));
  ok('C2 one written as a Choice and its Fallback is ONE picture', wb.pictures.filter((p) => p.row === 2).length === 1);
  ok('C3 the rows\' text is untouched', wb.rows[1][2] === 'Glass cleaner' && wb.rows[2][2] === 'Mop');
}

// ── D links ───────────────────────────────────────────────────────────────────────────────
section('D  links');
{
  const { parts, workbookRels } = inCellParts([], ['https://img.example.com/web.png']);
  const wb = await readWorkbook(book({
    shared: SHARED,
    sheet: `<sheetData>${headerRow}
      <row r="2"><c r="A2" t="e"><f>_xlfn.IMAGE("https://cdn.example.com/a.png?x=1&amp;y=""2""")</f><v>#VALUE!</v></c></row>
      <row r="3"><c r="A3" t="e" vm="1"><v>#VALUE!</v></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>See the picture</t></is></c></row>
      <row r="5"><c r="A5" t="e"><f>IMAGE("javascript:alert(1)")</f><v>#VALUE!</v></c></row>
      <row r="6"><c r="A6" t="inlineStr"><is><t>bad link</t></is></c></row>
    </sheetData><drawing r:id="rIdD"/><hyperlinks><hyperlink ref="A4" r:id="rIdH"/><hyperlink ref="A6" r:id="rIdF"/><hyperlink ref="B6" location="Sheet1!A1"/></hyperlinks>`,
    sheetRels: [rel('rIdD', `${R}/drawing`, '../drawings/drawing1.xml'), rel('rIdH', `${R}/hyperlink`, 'https://shop.example.com/p/4.jpg', true), rel('rIdF', `${R}/hyperlink`, 'file:///C:/pics/mop.jpg', true)],
    workbookRels,
    parts: [...parts, ...drawingParts([{ col: 0, row: 6, link: 'https://img.example.com/linked.jpg' }])],
  }));
  const of = (row) => wb.links.filter((l) => l.row === row);
  ok('D1 an IMAGE() formula is a link, its quotes and & read', of(1).length === 1 && of(1)[0].source === 'image-formula' && of(1)[0].url === 'https://cdn.example.com/a.png?x=1&y=%222%22', JSON.stringify(of(1)));
  ok('D2 an IMAGE() cell\'s #VALUE! text is blanked', wb.rows[1][0] === '');
  ok('D3 a web image placed in a cell is its address', of(2).length === 1 && of(2)[0].source === 'web-image' && of(2)[0].url === 'https://img.example.com/web.png', JSON.stringify(of(2)));
  ok('D4 a hyperlinked cell is a link; its text stays', of(3).length === 1 && of(3)[0].source === 'hyperlink' && wb.rows[3][0] === 'See the picture', JSON.stringify(of(3)));
  ok('D5 a javascript: IMAGE(), a file: hyperlink and an in-book link are not links', of(4).length === 0 && of(5).length === 0, JSON.stringify(wb.links));
  ok('D6 a linked (not embedded) floating picture is a link', of(6).length === 1 && of(6)[0].source === 'floating' && of(6)[0].url === 'https://img.example.com/linked.jpg', JSON.stringify(of(6)));
  ok('D7 no picture bytes come from links', wb.pictures.length === 0);
}

// ── E pictures no browser draws, two on a row ─────────────────────────────────────────────
section('E  awkward pictures');
{
  const { parts, workbookRels } = inCellParts(['image1.emf']);
  const wb = await readWorkbook(book({
    sheet: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Photo</t></is></c></row><row r="2"><c r="A2" t="e" vm="1"><v>#VALUE!</v></c></row><row r="3"><c r="C3" t="inlineStr"><is><t>Two</t></is></c></row></sheetData><drawing r:id="rIdD"/>`,
    sheetRels: [rel('rIdD', `${R}/drawing`, '../drawings/drawing1.xml')],
    workbookRels,
    parts: [...parts, ...drawingParts([{ col: 0, row: 2, media: 'a.png' }, { col: 1, row: 2, media: 'b.jpeg' }]), { name: 'xl/media/image1.emf', data: EMF }, { name: 'xl/media/a.png', data: PNG }, { name: 'xl/media/b.jpeg', data: JPEG }],
  }));
  const emf = wb.pictures.find((p) => p.row === 1);
  ok('E1 an EMF picture is found, and its kind is one no browser draws', emf && emf.type === 'image/x-emf' && !DRAWABLE_PICTURES.has(emf.type), emf && emf.type);
  ok('E2 two pictures on one row are both found, each in its column', wb.pictures.filter((p) => p.row === 2).map((p) => p.col).sort().join() === '0,1');
  ok('E3 a picture\'s kind comes from its bytes, never its name', pictureType(PNG, 'x.jpeg') === 'image/png' && pictureType(JPEG, 'x.png') === 'image/jpeg' && pictureType(Buffer.from('GIF89a'), '') === 'image/gif' && pictureType(Buffer.from([1, 2, 3]), 'x.tiff') === 'image/tiff');
}

// ── F the template ────────────────────────────────────────────────────────────────────────
section('F  the template');
{
  const bytes = catalogTemplateXlsx();
  ok('F1 the template is a ZIP', isZip(bytes) && !isLegacyXls(bytes));
  const wb = await readWorkbook(bytes);
  ok('F2 its six headers, in the call\'s order', JSON.stringify(wb.rows[0]) === JSON.stringify(['Photo', 'SKU', 'Item', 'Category', 'How it comes', 'Price']) && JSON.stringify(CATALOG_TEMPLATE_HEADERS) === JSON.stringify(wb.rows[0]), JSON.stringify(wb.rows[0]));
  ok('F3 its sheet is named for the catalog', wb.sheet === 'Supply catalog', wb.sheet);
  const dec = new TextDecoder();
  const { zipDirectory, zipEntry } = await import('../src/lib/xlsx.js');
  const dir = zipDirectory(bytes);
  const sheet = dec.decode(await zipEntry(bytes, dir, 'xl/worksheets/sheet1.xml'));
  const styles = dec.decode(await zipEntry(bytes, dir, 'xl/styles.xml'));
  ok('F4 the header row is frozen and the rows are tall enough for a picture', /<pane[^>]*ySplit="1"[^>]*state="frozen"/.test(sheet) && /defaultRowHeight="60"/.test(sheet), sheet.slice(0, 400));
  ok('F5 the SKU column is formatted as Text (keeps leading zeros), the price as money', /numFmtId="49"/.test(styles) && /formatCode="#,##0\.00"/.test(styles));
  const custom = templateWorkbook({ sheet: 'A & B', columns: [{ header: 'x<y', width: 10 }] });
  const back = await readWorkbook(custom);
  ok('F6 a header and sheet name with XML characters survive', back.rows[0][0] === 'x<y' && back.sheet === 'A & B', JSON.stringify(back));
}

// ── G not a workbook ──────────────────────────────────────────────────────────────────────
section('G  what is not a workbook');
{
  const xls = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]);
  ok('G1 an old .xls is recognised (and is not a ZIP)', isLegacyXls(xls) && !isZip(xls));
  const csv = new TextEncoder().encode('SKU,Item\nA,B\n');
  ok('G2 a CSV is neither', !isZip(csv) && !isLegacyXls(csv));
  let code = null;
  try { await readWorkbook(csv); } catch (e) { code = e instanceof XlsxError ? e.code : 'other'; }
  ok('G3 reading a CSV as a workbook says not_xlsx', code === 'not_xlsx', code);
  const good = book({ sheet: '<sheetData/>' });
  const cut = good.slice(0, Math.floor(good.length / 2));
  code = null;
  try { await readWorkbook(cut); } catch (e) { code = e instanceof XlsxError ? e.code : `other:${e.message}`; }
  ok('G4 a cut-off workbook is refused as damaged, never misread', code === 'damaged' || code === 'not_xlsx', code);
  const noBook = new Uint8Array(zip([{ name: 'word/document.xml', data: '<w/>' }]));
  code = null;
  try { await readWorkbook(noBook); } catch (e) { code = e instanceof XlsxError ? e.code : 'other'; }
  ok('G5 a ZIP that is not a workbook (a Word file) says not_xlsx', code === 'not_xlsx', code);
}

console.log(`\ntest-xlsx-read: ${passed}/${passed + failed.length} passed`);
if (failed.length) {
  console.log(`\n✖ ${failed.length} failed:`);
  for (const f of failed) console.log(`  - ${f}`);
  process.exitCode = 1;
}
