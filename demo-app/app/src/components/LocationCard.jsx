import { useEffect, useMemo, useRef, useState } from 'react';
import FormField from './FormField';
import ContactPicker from './ContactPicker';
import SecurityCard from './SecurityCard';
import Badge from './Badge';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { usePermission } from '../hooks/usePermission';
import { selectContactById } from '../store/selectors';
import { formatBytes } from '../lib/attachments';
import { geocodeAddress } from '../lib/geoApi';
import { composeAddress, parseAddress } from '../lib/address';
import { GEOCODE_STATUS, GEOCODE_REASON, resolveGeocodeOutcome, coordsMatchAddress } from '../lib/geocodeLocation';
import { uploadSiteAttachment, deleteSiteAttachment, attachmentUrl, isAttachmentStored, ATTACHMENT_SCOPE } from '../lib/siteAttachmentsApi';
import { SITE_ATTACHMENT_ALLOWED_MIME, SITE_ATTACHMENT_MAX_BYTES, siteAttachmentWriteAllowed } from '../lib/siteAttachmentRules';
import { useAuth } from '../hooks/useAuth';
import { IDENTITY } from '../brand/identity.generated.js';
import { useT } from '../i18n/react';

// The account's single location, on the ACCESS tab. Read-first but nothing is hidden:
// the read view shows ALL of it (address, geofence, access instructions + attachments,
// expected clean time, site contact, door/alarm codes masked) — "Edit" flips the
// editable fields to inputs (Save/Cancel, UI_RULES §101). Photos/video sit alongside on
// the same tab; cleaning instructions on the Notes tab; the geofence MAP was dropped
// (the clock-in center still auto-geocodes from the address on save).
export default function LocationCard({ client, location, canEdit }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  // Who may add or remove an access file: the server's own rule (CS-692) — editing the
  // location AND `sites.attachments` AND an office role, crew never.
  const { currentUser } = useAuth();
  const canAttachKey = usePermission('sites.attachments');
  const canAttach = siteAttachmentWriteAllowed(currentUser?.role, { canEditSites: !!canEdit, canAttach: canAttachKey });
  const [editing, setEditing] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
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
      // Carried so `resolveGeocode` sees the full `previous` state and can tell an
      // unchanged-already-located address (no lookup) from one that needs one.
      geocodeStatus: location.geocodeStatus ?? null,
      geocodeCheckedAt: location.geocodeCheckedAt || null,
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

  // Upload the BYTES as soon as a file is picked (CS-043). This used to push
  // `{ name, size, type }` into the form and stop there, so the file was never uploaded
  // anywhere and the chip named a document nobody could open — while the copy right above
  // it promised crew site maps and walkthrough PDFs. Uploading on pick (not on Save) means
  // the chip only ever appears for a file that really landed, and a failed upload is
  // reported at the moment it fails instead of being discovered months later.
  const handleFile = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    setUploading(true);
    for (const f of files) {
      // The cap the SERVER enforces, so the instant feedback and the eventual refusal
      // agree. This read invoice/marketing's own ATTACHMENT_MAX_BYTES — a second constant
      // that merely happened to hold the same number.
      if (f.size > SITE_ATTACHMENT_MAX_BYTES) { toast.error(`"${f.name}" is ${formatBytes(f.size)}. Over the ${formatBytes(SITE_ATTACHMENT_MAX_BYTES)} limit.`); continue; }
      try {
        const meta = await uploadSiteAttachment(f, { scope: ATTACHMENT_SCOPE.SITE, ownerId: location.id });
        setForm((prev) => ({ ...prev, attachments: [...(prev.attachments || []), meta] }));
      } catch (err) {
        toast.error(`"${f.name}" didn’t upload. ${err.message || 'Please try again.'}`);
      }
    }
    setUploading(false);
  };
  // Removing from the form also removes the bytes: an object nothing references is a file
  // nobody can reach and nobody can delete later. Best-effort, so a Storage hiccup can't
  // strand the row on screen.
  const removeAttachment = (idx) => {
    const att = (form.attachments || [])[idx];
    setForm((prev) => ({ ...prev, attachments: (prev.attachments || []).filter((_, i) => i !== idx) }));
    if (att) deleteSiteAttachment(att, { scope: ATTACHMENT_SCOPE.SITE, ownerId: location.id });
  };

  // Open one attachment through a short-lived signed URL. A pre-CS-043 row has no bytes
  // behind it at all, so it says so rather than opening a dead link.
  const openAttachment = async (att) => {
    if (!isAttachmentStored(att)) {
      toast.error(`"${att.name}" was recorded before files were uploaded, so there’s nothing to open. Re-attach it.`);
      return;
    }
    try {
      const url = await attachmentUrl(att, { scope: ATTACHMENT_SCOPE.SITE, ownerId: location.id });
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else toast.error(`Couldn’t open "${att.name}".`);
    } catch (err) {
      toast.error(err.message || `Couldn’t open "${att.name}".`);
    }
  };

  const save = async () => {
    if (!location || !form) return;
    if (!form.name.trim() || !form.street.trim() || !form.city.trim()) { toast.error('Location name, street, and city are required'); return; }
    if (form.expectedCleanMins === '' || !(Number(form.expectedCleanMins) > 0)) {
      toast.error('Expected clean time (minutes) is required. It sets the variance baseline for this location.');
      return;
    }
    const address = composeAddress(form);
    // The clock-in geofence centre comes from the address, server-side, through the ONE
    // shared rule in lib/geocodeLocation.js (the same one every create path uses). It
    // calls the geocoder at most once, and only when the address actually changed.
    //
    // A FAILED lookup CLEARS the coordinates (CS-041). This used to keep the previous
    // pair while telling the manager it "will save without a clock-in location", so after
    // an address change crew went on being measured against the old address. No
    // coordinates is the honest state: lib/geo.js returns 'no_site_coords' and the punch
    // is allowed but flagged, instead of confidently judged against the wrong place.
    //
    // A lookup the server REFUSED (CS-083: this sign-in's hourly allowance, or the company's
    // daily quota) learns nothing: the patch clears the stale pair and leaves the location
    // NOT_ATTEMPTED, so it is still "not located" and still in the import's Locate list.
    setGeoBusy(true);
    const lookup = await resolveGeocodeOutcome({ address, previous: form, geocode: geocodeAddress });
    const geo = lookup.patch;
    setGeoBusy(false);
    if (lookup.kind === 'limited') {
      toast.error(t('geocode.limitedSave'));
    } else if (geo.geocodeStatus === GEOCODE_STATUS.NOT_LOCATED && address) {
      toast.error(`${GEOCODE_REASON[GEOCODE_STATUS.NOT_LOCATED]} The location saves, but the clock-in area isn’t set.`);
    } else if (geo.geocodeStatus === GEOCODE_STATUS.UNAVAILABLE && form.geocodeStatus !== GEOCODE_STATUS.UNAVAILABLE) {
      toast.error(`${GEOCODE_REASON[GEOCODE_STATUS.UNAVAILABLE]} The location saves without it.`);
    }
    // Persist the door/alarm codes through SecurityCard (encryption stays in one place).
    // A code failure must NOT take the rest of the location with it (CS-037): this used
    // to `catch { return; }`, so an unset OPS_CODE_ENCRYPTION_KEY on the server threw a
    // 500 and discarded the name, address, geofence, access notes and expected clean
    // time the manager had just typed. The codes are a separate store (a server route)
    // from the rest (the blob), so saving one without the other leaves nothing
    // half-written — it just tells the truth about which part landed.
    let codesError = null;
    try { await securityRef.current?.save(); } catch (err) { codesError = err; }
    dispatch({ type: ACTIONS.UPDATE_SITE, id: location.id, patch: {
      name: form.name.trim(),
      street: form.street.trim(), city: form.city.trim(), state: form.state.trim(), zip: form.zip.trim(),
      address,
      accessNotes: form.accessNotes.trim(),
      siteContactId: form.siteContactId || null,
      attachments: form.attachments,
      expectedCleanMins: form.expectedCleanMins === '' ? null : Math.max(0, Math.round(Number(form.expectedCleanMins) || 0)),
      ...geo, // lat, lng, geocodedAddress, geocodeStatus, geocodeCheckedAt — always all five
      geofenceRadiusM: form.geofenceRadiusM,
      geofenceEnabled: true, // always on — no per-site opt-out
    } });
    if (codesError) {
      // The rest IS saved. Stay in edit mode so the typed codes are still on screen to
      // retry — SecurityCard owns its own input state, which this dispatch doesn't touch.
      toast.error(`${codesError.message || 'The door and alarm codes couldn’t be saved.'} Everything else on this location was saved.`);
      return;
    }
    toast.success('Location updated');
    setEditing(false);
  };
  const cancel = () => { setForm(buildForm()); setEditing(false); };

  // Retry the lookup from the READ view, without reopening the editor — the office's
  // move once a Maps key is finally set (CS-036) or an address is corrected elsewhere.
  // One call per click, never on a timer or a keystroke: this same path will run over
  // ~750 imported buildings, so nothing here may loop.
  const located = coordsMatchAddress(location, location?.address || composeAddress(location || {}));
  const locateNow = async () => {
    const address = location.address || composeAddress(location);
    if (!address) { toast.error('Add a street and city first — there’s no address to locate.'); return; }
    setGeoBusy(true);
    const lookup = await resolveGeocodeOutcome({ address, previous: { ...location, geocodedAddress: null }, geocode: geocodeAddress });
    const geo = lookup.patch;
    setGeoBusy(false);
    // Refused (CS-083): nothing was learned and the address hasn't changed, so the location is
    // left exactly as it was.
    if (lookup.kind === 'limited') { toast.error(t('geocode.limited')); return; }
    dispatch({ type: ACTIONS.UPDATE_SITE, id: location.id, patch: geo });
    if (geo.geocodeStatus === GEOCODE_STATUS.LOCATED) toast.success('Clock-in location set from the address');
    else toast.error(GEOCODE_REASON[geo.geocodeStatus] || 'Couldn’t locate this address.');
  };

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
            {/* The geofence line tells the truth about whether the clock-in area exists.
                It used to read "On, locating from the address" whenever coordinates were
                missing — which implied work in progress that was never happening: only
                this editor's Save ever geocoded (CS-042), and a failed lookup silently
                kept the previous address's coordinates (CS-041). With no
                GOOGLE_MAPS_API_KEY in production (CS-036) that is the state of most
                accounts, so it has to be visible, with the REASON and a way to retry. */}
            <div><dt>Geofence</dt><dd>
              {located ? 'On, clock-in location set' : (
                <>
                  <Badge variant="amber">Address not located</Badge>
                  <div className="form-help">
                    {GEOCODE_REASON[location.geocodeStatus] || 'The clock-in area hasn’t been placed from this address yet.'}
                    {' '}Clock-ins here are allowed and flagged for review until it is.
                  </div>
                  {canEdit && (
                    <button type="button" className="btn btn-link" style={{ paddingLeft: 0 }} disabled={geoBusy} onClick={locateNow}>
                      {geoBusy ? 'Locating…' : 'Locate address'}
                    </button>
                  )}
                </>
              )}
            </dd></div>
            <div><dt>Access instructions</dt><dd>{location.accessNotes || '—'}</dd></div>
            <div><dt>Expected clean time</dt><dd>{Number.isFinite(location.expectedCleanMins) ? `${location.expectedCleanMins} min` : '—'}</dd></div>
            <div><dt>Location contact</dt><dd>{locationContact ? <>{locationContact.firstName} {locationContact.lastName}</> : '—'}</dd></div>
          </dl>
          {Array.isArray(location.attachments) && location.attachments.length > 0 && (
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">Access attachments</label>
              {/* The chip OPENS the file now (CS-043). It used to be inert text naming a
                  document that had never been uploaded. A row from before the upload
                  existed has no bytes, so it is marked rather than offered. */}
              <div className="site-attachment-list">
                {location.attachments.map((a, i) => (
                  <span key={`${a.name}-${i}`} className="email-attachment-chip">
                    <Icon name="paperclip" size={12} />
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => openAttachment(a)}
                      title={isAttachmentStored(a) ? `Open ${a.name}` : 'This file was never uploaded — re-attach it'}
                    >
                      {a.name}
                    </button>
                    <span className="text-muted text-xs">
                      ({formatBytes(a.size)}{isAttachmentStored(a) ? '' : ' · not uploaded'})
                    </span>
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
                Files for the access instructions above — site maps, gate codes, walkthrough PDFs. Visible to any crew member assigned to this customer. Max {formatBytes(SITE_ATTACHMENT_MAX_BYTES)} per file. (Photos &amp; video are shown below on this tab.)
              </div>
              {form.attachments.length > 0 && (
                <div className="site-attachment-list">
                  {form.attachments.map((a, i) => (
                    <span key={`${a.name}-${i}`} className="email-attachment-chip">
                      <Icon name="paperclip" size={12} />
                      <button type="button" className="btn btn-link" onClick={() => openAttachment(a)}>{a.name}</button>
                      <span className="text-muted text-xs">
                        ({formatBytes(a.size)}{isAttachmentStored(a) ? '' : ' · not uploaded'})
                      </span>
                      <button type="button" className="chip-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(i)}>&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <input ref={fileRef} type="file" multiple hidden accept={SITE_ATTACHMENT_ALLOWED_MIME.join(',')} onChange={handleFile} />
              <button type="button" className="btn btn-success" disabled={uploading} onClick={() => fileRef.current?.click()} style={{ marginTop: form.attachments.length > 0 ? 8 : 0 }}>
                {uploading ? 'Uploading…' : 'Add Attachment'}
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
