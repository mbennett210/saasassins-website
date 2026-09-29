// Screenshot / file picker for issue reports. Ported from the SaaSassins CRM's
// proven ScreenshotDropzone (support tickets) — same three ways in, because a
// user reporting a bug reaches for whichever is nearest and none of them should
// be a dead end:
//   • PASTE — Ctrl+V straight from Snipping Tool / Cmd+Shift+4. The component
//     wraps its own fields: a paste inside the subject/description bubbles to
//     this wrapper and is caught here, so the user never saves to disk first.
//   • DROP — drag a file anywhere onto the form.
//   • PICK — the ordinary file input, for people who expect a button.
//
// Files are held as real File objects and handed to the caller unchanged;
// upload happens on submit, not on select, so nothing is stored for a report
// that never gets sent.
import { useRef, useState } from 'react';
import Icon from './Icon';
import {
  TICKET_ATTACHMENT_ALLOWED_MIME, TICKET_ATTACHMENT_MAX_COUNT,
  filesFromDataTransfer, validateAttachment, formatBytes, isImageMime,
} from '../lib/supportApi';

// Preview a not-yet-uploaded File without holding its object URL in state.
// The ref callback mints the URL when the <img> mounts and React 19 runs the
// returned cleanup on unmount, so the URL's lifetime is exactly the element's —
// no leak, no setState-in-effect, no stale URL surviving a StrictMode
// double-render. A leaked blob URL pins the whole image in memory.
function FilePreview({ file, alt, className }) {
  return (
    <img
      alt={alt}
      className={className}
      ref={(node) => {
        if (!node) return undefined;
        const url = URL.createObjectURL(file);
        node.src = url;
        return () => URL.revokeObjectURL(url);
      }}
    />
  );
}

export default function ScreenshotDropzone({
  files = [],
  onChange,
  disabled = false,
  maxCount = TICKET_ATTACHMENT_MAX_COUNT,
  label = 'Screenshots',
  hint = 'Paste with Ctrl+V, drag files in, or browse. PNG, JPG, WebP, GIF or PDF.',
  children,
}) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const add = (incoming) => {
    if (disabled || !incoming?.length) return;
    const room = maxCount - files.length;
    if (room <= 0) {
      setError(`That's the limit. ${maxCount} file${maxCount === 1 ? '' : 's'} per report.`);
      return;
    }
    const accepted = [];
    let problem = null;
    incoming.slice(0, room).forEach((f) => {
      const bad = validateAttachment(f);
      if (bad) { problem = problem || bad; return; }
      accepted.push(f);
    });
    if (incoming.length > room && !problem) {
      problem = `Only the first ${room} file${room === 1 ? '' : 's'} were added. ${maxCount} per report is the limit.`;
    }
    setError(problem);
    if (accepted.length) onChange?.([...files, ...accepted]);
  };

  const removeAt = (i) => {
    if (disabled) return;
    setError(null);
    onChange?.(files.filter((_, idx) => idx !== i));
  };

  const onPaste = (e) => {
    const pasted = filesFromDataTransfer(e.clipboardData);
    if (!pasted.length) return; // plain text paste — let it through to the field
    e.preventDefault();
    add(pasted);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    add(filesFromDataTransfer(e.dataTransfer));
  };

  const full = files.length >= maxCount;

  return (
    <div
      onPaste={onPaste}
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      className={`ticket-dropzone ${dragging ? 'is-dragging' : ''}`}
    >
      {children}

      <div className="form-group">
        <span className="form-label">{label}</span>
        <div className="ticket-dropzone-body">
          {files.length > 0 && (
            <ul className="ticket-thumb-strip">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="ticket-thumb">
                  {isImageMime(f.type) ? (
                    <FilePreview file={f} alt={f.name} className="ticket-thumb-img" />
                  ) : (
                    <span className="ticket-thumb-doc" aria-hidden><Icon name="paperclip" size={20} /></span>
                  )}
                  <button
                    type="button"
                    className="thumb-remove"
                    onClick={() => removeAt(i)}
                    disabled={disabled}
                    aria-label={`Remove ${f.name}`}
                    title={`Remove ${f.name}`}
                  >
                    <Icon name="x" size={12} />
                  </button>
                  <span className="ticket-thumb-meta" title={f.name}>
                    <span className="ticket-thumb-name">{f.name}</span>
                    <span className="text-xs text-muted">{formatBytes(f.size)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="ticket-dropzone-cta">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || full}
              title={full ? `${maxCount} files is the limit` : 'Choose files'}
            >
              <Icon name="upload" size={14} /> Add file{files.length ? 's' : ''}
            </button>
            <span className="text-xs text-muted">
              {full ? `${maxCount} of ${maxCount}. That's the limit` : hint}
            </span>
          </div>

          <input
            ref={inputRef}
            type="file"
            multiple
            accept={TICKET_ATTACHMENT_ALLOWED_MIME.join(',')}
            hidden
            onChange={(e) => { add(Array.from(e.target.files || [])); e.target.value = ''; }}
          />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
