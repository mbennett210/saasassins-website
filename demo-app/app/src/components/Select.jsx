import { useEffect, useRef, useState } from 'react';

// Themed dropdown that replaces native <select>. Trigger and menu share the
// same gradient border; when open the seam disappears so they read as one box
// with rounded outer corners.
export default function Select({
  value,
  onChange,
  options,
  ghost = false,
  disabled = false,
  placeholder = 'Select…',
  id,
  ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cls = [
    'select-shell',
    ghost ? 'is-ghost' : '',
    open ? 'is-open' : '',
    disabled ? 'is-disabled' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} ref={wrapRef}>
      <button
        id={id}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="select-trigger"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className="select-trigger-text">
          {selected?.label ?? <span className="select-placeholder">{placeholder}</span>}
        </span>
        <span className="select-trigger-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="select-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`select-option ${o.value === value ? 'on' : ''}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
