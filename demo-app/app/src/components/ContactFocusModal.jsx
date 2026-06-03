import { useEffect } from 'react';
import ContactDetail from '../pages/ContactDetail';
import Icon from './Icon';

// Full-screen focus modal that embeds the canonical ContactDetail content.
// Backdrop blurs the app behind it; Escape + click-outside close.

export default function ContactFocusModal({ open, onClose, contactId }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !contactId) return null;

  return (
    <div className="focus-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="focus-modal-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="focus-modal-close" onClick={onClose} aria-label="Close">
          <Icon name="x" size={18} />
        </button>
        <div className="focus-modal-body">
          <ContactDetail contactId={contactId} embedded />
        </div>
      </div>
    </div>
  );
}
