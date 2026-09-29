import { Component } from 'react';

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
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try {
      console.error('[ALERT] client.render_crash', JSON.stringify({
        message: error?.message || String(error),
        stack: (info?.componentStack || '').split('\n').slice(0, 6).join('\n'),
      }));
    } catch {
      console.error('[ALERT] client.render_crash', error);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
          maxWidth: 420, margin: '15vh auto', padding: '0 24px', textAlign: 'center', color: 'var(--color-brand-primary-500)',
        }}>
          <h1 style={{ fontSize: 20, marginBottom: 10 }}>Something went wrong</h1>
          <p style={{ color: 'var(--color-neutral-600)', lineHeight: 1.6, fontSize: 15 }}>
            The page hit an unexpected error. Reloading usually fixes it. Your data is safe.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16, padding: '10px 20px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
              color: 'var(--color-surface-base)', background: 'var(--color-brand-primary-500)', border: 'none', borderRadius: 8,
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
