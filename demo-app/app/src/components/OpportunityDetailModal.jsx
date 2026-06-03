import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import Avatar from './Avatar';
import FormField from './FormField';
import TagPicker from './TagPicker';
import { useFromHere } from '../hooks/useFromHere';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClientById, selectPipelines, selectTagById } from '../store/selectors';
import { useToast } from './Toast';
import { money } from '../lib/dates';

const LIFECYCLES = [
  { value: 'lead',     label: 'Lead' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'client',   label: 'Client' },
  { value: 'vendor',   label: 'Vendor' },
];

function emptyDraftFor(contact) {
  if (!contact) return null;
  return {
    email: contact.email || '',
    phone: contact.phone || '',
    title: contact.title || '',
    lifecycle: contact.lifecycle || 'lead',
    pipelineId: contact.pipelineId || '',
    stage: contact.stage || '',
    dealValue: contact.dealValue == null ? '' : String(contact.dealValue),
    expectedCloseDate: contact.expectedCloseDate || '',
    tagIds: contact.tagIds || [],
    notes: contact.notes || '',
  };
}

export default function OpportunityDetailModal({ open, onClose, contact }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const nav = useFromHere();
  const pipelines = selectPipelines(state);

  const [draft, setDraft] = useState(() => emptyDraftFor(contact));

  useEffect(() => {
    if (open) setDraft(emptyDraftFor(contact));
  }, [open, contact]);

  // Hooks must run in the same order every render — keep useMemo above any
  // early return. Falls back to an empty pipelineId/stage list when no contact.
  const stagesForPipeline = useMemo(() => {
    const pl = pipelines.find((p) => p.id === (draft?.pipelineId || ''));
    return pl?.stages || [];
  }, [pipelines, draft?.pipelineId]);

  if (!contact || !draft) {
    return <Modal open={open} onClose={onClose} title="Opportunity" size="sm">{null}</Modal>;
  }

  const company = contact.companyId ? selectClientById(state, contact.companyId) : null;
  const companyName = company?.name || contact.customFields?.company || '—';
  const tagsForDisplay = (draft.tagIds || []).map((id) => selectTagById(state, id)).filter(Boolean);
  const initials = `${(contact.firstName || '')[0] || ''}${(contact.lastName || '')[0] || ''}`.toUpperCase() || 'C';
  const avatarVariant = ((contact.id?.length || 0) % 5) + 1;

  const set = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const isDirty = (
    draft.email !== (contact.email || '') ||
    draft.phone !== (contact.phone || '') ||
    draft.title !== (contact.title || '') ||
    draft.lifecycle !== (contact.lifecycle || 'lead') ||
    draft.pipelineId !== (contact.pipelineId || '') ||
    draft.stage !== (contact.stage || '') ||
    draft.dealValue !== (contact.dealValue == null ? '' : String(contact.dealValue)) ||
    draft.expectedCloseDate !== (contact.expectedCloseDate || '') ||
    draft.notes !== (contact.notes || '') ||
    JSON.stringify(draft.tagIds || []) !== JSON.stringify(contact.tagIds || [])
  );

  const handleSave = (e) => {
    e?.preventDefault?.();
    if (!isDirty) { onClose(); return; }

    const parsedValue = draft.dealValue.trim ? draft.dealValue.trim() : draft.dealValue;
    const numericValue = parsedValue === '' ? null : Number(parsedValue);
    if (numericValue != null && Number.isNaN(numericValue)) {
      toast.error('Deal value must be a number.');
      return;
    }

    dispatch({
      type: ACTIONS.UPDATE_CONTACT,
      id: contact.id,
      patch: {
        email: draft.email.trim().toLowerCase(),
        phone: draft.phone.trim(),
        title: draft.title.trim(),
        lifecycle: draft.lifecycle,
        dealValue: numericValue,
        expectedCloseDate: draft.expectedCloseDate || null,
        tagIds: draft.tagIds,
        notes: draft.notes,
      },
    });

    const stageChanged = draft.stage !== (contact.stage || '') || draft.pipelineId !== (contact.pipelineId || '');
    if (stageChanged) {
      dispatch({
        type: ACTIONS.SET_CONTACT_STAGE,
        id: contact.id,
        stage: draft.stage || null,
        pipelineId: draft.pipelineId || null,
      });
    }

    toast.success('Opportunity updated');
    onClose();
  };

  const goToContact = () => {
    onClose?.();
    navigate(`/contacts/${contact.id}`, { state: nav });
  };

  const goToClient = () => {
    if (!company) return;
    onClose?.();
    navigate(`/clients/${company.id}`, { state: nav });
  };

  return (
    <Modal open={open} onClose={onClose} title="Opportunity">
      <form onSubmit={handleSave}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Avatar initials={initials} variant={avatarVariant} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
              {contact.firstName} {contact.lastName}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
              {company ? (
                <button type="button" className="linklike" onClick={goToClient}>{companyName}</button>
              ) : (
                companyName
              )}
              {contact.title ? ` · ${contact.title}` : ''}
            </div>
          </div>
        </div>

        <div className="form-row">
          <FormField label="Deal value">
            <input
              className="input"
              type="text"
              inputMode="numeric"
              value={draft.dealValue === '' ? '' : money(Number(draft.dealValue) || 0)}
              onChange={(e) => set('dealValue', e.target.value.replace(/[^\d]/g, ''))}
              placeholder="$0"
            />
          </FormField>
          <FormField
            label="Expected close"
            type="date"
            value={draft.expectedCloseDate}
            onChange={(e) => set('expectedCloseDate', e.target.value)}
          />
        </div>

        <div className="form-row">
          <FormField
            label="Pipeline"
            as="select"
            value={draft.pipelineId}
            onChange={(e) => set('pipelineId', e.target.value)}
            options={[{ value: '', label: '— None —' }, ...pipelines.map((p) => ({ value: p.id, label: p.label }))]}
          />
          <FormField
            label="Stage"
            as="select"
            value={draft.stage}
            onChange={(e) => set('stage', e.target.value)}
            disabled={!draft.pipelineId}
            options={[{ value: '', label: '— None —' }, ...stagesForPipeline.map((s) => ({ value: s.key, label: s.label }))]}
          />
        </div>

        <div className="form-row">
          <FormField
            label="Email"
            type="email"
            value={draft.email}
            onChange={(e) => set('email', e.target.value)}
          />
          <FormField
            label="Phone"
            value={draft.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </div>

        <div className="form-row">
          <FormField
            label="Title"
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Office Manager, Facilities Director…"
          />
          <FormField
            label="Status"
            as="select"
            value={draft.lifecycle}
            onChange={(e) => set('lifecycle', e.target.value)}
            options={LIFECYCLES}
            help="Auto-promotes to Client on Won. Edit here to override."
          />
        </div>

        <div className="form-group">
          <label className="form-label">Tags</label>
          <TagPicker value={draft.tagIds} onChange={(ids) => set('tagIds', ids)} />
        </div>

        <FormField
          label="Notes"
          as="textarea"
          rows={3}
          value={draft.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Anything worth remembering…"
        />

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-outline" onClick={goToContact}>Open full profile</button>
          <button type="submit" className="btn btn-primary" disabled={!isDirty}>Save changes</button>
        </div>
      </form>
    </Modal>
  );
}
