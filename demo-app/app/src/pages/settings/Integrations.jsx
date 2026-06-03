// Settings → Integrations
//
// Surfaces deployment-level integrations. Future add-ons (QuickBooks, Gusto,
// Stripe Connect) will register additional cards here.
//
// Twilio cards (Core SMS):
//   1. Connection — status, phone number, account SID last 4, Connect/Disconnect.
//   2. A2P 10DLC — registration status, submit/edit form, super-admin status override.
//   3. Webhook — inbound SMS webhook URL (read-only; copy-to-clipboard).
//   4. Test SMS — send a test outbound (gated by full readiness).
//   5. Simulate inbound — exercises the inbound routing path locally (dev only — hidden when backend is wired).
//
// Resend cards (Core email — system transactional):
//   6. Connection — status, verified domain, default From, Connect/Disconnect.
//   7. Domain Verification — DKIM/SPF/DMARC records to add to DNS, with status.
//   8. Test Email — send a test email through the connected provider.
//
// Per-user conversational email lives at Settings → My Account → Connected
// Inboxes (Phase 3) — NOT here. This page is for deployment-level provider
// setup that an admin configures once.
//
// Permissions: integrations.view (admin+) sees the page. integrations.manage (super admin)
// is required to connect, disconnect, submit A2P, or override A2P status.

import { useMemo, useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectTwilioIntegration,
  selectIsTwilioSendReady,
  selectTwilioBlockers,
  selectEmailIntegration,
  selectIsEmailSendReady,
  selectEmailBlockers,
  selectEmailDefaultFrom,
} from '../../store/selectors';
import { useToast } from '../../components/Toast';
import { usePermission } from '../../hooks/usePermission';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import ConnectTwilioModal from '../../components/ConnectTwilioModal';
import A2PRegistrationModal from '../../components/A2PRegistrationModal';
import ConnectEmailProviderModal from '../../components/ConnectEmailProviderModal';
import {
  disconnectTwilio,
  sendSMS,
  subscribeToDelivery,
  simulateInbound,
  TWILIO_BACKEND_URL,
} from '../../lib/twilio';
import { sendEmail, getEmailHealth, EMAIL_BACKEND_URL } from '../../lib/email';

const A2P_BADGE = {
  not_started: { variant: 'slate',  label: 'Not started' },
  pending:     { variant: 'amber',  label: 'Pending review' },
  approved:    { variant: 'green',  label: 'Approved' },
  rejected:    { variant: 'red',    label: 'Rejected' },
  suspended:   { variant: 'red',    label: 'Suspended' },
};

const USE_CASE_LABEL = {
  customer_care: 'Customer Care',
  marketing: 'Marketing',
  mixed: 'Mixed (Care + Marketing)',
  account_notification: 'Account Notifications',
  delivery_notification: 'Delivery Notifications',
};

