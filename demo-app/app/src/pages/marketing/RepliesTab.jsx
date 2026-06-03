// Replies tab — the marketing reply inbox. One shared list of every inbound
// reply correlated to a sequence. Replies are NOT auto-sorted into leads vs
// junk (no classifier) — open one to read it and decide: open the contact,
// move their pipeline stage, unenroll them, mark the reply handled, or resume
// a reply-halted sequence. A sent/replies stat strip sits up top.
//
// In stub mode (no email backend wired) the inbound listener is a no-op, so a
// "Simulate a reply" affordance lets you exercise the whole flow in dev.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectMarketingReplies,
  selectMarketingSequences,
  selectContacts,
  selectMarketingSends,
  selectMarketingInboxes,
  selectPipelines,
} from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useFromHere } from '../../hooks/useFromHere';
import { useToast } from '../../components/Toast';
import { INBOX_BACKEND_URL, sendViaInbox } from '../../lib/connectedInboxes';
import { newId } from '../../lib/ids';
import Modal from '../../components/Modal';
import FormField from '../../components/FormField';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function snippet(text, n = 140) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function contactLabel(c) {
  if (!c) return 'Unknown contact';
  return `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'Unknown contact';
}

// ─── Reply composer helpers ──────────────────────────────────────────────────

// Build the Re: subject — strips an existing "Re:" prefix (case-insensitive,
// any amount of whitespace) so we don't end up with "Re: Re: Re: …".
function buildReplySubject(originalSubject) {
  const raw = (originalSubject || '').trim();
  if (!raw) return 'Re:';
  const stripped = raw.replace(/^\s*re\s*:\s*/i, '');
  return `Re: ${stripped}`;
}

// Build the GitHub-style quoted body. Each line of the original gets a `>`
// prefix; the operator types their reply above the quote block.
function buildQuotedBody(reply, contact) {
  const date = reply.receivedAt
    ? new Date(reply.receivedAt).toLocaleString(undefined, {
        dateStyle: 'medium', timeStyle: 'short',
      })
    : 'a recent date';
  const name = contactLabel(contact);
  const lines = (reply.body || '').split(/\r?\n/);
  const quoted = lines.map((l) => `> ${l}`).join('\n');
  return `\n\n--\nOn ${date}, ${name} wrote:\n${quoted}`;
}

// A reply's `id` is normally the inbound's real RFC-5322 Message-ID (set by
// MarketingInboundListener from email.messageId). If it's a synthesized
// 'mrep_*' fallback (inbound had no Message-ID — rare), there's no real
// threading target so we skip the In-Reply-To header.
function inboundMessageIdForThreading(reply) {
  if (!reply?.id) return null;
  if (reply.id.startsWith('mrep_')) return null;
  return reply.id;
}

// Find the marketing inbox that sent the original outbound this reply is
// replying to. Walk marketingSends for this enrollment, pick the most recent
// 'sent' row, and look up the inbox by id. Returns null if we can't trace
// the send back to a known active inbox (e.g. the inbox was disconnected
// since send, or correlation failed and there's no enrollmentId).
function findSendingInbox(state, reply) {
  if (!reply?.enrollmentId) return null;
  const sends = (state.marketingSends || [])
    .filter((sd) => sd.enrollmentId === reply.enrollmentId && sd.status === 'sent')
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
  if (sends.length === 0) return null;
  const inboxId = sends[0].inboxId;
  if (!inboxId) return null;
  const inbox = (state.marketingInboxes || []).find((i) => i.id === inboxId);
  if (!inbox || inbox.status !== 'active' || inbox.enabled === false) return null;
  return inbox;
}

export default function RepliesTab() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const nav = useFromHere();
  const canManage = usePermission('marketing.manage');

  const replies = selectMarketingReplies(state);
  const sequences = selectMarketingSequences(state);
  const contacts = selectContacts(state);
  const sends = selectMarketingSends(state);

  const [openReplyId, setOpenReplyId] = useState(null);
  const [simulateOpen, setSimulateOpen] = useState(false);

  const seqById = new Map(sequences.map((s) => [s.id, s]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const sentCount = sends.filter((sd) => sd.status === 'sent').length;
  const newCount = replies.filter((r) => r.status === 'new').length;
  const openReply = openReplyId ? replies.find((r) => r.id === openReplyId) || null : null;
  const stubMode = !INBOX_BACKEND_URL;

  return (
    <>
      <div className="marketing-stat-strip">
        <div className="marketing-stat">
          <span className="marketing-stat-num">{sentCount}</span>
          <span className="marketing-stat-label">emails sent</span>
        </div>
        <div className="marketing-stat">
          <span className="marketing-stat-num">{replies.length}</span>
          <span className="marketing-stat-label">replies</span>
        </div>
        <div className="marketing-stat">
          <span className="marketing-stat-num">{newCount}</span>
          <span className="marketing-stat-label">need review</span>
        </div>
        {stubMode && canManage && (
          <button
            type="button"
            className="btn btn-outline marketing-stat-action"
            onClick={() => setSimulateOpen(true)}
          >
            Simulate a reply
          </button>
        )}
      </div>

      <p className="marketing-tab-intro">
        Every reply to a marketing email lands here — out-of-office, "not
        interested," and genuine bites all mixed together. Open one to read it
        and decide what to do.
      </p>

      {replies.length === 0 ? (
        <EmptyState
          icon={<Icon name="mail" size={32} />}
          title="No replies yet"
          message="When a contact replies to a sequence email, it shows up here for review."
        />
      ) : (
        <div className="marketing-reply-list">
          {replies.map((r) => {
            const seq = seqById.get(r.sequenceId);
            return (
              <button
                key={r.id}
                type="button"
                className={`card marketing-reply-row ${r.status === 'new' ? 'is-new' : ''}`}
                onClick={() => setOpenReplyId(r.id)}
              >
                <div className="marketing-reply-row-top">
                  <span className="marketing-reply-row-name">
                    {contactLabel(contactById.get(r.contactId))}
                  </span>
                  <Badge variant={r.status === 'new' ? 'blue' : 'slate'}>
                    {r.status === 'new' ? 'New' : 'Handled'}
                  </Badge>
                </div>
                <div className="marketing-reply-row-meta">
                  {seq ? seq.name : 'Unknown sequence'} · {timeAgo(r.receivedAt)}
                </div>
                <div className="marketing-reply-row-snippet">
                  {snippet(r.body) || <em>(no message body)</em>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <ReplyDetailModal
        key={openReplyId || 'closed'}
        reply={openReply}
        open={Boolean(openReply)}
        onClose={() => setOpenReplyId(null)}
        state={state}
        dispatch={dispatch}
        toast={toast}
        canManage={canManage}
        navigate={navigate}
        nav={nav}
      />
      <SimulateReplyModal
        key={simulateOpen ? 'sim-open' : 'sim-closed'}
        open={simulateOpen}
        onClose={() => setSimulateOpen(false)}
        state={state}
        dispatch={dispatch}
        toast={toast}
      />
    </>
  );
}

// ─── Reply detail + actions ──────────────────────────────────────────────────
function ReplyDetailModal({ reply, open, onClose, state, dispatch, toast, canManage, navigate, nav }) {
  const contact = reply ? (state.contacts || []).find((c) => c.id === reply.contactId) || null : null;
  const [stagePipelineId, setStagePipelineId] = useState(contact?.pipelineId || '');
  const [stageKey, setStageKey] = useState('');

  // Reply composer state — seeded from the inbound when the modal opens.
  // Operator can edit both fields before sending; the body opens with a
  // GitHub-style quote block so context stays visible to the recipient.
  const [replyDraft, setReplyDraft] = useState({ subject: '', body: '' });
  const [sendingReply, setSendingReply] = useState(false);
  useEffect(() => {
    if (!reply) return;
    setReplyDraft({
      subject: buildReplySubject(reply.subject),
      body: buildQuotedBody(reply, contact),
    });
    // Re-seed only when switching replies — letting the user edit, change
    // their mind, come back, edit more, send. eslint-disable: contact is a
    // derived value that changes only when reply.id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply?.id]);

  if (!open || !reply) return null;

  const sequence = (state.marketingSequences || []).find((s) => s.id === reply.sequenceId) || null;
  const enrollment = reply.enrollmentId
    ? (state.marketingEnrollments || []).find((e) => e.id === reply.enrollmentId) || null
    : null;
  const pipelines = state.pipelines || [];
  const stagePipeline = pipelines.find((p) => p.id === stagePipelineId) || null;
  const stages = stagePipeline ? stagePipeline.stages || [] : [];

  // Sending-inbox lookup — same mailbox that fired the original outbound, so
  // the contact sees the reply land on the thread they already know.
  const sendingInbox = findSendingInbox(state, reply);
  const canReply = canManage
    && !!sendingInbox
    && !!reply.fromEmail
    && Boolean(INBOX_BACKEND_URL || true); // stub-mode allowed — sendViaInbox no-ops

  const responses = Array.isArray(reply.responses) ? reply.responses : [];

  async function sendReply() {
    if (!canReply || sendingReply) return;
    const subjectTrim = replyDraft.subject.trim();
    const bodyTrim = replyDraft.body.trim();
    if (!subjectTrim) { toast.error('Subject is required.'); return; }
    if (!bodyTrim) { toast.error('Reply body is empty.'); return; }
    setSendingReply(true);
    const inboundId = inboundMessageIdForThreading(reply);
    const headers = inboundId
      ? { 'In-Reply-To': `<${inboundId}>`, References: `<${inboundId}>` }
      : undefined;
    const responseRow = {
      id: newId('mrep_resp'),
      sentAt: new Date().toISOString(),
      sentByUserId: state.currentUserId || null,
      fromEmail: sendingInbox.email,
      fromName: sendingInbox.senderName || null,
      subject: subjectTrim,
      body: bodyTrim,
      status: 'pending',
      providerMessageId: null,
      failureReason: null,
    };
    try {
      const res = await sendViaInbox(sendingInbox.id, {
        to: reply.fromEmail,
        fromName: sendingInbox.senderName || undefined,
        subject: subjectTrim,
        body: bodyTrim,
        headers,
      });
      const finalRow = {
        ...responseRow,
        status: 'sent',
        providerMessageId: res?.id || null,
      };
      dispatch({
        type: ACTIONS.UPDATE_MARKETING_REPLY,
        id: reply.id,
        patch: {
          responses: [...responses, finalRow],
          status: 'handled',
        },
      });
      // Reset composer for a fresh follow-up if the operator wants one.
      setReplyDraft({
        subject: buildReplySubject(subjectTrim),
        body: '',
      });
      toast.success('Reply sent');
    } catch (err) {
      toast.error(err?.message || 'Reply failed to send');
    } finally {
      setSendingReply(false);
    }
  }

  function markHandled(next) {
    dispatch({ type: ACTIONS.UPDATE_MARKETING_REPLY, id: reply.id, patch: { status: next } });
    if (next === 'handled') {
      toast.success('Reply marked handled');
      onClose();
    }
  }

  function moveStage() {
    if (!contact || !stagePipelineId || !stageKey) {
      toast.error('Pick a pipeline and stage first.');
      return;
    }
    dispatch({
      type: ACTIONS.SET_CONTACT_STAGE,
      id: contact.id,
      stage: stageKey,
      pipelineId: stagePipelineId,
      authorUserId: state.currentUserId || null,
    });
    toast.success('Contact moved');
  }

  function unenroll() {
    if (!enrollment) return;
    dispatch({ type: ACTIONS.UNENROLL_CONTACT, enrollmentId: enrollment.id });
    toast.success('Contact unenrolled from the sequence');
  }

  function resume() {
    if (!enrollment) return;
    dispatch({ type: ACTIONS.RESUME_ENROLLMENT, enrollmentId: enrollment.id });
    toast.success('Sequence resumed for this contact');
  }

  function openContact() {
    if (!contact) return;
    navigate(`/contacts/${contact.id}`, { state: nav });
  }

  return (
    <Modal open={open} onClose={onClose} title={`Reply from ${contactLabel(contact)}`} size="md">
      <div className="marketing-reply-detail">
        <div className="marketing-reply-context">
          <div><span>From</span> {reply.fromEmail || '—'}</div>
          <div><span>Sequence</span> {sequence ? sequence.name : 'Unknown'}</div>
          <div><span>Received</span> {reply.receivedAt ? new Date(reply.receivedAt).toLocaleString() : '—'}</div>
          <div>
            <span>Sequence status</span>{' '}
            {enrollment
              ? (enrollment.status === 'replied'
                  ? 'Halted by this reply'
                  : enrollment.status.charAt(0).toUpperCase() + enrollment.status.slice(1))
              : '—'}
          </div>
        </div>

        <div className="marketing-reply-subject">{reply.subject || '(no subject)'}</div>
        <div className="marketing-reply-body">
          {reply.body ? reply.body : <em>(no message body)</em>}
        </div>

        {/* History — past responses this operator (or teammates) already sent
            in reply to this thread. Renders above the composer so it reads
            chronologically (inbound → response → response → composer). */}
        {responses.length > 0 && (
          <div className="marketing-reply-history">
            {responses.map((resp) => (
              <div key={resp.id} className="marketing-reply-history-item">
                <div className="marketing-reply-history-meta">
                  <span>
                    <strong>You replied</strong>
                    {' · '}
                    {new Date(resp.sentAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    {resp.status === 'failed' && (
                      <Badge variant="red" style={{ marginLeft: 8 }}>Failed</Badge>
                    )}
                  </span>
                </div>
                <div className="marketing-reply-history-subject">{resp.subject}</div>
                <div className="marketing-reply-history-body">{resp.body}</div>
              </div>
            ))}
          </div>
        )}

        {/* Inline reply composer — sends through the same marketing inbox
            the original outbound used so the contact's email client threads
            it under the existing conversation. */}
        {canManage && (
          <div className="marketing-reply-compose">
            <div className="marketing-reply-compose-head">
              <div className="marketing-reply-compose-head-label">Reply</div>
              <div className="marketing-reply-compose-head-from">
                {sendingInbox
                  ? <>Sending from <strong>{sendingInbox.senderName ? `${sendingInbox.senderName} <${sendingInbox.email}>` : sendingInbox.email}</strong></>
                  : <em>Can&apos;t determine which inbox to reply from — open the contact and use Messaging instead.</em>}
              </div>
            </div>
            {sendingInbox && (
              <>
                <FormField
                  label="Subject"
                  name="reply-subject"
                  value={replyDraft.subject}
                  onChange={(e) => setReplyDraft((d) => ({ ...d, subject: e.target.value }))}
                  disabled={sendingReply}
                />
                <FormField
                  label="Message"
                  name="reply-body"
                  as="textarea"
                  rows={8}
                  value={replyDraft.body}
                  onChange={(e) => setReplyDraft((d) => ({ ...d, body: e.target.value }))}
                  disabled={sendingReply}
                  help={inboundMessageIdForThreading(reply)
                    ? 'Sends with In-Reply-To headers so it threads under the original conversation in their inbox.'
                    : 'Threading headers unavailable for this inbound — the reply will arrive as a new thread.'}
                />
                <div className="marketing-reply-compose-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={sendReply}
                    disabled={!canReply || sendingReply || !replyDraft.subject.trim() || !replyDraft.body.trim()}
                  >
                    {sendingReply ? 'Sending…' : 'Send reply'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {canManage && (
          <>
            <div className="form-row marketing-reply-move">
              <FormField
                label="Move to pipeline"
                name="reply-move-pipeline"
                as="select"
                value={stagePipelineId}
                onChange={(e) => { setStagePipelineId(e.target.value); setStageKey(''); }}
                placeholder="Select a pipeline…"
                options={pipelines.map((p) => ({ value: p.id, label: p.label }))}
              />
              <FormField
                label="Stage"
                name="reply-move-stage"
                as="select"
                value={stageKey}
                onChange={(e) => setStageKey(e.target.value)}
                placeholder={stagePipeline ? 'Select a stage…' : 'Pick a pipeline first'}
                options={stages.map((st) => ({ value: st.key, label: st.label }))}
                disabled={!stagePipeline}
              />
            </div>
            <div className="marketing-reply-actions">
              <button type="button" className="btn btn-outline" onClick={moveStage} disabled={!contact}>
                Move stage
              </button>
              {enrollment && enrollment.status === 'replied' && (
                <button type="button" className="btn btn-outline" onClick={resume}>
                  Resume in sequence
                </button>
              )}
              {enrollment && enrollment.status !== 'unenrolled' && (
                <button type="button" className="btn btn-outline" onClick={unenroll}>
                  Unenroll
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="modal-actions marketing-reply-footer">
        <button type="button" className="btn btn-outline" onClick={openContact} disabled={!contact}>
          Open contact
        </button>
        {reply.status === 'new' ? (
          <button type="button" className="btn btn-primary" onClick={() => markHandled('handled')}>
            Mark handled
          </button>
        ) : (
          <button type="button" className="btn btn-outline" onClick={() => markHandled('new')}>
            Reopen
          </button>
        )}
      </div>
    </Modal>
  );
}

// ─── Dev-only: inject a simulated reply (stub mode has no live inbound) ───────
function SimulateReplyModal({ open, onClose, state, dispatch, toast }) {
  const [enrollmentId, setEnrollmentId] = useState('');
  const [body, setBody] = useState('');

  if (!open) return null;

  const enrollments = (state.marketingEnrollments || []).filter((e) => e.status !== 'unenrolled');
  const contacts = state.contacts || [];
  const sequences = state.marketingSequences || [];
  const options = enrollments.map((e) => {
    const c = contacts.find((x) => x.id === e.contactId);
    const s = sequences.find((x) => x.id === e.sequenceId);
    return { value: e.id, label: `${contactLabel(c)} — ${s ? s.name : 'sequence'}` };
  });

  function fire() {
    const enr = enrollments.find((e) => e.id === enrollmentId);
    if (!enr) {
      toast.error('Pick an enrolled contact first.');
      return;
    }
    const c = contacts.find((x) => x.id === enr.contactId);
    dispatch({
      type: ACTIONS.RECEIVE_MARKETING_REPLY,
      enrollmentId: enr.id,
      fromEmail: c?.email || null,
      subject: 'Re: (simulated reply)',
      body: body.trim() || 'This is a simulated reply for testing.',
    });
    toast.success('Simulated reply added to the inbox');
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Simulate a reply" size="sm">
      <p className="marketing-connect-copy">
        Dev helper — with no email backend wired, live replies never arrive.
        This injects a reply against a real enrollment so you can exercise the
        Replies inbox, halt-on-reply, and reply-routing.
      </p>
      {options.length === 0 ? (
        <div className="callout callout-info">
          Enroll a contact in a sequence first — there's nothing to reply to yet.
        </div>
      ) : (
        <>
          <FormField
            label="Replying contact"
            name="sim-enrollment"
            as="select"
            value={enrollmentId}
            onChange={(e) => setEnrollmentId(e.target.value)}
            placeholder="Select an enrolled contact…"
            options={options}
          />
          <FormField
            label="Reply message"
            name="sim-body"
            as="textarea"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Not interested, please remove me."
          />
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={fire}
          disabled={options.length === 0 || !enrollmentId}
        >
          Simulate reply
        </button>
      </div>
    </Modal>
  );
}
