// "When is the walkthrough?" — the question that opens after a deal is moved (or added) into the
// walkthrough stage on the board (Daniel, 2026-10-20: moving a deal into "Walkthrough Scheduled"
// asks for the date and time). A PROMPT, NEVER A BLOCK: the move has already happened when this
// opens; "Not now" (or Esc, or the backdrop) closes it and writes nothing, and the card then says
// the time is not set. Saving writes the walkthrough through the deal's one write
// (UPDATE_OPPORTUNITY), which stamps it, and the walkthrough confirmation goes to the deal's contact
// (lib/walkthrough, lib/reminderScheduler).
import { useEffect, useState } from 'react';
import Modal from './Modal';
import WalkthroughFields from './WalkthroughFields';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClientById } from '../store/selectors';
import { useT } from '../i18n/react';
import { useToast } from './Toast';
import { walkthroughFields, walkthroughPatch } from '../lib/walkthrough';

export default function WalkthroughPrompt({ opportunityId, stageLabel = '', onClose }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const opportunity = opportunityId ? (state.opportunities || []).find((o) => o.id === opportunityId) || null : null;
  const company = opportunity?.clientId ? selectClientById(state, opportunity.clientId) : null;
  const [value, setValue] = useState(() => walkthroughFields(opportunity));
  const [errors, setErrors] = useState({});
  useEffect(() => {
    if (opportunityId) { setValue(walkthroughFields(opportunity)); setErrors({}); }
    // Opened for a deal: start from what it already has. Re-reading on every store change would wipe the typing.
  }, [opportunityId]);

  const open = !!opportunity;
  const save = (e) => {
    e?.preventDefault?.();
    const { patch, error } = walkthroughPatch(value);
    if (error) { setErrors({ [error]: true }); return; }
    dispatch({ type: ACTIONS.UPDATE_OPPORTUNITY, id: opportunity.id, patch });
    toast.success(t('walkthrough.saved'));
    onClose?.();
  };

  return (
    <Modal open={open} onClose={onClose} title={t('walkthrough.prompt.title')} size="sm">
      {open && (
        <form onSubmit={save} noValidate>
          <p className="text-sm text-muted walkthrough-prompt-lead">
            {t('walkthrough.prompt.lead', { company: company?.name || '', stage: stageLabel })}
          </p>
          <WalkthroughFields value={value} onChange={(v) => { setValue(v); setErrors({}); }} errors={errors}
            contactId={opportunity.primaryContactId || company?.primaryContactId || null} autoFocus />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('walkthrough.prompt.notNow')}</button>
            <button type="submit" className="btn btn-primary">{t('walkthrough.prompt.save')}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
