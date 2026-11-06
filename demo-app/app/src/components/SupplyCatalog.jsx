// The Supplies page's CATALOG tab — the org's master supply list (Matt, the Oct 6 call: "We can
// have a master template… quantity, price per quantity or per item, the SKU number, and then
// it's going to be the little Bible there"; plan 2026-10-11 §2, D2–D4), and since S131 (Matt's
// board sm-web-03, "Supply Catalog — products approved for ordering, assigned per property") each
// BUILDING's products.
//
//   • A building picker (a searchable FilterSelect — 750 buildings, the filters rule): "All
//     products" is the master list; a building shows ITS switched-on products.
//   • All products: image · SKU · Item · Category · How it comes · Price · On N buildings, one server
//     page of 20 with its total (GET /api/supplies/catalog), a search (name or SKU) and a category
//     filter in the .filter-bar, all in the URL (?cq= / ?ccat= / ?cp= / ?cb=) so Back restores the
//     view; the office (supplies.manage) adds and edits an item in a kit Modal — the category a free
//     label with the ones in use suggested (D3), and its PRODUCT IMAGE (shrunk on the device, lib/
//     imageCanvas shrinkPhoto, then suppliesApi.uploadCatalogImage) — and deletes it through a
//     ConfirmDialog that says how many buildings have it switched on; a SKU another item holds is
//     refused BY NAME (the route's 409 names the holder, D2). "Import items" (task 257) brings the
//     catalog in from a spreadsheet: components/SupplyCatalogImport.
//   • One building: image · name + how it comes · SKU · unit cost · Edit, and "+ Add product" — pick
//     one from the master list (switches it on for the building) or create one (saved, then
//     switched on). The board's footer line says the rule: cleaners order only from this list.
//
// A building's switches are also on the building's own customer page (components/
// SupplyListSwitches). Loading, error-with-Try-again (§117) and an honest offline line (§131) are
// real states; nothing is queued on the phone.
//
// LANGUAGES: every word is a catalog line (`supplyPage.catalog.*`, UI_RULES §140); the items' own
// names, SKUs, categories and units travel as the office wrote them.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { selectActiveClients, selectClientById } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { usePagedRows } from '../hooks/usePagedRows';
import { searchRows } from '../lib/searchRows';
import { customerLabel } from '../lib/customerNumber';
import { shrinkPhoto } from '../lib/imageCanvas';
import { blobToDataUrl } from '../lib/avatarApi';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useTableSearch } from '../hooks/useTableSearch';
import { useServerPager } from '../hooks/useServerPager';
import { useToast } from './Toast';
import { money } from '../lib/dates';
import {
  SUPPLY_NO_CATEGORY, SUPPLY_NAME_MAX, SUPPLY_SKU_MAX, SUPPLY_CATEGORY_MAX, SUPPLY_UNIT_MAX, SUPPLY_IMAGE_EDGE, SUPPLY_IMAGE_MAX_BYTES,
} from '../lib/supplies';
import * as suppliesApi from '../lib/suppliesApi';
import Icon from './Icon';
import Modal from './Modal';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import ConfirmDialog from './ConfirmDialog';
import EmptyState from './EmptyState';
import TableSearch from './TableSearch';
import ListPager from './ListPager';
import SupplyCatalogImport from './SupplyCatalogImport';
import { useT } from '../i18n/react';

