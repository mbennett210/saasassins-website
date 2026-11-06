import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Select from './Select';
import ConfirmDialog from './ConfirmDialog';
import Modal from './Modal';
import { useToast } from './Toast';
import { useDispatch, useSelector, useSyncStatus } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClientById } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useT } from '../i18n/react';
import * as scanCodesApi from '../lib/scanCodesApi';
import {
  LABEL_FORMATS, LABEL_FORMAT_SETTING, labelFormatKey, labelFormatOptions, SHEET_LAYOUTS, qrPathData, QR_ERROR_CORRECTION,
  scanLinkRows, scanLinksCsv, scanLinksFilename, scanCodesMissing,
} from '../lib/scanCodes';
import { fmtDate } from '../lib/dates';

// QR-6 — a location's QR codes, on its Cleaning instructions card (where the areas are
// defined): one code per area, each with Open (the public page it leads to) and Replace (a
// stolen or moved label), and the two prints — the label sheet and every code on one page.
// Opening the panel mints a code for any area that has none (the server's idempotent
// ensure, EP-260), so a newly added area gets its code the moment the card is saved.
//
// Mounted ONLY for a viewer the server will serve: `sites.edit` and an office role
// (lib/scanCodes.scanCodesAllowed — CleaningInstructionsCard decides, the route re-checks).
// The label sheet is remembered for the whole office in opsSettings (LABEL_FORMAT_SETTING),
// written through the Operations page's own UPDATE_OPS_SETTINGS by a holder of the key the
// server checks for that slice (time.config); anyone else sees the office's choice, locked,
// with the reason under it (UI_RULES §118).
//
// For the office's OWN label software (QR Wave 1, 2026-10-16): Copy link on every row, and
// Download links — this building's codes as a spreadsheet, built here from the panel's own
// answer by the ONE builder the all-buildings file on the Customers list uses (lib/scanCodes
// scanLinkRows / scanLinksCsv). The new words are catalog lines (UI_RULES §140).
//
// Print label (QR-9, QR Wave 2: "just one location on one site, if needed, if something gets
// damaged"): each row prints ONE area's label on the office's label sheet, at the position picked
// on that sheet's own grid (the kit's chips, `cols` across, 1 … `perSheet`), so a partly used sheet
// is not wasted — the same document and the same door as Print labels (EP-262's areaId + position,
// UI_RULES §177).
function QrMark({ data }) {
  if (!data) return <span className="scan-code-qr is-empty" aria-hidden="true" />;
  return (
    <svg className="scan-code-qr" viewBox={`0 0 ${data.size} ${data.size}`} aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <rect className="scan-code-qr-bg" width={data.size} height={data.size} />
      <path className="scan-code-qr-ink" d={data.d} />
    </svg>
  );
}

