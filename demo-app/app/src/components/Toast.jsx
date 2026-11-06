import ToastLayer from '../demo/ToastLayer'; // polishpoint-demo
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Icon from './Icon';
import { useT } from '../i18n/react';

const ToastCtx = createContext(null);

// Hard ceiling on simultaneously-visible toasts. A backstop so no source (a
// notification resync, a bulk action) can stack an unbounded wall of toasts —
// oldest are dropped once the cap is exceeded.
const MAX_VISIBLE_TOASTS = 5;

export function ToastProvider({ children }) {
  const t = useT();
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const push = useCallback((message, opts = {}) => {
    const id = nextId.current++;
    const toast = { id, message, variant: opts.variant || 'success', duration: opts.duration ?? 3000 };
    setToasts((t) => [...t, toast].slice(-MAX_VISIBLE_TOASTS));
    if (toast.duration > 0) {
      window.setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, toast.duration);
    }
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const api = {
    success: (msg, opts) => push(msg, { ...opts, variant: 'success' }),
    error:   (msg, opts) => push(msg, { ...opts, variant: 'error' }),
    info:    (msg, opts) => push(msg, { ...opts, variant: 'info' }),
    dismiss,
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ToastLayer><div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.variant}`}>
            <span className="toast-msg">{toast.message}</span>
            <button type="button" className="btn-icon btn-icon-ghost" onClick={() => dismiss(toast.id)} aria-label={t('common.dismiss')}><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div></ToastLayer>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