export default function SupplyCatalog() {
  const t = useT();
  const toast = useToast();
  const state = useStore();
  const online = useOnlineStatus() !== false;
  const canManage = usePermission('supplies.manage');
  const [params, setParams] = useSearchParams();
  // S131: the building picker (?cb=) — "All products" (the master list) or one building's products.
  const building = params.get('cb') || '';
  const activeClients = useMemo(() => selectActiveClients(state), [state]);
  const buildingOptions = useMemo(() => [
    { value: '', label: t('supplyPage.catalog.allProducts') },
    ...activeClients.map((c) => ({ value: c.id, label: customerLabel(c) })),
  ], [activeClients, t]);
  const buildingClient = building ? selectClientById(state, building) : null;
  const setParam = useCallback((patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => { if (v == null || v === '') next.delete(k); else next.set(k, v); });
    return next;
  }, { replace: true }), [setParams]);
  const [q, setQ] = useTableSearch('cq', { reset: ['cp'] }); // a new search starts on page 1, one address update (CS-720)
  const category = params.get('ccat') || '';
  const page = Math.max(1, Number(params.get('cp')) || 1);

  // One server read per view: { items (+ buildings), total, page, pageSize, categories }.
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (building) return undefined; // one building's products are its own read (BuildingCatalog)
    let live = true;
    setErr(null);
    const timer = setTimeout(() => {
      suppliesApi.listCatalog({ q, category, page })
        .then((r) => { if (live) setData(r); })
        .catch((e) => { if (live) { setData(null); setErr(e); } });
    }, q ? 250 : 0); // a typed search waits for a pause
    return () => { live = false; clearTimeout(timer); };
  }, [q, category, page, tick, building]);

  const pager = useServerPager(data ? data.items : null, {
    total: data ? data.total : 0, page: data ? data.page : 1, pageSize: data ? data.pageSize : suppliesApi.SUPPLY_PAGE_SIZE,
    setPage: (p) => setParam({ cp: p > 1 ? p : null }),
  });
  const categories = (data && data.categories) || [];
  const categoryOptions = [
    { value: '', label: t('supplyPage.catalog.allCategories') },
    ...categories.map((c) => ({ value: c, label: c })),
    { value: SUPPLY_NO_CATEGORY, label: t('supplyPage.catalog.noCategory') },
  ];
  const filtered = !!(q || category);

  const [editing, setEditing] = useState(null); // null | 'new' | the item
  // "+ Add product" on a building: the master list to pick from, or a new product switched on.
  const [adding, setAdding] = useState(false);
  const [createFor, setCreateFor] = useState(null); // the building a new product is switched on for
  const [deleting, setDeleting] = useState(null);
  const [importing, setImporting] = useState(false); // task 257: Import items (SupplyCatalogImport)
  const [busy, setBusy] = useState(false);
  async function remove(item) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await suppliesApi.deleteCatalogItem(item.id);
      const n = Number(r && r.buildings) || 0;
      toast.success(n ? t('supplyPage.catalog.deleted', { item: item.name, count: n }) : t('supplyPage.catalog.deletedNone', { item: item.name }));
      reload();
    } catch (e) {
      if (e && e.status === 404) { toast.info(t('supplyPage.catalog.gone')); reload(); }
      else toast.error(t('supplyPage.toast.failed'));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  const buildingPicker = (
    <FormField label={t('supplyPage.catalog.building')}>
      <FilterSelect
        ariaLabel={t('supplyPage.catalog.building')}
        value={building}
        onChange={(v) => setParam({ cb: v || null, cp: null, cq: null, ccat: null })}
        options={buildingOptions}
      />
    </FormField>
  );

  if (building) {
    return (
      <>
        <p className="text-sm text-muted supply-cat-lead">{t('supplyPage.catalog.leadBuilding')}</p>
        <div className="filter-bar">{buildingPicker}</div>
        <BuildingCatalog
          clientId={building} buildingName={buildingClient ? customerLabel(buildingClient) : '—'} canManage={canManage} online={online}
          reloadKey={tick} onEdit={setEditing} onAdd={() => setAdding(true)}
        />
        <p className="text-xs text-muted supply-cat-foot">{t('supplyPage.catalog.footer')}</p>
        {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}
        {adding && (
          <AddProductModal
            clientId={building} buildingName={buildingClient ? customerLabel(buildingClient) : '—'}
            onCreate={() => { setAdding(false); setCreateFor(building); setEditing('new'); }}
            onAdded={reload}
            onClose={() => setAdding(false)}
          />
        )}
        {editing && (
          <CatalogItemModal
            item={editing === 'new' ? null : editing}
            categories={categories}
            onClose={() => { setEditing(null); setCreateFor(null); }}
            onSaved={async (item, created) => {
              // A product created here is switched on for this building in the same breath.
              if (created && createFor) {
                try { await suppliesApi.assignItems({ clientId: createFor, on: [item.id] }); }
                catch { toast.error(t('supplyPage.toast.failed')); }
              }
              toast.success(created ? t('supplyPage.catalog.added', { item: item.name }) : t('supplyPage.catalog.saved', { item: item.name }));
              setEditing(null); setCreateFor(null);
              reload();
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <p className="text-sm text-muted supply-cat-lead">{t('supplyPage.catalog.lead')}</p>
      <div className="filter-bar">
        {buildingPicker}
        <FormField label={t('supplyPage.catalog.category')}>
          <FilterSelect
            ariaLabel={t('supplyPage.catalog.category')}
            value={category}
            onChange={(v) => setParam({ ccat: v || null, cp: null })}
            options={categoryOptions}
          />
        </FormField>
      </div>

      {err ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('supplyPage.catalog.loadFailed')}
          message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
          action={<button type="button" className="btn btn-primary" onClick={reload}>{t('supplyPage.tryAgain')}</button>}
        />
      ) : !data ? (
        <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>
      ) : data.total === 0 && !filtered ? (
        <EmptyState
          icon={<Icon name="box" size={28} />}
          title={t('supplyPage.catalog.emptyTitle')}
          message={canManage ? t('supplyPage.catalog.emptyOffice') : t('supplyPage.catalog.emptyOther')}
          action={canManage && (
            <div className="supply-cat-actions">
              <button type="button" className="btn btn-outline" onClick={() => setImporting(true)} disabled={!online}>{t('supplyImport.open')}</button>
              <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} disabled={!online}>{t('supplyPage.catalog.add')}</button>
            </div>
          )}
        />
      ) : (
        <>
          <div className="table-head">
            <div className="table-controls">
              <TableSearch value={q} onChange={setQ} placeholder={t('supplyPage.catalog.search')} />
              <span className="table-count">{t('supplyPage.catalog.count', { count: data.total })}</span>
              <span className="spacer" />
              {canManage && (
                <button type="button" className="btn btn-outline" onClick={() => setImporting(true)} disabled={!online}>{t('supplyImport.open')}</button>
              )}
              {canManage && (
                <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} disabled={!online}>{t('supplyPage.catalog.add')}</button>
              )}
            </div>
          </div>

          {data.total === 0 ? (
            <EmptyState icon={<Icon name="search" size={28} />} title={t('supplyPage.noSearchMatch')} message={t('supplyPage.noSearchMatchHint')} />
          ) : (
            <>
              <div className="table-wrap mobile-stack">
                <table>
                  <thead>
                    <tr>
                      <th>{t('supplyPage.catalog.col.sku')}</th>
                      <th>{t('supplyPage.catalog.col.item')}</th>
                      <th>{t('supplyPage.catalog.col.category')}</th>
                      <th>{t('supplyPage.catalog.col.howItComes')}</th>
                      <th className="supply-num">{t('supplyPage.catalog.col.price')}</th>
                      <th className="supply-num">{t('supplyPage.catalog.col.buildings')}</th>
                      {canManage && <th className="supply-actions-col"><span className="sr-only">{t('supplyPage.col.actions')}</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageRows.map((c) => (
                      <tr key={c.id}>
                        {/* i18n-ok: the SKU as the office wrote it */}
                        <td data-label={t('supplyPage.catalog.col.sku')} className="supply-nowrap">{c.sku || <span className="text-muted">—</span>}</td>
                        <td className="cell-primary supply-item-name">
                          <span className="supply-cat-item"><ProductThumb url={c.imageUrl} /><span className="truncate" title={c.name}>{c.name}</span></span>
                        </td>
                        <td data-label={t('supplyPage.catalog.col.category')}>{c.category
                          ? <span className="truncate" title={c.category}>{c.category}</span>
                          : <span className="text-muted">{t('supplyPage.catalog.noCategory')}</span>}</td>
                        <td data-label={t('supplyPage.catalog.col.howItComes')}><span className="truncate" title={c.unit || t('supplyPage.each')}>{c.unit || t('supplyPage.each')}</span></td>
                        <td data-label={t('supplyPage.catalog.col.price')} className="supply-money supply-num">{Number(c.unitPrice) > 0 ? money(c.unitPrice) : <span className="text-muted">{t('supplyPage.noPrice')}</span>}</td>
                        <td data-label={t('supplyPage.catalog.col.buildings')} className="supply-num supply-nowrap">{t('supplyPage.catalog.onBuildings', { count: c.buildings || 0 })}</td>
                        {canManage && (
                          <td className="cell-actions supply-actions-col">
                            <div className="supply-row-actions">
                              <button type="button" className="btn btn-sm btn-outline" disabled={!online} onClick={() => setEditing(c)}>{t('supplyPage.catalog.edit')}</button>
                              <button type="button" className="btn btn-sm btn-outline" disabled={!online || busy} onClick={() => setDeleting(c)}>{t('supplyPage.catalog.delete')}</button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ListPager pager={pager} noun={t('pager.noun.items')} />
            </>
          )}
        </>
      )}
      {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}

      {editing && (
        <CatalogItemModal
          item={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={(item, created) => {
            toast.success(created ? t('supplyPage.catalog.added', { item: item.name }) : t('supplyPage.catalog.saved', { item: item.name }));
            setEditing(null);
            reload();
          }}
        />
      )}

      {canManage && <SupplyCatalogImport open={importing} onClose={() => { setImporting(false); reload(); }} />}

      <ConfirmDialog
        open={!!deleting}
        title={deleting ? t('supplyPage.catalog.deleteTitle', { item: deleting.name }) : ''}
        message={deleting && deleting.buildings
          ? t('supplyPage.catalog.deleteMessage', { count: deleting.buildings })
          : t('supplyPage.catalog.deleteMessageNone')}
        confirmLabel={t('supplyPage.catalog.delete')}
        variant="danger"
        onConfirm={() => deleting && remove(deleting)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

// Add or edit one catalog item: labelled fields above their boxes (§16). SKU, category and price
// are optional (D2, SUP-4); the category suggests the labels already in use (D3). A SKU another
// item holds comes back from the route naming that item, shown on the SKU field.
function CatalogItemModal({ item, categories, onClose, onSaved }) {
  const t = useT();
  // S131: the product image — the one it has, a newly picked one (shown before it is saved), or
  // taken off. It is stored after the item's words, on the version the save answered.
  const [picked, setPicked] = useState(null);       // { file, preview }
  const [dropImage, setDropImage] = useState(false);
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.preview); }, [picked]);
  const shownImage = picked ? picked.preview : (dropImage ? null : (item?.imageUrl || null));
  const [sku, setSku] = useState(item?.sku || '');
  const [name, setName] = useState(item?.name || '');
  const [category, setCategory] = useState(item?.category || '');
  const [unit, setUnit] = useState(item?.unit || '');
  const [price, setPrice] = useState(Number(item?.unitPrice) > 0 ? String(item.unitPrice) : '');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  // A new item's id is minted once, so a retried save is the same item, never a second one.
  const [newId] = useState(() => suppliesApi.newSupplyCatalogId());
  async function submit(e) {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    const raw = String(price).replace(/[^0-9.]/g, '');
    const value = raw ? parseFloat(raw) : null;
    const next = {};
    if (!trimmed) next.name = t('supplyPage.catalog.nameRequired');
    if (raw && !(value > 0)) next.price = t('supplyPage.catalog.priceInvalid');
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      let saved = await suppliesApi.saveCatalogItem({
        id: item ? item.id : newId, sku: sku.trim(), name: trimmed, category: category.trim(), unit: unit.trim(), unitPrice: value,
      });
      if (picked || (dropImage && item?.imageUrl)) {
        try {
          if (picked) {
            // Shrunk on the device to about SUPPLY_IMAGE_EDGE (a camera photo becomes a small JPEG).
            const file = await shrinkPhoto(picked.file, { maxEdge: SUPPLY_IMAGE_EDGE, smallBytes: 0 });
            if (file.size > SUPPLY_IMAGE_MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'too_large' });
            saved = await suppliesApi.uploadCatalogImage({ id: saved.id, version: saved.version, dataUrl: await blobToDataUrl(file) });
          } else {
            saved = await suppliesApi.uploadCatalogImage({ id: saved.id, version: saved.version, remove: true });
          }
        } catch (imgErr) {
          // The words saved; the picture did not. Say so on the form and keep it open.
          setErrors({ image: t(imgErr && (imgErr.code === 'too_large' || imgErr.code === 'bad_image') ? 'supplyPage.catalog.imageInvalid' : 'supplyPage.catalog.imageFailed') });
          setSaving(false);
          return;
        }
      }
      onSaved(saved, !item);
    } catch (err) {
      if (err && err.code === 'sku_taken') {
        setErrors({ sku: t('supplyPage.catalog.skuTaken', { sku: sku.trim(), item: err.holder ? err.holder.name : '—' }) });
      } else if (err && err.code === 'bad_price') {
        setErrors({ price: t('supplyPage.catalog.priceInvalid') });
      } else {
        setErrors({ form: t('supplyPage.toast.failed') });
      }
      setSaving(false);
    }
  }
  const listId = 'supply-catalog-categories';
  return (
    <Modal open onClose={onClose} size="md" title={item ? t('supplyPage.catalog.editTitle') : t('supplyPage.catalog.addTitle')}>
      <form onSubmit={submit} noValidate>
        <FormField label={t('supplyPage.catalog.image')} error={errors.image}>
          <div className="supply-cat-image">
            <ProductThumb url={shownImage} large />
            <div className="supply-cat-image-actions">
              <label className="btn btn-outline">
                {t(shownImage ? 'supplyPage.catalog.imageChange' : 'supplyPage.catalog.imagePick')}
                <input
                  type="file" accept="image/jpeg,image/png" hidden
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    e.target.value = '';
                    if (f) { setPicked({ file: f, preview: URL.createObjectURL(f) }); setDropImage(false); }
                  }}
                />
              </label>
              {shownImage && (
                <button type="button" className="btn btn-link" onClick={() => { setPicked(null); setDropImage(true); }}>{t('supplyPage.catalog.imageRemove')}</button>
              )}
            </div>
          </div>
        </FormField>
        <FormField label={t('supplyPage.catalog.name')} name="supply-catalog-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('supplyPage.catalog.namePlaceholder')} error={errors.name} maxLength={SUPPLY_NAME_MAX} autoFocus />
        <div className="form-row">
          <FormField label={t('supplyPage.catalog.sku')} name="supply-catalog-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t('supplyPage.catalog.skuPlaceholder')} error={errors.sku} help={t('supplyPage.catalog.skuHelp')} maxLength={SUPPLY_SKU_MAX} />
          <FormField label={t('supplyPage.catalog.categoryField')} name="supply-catalog-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('supplyPage.catalog.categoryPlaceholder')} help={t('supplyPage.catalog.categoryHelp')} maxLength={SUPPLY_CATEGORY_MAX} list={listId} />
        </div>
        <datalist id={listId}>
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <div className="form-row">
          <FormField label={t('supplyPage.catalog.howItComes')} name="supply-catalog-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={t('supplyPage.each')} help={t('supplyPage.catalog.howItComesHelp')} maxLength={SUPPLY_UNIT_MAX} />
          <FormField label={t('supplyPage.catalog.price')} name="supply-catalog-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={t('supplyPage.catalog.pricePlaceholder')} error={errors.price} help={t('supplyPage.catalog.priceHelp')} />
        </div>
        {item && <p className="form-help">{t('supplyPage.catalog.editHint')}</p>}
        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{item ? t('common.save') : t('supplyPage.catalog.add')}</button>
        </div>
      </form>
    </Modal>
  );
}

// A product's picture, or the box glyph where it has none (the board's image tile).
function ProductThumb({ url, large = false }) {
  return (
    <span className={`supply-thumb${large ? ' is-large' : ''}`} aria-hidden="true">
      {url ? <img src={url} alt="" loading="lazy" /> : <Icon name="box" size={large ? 24 : 16} />}
    </span>
  );
}

// ONE BUILDING's products (S131, Matt's board sm-web-03): its switched-on items read through the
// catalog (GET /api/supplies/items — a complete read; a building's list is a few dozen), searched
// and paged on the page: image · name + how it comes · SKU · unit cost · Edit.
function BuildingCatalog({ clientId, buildingName, canManage, online, reloadKey, onEdit, onAdd }) {
  const t = useT();
  const [q, setQ] = useTableSearch('cq', { reset: ['cp'] });
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setErr(null);
    setItems(null);
    suppliesApi.listItems(clientId)
      .then((r) => { if (live) setItems(r); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [clientId, reloadKey, tick]);
  const found = useMemo(() => searchRows(items || [], q, (it) => `${it.name} ${it.sku || ''} ${it.unit || ''}`), [items, q]);
  const pager = usePagedRows(found, { param: 'cp', resetKey: `${clientId}|${q}` });
  // The edit form edits the CATALOG item this switch is over (the building's row holds only the link).
  const asCatalogItem = (it) => ({
    id: it.catalogItemId, sku: it.sku, name: it.name, category: it.category, unit: it.unit, unitPrice: it.unitPrice,
    imageUrl: it.imageUrl || null, imageV: it.imageV || null,
  });
  if (err) {
    return (
      <EmptyState
        icon={<Icon name="warning" size={28} />}
        title={t('supplyPage.list.loadFailed')}
        message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
        action={<button type="button" className="btn btn-primary" onClick={() => setTick((n) => n + 1)}>{t('supplyPage.tryAgain')}</button>}
      />
    );
  }
  if (!items) return <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="box" size={28} />}
        title={t('supplyPage.list.emptyTitle', { customer: buildingName })}
        message={canManage ? t('supplyPage.catalog.buildingEmpty') : t('supplyPage.list.emptyOther')}
        action={canManage && <button type="button" className="btn btn-primary" onClick={onAdd} disabled={!online}>{t('supplyPage.catalog.addProduct')}</button>}
      />
    );
  }
  return (
    <>
      <div className="table-head">
        <div className="table-controls">
          <TableSearch value={q} onChange={setQ} placeholder={t('supplyPage.catalog.search')} />
          <span className="table-count">{t('supplyPage.catalog.count', { count: found.length })}</span>
          <span className="spacer" />
          {canManage && <button type="button" className="btn btn-primary" onClick={onAdd} disabled={!online}>{t('supplyPage.catalog.addProduct')}</button>}
        </div>
      </div>
      {found.length === 0 ? (
        <EmptyState icon={<Icon name="search" size={28} />} title={t('supplyPage.noSearchMatch')} message={t('supplyPage.noSearchMatchHint')} />
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr>
                  <th>{t('supplyPage.catalog.col.product')}</th>
                  <th>{t('supplyPage.catalog.col.sku')}</th>
                  <th className="supply-num">{t('supplyPage.catalog.col.unitCost')}</th>
                  {canManage && <th className="supply-actions-col"><span className="sr-only">{t('supplyPage.col.actions')}</span></th>}
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((it) => (
                  <tr key={it.id}>
                    <td className="cell-primary">
                      {/* i18n-ok: the item's own name and how it comes, as the office wrote them */}
                      <span className="supply-cat-item">
                        <ProductThumb url={it.imageUrl} />
                        <span className="supply-cat-item-text">
                          <span className="truncate supply-item-name" title={it.name}>{it.name}</span>
                          <span className="text-xs text-muted truncate">{it.unit || t('supplyPage.each')}</span>
                        </span>
                      </span>
                    </td>
                    {/* i18n-ok: the SKU as the office wrote it */}
                    <td data-label={t('supplyPage.catalog.col.sku')} className="supply-nowrap">{it.sku || <span className="text-muted">—</span>}</td>
                    <td data-label={t('supplyPage.catalog.col.unitCost')} className="supply-money supply-num">{Number(it.unitPrice) > 0 ? money(it.unitPrice) : <span className="text-muted">{t('supplyPage.noPrice')}</span>}</td>
                    {canManage && (
                      <td className="cell-actions supply-actions-col">
                        <button type="button" className="btn btn-sm btn-outline" disabled={!online} onClick={() => onEdit(asCatalogItem(it))}>{t('supplyPage.catalog.edit')}</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('pager.noun.items')} />
        </>
      )}
    </>
  );
}

// "+ Add product" for one building: every catalog item it does not have yet (the whole catalog,
// one complete read), searchable; "Add" switches one on (POST items/assign) — or create a new
// product, which is saved and switched on.
function AddProductModal({ clientId, buildingName, onCreate, onAdded, onClose }) {
  const t = useT();
  const toast = useToast();
  const [all, setAll] = useState(null);
  const [on, setOn] = useState(null);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.all([suppliesApi.listCatalog({ all: true }), suppliesApi.listItems(clientId)])
      .then(([cat, items]) => { if (!live) return; setAll(cat.items || []); setOn(new Set((items || []).map((it) => it.catalogItemId))); })
      .catch(() => { if (live) { setAll([]); setOn(new Set()); toast.error(t('supplyPage.catalog.loadFailed')); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);
  const offList = useMemo(() => (all && on ? all.filter((c) => !on.has(c.id)) : []), [all, on]);
  const found = useMemo(() => searchRows(offList, q, (c) => `${c.name} ${c.sku || ''} ${c.category || ''}`).slice(0, 50), [offList, q]);
  async function add(c) {
    if (busyId) return;
    setBusyId(c.id);
    try {
      await suppliesApi.assignItems({ clientId, on: [c.id] });
      setOn((s) => new Set([...s, c.id]));
      toast.success(t('supplyPage.catalog.addedTo', { item: c.name, customer: buildingName }));
      onAdded();
    } catch { toast.error(t('supplyPage.toast.failed')); }
    finally { setBusyId(null); }
  }
  return (
    <Modal open onClose={onClose} size="md" title={t('supplyPage.catalog.addProductTitle', { customer: buildingName })}>
      <TableSearch value={q} onChange={setQ} placeholder={t('supplyPage.catalog.search')} />
      {!all ? <p className="text-muted text-sm supply-loading">{t('common.loading')}</p> : found.length === 0 ? (
        <p className="text-sm text-muted">{offList.length === 0 ? t('supplyPage.catalog.allOn') : t('supplyPage.noSearchMatch')}</p>
      ) : (
        <ul className="supply-cat-pick">
          {found.map((c) => (
            <li key={c.id}>
              <ProductThumb url={c.imageUrl} />
              {/* i18n-ok: the item's own name and SKU, as the office wrote them */}
              <span className="supply-cat-item-text"><span className="truncate">{c.name}</span><span className="text-xs text-muted truncate">{[c.sku, c.unit].filter(Boolean).join(' · ') || t('supplyPage.each')}</span></span>
              <button type="button" className="btn btn-outline" disabled={!!busyId} onClick={() => add(c)}>{t('supplyPage.catalog.addOne')}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-link supply-cat-create" onClick={onCreate}>{t('supplyPage.catalog.createProduct')}</button>
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('supplyPage.switches.done')}</button>
      </div>
    </Modal>
  );
}
