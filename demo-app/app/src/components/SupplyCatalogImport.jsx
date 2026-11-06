// Supplies → Catalog → Import items (task 257, the "Live testing prep call" 2026-10-27: the supply
// catalog from a spreadsheet, "six columns starting with photo", "hundreds of items"). Every rule is
// lib/supplyCatalogImport.js; this screen only walks it:
//
//   FILE     download the template (an Excel file: Photo · SKU · Item · Category · How it comes ·
//            Price), then choose or drop an .xlsx (pictures travel in it) or a CSV (links only).
//   COLUMNS  one picker per column, guessed from its header; the Item column is required.
//   PREVIEW  the catalog read fresh, then each row New / Update / Unchanged / Problem with its photo
//            and what would change — nothing is saved yet. A row for an item already in the catalog
//            updates it: filled cells replace, blank cells leave (Daniel's answer, 2026-10-27).
//   RUN      the items, CATALOG_IMPORT_BATCH a call (each answered), then the photos three at a
//            time: a picture from the file, or a link the SERVER downloads (catalog/image-link) —
//            each redrawn on the device as a ~640 px JPEG and stored through catalog/image (EP-399).
//   DONE     the totals, the photos that could not be stored, and the problems file.
// Closing it part way stops what is left; what was saved stays. Every word is a catalog line
// (`supplyImport.*`, UI_RULES §140); the items' own words travel as the file wrote them.
import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import Badge from './Badge';
import Icon from './Icon';
import ListPager from './ListPager';
import { useToast } from './Toast';
import { usePagedRows } from '../hooks/usePagedRows';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { decodeCsvBytes, parseCsv, gridTable } from '../lib/csv';
import { readWorkbook, isZip, isLegacyXls, DRAWABLE_PICTURES } from '../lib/xlsx';
import {
  CATALOG_IMPORT_FIELDS, CATALOG_IMPORT_MAX_FILE_BYTES, CATALOG_IMPORT_MAX_ROWS, guessCatalogMapping,
  planCatalogImport, catalogImportItems, catalogImportBatches, catalogImportProblemsCsv, catalogTemplateXlsx,
} from '../lib/supplyCatalogImport';
import { SUPPLY_IMAGE_EDGE, SUPPLY_IMAGE_MAX_BYTES } from '../lib/supplies';
import { pictureAsJpeg } from '../lib/imageCanvas';
import { blobToDataUrl } from '../lib/avatarApi';
import { money } from '../lib/dates';
import * as suppliesApi from '../lib/suppliesApi';
import { BRAND } from '../brand/tokens.generated.js';
import { IDENTITY } from '../brand/identity.generated.js';
import { useT } from '../i18n/react';
import { msg } from '../i18n/core';

const STEP = { FILE: 'file', COLUMNS: 'columns', PREVIEW: 'preview', RUN: 'run', DONE: 'done' };
const STATUS_BADGE = {
  create: ['green', 'supplyImport.status.create'],
  update: ['blue', 'supplyImport.status.update'],
  unchanged: ['slate', 'supplyImport.status.unchanged'],
  error: ['red', 'supplyImport.status.error'],
};
const FILTERS = [
  { key: 'all', labelKey: 'supplyImport.filter.all' },
  { key: 'create', labelKey: 'supplyImport.filter.create' },
  { key: 'update', labelKey: 'supplyImport.filter.update' },
  { key: 'unchanged', labelKey: 'supplyImport.filter.unchanged' },
  { key: 'problems', labelKey: 'supplyImport.filter.problems' },
];
const matchesFilter = (r, f) => (f === 'all' ? true
  : f === 'problems' ? (r.errors.length > 0 || r.warnings.length > 0) : r.status === f);
// Photos are stored this many at a time (each is a download or a redraw, then one upload).
const PHOTO_CONCURRENCY = 3;
// The file limit in whole megabytes ("100 MB"), for the words.
const MAX_FILE_MB = Math.round(CATALOG_IMPORT_MAX_FILE_BYTES / (1024 * 1024));

