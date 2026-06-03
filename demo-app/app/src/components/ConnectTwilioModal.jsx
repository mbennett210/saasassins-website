// Two-step connection flow:
//   Step 1: enter Account SID + Auth Token → adapter validates + returns numbers
//   Step 2: pick a phone number from the returned list (or enter custom) → provision
// On success, dispatches CONNECT_TWILIO so the rest of the app sees the integration as live.

import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { connectTwilio, provisionNumber, TWILIO_BACKEND_URL } from '../lib/twilio';

const EMPTY = { accountSid: '', authToken: '' };

export default function ConnectTwilioModal({ open, onClose }) {
  const dispatch = useDispatch();
  const toast = useToast();

  const [step, setStep] = useState(1);
  const [creds, setCreds] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [available, setAvailable] = useState([]);
  const [accountSidLast4, setAccountSidLast4] = useState(null);
  const [chosenNumber, setChosenNumber] = useState('');
  const [customNumber, setCustomNumber] = useState('');

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setCreds(EMPTY);
    setBusy(false);
    setError('');
    setAvailable([]);
    setAccountSidLast4(null);
    setChosenNumber('');
    setCustomNumber('');
  }, [open]);

  const submitStep1 = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await connectTwilio({
        accountSid: creds.accountSid.trim(),
        authToken: creds.authToken.trim(),
      });
      if (!result.ok) throw new Error('Twilio rejected the credentials.');
      setAccountSidLast4(result.accountSidLast4);
      setAvailable(result.availableNumbers || []);
      setChosenNumber(result.availableNumbers?.[0]?.phoneNumber || '');
      setStep(2);
    } catch (err) {
      setError(err.message || 'Could not connect to Twilio.');
    } finally {
      setBusy(false);
    }
  };

  const submitStep2 = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const phoneNumber = chosenNumber === '__custom' ? customNumber.trim() : chosenNumber;
      const friendlyName = available.find((n) => n.phoneNumber === phoneNumber)?.friendlyName || phoneNumber;
      const result = await provisionNumber({ phoneNumber, friendlyName });
      if (!result.ok) throw new Error('Twilio rejected the number.');
      dispatch({
        type: ACTIONS.CONNECT_TWILIO,
        accountSidLast4,
        phoneNumber: result.phoneNumber,
        phoneNumberFriendlyName: result.friendlyName,
      });
      if (result.inboundWebhookUrl) {
        dispatch({ type: ACTIONS.UPDATE_TWILIO_WEBHOOK, url: result.inboundWebhookUrl });
      }
      toast.success('Twilio connected.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not provision the number.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={step === 1 ? 'Connect Twilio' : 'Choose a Phone Number'}>
      {step === 1 && (
        <form onSubmit={submitStep1}>
          <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 14 }}>
            Enter your Twilio Account SID and Auth Token. Find them on the
            Twilio Console dashboard.
            {!TWILIO_BACKEND_URL && (
              <> <strong>Dev mode:</strong> credentials are simulated locally and not sent to Twilio.</>
            )}
          </p>
          <FormField
            label="Account SID"
            required
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={creds.accountSid}
            onChange={(e) => setCreds({ ...creds, accountSid: e.target.value })}
            help="Starts with AC, 34 characters."
          />
          <FormField
            label="Auth Token"
            type="password"
            required
            placeholder="••••••••••••••••••••••••••••••••"
            value={creds.authToken}
            onChange={(e) => setCreds({ ...creds, authToken: e.target.value })}
          />
          {error && <div className="form-error" style={{ marginTop: 4 }}>{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Connecting…' : 'Continue'}
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={submitStep2}>
          <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 14 }}>
            Connected to account <code>•••• {accountSidLast4}</code>. Choose the number this deployment will send and receive SMS from.
          </p>
          <FormField
            label="Phone number"
            as="select"
            required
            value={chosenNumber}
            onChange={(e) => setChosenNumber(e.target.value)}
            options={[
              ...available.map((n) => ({ value: n.phoneNumber, label: n.friendlyName })),
              { value: '__custom', label: 'Use a different number…' },
            ]}
          />
          {chosenNumber === '__custom' && (
            <FormField
              label="Custom number (E.164 format)"
              required
              placeholder="+12065550100"
              value={customNumber}
              onChange={(e) => setCustomNumber(e.target.value)}
              help="Must start with + and country code."
            />
          )}
          {error && <div className="form-error" style={{ marginTop: 4 }}>{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(1)} disabled={busy}>Back</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Provisioning…' : 'Connect'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
