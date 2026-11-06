import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useSession } from '../../auth/AuthProvider';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import AvatarPhotoControl from '../../components/AvatarPhotoControl';
import Toggle from '../../components/Toggle';
import SignaturePreview from '../../components/SignaturePreview';
import LanguageCard from '../../components/LanguageCard';
import { areNotificationsMandatory } from '../../lib/roles';
import { SIGNATURE_IMAGE_WIDTH_PRESETS, DEFAULT_SIGNATURE_IMAGE_WIDTH, signatureImageWidth } from '../../lib/signature';
import { uploadSignatureImage } from '../../lib/signatureApi';
import useSignatureImageSrc from '../../hooks/useSignatureImageSrc';
import { selectVisibleNotificationGroups, selectNotificationPrefs, selectSignaturePrefs } from '../../store/selectors';
import { isNotificationEnabled } from '../../lib/notifications';
import {
  quietHoursFor, smsAlertsEnabled, isSmsOptedOut, toE164, QUIET_HOURS_DEFAULTS,
} from '../../lib/alertDelivery';
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
import { fmtDate } from '../../lib/dates';
import { useT } from '../../i18n/react';
import { errorText } from '../../i18n/errors';

// Your account — every person's own settings, cleaners included, so every word is a
// catalog line in their language (CS-193). The role names and descriptions come from the
// catalog too (`role.*`), keyed by the schema role.

// Kept in step with SIGNATURE_MAX_B64_BYTES in api/_lib/blobBudget.js: 36 KB of image
// is ~48 KB once base64'd, which is what the server enforces per user. Asserted by
// app/scripts/test-blob-budget.mjs so the two cannot drift apart silently.
const SIGNATURE_MAX_IMAGE_BYTES = 36 * 1024;

// The role's name and one-line description, by schema key, from the catalog.
const ROLE_NAME_KEYS = { owner: 'role.owner', admin: 'role.admin', manager: 'role.manager', crew: 'role.crew' };
const ROLE_DESC_KEYS = { owner: 'role.owner.desc', admin: 'role.admin.desc', manager: 'role.manager.desc', crew: 'role.crew.desc' };

