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
// System email cards (the app's own mail, through Google):
//   6. System Email — which connected Google mailbox the app sends as, its OAuth health,
//      and (Super Admin only) the picker that marks it. There is NO key to paste and no
//      domain for the app to verify: DKIM/SPF/DMARC belong to the Google Workspace and are
//      set once in Google Admin, outside this product.
//   7. Test Email — send a test through that mailbox.
//
// This replaced a Resend "Connect provider" modal + a Domain Verification card. The modal
// kept only `apiKey.slice(-4)` in the shared record, never sent the key anywhere, and
// reported "connected" (CS-039); the domain card showed DKIM records for a subdomain that
// had none in public DNS (CS-280). Email goes through Google now (Daniel, 2026-09-29).
//
// Per-user conversational email lives at Settings → Connected Inboxes
// (Phase 3) — NOT here. This page is for deployment-level provider
// setup that an admin configures once.
//
// Permissions: integrations.view sees the page. integrations.manage is required to connect,
// disconnect, submit A2P, override A2P status, change a webhook, or see / copy a webhook's
// signing secret or lead token (the server sends those only to the Super Admin, by role, and
// to integrations.manage holders; the Copy buttons follow what it sent). Both default to
// Super Admin + Manager (lib/roles.js).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectTwilioIntegration,
  selectIsTwilioSendReady,
  selectTwilioBlockers,
} from '../../store/selectors';
import { useToast } from '../../components/Toast';
import { usePermission } from '../../hooks/usePermission';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import WebhooksSection from '../../components/WebhooksSection';
import LeadWebhooksSection from '../../components/LeadWebhooksSection';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import ConnectTwilioModal from '../../components/ConnectTwilioModal';
import A2PRegistrationModal from '../../components/A2PRegistrationModal';
import {
  disconnectTwilio,
  sendSMS,
  subscribeToDelivery,
  simulateInbound,
  TWILIO_BACKEND_URL,
  TWILIO_STUB_ACTIVE,
  TWILIO_CONFIGURED,
} from '../../lib/twilio';
import { sendEmail, getEmailHealth, getSystemSender, setSystemSender } from '../../lib/email';
import { smsStatus } from '../../lib/integrationsApi';
import { SMS_ALERT_EVENT_KEYS } from '../../lib/alertDelivery';
import GoogleWorkspacesSection from '../../components/GoogleWorkspacesSection';
import QuickBooksSection from '../../components/QuickBooksSection';

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

  // System email lives on the SERVER, not in the shared record: /api/email/health says
  // which Google mailbox sends and whether its token is still good.
  const isSuperAdmin = state.users?.find((u) => u.id === state.currentUserId)?.role === 'owner';
  const [emailHealth, setEmailHealth] = useState(null);
  const [emailHealthError, setEmailHealthError] = useState('');
  const [senderOptions, setSenderOptions] = useState([]);
  const [senderBusy, setSenderBusy] = useState(false);
  const emailConfigured = emailHealth?.configured === true;
  const emailDefaultFrom = emailHealth?.defaultFrom || emailHealth?.senderEmail || '';

  const [connectOpen, setConnectOpen] = useState(false);
  const [a2pOpen, setA2pOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);


  // Test SMS local UI state.
  const [testTo, setTestTo] = useState('');
  const [testBody, setTestBody] = useState('Hi from the SMS test. Replying confirms delivery.');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null); // { sid, status, failureReason? }

  // Simulate inbound local UI state.
  const [simFrom, setSimFrom] = useState('');
  const [simBody, setSimBody] = useState('Hey. Thanks for the reminder, see you tomorrow.');

  // Test Email local UI state.
  const [emailTestTo, setEmailTestTo] = useState('');
  const [emailTestSubject, setEmailTestSubject] = useState('Test from your app');
  const [emailTestBody, setEmailTestBody] = useState('This is a test email from your app. Replying confirms the From + Reply-To routing works.');
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

  // ---------- System email (Google) handlers ----------
  // One read on mount, and again after the owner changes the mailbox. The candidate list is
  // owner-only on the server (api/email/system-sender.js), so a non-owner simply gets no
  // picker rather than a 403 in the console.
  const loadEmailState = useCallback(async () => {
    try {
      const health = await getEmailHealth();
      setEmailHealth(health);
      setEmailHealthError('');
    } catch (err) {
      setEmailHealthError(err.message || 'Could not read the email status.');
    }
    if (!isSuperAdmin) { setSenderOptions([]); return; }
    try {
      const { candidates } = await getSystemSender();
      setSenderOptions(candidates || []);
    } catch {
      setSenderOptions([]); // not fatal: the status card still renders
    }
  }, [isSuperAdmin]);

  useEffect(() => { loadEmailState(); }, [loadEmailState]);

  // 🔴 NTF-1 / CS-069 / CS-038 — the ALERT-TEXT channel's REAL state, read from the SERVER.
  // Alert texts do not go through the blob's `company.integrations.twilio` (which a stub could
  // once set to "Connected" with a fake number, CS-038): they go through the deployment's own
  // Twilio environment, and only the server can say whether that exists. Presence only — the
  // route returns env NAMES and the kind of sender, never a value. A failed read is reported as
  // unknown, never as configured.
  const [smsState, setSmsState] = useState(null);       // { configured, senderKind, missing[] }
  const [smsStateError, setSmsStateError] = useState('');
  useEffect(() => {
    let alive = true;
    smsStatus()
      .then((s) => { if (alive) { setSmsState(s); setSmsStateError(''); } })
      .catch((err) => { if (alive) setSmsStateError(err.message || 'Could not read the texting status.'); });
    return () => { alive = false; };
  }, []);

  const chooseSender = async (inboxId) => {
    setSenderBusy(true);
    try {
      await setSystemSender(inboxId || null);
      await loadEmailState();
      toast.success(inboxId ? 'Sending mailbox updated.' : 'Sending mailbox cleared.');
    } catch (err) {
      toast.error(err.message || 'Could not set the sending mailbox.');
    } finally {
      setSenderBusy(false);
    }
  };

  const sendEmailTest = async (e) => {
    e.preventDefault();
    setEmailTestBusy(true);
    setEmailTestResult({ status: 'sending' });
    try {
      // No `from`: Gmail sends as the system-sender mailbox (api/_lib/email.js).
      const result = await sendEmail({
        to: emailTestTo.trim(),
        subject: emailTestSubject,
        body: emailTestBody,
        tags: ['settings_test'],
      });
      setEmailTestResult({ id: result.id, status: result.status });
    } catch (err) {
      setEmailTestResult({ status: 'failed', failureReason: err.message || 'Unknown error' });
      loadEmailState(); // a failure usually means the mailbox needs reconnecting
    } finally {
      setEmailTestBusy(false);
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

  // The sending mailbox's own state. 'verified' = a live Google token; 'failed' = it expired
  // and needs reconnecting; 'not_started' = no mailbox marked. There is no DNS state to
  // report: Google owns DKIM/SPF for the Workspace domain.
  const emailSenderBadge = useMemo(() => {
    const status = emailHealth?.status || 'not_started';
    const map = {
      not_started:   { variant: 'slate', label: "Email isn't set up" },
      not_configured:{ variant: 'slate', label: 'Not configured' },
      verified:      { variant: 'green', label: 'Sending' },
      failed:        { variant: 'red',   label: 'Needs reconnecting' },
    };
    return map[status] || { variant: 'slate', label: status };
  }, [emailHealth]);

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Integrations</h1>
      </div>

      {/* ───────── Google Workspaces (multi-Workspace OAuth registry) ───────── */}
      <GoogleWorkspacesSection canManage={canManage} />

      {/* ───────── QuickBooks Online (property P&L feed) — owner-gated inside ───────── */}
      <QuickBooksSection />

      {/* ───────── Alert texts (NTF-1 / CS-069) — the SERVER's own state ───────── */}
      <div className="card detail-card">
        {/* The title row's own flex gap spaces the badge — no inline margin (lint:design). */}
        <div className="dash-card-title-row">
          <h3 className="dash-card-title">
            <Icon name="bell" size={16} /> Alert texts
          </h3>
          {smsStateError
            ? <Badge variant="amber">Unknown</Badge>
            : smsState?.configured
              ? <Badge variant="green">On</Badge>
              : <Badge variant="slate">Off</Badge>}
        </div>
        <div className="text-sm text-muted">
          Missed shifts and urgent tickets are texted as well as pushed, to the phone number on each person&rsquo;s profile. Everyone chooses for themselves under Your Account; it is off until they turn it on.
        </div>
        {smsStateError ? (
          <div className="form-error">{smsStateError}</div>
        ) : smsState === null ? (
          <div className="text-sm text-muted">Checking…</div>
        ) : smsState.configured ? (
          <div className="text-sm text-muted">
            Sending through {smsState.senderKind === 'messaging_service' ? 'a Twilio Messaging Service' : 'a Twilio number'}.
            {' '}{SMS_ALERT_EVENT_KEYS.size} events text: a missed shift and an urgent ticket.
          </div>
        ) : (
          // The honest not-configured state — the CS-038 lesson: never imply a texting channel
          // exists. The env NAMES are safe to print; their values never are.
          <div className="text-sm text-muted">
            Texting is off: this deployment has no Twilio credentials.
            {smsState.missing?.length ? (
              <> Still needed: {smsState.missing.map((name, i) => (
                <span key={name}>{i > 0 ? ', ' : ''}<code>{name}</code></span>
              ))}.</>
            ) : null}
            {' '}Until then a missed shift and an urgent ticket are pushed only.
          </div>
        )}
      </div>

      {/* ───────── Twilio Connection ───────── */}
      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 className="dash-card-title">
              <Icon name="phone" size={16} /> Twilio
              {twilio?.connected
                ? <Badge variant="green" style={{ marginLeft: 8 }}>Connected</Badge>
                : <Badge variant="slate" style={{ marginLeft: 8 }}>{TWILIO_CONFIGURED ? 'Not connected' : 'Not configured'}</Badge>}
            </h3>
            {twilio?.connected ? (
              <div className="text-sm text-muted">
                Account ending in <code>•••• {twilio.accountSidLast4}</code>
                {twilio.phoneNumber && <> · Number <strong>{twilio.phoneNumberFriendlyName || twilio.phoneNumber}</strong></>}
                {twilio.connectedAt && <> · Connected {new Date(twilio.connectedAt).toLocaleDateString()}</>}
              </div>
            ) : TWILIO_CONFIGURED ? (
              <div className="text-sm text-muted">
                Connect a Twilio account to enable SMS for this deployment.
              </div>
            ) : (
              // CS-038: a production build with no Twilio backend must NOT offer a stub
              // "Connect" that hands out fake numbers. Show the honest not-configured state.
              <div className="text-sm text-muted">
                SMS is not configured for this deployment. It will be enabled once the Twilio
                backend is provisioned.
              </div>
            )}
            {twilio?.lastError && (
              <div className="form-error" style={{ marginTop: 6 }}>
                Last error: {twilio.lastError}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!twilio?.connected && canManage && TWILIO_CONFIGURED && (
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
                  {twilio.a2p?.rejectionReason && (<><span className="text-muted">Rejection</span><span className="text-danger">{twilio.a2p.rejectionReason}</span></>)}
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
                  <button className="btn btn-outline" onClick={() => handleA2POverride('approved')}>Mark approved</button>
                  <button className="btn btn-outline" onClick={() => handleA2POverride('rejected')}>Mark rejected</button>
                </>
              )}
              {canManage && (twilio.a2p?.status === 'approved' || twilio.a2p?.status === 'suspended') && (
                <button className="btn btn-outline" onClick={handleA2PReset}>Reset</button>
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
            <code style={{ flex: 1, padding: '8px 12px', background: 'var(--inset-bg)', borderRadius: 6, fontSize: 13, wordBreak: 'break-all' }}>
              {twilio.inboundWebhookUrl}
            </code>
            <button type="button" className="btn btn-outline" onClick={copyWebhook}>Copy</button>
          </div>
        </div>
      )}

      {/* ───────── Send-readiness blockers ───────── */}
      {twilio?.connected && !sendReady && blockers.length > 0 && (
        <div className="card detail-card" style={{ marginBottom: 16, borderLeft: '3px solid var(--warning)' }}>
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
                      <span className="text-xs text-danger">
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

      {/* ───────── Simulate inbound (demo/dev only — DCE'd + hidden in production) ───────── */}
      {twilio?.connected && !TWILIO_BACKEND_URL && TWILIO_STUB_ACTIVE && (
        <div className="card detail-card" style={{ marginBottom: 16, borderLeft: '3px solid var(--primary)' }}>
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

      {/* ───────── System Email (Google) ───────── */}
      <div className="card detail-card" style={{ marginBottom: 16, marginTop: 28 }}>
        <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <h3 className="dash-card-title">
              <Icon name="mail" size={16} /> System Email
              <Badge variant={emailSenderBadge.variant} style={{ marginLeft: 8 }}>{emailSenderBadge.label}</Badge>
              <span className="text-xs text-muted" style={{ marginLeft: 8 }}>via Google</span>
            </h3>
            {emailConfigured ? (
              <div className="text-sm text-muted">
                Invitations, set-password links, quotes, reminders and customer email all send from{' '}
                <code>{emailHealth.senderEmail}</code>.
                <div style={{ marginTop: 4 }}>
                  {emailHealth.pinned
                    ? 'Pinned for this deployment (SYSTEM_SENDER_EMAIL), so it cannot be changed here.'
                    : 'Chosen below. Google handles DKIM and SPF for this domain — there is nothing to add to DNS.'}
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted">
                {emailHealth?.failureReason
                  || 'No sending mailbox chosen yet. Connect a Google mailbox, then mark it here — until then the app sends no email.'}
              </div>
            )}
            {emailHealthError && (
              <div className="form-error" style={{ marginTop: 6 }}>{emailHealthError}</div>
            )}
            {emailHealth?.senderLastError && (
              <div className="form-error" style={{ marginTop: 6 }}>Last error: {emailHealth.senderLastError}</div>
            )}

            {/* The picker is Super-Admin only, matching the server (requireRole owner). */}
            {isSuperAdmin && !emailHealth?.pinned && (
              <div style={{ marginTop: 12, maxWidth: 420 }}>
                <FormField
                  label="Sending mailbox"
                  as="select"
                  name="system-sender"
                  value={emailHealth?.senderInboxId || ''}
                  onChange={(e) => chooseSender(e.target.value)}
                  disabled={senderBusy || senderOptions.length === 0}
                  placeholder={senderOptions.length ? 'No mailbox — email is off' : 'No Google mailbox connected yet'}
                  options={senderOptions.map((c) => ({
                    value: c.id,
                    label: c.status === 'active' ? c.email : `${c.email} (needs reconnecting)`,
                  }))}
                  help={senderOptions.length
                    ? 'Any connected Google mailbox can send the app’s email. Only one at a time.'
                    : 'Connect one under Settings → Connected Inboxes, or Marketing → Inboxes, then pick it here.'}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ───────── Test Email ───────── */}
      {emailConfigured && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <h3 className="dash-card-title"><Icon name="mail" size={16} /> Send a Test Email</h3>
          <div className="text-sm text-muted" style={{ marginBottom: 10 }}>
            Verify outbound delivery without leaving Settings. The message leaves from the sending
            mailbox above, so a reply lands in that inbox.
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
                value={emailDefaultFrom}
                disabled
                help="The sending mailbox above. Gmail always sends as the mailbox itself."
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
                      <span className="text-xs text-danger">
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

      <LeadWebhooksSection />

      <WebhooksSection />

      <ConnectTwilioModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      <A2PRegistrationModal open={a2pOpen} onClose={() => setA2pOpen(false)} />
      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Twilio?"
        message="This deployment will stop sending and receiving SMS until reconnected. Existing message history is preserved."
        confirmLabel="Disconnect"
        variant="danger"
        onConfirm={handleDisconnect}
        onClose={() => setConfirmDisconnect(false)}
      />
    </div>
  );
}
