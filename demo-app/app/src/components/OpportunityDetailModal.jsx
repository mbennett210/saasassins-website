import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import Avatar from './Avatar';
import Icon from './Icon';
import FormField from './FormField';
import { useFromHere } from '../hooks/useFromHere';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectClientById,
  selectContactById,
  selectContactsForClient,
  selectConversationsForContact,
  selectActivePipelineStages,
} from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { money } from '../lib/dates';

// The deal editor (opens when a board card is clicked). An Opportunity belongs to
// a COMPANY, so the header leads with the company and its primary contact; the
// editable fields are the deal's (name / value / stage / close / which person it
// runs through). Notes land on the company's timeline.

function emptyDraftFor(opp) {
  if (!opp) return null;
  return {
    title: opp.title || '',
    value: opp.value == null ? '' : String(opp.value),
    stage: opp.stage || '',
    expectedCloseDate: opp.expectedCloseDate || '',
    primaryContactId: opp.primaryContactId || '',
  };
}

export default function OpportunityDetailModal({ open, onClose, opportunity }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canEdit = usePermission('pipeline.edit');
  const canStartConversation = usePermission('messaging.startConversation');

  const [draft, setDraft] = useState(() => emptyDraftFor(opportunity));
  const [noteDraft, setNoteDraft] = useState('');

  useEffect(() => {
    if (open) { setDraft(emptyDraftFor(opportunity)); setNoteDraft(''); }
  }, [open, opportunity]);

  const stages = selectActivePipelineStages(state);
  const company = opportunity?.clientId ? selectClientById(state, opportunity.clientId) : null;
  const companyContacts = company ? selectContactsForClient(state, company.id) : [];

  if (!opportunity || !draft) {
    return <Modal open={open} onClose={onClose} title="Opportunity" size="sm">{null}</Modal>;
  }

  const person = draft.primaryContactId ? selectContactById(state, draft.primaryContactId) : null;
  const companyName = company?.name || 'Unknown company';
  const initials = companyName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'C';
  const avatarVariant = ((opportunity.id?.length || 0) % 5) + 1;

  const set = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const isDirty = (
    draft.title !== (opportunity.title || '') ||
    draft.value !== (opportunity.value == null ? '' : String(opportunity.value)) ||
    draft.stage !== (opportunity.stage || '') ||
    draft.expectedCloseDate !== (opportunity.expectedCloseDate || '') ||
    draft.primaryContactId !== (opportunity.primaryContactId || '')
  );
  const hasPendingNote = !!noteDraft.trim();

  const flushNote = () => {
    if (!hasPendingNote || !company) return;
    dispatch({ type: ACTIONS.APPEND_CLIENT_NOTE, id: company.id, text: noteDraft.trim(), authorUserId: currentUser?.id });
    setNoteDraft('');
  };

  const commitSave = () => {
    if (isDirty) {
      const cleaned = String(draft.value).replace(/[$,\s]/g, '');
      const numericValue = cleaned === '' ? null : Number(cleaned);
      if (numericValue != null && Number.isNaN(numericValue)) { toast.error('Deal value must be a number.'); return false; }
      flushNote();
      dispatch({
        type: ACTIONS.UPDATE_OPPORTUNITY,
        id: opportunity.id,
        patch: {
          title: draft.title.trim(),
          value: numericValue,
          expectedCloseDate: draft.expectedCloseDate || null,
          primaryContactId: draft.primaryContactId || null,
        },
      });
      if (draft.stage !== (opportunity.stage || '')) {
        dispatch({ type: ACTIONS.SET_OPPORTUNITY_STAGE, id: opportunity.id, stage: draft.stage || null, pipelineId: opportunity.pipelineId || null, authorUserId: currentUser?.id });
      }
      toast.success('Opportunity updated');
      return true;
    }
    if (hasPendingNote) { flushNote(); toast.success('Note added'); }
    return true;
  };

  const handleSave = (e) => { e?.preventDefault?.(); if (commitSave()) onClose(); };
  const appendNote = () => { if (!hasPendingNote) return; flushNote(); toast.success('Note added'); };

  const openThread = (channel) => {
    if ((isDirty || hasPendingNote) && !commitSave()) return;
    if (!person) return;
    const existing = selectConversationsForContact(state, person.id)
      .filter((c) => c.channel === channel)
      .sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
    let convId = existing[0]?.id;
    if (!convId) {
      convId = newId('cv');
      dispatch({ type: ACTIONS.ADD_CONVERSATION, conversation: { id: convId, channel, contactId: person.id, clientId: company?.id || null, title: null } });
    }
    onClose?.();
    navigate(`/messaging/${convId}`, { state: nav });
  };

  const goToClient = () => { if (!company) return; onClose?.(); navigate(`/clients/${company.id}`, { state: nav }); };

  return (
    <Modal open={open} onClose={onClose} title="Opportunity">
      <form onSubmit={handleSave} noValidate>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Avatar initials={initials} variant={avatarVariant} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
              <button type="button" className="linklike" onClick={goToClient}>{companyName}</button>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
              {person ? `${person.firstName} ${person.lastName}`.trim() : 'No primary contact'}
              {person?.title ? ` · ${person.title}` : ''}
            </div>
          </div>
          {canStartConversation && person && (
            <div className="opp-quick-actions">
              <button type="button" className="btn-icon btn-icon-primary" disabled={!person.phone} aria-label="Send a text message" title={person.phone ? undefined : 'No phone number on file'} onClick={() => openThread('sms')}>
                <Icon name="messagingSolid" size={16} />
              </button>
              <button type="button" className="btn-icon btn-icon-primary" disabled={!person.email} aria-label="Send an email" title={person.email ? undefined : 'No email address on file'} onClick={() => openThread('email')}>
                <Icon name="mailSolid" size={16} />
              </button>
            </div>
          )}
        </div>

        <FormField label="Deal name" value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Janitorial contract" />

        <div className="form-row">
          <FormField label="Deal value">
            <input className="input" type="text" inputMode="numeric" value={draft.value === '' ? '' : money(Number(draft.value) || 0)} onChange={(e) => set('value', e.target.value.replace(/[^\d]/g, ''))} placeholder="$0" />
          </FormField>
          <FormField label="Expected close" type="date" value={draft.expectedCloseDate} onChange={(e) => set('expectedCloseDate', e.target.value)} />
        </div>

        <div className="form-row">
          <FormField label="Stage" as="select" value={draft.stage} onChange={(e) => set('stage', e.target.value)}
            options={stages.map((s) => ({ value: s.key, label: s.label }))} />
          <FormField label="Primary contact" as="select" value={draft.primaryContactId}
            onChange={(e) => set('primaryContactId', e.target.value)}
            options={[{ value: '', label: 'None' }, ...companyContacts.map((c) => ({ value: c.id, label: `${c.firstName} ${c.lastName}`.trim() }))]} />
        </div>

        <div className="form-group">
          <label className="form-label">Notes</label>
          {canEdit && (
            <>
              <textarea className="input notes-compose" rows={3} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Call recap, follow-up, decision…" />
              <div className="notes-compose-actions opp-notes-actions">
                <button type="button" className="btn btn-primary" disabled={!hasPendingNote} onClick={appendNote}>Append note</button>
              </div>
            </>
          )}
          <div className="text-xs text-muted opp-notes-empty">Notes are added to {companyName}&rsquo;s timeline.</div>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-outline" onClick={goToClient}>Open company</button>
          <button type="submit" className="btn btn-primary" disabled={!isDirty && !hasPendingNote}>Save changes</button>
        </div>
      </form>
    </Modal>
  );
}
