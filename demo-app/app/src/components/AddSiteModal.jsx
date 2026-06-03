import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import ContactPicker from './ContactPicker';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClientById } from '../store/selectors';
import { useToast } from './Toast';
import { usePermission } from '../hooks/usePermission';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';

const EMPTY = { name: '', address: '', accessNotes: '', siteContactId: null, attachments: [] };

export default function AddSiteModal({ open, onClose, clientId, mode = 'create', initialData = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('sites.edit');
  const canAttach = usePermission('sites.attachments');
  const [form, setForm] = useState(EMPTY);
  const fileRef = useRef(null);

  // When the user can attach but can't edit, all non-attachment fields render
  // read-only — they can still see context but only the attachments section
  // accepts changes. canEdit always implies edit access to everything.
  const fieldsReadOnly = !canEdit && canAttach;

  useEffect(() => {
    if (!open) return;
    if (initialData) {
      setForm({
        name: initialData.name || '',
        address: initialData.address || '',
        accessNotes: initialData.accessNotes || '',
        siteContactId: initialData.siteContactId || null,
        attachments: Array.isArray(initialData.attachments) ? initialData.attachments : [],
      });
    } else {
      // On a fresh site, pre-fill with the client's primary contact as a sensible default.
      const client = clientId ? selectClientById(state, clientId) : null;
      setForm({ ...EMPTY, siteContactId: client?.primaryContactId || null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialData, clientId]);

  const handleFile = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    const accepted = [];
    for (const f of files) {
      if (f.size > ATTACHMENT_MAX_BYTES) {
        toast.error(`"${f.name}" is ${formatBytes(f.size)} — over the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit.`);
        continue;
      }
      accepted.push({ name: f.name, size: f.size, type: f.type });
    }
    if (accepted.length > 0) {
      setForm((prev) => ({ ...prev, attachments: [...(prev.attachments || []), ...accepted] }));
    }
  };

  const removeAttachment = (idx) => {
    setForm((prev) => ({ ...prev, attachments: (prev.attachments || []).filter((_, i) => i !== idx) }));
  };

  const submit = (e) => {
    e.preventDefault();
    if (mode === 'edit' && initialData && fieldsReadOnly) {
      // Attachment-only path: caller can change attachments but nothing else.
      dispatch({ type: ACTIONS.UPDATE_SITE, id: initialData.id, patch: { attachments: form.attachments } });
      toast.success('Site attachments updated');
      onClose();
      return;
    }
    if (!form.name.trim() || !form.address.trim()) return;
    const patch = {
      name: form.name.trim(),
      address: form.address.trim(),
      accessNotes: form.accessNotes.trim(),
      siteContactId: form.siteContactId || null,
      attachments: form.attachments,
    };
    if (mode === 'edit' && initialData) {
      dispatch({ type: ACTIONS.UPDATE_SITE, id: initialData.id, patch });
      toast.success('Site updated');
    } else {
      dispatch({ type: ACTIONS.ADD_SITE, site: { clientId, ...patch } });
      toast.success('Site added');
    }
    onClose();
  };

  const isEditMode = mode === 'edit' && initialData;
  const siteContact = form.siteContactId
    ? (state.contacts || []).find((c) => c.id === form.siteContactId)
    : null;

  return (
    <Modal open={open} onClose={onClose} title={isEditMode ? 'Edit Site' : 'Add Site'}>
      <form onSubmit={submit}>
        {fieldsReadOnly ? (
          <>
            <div className="form-group">
              <label className="form-label">Site name</label>
              <div className="readonly-field">{form.name || '—'}</div>
            </div>
            <div className="form-group">
              <label className="form-label">Address</label>
              <div className="readonly-field">{form.address || '—'}</div>
            </div>
            <div className="form-group">
              <label className="form-label">Site contact</label>
              <div className="readonly-field">
                {siteContact ? `${siteContact.firstName} ${siteContact.lastName}` : '—'}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Access notes</label>
              <div className="readonly-field" style={{ whiteSpace: 'pre-wrap', minHeight: 60 }}>
                {form.accessNotes || '—'}
              </div>
            </div>
          </>
        ) : (
          <>
            <FormField label="Site name" required placeholder="e.g., Main Hospital" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <FormField label="Address" required placeholder="123 Example St, City ST 00000" value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <div className="form-group">
              <label className="form-label">Site contact</label>
              <ContactPicker
                value={form.siteContactId}
                onChange={(id) => setForm({ ...form, siteContactId: id })}
                companyId={clientId || null}
                placeholder="Select a site contact…"
              />
              <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                Optional — who to call when crew arrives. Defaults to the client's primary contact.
              </div>
            </div>
            <FormField label="Access notes" as="textarea" placeholder="Gate code, best entrance, security contact…"
              value={form.accessNotes} onChange={(e) => setForm({ ...form, accessNotes: e.target.value })} />
          </>
        )}

        {isEditMode && canAttach && (
          <div className="form-group">
            <label className="form-label">Attachments</label>
            <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
              Photos or PDFs — site maps, gate codes, walkthrough notes. Max {formatBytes(ATTACHMENT_MAX_BYTES)} per file.
            </div>
            {form.attachments.length > 0 && (
              <div className="site-attachment-list">
                {form.attachments.map((a, i) => (
                  <span key={`${a.name}-${i}`} className="email-attachment-chip">
                    <Icon name="paperclip" size={12} />
                    <span>{a.name}</span>
                    <span className="text-muted text-xs">({formatBytes(a.size)})</span>
                    <button
                      type="button"
                      className="email-attachment-remove"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => removeAttachment(i)}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input ref={fileRef} type="file" multiple hidden onChange={handleFile} />
            <button
              type="button"
              className="btn btn-success btn-sm"
              onClick={() => fileRef.current?.click()}
              style={{ marginTop: form.attachments.length > 0 ? 8 : 0 }}
            >
              Add Attachment
            </button>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">{isEditMode ? 'Save Changes' : 'Add Site'}</button>
        </div>
      </form>
    </Modal>
  );
}
