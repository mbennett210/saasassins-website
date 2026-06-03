import { useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectTags } from '../../store/selectors';
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

export default function SettingsTags() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const tags = selectTags(state);

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
        <h1 className="page-head-title">Tags</h1>
        <p className="page-head-subtitle">
          Tags appear on contacts and clients. Deleting a tag removes it from every contact that has it.
        </p>
      </div>

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
