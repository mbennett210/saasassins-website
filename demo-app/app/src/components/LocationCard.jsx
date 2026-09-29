import { useEffect, useMemo, useRef, useState } from 'react';
import FormField from './FormField';
import ContactPicker from './ContactPicker';
import SecurityCard from './SecurityCard';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { usePermission } from '../hooks/usePermission';
import { selectContactById } from '../store/selectors';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { geocodeAddress } from '../lib/geoApi';
import { composeAddress, parseAddress } from '../lib/address';
import { IDENTITY } from '../brand/identity.generated.js';

// The account's single location, on the ACCESS tab. Read-first but nothing is hidden:
// the read view shows ALL of it (address, geofence, access instructions + attachments,
// expected clean time, site contact, door/alarm codes masked) — "Edit" flips the
// editable fields to inputs (Save/Cancel, UI_RULES §101). Photos/video sit alongside on
// the same tab; cleaning instructions on the Notes tab; the geofence MAP was dropped
// (the clock-in center still auto-geocodes from the address on save).
export default function LocationCard({ client, location, canEdit }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canAttach = usePermission('sites.attachments');
  const [editing, setEditing] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const fileRef = useRef(null);
  const securityRef = useRef(null); // imperative save() for the embedded door/alarm codes

  const buildForm = () => {
    if (!location) return null;
    const addr = (location.street || location.city || location.state || location.zip)
      ? { street: location.street || '', city: location.city || '', state: location.state || '', zip: location.zip || '' }
      : parseAddress(location.address || '');
    return {
      name: location.name || '',
      ...addr,
      address: location.address || '',
      accessNotes: location.accessNotes || '',
      siteContactId: location.siteContactId || null,
      attachments: Array.isArray(location.attachments) ? location.attachments : [],
      expectedCleanMins: Number.isFinite(location.expectedCleanMins) ? String(location.expectedCleanMins) : '',
      lat: Number.isFinite(location.lat) ? location.lat : null,
      lng: Number.isFinite(location.lng) ? location.lng : null,
      geocodedAddress: location.geocodedAddress || null,
      geofenceRadiusM: Number.isFinite(location.geofenceRadiusM) ? location.geofenceRadiusM : null,
    };
  };
  const [form, setForm] = useState(buildForm);
  // Resync when the underlying location changes (external edit / route change).
  useEffect(() => { setForm(buildForm()); }, [location?.id, location?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const locationContact = useMemo(
    () => (location?.siteContactId ? selectContactById(state, location.siteContactId) : null),
    [state, location?.siteContactId],
  );

  const handleFile = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    const accepted = [];
    for (const f of files) {
      if (f.size > ATTACHMENT_MAX_BYTES) { toast.error(`"${f.name}" is ${formatBytes(f.size)}. Over the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit.`); continue; }
      accepted.push({ name: f.name, size: f.size, type: f.type });
    }
    if (accepted.length > 0) setForm((prev) => ({ ...prev, attachments: [...(prev.attachments || []), ...accepted] }));
  };
  const removeAttachment = (idx) => setForm((prev) => ({ ...prev, attachments: (prev.attachments || []).filter((_, i) => i !== idx) }));

  const save = async () => {
    if (!location || !form) return;
    if (!form.name.trim() || !form.street.trim() || !form.city.trim()) { toast.error('Location name, street, and city are required'); return; }
    if (form.expectedCleanMins === '' || !(Number(form.expectedCleanMins) > 0)) {
      toast.error('Expected clean time (minutes) is required. It sets the variance baseline for this location.');
      return;
    }
    const address = composeAddress(form);
    // The clock-in geofence center is set automatically from the address (server-side
    // geocode). Re-geocode only when the address actually changed; in local/demo mode
    // there is no backend so it skips silently (geofence inert, no map to show).
    let { lat, lng, geocodedAddress } = form;
    if (address && address !== geocodedAddress) {
      setGeoBusy(true);
      try {
        const r = await geocodeAddress(address);
        lat = +Number(r.lat).toFixed(6); lng = +Number(r.lng).toFixed(6); geocodedAddress = address;
      } catch (err) {
        if (!err.stub) toast.error('Couldn’t locate this address. It will save without a clock-in location. Double-check the address.');
      } finally { setGeoBusy(false); }
    }
    // Persist the door/alarm codes through SecurityCard (encryption stays in one
    // place); abort the whole save if that fails so nothing half-saves.
    try { await securityRef.current?.save(); } catch { return; }
    dispatch({ type: ACTIONS.UPDATE_SITE, id: location.id, patch: {
      name: form.name.trim(),
      street: form.street.trim(), city: form.city.trim(), state: form.state.trim(), zip: form.zip.trim(),
      address,
      accessNotes: form.accessNotes.trim(),
      siteContactId: form.siteContactId || null,
      attachments: form.attachments,
      expectedCleanMins: form.expectedCleanMins === '' ? null : Math.max(0, Math.round(Number(form.expectedCleanMins) || 0)),
      lat, lng, geocodedAddress,
      geofenceRadiusM: form.geofenceRadiusM,
      geofenceEnabled: true, // always on — no per-site opt-out
    } });
    toast.success('Location updated');
    setEditing(false);
  };
  const cancel = () => { setForm(buildForm()); setEditing(false); };

  return (
    <div className="card detail-card">
      <div className="overview-card-head">
        <h3>Location</h3>
        {canEdit && !editing && location && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>

      {!location ? (
        <p className="text-sm text-muted" style={{ margin: 0 }}>No location on file for this account.</p>
      ) : !editing ? (
        <>
          <dl className="detail-dl">
            <div><dt>Address</dt><dd>{location.address || composeAddress(location) || '—'}</dd></div>
            <div><dt>Geofence</dt><dd>{Number.isFinite(location.lat) && Number.isFinite(location.lng)
              ? 'On, clock-in location set'
              : 'On, locating from the address'}</dd></div>
            <div><dt>Access instructions</dt><dd>{location.accessNotes || '—'}</dd></div>
            <div><dt>Expected clean time</dt><dd>{Number.isFinite(location.expectedCleanMins) ? `${location.expectedCleanMins} min` : '—'}</dd></div>
            <div><dt>Location contact</dt><dd>{locationContact ? <>{locationContact.firstName} {locationContact.lastName}</> : '—'}</dd></div>
          </dl>
          {Array.isArray(location.attachments) && location.attachments.length > 0 && (
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">Access attachments</label>
              <div className="site-attachment-list">
                {location.attachments.map((a, i) => (
                  <span key={`${a.name}-${i}`} className="email-attachment-chip">
                    <Icon name="paperclip" size={12} />
                    <span>{a.name}</span>
                    <span className="text-muted text-xs">({formatBytes(a.size)})</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <SecurityCard siteId={location.id} readOnly />
        </>
      ) : (
        <>
          <FormField label="Location name" required placeholder="e.g., Main Hospital" value={form.name}
            onChange={(e) => set({ name: e.target.value })} />
          <FormField label="Street address" required placeholder="123 Example St" value={form.street}
            onChange={(e) => set({ street: e.target.value })} />
          <div className="site-addr-row">
            {/* the hints are the brand's own city, state and ZIP (UI_RULES §129) */}
            <FormField label="City" required placeholder={IDENTITY.company.locality} value={form.city} onChange={(e) => set({ city: e.target.value })} />
            <FormField label="State" placeholder={IDENTITY.company.region} value={form.state} onChange={(e) => set({ state: e.target.value })} />
            <FormField label="ZIP" placeholder={IDENTITY.company.postalCode} value={form.zip} onChange={(e) => set({ zip: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Location contact</label>
            <ContactPicker value={form.siteContactId} onChange={(id) => set({ siteContactId: id })} companyId={client.id} placeholder="Select a contact…" />
            <div className="text-xs text-muted" style={{ marginTop: 4 }}>Optional. Who to call when crew arrives. Defaults to the company&apos;s primary contact.</div>
          </div>
          {/* Access instructions = the crew-facing "how to get in" for this account:
              the notes text PLUS its attachments, grouped together. Both are shown to
              any crew member assigned to this customer. */}
          <FormField label="Access instructions" as="textarea" placeholder="Gate code, best entrance, security contact…"
            help="Shown to any crew member assigned to this customer."
            value={form.accessNotes} onChange={(e) => set({ accessNotes: e.target.value })} />

          {canAttach && (
            <div className="form-group">
              <label className="form-label">Access attachments</label>
              <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
                Files for the access instructions above — site maps, gate codes, walkthrough PDFs. Visible to any crew member assigned to this customer. Max {formatBytes(ATTACHMENT_MAX_BYTES)} per file. (Photos &amp; video are shown below on this tab.)
              </div>
              {form.attachments.length > 0 && (
                <div className="site-attachment-list">
                  {form.attachments.map((a, i) => (
                    <span key={`${a.name}-${i}`} className="email-attachment-chip">
                      <Icon name="paperclip" size={12} />
                      <span>{a.name}</span>
                      <span className="text-muted text-xs">({formatBytes(a.size)})</span>
                      <button type="button" className="chip-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(i)}>&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <input ref={fileRef} type="file" multiple hidden onChange={handleFile} />
              <button type="button" className="btn btn-success" onClick={() => fileRef.current?.click()} style={{ marginTop: form.attachments.length > 0 ? 8 : 0 }}>
                Add Attachment
              </button>
            </div>
          )}

          <div className="field-narrow">
            <FormField label="Expected clean time (minutes)" required type="number" placeholder="e.g. 120"
              help="How long this location should take. Variance flags cleans that run over or under."
              value={form.expectedCleanMins} onChange={(e) => set({ expectedCleanMins: e.target.value })} />
          </div>

          <SecurityCard ref={securityRef} siteId={location.id} embedded />

          <div className="inline-edit-savebar">
            <span className="save-hint">Editing location</span>
            <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={geoBusy} onClick={save}>{geoBusy ? 'Locating…' : 'Save Changes'}</button>
          </div>
        </>
      )}
    </div>
  );
}
