// Sequence editor panel — the full edit surface for one marketing sequence,
// rendered inline inside an expanded SequencesTab accordion row (no popout).
// Sections: Header (name / status / plain-text / stage-exit), Reply
// handling (halt + routing + tags), Leads (auto: deal-stage
// sources; manual: contact picker), and Steps
// (reorderable list → StepEditorModal). Dispatches granular reducer actions
// directly — no whole-sequence draft.
//
// All hooks run unconditionally before the `!seq` early return so the hook
// order is stable. The panel is mounted only while its row is expanded;
// collapsing the row unmounts it (transient field state resets — the
// persistent data lives in the store).

import { useState, useMemo, Fragment } from 'react';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectMarketingSequenceById,
  selectStepsForSequence,
  selectEnrollmentsForSequence,
  selectPipelines,
  selectContacts,
  selectMarketingSettings,
  selectActiveUsers,
  selectEnrollmentStepBuckets,
  selectSequenceDiagnostics,
} from '../../store/selectors';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import Toggle from '../../components/Toggle';
import Icon from '../../components/Icon';
import Avatar from '../../components/Avatar';
import ConfirmDialog from '../../components/ConfirmDialog';
import TagPicker from '../../components/TagPicker';
import StepEditorModal from './StepEditorModal';
import StepEnrollmentsModal from './StepEnrollmentsModal';
import SequenceContactsModal from './SequenceContactsModal';
import { deleteMarketingAttachment } from '../../lib/attachments';
import { formatStepDelay, stripHtml, humanizeFailure, contactIdsAtSourceStages } from '../../lib/marketingScheduler';
import { clearInFlight } from '../../lib/marketingInFlight';

function fmtHour(h) {
  const hr = ((h % 12) || 12);
  return `${hr}${h < 12 ? 'am' : 'pm'}`;
}

