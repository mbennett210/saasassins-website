import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useSession } from '../../auth/AuthProvider';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import Avatar from '../../components/Avatar';
import Toggle from '../../components/Toggle';
import SignaturePreview from '../../components/SignaturePreview';
import { ROLE_LABELS, ROLE_DESCRIPTIONS, areNotificationsMandatory } from '../../lib/roles';
import { SIGNATURE_IMAGE_WIDTH_PRESETS, DEFAULT_SIGNATURE_IMAGE_WIDTH, signatureImageWidth } from '../../lib/signature';
import { uploadSignatureImage } from '../../lib/signatureApi';
import useSignatureImageSrc from '../../hooks/useSignatureImageSrc';
import { selectVisibleNotificationGroups, selectNotificationPrefs, selectSignaturePrefs } from '../../store/selectors';
import { isNotificationEnabled } from '../../lib/notifications';
import { IDENTITY } from '../../brand/identity.generated.js';
import {
  enableMobilePush,
  disableMobilePush,
  sendTestPush,
  getDevices,
  removeDevice,
  isPushSupported,
  isIOS,
  isStandalonePWA,
  isCurrentDeviceSubscribed,
} from '../../lib/push';

// Kept in step with SIGNATURE_MAX_B64_BYTES in api/_lib/blobBudget.js: 36 KB of image
// is ~48 KB once base64'd, which is what the server enforces per user. Asserted by
// app/scripts/test-blob-budget.mjs so the two cannot drift apart silently.
const SIGNATURE_MAX_IMAGE_BYTES = 36 * 1024;

