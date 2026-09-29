import { useSyncStatus } from '../store';

// Ambient indicator of whether local edits have been saved to the shared
// backend. Silent when everything is synced; shows "Saving…" briefly and, when
// offline, "Offline — saved" (in red) so a crew member on a phone sees at a glance
// that their change is safe on the device and will sync — the reassurance is in the
// visible label itself, not only the hover tooltip (which never shows on touch).
// No-op in local-only mode (status stays 'synced').
export default function SyncIndicator() {
  const status = useSyncStatus();
  if (status === 'synced') return null;
  const offline = status === 'offline';
  return (
    <span
      className="sync-indicator"
      title={offline
        ? "You're offline. Your changes are saved on this device and will sync automatically when the connection returns."
        : 'Saving your changes…'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
        color: offline ? 'var(--danger)' : 'var(--text-faint)',
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
        background: offline ? 'var(--danger)' : 'var(--warning)',
        animation: offline ? 'none' : 'rfs-pulse 1s ease-in-out infinite',
      }} />
      {offline ? 'Offline. Saved' : 'Saving…'}
      <style>{'@keyframes rfs-pulse{0%,100%{opacity:1}50%{opacity:.35}}'}</style>
    </span>
  );
}
