import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import { useStore } from '../store';
import { selectActiveClients } from '../store/selectors';
import { customerLabel } from '../lib/customerNumber';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import PickerCapNote from './PickerCapNote';
import { composeAddress } from '../lib/address';
import { startHubPreview } from '../lib/hubPreview';
import { buildingPath } from '../pages/hub/hubNav';
import { useT } from '../i18n/react';

// "Preview the customer hub" from the user menu (the client hub redesign, plan §3.7, decision D2):
// pick ONE building, and the hub opens as that building's customer (HUB_PREVIEW_ACTS_AS_CUSTOMER).
// The user menu shows the entry only to a holder of `hub.users.view`, and the server checks that key
// again on every call of the preview (api/_lib/authz.js requireHubCaller) — this is only the way in.
//
// The buildings are a LIST in the dialog, not a dropdown (Daniel, 2026-10-09: "the modal is way too
// scrunched and you can barely see the dropdown options" — a select's menu inside a narrow dialog
// was cut off by the dialog's own scroll box). A search box narrows it; the list renders at most
// PICKER_MAX_VISIBLE rows and says how many more there are, in the shared footnote under the search
// box (PickerCapNote; the customer book is ~750 buildings at the stated scale, UI_RULES §127), so
// typing reaches every one. A click picks a row, a double-click or Enter on a picked row opens it.
// Vendors are not buildings with customers.
export function startPreviewOf(navigate, client) {
  if (!client?.id || !startHubPreview({ buildingId: client.id, name: client.name || '' })) return false;
  navigate(buildingPath(client.id));
  return true;
}

export default function HubPreviewPicker({ open, onClose }) {
  const t = useT();
  const navigate = useNavigate();
  const state = useStore();
  const clients = selectActiveClients(state);
  const [pick, setPick] = useState('');
  const [query, setQuery] = useState('');

  const buildings = useMemo(() => (clients || [])
    .filter((c) => c && c.id && c.type !== 'vendor')
    .map((c) => ({
      client: c,
      label: customerLabel(c),
      address: composeAddress({ street: c.street, city: c.city, state: c.state, zip: c.zip }),
    }))
    .sort((a, b) => a.label.localeCompare(b.label)), [clients]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? buildings.filter((b) => `${b.label} ${b.address}`.toLowerCase().includes(q)) : buildings;
  }, [buildings, query]);
  const { shown, noteMsg } = capOptions(matches, PICKER_MAX_VISIBLE);

  const close = () => { setPick(''); setQuery(''); onClose?.(); };
  const openBuilding = (id) => {
    const b = buildings.find((x) => x.client.id === id);
    if (b && startPreviewOf(navigate, b.client)) close();
  };
  // Enter in the search box with exactly one building left picks and opens it.
  const onSearchKey = (e) => {
    if (e.key === 'Enter' && matches.length === 1) { e.preventDefault(); openBuilding(matches[0].client.id); }
  };

  return (
    <Modal open={open} onClose={close} title={t('userMenu.previewHub')} size="md">
      <p className="text-sm text-muted">{t('hubPreview.pickHelp')}</p>
      <div className="hpp">
        <input
          className="input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder={t('hubPreview.search')}
          aria-label={t('hubPreview.search')}
          autoFocus
        />
        <PickerCapNote note={noteMsg} />
        <div className="hpp-list" role="listbox" aria-label={t('hubPreview.building')}>
          {shown.length === 0 && (
            <div className="text-sm text-muted hpp-empty">{query ? t('hubPreview.noMatch') : t('hubPreview.empty')}</div>
          )}
          {shown.map((b) => (
            <button
              key={b.client.id}
              type="button"
              role="option"
              aria-selected={pick === b.client.id}
              className={`menu-option hpp-row ${pick === b.client.id ? 'active' : ''}`}
              onClick={() => setPick(b.client.id)}
              onDoubleClick={() => openBuilding(b.client.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' && pick === b.client.id) { e.preventDefault(); openBuilding(b.client.id); } }}
            >
              <span className="hpp-text">
                <span className="hpp-name">{b.label}</span>
                {b.address && <span className="hpp-addr text-xs text-muted">{b.address}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={close}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!pick} onClick={() => openBuilding(pick)}>{t('hubPreview.open')}</button>
      </div>
    </Modal>
  );
}
