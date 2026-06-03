import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { selectEffectiveStatus } from '../store/selectors';

const STATUS_META = {
  open:    { label: 'Open',    variant: 'green' },
  snoozed: { label: 'Snoozed', variant: 'amber' },
  closed:  { label: 'Closed',  variant: 'slate' },
};

// Small helpers — compute ISO timestamps for snooze presets.
function at(hoursFromNow) {
  const d = new Date();
  d.setHours(d.getHours() + hoursFromNow);
  return d.toISOString();
}
function tomorrow9am() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}
function nextWeek9am() {
  const d = new Date();
  const dayOfWeek = d.getDay();
  // Monday next week (day=1). If today is Sunday, +1; if Monday, +7; etc.
  const diff = ((8 - dayOfWeek) % 7) || 7;
  d.setDate(d.getDate() + diff);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

export default function ConversationStatusMenu({ conversation, onSetStatus, onSnooze }) {
  const [open, setOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setSnoozeOpen(false); } };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setSnoozeOpen(false); } };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const effective = selectEffectiveStatus(conversation);
  const meta = STATUS_META[effective] || STATUS_META.open;

  const chooseOpen = () => { onSetStatus('open'); setOpen(false); setSnoozeOpen(false); };
  const chooseClosed = () => { onSetStatus('closed'); setOpen(false); setSnoozeOpen(false); };
  const chooseSnooze = (untilIso) => { onSnooze(untilIso); setOpen(false); setSnoozeOpen(false); };

  return (
    <div className="status-menu" ref={wrapRef}>
      <button
        type="button"
        className={`btn btn-outline btn-sm status-trigger status-trigger-${meta.variant}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`status-dot status-dot-${meta.variant}`} aria-hidden />
        <span>{meta.label}</span>
        <span className="status-caret">▾</span>
      </button>
      {open && (
        <div className="status-popover">
          <button type="button" className={`status-option ${effective === 'open' ? 'on' : ''}`} onClick={chooseOpen}>
            <span className="status-dot status-dot-green" aria-hidden />
            <span>Open</span>
          </button>
          <button
            type="button"
            className={`status-option status-option-snooze ${effective === 'snoozed' ? 'on' : ''}`}
            onClick={() => setSnoozeOpen((v) => !v)}
          >
            <span className="status-dot status-dot-amber" aria-hidden />
            <span>Snooze…</span>
            <Icon name="chevronRight" size={12} />
          </button>
          {snoozeOpen && (
            <div className="status-snooze-submenu">
              <button type="button" className="status-option" onClick={() => chooseSnooze(at(1))}>In 1 hour</button>
              <button type="button" className="status-option" onClick={() => chooseSnooze(at(4))}>In 4 hours</button>
              <button type="button" className="status-option" onClick={() => chooseSnooze(tomorrow9am())}>Tomorrow morning</button>
              <button type="button" className="status-option" onClick={() => chooseSnooze(nextWeek9am())}>Next week</button>
            </div>
          )}
          <button type="button" className={`status-option ${effective === 'closed' ? 'on' : ''}`} onClick={chooseClosed}>
            <span className="status-dot status-dot-slate" aria-hidden />
            <span>Closed</span>
          </button>
        </div>
      )}
    </div>
  );
}
