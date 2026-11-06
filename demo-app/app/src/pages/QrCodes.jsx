// QR codes — every building's QR codes in one place (UI_RULES §183).
//
// Matt (2026-10-30): "what about the QR codes? How do I create them? I'm not able to find that".
// A location's codes are made from its cleaning areas, one code per area (QR-6), and until now they
// lived only on each customer's Notes tab, under the Cleaning instructions card, and only once the
// location had areas. Daniel's pick (2026-10-30): a page in the menu, plus the location's own card
// (CleaningInstructionsCard says how when there are no areas yet).
//
// Every location of every customer we clean for (an ARCHIVED customer's codes answer "no longer
// active", QR-27, so its buildings are left out; a vendor has none), with its areas. "Codes" opens
// that location's own Cleaning instructions card in a pop-up — the ONE card, so its areas editor, its
// codes, Print labels, Print all on one page and Download links are the customer page's, never a
// second copy; "Add areas" opens the same card straight on its areas editor for a location with none
// yet. Closing the pop-up (its ×, Esc, a click outside) with areas added, changed or ticked and not saved
// asks first (ConfirmDialog), so ticked areas are never dropped without a word (and Save Changes saves the
// ticked ones too, CleaningInstructionsCard). "QR code links" is the
// all-buildings spreadsheet the Customers list offers (useScanLinksDownload, one implementation).
// Gated like the codes themselves: sites.edit AND an office role (lib/scanCodes scanCodesAllowed;
// the route re-checks every call). 20 a page (usePagedRows + ListPager), the filters in the URL
// (?q=&show=&page=), stacked cards on a phone (in its menu too). Every word is a catalog line.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSelector } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useFromHere } from '../hooks/useFromHere';
import { usePagedRows } from '../hooks/usePagedRows';
import { useScanLinksDownload } from '../hooks/useScanLinksDownload';
import Badge from '../components/Badge';
import EmptyState from '../components/EmptyState';
import FilterSelect from '../components/FilterSelect';
import FormField from '../components/FormField';
import Icon from '../components/Icon';
import ListPager from '../components/ListPager';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import CleaningInstructionsCard from '../components/CleaningInstructionsCard';
import { scanAreasOf, scanCodesAllowed, SCAN_CODES_PERMISSION } from '../lib/scanCodes';
import { isArchivedCustomer } from '../lib/customerStatus';
import { customerLabel } from '../lib/customerNumber';
import { composeAddress } from '../lib/address';
import { useT } from '../i18n/react';

const SHOW_NO_AREAS = 'none';
const SHOW_WITH_AREAS = 'ready';
const selSites = (s) => s.sites;
const selClients = (s) => s.clients;
const addressOf = (site) => (typeof site?.address === 'string' && site.address.trim()) || composeAddress(site || {});