function MobilePushCard({ user, prefs, dispatch, toast }) {
  const supported = isPushSupported();
  const iosBlocked = isIOS() && !isStandalonePWA();
  // Opt-out master switch — absent/true = on, matching the push dispatcher
  // (api/push/dispatch.js gates on `mobilePushEnabled !== false`). Reading it as
  // `=== true` here made pre-push live users (absent key) see "Off" while the
  // server counted them opted-in. Actual delivery still needs a per-device sub.
  const enabled = prefs.mobilePushEnabled !== false;
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState([]);
  const [subscribed, setSubscribed] = useState(false);
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'default');

  const reload = useCallback(async () => {
    if (!user?.id) return;
    try {
      const [list, sub] = await Promise.all([
        getDevices({ userId: user.id }),
        isCurrentDeviceSubscribed(),
      ]);
      setDevices(list);
      setSubscribed(sub);
    } catch {
      setDevices([]);
      setSubscribed(false);
    }
  }, [user?.id]);

  useEffect(() => { reload(); }, [reload, enabled]);

  const setPref = (next) => {
    dispatch({ type: ACTIONS.UPDATE_NOTIFICATION_PREFS, userId: user.id, patch: { mobilePushEnabled: next } });
  };

  const subscribeThisDevice = async () => {
    setBusy(true);
    try {
      await enableMobilePush({ userId: user.id });
      setPerm(typeof Notification !== 'undefined' ? Notification.permission : 'granted');
      await reload();
      toast.success('This device is subscribed.');
    } catch (err) {
      toast.error(err?.message || 'Could not subscribe this device.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (next) => {
    if (busy) return;
    setBusy(true);
    try {
      if (next) {
        // Pref → on. If the device isn't subscribed yet, also kick off the
        // permission/subscribe flow so the user gets working push immediately.
        if (!subscribed && !iosBlocked) {
          await enableMobilePush({ userId: user.id });
          setPerm(typeof Notification !== 'undefined' ? Notification.permission : 'granted');
        }
        setPref(true);
      } else {
        // Pref → off. Tear down the subscription on this device too.
        await disableMobilePush({ userId: user.id });
        setPref(false);
      }
      await reload();
    } catch (err) {
      // The toggle's intent succeeded (pref state is what the user clicked);
      // only the subscription side-effect failed. Surface the error and
      // leave the pref in whichever state matches what the user intended.
      setPref(next);
      toast.error(err?.message || 'Could not update mobile push.');
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    try {
      const res = await sendTestPush({ userId: user.id });
      if (res?.stub) {
        toast.info('Test push fired locally (stub mode, no backend wired).');
      } else {
        const delivered = res?.delivered ?? 0;
        const failed = res?.failed ?? 0;
        if (delivered === 0) {
          // Never report a green success when nothing was delivered. Common cause:
          // a rotated/mismatched server VAPID keypair 401ing every send, or all
          // subscriptions expired — "sent to 0 devices" used to hide a dead channel.
          toast.error(
            failed > 0
              ? `Test push reached 0 devices. ${failed} failed. The subscription may be expired or the server VAPID keys may not match.`
              : 'Test push reached 0 devices. Subscribe this device first (it may have been unsubscribed).'
          );
        } else if (failed > 0) {
          toast.info(`Test push sent to ${delivered} device${delivered === 1 ? '' : 's'}; ${failed} failed.`);
        } else {
          toast.success(`Test push sent to ${delivered} device${delivered === 1 ? '' : 's'}.`);
        }
      }
    } catch (err) {
      toast.error(err?.message || 'Test push failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveDevice = async (endpoint) => {
    setBusy(true);
    try {
      await removeDevice({ userId: user.id, endpoint });
      await reload();
      toast.success('Device removed.');
    } catch (err) {
      toast.error(err?.message || 'Could not remove device.');
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <div className="card detail-card">
        <div className="push-card-head">
          <div>
            <div className="pref-row-label">Mobile push notifications</div>
            <div className="pref-row-desc">This browser does not support push notifications.</div>
          </div>
        </div>
      </div>
    );
  }

  let statusLine;
  if (!enabled) {
    statusLine = 'Off. Turn on to receive notifications on this device even when the app is closed.';
  } else if (subscribed) {
    statusLine = 'Subscribed on this device. Events you have turned on above will arrive as push notifications.';
  } else if (iosBlocked) {
    statusLine = 'On for your account. Install this app to your home screen to receive push on this iPhone or iPad.';
  } else if (perm === 'denied') {
    statusLine = 'On for your account, but this browser is blocking notifications.';
  } else {
    statusLine = 'On for your account. Subscribe this device to start receiving push here.';
  }

  return (
    <div className="card detail-card">
      <div className="push-card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pref-row-label">Mobile push notifications</div>
          <div className="pref-row-desc">{statusLine}</div>
        </div>
        <Toggle on={enabled} onChange={handleToggle} />
      </div>

      {enabled && iosBlocked && (
        <div className="text-xs text-muted" style={{ marginTop: 8 }}>
          On iPhone or iPad, install this app to your home screen first: tap the share icon in Safari, then "Add to Home Screen", then return here.
        </div>
      )}
      {enabled && !iosBlocked && perm === 'denied' && (
        <div className="text-xs text-danger" style={{ marginTop: 8 }}>
          Notifications are blocked for this site in your browser. Allow them in site settings, then click Subscribe this device.
        </div>
      )}

      {enabled && !subscribed && !iosBlocked && (
        <div className="push-card-actions">
          <button type="button" className="btn btn-primary" onClick={subscribeThisDevice} disabled={busy}>
            Subscribe this device
          </button>
        </div>
      )}

      {enabled && subscribed && (
        <>
          <div className="push-card-actions">
            <button type="button" className="btn btn-secondary" onClick={handleTest} disabled={busy}>
              Send test push
            </button>
          </div>

          {devices.length > 0 && (
            <div className="push-device-list">
              {devices.map((d) => (
                <div key={d.subscriptionId || d.endpoint} className="push-device-row">
                  <div className="push-device-meta">
                    <div className="push-device-label">{d.deviceLabel || 'Device'}</div>
                    <div className="push-device-sub">
                      {d.endpointMasked || d.endpoint?.slice(0, 24) + '…'}
                      {d.lastSeenAt && ` · subscribed ${new Date(d.lastSeenAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={() => handleRemoveDevice(d.endpoint)} disabled={busy}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Per-user email signature — text + optional image, auto-appended to outbound
// Messaging emails (replies/forwards included). Emails send real HTML with the
// image inline (Content-ID); the preview here renders through SignaturePreview,
// the shared source of truth, so the preview matches the sent email (§48).
// Content fields (text / image / size) use an explicit draft + Save + toast
// (§48); the `enabled` toggle auto-saves immediately + silently (§8).
function SignatureCard({ user, dispatch, toast }) {
  const state = useStore();
  const prefs = selectSignaturePrefs(state, user.id);
  const fileRef = useRef(null);

  // Local draft for the content fields — nothing persists until Save. Resynced
  // when the user identity changes (last-write-wins, pipelineDraft precedent).
  const draftFrom = (sp) => ({
    text: sp.text || '',
    imageDataUrl: sp.imageDataUrl || null,
    imagePath: sp.imagePath || null,
    imageWidth: sp.imageWidth ?? DEFAULT_SIGNATURE_IMAGE_WIDTH,
  });
  const [draft, setDraft] = useState(() => draftFrom(prefs));
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState(false);
  // Bumped after every successful upload. The object key is deterministic and the
  // upload upserts, so replacing one PNG with another leaves the PATH identical —
  // without this the preview would keep showing the previous image. See the hook.
  const [imageReloadKey, setImageReloadKey] = useState(0);
  useEffect(() => {
    setDraft(draftFrom(selectSignaturePrefs(state, user.id)));
    // Resync keyed on user.id only — a fresh dispatch shouldn't clobber edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  const onPickImage = (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif)$/.test(file.type)) {
      toast.error('Please choose a PNG, JPG, or GIF image.');
      return;
    }
    // 36 KB of image ≈ 48 KB once base64'd. That was the per-user BLOB budget
    // (api/_lib/blobBudget.js) back when the bytes lived in org_state; the image now
    // goes to Storage, but the cap stays because the server enforces the same number
    // and a signature is a small flat image by nature. Checked here only so the user
    // finds out before uploading — the server is the real gate.
    if (file.size > SIGNATURE_MAX_IMAGE_BYTES) {
      toast.error(`Signature image must be under ${Math.round(SIGNATURE_MAX_IMAGE_BYTES / 1024)} KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = String(ev.target?.result || '');
      if (!dataUrl) { toast.error('Could not read that image.'); return; }
      // Upload at PICK time, not at Save. The image has to be in Storage before the
      // preview can render it (the bucket is private, so the preview needs a signed URL
      // for a real object). An abandoned draft leaves one unreferenced object behind,
      // which the next upload overwrites — the key is per-user and upserted.
      setUploading(true);
      const r = await uploadSignatureImage(dataUrl);
      setUploading(false);
      if (!r.ok) { toast.error(r.error); return; }
      // imageDataUrl is cleared here: that is the point of C07. Leaving the legacy
      // base64 in place would keep the bytes in the shared blob forever while the
      // reader silently preferred the Storage copy.
      setDraft((d) => ({ ...d, imagePath: r.path, imageDataUrl: null }));
      setImageReloadKey((k) => k + 1);
    };
    reader.onerror = () => toast.error('Could not read that image.');
    reader.readAsDataURL(file);
  };

  const hasImage = Boolean(draft.imagePath || draft.imageDataUrl);
  const hasContent = Boolean((draft.text || '').trim() || hasImage);
  const dirty =
    (draft.text || '') !== (prefs.text || '')
    || (draft.imageDataUrl || null) !== (prefs.imageDataUrl || null)
    || (draft.imagePath || null) !== (prefs.imagePath || null)
    || signatureImageWidth(draft) !== signatureImageWidth(prefs);
  const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 };

  // The thumbnail next to "Remove image" resolves through the same hook as the
  // WYSIWYG preview, so both shapes render identically and neither knows which it has.
  const draftImageSrc = useSignatureImageSrc({ ...draft, enabled: true }, imageReloadKey);

  const cancel = () => { setDraft(draftFrom(prefs)); setEditing(false); };
  const save = () => {
    dispatch({
      type: ACTIONS.UPDATE_SIGNATURE_PREFS,
      userId: user.id,
      patch: {
        text: draft.text,
        imageDataUrl: draft.imageDataUrl,
        imagePath: draft.imagePath,
        imageWidth: signatureImageWidth(draft),
      },
    });
    toast.success('Signature saved');
    setEditing(false);
  };

  return (
    <div className="card detail-card">
      <div className="push-card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pref-row-label">Email signature</div>
          <div className="pref-row-desc">
            {prefs.enabled
              ? 'Added automatically to new emails, replies, and forwards you send from Messaging.'
              : 'Off. Your signature is not added to outgoing emails.'}
          </div>
        </div>
        <Toggle on={prefs.enabled} onChange={(next) => dispatch({ type: ACTIONS.UPDATE_SIGNATURE_PREFS, userId: user.id, patch: { enabled: next } })} />
      </div>

      {!editing ? (
        <div style={{ marginTop: 14 }}>
          {hasContent ? (
            <>
              <div style={labelStyle}>Preview</div>
              <div className="card" style={{ padding: 12, background: 'var(--inset-bg)' }}>
                <SignaturePreview prefs={{ ...draft, enabled: true }} />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted" style={{ margin: 0 }}>No signature added yet.</p>
          )}
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>Edit</button>
          </div>
        </div>
      ) : (
      <>
      <div style={{ marginTop: 14 }}>
        <div style={labelStyle}>Signature text</div>
        <textarea
          className="input"
          style={{ width: '100%', minHeight: 96, resize: 'vertical', lineHeight: 1.5 }}
          placeholder={`${user.name || 'Your name'}\n${IDENTITY.name}\n${IDENTITY.company.phone}`}
          value={draft.text || ''}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={labelStyle}>Signature image (optional)</div>
        {hasImage ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {draftImageSrc && (
              <img
                src={draftImageSrc}
                alt="Signature"
                style={{ maxHeight: 64, maxWidth: 240, borderRadius: 6, border: '1px solid var(--border-light)' }}
              />
            )}
            {/* Clears BOTH shapes: a user who removes the image must not be left with
                the legacy base64 still in the blob and still being sent. The Storage
                object is left in place. It is overwritten on the next upload, and
                deleting it here would break an unsaved Cancel. */}
            <button type="button" className="btn btn-outline" onClick={() => setDraft((d) => ({ ...d, imageDataUrl: null, imagePath: null }))}>
              Remove image
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? 'Uploading…' : 'Add image'}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif"
          hidden
          onChange={onPickImage}
        />
        <div className="text-xs text-muted" style={{ marginTop: 6 }}>
          PNG, JPG, or GIF, up to {Math.round(SIGNATURE_MAX_IMAGE_BYTES / 1024)} KB. Shows up in your signature on every email you send.
        </div>
      </div>

      {/* Display-width scaling (S/M/L) — only meaningful with an image. Same
          segmented idiom as the compose channel toggle. */}
      {hasImage && (
        <div style={{ marginTop: 14 }}>
          <div style={labelStyle}>Image size</div>
          <div style={{ display: 'flex', gap: 6 }} role="group" aria-label="Signature image size">
            {Object.entries(SIGNATURE_IMAGE_WIDTH_PRESETS).map(([key, w]) => {
              const active = signatureImageWidth(draft) === w;
              const label = key === 'S' ? 'Small' : key === 'M' ? 'Medium' : 'Large';
              return (
                <button
                  key={key}
                  type="button"
                  className={`btn ${active ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setDraft((d) => ({ ...d, imageWidth: w }))}
                  aria-pressed={active}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {hasContent && (
        <div style={{ marginTop: 14 }}>
          <div style={labelStyle}>Preview</div>
          <div className="card" style={{ padding: 12, background: 'var(--inset-bg)' }}>
            <SignaturePreview prefs={{ ...draft, enabled: true }} />
          </div>
        </div>
      )}

      <div className="inline-edit-savebar">
        <span className="save-hint">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
        <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
      </div>
      </>
      )}
    </div>
  );
}

// Change the password used to sign in (authed/Supabase mode only).
function ChangePasswordCard() {
  const { updatePassword } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 8) { toast.error('Password must be at least 8 characters.'); return; }
    if (pw !== confirm) { toast.error('Passwords do not match.'); return; }
    setBusy(true);
    const { error } = await updatePassword(pw);
    setBusy(false);
    if (error) { toast.error(error.message || 'Could not change password.'); return; }
    setPw(''); setConfirm('');
    toast.success('Password changed.');
  };

  return (
    <form className="card detail-card" onSubmit={submit}>
      <div style={{ marginBottom: 12 }}>
        <h2 className="page-head-title" style={{ fontSize: 16 }}>Password</h2>
      </div>
      <div className="form-row">
        <FormField label="New password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} help="At least 8 characters" autoComplete="new-password" />
        <FormField label="Confirm new password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="modal-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </form>
  );
}

export default function SettingsAccount() {
  const { currentUser, authConfigured } = useAuth();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const [form, setForm] = useState(currentUser);

  useEffect(() => { setForm(currentUser); }, [currentUser]);

  if (!currentUser) return null;

  const save = (e) => {
    e.preventDefault();
    // In authed mode the email IS the Supabase login identity (the app maps
    // session→team-member by email), so it must not change here or the user
    // would lock themselves out. Only editable in local-only mode.
    const patch = { name: form.name, phone: form.phone, initials: form.initials };
    if (!authConfigured) patch.email = form.email;
    dispatch({ type: ACTIONS.UPDATE_USER, id: currentUser.id, patch });
    toast.success('Profile saved');
  };

  const prefs = selectNotificationPrefs(state, currentUser.id) || {};
  const groups = selectVisibleNotificationGroups(state, currentUser.id);

  const setPref = (key, value) => {
    dispatch({
      type: ACTIONS.UPDATE_NOTIFICATION_PREFS,
      userId: currentUser.id,
      patch: { [key]: value },
    });
  };

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Your Account</h1>
      </div>

      <div className="account-grid">
        <div className="account-col">
          <form className="card detail-card" onSubmit={save}>
            <div className="flex-row" style={{ gap: 16, alignItems: 'center', marginBottom: 20 }}>
              <Avatar initials={currentUser.initials} variant={currentUser.avatar} size="lg" />
              <div>
                <div className="text-sm font-semi">{ROLE_LABELS[currentUser.role]}</div>
                <div className="text-xs text-muted">{ROLE_DESCRIPTIONS[currentUser.role]}</div>
              </div>
            </div>
            <div className="form-row">
              <FormField label="Full name" required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <FormField label="Initials" value={form.initials || ''} onChange={(e) => setForm({ ...form, initials: e.target.value.toUpperCase().slice(0, 3) })} help="2–3 characters used in the avatar" />
            </div>
            <div className="info-banner" role="note">
              <div>
                <strong>Account email vs. connected mailboxes.</strong>{' '}
                Your account email is what we use to sign you in and to send you
                app notifications, password resets, etc. Mailboxes you connect under{' '}
                <strong>Settings → Connected Inboxes</strong> are different. 
                those are the addresses you send and receive <em>as</em> inside
                Messaging. The two can be the same person, but they're stored
                separately and {IDENTITY.name} never assumes one matches the other.
              </div>
            </div>
            <div className="form-row">
              <FormField
                label="Email"
                type="email"
                value={form.email || ''}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                disabled={authConfigured}
                help={authConfigured ? 'Your sign-in email. Contact a Super Admin to change it.' : undefined}
              />
              <FormField label="Phone" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>

          <MobilePushCard user={currentUser} prefs={prefs} dispatch={dispatch} toast={toast} />

          {/* Crew don't send outbound emails, so no signature for them. */}
          {currentUser.role !== 'crew' && (
            <SignatureCard user={currentUser} dispatch={dispatch} toast={toast} />
          )}

          {authConfigured && <ChangePasswordCard />}
        </div>

        <div className="card detail-card">
          <div style={{ marginBottom: 12 }}>
            <h2 className="page-head-title" style={{ fontSize: 16 }}>Notifications</h2>
            {areNotificationsMandatory(currentUser) && (
              <p className="text-sm text-muted">
                Notifications are required for your role and can’t be turned off.
              </p>
            )}
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-muted">No notification preferences are available for your role.</p>
          ) : (
            groups.map((group, idx) => (
              <div key={group.id} style={{ marginTop: idx === 0 ? 8 : 18 }}>
                <h3 className="perm-group-head">{group.label}</h3>
                {group.items.map((item) => (
                  <div key={item.key} className="pref-row">
                    <div className="pref-row-text">
                      <div className="pref-row-label">{item.label}</div>
                      {item.description && <div className="pref-row-desc">{item.description}</div>}
                    </div>
                    <Toggle
                      // Single source of truth shared with the fan-out gates, so
                      // display and delivery always agree: opt-out keys read ON
                      // unless explicitly false; opt-in (defaultOff) keys read ON
                      // only when explicitly true. Crew notifications are mandatory
                      // (lib/roles) — the toggle reads ON and is locked; the reducer
                      // refuses a mute at the write point too.
                      on={areNotificationsMandatory(currentUser) ? true : isNotificationEnabled(prefs, item.key)}
                      onChange={(next) => setPref(item.key, next)}
                      disabled={areNotificationsMandatory(currentUser)}
                    />
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
