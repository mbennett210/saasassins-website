import { useT } from '../i18n/react';
import { useToast } from './Toast';
import FormField from './FormField';
import Modal from './Modal';
import { SIGN_IN_LINK_HOURS, LINK_NOT_SENT } from '../lib/signInLink';

// A ONE-TIME SIGN-IN LINK THE APP COULDN'T EMAIL, handed to the office to send themselves (GO-10
// for customer logins; CS-661 for staff — the live app has no sending mailbox). The four places
// that make a link show it here: Team's invite (AddUserModal), a member's "Send password-reset
// link" (TeamDetail), and a customer contact's Invite / Re-invite (Settings → Customer logins and
// the customer page's card). Plain words, the link to copy, and how long it lasts.
//
// 🔴 `link` IS A CAPABILITY (it sets the person's password): shown, copied, never stored — the
// screens keep it in component state only, and the server answers it no-store.
// A sign-in link is never texted (2026-10-28: the approved texting campaign covers the customer
// texts only, so GO-7's texted link was removed); this panel is the one way past a failed email.
export default function SignInLinkPanel({ name, link, why = LINK_NOT_SENT.notSetUp, replaces = false }) {
  const t = useT();
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('signInLink.copied'));
    } catch {
      toast.error(t('signInLink.copyFailed'));
    }
  };
  const params = { name, count: SIGN_IN_LINK_HOURS };
  return (
    <>
      <div className="callout callout-warning text-sm mb-14">
        {why === LINK_NOT_SENT.failed ? t('signInLink.sendFailed', params) : t('signInLink.notEmailed', params)}
        {replaces && <> {t('signInLink.replaces')}</>}
      </div>
      <FormField
        label={t('signInLink.label')}
        as="textarea"
        readOnly
        value={link}
        rows={3}
        onFocus={(e) => e.target.select()}
      />
      <button type="button" className="btn btn-outline" onClick={copy}>{t('signInLink.copy')}</button>
    </>
  );
}

// The panel in its own dialog, for the screens that make a link from a button.
export function SignInLinkModal({ open, onClose, name, link, why, replaces = false }) {
  const t = useT();
  return (
    <Modal open={open && !!link} onClose={onClose} title={t('signInLink.title')}>
      {open && link && (
        <>
          <SignInLinkPanel name={name} link={link} why={why} replaces={replaces} />
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.done')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