export default function QrCodes() {
  const t = useT();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canSitesEdit = usePermission(SCAN_CODES_PERMISSION);
  const allowed = scanCodesAllowed(currentUser?.role || null, canSitesEdit);
  const qrLinks = useScanLinksDownload();
  const sites = useSelector(selSites);
  const clients = useSelector(selClients);
  const [params, setParams] = useSearchParams();
  const setParam = (patch) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') p.delete(k); else p.set(k, String(v)); }
    p.delete('page');
    return p;
  }, { replace: true });
  // The location whose card is open (its id, so the pop-up follows the store as its areas are saved),
  // and whether it opened on the editor (its row's "Add areas").
  const [opened, setOpened] = useState(null);   // { id, edit }
  const openId = opened?.id || null;
  // Areas added or changed in the open card and not saved (the card reports it), and the question
  // a close asks while there are.
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const closeCodes = () => { if (dirty) setAsking(true); else setOpened(null); };

  const clientById = useMemo(() => new Map((clients || []).filter(Boolean).map((c) => [c.id, c])), [clients]);
  // Every location of a customer we clean for: a vendor has no building, an archived customer's codes
  // answer "no longer active" (QR-27).
  const all = useMemo(() => (sites || []).filter(Boolean).map((site) => {
    const client = clientById.get(site.clientId);
    if (!client || client.type === 'vendor' || isArchivedCustomer(client)) return null;
    return { site, client, areas: scanAreasOf(site).length, label: customerLabel(client), address: addressOf(site) };
  }).filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || String(a.site.name || '').localeCompare(String(b.site.name || ''))),
  [sites, clientById]);

  const qRaw = params.get('q') || '';
  const q = qRaw.trim().toLowerCase();
  const show = params.get('show') || '';
  const rows = useMemo(() => all.filter((r) => {
    if (show === SHOW_NO_AREAS && r.areas > 0) return false;
    if (show === SHOW_WITH_AREAS && r.areas === 0) return false;
    if (q && ![r.label, r.site.name, r.address].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  }), [all, show, q]);
  const pager = usePagedRows(rows, { param: 'page', resetKey: `${show}|${q}` });
  const withoutAreas = all.filter((r) => r.areas === 0).length;

  if (!allowed) {
    return <EmptyState icon={<Icon name="lock" size={28} />} title={t('noAccess.title')} message={t('noAccess.body')} />;
  }

  const open = openId ? all.find((r) => r.site.id === openId) || null : null;
  const showOptions = [
    { value: '', label: t('qrPage.show.all') },
    { value: SHOW_NO_AREAS, label: t('qrPage.show.noAreas') },
    { value: SHOW_WITH_AREAS, label: t('qrPage.show.withAreas') },
  ];

  return (
    <div className="qr-codes-page">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">{t('qrPage.title')}</h1>
          <p className="page-sub">{t('qrPage.sub')}</p>
        </div>
        {qrLinks.show && (
          <div className="page-head-actions">
            <button type="button" className="btn btn-secondary" disabled={qrLinks.busy} onClick={qrLinks.download} title={t('qrLinks.buttonHint')}>
              {qrLinks.busy ? t('qrLinks.preparing') : t('qrLinks.button')}
            </button>
          </div>
        )}
      </div>

      <div className="callout callout-info qr-codes-how">
        <Icon name="qr" size={18} />
        <span>{t('qrPage.how')}</span>
      </div>

      <div className="filter-bar">
        <FormField label={t('qrPage.filter.show')}>
          <FilterSelect ariaLabel={t('qrPage.filter.show')} value={show} onChange={(v) => setParam({ show: v })} options={showOptions} />
        </FormField>
        <FormField label={t('qrPage.search')}>
          <input
            className="input" type="search" value={qRaw} placeholder={t('qrPage.search')}
            aria-label={t('qrPage.search')} onChange={(e) => setParam({ q: e.target.value })}
          />
        </FormField>
      </div>
      {withoutAreas > 0 && <p className="text-xs text-muted qr-codes-note">{t('qrPage.withoutAreas', { count: withoutAreas })}</p>}

      {rows.length === 0 ? (
        all.length === 0
          ? <EmptyState icon={<Icon name="building" size={28} />} title={t('qrPage.empty')} message={t('qrPage.emptyHint')} />
          : <EmptyState icon={<Icon name="search" size={28} />} title={t('qrPage.noMatch')} message={t('qrPage.noMatchHint')} />
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table className="qr-codes-table">
              <thead>
                <tr>
                  <th>{t('qrPage.col.customer')}</th>
                  <th>{t('qrPage.col.location')}</th>
                  <th>{t('qrPage.col.areas')}</th>
                  <th className="qr-codes-action">{t('qrPage.col.codes')}</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((r) => (
                  <tr key={r.site.id}>
                    <td className="cell-primary">
                      <Link to={`/clients/${r.client.id}?tab=notes`} state={nav} className="table-name-link">
                        <span className="truncate" title={r.label}>{r.label}</span>
                      </Link>
                    </td>
                    <td data-label={t('qrPage.col.location')}>
                      {/* One block, so a phone's card keeps the address under the name (its cell is a row). */}
                      <div className="qr-codes-loc">
                        <div className="truncate" title={r.site.name || ''}>{r.site.name || t('qrPage.unnamedLocation')}</div>
                        {r.address && <div className="text-xs text-muted truncate" title={r.address}>{r.address}</div>}
                      </div>
                    </td>
                    <td data-label={t('qrPage.col.areas')}>
                      {r.areas > 0
                        ? t('qrPage.areaCount', { count: r.areas })
                        : <Badge variant="amber">{t('qrPage.noAreas')}</Badge>}
                    </td>
                    <td data-label={t('qrPage.col.codes')} className="qr-codes-action">
                      <button
                        type="button"
                        className={`btn ${r.areas > 0 ? 'btn-outline' : 'btn-primary'}`}
                        aria-label={t(r.areas > 0 ? 'qrPage.openCodesFor' : 'qrPage.addAreasFor', { location: r.site.name || t('qrPage.unnamedLocation') })}
                        onClick={() => { setDirty(false); setOpened({ id: r.site.id, edit: r.areas === 0 }); }}
                      >
                        {r.areas > 0 ? t('qrPage.openCodes') : t('qrPage.addAreas')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('qrPage.noun')} />
        </>
      )}

      <Modal
        open={!!open}
        onClose={closeCodes}
        title={open ? t('qrPage.modalTitle', { customer: open.label, location: open.site.name || t('qrPage.unnamedLocation') }) : ''}
        size="lg"
      >
        {open && (
          <CleaningInstructionsCard
            key={open.site.id}
            location={open.site}
            canEdit={canSitesEdit}
            startEditing={opened?.edit === true}
            onDirtyChange={setDirty}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={asking}
        title={t('qrPage.discardTitle')}
        message={t('qrPage.discardMessage')}
        confirmLabel={t('common.discard')}
        cancelLabel={t('qrPage.keepEditing')}
        variant="danger"
        onConfirm={() => { setDirty(false); setOpened(null); }}
        onClose={() => setAsking(false)}
      />
    </div>
  );
}
