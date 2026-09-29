// Bulk contact enrollment for a marketing sequence. Two tabs:
//  - Add — filterable, paginated checkbox table; "select all matching" enrolls
//    a whole filtered segment in one action.
//  - Enrolled — the current roster; bulk-select rows and remove them.
// Dispatches ENROLL_CONTACTS (array — dedup-safe) and UNENROLL_CONTACT.
// Mounted only while open (the parent renders it conditionally), so every
// hook runs before the `!seq` guard and selection state is fresh per open.

import { useState, useMemo, useRef, useEffect } from 'react';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectMarketingSequenceById,
  selectEnrollmentsForSequence,
  selectContacts,
  selectTags,
  selectPipelines,
  selectContactIsVendor,
} from '../../store/selectors';
import { useToast } from '../../components/Toast';
import Modal from '../../components/Modal';
import Avatar from '../../components/Avatar';
import Badge from '../../components/Badge';
import ConfirmDialog from '../../components/ConfirmDialog';
import FilterSelect from '../../components/FilterSelect';
import ListPager from '../../components/ListPager';

const PAGE_SIZE = 10;
const LIFECYCLES = [
  { value: 'lead', label: 'Lead' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'client', label: 'Client' },
  { value: 'vendor', label: 'Vendor' },
];

function fullName(c) {
  return `${c.firstName || ''} ${c.lastName || ''}`.trim();
}
function initials(c) {
  const a = (c.firstName || '').trim()[0] || '';
  const b = (c.lastName || '').trim()[0] || '';
  return (a + b).toUpperCase() || '?';
}
// Avatar colour — matches the (id.length % 5) convention used elsewhere.
function avatarVariant(id) {
  return (id.length % 5) + 1;
}

