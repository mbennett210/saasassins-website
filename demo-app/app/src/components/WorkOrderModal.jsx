import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { selectVisibleSitesFor, selectClientById } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import {
  RAISABLE_WO_TYPES, WO_TYPE_META, WO_PRIORITIES, WO_PRIORITY_META,
  WO_CATEGORIES, WO_CATEGORY_META, UNCATEGORIZED_LABEL, LOCATION_ERROR_KEYS,
} from '../lib/workOrders';
import SearchSelect from './SearchSelect';
import MediaGallery from './MediaGallery';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

// Log a work order (relational problem_reports — the staff/crew logging surface).
// Staff-logged work orders are origin 'internal'; the client portal sets origin
// 'portal' when a client raises one (later increment). Names resolve server-side in
// real mode; clientName/siteName ride along for the demo stub. Mirrors the old
// ProblemModal, grown with type + priority (priority replaces severity).
// A work order is logged AT A LOCATION (CS-697): its completion photo is filed under the building
// and its queue is the building's manager, so one logged with no location (the old default) could never be
// resolved. Its words are still this form's English; the new ones are catalog lines.
// `presetTitle` / `presetSiteAreaId` (QR Wave 2): the area page's New request opens on its location and
// its AREA — the title starts as the area's name, and the area travels as `siteAreaId` (builder R makes
// the server store it; until then the route builds the ticket field by field and leaves it out) only
// while the location is still the one it opened on (another location has other areas).
export default function WorkOrderModal({ open, onClose, onCreated, presetSiteId = '', presetTitle = '', presetSiteAreaId = null }) {
  const t = useT();
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  // Crew only see sites for clients they're assigned to; managers see all.
  const sites = useMemo(() => selectVisibleSitesFor(state, currentUser), [state, currentUser]);
  // WO-12: `category` starts EMPTY — uncategorized is a real state, and pre-selecting
  // 'Other' would make the report that motivated the field read as if someone had chosen.
  const [form, setForm] = useState({ siteId: presetSiteId, title: presetTitle, description: '', type: 'issue', priority: 'medium', category: '' });
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('form');   // 'form' → fill it out · 'photos' → attach optional photo
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (open) { setForm({ siteId: presetSiteId, title: presetTitle, description: '', type: 'issue', priority: 'medium', category: '' }); setPhase('form'); setCreated(null); }
  }, [open, presetSiteId, presetTitle]);

  const save = async () => {
    if (!form.siteId) return;
    if (!form.title.trim()) { toast.error('A title is required'); return; }
    setBusy(true);
    try {
      const site = sites.find((s) => s.id === form.siteId);
      const client = site ? selectClientById(state, site.clientId) : null;
      const problem = await qcApi.createProblem({
        siteId: form.siteId, clientId: site?.clientId || null,
        title: form.title.trim(), description: form.description,
        type: form.type, priority: form.priority, category: form.category || null, origin: 'internal',
        reportedByUserId: currentUser?.id || null,
        siteName: site?.name || null, clientName: client?.name || null,
        ...(presetSiteAreaId && form.siteId === presetSiteId ? { siteAreaId: presetSiteAreaId } : {}),
      });
      toast.success('Work order logged');
      // Logged at its location → stay open for an optional photo (media is filed under the site).
      setCreated(problem); setPhase('photos');
    } catch (e) { toast.error(errorText(t, e, 'workOrders.modal.saveFailed', LOCATION_ERROR_KEYS)); }
    finally { setBusy(false); }
  };

  const finish = () => { onCreated?.(created); onClose(); };

  return (
    <Modal
      open={open}
      onClose={phase === 'photos' ? finish : onClose}
      title={phase === 'photos' ? 'Add a photo' : 'New work order'}
    >
      {phase === 'photos' && created ? (
        <div>
          <p className="text-muted" style={{ marginTop: 0 }}>
            ✓ Work order logged{(created.client_name || created.site_name) ? <> at <strong>{created.client_name || created.site_name}</strong></> : ''}. Add a photo so the team can see the issue. Optional.
          </p>
          <MediaGallery
            siteId={created.site_id}
            clientId={created.client_id}
            scope="problem_report"
            refId={created.id}
            label="Photos & video"
            hint="Attach a photo of the issue. Managers see these on the work order."
          />
          {/* WO-10: resolving needs a completion photo, so say so where the photos are added
              rather than only at the point of refusal. */}
          <p className="text-xs text-muted">A completion photo is required before this ticket can be resolved.</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={finish}>Done</button>
          </div>
        </div>
      ) : (
        <div className="wo-form">
          <FormField label={t('workOrders.modal.location')} required help={t('workOrders.modal.locationHelp')}>
            <SearchSelect
              value={form.siteId}
              onChange={(id) => setForm({ ...form, siteId: id || '' })}
              options={sites.map((s) => { const c = selectClientById(state, s.clientId); return { value: s.id, label: c?.name || s.name, sublabel: s.address || '' }; })}
              placeholder={t('workOrders.modal.pickLocation')}
              searchPlaceholder={t('workOrders.modal.searchLocations')}
            />
          </FormField>
          <FormField label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Broken soap dispenser, 2nd floor restroom" />
          <FormField label="Details" as="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What's wrong or requested, where, and any detail the team needs." />
          <div className="form-group">
            <label className="form-label">Type</label>
            <div className="tab-container-line" role="group" aria-label="Type">
              {/* WO-19: a failed inspection's ticket is the app's own, never raised by hand. */}
              {RAISABLE_WO_TYPES.map((t) => (
                <button key={t} type="button" className={`tab-btn ${form.type === t ? 'active' : ''}`} onClick={() => setForm({ ...form, type: t })}>{WO_TYPE_META[t].label}</button>
              ))}
            </div>
          </div>
          {/* WO-12 (Matt, 2026-09-29): the reporting category — a second axis beside Type.
              Optional: an uncategorized ticket is honest, and the list can be filtered by it.
              Seven answers are quick-pick CHIPS that wrap (UI_RULES §124, §184), never a one-row §7 strip:
              squeezed into the popup's 430px, the strip drew its seven words over each other (Matt,
              2026-10-30: "Need to fix the options", CS-955). */}
          <div className="form-group">
            <label className="form-label" id="wo-category-label">Category <span className="text-muted text-xs">(for reporting)</span></label>
            <div className="chip-picker wo-category-picks" role="group" aria-labelledby="wo-category-label">
              <button type="button" className={`chip${!form.category ? ' on' : ''}`} aria-pressed={!form.category} onClick={() => setForm({ ...form, category: '' })}>{UNCATEGORIZED_LABEL}</button>
              {WO_CATEGORIES.map((c) => (
                <button key={c} type="button" className={`chip${form.category === c ? ' on' : ''}`} aria-pressed={form.category === c} title={WO_CATEGORY_META[c].hint} onClick={() => setForm({ ...form, category: c })}>{WO_CATEGORY_META[c].label}</button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Priority</label>
            <div className="tab-container-line" role="group" aria-label="Priority">
              {WO_PRIORITIES.map((p) => (
                <button key={p} type="button" className={`tab-btn ${form.priority === p ? 'active' : ''}`} onClick={() => setForm({ ...form, priority: p })}>{WO_PRIORITY_META[p].label}</button>
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || !form.siteId} onClick={save}>{busy ? 'Saving…' : 'Log work order'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
