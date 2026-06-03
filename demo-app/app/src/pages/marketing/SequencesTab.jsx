// Sequences tab — paginated accordion of marketing sequences. Each row is a
// collapsible disclosure: the summary header (name / status / stats / actions)
// is always visible; clicking it expands the row in place to reveal the full
// editor (SequenceEditorPanel) inline — no popout. One row open at a time.
// The list is paginated 10 per page. Empty state with a "Create your first
// sequence" CTA. Per-row Start / Pause / Resume + a Delete that confirms.
//
// The list + pagination are wrapped in .marketing-seq-tab so they group as a
// single .settings-content child (that layout forces flex-column on its direct
// children — keeping the pagination out of that reach keeps it a normal row).

import { useState } from 'react';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectMarketingSequences,
  selectSequenceStats,
  selectPipelines,
} from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import Modal from '../../components/Modal';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import SequenceEditorPanel from './SequenceEditorPanel';
import SequenceContactsModal from './SequenceContactsModal';
import { deleteMarketingAttachment } from '../../lib/attachments';

const STATUS_VARIANTS = {
  draft: 'slate',
  active: 'green',
  paused: 'amber',
  archived: 'slate',
};

const PAGE_SIZE = 10;

function statusLabel(s) {
  if (!s) return 'Draft';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function SequencesTab({ createOpen, onOpenCreate, onCloseCreate }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canManage = usePermission('marketing.manage');
  const sequences = selectMarketingSequences(state);
  const [expandedId, setExpandedId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [page, setPage] = useState(0);
  // Lifted modal state — opened by clicking the "X enrolled" stat directly
  // on a row, drilling straight into the contacts roster without first
  // expanding the editor. { sequenceId, initialTab } | null
  const [contactsModal, setContactsModal] = useState(null);

  // Paginate — clamp the page so a shrinking list never strands the view.
  const totalPages = Math.max(1, Math.ceil(sequences.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageSequences = sequences.slice(pageStart, pageStart + PAGE_SIZE);

  function handleCreate({ name, audienceMode, sourcePipelineId, sourceStageKey }) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const id = `mseq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    // Seed the source pair at create time so the operator doesn't have to
    // re-pick inside the editor. They can add MORE sources (or remove this
    // one) in the editor's Leads section later. onStageExit is left at the
    // 'continue' default — the editor's toggle is the canonical place to
    // change it whenever they want, regardless of when the sequence was
    // created.
    const enrollmentSources = (
      audienceMode === 'auto' && sourcePipelineId && sourceStageKey
        ? [{ kind: 'pipelineStage', pipelineId: sourcePipelineId, stageKey: sourceStageKey }]
        : []
    );
    dispatch({
      type: ACTIONS.ADD_MARKETING_SEQUENCE,
      sequence: {
        id,
        name: trimmed,
        status: 'draft',
        audienceMode,
        onStageExit: 'continue',
        enrollmentSources,
      },
    });
    onCloseCreate?.();
    // New sequences are appended — jump to the last page and expand it.
    setPage(Math.floor(sequences.length / PAGE_SIZE));
    setExpandedId(id);
    toast.success(`Sequence "${trimmed}" created`);
  }

  // Start (draft → active), Pause (active → paused), Resume (paused → active).
  function toggleSendingState(seq) {
    const next = seq.status === 'active' ? 'paused' : 'active';
    dispatch({ type: ACTIONS.UPDATE_MARKETING_SEQUENCE, id: seq.id, patch: { status: next } });
    const msg = next === 'paused'
      ? 'Sequence paused'
      : seq.status === 'draft' ? 'Sequence started' : 'Sequence resumed';
    toast.success(msg);
  }

  function deleteSeq(seq) {
    if (expandedId === seq.id) setExpandedId(null);
    // Drop every step's attachment blobs from IndexedDB — fire-and-forget.
    (seq.steps || []).forEach((st) => {
      (st.attachments || []).forEach((att) => { deleteMarketingAttachment(att.id); });
    });
    dispatch({ type: ACTIONS.DELETE_MARKETING_SEQUENCE, id: seq.id });
    toast.success(`Sequence "${seq.name}" deleted`);
  }

  if (sequences.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Icon name="mail" size={32} />}
          title="No sequences yet"
          message="Build a multi-step email sequence to drip-message a contact list. Sends rotate across your connected Gmail inboxes."
          action={canManage ? (
            <button className="btn btn-primary" onClick={onOpenCreate}>Create your first sequence</button>
          ) : null}
        />
        <NewSequenceModal open={createOpen} onClose={onCloseCreate} onSubmit={handleCreate} />
      </>
    );
  }

  return (
    <>
      <div className="marketing-seq-tab">
        <div className="marketing-seq-list">
          {pageSequences.map((seq) => {
            const stats = selectSequenceStats(state, seq.id);
            const expanded = expandedId === seq.id;
            const stepCount = (seq.steps || []).length;
            const isActive = seq.status === 'active';
            // Start/Resume move the sequence into the sending state — block
            // that until it has at least one step. Pause is always allowed.
            const runLabel = seq.status === 'draft' ? 'Start' : isActive ? 'Pause' : 'Resume';
            const runBlockedNoSteps = !isActive && seq.status !== 'archived' && stepCount === 0;
            const runDisabled = seq.status === 'archived' || runBlockedNoSteps;
            const toggle = () => setExpandedId(expanded ? null : seq.id);
            return (
              <div key={seq.id} className={`card marketing-seq-row ${expanded ? 'is-expanded' : ''}`}>
                <div
                  className="marketing-seq-summary"
                  role={canManage ? 'button' : undefined}
                  tabIndex={canManage ? 0 : undefined}
                  aria-expanded={canManage ? expanded : undefined}
                  onClick={canManage ? toggle : undefined}
                  onKeyDown={canManage ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle();
                    }
                  } : undefined}
                >
                  {canManage && (
                    <span className="marketing-seq-chevron" aria-hidden="true">
                      <Icon name="chevronRight" size={16} />
                    </span>
                  )}
                  <div className="marketing-seq-row-main">
                    <div className="marketing-seq-row-title">
                      <h3>{seq.name}</h3>
                      <Badge variant={STATUS_VARIANTS[seq.status] || 'slate'}>{statusLabel(seq.status)}</Badge>
                      {seq.plainText && <Badge variant="slate">Plain text</Badge>}
                    </div>
                    <div className="marketing-seq-row-stats">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setContactsModal({ sequenceId: seq.id, initialTab: stats.enrolledCount > 0 ? 'enrolled' : 'add' });
                          }}
                          title={stats.enrolledCount > 0 ? 'View enrolled contacts' : 'Add contacts to this sequence'}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            padding: 0,
                            margin: 0,
                            color: 'inherit',
                            font: 'inherit',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            textDecorationStyle: 'dotted',
                            textUnderlineOffset: 3,
                          }}
                        >
                          <strong>{stats.enrolledCount}</strong> enrolled
                        </button>
                      ) : (
                        <span><strong>{stats.enrolledCount}</strong> enrolled</span>
                      )}
                      <span>·</span>
                      <span><strong>{stats.sentCount}</strong> sent</span>
                      <span>·</span>
                      <span><strong>{stats.repliedCount}</strong> replied</span>
                      {stats.failedCount > 0 && (
                        <>
                          <span>·</span>
                          <span className="marketing-seq-row-stat-fail"><strong>{stats.failedCount}</strong> failed</span>
                        </>
                      )}
                      <span className="marketing-seq-row-meta">
                        · {stepCount} step{stepCount === 1 ? '' : 's'}
                        · {seq.audienceMode === 'manual' ? 'Manual leads' : 'Auto leads'}
                      </span>
                    </div>
                  </div>
                  {canManage && (
                    <div className="marketing-seq-row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn btn-primary"
                        onClick={() => toggleSendingState(seq)}
                        disabled={runDisabled}
                        title={runBlockedNoSteps ? 'Add at least one email step first' : undefined}
                      >
                        {runLabel}
                      </button>
                      <button className="btn btn-danger" onClick={() => setConfirmDelete(seq)}>Delete</button>
                    </div>
                  )}
                </div>
                {expanded && canManage && (
                  <div className="marketing-seq-body">
                    <SequenceEditorPanel sequenceId={seq.id} onCollapse={() => setExpandedId(null)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {totalPages > 1 && (
          <SequencePagination page={safePage} totalPages={totalPages} onChange={setPage} />
        )}
      </div>

      <NewSequenceModal open={createOpen} onClose={onCloseCreate} onSubmit={handleCreate} />
      {contactsModal && (
        <SequenceContactsModal
          sequenceId={contactsModal.sequenceId}
          initialTab={contactsModal.initialTab}
          onClose={() => setContactsModal(null)}
        />
      )}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete sequence?"
        message={confirmDelete ? `"${confirmDelete.name}" and all of its enrollments + send history will be removed. This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => confirmDelete && deleteSeq(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}

function SequencePagination({ page, totalPages, onChange }) {
  const pages = Array.from({ length: totalPages }, (_, i) => i);
  return (
    <nav className="marketing-pagination" aria-label="Sequence pages">
      <button
        type="button"
        className="marketing-pagination-btn"
        aria-label="Previous page"
        onClick={() => onChange(page - 1)}
        disabled={page === 0}
      >
        <Icon name="chevronLeft" size={15} />
      </button>
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          className={`marketing-pagination-btn ${p === page ? 'is-active' : ''}`}
          aria-label={`Page ${p + 1}`}
          aria-current={p === page ? 'page' : undefined}
          onClick={() => onChange(p)}
        >
          {p + 1}
        </button>
      ))}
      <button
        type="button"
        className="marketing-pagination-btn"
        aria-label="Next page"
        onClick={() => onChange(page + 1)}
        disabled={page === totalPages - 1}
      >
        <Icon name="chevronRight" size={15} />
      </button>
    </nav>
  );
}

function NewSequenceModal({ open, onClose, onSubmit }) {
  const state = useStore();
  const pipelines = selectPipelines(state).filter((p) => !p.isMaster);

  const [name, setName] = useState('');
  const [audienceMode, setAudienceMode] = useState('auto');
  const [sourcePipelineId, setSourcePipelineId] = useState('');
  const [sourceStageKey, setSourceStageKey] = useState('');

  const sourcePipeline = pipelines.find((p) => p.id === sourcePipelineId) || null;
  const sourceStages = sourcePipeline ? (sourcePipeline.stages || []) : [];

  function reset() {
    setName('');
    setAudienceMode('auto');
    setSourcePipelineId('');
    setSourceStageKey('');
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      audienceMode,
      sourcePipelineId: audienceMode === 'auto' ? sourcePipelineId : '',
      sourceStageKey: audienceMode === 'auto' ? sourceStageKey : '',
    });
    reset();
  }

  function handleClose() {
    reset();
    onClose?.();
  }

  // Auto mode needs both pipeline AND stage before Create unlocks, so the
  // sequence lands with a usable source. (The operator can still add more
  // sources — or remove this one — from the editor's Leads section later.)
  const autoIncomplete = audienceMode === 'auto' && !(sourcePipelineId && sourceStageKey);

  return (
    <Modal open={open} onClose={handleClose} title="New sequence" size="md">
      <form onSubmit={handleSubmit}>
        <FormField
          label="Sequence name"
          name="seq-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Cold outreach — Q3 leads"
          required
          autoFocus
        />
        <FormField
          label="Leads"
          name="seq-audience"
          as="select"
          value={audienceMode}
          onChange={(e) => {
            setAudienceMode(e.target.value);
            // Switching to manual clears the auto-only fields so a stray
            // selection doesn't ride along in the submitted payload.
            if (e.target.value === 'manual') {
              setSourcePipelineId('');
              setSourceStageKey('');
            }
          }}
          options={[
            { value: 'auto', label: 'Auto — pull from a pipeline stage' },
            { value: 'manual', label: 'Manual — pick contacts yourself' },
          ]}
          help={audienceMode === 'auto'
            ? 'Contacts at the pipeline stage you pick below auto-enroll on every scheduler tick.'
            : 'You select which contacts to enroll from the editor after you create the sequence.'}
        />
        {audienceMode === 'auto' && (
          <div className="form-row">
            <FormField
              label="Source pipeline"
              name="seq-source-pipeline"
              as="select"
              value={sourcePipelineId}
              onChange={(e) => { setSourcePipelineId(e.target.value); setSourceStageKey(''); }}
              placeholder="Select a pipeline…"
              options={pipelines.map((p) => ({ value: p.id, label: p.label }))}
            />
            <FormField
              label="Source stage"
              name="seq-source-stage"
              as="select"
              value={sourceStageKey}
              onChange={(e) => setSourceStageKey(e.target.value)}
              placeholder={sourcePipeline ? 'Select a stage…' : 'Pick a pipeline first'}
              options={sourceStages.map((st) => ({ value: st.key, label: st.label }))}
              disabled={!sourcePipeline}
            />
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={handleClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || autoIncomplete}>Create</button>
        </div>
      </form>
    </Modal>
  );
}