export default function AreaScanCodes({ location }) {
  const t = useT();
  const toast = useToast();
  const dispatch = useDispatch();
  const canSetSheet = usePermission('time.config');
  const saved = useSelector((s) => s.opsSettings?.[LABEL_FORMAT_SETTING] ?? null);
  const format = labelFormatKey(saved);
  const siteId = location?.id || null;
  const clientId = location?.clientId || null;
  // The customer (its name and number, for the links file) and the org's zone ("Made on").
  const client = useSelector(useCallback((s) => (clientId ? selectClientById(s, clientId) : null), [clientId]));
  const timeZone = useSelector((s) => s.company?.timezone || null);
  // The panel re-reads when the areas change (a new area needs its code; a removed one's
  // code stops resolving on its own).
  const areasKey = (Array.isArray(location?.cleaningAreas) ? location.cleaningAreas : [])
    .map((a) => `${a?.id}:${a?.label}`).join('|');

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null); // 'labels' | 'sheet' | 'label' | 'replace'
  const [confirm, setConfirm] = useState(null);
  // Print label: the code whose one label is being printed, and the position picked for it.
  const [labelFor, setLabelFor] = useState(null);
  const [position, setPosition] = useState(1);
  const positionId = useId();
  const sheet = LABEL_FORMATS[format];
  const [qr, setQr] = useState({});
  // Set on every mount, not only the first: StrictMode mounts, unmounts and mounts again.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!siteId) return;
    setError('');
    try {
      const r = await scanCodesApi.ensureScanCodes(siteId);
      if (alive.current) setData(r);
    } catch (e) {
      if (alive.current) setError(e?.message || 'The QR codes could not load.');
    }
  }, [siteId]);
  useEffect(() => { load(); }, [load, areasKey]);
  // CS-952: the read above runs the moment the areas change here, before the card's save reaches the
  // server, and the server mints codes only for the SAVED areas. So once the store says the save has
  // landed ('synced') and an area still has no code, ask again. It re-runs only when one of the two
  // turns, so an area the server will not mint for never loops.
  const synced = useSyncStatus() === 'synced';
  const missing = !!data && scanCodesMissing(location, data.codes);
  useEffect(() => { if (synced && missing) load(); }, [synced, missing, load]);

  // Each code drawn from its own URL, once the list is in (the library loads on demand).
  useEffect(() => {
    const codes = data?.codes || [];
    if (!codes.length) return undefined;
    let live = true;
    import('qrcode').then((mod) => {
      const QR = mod.default || mod;
      const next = {};
      for (const c of codes) {
        try { next[c.token] = qrPathData(QR.create(c.url, { errorCorrectionLevel: QR_ERROR_CORRECTION })); } catch { /* drawn on the print */ }
      }
      if (live) setQr(next);
    }).catch(() => { /* the preview is decoration; the print draws its own */ });
    return () => { live = false; };
  }, [data]);

  const chooseSheet = (key) => {
    if (!canSetSheet || key === format) return;
    dispatch({ type: ACTIONS.UPDATE_OPS_SETTINGS, patch: { [LABEL_FORMAT_SETTING]: labelFormatKey(key) } });
    toast.success('Label sheet saved for the whole office');
  };

  const print = (layout) => {
    setBusy(layout);
    // Called straight from the click: the demo opens its print window before any await.
    scanCodesApi.printScanSheet({ siteId, layout, format })
      .catch((e) => toast.error(e?.message || 'The codes could not be printed.'))
      .finally(() => { if (alive.current) setBusy(null); });
  };

  const openLabel = (code) => { setPosition(1); setLabelFor(code); };
  const printLabel = () => {
    const code = labelFor;
    if (!code) return;
    setBusy('label');
    // Straight from the click, like the other prints: the demo opens its print window first.
    scanCodesApi.printScanSheet({ siteId, layout: SHEET_LAYOUTS.LABELS, format, areaId: code.areaId, position })
      .then(() => { if (alive.current) setLabelFor(null); })
      .catch((e) => toast.error(e?.message || t('qrLabel.failed')))
      .finally(() => { if (alive.current) setBusy(null); });
  };

  const copyLink = async (code) => {
    try {
      await navigator.clipboard.writeText(code.url);
      toast.success(t('qrLinks.copied'));
    } catch {
      toast.error(t('qrLinks.copyFailed'));
    }
  };

  // This building's links, from the panel's own answer (the codes just ensured, in area order).
  const downloadLinks = () => {
    const rows = scanLinkRows({ client, site: location, codes: data?.codes || [], timeZone });
    scanCodesApi.saveScanLinksCsv(scanLinksCsv(rows), scanLinksFilename({ building: data?.building || client?.name || location?.name || '' }));
    toast.success(t('qrLinks.downloaded'));
  };

  const replace = async (code) => {
    setBusy('replace');
    try {
      const r = await scanCodesApi.replaceScanCode({ siteId, areaId: code.areaId });
      if (alive.current) setData((d) => (d ? { ...d, codes: d.codes.map((c) => (c.areaId === code.areaId ? r.code : c)) } : d));
      toast.success(`New code for ${code.label || 'this area'}. Print it and swap the label.`);
    } catch (e) {
      toast.error(e?.message || 'The code could not be replaced.');
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const codes = data?.codes || [];
  return (
    <section className="scan-codes" aria-labelledby={`scan-codes-${siteId}`}>
      <h4 id={`scan-codes-${siteId}`} className="scan-codes-title">QR codes</h4>
      <p className="text-xs text-muted scan-codes-hint">
        One code per area. Put each one up in its area: anyone who scans it sees when that area was last cleaned, with no login.
      </p>

      {error && (
        <div className="callout callout-danger scan-codes-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-secondary" onClick={load}>Try again</button>
        </div>
      )}
      {!data && !error && <p className="text-xs text-muted">Getting the codes…</p>}

      {codes.length > 0 && (
        <ul className="scan-code-list">
          {codes.map((c) => (
            <li key={c.areaId} className="scan-code-row">
              <QrMark data={qr[c.token]} />
              <div className="scan-code-main">
                <div className="scan-code-name">{c.label || 'Untitled area'}</div>
                <div className="text-xs text-muted">In use since {fmtDate(c.createdAt)}</div>
              </div>
              <div className="scan-code-actions">
                <a className="btn btn-link" href={c.url} target="_blank" rel="noopener noreferrer"
                  aria-label={`Open the scan page for ${c.label || 'this area'}`}>Open</a>
                <button type="button" className="btn btn-link" disabled={!c.url}
                  aria-label={c.label ? t('qrLinks.copyAria', { area: c.label }) : t('qrLinks.copyAriaUnnamed')} onClick={() => copyLink(c)}>{t('qrLinks.copy')}</button>
                <button type="button" className="btn btn-link" disabled={!!busy}
                  aria-label={c.label ? t('qrLabel.printAria', { area: c.label }) : t('qrLabel.printAriaUnnamed')} onClick={() => openLabel(c)}>{t('qrLabel.print')}</button>
                <button type="button" className="btn btn-link" disabled={!!busy}
                  aria-label={`Replace the code for ${c.label || 'this area'}`} onClick={() => setConfirm(c)}>Replace</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && (
        <div className="scan-codes-print">
          <div className="form-group scan-codes-sheet">
            <label className="form-label" htmlFor={`scan-sheet-${siteId}`}>Label sheet</label>
            <Select
              id={`scan-sheet-${siteId}`}
              ariaLabel="Label sheet"
              value={format}
              onChange={chooseSheet}
              options={labelFormatOptions()}
              disabled={!canSetSheet}
            />
            <p className="text-xs text-muted scan-codes-sheet-help">
              {canSetSheet
                ? 'Saved for the whole office.'
                : 'Saved for the whole office. Only someone who can change Operations settings can switch it.'}
            </p>
          </div>
          <div className="scan-codes-buttons">
            <button type="button" className="btn btn-primary" disabled={!codes.length || !!busy} onClick={() => print(SHEET_LAYOUTS.LABELS)}>
              {busy === SHEET_LAYOUTS.LABELS ? 'Preparing…' : 'Print labels'}
            </button>
            <button type="button" className="btn btn-gold" disabled={!codes.length || !!busy} onClick={() => print(SHEET_LAYOUTS.SHEET)}>
              {busy === SHEET_LAYOUTS.SHEET ? 'Preparing…' : 'Print all on one page'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={!codes.length} onClick={downloadLinks}>
              {t('qrLinks.download')}
            </button>
          </div>
          <p className="text-xs text-muted">Print at 100% (“Actual size”) so each code lands on its label.</p>
        </div>
      )}

      <Modal
        open={!!labelFor}
        onClose={() => setLabelFor(null)}
        title={labelFor?.label ? t('qrLabel.title', { area: labelFor.label }) : t('qrLabel.titleUnnamed')}
        size="sm"
      >
        <div className="scan-label-pick">
          <p className="text-sm scan-label-sheet-name">{t('qrLabel.sheet', { sheet: `${sheet.name} · ${sheet.size}`, count: sheet.perSheet })}</p>
          <div>
            <div id={positionId} className="form-label">{t('qrLabel.position')}</div>
            <p className="text-xs text-muted scan-label-help">{t('qrLabel.positionHelp')}</p>
          </div>
          <div className="scan-label-sheet" role="group" aria-labelledby={positionId}
            style={{ gridTemplateColumns: `repeat(${sheet.cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: sheet.perSheet }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={`chip${n === position ? ' on' : ''}`}
                aria-pressed={n === position}
                aria-label={t('qrLabel.positionAria', { n, row: Math.ceil(n / sheet.cols), col: ((n - 1) % sheet.cols) + 1 })}
                onClick={() => setPosition(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{t('qrLabel.actualSize')}</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={() => setLabelFor(null)}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={printLabel}>
            {busy === 'label' ? t('qrLabel.preparing') : t('qrLabel.go', { n: position })}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title="Replace this code?"
        message={confirm ? `The label for ${confirm.label || 'this area'} stops working as soon as you replace it. Print the new one and put it up in its place.` : ''}
        confirmLabel="Replace code"
        variant="danger"
        onConfirm={() => { if (confirm) replace(confirm); }}
        onClose={() => setConfirm(null)}
      />
    </section>
  );
}
