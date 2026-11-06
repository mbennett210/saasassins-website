// CS-193 / LANG-5 — the translator's spreadsheet goes out and comes back.
//
//   1. `npm run i18n:export` writes ONE .xlsx: a Read me, a Translate sheet (key, English,
//      where it shows, length limit, placeholders and what they stand for, notes, a Spanish
//      and a Creole column) and a Glossary — read back here with the same reader the import
//      uses, and checked as a well-formed workbook.
//   2. A "translator" fills it in (test strings, prefixed "ES:" — never real Spanish, and only
//      ever written into a TEMPORARY catalog directory), including the mistakes a real sheet
//      comes back with.
//   3. `npm run i18n:import -- <file> --lang es` loads the good lines, REFUSES the bad ones —
//      a changed placeholder, a dropped bold mark, an unknown key, a line whose English moved
//      after the sheet went out — and writes a catalog the app renders from.
//   4. A re-export shows the loaded lines in the Spanish column; a CSV saved from the sheet
//      imports the same way; and a workbook written the way Excel writes (shared strings) is
//      read correctly.
//
// Offline; writes only under the OS temp directory. Run: node scripts/test-i18n-roundtrip.mjs
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const has = (f) => existsSync(path.join(HERE, f));
ok('the export command exists (scripts/i18n-export.mjs)', has('i18n-export.mjs'));
ok('the import command exists (scripts/i18n-import.mjs)', has('i18n-import.mjs'));
ok('the spreadsheet reader/writer exists (scripts/xlsx-lib.mjs)', has('xlsx-lib.mjs'));
const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
ok('npm run i18n:export is wired', pkg.scripts?.['i18n:export'] === 'node scripts/i18n-export.mjs');
ok('npm run i18n:import is wired', pkg.scripts?.['i18n:import'] === 'node scripts/i18n-import.mjs');