// What the server said about one item, in words.
function itemOutcome(r) {
  if (r.code === 'stale') return msg('supplyImport.run.stale');
  if (r.code === 'not_found') return msg('supplyImport.run.gone');
  if (r.code === 'sku_taken') return msg('supplyImport.run.skuTaken', { item: r.holder ? r.holder.name : '—' });
  if (['name_required', 'name_too_long', 'sku_too_long', 'category_too_long', 'unit_too_long', 'bad_price'].includes(r.code)) return msg('supplyImport.run.invalid');
  return msg('supplyImport.run.failed');
}
// Why a photo was not stored, in words. A link's own trouble comes as `link_<code>` (the
// image-link door's codes); the rest is the product-image door's (EP-399) or this device's.
function photoOutcome(e) {
  const code = (e && e.code) || '';
  if (code === 'unreadable') return msg('supplyImport.photo.unreadable');
  if (code === 'too_large' || code === 'bad_image') return msg('supplyImport.photo.tooLarge');
  if (code === 'stale') return msg('supplyImport.photo.stale');
  if (code === 'not_found') return msg('supplyImport.run.gone');
  if (code === 'demo_storage_full') return msg('supplyImport.photo.demoFull');
  if (code === 'link_demo_no_download') return msg('supplyImport.photo.demoLink');
  if (code === 'link_rate-limited') return msg('supplyImport.photo.limited');
  if (code === 'link_bad_link' || code === 'link_blocked_address' || code === 'link_blocked_port') return msg('supplyImport.photo.badLink');
  if (code === 'link_not_found') return msg('supplyImport.photo.linkGone');
  if (code === 'link_not_an_image') return msg('supplyImport.photo.notPicture');
  if (code === 'link_too_large') return msg('supplyImport.photo.linkTooLarge');
  if (code.startsWith('link_')) return msg('supplyImport.photo.unreachable');
  return msg('supplyImport.photo.failed');
}