function MobilePushCard({ user, prefs, dispatch, toast }) {
  const t = useT();
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
      toast.success(t('account.push.subscribed'));
    } catch (err) {
      toast.error(errorText(t, err, 'account.push.subscribeFailed'));
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
      toast.error(errorText(t, err, 'account.push.updateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    try {
      const res = await sendTestPush({ userId: user.id });
      if (res?.stub) {
        toast.info(t('account.push.testStub'));
      } else {
        const delivered = res?.delivered ?? 0;
        const failed = res?.failed ?? 0;
        if (delivered === 0) {
          // Never report a green success when nothing was delivered. Common cause:
          // a rotated/mismatched server VAPID keypair 401ing every send, or all
          // subscriptions expired — "sent to 0 devices" used to hide a dead channel.
          toast.error(failed > 0 ? t('account.push.testNoneFailed', { count: failed }) : t('account.push.testNone'));
        } else if (failed > 0) {
          toast.info(t('account.push.testSomeFailed', { count: delivered, failed }));
        } else {
          toast.success(t('account.push.testSent', { count: delivered }));
        }
      }
    } catch (err) {
      toast.error(errorText(t, err, 'account.push.testFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveDevice = async (endpoint) => {
    setBusy(true);
    try {
      await removeDevice({ userId: user.id, endpoint });
      await reload();
      toast.success(t('account.push.deviceRemoved'));
    } catch (err) {
      toast.error(errorText(t, err, 'account.push.removeFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <div className="card detail-card">
        <div className="push-card-head">
          <div>
            <div className="pref-row-label">{t('account.push.title')}</div>
            <div className="pref-row-desc">{t('account.push.unsupported')}</div>
          </div>
        </div>
      </div>
    );
  }

  let statusLine;
  if (!enabled) {
    statusLine = t('account.push.statusOff');
  } else if (subscribed) {
    statusLine = t('account.push.statusSubscribed');
  } else if (iosBlocked) {
    statusLine = t('account.push.statusIosInstall');
  } else if (perm === 'denied') {
    statusLine = t('account.push.statusDenied');
  } else {
    statusLine = t('account.push.statusSubscribeHere');
  }

  return (
    <div className="card detail-card">
      <div className="push-card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pref-row-label">{t('account.push.title')}</div>
          <div className="pref-row-desc">{statusLine}</div>
        </div>
        <Toggle on={enabled} onChange={handleToggle} />
      </div>

      {enabled && iosBlocked && (
        <div className="text-xs text-muted" style={{ marginTop: 8 }}>
          {t('account.push.iosHowTo')}
        </div>
      )}
      {enabled && !iosBlocked && perm === 'denied' && (
        <div className="text-xs text-danger" style={{ marginTop: 8 }}>
          {t('account.push.blockedHowTo')}
        </div>
      )}

      {enabled && !subscribed && !iosBlocked && (
        <div className="push-card-actions">
          <button type="button" className="btn btn-primary" onClick={subscribeThisDevice} disabled={busy}>
            {t('account.push.subscribe')}
          </button>
        </div>
      )}

      {enabled && subscribed && (
        <>
          <div className="push-card-actions">
            <button type="button" className="btn btn-secondary" onClick={handleTest} disabled={busy}>
              {t('account.push.sendTest')}
            </button>
          </div>

          {devices.length > 0 && (
            <div className="push-device-list">
              {devices.map((d) => (
                <div key={d.subscriptionId || d.endpoint} className="push-device-row">
                  <div className="push-device-meta">
                    <div className="push-device-label">{d.deviceLabel || t('account.push.device')}</div>
                    <div className="push-device-sub">
                      {d.endpointMasked || d.endpoint?.slice(0, 24) + '…'}
                      {d.lastSeenAt && ` · ${t('account.push.subscribedOn', { date: fmtDate(d.lastSeenAt, { month: 'numeric', day: 'numeric', year: 'numeric' }) })}`}
                    </div>
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={() => handleRemoveDevice(d.endpoint)} disabled={busy}>
                    {t('account.push.remove')}
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

// 🔴 ALERT DELIVERY — quiet hours (NTF-2 ★a) + alert texts (NTF-1 ★b), Matt 2026-09-29.
// Both are DELIVERY prefs, not event mutes: they decide whether an alert reaches this person's
// phone, never whether the alert happens. The policy is pure and shared with the server
// (lib/alertDelivery), so what this card promises is exactly what the dispatcher does.
//
// Hidden for a mandatory-notifications role (crew): their operational alerts are not theirs to
// silence, and the two events that text are office ones, so there would be nothing to switch.
// The READER enforces that too (quietHoursFor returns null for them), because org_state is
// browser-writable and a UI that merely hides a control is not a boundary.
function AlertDeliveryCard({ user, prefs, dispatch }) {
  const t = useT();
  const locked = areNotificationsMandatory(user);
  if (locked) return null;
  const quiet = quietHoursFor(user);
  const quietOn = prefs.quietHoursEnabled === true;
  const start = prefs.quietHoursStart || QUIET_HOURS_DEFAULTS.quietHoursStart;
  const end = prefs.quietHoursEnd || QUIET_HOURS_DEFAULTS.quietHoursEnd;
  const textsOn = smsAlertsEnabled(user);
  const optedOut = isSmsOptedOut(user);
  const textable = toE164(user.phone);
  const setPref = (patch) => dispatch({ type: ACTIONS.UPDATE_NOTIFICATION_PREFS, userId: user.id, patch });

  return (
    <div className="card detail-card">
      <h3 className="dash-card-title">{t('account.alerts.title')}</h3>
      <div className="pref-row">
        <div className="pref-row-text">
          <div className="pref-row-label">{t('account.alerts.quietHours')}</div>
          <div className="pref-row-desc">
            {t('account.alerts.quietHoursDesc')}
          </div>
        </div>
        <Toggle on={quietOn} onChange={(next) => setPref({ quietHoursEnabled: next })} />
      </div>
      {quietOn && (
        <div className="form-row">
          <FormField label={t('account.alerts.from')} type="time" value={start} onChange={(e) => setPref({ quietHoursStart: e.target.value })} />
          <FormField
            label={t('account.alerts.until')} type="time" value={end} onChange={(e) => setPref({ quietHoursEnd: e.target.value })}
            // A half-typed or equal pair is NO quiet hours rather than an all-day one, so the
            // card has to say when the window it is showing is not actually in force.
            help={quiet ? t('account.alerts.crossesMidnight') : t('account.alerts.setTwoTimes')}
          />
        </div>
      )}
      <div className="pref-row">
        <div className="pref-row-text">
          <div className="pref-row-label">{t('account.alerts.texts')}</div>
          <div className="pref-row-desc">
            {t('account.alerts.textsDesc')}
            {' '}
            {textable ? t('account.alerts.textsTo', { phone: user.phone }) : t('account.alerts.addPhone')}
          </div>
        </div>
        <Toggle on={textsOn && !optedOut} onChange={(next) => setPref({ smsAlertsEnabled: next, ...(next ? { smsOptedOut: false, smsOptedOutAt: null } : {}) })} />
      </div>
      {optedOut && (
        <div className="info-banner" role="note">
          <div>
            {t.rich('account.alerts.optedOut')}
          </div>
        </div>
      )}
      <p className="text-xs text-muted" style={{ marginTop: 'var(--space-1)' }}>
        {t.rich('account.alerts.companySwitch')}
      </p>
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
  const t = useT();
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
      toast.error(t('account.signature.wrongType'));
      return;
    }
    // 36 KB of image ≈ 48 KB once base64'd. That was the per-user BLOB budget
    // (api/_lib/blobBudget.js) back when the bytes lived in org_state; the image now
    // goes to Storage, but the cap stays because the server enforces the same number
    // and a signature is a small flat image by nature. Checked here only so the user
    // finds out before uploading — the server is the real gate.
    if (file.size > SIGNATURE_MAX_IMAGE_BYTES) {
      toast.error(t('account.signature.tooBig', { kb: Math.round(SIGNATURE_MAX_IMAGE_BYTES / 1024) }));
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = String(ev.target?.result || '');
      if (!dataUrl) { toast.error(t('account.signature.unreadable')); return; }
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
    reader.onerror = () => toast.error(t('account.signature.unreadable'));
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
    toast.success(t('account.signature.saved'));
    setEditing(false);
  };

  // S/M/L — the size presets' names, from the catalog.
  const SIZE_KEYS = { S: 'account.signature.small', M: 'account.signature.medium', L: 'account.signature.large' };

  return (
    <div className="card detail-card">
      <div className="push-card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pref-row-label">{t('account.signature.title')}</div>
          <div className="pref-row-desc">
            {prefs.enabled ? t('account.signature.on') : t('account.signature.off')}
          </div>
        </div>
        <Toggle on={prefs.enabled} onChange={(next) => dispatch({ type: ACTIONS.UPDATE_SIGNATURE_PREFS, userId: user.id, patch: { enabled: next } })} />
      </div>

      {!editing ? (
        <div style={{ marginTop: 14 }}>
          {hasContent ? (
            <>
              <div style={labelStyle}>{t('account.signature.preview')}</div>
              <div className="card" style={{ padding: 12, background: 'var(--inset-bg)' }}>
                <SignaturePreview prefs={{ ...draft, enabled: true }} />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted" style={{ margin: 0 }}>{t('account.signature.none')}</p>
          )}
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>{t('account.edit')}</button>
          </div>
        </div>
      ) : (
      <>
      <div style={{ marginTop: 14 }}>
        <div style={labelStyle}>{t('account.signature.text')}</div>
        <textarea
          className="input"
          style={{ width: '100%', minHeight: 96, resize: 'vertical', lineHeight: 1.5 }}
          placeholder={`${user.name || t('account.signature.yourName')}\n${IDENTITY.name}\n${IDENTITY.company.phone}`}
          value={draft.text || ''}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={labelStyle}>{t('account.signature.image')}</div>
        {hasImage ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {draftImageSrc && (
              <img
                src={draftImageSrc}
                alt={t('account.signature.imageAlt')}
                style={{ maxHeight: 64, maxWidth: 240, borderRadius: 6, border: '1px solid var(--border-light)' }}
              />
            )}
            {/* Clears BOTH shapes: a user who removes the image must not be left with
                the legacy base64 still in the blob and still being sent. The Storage
                object is left in place. It is overwritten on the next upload, and
                deleting it here would break an unsaved Cancel. */}
            <button type="button" className="btn btn-outline" onClick={() => setDraft((d) => ({ ...d, imageDataUrl: null, imagePath: null }))}>
              {t('account.signature.removeImage')}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? t('account.signature.uploading') : t('account.signature.addImage')}
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
          {t('account.signature.imageHelp', { kb: Math.round(SIGNATURE_MAX_IMAGE_BYTES / 1024) })}
        </div>
      </div>

      {/* Display-width scaling (S/M/L) — only meaningful with an image. Same
          segmented idiom as the compose channel toggle. */}
      {hasImage && (
        <div style={{ marginTop: 14 }}>
          <div style={labelStyle}>{t('account.signature.size')}</div>
          <div style={{ display: 'flex', gap: 6 }} role="group" aria-label={t('account.signature.sizeAria')}>
            {Object.entries(SIGNATURE_IMAGE_WIDTH_PRESETS).map(([key, w]) => {
              const active = signatureImageWidth(draft) === w;
              return (
                <button
                  key={key}
                  type="button"
                  className={`btn ${active ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setDraft((d) => ({ ...d, imageWidth: w }))}
                  aria-pressed={active}
                >
                  {t(SIZE_KEYS[key] || 'account.signature.large')}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {hasContent && (
        <div style={{ marginTop: 14 }}>
          <div style={labelStyle}>{t('account.signature.preview')}</div>
          <div className="card" style={{ padding: 12, background: 'var(--inset-bg)' }}>
            <SignaturePreview prefs={{ ...draft, enabled: true }} />
          </div>
        </div>
      )}

      <div className="inline-edit-savebar">
        <span className="save-hint">{dirty ? t('account.unsaved') : t('account.noChanges')}</span>
        <button type="button" className="btn btn-outline" onClick={cancel}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={save}>{t('account.saveChanges')}</button>
      </div>
      </>
      )}
    </div>
  );
}

// Change the password used to sign in (authed/Supabase mode only).
function ChangePasswordCard() {
  const t = useT();
  const { updatePassword } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 8) { toast.error(t('account.password.tooShort')); return; }
    if (pw !== confirm) { toast.error(t('account.password.mismatch')); return; }
    setBusy(true);
    const { error } = await updatePassword(pw);
    setBusy(false);
    if (error) { toast.error(errorText(t, error, 'account.password.failed')); return; }
    setPw(''); setConfirm('');
    toast.success(t('account.password.changed'));
  };

  return (
    <form className="card detail-card" onSubmit={submit}>
      <div style={{ marginBottom: 12 }}>
        <h2 className="page-head-title" style={{ fontSize: 16 }}>{t('account.password.title')}</h2>
      </div>
      <div className="form-row">
        <FormField label={t('account.password.new')} type="password" value={pw} onChange={(e) => setPw(e.target.value)} help={t('account.password.help')} autoComplete="new-password" />
        <FormField label={t('account.password.confirm')} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="modal-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('account.saving') : t('account.password.change')}</button>
      </div>
    </form>
  );
}

export default function SettingsAccount() {
  const t = useT();
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
    toast.success(t('account.profileSaved'));
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
        <h1 className="page-head-title">{t('account.title')}</h1>
      </div>

      <div className="account-grid">
        <div className="account-col">
          <form className="card detail-card" onSubmit={save}>
            {/* Your photo (UI_RULES §141): everyone sets their own; the buttons are type="button",
                so they never submit this form. */}
            <AvatarPhotoControl user={currentUser} canEdit self>
              <div className="text-sm font-semi">{ROLE_NAME_KEYS[currentUser.role] ? t(ROLE_NAME_KEYS[currentUser.role]) : ''}</div>
              <div className="text-xs text-muted">{ROLE_DESC_KEYS[currentUser.role] ? t(ROLE_DESC_KEYS[currentUser.role]) : ''}</div>
            </AvatarPhotoControl>
            <div className="form-row">
              <FormField label={t('account.fullName')} required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <FormField label={t('account.initials')} value={form.initials || ''} onChange={(e) => setForm({ ...form, initials: e.target.value.toUpperCase().slice(0, 3) })} help={t('account.initialsHelp')} />
            </div>
            <div className="info-banner" role="note">
              <div>
                {/* the software keeps the two apart, so it is the software's name (UI_RULES §129) */}
                {t.rich('account.emailVsMailboxes', { brand: IDENTITY.product.name })}
              </div>
            </div>
            <div className="form-row">
              <FormField
                label={t('account.email')}
                type="email"
                value={form.email || ''}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                disabled={authConfigured}
                help={authConfigured ? t('account.emailLocked') : undefined}
              />
              <FormField label={t('account.phone')} value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="submit" className="btn btn-primary">{t('common.save')}</button>
            </div>
          </form>

          {/* CS-193 — the language this person reads the app in (LANG-3 + LANG-11). */}
          <LanguageCard user={currentUser} />

          <MobilePushCard user={currentUser} prefs={prefs} dispatch={dispatch} toast={toast} />

          {/* NTF-2 + NTF-1 — when a phone may be buzzed, and whether it is also texted. */}
          <AlertDeliveryCard user={currentUser} prefs={prefs} dispatch={dispatch} />

          {/* Crew don't send outbound emails, so no signature for them. */}
          {currentUser.role !== 'crew' && (
            <SignatureCard user={currentUser} dispatch={dispatch} toast={toast} />
          )}

          {authConfigured && <ChangePasswordCard />}
        </div>

        <div className="card detail-card">
          <div style={{ marginBottom: 12 }}>
            <h2 className="page-head-title" style={{ fontSize: 16 }}>{t('account.notifications.title')}</h2>
            {areNotificationsMandatory(currentUser) && (
              <p className="text-sm text-muted">
                {t('account.notifications.mandatory')}
              </p>
            )}
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-muted">{t('account.notifications.none')}</p>
          ) : (
            groups.map((group, idx) => (
              <div key={group.id} style={{ marginTop: idx === 0 ? 8 : 18 }}>
                <h3 className="perm-group-head">{t(group.labelKey)}</h3>
                {group.items.map((item) => (
                  <div key={item.key} className="pref-row">
                    <div className="pref-row-text">
                      <div className="pref-row-label">{t(item.labelKey)}</div>
                      {item.descKey && <div className="pref-row-desc">{t(item.descKey)}</div>}
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
