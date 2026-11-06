// Declining a supply order (SUP-1 b: "rejected with a reason" — never a bare refusal). ONE modal for
// every decline (S131): the order queue's row action, the order page, and By building's "Awaiting your
// approval" cards (S131 Wave 2). The reason is required — at least SUPPLY_DECLINE_REASON_MIN characters,
// the write point's own number (lib/supplyFlow supplyDecisionPatch refuses fewer) — and the person who
// asked is told it (lib/supplyFlow `supplyOrderDeclined`). The stored status stays `rejected`.
import { useState } from 'react';
import { useStore } from '../store';
import { selectClientById } from '../store/selectors';
import { customerLabel } from '../lib/customerNumber';
import { SUPPLY_DECLINE_REASON_MIN, SUPPLY_DECLINE_REASON_MAX } from '../lib/supplies';
import Modal from './Modal';
import FormField from './FormField';
import { useT } from '../i18n/react';

export default function SupplyDeclineModal({ request, working, onDecline, onClose }) {
  const t = useT();
  const state = useStore();
  const [reason, setReason] = useState('');
  const client = request ? selectClientById(state, request.clientId) : null;
  const trimmed = reason.trim();
  const valid = trimmed.length >= SUPPLY_DECLINE_REASON_MIN;
  return (
    <Modal open onClose={onClose} title={client ? t('supplyPage.rejectTitleAt', { customer: customerLabel(client) }) : t('supplyPage.rejectTitle')}>
      <p className="text-sm text-muted">{t('supplyPage.rejectLead')}</p>
      <FormField label={t('supplyPage.rejectReason')} error={trimmed && !valid ? t('supplyPage.rejectReasonShort', { min: SUPPLY_DECLINE_REASON_MIN }) : null}>
        <textarea
          className="input" rows={3} value={reason} autoFocus maxLength={SUPPLY_DECLINE_REASON_MAX}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('supplyPage.rejectPlaceholder')}
        />
      </FormField>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-danger" onClick={() => onDecline(trimmed)} disabled={!valid || working}>{t('supplyPage.rejectConfirm')}</button>
      </div>
    </Modal>
  );
}
