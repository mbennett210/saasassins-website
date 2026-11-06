import Modal from './Modal';
import { useT } from '../i18n/react';

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default', // 'default' | 'danger'
  onConfirm,
  onClose,
}) {
  // The defaults are catalog lines in the reader's language (CS-193).
  const t = useT();
  return (
    <Modal open={open} onClose={onClose} title={title ?? t('common.areYouSure')} size="sm">
      {message && <p className="confirm-message">{message}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{cancelLabel ?? t('common.cancel')}</button>
        <button
          type="button"
          className={`btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => { onConfirm?.(); onClose?.(); }}
        >
          {confirmLabel ?? t('common.confirm')}
        </button>
      </div>
    </Modal>
  );
}