async function eachLimited(list, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A row's photo in the preview: the picture from the file, the picture at its link (shown straight
// from the link; the server downloads it only on Import), or the box glyph.
function PhotoThumb({ photo }) {
  const [broken, setBroken] = useState(false);
  const url = !photo ? null : (photo.kind === 'picture' ? photo.picture.url : photo.url);
  return (
    <span className="supply-thumb" aria-hidden="true">
      {url && !broken
        ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : <Icon name={photo && photo.kind === 'link' ? 'link' : 'box'} size={16} />}
    </span>
  );
}

export default function SupplyCatalogImport({ open, onClose }) {
  const t = useT();
  const toast = useToast();
  const canManage = usePermission('supplies.manage');
  const online = useOnlineStatus() !== false;

  const [step, setStep] = useState(STEP.FILE);
  const [file, setFile] = useState(null);
  const [mapping, setMapping] = useState({});
  const [readError, setReadError] = useState(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState(false);
  const [filter, setFilter] = useState('all');
  const [progress, setProgress] = useState(null); // { phase: 'items' | 'photos', done, total }
  const [result, setResult] = useState(null);
  const outcomes = useRef(new Map()); // row line → [msg] said during the run
  const ids = useRef(new Map());      // row index → the new item's id, minted once per file
  const urls = useRef([]);            // the pictures' object URLs, revoked when done
  const stopped = useRef(false);
  const running = useRef(false);

  const forgetPictures = () => { for (const u of urls.current) URL.revokeObjectURL(u); urls.current = []; };
  useEffect(() => {
    if (!open) return undefined;
    setStep(STEP.FILE); setFile(null); setMapping({}); setReadError(null); setReading(false);
    setCatalog(null); setCatalogError(false); setFilter('all'); setProgress(null); setResult(null);
    outcomes.current = new Map(); ids.current = new Map(); stopped.current = false; running.current = false;
    return () => { stopped.current = true; forgetPictures(); };
  }, [open]);

  // ── reading the file ──
  const readFile = async (f) => {
    if (!f || reading) return;
    setReadError(null);
    if (f.size > CATALOG_IMPORT_MAX_FILE_BYTES) { setReadError(msg('supplyImport.err.fileTooLarge', { size: MAX_FILE_MB })); return; }
    setReading(true);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (isLegacyXls(bytes)) { setReadError(msg('supplyImport.err.oldExcel')); return; }
      let table;
      let pictures = [];
      let links = [];
      let extra = { kind: 'csv', encoding: 'utf-8', delimiter: ',' };
      if (isZip(bytes)) {
        const wb = await readWorkbook(bytes);
        const onRow = new Set([...wb.pictures, ...wb.links].map((p) => p.row));
        table = gridTable(wb.rows, { keepRow: (i) => onRow.has(i) });
        // A picture's column is the sheet's; the table leaves empty columns out.
        const colOf = (c) => table.sheetCols.indexOf(c);
        forgetPictures();
        pictures = wb.pictures.map((p) => {
          const blob = new Blob([p.bytes], { type: p.type });
          const url = DRAWABLE_PICTURES.has(p.type) ? URL.createObjectURL(blob) : null;
          if (url) urls.current.push(url);
          return { row: p.row, col: colOf(p.col), source: p.source, type: p.type, name: p.name, blob, url };
        });
        links = wb.links.map((l) => ({ ...l, col: colOf(l.col) }));
        extra = { kind: 'xlsx' };
      } else {
        const { text, encoding } = decodeCsvBytes(bytes);
        table = parseCsv(text);
        extra = { kind: 'csv', encoding, delimiter: table.delimiter };
      }
      if (!table.headers.length || !table.rows.length) { setReadError(msg('supplyImport.err.empty')); return; }
      if (table.rows.length > CATALOG_IMPORT_MAX_ROWS) { setReadError(msg('supplyImport.err.tooManyRows', { count: CATALOG_IMPORT_MAX_ROWS })); return; }
      ids.current = new Map();
      setFile({ ...table, ...extra, name: f.name, pictures, links });
      setMapping(guessCatalogMapping(table.headers));
      setStep(STEP.COLUMNS);
    } catch {
      setReadError(msg('supplyImport.err.unreadable'));
    } finally {
      setReading(false);
    }
  };

  // ── the columns ──
  const nameMapped = Object.values(mapping).includes('name');
  const setField = (idx, key) => setMapping((prev) => {
    const next = {};
    for (const [i, k] of Object.entries(prev)) if (k !== key && Number(i) !== idx) next[i] = k;
    if (key) next[idx] = key;
    return next;
  });
  const fieldOptions = useMemo(() => [
    { value: '', label: t('supplyImport.skip') },
    ...CATALOG_IMPORT_FIELDS.map((f) => ({ value: f.key, label: t(f.labelKey) })),
  ], [t]);
  // A column's sample: its pictures when it holds more pictures than words, else its first words.
  const sampleOf = (idx) => {
    const pics = file.pictures.filter((p) => p.col === idx).length;
    const texts = file.rows.filter((r) => r[idx]).length;
    if (pics && pics >= texts) return t('supplyImport.pictureCount', { count: pics });
    return file.rows.find((r) => r[idx])?.[idx] || '—';
  };

  // ── the preview: the catalog read fresh, then the dry run ──
  const loadCatalog = () => {
    setCatalog(null); setCatalogError(false);
    suppliesApi.listCatalog({ all: true })
      .then((r) => setCatalog(r.items || []))
      .catch(() => setCatalogError(true));
  };
  const toPreview = () => { setFilter('all'); setStep(STEP.PREVIEW); loadCatalog(); };
  const toColumns = () => { setCatalog(null); setCatalogError(false); setStep(STEP.COLUMNS); };
  const newId = (i) => {
    if (!ids.current.has(i)) ids.current.set(i, suppliesApi.newSupplyCatalogId());
    return ids.current.get(i);
  };
  // The dry run, once the catalog is read (it is read afresh each time the preview opens).
  const plan = useMemo(() => {
    if (!file || !catalog) return null;
    return planCatalogImport({
      rows: file.rows, sheetRows: file.sheetRows, mapping, pictures: file.pictures, links: file.links, catalog, newId,
    });
  }, [file, mapping, catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowsShown = useMemo(() => (plan ? plan.rows.filter((r) => matchesFilter(r, filter)) : []), [plan, filter]);
  const pager = usePagedRows(rowsShown, { resetKey: filter });
  const counts = plan ? plan.counts : { create: 0, update: 0, unchanged: 0, error: 0, warning: 0, photos: 0 };
  const toWrite = counts.create + counts.update;
  const problems = plan ? plan.rows.filter((r) => r.errors.length || r.warnings.length || outcomes.current.has(r.line)).length : 0;

  const downloadProblems = () => {
    if (!plan || !file) return;
    const text = catalogImportProblemsCsv({ plan, headers: file.headers, render: (m) => t(m), outcomes: outcomes.current });
    download(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${IDENTITY.slug}-supply-import-problems.csv`);
  };
  const downloadTemplate = () => {
    download(new Blob([catalogTemplateXlsx()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${IDENTITY.slug}-supply-catalog-template.xlsx`);
  };

  // ── the import ──
  const say = (line, m) => outcomes.current.set(line, [...(outcomes.current.get(line) || []), m]);
  async function storePhoto(row, version) {
    let blob;
    if (row.photo.kind === 'picture') blob = row.photo.picture.blob;
    else {
      let got;
      try { got = await suppliesApi.fetchImageLink(row.photo.url); }
      catch (e) { throw Object.assign(new Error('link'), { code: `link_${(e && e.code) || 'unreachable'}` }); }
      blob = await (await fetch(got.dataUrl)).blob();
    }
    const jpeg = await pictureAsJpeg(blob, { maxEdge: SUPPLY_IMAGE_EDGE, fill: BRAND.card, keepBytes: SUPPLY_IMAGE_MAX_BYTES });
    if (!jpeg) throw Object.assign(new Error('unreadable'), { code: 'unreadable' });
    if (jpeg.size > SUPPLY_IMAGE_MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'too_large' });
    await suppliesApi.uploadCatalogImage({ id: row.id, version, dataUrl: await blobToDataUrl(jpeg) });
  }
  async function runImport() {
    if (!plan || running.current) return;
    running.current = true;
    stopped.current = false;
    outcomes.current = new Map();
    setStep(STEP.RUN);
    const items = catalogImportItems(plan);
    const rowOf = new Map(plan.rows.map((r) => [r.id, r]));
    const saved = new Map(); // id → its version after the import
    const tally = { added: 0, updated: 0, failed: 0, notTried: 0, photos: 0, photosFailed: 0 };
    let done = 0;
    setProgress({ phase: 'items', done: 0, total: items.length });
    for (const batch of catalogImportBatches(items)) {
      if (stopped.current) { tally.notTried += items.length - done; break; }
      let res = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
        try { res = await suppliesApi.importCatalog(batch); } catch (e) { lastError = e; /* tried again once: the same ids, so nothing twice */ }
      }
      if (!res) {
        // The server could not be reached twice running: stop, and say which rows were not saved.
        const why = lastError && lastError.code === 'demo_storage_full' ? msg('supplyImport.run.demoFull') : msg('supplyImport.run.failed');
        for (const it of items.slice(done)) say(rowOf.get(it.id).line, why);
        tally.failed += items.length - done;
        break;
      }
      for (const r of res.results || []) {
        const row = rowOf.get(r.id);
        if (r.ok) {
          saved.set(r.id, r.item ? r.item.version : null);
          if (r.created || r.code === 'exists') tally.added += 1; else tally.updated += 1;
        } else {
          tally.failed += 1;
          if (row) say(row.line, itemOutcome(r));
        }
      }
      done += batch.length;
      setProgress({ phase: 'items', done, total: items.length });
    }
    const photoRows = plan.rows.filter((r) => r.photo && saved.has(r.id) && saved.get(r.id));
    let photosDone = 0;
    if (photoRows.length && !stopped.current) {
      setProgress({ phase: 'photos', done: 0, total: photoRows.length });
      await eachLimited(photoRows, PHOTO_CONCURRENCY, async (row) => {
        if (stopped.current) return;
        try {
          await storePhoto(row, saved.get(row.id));
          tally.photos += 1;
        } catch (e) {
          tally.photosFailed += 1;
          say(row.line, photoOutcome(e));
        }
        photosDone += 1;
        setProgress({ phase: 'photos', done: photosDone, total: photoRows.length });
      });
    }
    tally.photosNotTried = Math.max(0, photoRows.length - photosDone);
    running.current = false;
    if (stopped.current) return;
    setResult(tally);
    setStep(STEP.DONE);
    toast.success(t('supplyImport.toastDone', { added: tally.added, updated: tally.updated }));
  }

  const close = () => { stopped.current = true; onClose(); };

  if (!canManage) {
    return (
      <Modal open={open} onClose={close} title={t('supplyImport.title')} size="lg">
        <p className="text-sm">{t('supplyImport.notPermitted')}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={close}>{t('common.close')}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title={t('supplyImport.title')} size="lg">
      {step === STEP.FILE && (
        <div className="supply-import-step">
          <p className="text-sm text-muted">{t('supplyImport.lead')}</p>
          <div className="supply-import-template">
            <button type="button" className="btn btn-link" onClick={downloadTemplate}>{t('supplyImport.template')}</button>
            <span className="text-xs text-muted">{t('supplyImport.templateHint')}</span>
          </div>
          <ul className="supply-import-how text-sm">
            <li>{t('supplyImport.howPicture')}</li>
            <li>{t('supplyImport.howLink')}</li>
            <li>{t('supplyImport.howUpdate')}</li>
          </ul>
          <label
            className={`supply-import-drop ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer?.files?.[0]); }}
          >
            <input
              type="file" className="supply-import-file"
              accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; readFile(f); }}
            />
            <Icon name="upload" size={28} />
            <span className="supply-import-drop-title">{reading ? t('supplyImport.reading') : t('supplyImport.drop')}</span>
            <span className="text-xs text-muted">{t('supplyImport.dropHint', { size: MAX_FILE_MB })}</span>
          </label>
          {readError && <div className="conflict-warning" role="alert"><Icon name="warning" size={14} /><span>{t(readError)}</span></div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={close}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {step === STEP.COLUMNS && file && (
        <div className="supply-import-step">
          <p className="text-sm text-muted">{t('supplyImport.mapLead', { count: file.rows.length })}</p>
          {(file.kind === 'xlsx' && file.pictures.length > 0) && (
            <p className="text-xs text-muted">{t('supplyImport.picturesFound', { count: file.pictures.length })}</p>
          )}
          {(file.encoding === 'windows-1252' || file.delimiter === ';' || file.delimiter === '\t' || file.renamed?.length > 0 || file.kind === 'csv') && (
            <div className="callout callout-info supply-import-notes">
              {file.kind === 'csv' && <p>{t('supplyImport.csvNoPictures')}</p>}
              {file.encoding === 'windows-1252' && <p>{t('supplyImport.readAs1252')}</p>}
              {file.delimiter === ';' && <p>{t('supplyImport.readSemicolon')}</p>}
              {file.delimiter === '\t' && <p>{t('supplyImport.readTab')}</p>}
              {file.renamed?.length > 0 && <p>{t('supplyImport.renamedHeaders', { columns: file.renamed.map((r) => r.to) })}</p>}
            </div>
          )}
          <div className="supply-import-map">
            {file.headers.map((h, idx) => (
              <div key={idx} className="supply-import-map-row">
                <div className="supply-import-map-head">
                  <div className="text-sm font-semi truncate" title={h}>{h || t('supplyImport.emptyHeader')}</div>
                  {/* i18n-ok: a value from the person's own file */}
                  <div className="text-xs text-muted truncate">{sampleOf(idx)}</div>
                </div>
                <Select
                  ariaLabel={t('supplyImport.mapAria', { column: h || t('supplyImport.emptyHeader') })}
                  value={mapping[idx] || ''}
                  onChange={(v) => setField(idx, v || '')}
                  options={fieldOptions}
                />
              </div>
            ))}
          </div>
          {!nameMapped && <div className="conflict-warning"><Icon name="warning" size={14} /><span>{t('supplyImport.needName')}</span></div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(STEP.FILE)}>{t('supplyImport.back')}</button>
            <button type="button" className="btn btn-primary" disabled={!nameMapped} onClick={toPreview}>{t('supplyImport.toPreview')}</button>
          </div>
        </div>
      )}

      {step === STEP.PREVIEW && (
        <div className="supply-import-step">
          {catalogError ? (
            <>
              <div className="callout callout-danger">{online ? t('supplyImport.catalogFailed') : t('supplyPage.offline')}</div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={toColumns}>{t('supplyImport.back')}</button>
                <button type="button" className="btn btn-primary" onClick={loadCatalog}>{t('supplyPage.tryAgain')}</button>
              </div>
            </>
          ) : !plan ? (
            <p className="text-sm text-muted">{t('supplyImport.checking')}</p>
          ) : (
            <>
              <div className="supply-import-stats">
                <div className="supply-import-stat tone-create"><strong>{counts.create}</strong><span>{t('supplyImport.stat.create')}</span></div>
                <div className="supply-import-stat tone-update"><strong>{counts.update}</strong><span>{t('supplyImport.stat.update')}</span></div>
                <div className="supply-import-stat"><strong>{counts.unchanged}</strong><span>{t('supplyImport.stat.unchanged')}</span></div>
                <div className="supply-import-stat tone-error"><strong>{counts.error}</strong><span>{t('supplyImport.stat.error')}</span></div>
                <div className="supply-import-stat"><strong>{counts.photos}</strong><span>{t('supplyImport.stat.photos')}</span></div>
              </div>
              {counts.warning > 0 && <p className="text-xs text-muted">{t('supplyImport.notesCount', { count: counts.warning })}</p>}
              <div className="supply-import-filter" role="group" aria-label={t('supplyImport.filterAria')}>
                {FILTERS.map((f) => {
                  const n = plan.rows.filter((r) => matchesFilter(r, f.key)).length;
                  return (
                    <button key={f.key} type="button" className={`chip chip-sm ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
                      {t(f.labelKey)} <span className="control-count">{n}</span>
                    </button>
                  );
                })}
              </div>
              <div className="table-wrap mobile-stack supply-import-preview">
                <table>
                  <thead>
                    <tr>
                      <th>{t('supplyImport.col.row')}</th>
                      <th>{t('supplyImport.col.item')}</th>
                      <th>{t('supplyImport.col.details')}</th>
                      <th>{t('supplyImport.col.result')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageRows.map((r) => {
                      const [variant, key] = STATUS_BADGE[r.status];
                      const f = r.fields;
                      const details = f
                        ? [f.category, f.unit, f.unitPriceCents ? money(f.unitPriceCents / 100) : null].filter(Boolean).join(' · ')
                        : '';
                      return (
                        <tr key={r.line}>
                          <td data-label={t('supplyImport.col.row')} className="supply-import-line">{r.line}</td>
                          <td className="cell-primary">
                            {/* i18n-ok: the item's own name and SKU, as the file wrote them */}
                            <span className="supply-cat-item">
                              <PhotoThumb photo={r.photo} />
                              <span className="supply-cat-item-text">
                                <span className="truncate" title={r.label}>{r.label || '—'}</span>
                                {r.sku && <span className="text-xs text-muted truncate">{r.sku}</span>}
                              </span>
                            </span>
                          </td>
                          {/* i18n-ok: the item's own category, unit and price, as the file wrote them */}
                          <td data-label={t('supplyImport.col.details')} className="supply-import-details">{details || '—'}</td>
                          <td data-label={t('supplyImport.col.result')} className="supply-import-result-cell">
                            <div className="supply-import-result">
                              <Badge variant={variant}>{t(key)}</Badge>
                              <ul className="supply-import-result-lines">
                                {r.errors.map((m, i) => <li key={`e${i}`} className="text-danger">{t(m)}</li>)}
                                {r.changes.map((m, i) => <li key={`c${i}`}>{t(m)}</li>)}
                                {r.warnings.map((m, i) => <li key={`w${i}`} className="supply-import-warn">{t(m)}</li>)}
                              </ul>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ListPager pager={pager} noun={t('supplyImport.rowsNoun')} />
              {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}
              <div className="modal-actions">
                {problems > 0 && <button type="button" className="btn btn-secondary supply-import-problems-btn" onClick={downloadProblems}>{t('supplyImport.download')}</button>}
                <button type="button" className="btn btn-outline" onClick={toColumns}>{t('supplyImport.back')}</button>
                <button type="button" className="btn btn-primary" disabled={toWrite === 0 || !online} onClick={runImport}>
                  {toWrite === 0 ? t('supplyImport.nothingToImport') : t('supplyImport.importN', { count: toWrite })}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {step === STEP.RUN && progress && (
        <div className="supply-import-step" role="status" aria-live="polite">
          <p className="text-sm font-semi">
            {progress.phase === 'items'
              ? t('supplyImport.savingItems', { done: progress.done, total: progress.total })
              : t('supplyImport.savingPhotos', { done: progress.done, total: progress.total })}
          </p>
          <div className="supply-import-bar" aria-hidden="true">
            <span className="supply-import-bar-fill" style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }} />
          </div>
          <p className="text-xs text-muted">{t('supplyImport.keepOpen')}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={close}>{t('supplyImport.stop')}</button>
          </div>
        </div>
      )}

      {step === STEP.DONE && result && (
        <div className="supply-import-step">
          <p className="text-sm font-semi">
            {result.added + result.updated === 0 ? t('supplyImport.doneNone')
              : result.failed + counts.error > 0 ? t('supplyImport.donePartly') : t('supplyImport.done')}
          </p>
          <div className="supply-import-stats">
            <div className="supply-import-stat tone-create"><strong>{result.added}</strong><span>{t('supplyImport.stat.added')}</span></div>
            <div className="supply-import-stat tone-update"><strong>{result.updated}</strong><span>{t('supplyImport.stat.updated')}</span></div>
            <div className="supply-import-stat tone-error"><strong>{result.failed + counts.error}</strong><span>{t('supplyImport.stat.notImported')}</span></div>
            <div className="supply-import-stat"><strong>{result.photos}</strong><span>{t('supplyImport.stat.photosSaved')}</span></div>
          </div>
          {result.photosFailed > 0 && <div className="callout callout-info">{t('supplyImport.photosFailed', { count: result.photosFailed })}</div>}
          <div className="modal-actions">
            {problems > 0 && <button type="button" className="btn btn-secondary supply-import-problems-btn" onClick={downloadProblems}>{t('supplyImport.download')}</button>}
            <button type="button" className="btn btn-primary" onClick={close}>{t('common.done')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