export default function SequenceEditorPanel({ sequenceId, onCollapse }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const seq = sequenceId ? selectMarketingSequenceById(state, sequenceId) : null;

  const steps = useMemo(
    () => (sequenceId ? selectStepsForSequence(state, sequenceId) : []),
    [state, sequenceId]
  );
  const enrollments = useMemo(
    () => (sequenceId ? selectEnrollmentsForSequence(state, sequenceId) : []),
    [state, sequenceId]
  );
  // Per-step "who's here now" counts for the flow cards (active waiting per
  // step) + replied/completed tallies.
  const stepBuckets = useMemo(
    () => selectEnrollmentStepBuckets(state, sequenceId, steps.length),
    [state, sequenceId, steps.length]
  );
  // Delivery diagnostics: failed sends + systemic stalls (e.g. no sending inbox).
  const diagnostics = useMemo(
    () => selectSequenceDiagnostics(state, sequenceId),
    [state, sequenceId]
  );
  const pipelines = selectPipelines(state);
  // Deals live on the Master Pipeline (the one sales board); sources and reply
  // routing target its stages.
  const masterPipeline = pipelines.find((p) => p.isMaster) || null;
  const masterId = masterPipeline?.id || null;
  const masterStages = masterPipeline?.stages || [];
  const contacts = selectContacts(state);
  const settings = selectMarketingSettings(state);
  const users = selectActiveUsers(state);

  const [nameDraft, setNameDraft] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [stepModal, setStepModal] = useState(null); // { step|null, index }
  const [stepEnroll, setStepEnroll] = useState(null); // null | { bucket, title }
  const [confirmDeleteStep, setConfirmDeleteStep] = useState(null);
  const [srcStage, setSrcStage] = useState('');
  const [bulkEnroll, setBulkEnroll] = useState(null); // null | { tab: 'add' | 'enrolled' }

  // UI-only "intent to enable" flags for the two On-reply actions that have
  // no explicit boolean field on the sequence — Apply tags is gated by
  // `replyTags.length > 0` and Notify is gated by `notifyOnReplyUserId`. The
  // toggles flip these flags so the user can open an empty picker before any
  // value is set; turning the toggle off clears the underlying data. We
  // seed initial state from the data so an already-configured sequence opens
  // in the "on" position.
  const [tagsExpanded, setTagsExpanded] = useState(
    Array.isArray(seq?.replyTags) && seq.replyTags.length > 0
  );
  const [notifyExpanded, setNotifyExpanded] = useState(
    typeof seq?.notifyOnReplyUserId === 'string' && seq.notifyOnReplyUserId.length > 0
  );

  // Leads: auto sources (kept as a memo so the count memo's deps are stable).
  const sources = useMemo(
    () => (Array.isArray(seq?.enrollmentSources) ? seq.enrollmentSources : []),
    [seq]
  );

  // Count of contacts currently matching the auto sources — the primary contact
  // of every open deal at a source stage (with an email to send to).
  const autoMatchCount = useMemo(() => {
    if (!seq || seq.audienceMode !== 'auto') return 0;
    const matchers = sources.filter((s) => s && s.kind === 'pipelineStage' && s.pipelineId && s.stageKey);
    const ids = contactIdsAtSourceStages(state, matchers);
    return contacts.filter((c) => c.email && ids.has(c.id)).length;
  }, [contacts, sources, seq, state]);

  // ----- Early return AFTER every hook -----
  if (!seq) return null;

  const nameValue = nameFocused ? nameDraft : seq.name;

  function patchSeq(patch) {
    dispatch({ type: ACTIONS.UPDATE_MARKETING_SEQUENCE, id: seq.id, patch });
  }

  // Diagnostics "Retry": clear the in-flight guard + drop the failed send so the
  // scheduler re-attempts it on its next tick — reusing the real send path.
  function retrySend(sd) {
    clearInFlight(`${sd.enrollmentId}::${sd.stepId}`);
    dispatch({ type: ACTIONS.RETRY_MARKETING_SEND, id: sd.id });
    const c = contacts.find((x) => x.id === sd.contactId);
    const who = c ? (`${c.firstName} ${c.lastName}`.trim() || c.email) : (sd.toEmail || 'contact');
    toast.success(`Retrying ${who}…`);
  }
  function retryAllFailed() {
    if (diagnostics.failed.length === 0) return;
    diagnostics.failed.forEach((sd) => {
      clearInFlight(`${sd.enrollmentId}::${sd.stepId}`);
      dispatch({ type: ACTIONS.RETRY_MARKETING_SEND, id: sd.id });
    });
    toast.success(`Retrying ${diagnostics.failed.length} failed send${diagnostics.failed.length === 1 ? '' : 's'}…`);
  }

  function commitName() {
    const trimmed = nameDraft.trim();
    setNameFocused(false);
    if (trimmed && trimmed !== seq.name) patchSeq({ name: trimmed });
  }

  // Edits autosave via granular dispatches as you type — Save just confirms
  // with a toast and collapses the row.
  function handleSave() {
    toast.success(`Sequence "${seq.name}" saved`);
    onCollapse?.();
  }

  // ----- On reply -----
  // `rr.enabled` is the explicit user-controlled gate for pipeline routing.
  // The reducer's RECEIVE_MARKETING_REPLY check is three-way (enabled +
  // pipelineId + stageKey) so partial config never fires; we just don't
  // hide the pickers anymore — the toggle on the row controls visibility.
  const rr = seq.replyRouting || {};
  function patchReplyRouting(patch) {
    patchSeq({ replyRouting: { ...(seq.replyRouting || {}), ...patch } });
  }
  function setMoveEnabled(on) {
    if (on) {
      patchReplyRouting({ enabled: true });
    } else {
      // Off → clear the picked target so re-enabling shows empty pickers
      // and the live flow graphic immediately reflects "Stays in Replies
      // inbox". The fields persist between sessions if they leave them
      // empty (they're just null), so nothing to grandfather.
      patchReplyRouting({ enabled: false, pipelineId: null, stageKey: null });
    }
  }
  const rrStages = masterStages;
  const rrStage = rr.stageKey
    ? masterStages.find((st) => st.key === rr.stageKey) || null
    : null;

  function setTagsEnabled(on) {
    setTagsExpanded(on);
    // Off → drop any previously-picked tags so the data matches the UI.
    if (!on && (seq.replyTags || []).length > 0) patchSeq({ replyTags: [] });
  }
  function setNotifyEnabled(on) {
    setNotifyExpanded(on);
    // Off → clear the picked user + channels.
    if (!on) patchNotify({ notifyOnReplyUserId: null });
  }

  // ----- Notify on reply -----
  // Operator-picked team user gets a bell-inbox row when a contact replies to
  // this sequence. Email channel intentionally absent for v1 (Resend path +
  // domain DNS still pending — see HANDOFF backlog).
  const notifyUserId = seq.notifyOnReplyUserId || null;
  const notifyInApp = seq.notifyOnReplyChannels?.inApp === true;
  function patchNotify(patch) {
    const nextChannels = {
      ...(seq.notifyOnReplyChannels || { inApp: false }),
      ...(patch.notifyOnReplyChannels || {}),
    };
    const seqPatch = { notifyOnReplyChannels: nextChannels };
    if (Object.prototype.hasOwnProperty.call(patch, 'notifyOnReplyUserId')) {
      seqPatch.notifyOnReplyUserId = patch.notifyOnReplyUserId || null;
      // Clearing the user implicitly clears the channel toggles so the editor
      // doesn't show "In-app" on for a user that isn't picked anymore.
      if (!patch.notifyOnReplyUserId) {
        seqPatch.notifyOnReplyChannels = { inApp: false };
      }
    }
    patchSeq(seqPatch);
  }

  // ----- Leads: auto sources (Master Pipeline deal stages) -----
  const srcStages = masterStages;

  function addSource() {
    if (!masterId || !srcStage) return;
    const exists = sources.some((s) => s.pipelineId === masterId && s.stageKey === srcStage);
    if (exists) {
      toast.error('That deal stage is already added.');
      return;
    }
    patchSeq({
      enrollmentSources: [...sources, { kind: 'pipelineStage', pipelineId: masterId, stageKey: srcStage }],
    });
    setSrcStage('');
  }

  function removeSource(src) {
    patchSeq({
      enrollmentSources: sources.filter(
        (s) => !(s.pipelineId === src.pipelineId && s.stageKey === src.stageKey)
      ),
    });
  }

  function describeSource(src) {
    const st = masterStages.find((x) => x.key === src.stageKey) || null;
    return st ? st.label : src.stageKey;
  }

  // ----- Leads: manual enrollment -----
  const enrolledContactIds = new Set(
    enrollments.filter((e) => e.status !== 'unenrolled').map((e) => e.contactId)
  );
  const enrolledContacts = contacts.filter((c) => enrolledContactIds.has(c.id));
  const enrolledPreview = enrolledContacts.slice(0, 6);
  const enrolledExtra = enrolledContacts.length - enrolledPreview.length;

  // ----- Steps -----
  function moveStep(step, dir) {
    const ids = steps.map((s) => s.id);
    const idx = ids.indexOf(step.id);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    dispatch({ type: ACTIONS.REORDER_MARKETING_STEPS, sequenceId: seq.id, ids });
  }
  function deleteStep(step) {
    dispatch({ type: ACTIONS.DELETE_MARKETING_STEP, sequenceId: seq.id, stepId: step.id });
    // Drop the step's attachment blobs from IndexedDB — fire-and-forget.
    (step.attachments || []).forEach((att) => { deleteMarketingAttachment(att.id); });
  }

  const statusOptions = [
    { value: 'draft', label: 'Draft. Not sending' },
    { value: 'active', label: 'Active. Sending' },
    { value: 'paused', label: 'Paused. Temporarily stopped' },
  ];

  return (
    <>
      <div className="marketing-editor">
        {/* ---------- Header ---------- */}
        <section className="marketing-editor-section">
          <FormField
            label="Sequence name"
            name="seq-edit-name"
            value={nameValue}
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={() => { setNameDraft(seq.name); setNameFocused(true); }}
            onBlur={commitName}
            required
          />
          <div className="form-row">
            <FormField
              label="Status"
              name="seq-edit-status"
              as="select"
              value={seq.status}
              onChange={(e) => patchSeq({ status: e.target.value })}
              options={statusOptions}
              help={seq.status === 'active' && steps.length === 0
                ? 'This sequence is active but has no steps. Nothing will send.'
                : undefined}
            />
          </div>
          <div className="pref-row">
            <div className="pref-row-text">
              <div className="pref-row-label">Send all plain-text</div>
              <div className="pref-row-desc">Strip HTML from every step body before sending.</div>
            </div>
            <Toggle on={seq.plainText === true} onChange={(v) => patchSeq({ plainText: v })} />
          </div>
          {seq.audienceMode === 'auto' && (
            <div className="pref-row">
              <div className="pref-row-text">
                <div className="pref-row-label">If a contact leaves the source stage</div>
                <div className="pref-row-desc">
                  {seq.onStageExit === 'unenroll'
                    ? 'Auto-unenroll. Remaining steps are cancelled.'
                    : 'Keep running. Remaining steps still send.'}
                </div>
              </div>
              <Toggle
                on={seq.onStageExit === 'unenroll'}
                onChange={(v) => patchSeq({ onStageExit: v ? 'unenroll' : 'continue' })}
              />
            </div>
          )}
        </section>

        {/* ---------- On reply ---------- */}
        <section className="marketing-editor-section">
          <div className="section-head"><h3>On reply</h3></div>

          {/* Light flow graphic — at-a-glance live preview: where leads come
              in, what they go through, and where they end up after replying.
              Updates as the operator flips the toggles + pickers below. */}
          <div className="marketing-reply-flow" aria-label="Sequence flow overview">
            <div className="marketing-reply-flow-node">
              <div className="marketing-reply-flow-node-icon" aria-hidden="true">
                <Icon name="user" size={16} />
              </div>
              <div className="marketing-reply-flow-node-label">Leads come in from</div>
              <div className="marketing-reply-flow-node-value">
                {seq.audienceMode === 'manual'
                  ? (enrolledContactIds.size > 0
                      ? `${enrolledContactIds.size} manually added`
                      : 'Manual enrollment')
                  : (sources.length === 0
                      ? <span className="marketing-reply-flow-node-empty">No source picked</span>
                      : (
                          <>
                            {describeSource(sources[0])}
                            {sources.length > 1 && (
                              <span className="marketing-reply-flow-node-more"> +{sources.length - 1} more</span>
                            )}
                          </>
                        ))}
              </div>
            </div>
            <div className="marketing-reply-flow-arrow" aria-hidden="true">
              <Icon name="chevronRight" size={14} />
            </div>
            <div className="marketing-reply-flow-node">
              <div className="marketing-reply-flow-node-icon" aria-hidden="true">
                <Icon name="mail" size={16} />
              </div>
              <div className="marketing-reply-flow-node-label">Sequence</div>
              <div className="marketing-reply-flow-node-value">
                {steps.length === 0
                  ? <span className="marketing-reply-flow-node-empty">No steps yet</span>
                  : `${steps.length} email${steps.length === 1 ? '' : 's'}`}
              </div>
            </div>
            <div className="marketing-reply-flow-arrow" aria-hidden="true">
              <Icon name="chevronRight" size={14} />
            </div>
            <div className="marketing-reply-flow-node">
              <div className="marketing-reply-flow-node-icon" aria-hidden="true">
                <Icon name="tag" size={16} />
              </div>
              <div className="marketing-reply-flow-node-label">On reply, the deal advances to</div>
              <div className="marketing-reply-flow-node-value">
                {rr.enabled && rrStage
                  ? rrStage.label
                  : <span className="marketing-reply-flow-node-empty">Stays in Replies inbox</span>}
              </div>
            </div>
          </div>

          <p className="marketing-editor-hint">
            Decide what happens the moment a contact replies. Every reply also
            lands in the <strong>Replies</strong> inbox regardless of these
            settings. These only control what else fires.
          </p>

          {/* 1. Stop sending more emails (haltOnReply) */}
          <div className="pref-row">
            <div className="pref-row-text">
              <div className="pref-row-label">Stop sending more emails</div>
              <div className="pref-row-desc">
                Pauses the drip for any contact who replies. Turn off to keep
                their scheduled steps firing.
              </div>
            </div>
            <Toggle on={seq.haltOnReply !== false} onChange={(v) => patchSeq({ haltOnReply: v })} />
          </div>

          {/* 2. Advance the deal on reply */}
          <div className="pref-row">
            <div className="pref-row-text">
              <div className="pref-row-label">Advance the deal on reply</div>
              <div className="pref-row-desc">
                Moves the contact's company deal to a stage you pick. Useful for
                parking replies on a "follow up" lane.
              </div>
            </div>
            <Toggle on={rr.enabled === true} onChange={setMoveEnabled} />
          </div>
          {rr.enabled && (
            <div className="form-row marketing-settings-routing marketing-onreply-detail">
              <FormField
                label="Advance the deal to stage"
                name="seq-rr-stage"
                as="select"
                value={rr.stageKey || ''}
                onChange={(e) => patchReplyRouting({ pipelineId: masterId, stageKey: e.target.value })}
                placeholder="Select a stage…"
                options={rrStages.map((st) => ({ value: st.key, label: st.label }))}
              />
            </div>
          )}

          {/* 3. Apply tags to the contact */}
          <div className="pref-row">
            <div className="pref-row-text">
              <div className="pref-row-label">Apply tags to the contact</div>
              <div className="pref-row-desc">
                Adds the picked tags to the contact's profile so you can filter
                on them later (e.g. <em>Replied · Interested</em>).
              </div>
            </div>
            <Toggle on={tagsExpanded} onChange={setTagsEnabled} />
          </div>
          {tagsExpanded && (
            <div className="marketing-onreply-detail">
              <TagPicker
                value={seq.replyTags || []}
                onChange={(ids) => patchSeq({ replyTags: ids })}
                placeholder="Pick tags…"
              />
            </div>
          )}

          {/* 4. Notify a teammate */}
          <div className="pref-row">
            <div className="pref-row-text">
              <div className="pref-row-label">Notify a teammate</div>
              <div className="pref-row-desc">
                Pings the picked team member with a bell-inbox row + tab-title
                badge so a real human picks the thread up fast.
              </div>
            </div>
            <Toggle on={notifyExpanded} onChange={setNotifyEnabled} />
          </div>
          {notifyExpanded && (
            <div className="marketing-onreply-detail">
              <FormField
                label="Who to ping"
                name="seq-notify-user"
                as="select"
                value={notifyUserId || ''}
                onChange={(e) => patchNotify({ notifyOnReplyUserId: e.target.value })}
                placeholder="Pick a teammate…"
                options={users.map((u) => ({ value: u.id, label: u.name }))}
              />
              {notifyUserId && (() => {
                const u = users.find((u) => u.id === notifyUserId);
                const possessive = u?.name ? `${u.name}'s` : 'their';
                return (
                  <div className="pref-row marketing-onreply-subrow">
                    <div className="pref-row-text">
                      <div className="pref-row-label">In-app notification</div>
                      <div className="pref-row-desc">
                        Adds a row to {possessive} bell inbox and updates their tab title.
                      </div>
                    </div>
                    <Toggle
                      on={notifyInApp}
                      onChange={(v) => patchNotify({ notifyOnReplyChannels: { inApp: v } })}
                    />
                  </div>
                );
              })()}
            </div>
          )}
        </section>

        {/* ---------- Leads ---------- */}
        <section className="marketing-editor-section">
          <div className="section-head"><h3>Leads</h3></div>
          <FormField
            label="Lead source"
            name="seq-audience-mode"
            as="select"
            value={seq.audienceMode || 'auto'}
            onChange={(e) => patchSeq({ audienceMode: e.target.value })}
            options={[
              { value: 'auto', label: 'Auto. Pull from a deal stage' },
              { value: 'manual', label: 'Manual. Pick contacts yourself' },
            ]}
            help="Switching keeps everyone already enrolled. It only changes how new contacts join."
          />
          {seq.audienceMode === 'auto' ? (
            <>
              <p className="marketing-editor-hint">
                The primary contact of every company with an open deal at any of these
                stages auto-enrolls into the queue right away. Including while this
                sequence is in Draft, so you can see exactly who&apos;s lined up before
                launching. Sends only fire once you click <strong>Start</strong>.
                {sources.length > 0 && ` ${autoMatchCount} currently match · ${enrolledContactIds.size} enrolled.`}
              </p>
              {sources.length > 0 && (
                <div className="marketing-source-chips">
                  {sources.map((src) => (
                    <span key={`${src.pipelineId}:${src.stageKey}`} className="marketing-source-chip">
                      <span>{describeSource(src)}</span>
                      <button type="button" className="chip-remove" aria-label="Remove source" onClick={() => removeSource(src)}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="form-row marketing-source-add">
                <FormField
                  label="Deal stage"
                  name="src-stage"
                  as="select"
                  value={srcStage}
                  onChange={(e) => setSrcStage(e.target.value)}
                  placeholder="Select a stage…"
                  options={srcStages.map((st) => ({ value: st.key, label: st.label }))}
                />
                <div className="marketing-source-add-btn">
                  <button type="button" className="btn btn-secondary" onClick={addSource} disabled={!srcStage}>
                    Add source
                  </button>
                </div>
              </div>

              {/* Same Enrolled roster + buttons the manual branch has —
                  auto-mode sequences also accept on-demand manual adds, and
                  operators need to see who's actually in the queue. */}
              {enrolledPreview.length > 0 && (
                <div className="marketing-enroll-stack" style={{ marginTop: 14 }}>
                  {enrolledPreview.map((c) => (
                    <Avatar
                      key={c.id}
                      initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`}
                      variant={(c.id.length % 5) + 1}
                      size="sm"
                    />
                  ))}
                  {enrolledExtra > 0 && (
                    <span className="marketing-enroll-stack-more">+{enrolledExtra}</span>
                  )}
                </div>
              )}
              <div className="marketing-enroll-actions">
                {enrolledContactIds.size > 0 && (
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={() => setBulkEnroll({ tab: 'enrolled' })}
                  >
                    Manage enrolled
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setBulkEnroll({ tab: 'add' })}
                >
                  Add contacts
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="marketing-editor-hint">
                {enrolledContactIds.size === 0
                  ? 'No contacts enrolled yet. Add contacts in bulk to start the drip.'
                  : `${enrolledContactIds.size} contact${enrolledContactIds.size === 1 ? '' : 's'} enrolled in this sequence.`}
              </p>
              {enrolledPreview.length > 0 && (
                <div className="marketing-enroll-stack">
                  {enrolledPreview.map((c) => (
                    <Avatar
                      key={c.id}
                      initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`}
                      variant={(c.id.length % 5) + 1}
                      size="sm"
                    />
                  ))}
                  {enrolledExtra > 0 && (
                    <span className="marketing-enroll-stack-more">+{enrolledExtra}</span>
                  )}
                </div>
              )}
              <div className="marketing-enroll-actions">
                {enrolledContactIds.size > 0 && (
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={() => setBulkEnroll({ tab: 'enrolled' })}
                  >
                    Manage enrolled
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setBulkEnroll({ tab: 'add' })}
                >
                  Add contacts
                </button>
              </div>
            </>
          )}
        </section>

        {/* ---------- Steps ---------- */}
        <section className="marketing-editor-section">
          <div className="section-head"><h3>Steps</h3></div>
          <p className="marketing-editor-hint">
            Each box is one email. Click a box to edit it; the connector
            between boxes shows how long the sequence waits before the next send.
          </p>
          <div className="marketing-flow">
            {steps.map((step, idx) => {
              const bodyPreview = stripHtml(step.body || '');
              return (
              <Fragment key={step.id}>
                {idx > 0 && (
                  <button
                    type="button"
                    className="marketing-flow-wait"
                    onClick={() => setStepModal({ step, index: idx })}
                    title="Edit the wait + this email"
                  >
                    <span className="marketing-flow-wait-chip">
                      <Icon name="schedule" size={12} />
                      {formatStepDelay(step)}
                    </span>
                  </button>
                )}
                <div
                  className={`marketing-flow-card ${step.subject ? '' : 'is-empty'}`}
                  onClick={() => setStepModal({ step, index: idx })}
                >
                  <div className="marketing-flow-card-head">
                    <div className="marketing-flow-card-headleft">
                      <span className="marketing-flow-card-num">Email {idx + 1}</span>
                      <button
                        type="button"
                        className={`marketing-flow-card-count ${(stepBuckets.perStep[idx] || 0) === 0 ? 'is-zero' : ''}`}
                        title={`${stepBuckets.perStep[idx] || 0} contact${(stepBuckets.perStep[idx] || 0) === 1 ? '' : 's'} waiting at this step. Click to view`}
                        onClick={(e) => { e.stopPropagation(); setStepEnroll({ bucket: idx, title: `Email ${idx + 1} · waiting here` }); }}
                      >
                        <Icon name="user" size={11} />
                        {stepBuckets.perStep[idx] || 0}
                      </button>
                    </div>
                    <div className="marketing-flow-card-tools">
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label="Move earlier"
                        disabled={idx === 0}
                        onClick={(e) => { e.stopPropagation(); moveStep(step, -1); }}
                      >
                        <Icon name="chevronLeft" size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label="Move later"
                        disabled={idx === steps.length - 1}
                        onClick={(e) => { e.stopPropagation(); moveStep(step, 1); }}
                      >
                        <Icon name="chevronRight" size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon btn-icon-danger"
                        aria-label="Delete email"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteStep({ step, index: idx }); }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="marketing-flow-card-body">
                    <span className="marketing-flow-card-label">Subject</span>
                    <div className="marketing-flow-card-subject">
                      {step.subject || 'Empty email. Click to edit'}
                    </div>
                    {bodyPreview && (
                      <div className="marketing-flow-card-preview">{bodyPreview}</div>
                    )}
                  </div>
                  <div className="marketing-flow-card-foot">
                    <span className="marketing-flow-card-window">
                      <Icon name="schedule" size={12} />
                      {fmtHour(step.sendHourStart ?? 9)}–{fmtHour(step.sendHourEnd ?? 17)}
                    </span>
                    <span className="marketing-flow-card-foot-meta">
                      {idx === 0 && (
                        <span className="marketing-flow-card-when">On enrollment</span>
                      )}
                      {(step.attachments?.length > 0) && (
                        <span
                          className="marketing-flow-card-attach"
                          title={`${step.attachments.length} attachment${step.attachments.length === 1 ? '' : 's'}`}
                        >
                          <Icon name="paperclip" size={11} />
                          {step.attachments.length}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </Fragment>
              );
            })}
            {steps.length > 0 && <div className="marketing-flow-join" aria-hidden="true" />}
            <button
              type="button"
              className="add-tile marketing-flow-add"
              onClick={() => setStepModal({ step: null, index: steps.length })}
            >
              <span>{steps.length === 0 ? 'Add the first email' : 'Add email'}</span>
            </button>
          </div>
          {(stepBuckets.replied > 0 || stepBuckets.completed > 0) && (
            <div className="marketing-flow-tallies">
              {stepBuckets.replied > 0 && (
                <button
                  type="button"
                  className="chip chip-sm"
                  onClick={() => setStepEnroll({ bucket: 'replied', title: 'Replied. Sequence paused' })}
                >
                  {stepBuckets.replied} replied
                </button>
              )}
              {stepBuckets.completed > 0 && (
                <button
                  type="button"
                  className="chip chip-sm"
                  onClick={() => setStepEnroll({ bucket: 'completed', title: 'Completed the sequence' })}
                >
                  {stepBuckets.completed} completed
                </button>
              )}
            </div>
          )}
        </section>

        <section className="marketing-editor-section">
          <div className="section-head"><h3>Diagnostics</h3></div>
          <p className="marketing-editor-hint">
            Delivery issues for this sequence. What failed and why, plus a way to
            re-send once the cause is fixed.
          </p>
          {diagnostics.failedCount === 0 && !diagnostics.noActiveInbox ? (
            <div className="marketing-diag-ok">No delivery issues. Every send has gone through.</div>
          ) : (
            <div className="marketing-diag">
              {diagnostics.noActiveInbox && (
                <div className="marketing-diag-warn">
                  <div className="marketing-diag-warn-title">No connected sending inbox</div>
                  <div className="marketing-diag-warn-hint">
                    {diagnostics.waitingCount} contact{diagnostics.waitingCount === 1 ? '' : 's'} waiting. Connect a sending inbox under Marketing → Inboxes to resume sending.
                  </div>
                </div>
              )}
              {diagnostics.failedCount > 0 && (
                <>
                  <div className="marketing-diag-bar">
                    <span className="marketing-diag-bar-count">
                      {diagnostics.failedCount} failed send{diagnostics.failedCount === 1 ? '' : 's'}
                    </span>
                    <button type="button" className="btn btn-outline" onClick={retryAllFailed}>Retry all</button>
                  </div>
                  <ul className="marketing-diag-list">
                    {diagnostics.failed.map((sd) => {
                      const c = contacts.find((x) => x.id === sd.contactId);
                      const stepIdx = steps.findIndex((st) => st.id === sd.stepId);
                      const reason = humanizeFailure(sd.failureReason);
                      const who = c ? (`${c.firstName} ${c.lastName}`.trim() || c.email) : (sd.toEmail || 'Unknown contact');
                      return (
                        <li key={sd.id} className="marketing-diag-item">
                          <div className="marketing-diag-item-body">
                            <div className="marketing-diag-item-top">
                              <span className="marketing-diag-who">{who}</span>
                              {stepIdx >= 0 && <span className="marketing-diag-step">Email {stepIdx + 1}</span>}
                              <span className="marketing-diag-reason">{reason.label}</span>
                            </div>
                            <div className="marketing-diag-hint">{reason.hint}</div>
                          </div>
                          <button type="button" className="btn btn-outline" onClick={() => retrySend(sd)}>Retry</button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="marketing-editor-foot">
        <button type="button" className="btn btn-primary" onClick={handleSave}>Save</button>
      </div>

      {stepModal && (
        <StepEditorModal
          open
          sequenceId={seq.id}
          step={stepModal.step}
          stepIndex={stepModal.index}
          defaultWindow={settings.defaultSendWindow}
          onClose={() => setStepModal(null)}
        />
      )}
      {stepEnroll && (
        <StepEnrollmentsModal
          sequenceId={seq.id}
          bucket={stepEnroll.bucket}
          stepCount={steps.length}
          title={stepEnroll.title}
          onClose={() => setStepEnroll(null)}
        />
      )}
      {bulkEnroll && (
        <SequenceContactsModal
          sequenceId={seq.id}
          initialTab={bulkEnroll.tab}
          onClose={() => setBulkEnroll(null)}
        />
      )}
      <ConfirmDialog
        open={Boolean(confirmDeleteStep)}
        title="Delete step?"
        message={confirmDeleteStep
          ? `Step ${confirmDeleteStep.index + 1} ("${confirmDeleteStep.step.subject || 'no subject'}") will be removed from this sequence.`
          : ''}
        confirmLabel="Delete step"
        variant="danger"
        onConfirm={() => confirmDeleteStep && deleteStep(confirmDeleteStep.step)}
        onClose={() => setConfirmDeleteStep(null)}
      />
    </>
  );
}
