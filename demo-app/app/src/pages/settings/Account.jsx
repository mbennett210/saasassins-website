import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import Avatar from '../../components/Avatar';
import Toggle from '../../components/Toggle';
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from '../../lib/roles';
import { selectVisibleNotificationGroups, selectNotificationPrefs } from '../../store/selectors';
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
  PUSH_BACKEND_URL,
} from '../../lib/push';

function MobilePushCard({ user, prefs, dispatch, toast }) {
  const supported = isPushSupported();
  const iosBlocked = isIOS() && !isStandalonePWA();
  const enabled = prefs.mobilePushEnabled === true;
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
        toast.info('Test push fired locally (stub mode — no backend wired).');
      } else {
        toast.success(`Test push sent to ${res?.delivered ?? 0} device${res?.delivered === 1 ? '' : 's'}.`);
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
        <div className="text-xs" style={{ marginTop: 8, color: 'var(--color-semantic-danger-700, #b91c1c)' }}>
          Notifications are blocked for this site in your browser. Allow them in site settings, then click Subscribe this device.
        </div>
      )}
      {!PUSH_BACKEND_URL && (
        <div className="text-xs text-muted" style={{ marginTop: 8 }}>
          Stub mode — push backend is not configured for this build, so subscriptions live in memory and the test button fires a local notification.
        </div>
      )}

      {enabled && !subscribed && !iosBlocked && (
        <div className="push-card-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={subscribeThisDevice} disabled={busy}>
            Subscribe this device
          </button>
        </div>
      )}

      {enabled && subscribed && (
        <>
          <div className="push-card-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleTest} disabled={busy}>
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
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleRemoveDevice(d.endpoint)} disabled={busy}>
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

export default function SettingsAccount() {
  const { currentUser } = useAuth();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const [form, setForm] = useState(currentUser);

  useEffect(() => { setForm(currentUser); }, [currentUser]);

  if (!currentUser) return null;

  const save = (e) => {
    e.preventDefault();
    dispatch({
      type: ACTIONS.UPDATE_USER,
      id: currentUser.id,
      patch: { name: form.name, email: form.email, phone: form.phone, initials: form.initials },
    });
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
        <p className="page-head-subtitle">Manage your profile and preferences.</p>
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
            <div className="form-row">
              <FormField label="Email" type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <FormField label="Phone" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>

          <MobilePushCard user={currentUser} prefs={prefs} dispatch={dispatch} toast={toast} />
        </div>

        <div className="card detail-card">
          <div style={{ marginBottom: 12 }}>
            <h2 className="page-head-title" style={{ fontSize: 16 }}>Notifications</h2>
            <p className="page-head-subtitle">Pings only fire for the events below — turn off anything you don't want to hear about.</p>
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
                      on={prefs[item.key] === true}
                      onChange={(next) => setPref(item.key, next)}
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