export default function SequenceContactsModal({ sequenceId, initialTab, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const seq = sequenceId ? selectMarketingSequenceById(state, sequenceId) : null;
  const contacts = selectContacts(state);
  const tags = selectTags(state);
  const pipelines = selectPipelines(state);
  const enrollments = useMemo(
    () => (sequenceId ? selectEnrollmentsForSequence(state, sequenceId) : []),
    [state, sequenceId]
  );

  const [tab, setTab] = useState(initialTab === 'enrolled' ? 'enrolled' : 'add');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [enrolledQuery, setEnrolledQuery] = useState('');
  const [enrolledSelectedIds, setEnrolledSelectedIds] = useState(() => new Set());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const masterRef = useRef(null);
  const enrolledMasterRef = useRef(null);

  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  // Options for the searchable filter dropdowns (FilterSelect). Each leads with
  // an "All …" default (value '') that clears the filter. Pipeline stages are
  // flattened across pipelines, prefixed with the pipeline name only when more
  // than one exists.
  const tagFilterOptions = useMemo(
    () => [{ value: '', label: 'All tags' }, ...tags.map((t) => ({ value: t.id, label: t.label }))],
    [tags]
  );
  const lifecycleFilterOptions = useMemo(
    () => [{ value: '', label: 'All lifecycle stages' }, ...LIFECYCLES.map((l) => ({ value: l.value, label: l.label }))],
    []
  );
  const stageFilterOptions = useMemo(() => {
    // Deals live on the Master Pipeline now; filter the manual list by the stage
    // of a contact's company deal. Guard any label-less stage.
    const master = pipelines.find((p) => p.isMaster) || null;
    const opts = [{ value: '', label: 'All deal stages' }];
    (master?.stages || []).forEach((s) => {
      if (!s.key || !s.label) return;
      opts.push({ value: `${master.id}::${s.key}`, label: s.label });
    });
    return opts;
  }, [pipelines]);

  // A contact's "deal stage" as `${pipelineId}::${stageKey}` — the open opportunity
  // they're the primary of, else any open opportunity at their company. A person is
  // never on a pipeline; the deal belongs to the company.
  const dealStageByContact = useMemo(() => {
    const m = new Map();
    const opps = (state.opportunities || []).filter((o) => o.status === 'open' && o.stage);
    for (const o of opps) {
      if (o.primaryContactId && !m.has(o.primaryContactId)) m.set(o.primaryContactId, `${o.pipelineId}::${o.stage}`);
    }
    for (const c of contacts) {
      if (m.has(c.id) || !c.companyId) continue;
      const o = opps.find((x) => x.clientId === c.companyId);
      if (o) m.set(c.id, `${o.pipelineId}::${o.stage}`);
    }
    return m;
  }, [state.opportunities, contacts]);

  const enrollmentByContact = useMemo(() => {
    const m = new Map();
    enrollments
      .filter((e) => e.status !== 'unenrolled')
      .forEach((e) => m.set(e.contactId, e));
    return m;
  }, [enrollments]);
  const enrolledIds = useMemo(() => new Set(enrollmentByContact.keys()), [enrollmentByContact]);

  // Contacts matching the Add-tab filters, sorted by name.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .filter((c) => {
        // Vendors are excluded from all marketing targeting (CRM-MODEL §6).
        if (selectContactIsVendor(state, c)) return false;
        if (q) {
          const name = fullName(c).toLowerCase();
          if (!name.includes(q) && !(c.email || '').toLowerCase().includes(q)) return false;
        }
        if (tagFilter && !(c.tagIds || []).includes(tagFilter)) return false;
        if (lifecycleFilter && c.lifecycle !== lifecycleFilter) return false;
        if (stageFilter && dealStageByContact.get(c.id) !== stageFilter) return false;
        return true;
      })
      .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  }, [contacts, query, tagFilter, lifecycleFilter, stageFilter, dealStageByContact, state.clients]);

  // Of the filtered set, the ones that can actually be added.
  const addable = useMemo(
    () => filtered.filter((c) => c.email && !enrolledIds.has(c.id)),
    [filtered, enrolledIds]
  );

  const pageContacts = useMemo(() => {
    const tp = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const sp = Math.min(page, tp - 1);
    return filtered.slice(sp * PAGE_SIZE, sp * PAGE_SIZE + PAGE_SIZE);
  }, [filtered, page]);
  const pageAddable = useMemo(
    () => pageContacts.filter((c) => c.email && !enrolledIds.has(c.id)),
    [pageContacts, enrolledIds]
  );

  // Enrolled-tab roster. Sorted by enrollment time ascending so the list
  // matches the FIFO send order — earlier enrollments will receive Step 1
  // before later enrollments. Position 1 is the oldest enrollment, the
  // next to be sent through any newly-freed inbox slot.
  const enrolledList = useMemo(() => {
    const q = enrolledQuery.trim().toLowerCase();
    return contacts
      .filter((c) => enrolledIds.has(c.id))
      .filter((c) => !q || fullName(c).toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q))
      .sort((a, b) => {
        const aT = enrollmentByContact.get(a.id)?.enrolledAt || '';
        const bT = enrollmentByContact.get(b.id)?.enrolledAt || '';
        if (aT === bT) return fullName(a).localeCompare(fullName(b));
        return aT < bT ? -1 : 1;
      });
  }, [contacts, enrolledIds, enrolledQuery, enrollmentByContact]);

  // Reflect partial selection on whichever tab's header checkbox is mounted.
  useEffect(() => {
    const addEl = masterRef.current;
    if (addEl) {
      const sel = pageAddable.filter((c) => selectedIds.has(c.id)).length;
      addEl.indeterminate = sel > 0 && sel < pageAddable.length;
    }
    const enrEl = enrolledMasterRef.current;
    if (enrEl) {
      const sel = enrolledList.filter((c) => enrolledSelectedIds.has(c.id)).length;
      enrEl.indeterminate = sel > 0 && sel < enrolledList.length;
    }
  }, [pageAddable, selectedIds, enrolledList, enrolledSelectedIds, tab]);

  // ----- Early return AFTER every hook -----
  if (!seq) return null;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const allPageSelected = pageAddable.length > 0 && pageAddable.every((c) => selectedIds.has(c.id));
  const allAddableSelected = addable.length > 0 && addable.every((c) => selectedIds.has(c.id));
  const showBanner = allPageSelected && (addable.length > pageAddable.length || allAddableSelected);
  const enrolledCount = enrolledIds.size;
  const allEnrolledSelected =
    enrolledList.length > 0 && enrolledList.every((c) => enrolledSelectedIds.has(c.id));

  function toggleOne(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleMaster() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageAddable.forEach((c) => next.delete(c.id));
      else pageAddable.forEach((c) => next.add(c.id));
      return next;
    });
  }
  function selectAllMatching() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      addable.forEach((c) => next.add(c.id));
      return next;
    });
  }
  function handleAdd() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    dispatch({ type: ACTIONS.ENROLL_CONTACTS, sequenceId: seq.id, contactIds: ids });
    toast.success(`${ids.length} contact${ids.length === 1 ? '' : 's'} enrolled`);
    onClose?.();
  }
  function toggleEnrolled(id) {
    setEnrolledSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleEnrolledMaster() {
    setEnrolledSelectedIds((prev) => {
      const next = new Set(prev);
      if (allEnrolledSelected) enrolledList.forEach((c) => next.delete(c.id));
      else enrolledList.forEach((c) => next.add(c.id));
      return next;
    });
  }
  function doRemove() {
    enrolledSelectedIds.forEach((contactId) => {
      const enr = enrollmentByContact.get(contactId);
      if (enr) dispatch({ type: ACTIONS.UNENROLL_CONTACT, enrollmentId: enr.id });
    });
    setEnrolledSelectedIds(new Set());
    setConfirmRemove(false);
  }

  function stageLabelFor(c) {
    const key = dealStageByContact.get(c.id);
    if (!key) return null;
    const [, stageKey] = key.split('::');
    const master = pipelines.find((p) => p.isMaster) || null;
    const st = (master?.stages || []).find((s) => s.key === stageKey);
    return st ? st.label : null;
  }

  return (
    <Modal open onClose={onClose} title={seq.name} size="lg">
      <div className="enroll-modal">
        <div className="tab-container tab-container-line enroll-tabs">
          <button type="button" className={`tab-btn ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
            Add contacts
          </button>
          <button type="button" className={`tab-btn ${tab === 'enrolled' ? 'active' : ''}`} onClick={() => setTab('enrolled')}>
            Enrolled · {enrolledCount}
          </button>
        </div>

        {tab === 'add' ? (
          <>
            <p className="text-sm text-muted" style={{ margin: '4px 0 10px', padding: '8px 10px', background: 'var(--inset-bg)', borderRadius: 4 }}>
              Selected contacts are added to the <strong>back of the queue</strong> and start at <strong>Step 1</strong> of the sequence. Sends process in <strong>FIFO order</strong>. Earlier enrollments send before later ones, paced by each connected inbox&apos;s daily limit and send interval.
            </p>
            <div className="enroll-toolbar">
              <input
                className="input"
                placeholder="Search contacts by name or email…"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
              />
              <div className="enroll-filters">
                <FilterSelect
                  ariaLabel="Filter by tag"
                  value={tagFilter}
                  options={tagFilterOptions}
                  onChange={(v) => { setTagFilter(v); setPage(0); }}
                />
                <FilterSelect
                  ariaLabel="Filter by lifecycle stage"
                  value={lifecycleFilter}
                  options={lifecycleFilterOptions}
                  onChange={(v) => { setLifecycleFilter(v); setPage(0); }}
                />
                <FilterSelect
                  ariaLabel="Filter by deal stage"
                  value={stageFilter}
                  options={stageFilterOptions}
                  onChange={(v) => { setStageFilter(v); setPage(0); }}
                />
              </div>
            </div>

            <div className="enroll-table">
              <div className="enroll-row enroll-row-head">
                <span className="enroll-cell-check">
                  <input
                    ref={masterRef}
                    type="checkbox"
                    checked={allPageSelected}
                    disabled={pageAddable.length === 0}
                    onChange={toggleMaster}
                    aria-label="Select every addable contact on this page"
                  />
                </span>
                <span>Contact</span>
                <span className="enroll-cell-tags">Tags</span>
                <span className="enroll-cell-stage">Deal stage</span>
              </div>

              <div className="enroll-scroll">
                {showBanner && (
                  <div className="enroll-banner">
                    {allAddableSelected ? (
                      <>
                        <span>All <strong>{addable.length}</strong> matching contact{addable.length === 1 ? '' : 's'} selected.</span>
                        <button type="button" className="linklike" onClick={() => setSelectedIds(new Set())}>
                          Clear selection
                        </button>
                      </>
                    ) : (
                      <>
                        <span>All <strong>{pageAddable.length}</strong> on this page selected.</span>
                        <button type="button" className="linklike" onClick={selectAllMatching}>
                          Select all {addable.length} contacts
                        </button>
                      </>
                    )}
                  </div>
                )}

                {pageContacts.length === 0 && (
                  <div className="enroll-empty">No contacts match your search.</div>
                )}

                {pageContacts.map((c) => {
                  const isEnrolled = enrolledIds.has(c.id);
                  const noEmail = !c.email;
                  const locked = isEnrolled || noEmail;
                  const stage = stageLabelFor(c);
                  const tagChips = (c.tagIds || []).map((id) => tagsById.get(id)).filter(Boolean);
                  const body = (
                    <>
                      <span className="enroll-cell-check">
                        {isEnrolled ? (
                          <input type="checkbox" checked disabled aria-label="Already enrolled" />
                        ) : (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(c.id)}
                            disabled={noEmail}
                            onChange={() => toggleOne(c.id)}
                            aria-label={`Select ${fullName(c)}`}
                          />
                        )}
                      </span>
                      <span className="enroll-cell-contact">
                        <Avatar initials={initials(c)} variant={avatarVariant(c.id)} size="sm" />
                        <span className="enroll-contact-txt">
                          <span className="enroll-contact-name-row">
                            <span className="enroll-contact-name">{fullName(c) || 'Unnamed contact'}</span>
                            {isEnrolled && <Badge variant="green">Enrolled</Badge>}
                          </span>
                          <span className={`enroll-contact-mail ${noEmail ? 'is-warn' : ''}`}>
                            {c.email || 'No email. Can’t enroll'}
                          </span>
                        </span>
                      </span>
                      <span className="enroll-cell-tags">
                        {tagChips.slice(0, 2).map((t) => (
                          <Badge key={t.id} variant={t.color}>{t.label}</Badge>
                        ))}
                        {tagChips.length > 2 && <span className="enroll-tag-more">+{tagChips.length - 2}</span>}
                      </span>
                      <span className="enroll-cell-stage">
                        {stage ? <span className="enroll-stage">{stage}</span> : <span className="enroll-dash">—</span>}
                      </span>
                    </>
                  );
                  return locked ? (
                    <div key={c.id} className="enroll-row is-locked">{body}</div>
                  ) : (
                    <label key={c.id} className="enroll-row">{body}</label>
                  );
                })}
              </div>
            </div>

            <ListPager
              pager={{ page: safePage + 1, totalPages, setPage: (p) => setPage(p - 1), start: safePage * PAGE_SIZE + 1, end: Math.min((safePage + 1) * PAGE_SIZE, filtered.length), total: filtered.length }}
              noun="contacts"
            />

            <div className="enroll-foot">
              <span className="enroll-foot-count"><strong>{selectedIds.size}</strong> selected</span>
              <div className="enroll-foot-btns">
                <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={handleAdd} disabled={selectedIds.size === 0}>
                  Add {selectedIds.size} to sequence
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted" style={{ margin: '4px 0 10px', padding: '8px 10px', background: 'var(--inset-bg)', borderRadius: 4 }}>
              Listed in <strong>FIFO send order</strong> (Position 1 = oldest enrollment, next in line). All contacts begin at Step 1; the scheduler advances them through the sequence subject to inbox throttles and daily caps.
            </p>
            <div className="enroll-toolbar">
              <input
                className="input"
                placeholder="Search enrolled contacts…"
                value={enrolledQuery}
                onChange={(e) => setEnrolledQuery(e.target.value)}
              />
            </div>
            <div className="enroll-table is-2col">
              <div className="enroll-row enroll-row-head">
                <span className="enroll-cell-check">
                  <input
                    ref={enrolledMasterRef}
                    type="checkbox"
                    checked={allEnrolledSelected}
                    disabled={enrolledList.length === 0}
                    onChange={toggleEnrolledMaster}
                    aria-label="Select every enrolled contact shown"
                  />
                </span>
                <span>Contact</span>
              </div>
              <div className="enroll-scroll">
                {enrolledList.length === 0 && (
                  <div className="enroll-empty">
                    {enrolledCount === 0 ? 'No contacts enrolled yet.' : 'No enrolled contacts match your search.'}
                  </div>
                )}
                {enrolledList.map((c, idx) => {
                  const enr = enrollmentByContact.get(c.id);
                  const sourceLabel = enr?.source === 'auto' ? 'auto-pulled' : 'manually added';
                  return (
                    <label key={c.id} className="enroll-row">
                      <span className="enroll-cell-check">
                        <input
                          type="checkbox"
                          checked={enrolledSelectedIds.has(c.id)}
                          onChange={() => toggleEnrolled(c.id)}
                          aria-label={`Select ${fullName(c)}`}
                        />
                      </span>
                      <span className="enroll-cell-contact">
                        <Avatar initials={initials(c)} variant={avatarVariant(c.id)} size="sm" />
                        <span className="enroll-contact-txt">
                          <span className="enroll-contact-name">
                            <span style={{
                              display: 'inline-block',
                              minWidth: 24,
                              marginRight: 6,
                              fontSize: 11,
                              color: 'var(--color-text-muted)',
                              fontVariantNumeric: 'tabular-nums',
                            }}>#{idx + 1}</span>
                            {fullName(c) || 'Unnamed contact'}
                            <span style={{
                              marginLeft: 6,
                              fontSize: 10,
                              fontWeight: 400,
                              color: 'var(--color-text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.4,
                            }}>{sourceLabel}</span>
                          </span>
                          <span className="enroll-contact-mail">{c.email || 'No email'}</span>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="enroll-foot">
              <span className="enroll-foot-count">
                {enrolledSelectedIds.size > 0
                  ? <><strong>{enrolledSelectedIds.size}</strong> selected</>
                  : <><strong>{enrolledCount}</strong> enrolled</>}
              </span>
              <div className="enroll-foot-btns">
                <button type="button" className="btn btn-outline" onClick={onClose}>Close</button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setConfirmRemove(true)}
                  disabled={enrolledSelectedIds.size === 0}
                >
                  Remove{enrolledSelectedIds.size > 0 ? ` ${enrolledSelectedIds.size}` : ''}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove from sequence?"
        message={`${enrolledSelectedIds.size} contact${enrolledSelectedIds.size === 1 ? '' : 's'} will be removed from this sequence. Their remaining steps won’t send.`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={doRemove}
        onClose={() => setConfirmRemove(false)}
      />
    </Modal>
  );
}
