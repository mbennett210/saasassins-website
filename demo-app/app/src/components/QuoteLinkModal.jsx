import { useT } from '../i18n/react';
import { useToast } from './Toast';
import FormField from './FormField';
import Modal from './Modal';
import { quoteNotEmailedKey } from '../lib/quoteRules';

// A QUOTE THE APP COULDN'T EMAIL, handed to the office to send themselves (CS-664). The live app has
// no sending mailbox, so Send marked the quote sent and emailed nothing while the editor said
// "Sent to X for signature". The quote IS sent — its signing link works — so this says why nothing
// went (lib/quoteRules QUOTE_NOT_EMAILED: no mailbox, no address on file, or a failed send) and
// shows the link to copy. The same shape as the sign-in link hand-over (components/SignInLinkPanel,
// UI_RULES §157), without its expiry line: a signing link is meant to be shared, not a credential.
export default function QuoteLinkModal({ open, onClose, name, link, why }) {
  const t = useT();
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('quoteSend.copied'));
    } catch {
      toast.error(t('quoteSend.copyFailed'));
    }
  };
  return (
    <Modal open={open && !!link} onClose={onClose} title={t('quoteSend.title')}>
      {open && link && (
        <>
          <div className="callout callout-warning text-sm mb-14">
            {t(quoteNotEmailedKey(why), { name: name || t('quoteSend.theContact') })}
          </div>
          <FormField
            label={t('quoteSend.label')}
            as="textarea"
            readOnly
            value={link}
            rows={2}
            onFocus={(e) => e.target.select()}
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={copy}>{t('quoteSend.copy')}</button>
            <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.done')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