if (has('i18n-export.mjs') && has('i18n-import.mjs') && has('xlsx-lib.mjs')) {
  const xlsx = await import('./xlsx-lib.mjs');
  const lib = await import('./i18n-lib.mjs');
  const exp = await import('./i18n-export.mjs');
  const imp = await import('./i18n-import.mjs');
  const core = await import('../src/i18n/core.js');
  const tmp = mkdtempSync(path.join(tmpdir(), 'cs-i18n-'));
  const realEs = readFileSync(path.join(lib.CATALOG_DIR, 'es.js'), 'utf8');
  try {
    // ── 1. export ─────────────────────────────────────────────────────────────────────
    const out = path.join(tmp, 'translations.xlsx');
    const log = execFileSync(process.execPath, [path.join(HERE, 'i18n-export.mjs'), '--out', out], { encoding: 'utf8' });
    ok('1a: the export writes the file', existsSync(out), log);
    const zipEntries = xlsx.unzip(readFileSync(out));
    ok('1b: it is a real .xlsx package (workbook, styles, three sheets, content types)',
      ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']
        .every((n) => zipEntries.has(n)));
    const sheets = xlsx.readXlsx(out);
    ok('1c: three sheets — Read me, Translate, Glossary', sheets.map((s) => s.name).join('|') === 'Read me|Translate|Glossary');
    const tr = sheets.find((s) => s.name === 'Translate');
    const head = tr.rows[0];
    const col = (name) => head.findIndex((h) => h.toLowerCase().startsWith(name));
    for (const [name, label] of [['key', 'the key'], ['english', 'the English'], ['spanish', 'a Spanish column'], ['haitian creole', 'a Creole column'],
      ['where it shows', 'where it shows'], ['length limit', 'a length limit'], ['placeholders', 'its placeholders'], ['notes', 'notes']]) {
      ok(`1d: the Translate sheet has ${label}`, col(name) >= 0, head.join(' | '));
    }
    const { en } = await lib.loadCatalogs();
    const plurals = Object.values(en).filter((v) => v && typeof v === 'object');
    const expectedLines = Object.keys(en).length - plurals.length + plurals.reduce((n, v) => n + Object.keys(v).length, 0);
    ok('1e: one line per English string, one per plural form', tr.rows.length - 1 === expectedLines, `${tr.rows.length - 1} vs ${expectedLines}`);
    const row = (key, form = '') => tr.rows.find((r) => r[col('key')] === key && (r[col('form')] || '') === form);
    ok('1f: a line carries today\'s English', row('crewHome.hero.allDone')?.[col('english')] === en['crewHome.hero.allDone']);
    ok('1g: …where it shows, by screen', /My Day/.test(row('crewHome.hero.allDone')?.[col('where it shows')] || ''));
    ok('1h: …a hard length limit from the layout where there is one', /characters at most/.test(row('crewHome.stops.viewAll')?.[col('length limit')] || ''));
    ok('1i: …and a soft guide where the text wraps', /wraps/.test(row('crewHome.offline')?.[col('length limit')] || ''));
    ok('1j: …each placeholder and what it stands for', /\{time\} — /.test(row('clock.inSince')?.[col('placeholders')] || ''));
    ok('1k: …a formatted placeholder says how it shows', /\{start, time\} — .*time of day/.test(row('alerts.shiftMissed.body')?.[col('placeholders')] || ''));
    ok('1l: …a plural is one line per form', !!row('crewHome.stopsToday', 'one') && !!row('crewHome.stopsToday', 'other'));
    ok('1m: …and the Creole notes say "short, the icon carries it" where an icon does (LANG-9)',
      /icon/i.test(row('clock.in')?.[col('notes for creole')] || ''));
    const glossary = sheets.find((s) => s.name === 'Glossary');
    ok('1n: the glossary names the app\'s own words', ['clean', 'checklist', 'clock in / clock out', 'supervisor / manager', 'urgent']
      .every((t) => glossary.rows.some((r) => r[0] === t)));

    // ── 2. the translator fills it in (test strings only, into a TEMP catalog) ────────────
    const fill = (key, form, text) => { const r = row(key, form); if (r) r[col('spanish')] = text; return !!r; };
    fill('crewHome.hero.allDone', '', 'ES:My Day');
    fill('clock.inSince', '', 'ES:dentro desde {time}');
    fill('crewHome.stopsToday', 'one', 'ES:{count} limpieza');
    fill('crewHome.stopsToday', 'other', 'ES:{count} limpiezas');
    fill('crewHome.hero.opensAt', '', 'ES:Ahora {hora}');                            // ✖ renamed placeholder
    fill('clock.doneSummary', '', 'ES:Salida · {duration}');                // ✖ dropped the <b> mark
    fill('crewStops.comingUp', '', 'ES:Hoy');
    row('crewStops.comingUp')[col('english')] = 'Today (old wording)';             // ✖ English moved since export
    tr.rows.push(['no.such.key', '', 'Nope', 'ES:Nope']);                   // ✖ unknown key
    fill('crewStops.details', '', '   ');                                      // blank → not translated yet
    const back = path.join(tmp, 'returned.xlsx');
    xlsx.writeXlsx(back, [{ name: 'Translate', columns: head.map((h) => ({ header: h })), rows: tr.rows.slice(1) }]);

    // ── 3. import into a temporary copy of the catalogs ─────────────────────────────────
    const cat = path.join(tmp, 'catalog');
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(cat)}, { recursive: true })`]);
    for (const f of ['en.js', 'ht.js']) copyFileSync(path.join(lib.CATALOG_DIR, f), path.join(cat, f));
    // An EMPTY Spanish catalog to load into: the shipped es.js holds the app's own words since
    // S129, and these checks pin what a sheet does to a catalog that lacks a line.
    writeFileSync(path.join(cat, 'es.js'), 'export default {};\n');
    let imported = '';
    let code = 0;
    try {
      imported = execFileSync(process.execPath, [path.join(HERE, 'i18n-import.mjs'), back, '--lang', 'es', '--catalog-dir', cat], { encoding: 'utf8' });
    } catch (e) { imported = `${e.stdout || ''}${e.stderr || ''}`; code = e.status; }
    ok('3a: an import with refused lines exits 1 (the good lines still load)', code === 1, imported);
    const es = await lib.loadCatalog('es', cat);
    ok('3b: a plain line is loaded', es['crewHome.hero.allDone'] === 'ES:My Day');
    ok('3c: a line that keeps its placeholder is loaded', es['clock.inSince'] === 'ES:dentro desde {time}');
    ok('3d: both plural forms are loaded as one plural', es['crewHome.stopsToday']?.one === 'ES:{count} limpieza' && es['crewHome.stopsToday']?.other === 'ES:{count} limpiezas');
    ok('3e: a RENAMED placeholder is refused', !('crewHome.hero.opensAt' in es) && /crewHome\.hero\.opensAt: placeholders/.test(imported), imported);
    ok('3f: a DROPPED bold mark is refused', !('clock.doneSummary' in es) && /clock\.doneSummary: placeholders/.test(imported), imported);
    ok('3g: a line whose English moved after the sheet went out is refused', !('crewStops.comingUp' in es) && /crewStops\.comingUp: english-changed/.test(imported), imported);
    ok('3h: an unknown key is refused', !('no.such.key' in es) && /no\.such\.key: unknown-key/.test(imported), imported);
    ok('3i: a blank cell changes nothing', !('crewStops.details' in es));
    ok('3j: the real catalog was never touched', readFileSync(path.join(lib.CATALOG_DIR, 'es.js'), 'utf8') === realEs
      && !/ES:/.test(realEs));
    // The written file is the catalog the app renders from.
    core.registerCatalog('es', es);
    ok('3k: the app renders the loaded line', core.translate('es', 'crewHome.hero.allDone') === 'ES:My Day');
    ok('3l: …with its placeholder filled', core.translate('es', 'clock.inSince', { time: '9:30 PM' }) === 'ES:dentro desde 9:30 PM');
    ok('3m: …its plural picked by the number', core.translate('es', 'crewHome.stopsToday', { count: 3 }) === 'ES:3 limpiezas');
    ok('3n: …and a refused line still shows its English', core.translate('es', 'crewHome.hero.opensAt', { time: 'x' }) === core.english('crewHome.hero.opensAt', { time: 'x' }));

    // ── 4. a re-export shows the work; a CSV imports the same; Excel's shared strings read ─
    const rows2 = await exp.buildRows({ dir: cat });
    ok('4a: a re-export shows the loaded Spanish in its column', rows2.find((r) => r.key === 'crewHome.hero.allDone')?.es === 'ES:My Day');
    ok('4b: …per plural form', rows2.find((r) => r.key === 'crewHome.stopsToday' && r.form === 'other')?.es === 'ES:{count} limpiezas');
    const csv = path.join(tmp, 'returned.csv');
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    writeFileSync(csv, '﻿' + [head.map(q).join(','), ...tr.rows.slice(1).map((r) => r.map(q).join(','))].join('\r\n'));
    const fromCsv = imp.readReturnedRows(csv, 'es');
    ok('4c: a CSV saved from the sheet reads the same lines', fromCsv.find((r) => r.key === 'clock.inSince')?.text === 'ES:dentro desde {time}' && fromCsv.length === tr.rows.length - 1);
    // A minimal workbook the way Excel and Google Sheets save one: shared strings, a sparse row.
    const shared = ['Key (do not change)', 'Form', 'English', 'Spanish (fill in)', 'crewHome.hero.allDone', 'All done for today', 'ES:Día <b>"x"</b> & y'];
    const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t></si>`).join('')}</sst>`;
    const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="C3" t="s"><v>5</v></c><c r="D3" t="s"><v>6</v></c></row></sheetData></worksheet>';
    const excelish = xlsx.zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Translate" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/sharedStrings.xml', data: sst },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ]);
    const excelFile = path.join(tmp, 'excel.xlsx');
    writeFileSync(excelFile, excelish);
    const fromExcel = imp.readReturnedRows(excelFile, 'es');
    ok('4d: a workbook saved with SHARED strings (Excel, Google Sheets) reads correctly — skipped cells and rows included',
      fromExcel.length === 1 && fromExcel[0].key === 'crewHome.hero.allDone' && fromExcel[0].text === 'ES:Día <b>"x"</b> & y' && fromExcel[0].form === '',
      JSON.stringify(fromExcel));
    // A pure planner check: the placeholder rule compares the WHOLE set — an extra one is wrong too.
    const plan = await imp.planImport({
      rows: [{ row: 2, key: 'clock.inSince', form: '', english: null, text: 'ES:{time} {time2}' }],
      lang: 'es', en, current: {}, notes: lib.readCatalogNotes(),
    });
    ok('4e: an EXTRA placeholder is refused as surely as a missing one', plan.report.refused[0]?.reason === 'placeholders');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\ntest-i18n-roundtrip: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