export default function SettingsIntegrations() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();

  const canManage = usePermission('integrations.manage');
  const twilio = selectTwilioIntegration(state);
  const sendReady = selectIsTwilioSendReady(state);
  const blockers = selectTwilioBlockers(state);

  const email = selectEmailIntegration(state);
  const emailSendReady = selectIsEmailSendReady(state);
  const emailBlockers = selectEmailBlockers(state);
  const emailDefaultFrom = selectEmailDefaultFrom(state);

  const [connectOpen, setConnectOpen] = useState(false);
  const [a2pOpen, setA2pOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const [emailConnectOpen, setEmailConnectOpen] = useState(false);
  const [confirmEmailDisconnect, setConfirmEmailDisconnect] = useState(false);
  const [domainBusy, setDomainBusy] = useState(false);

  // Test SMS local UI state.
  const [testTo, setTestTo] = useState('');
  const [testBody, setTestBody] = useState('Hi from the SMS test — replying confirms delivery.');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null); // { sid, status, failureReason? }

  // Simulate inbound local UI state.
  const [simFrom, setSimFrom] = useState('');
  const [simBody, setSimBody] = useState('Hey — thanks for the reminder, see you tomorrow.');

  // Test Email local UI state.
  const [emailTestTo, setEmailTestTo] = useState('');
  const [emailTestSubject, setEmailTestSubject] = useState('Test from your app');
  const [emailTestBody, setEmailTestBody] = useState('This is a test email from your app — replying confirms the From + Reply-To routing works.');
  const [emailTestBusy, setEmailTestBusy] = useState(false);
  const [emailTestResult, setEmailTestResult] = useState(null); // { id, status, failureReason? }

  const a2pBadge = A2P_BADGE[twilio?.a2p?.status || 'not_started'];

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    try {
      await disconnectTwilio();
      dispatch({ type: ACTIONS.DISCONNECT_TWILIO });
    } catch (err) {
      toast.error(err.message || 'Disconnect failed.');
    }
  };

  const handleA2POverride = (nextStatus) => {
    if (nextStatus === 'rejected') {
      const reason = window.prompt('Rejection reason (carrier message)?', '');
      if (reason === null) return;
      dispatch({ type: ACTIONS.UPDATE_A2P_STATUS, status: 'rejected', rejectionReason: reason });
      return;
    }
    dispatch({ type: ACTIONS.UPDATE_A2P_STATUS, status: nextStatus });
  };

  const handleA2PReset = () => {
    if (!window.confirm('Reset A2P registration? The captured form data will be cleared.')) return;
    dispatch({ type: ACTIONS.RESET_A2P });
  };

  const copyWebhook = async () => {
    if (!twilio?.inboundWebhookUrl) return;
    try {
      await navigator.clipboard.writeText(twilio.inboundWebhookUrl);
    } catch {
      toast.error('Could not copy. Select the URL and copy manually.');
    }
  };

  const sendTest = async (e) => {
    e.preventDefault();
    if (!sendReady) return;
    setTestBusy(true);
    setTestResult({ status: 'sending' });

    // Push the message into the conversation thread for the test recipient (if linked),
    // OR just track the send + delivery status without persisting. The test card creates
    // a synthesized "test" record that doesn't pollute the inbox unless a thread already
    // exists for that number. To keep it observable and simple, we just track in-modal
    // status here without dispatching ADD_MESSAGE — production sends from Messaging itself.
    try {
      const result = await sendSMS({
        from: twilio.phoneNumber,
        to: testTo,
        body: testBody,
      });
      setTestResult({ sid: result.sid, status: result.status });
      const unsubscribe = subscribeToDelivery(result.sid, (update) => {
        setTestResult((prev) => ({ ...(prev || {}), ...update }));
        if (update.status === 'delivered' || update.status === 'failed') {
          unsubscribe();
        }
      });
    } catch (err) {
      setTestResult({ status: 'failed', failureReason: err.message || 'Unknown error' });
      dispatch({ type: ACTIONS.UPDATE_TWILIO_ERROR, error: err.message || null });
    } finally {
      setTestBusy(false);
    }
  };

  const handleSimulateInbound = (e) => {
    e.preventDefault();
    if (!simFrom.trim()) return;
    const payload = simulateInbound({
      fromPhone: simFrom.trim(),
      toPhone: twilio?.phoneNumber || '',
      body: simBody.trim(),
    });
    dispatch({
      type: ACTIONS.RECEIVE_SMS,
      fromPhone: payload.fromPhone,
      toPhone: payload.toPhone,
      body: payload.body,
      messageSid: payload.messageSid,
    });
    setSimBody('');
  };

  // ---------- Email provider handlers ----------
  const handleEmailDisconnect = async () => {
    setConfirmEmailDisconnect(false);
    try {
      dispatch({ type: ACTIONS.DISCONNECT_EMAIL_PROVIDER });
      toast.success('Email provider disconnected.');
    } catch (err) {
      toast.error(err.message || 'Disconnect failed.');
    }
  };

  const handleCheckDomain = async () => {
    setDomainBusy(true);
    try {
      const health = await getEmailHealth();
      dispatch({
        type: ACTIONS.UPDATE_EMAIL_DOMAIN_STATUS,
        status: health.status === 'verified' ? 'verified' : (health.status || 'pending'),
        dkimRecords: health.dkimRecords || [],
        spfStatus: health.spfStatus || null,
        dmarcStatus: health.dmarcStatus || null,
        failureReason: health.failureReason || null,
      });
      if (health.status === 'verified') {
        toast.success('Domain verified.');
      } else if (health.status === 'failed') {
        toast.error(health.failureReason || 'Domain verification failed.');
      } else {
        toast.success('Status refreshed.');
      }
    } catch (err) {
      dispatch({ type: ACTIONS.UPDATE_EMAIL_ERROR, error: err.message || 'Health check failed' });
      toast.error(err.message || 'Could not check domain status.');
    } finally {
      setDomainBusy(false);
    }
  };

  const sendEmailTest = async (e) => {
    e.preventDefault();
    setEmailTestBusy(true);
    setEmailTestResult({ status: 'sending' });
    try {
      const result = await sendEmail({
        to: emailTestTo.trim(),
        from: emailDefaultFrom || 'no-reply@example.com',
        subject: emailTestSubject,
        body: emailTestBody,
        tags: ['settings_test'],
      });
      setEmailTestResult({ id: result.id, status: result.status });
    } catch (err) {
      setEmailTestResult({ status: 'failed', failureReason: err.message || 'Unknown error' });
      dispatch({ type: ACTIONS.UPDATE_EMAIL_ERROR, error: err.message || null });
    } finally {
      setEmailTestBusy(false);
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy. Select the text and copy manually.');
    }
  };

  const testStatusBadge = useMemo(() => {
    if (!testResult) return null;
    const map = {
      sending:   { variant: 'slate', label: 'Sending…' },
      queued:    { variant: 'slate', label: 'Queued' },
      sent:      { variant: 'blue',  label: 'Sent' },
      delivered: { variant: 'green', label: 'Delivered' },
      failed:    { variant: 'red',   label: 'Failed' },
    };
    return map[testResult.status] || { variant: 'slate', label: testResult.status };
  }, [testResult]);

  const emailTestStatusBadge = useMemo(() => {
    if (!emailTestResult) return null;
    const map = {
      sending:   { variant: 'slate', label: 'Sending…' },
      queued:    { variant: 'slate', label: 'Queued' },
      sent:      { variant: 'green', label: 'Sent' },
      delivered: { variant: 'green', label: 'Delivered' },
      failed:    { variant: 'red',   label: 'Failed' },
    };
    return map[emailTestResult.status] || { variant: 'slate', label: emailTestResult.status };
  }, [emailTestResult]);

  const emailDomainBadge = useMemo(() => {
    const status = email?.domain?.status || 'not_started';
    const map = {
      not_started: { variant: 'slate', label: 'Not started' },
      pending:     { variant: 'amber', label: 'Pending DNS' },
      verified:    { variant: 'green', label: 'Verified' },
      failed:      { variant: 'red',   label: 'Failed' },
    };
    return map[status] || { variant: 'slate', label: status };
  }, [email]);

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Integrations</h1>
        <p className="page-head-subtitle">
          Connect external services. Twilio powers SMS; Resend powers system email
          (invitations, reminders, billing). Per-user conversational email lives at{' '}
          <strong>My Account → Connected Inboxes</strong>, not here.
          {(!TWILIO_BACKEND_URL || !EMAIL_BACKEND_URL) && (
            <> <strong>Dev mode:</strong> some network calls are simulated locally.</>
          )}
        </p>
      </div>

      {/* ───────── Twilio Connection ───────── */}
      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 className="dash-card-title">
              <Icon name="phone" size={16} /> Twilio
              {twilio?.connected
                ? <Badge variant="green" style={{ marginLeft: 8 }}>Connected</Badge>
                : <Badge variant="slate" style={{ marginLeft: 8 }}>Not connected</Badge>}
            </h3>
            {twilio?.connected ? (
              <div className="text-sm text-muted">
                Account ending in <code>•••• {twilio.accountSidLast4}</code>
                {twilio.phoneNumber && <> · Number <strong>{twilio.phoneNumberFriendlyName || twilio.phoneNumber}</strong></>}
                {twilio.connectedAt && <> · Connected {new Date(twilio.connectedAt).toLocaleDateString()}</>}
              </div>
            ) : (
              <div className="text-sm text-muted">
                Connect a Twilio account to enable SMS for this deployment.
              </div>
            )}
            {twilio?.lastError && (
              <div className="form-error" style={{ marginTop: 6 }}>
                Last error: {twilio.lastError}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!twilio?.connected && canManage && (
              <button className="btn btn-primary" onClick={() => setConnectOpen(true)}>Connect</button>
            )}
            {twilio?.connected && canManage && (
              <button className="btn btn-outline" onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
            )}
          </div>
        </div>
      </div>

      {/* ───────── A2P 10DLC ───────── */}
      {twilio?.connected && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <h3 className="dash-card-title">
                <Icon name="lock" size={16} /> A2P 10DLC Registration
                <Badge variant={a2pBadge.variant} style={{ marginLeft: 8 }}>{a2pBadge.label}</Badge>
              </h3>
              <div className="text-sm text-muted">
                Required by US carriers for application-to-person SMS. We file on your behalf;
                review takes 2–7 business days.
              </div>

              {twilio.a2p?.status !== 'not_started' && (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '160px 1fr', gap: '4px 12px', fontSize: 13 }}>
                  {twilio.a2p?.brandName && (<><span className="text-muted">Brand</span><span>{twilio.a2p.brandName}</span></>)}
                  {twilio.a2p?.useCase && (<><span className="text-muted">Use case</span><span>{USE_CASE_LABEL[twilio.a2p.useCase] || twilio.a2p.useCase}</span></>)}
                  {twilio.a2p?.submittedAt && (<><span className="text-muted">Submitted</span><span>{new Date(twilio.a2p.submittedAt).toLocaleString()}</span></>)}
                  {twilio.a2p?.approvedAt && (<><span className="text-muted">Approved</span><span>{new Date(twilio.a2p.approvedAt).toLocaleString()}</span></>)}
                  {twilio.a2p?.rejectionReason && (<><span className="text-muted">Rejection</span><span style={{ color: 'var(--color-text-error, #b91c1c)' }}>{twilio.a2p.rejectionReason}</span></>)}
                  {twilio.a2p?.sampleMessages?.length > 0 && (
                    <>
                      <span className="text-muted">Samples</span>
                      <ol style={{ margin: 0, paddingLeft: 18 }}>
                        {twilio.a2p.sampleMessages.map((m, i) => (
                          <li key={i} style={{ marginBottom: 4 }}>{m}</li>
                        ))}
                      </ol>
                    </>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexDirection: 'column', alignItems: 'flex-end' }}>
              {canManage && twilio.a2p?.status === 'not_started' && (
                <button className="btn btn-primary" onClick={() => setA2pOpen(true)}>Start Registration</button>
              )}
              {canManage && twilio.a2p?.status === 'rejected' && (
                <button className="btn btn-primary" onClick={() => setA2pOpen(true)}>Edit & Resubmit</button>
              )}
              {canManage && twilio.a2p?.status === 'pending' && (
                <>
                  <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Super-admin override:</div>
                  <button className="btn btn-outline btn-sm" onClick={() => handleA2POverride('approved')}>Mark approved</button>
                  <button className="btn btn-outline btn-sm" onClick={() => handleA2POverride('rejected')}>Mark rejected</button>
                </>
              )}
              {canManage && (twilio.a2p?.status === 'approved' || twilio.a2p?.status === 'suspended') && (
                <button className="btn btn-outline btn-sm" onClick={handleA2PReset}>Reset</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ───────── Webhook URL ───────── */}
      {twilio?.connected && twilio?.inboundWebhookUrl && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <h3 className="dash-card-title"><Icon name="bell" size={16} /> Inbound Webhook</h3>
          <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
            Configure this URL on your Twilio phone number's "Messaging" settings so inbound texts route to this app.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, padding: '8px 12px', background: 'var(--surface-muted, #f4f4f5)', borderRadius: 6, fontSize: 13, wordBreak: 'break-all' }}>
              {twilio.inboundWebhookUrl}
            </code>
            <button type="button" className="btn btn-outline btn-sm" onClick={copyWebhook}>Copy</button>
          </div>
        </div>
      )}

      {/* ───────── Send-readiness blockers ───────── */}
      {twilio?.connected && !sendReady && blockers.length > 0 && (
        <div className="card detail-card" style={{ marginBottom: 16, borderLeft: '3px solid var(--color-amber-500, #f59e0b)' }}>
          <h3 className="dash-card-title">SMS sending is blocked</h3>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 14 }}>
            {blockers.map((b) => (<li key={b.key}>{b.label}</li>))}
          </ul>
        </div>
      )}

      {/* ───────── Test SMS ───────── */}
      {twilio?.connected && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <h3 className="dash-card-title"><Icon name="mail" size={16} /> Send a Test SMS</h3>
          <div className="text-sm text-muted" style={{ marginBottom: 10 }}>
            {sendReady
              ? 'Verify outbound delivery without leaving Settings.'
              : 'Resolve the blockers above before sending.'}
          </div>
          <form onSubmit={sendTest}>
            <div className="form-row">
              <FormField
                label="To"
                placeholder="+12065550100"
                required
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                disabled={!sendReady || testBusy}
              />
              <FormField
                label="From"
                value={twilio.phoneNumberFriendlyName || twilio.phoneNumber || ''}
                disabled
                help="Set in the Twilio connection card above."
              />
            </div>
            <FormField
              label="Body"
              as="textarea"
              rows={2}
              value={testBody}
              onChange={(e) => setTestBody(e.target.value)}
              disabled={!sendReady || testBusy}
            />
            <div className="modal-actions" style={{ marginTop: 4 }}>
              <div style={{ flex: 1 }}>
                {testStatusBadge && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Badge variant={testStatusBadge.variant}>{testStatusBadge.label}</Badge>
                    {testResult?.sid && <code className="text-xs text-muted">{testResult.sid}</code>}
                    {testResult?.failureReason && (
                      <span className="text-xs" style={{ color: 'var(--color-text-error, #b91c1c)' }}>
                        {testResult.failureReason}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button type="submit" className="btn btn-primary" disabled={!sendReady || testBusy}>
                {testBusy ? 'Sending…' : 'Send Test'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ───────── Simulate inbound (dev only) ───────── */}
      {twilio?.connected && !TWILIO_BACKEND_URL && (
        <div className="card detail-card" style={{ marginBottom: 16, borderLeft: '3px solid var(--color-blue-500, #3b82f6)' }}>
          <h3 className="dash-card-title"><Icon name="messaging" size={16} /> Simulate Inbound SMS <span className="text-xs text-muted">(dev only)</span></h3>
          <div className="text-sm text-muted" style={{ marginBottom: 10 }}>
            Routes a fake inbound text into Messaging. Matches contacts by phone number; unmatched numbers create a new unlinked thread.
          </div>
          <form onSubmit={handleSimulateInbound}>
            <div className="form-row">
              <FormField
                label="From"
                placeholder="+12065550199"
                required
                value={simFrom}
                onChange={(e) => setSimFrom(e.target.value)}
              />
              <FormField
                label="To (your number)"
                value={twilio.phoneNumber || ''}
                disabled
              />
            </div>
            <FormField
              label="Body"
              as="textarea"
              rows={2}
              value={simBody}
              onChange={(e) => setSimBody(e.target.value)}
            />
            <div className="modal-actions" style={{ marginTop: 4 }}>
              <button type="submit" className="btn btn-outline">Route Inbound</button>
            </div>
          </form>
        </div>
      )}

      {/* ───────── Email Provider (Resend) — Connection ───────── */}
      <div className="card detail-card" style={{ marginBottom: 16, marginTop: 28 }}>
        <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 className="dash-card-title">
              <Icon name="mail" size={16} /> Email Provider
              {email?.connected
                ? <Badge variant="green" style={{ marginLeft: 8 }}>Connected</Badge>
                : <Badge variant="slate" style={{ marginLeft: 8 }}>Not connected</Badge>}
              {email?.connected && email.provider && (
                <span className="text-xs text-muted" style={{ marginLeft: 8 }}>
                  via {email.provider === 'resend' ? 'Resend' : email.provider}
                </span>
              )}
            </h3>
            {email?.connected ? (
              <div className="text-sm text-muted">
                Domain <strong>{email.verifiedDomain}</strong>
                {email.apiKeyLast4 && <> · Key ending <code>•••• {email.apiKeyLast4}</code></>}
                {email.connectedAt && <> · Connected {new Date(email.connectedAt).toLocaleDateString()}</>}
                <div style={{ marginTop: 4 }}>
                  Default From: <code>{email.defaultFrom || '—'}</code>
                </div>
                {email.defaultReplyTo && (
                  <div>Reply-To: <code>{email.defaultReplyTo}</code></div>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted">
                Connect a Resend account to send invitations, reminder emails, and (later) billing email
                from a verified subdomain.
              </div>
            )}
            {email?.lastError && (
              <div className="form-error" style={{ marginTop: 6 }}>
                Last error: {email.lastError}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!email?.connected && canManage && (
              <button className="btn btn-primary" onClick={() => setEmailConnectOpen(true)}>Connect</button>
            )}
            {email?.connected && canManage && (
              <button className="btn btn-outline" onClick={() => setConfirmEmailDisconnect(true)}>Disconnect</button>
            )}
          </div>
        </div>
      </div>

      {/* ───────── Domain Verification ───────── */}
      {email?.connected && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <h3 className="dash-card-title">
                <Icon name="lock" size={16} /> Domain Verification
                <Badge variant={emailDomainBadge.variant} style={{ marginLeft: 8 }}>{emailDomainBadge.label}</Badge>
              </h3>
              <div className="text-sm text-muted">
                Add these records to your DNS for <code>{email.verifiedDomain}</code> so recipient
                inboxes accept email from this domain. Verification typically completes within an
                hour but can take up to 48h depending on your registrar.
              </div>

              {Array.isArray(email.domain?.dkimRecords) && email.domain.dkimRecords.length > 0 ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {email.domain.dkimRecords.map((rec, i) => (
                    <div key={i} className="card" style={{ padding: '8px 12px', background: 'var(--surface-muted, #f4f4f5)' }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Badge variant="slate">{rec.type || 'TXT'}</Badge>
                        <code className="text-xs" style={{ flex: 1, wordBreak: 'break-all' }}>
                          {rec.host}
                        </code>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() => copyToClipboard(`${rec.host}\t${rec.type || 'TXT'}\t${rec.value}`)}
                        >
                          Copy row
                        </button>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <code className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>
                          {rec.value}
                        </code>
                      </div>
                      {rec.status && (
                        <div style={{ marginTop: 4 }}>
                          <Badge variant={rec.status === 'verified' ? 'green' : rec.status === 'failed' ? 'red' : 'amber'}>
                            {rec.status}
                          </Badge>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted" style={{ marginTop: 8 }}>
                  No DKIM records returned yet. Click Refresh to check Resend.
                </div>
              )}

              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '160px 1fr', gap: '4px 12px', fontSize: 13 }}>
                <span className="text-muted">SPF</span>
                <span>{email.domain?.spfStatus || '—'}</span>
                <span className="text-muted">DMARC</span>
                <span>{email.domain?.dmarcStatus || '—'}</span>
                {email.domain?.lastCheckedAt && (
                  <>
                    <span className="text-muted">Last checked</span>
                    <span>{new Date(email.domain.lastCheckedAt).toLocaleString()}</span>
                  </>
                )}
                {email.domain?.failureReason && (
                  <>
                    <span className="text-muted">Failure</span>
                    <span style={{ color: 'var(--color-text-error, #b91c1c)' }}>{email.domain.failureReason}</span>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexDirection: 'column', alignItems: 'flex-end' }}>
              {canManage && (
                <button
                  className="btn btn-outline btn-sm"
                  onClick={handleCheckDomain}
                  disabled={domainBusy}
                >
                  {domainBusy ? 'Checking…' : 'Refresh status'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ───────── Email send-readiness blockers ───────── */}
      {email?.connected && !emailSendReady && emailBlockers.length > 0 && (
        <div className="card detail-card" style={{ marginBottom: 16, borderLeft: '3px solid var(--color-amber-500, #f59e0b)' }}>
          <h3 className="dash-card-title">Email sending is blocked</h3>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 14 }}>
            {emailBlockers.map((b) => (<li key={b.key}>{b.label}</li>))}
          </ul>
        </div>
      )}

      {/* ───────── Test Email ───────── */}
      {email?.connected && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <h3 className="dash-card-title"><Icon name="mail" size={16} /> Send a Test Email</h3>
          <div className="text-sm text-muted" style={{ marginBottom: 10 }}>
            {emailSendReady
              ? 'Verify outbound delivery without leaving Settings.'
              : 'You can send a test even while domain verification is pending — Resend will queue it; deliverability depends on the receiving inbox.'}
          </div>
          <form onSubmit={sendEmailTest}>
            <div className="form-row">
              <FormField
                label="To"
                type="email"
                placeholder="recipient@example.com"
                required
                value={emailTestTo}
                onChange={(e) => setEmailTestTo(e.target.value)}
                disabled={emailTestBusy}
              />
              <FormField
                label="From"
                value={emailDefaultFrom || ''}
                disabled
                help="Set in the Connection card above."
              />
            </div>
            <FormField
              label="Subject"
              required
              value={emailTestSubject}
              onChange={(e) => setEmailTestSubject(e.target.value)}
              disabled={emailTestBusy}
            />
            <FormField
              label="Body"
              as="textarea"
              rows={3}
              value={emailTestBody}
              onChange={(e) => setEmailTestBody(e.target.value)}
              disabled={emailTestBusy}
            />
            <div className="modal-actions" style={{ marginTop: 4 }}>
              <div style={{ flex: 1 }}>
                {emailTestStatusBadge && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Badge variant={emailTestStatusBadge.variant}>{emailTestStatusBadge.label}</Badge>
                    {emailTestResult?.id && <code className="text-xs text-muted">{emailTestResult.id}</code>}
                    {emailTestResult?.failureReason && (
                      <span className="text-xs" style={{ color: 'var(--color-text-error, #b91c1c)' }}>
                        {emailTestResult.failureReason}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button type="submit" className="btn btn-primary" disabled={emailTestBusy}>
                {emailTestBusy ? 'Sending…' : 'Send Test'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConnectTwilioModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      <A2PRegistrationModal open={a2pOpen} onClose={() => setA2pOpen(false)} />
      <ConnectEmailProviderModal open={emailConnectOpen} onClose={() => setEmailConnectOpen(false)} />
      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Twilio?"
        message="This deployment will stop sending and receiving SMS until reconnected. Existing message history is preserved."
        confirmLabel="Disconnect"
        variant="danger"
        onConfirm={handleDisconnect}
        onClose={() => setConfirmDisconnect(false)}
      />
      <ConfirmDialog
        open={confirmEmailDisconnect}
        title="Disconnect Email Provider?"
        message="Invitations and reminder emails will fall back to local stub mode until reconnected. The verified domain stays in Resend (DNS records are unaffected); reconnecting later restores the live send path."
        confirmLabel="Disconnect"
        variant="danger"
        onConfirm={handleEmailDisconnect}
        onClose={() => setConfirmEmailDisconnect(false)}
      />
    </div>
  );
}
