import { useSyncStatus } from '../store';
import { useT } from '../i18n/react';

// Ambient indicator of whether local edits have been saved to the shared backend. Silent
// when everything is synced; shows "Saving…" briefly; when offline, "Offline. Saved" (in
// red) so a crew member on a phone sees at a glance that their change is safe on the device
// and will sync; and when the server ANSWERED but did not accept the save (not signed in, a
// server error, over the size limit — CS-009), "Not saved yet" in red, because that one may
// need someone to act and must not read as a dead signal. The reassurance is in the visible
// label itself, not only the hover tooltip (which never shows on touch). No-op in local-only
// mode (status stays 'synced').
export default function SyncIndicator() {
  const t = useT();
  const status = useSyncStatus();
  if (status === 'synced') return null;
  const offline = status === 'offline';
  const error = status === 'error';
  const alarm = offline || error;
  return (
    <span
      className="sync-indicator"
      title={error ? t('sync.errorTitle') : offline ? t('sync.offlineTitle') : t('sync.savingTitle')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
        color: alarm ? 'var(--danger)' : 'var(--text-faint)',
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
        background: alarm ? 'var(--danger)' : 'var(--warning)',
        animation: alarm ? 'none' : 'rfs-pulse 1s ease-in-out infinite',
      }} />
      {error ? t('sync.error') : offline ? t('sync.offline') : t('sync.saving')}
      <style>{'@keyframes rfs-pulse{0%,100%{opacity:1}50%{opacity:.35}}'}</style>
    </span>
  );
}
