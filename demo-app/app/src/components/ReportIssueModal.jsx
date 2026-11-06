// "Report an issue" — files a support ticket into the SaaSassins CRM Work
// Queue through this app's own /api/support proxy (the browser never sees the
// CRM or the portal token — see lib/supportApi.js).
//
// Alongside what the user types, the submit silently attaches diagnostics no
// client ever types: current route, app build, browser/OS, viewport, who was
// signed in, and the recent console-error ring buffer (lib/errorBuffer.js).
// Identity is re-derived server-side from the session; the context fields here
// are display-level diagnostics, not trust inputs.
//
// v1 confirmation shows a reference only — deliberately NO portal deep-link
// (the portal URL contains the token; exposing it defeats the proxy).
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Modal from './Modal';
import Icon from './Icon';
import ScreenshotDropzone from './ScreenshotDropzone';
import { useToast } from './Toast';
import { useSelector, useSyncStatus, useSyncDiagnostics } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { submitReport, isSupportUnavailable } from '../lib/supportApi';
import { getRecentErrors } from '../lib/errorBuffer';
import { APP_SHA, APP_BUILD, TAB_ID } from '../lib/appBuild';
import { countMedia } from '../lib/mediaQueue';
import { countChecklists } from '../lib/checklistQueue';
import { useT } from '../i18n/react';

const PRIORITIES = [
  { value: 'normal', labelKey: 'report.priority.normal' },
  { value: 'high', labelKey: 'report.priority.high' },
  { value: 'low', labelKey: 'report.priority.low' },
];

// A CRM ticket id is a uuid — the first block is plenty for "quote this back
// at us" and stays readable over the phone.
const shortRef = (id) => (id ? String(id).split('-')[0].toUpperCase() : null);

// Best-effort environment probes for the diagnostic packet — wrapped so
// collecting diagnostics can never throw and block a bug report.
const prefersDark = () => {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches; }
  catch { return false; }
};
const resolvedTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
  catch { return undefined; }
};

export default function ReportIssueModal({ open, onClose }) {
  const t = useT();
  const toast = useToast();
  const location = useLocation();
  const currentUser = useSelector(selectCurrentUser);
  const syncStatus = useSyncStatus();
  const getSyncDiagnostics = useSyncDiagnostics();

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);      // { ticketId } after a successful submit
  const [error, setError] = useState(null);    // inline message
  const [unavailable, setUnavailable] = useState(false);

  // Fresh form every time the modal opens — a previous report's draft or
  // confirmation must not leak into the next one.
  useEffect(() => {
    if (!open) return;
    setSubject(''); setDescription(''); setPriority('normal'); setFiles([]);
    setSending(false); setSent(null); setError(null); setUnavailable(false);
  }, [open]);

  // Closing mid-send would drop the confirmation on the floor while the
  // request still lands — hold the modal open until the submit settles.
  const safeClose = () => { if (!sending) onClose?.(); };

  const send = async (e) => {
    e.preventDefault();
    if (sending) return;
    const subj = subject.trim();
    if (!subj) { setError(t('report.needTitle')); return; }
    setError(null);
    setUnavailable(false);
    setSending(true);
    try {
      const sync = getSyncDiagnostics();
      // Offline-queue depths are async IndexedDB counts; fail-soft to undefined
      // (the field is simply omitted) so collecting diagnostics can never block
      // or fail a bug report.
      const [mediaQueueDepth, checklistQueueDepth] = await Promise.all([
        countMedia().catch(() => undefined),
        countChecklists().catch(() => undefined),
      ]);
      const context = {
        source: 'in-app',
        route: `${location.pathname}${location.search}`,
        appVersion: `cleanspace-app@${APP_SHA || 'dev'}`,
        appBuild: APP_BUILD,
        clientTime: new Date().toISOString(),
        timezone: resolvedTimeZone(),
        locale: navigator.language,
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        dpr: window.devicePixelRatio,
        colorScheme: prefersDark() ? 'dark' : 'light',
        online: navigator.onLine,
        syncStatus,
        orgStateVersion: sync.version ?? undefined,
        pendingWrites: sync.pending,
        dirty: sync.dirty,
        mediaQueueDepth,
        checklistQueueDepth,
        tabId: TAB_ID,
        tabAgeSec: Math.max(0, Math.round((typeof performance !== 'undefined' && performance.now ? performance.now() : 0) / 1000)),
        // identity (userId/role/roleSource/identitySource) is authored SERVER-side
        // from the JWT in report.js — never sent from here, so it can't be spoofed.
        user: currentUser ? `${currentUser.name} <${currentUser.email}>` : undefined,
        consoleErrors: getRecentErrors(),
      };
      const res = await submitReport({ subject: subj, description: description.trim(), priority, files, context });
      setSent({ ticketId: res?.ticketId || null });
    } catch (err) {
      if (isSupportUnavailable(err)) {
        setUnavailable(true);
      } else {
        setError(t.lang === 'en' && err.message ? err.message : t('report.failed'));
        toast.error(t.lang === 'en' && err.message ? err.message : t('report.failedToast'));
      }
    } finally {
      setSending(false);
    }
  };

  const reference = sent ? shortRef(sent.ticketId) : null;

  return (
    <Modal open={open} onClose={safeClose} title={t('report.title')} size="md">
      {sent ? (
        <div className="support-success">
          <span className="support-success-icon" aria-hidden><Icon name="check" size={22} /></span>
          <h3>{t('report.sent')}</h3>
          {reference && <p className="support-success-ref">{t.rich('report.reference', { ref: reference })}</p>}
          <p className="support-success-sub">
            {t('report.notified')}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.done')}</button>
          </div>
        </div>
      ) : (
        <form onSubmit={send}>
          <ScreenshotDropzone files={files} onChange={setFiles} disabled={sending}>
            <p className="support-intro">
              {t('report.intro')}
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="support-subject">{t('report.subjectLabel')}</label>
              <input
                id="support-subject"
                className="input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t('report.subjectPlaceholder')}
                maxLength={300}
                disabled={sending}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="support-description">{t('report.descLabel')}</label>
              <textarea
                id="support-description"
                className="input"
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('report.descPlaceholder')}
                disabled={sending}
              />
            </div>
            <div className="form-group">
              <span className="form-label" id="support-priority-label">{t('report.priority')}</span>
              <div className="segmented" role="group" aria-labelledby="support-priority-label">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={`segmented-btn ${priority === p.value ? 'active' : ''}`}
                    aria-pressed={priority === p.value}
                    onClick={() => setPriority(p.value)}
                    disabled={sending}
                  >
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          </ScreenshotDropzone>

          {unavailable && (
            <div className="support-unavailable" role="alert">
              <Icon name="warning" size={16} />
              <span>
                {t('report.unavailable')}
              </span>
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={safeClose} disabled={sending}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={sending}>
              {sending ? t('report.sending') : t('report.send')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
