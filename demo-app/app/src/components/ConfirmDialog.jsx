import Modal from './Modal';

export default function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default', // 'default' | 'danger'
  onConfirm,
  onClose,
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      {message && <p className="confirm-message">{message}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{cancelLabel}</button>
        <button
          type="button"
          className={`btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => { onConfirm?.(); onClose?.(); }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
