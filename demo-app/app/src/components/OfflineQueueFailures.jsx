import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';
import { allChecklists, removeChecklist, updateChecklist } from '../lib/checklistQueue';
import { allMedia, removeMedia, updateMedia } from '../lib/mediaQueue';
import { flushClockQueues } from '../lib/offlineFlush';
import { flushMediaQueue } from '../lib/accountMediaApi';
import { fmtDate, fmtTime } from '../lib/dates';
import { useT } from '../i18n/react';

// The visible half of CS-007. A buffered checklist or photo whose replay hit a DEFINITIVE
// validation 4xx stops retrying — but it is NEVER deleted behind the crew's back, which is
// exactly what the old drain did. It stays on the device, and it shows up here with the
// only two honest choices: Retry (the server may have been fixed, or the assignment
// restored) or Discard (an explicit, confirmed throw-away).
//
// Transient failures are not listed: they retry themselves with backoff and already show in
// the "waiting to sync" counters. Self-hides when there is nothing failed, so it costs the
// crew nothing on a normal day. Every word is a catalog line in the cleaner's language
// (CS-193); a photo's FILE NAME shows as it is.
export default function OfflineQueueFailures() {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [confirm, setConfirm] = useState(null); // the row awaiting a Discard confirmation
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [checklists, media] = await Promise.all([
      allChecklists().catch(() => []),
      allMedia().catch(() => []),
    ]);
    setRows([
      // `label` is a file name the phone already has, or null for the kind's own word.
      ...checklists.filter((it) => it.failed).map((it) => ({
        kind: 'checklist', id: it.id, at: it.createdAt || it.failedAt || null,
        label: null, labelKey: 'offline.kind.checklist', detail: it.error || null,
      })),
      ...media.filter((it) => it.failed).map((it) => ({
        kind: 'media', id: it.id, at: it.createdAt || it.failedAt || null,
        label: it.meta?.fileName || null,
        labelKey: String(it.meta?.mimeType || '').startsWith('video') ? 'offline.kind.video' : 'offline.kind.photo',
        detail: it.error || null,
      })),
    ]);
  }, []);

  useEffect(() => {
    load();
    const on = () => load();
    for (const ev of ['rfs:checklist-queued', 'rfs:checklist-flushed', 'rfs:media-queued', 'rfs:media-flushed', 'online']) {
      window.addEventListener(ev, on);
    }
    return () => {
      for (const ev of ['rfs:checklist-queued', 'rfs:checklist-flushed', 'rfs:media-queued', 'rfs:media-flushed', 'online']) {
        window.removeEventListener(ev, on);
      }
    };
  }, [load]);

  // Clear the terminal mark, the attempt count and the backoff, then drain that queue now.
  // A checklist goes through the ordered pump like every other trigger of the clock queues,
  // `chain`ed so the tap is never swallowed by the background pass already in flight (that
  // pass read the queue before this mark was cleared, so joining it would do nothing).
  const retry = async (row) => {
    if (busy) return;
    setBusy(true);
    const clear = { failed: false, error: null, errorStatus: null, failedAt: null, attempts: 0, nextAttemptAt: null };
    try {
      if (row.kind === 'checklist') { await updateChecklist(row.id, clear); await flushClockQueues({ chain: true }); }
      else { await updateMedia(row.id, clear); await flushMediaQueue(); }
      await load();
      toast.success(t('offline.retrying'));
    } catch {
      toast.error(t('offline.stillFailed'));
    } finally { setBusy(false); }
  };

  const discard = async (row) => {
    setBusy(true);
    try {
      if (row.kind === 'checklist') await removeChecklist(row.id);
      else await removeMedia(row.id);
      await load();
      toast.success(t('offline.discarded'));
    } finally { setBusy(false); }
  };

  const nameOf = (row) => row?.label || (row?.labelKey ? t(row.labelKey) : t('offline.thisItem'));

  if (!rows.length) return null;
  return (
    <div className="card offline-failures" role="alert">
      <div className="offline-failures-head">
        <Icon name="warning" size={16} />
        <span className="offline-failures-title">
          {t('offline.failedCount', { count: rows.length })}
        </span>
      </div>
      <p className="offline-failures-note text-xs">
        {t('offline.failedNote')}
      </p>
      <ul className="offline-failures-list">
        {rows.map((row) => (
          <li key={`${row.kind}:${row.id}`} className="offline-failures-row">
            <span className="offline-failures-what">
              <strong>{nameOf(row)}</strong>
              {row.at ? <span className="text-muted text-xs"> · {fmtDate(row.at)} {fmtTime(row.at)}</span> : null}
            </span>
            <span className="offline-failures-actions">
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => retry(row)}>{t('common.retry')}</button>
              <button type="button" className="btn btn-link" disabled={busy} onClick={() => setConfirm(row)}>{t('common.discard')}</button>
            </span>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!confirm}
        title={t('offline.discardTitle')}
        message={t('offline.discardMessage', { name: nameOf(confirm) })}
        confirmLabel={t('common.discard')}
        variant="danger"
        onConfirm={() => confirm && discard(confirm)}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
