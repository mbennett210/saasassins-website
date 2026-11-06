import { Component } from 'react';
import { submitReport } from '../lib/supportApi';
import { APP_SHA, APP_BUILD } from '../lib/appBuild';
import { useT } from '../i18n/react';

// The crash screen's words, in the reader's language (CS-193). A function component so it
// can read the language: the i18n runtime is module state, independent of the store and the
// router that may be what just failed. The ticket it files stays English (it goes to support).
function CrashScreen({ reported, reporting, reportFailed, onReport }) {
  const t = useT();
  return (
    <div style={{
      fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      maxWidth: 420, margin: '15vh auto', padding: '0 24px', textAlign: 'center', color: 'var(--color-brand-primary-500)',
    }}>
      <h1 style={{ fontSize: 20, marginBottom: 10 }}>{t('crash.title')}</h1>
      <p style={{ color: 'var(--color-neutral-600)', lineHeight: 1.6, fontSize: 15 }}>
        {t('crash.body')}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: 16, padding: '10px 20px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
          color: 'var(--color-surface-base)', background: 'var(--color-brand-primary-500)', border: 'none', borderRadius: 8,
        }}
      >
        {t('crash.reload')}
      </button>
      {/* Kit classes for the report affordance (`btn btn-link`, `text-xs text-muted`)
          rather than more inline px: this screen already reads --color-* tokens from
          index.css, so it is no more fragile for using its classes too, and the design
          ledgers stay honest. The Reload button above keeps its original inline style. */}
      <p className="text-xs text-muted">
        {reported ? (
          <span>
            {reported !== 'sent' ? t.rich('crash.reportedRef', { ref: reported }) : t('crash.reported')}
          </span>
        ) : (
          <>
            <button type="button" className="btn btn-link" onClick={onReport} disabled={reporting}>
              {reporting ? t('crash.reporting') : t('crash.report')}
            </button>
            {reportFailed && (
              <span> {t('crash.reportFailed')}</span>
            )}
          </>
        )}
      </p>
    </div>
  );
}

// Top-level render-crash guard. Before this, an uncaught render error white-screened
// the entire SPA with nothing surfaced anywhere — the client-side shape of the
// 2026-08-03 "users see a broken page, we hear about it when they complain" class.
// This catches it, keeps a greppable `[ALERT] client.render_crash` line in the console
// (mirroring the server-side [ALERT] tag in api/_lib/monitor.js, so one log-drain alert
// rule matches both sides), and renders a recover action instead of a blank page.
// React error boundaries MUST be class components.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stack: '', reporting: false, reported: null, reportFailed: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const stack = (info?.componentStack || '').split('\n').slice(0, 6).join('\n');
    this.setState({ stack });
    try {
      console.error('[ALERT] client.render_crash', JSON.stringify({
        message: error?.message || String(error),
        stack,
      }));
    } catch {
      console.error('[ALERT] client.render_crash', error);
    }
  }

  // Report the crash from the crash screen itself (CS-049). "Report an issue" lived only
  // in the desktop sidebar, and this boundary sits ABOVE the store and the router — the
  // very things that just failed — so ReportIssueModal (which needs both) cannot mount
  // here. Instead this posts the crash straight through lib/supportApi, which is
  // provider-free. No attachments and no free-text field: the whole app is broken, so the
  // one thing worth asking for is one tap, and the diagnostics that matter are already in
  // hand. Any failure is shown, never swallowed — a reporter who is told nothing assumes
  // it was sent.
  report = async () => {
    this.setState({ reporting: true, reportFailed: false });
    try {
      const r = await submitReport({
        subject: 'App crashed on screen load',
        description: [
          'Reported from the crash screen (ErrorBoundary).',
          `Error: ${this.state.error?.message || String(this.state.error)}`,
          `Route: ${typeof location !== 'undefined' ? location.pathname : '(unknown)'}`,
          `Build: ${APP_SHA || '(unknown)'} ${APP_BUILD || ''}`.trim(),
          '',
          'Component stack:',
          this.state.stack || '(none captured)',
        ].join('\n'),
        priority: 'high',
      });
      this.setState({ reported: r?.ticketId ? String(r.ticketId).split('-')[0].toUpperCase() : 'sent' });
    } catch {
      this.setState({ reportFailed: true });
    } finally {
      this.setState({ reporting: false });
    }
  };

  render() {
    if (this.state.error) {
      return (
        <CrashScreen
          reported={this.state.reported}
          reporting={this.state.reporting}
          reportFailed={this.state.reportFailed}
          onReport={this.report}
        />
      );
    }
    return this.props.children;
  }
}
