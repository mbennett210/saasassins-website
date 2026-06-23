import { useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectTags } from '../../store/selectors';
import { MARKETING_VARIABLES } from '../../lib/marketingScheduler';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import TagChip from '../../components/TagChip';

// Color and scope inputs are removed from the UI: TagChip stopped reading
// tag.color (every tag renders with neutral chrome to match GHL), and tags are
// contact-only (no Clients use case). The fields are still passed at create
// time as stable defaults so any older code paths that read them keep working.

// Read-only reference for the {merge fields} usable in marketing emails. Grouped
// by source; the live value (when a company field) is shown so the catalog
// doubles as a "what will this resolve to" preview. Sourced from the same
// MARKETING_VARIABLES catalog the scheduler substitutes at send time.
const VAR_GROUPS = [
  { key: 'contact',  title: 'Contact',    desc: 'Filled in per recipient from their contact record — the value differs for every contact the email reaches.' },
  { key: 'brand',    title: 'Your brand', desc: 'Your own company details and the teammate whose inbox sends the email.' },
  { key: 'sequence', title: 'Sequence',   desc: 'About the sequence the email belongs to.' },
];

function VariablesView({ company }) {
  return (
    <div className="var-view">
      <div className="info-banner">
        <Icon name="lock" size={18} />
        <div>
          <strong>Variables are fixed and read-only.</strong>{' '}
          Drop one into a marketing email&rsquo;s subject or body as{' '}
          <code className="var-token">{'{token}'}</code> and it&rsquo;s swapped for the
          real value when the email sends. To change a value, edit its source —
          e.g. a company detail at Settings → Company.
        </div>
      </div>
      {VAR_GROUPS.map((g) => {
        const vars = MARKETING_VARIABLES.filter((v) => v.group === g.key);
        if (vars.length === 0) return null;
        return (
          <div key={g.key} className="var-group">
            <h3 className="perm-group-head">{g.title}</h3>
            <p className="var-group-desc">{g.desc}</p>
            <div className="var-list">
              {vars.map((v) => {
                const liveValue = v.companyField ? (company && company[v.companyField]) : null;
                return (
                  <div key={v.key} className="var-row">
                    <code className="var-token">{`{${v.key}}`}</code>
                    <div className="var-row-body">
                      <div className="var-row-label">{v.label}</div>
                      <div className="var-row-from">
                        {liveValue ? (<><span className="var-row-value">{liveValue}</span>{' — '}{v.from}</>) : (v.from)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SettingsTags() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const tags = selectTags(state);

  const [view, setView] = useState('tags');
  const [draft, setDraft] = useState({ label: '' });
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const usageCount = (tagId) =>
    (state.contacts || []).filter((c) => (c.tagIds || []).includes(tagId)).length;

  const addTag = (e) => {
    e.preventDefault();
    const label = draft.label.trim();
    if (!label) return;
    const dup = tags.some((t) => t.label.toLowerCase() === label.toLowerCase());
    if (dup) {
      toast.error('A tag with that label already exists');
      return;
    }
    dispatch({ type: ACTIONS.ADD_TAG, tag: { label, color: 'slate', scope: 'contact' } });
    setDraft({ label: '' });
    toast.success('Tag added');
  };

  const saveTag = (t) => {
    const label = (t.label || '').trim();
    if (!label) return;
    const dup = tags.some((x) => x.id !== t.id && x.label.toLowerCase() === label.toLowerCase());
    if (dup) {
      toast.error('Another tag already uses that label');
      return;
    }
    dispatch({ type: ACTIONS.UPDATE_TAG, id: t.id, patch: { label } });
    setEditing(null);
    toast.success('Tag updated');
  };

  const deleteTag = (tag) => {
    dispatch({ type: ACTIONS.DELETE_TAG, id: tag.id });
    setConfirm(null);
  };

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Tags &amp; Variables</h1>
        <p className="page-head-subtitle">
          Tags categorize contacts. Variables are the read-only placeholders you drop into marketing emails.
        </p>
      </div>

      <div className="segmented" style={{ marginBottom: 20 }}>
        <button type="button" className={`segmented-btn ${view === 'tags' ? 'active' : ''}`} onClick={() => setView('tags')}>Tags</button>
        <button type="button" className={`segmented-btn ${view === 'variables' ? 'active' : ''}`} onClick={() => setView('variables')}>Variables</button>
      </div>

      {view === 'variables' ? (
        <VariablesView company={state.company} />
      ) : (
        <>
          <div className="card detail-card" style={{ marginBottom: 20, maxWidth: 360 }}>
            <h3 className="dash-card-title">Add tag</h3>
            <form className="tag-add-form" onSubmit={addTag}>
              <FormField
                label="Label"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="e.g., VIP, Net-30, Hot Lead"
              />
              <button type="submit" className="btn btn-primary tag-add-submit">Add</button>
            </form>
          </div>

          <div>
            <h3 className="perm-group-head">All tags ({tags.length})</h3>
            {tags.length === 0 ? (
              <EmptyState title="No tags yet" message="Add your first tag above to start categorizing contacts." />
            ) : (
              <>
              <div className="mobile-card-list" style={{ marginTop: 8 }}>
                {tags.map((t) => {
                  const used = usageCount(t.id);
                  const isEditing = editing?.id === t.id;
                  return (
                    <div key={t.id} className="mobile-card" style={{ cursor: 'default' }}>
                      <div className="mc-name" style={{ gridColumn: '1 / span 3' }}>
                        {isEditing ? (
                          <FormField
                            label=""
                            value={editing.label}
                            onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                          />
                        ) : (
                          <TagChip tag={t} size="sm" />
                        )}
                      </div>
                      <div className="mc-sub" style={{ gridColumn: '1 / span 4' }}>
                        {used} in use
                      </div>
                      <div className="mc-meta">
                        {isEditing ? (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => saveTag(editing)}>Save</button>
                            <button className="btn btn-sm btn-outline" onClick={() => setEditing(null)}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm btn-outline" onClick={() => setEditing({ ...t })}>Edit</button>
                            <button className="btn btn-sm btn-outline" onClick={() => setConfirm(t)} aria-label={`Delete ${t.label}`}>
                              <Icon name="trash" size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>In use</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tags.map((t) => {
                      const isEditing = editing?.id === t.id;
                      const used = usageCount(t.id);
                      return (
                        <tr key={t.id}>
                          <td>
                            {isEditing ? (
                              <FormField
                                label=""
                                value={editing.label}
                                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                              />
                            ) : (
                              <TagChip tag={t} size="sm" />
                            )}
                          </td>
                          <td className="text-sm text-muted">{used}</td>
                          <td className="text-right">
                            {isEditing ? (
                              <>
                                <button className="btn btn-sm btn-primary" onClick={() => saveTag(editing)}>Save</button>
                                <button className="btn btn-sm btn-outline" onClick={() => setEditing(null)} style={{ marginLeft: 6 }}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button className="btn btn-sm btn-outline" onClick={() => setEditing({ ...t })}>Edit</button>
                                <button
                                  className="btn btn-sm btn-outline"
                                  onClick={() => setConfirm(t)}
                                  style={{ marginLeft: 6 }}
                                  aria-label={`Delete ${t.label}`}
                                >
                                  <Icon name="trash" size={14} />
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Delete tag?"
        message={
          confirm
            ? `"${confirm.label}" will be removed from ${usageCount(confirm.id)} contact${usageCount(confirm.id) === 1 ? '' : 's'}. This can't be undone.`
            : ''
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => confirm && deleteTag(confirm)}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
