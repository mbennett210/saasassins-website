// Console-error ring buffer for "Report an issue" diagnostics.
//
// Installed once at app root (main.jsx) so errors thrown BEFORE the user opens
// the report modal are still on hand when they file. Captures uncaught errors
// (window 'error') and unhandled promise rejections; keeps the last 10, each
// truncated, so the buffer can never grow past ~20 KB no matter how loud a
// render loop gets. Read-only consumers get a copy via getRecentErrors().
//
// Deliberately addEventListener, never `window.onerror =` — assigning the
// property would clobber any other handler (and be clobbered back).
const MAX_ENTRIES = 10;
const MAX_CHARS = 2000;

const buffer = [];
let installed = false;

function push(line) {
  const text = String(line || '').slice(0, MAX_CHARS);
  if (!text.trim()) return;
  buffer.push(`${new Date().toISOString()} ${text}`.slice(0, MAX_CHARS));
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function installErrorBuffer() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // Non-capture listener: resource-load errors (img/script) don't bubble to
  // window, so only real script errors (ErrorEvent) arrive here.
  window.addEventListener('error', (e) => {
    const where = e?.filename ? ` @ ${e.filename}:${e.lineno || 0}` : '';
    const stack = e?.error?.stack ? `\n${e.error.stack}` : '';
    push(`${e?.message || 'Script error'}${where}${stack}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    const text = r instanceof Error ? (r.stack || r.message) : (() => {
      try { return JSON.stringify(r); } catch { return String(r); }
    })();
    push(`Unhandled rejection: ${text}`);
  });
}

export function getRecentErrors() {
  return [...buffer];
}
