import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import Avatar from './Avatar';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { ROLE_LABELS } from '../lib/roles';
import { selectActiveUsers, selectDmConversationBetween } from '../store/selectors';
import { newId } from '../lib/ids';

// 1:1 direct-message starter. Pick another user; if a DM thread already exists between
// the current user and the picked user, route to it instead of spawning a duplicate.
export default function NewDmModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const { currentUser } = useAuth();

  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  const candidates = useMemo(() => {
    const others = selectActiveUsers(state).filter((u) => u.id !== currentUser?.id);
    const q = search.trim().toLowerCase();
    if (!q) return others;
    return others.filter((u) =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );
  }, [state, currentUser, search]);

  if (!currentUser) return null;

  const handlePick = (otherId) => {
    const other = candidates.find((u) => u.id === otherId);
    const existing = selectDmConversationBetween(state, currentUser.id, otherId);
    if (existing) {
      onClose();
      navigate(`/messaging/${existing.id}?inbox=dm`);
      return;
    }
    // Mint the id up front so we can navigate to the new thread deterministically
    // without waiting on a re-render to read the latest state.
    const id = newId('cv');
    dispatch({
      type: ACTIONS.ADD_DM_CONVERSATION,
      id,
      participantUserIds: [currentUser.id, otherId],
    });
    onClose();
    toast.success(`DM with ${other?.name || 'user'} opened`);
    navigate(`/messaging/${id}?inbox=dm`);
  };

  return (
    <Modal open={open} onClose={onClose} title="New direct message">
      <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
        Pick a teammate to start a private 1:1 conversation. Only the two of you can see it.
      </div>

      <div className="thread-list-search" style={{ marginBottom: 8 }}>
        <Icon name="search" size={14} />
        <input
          className="thread-list-input"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search teammates by name or email…"
        />
      </div>

      <div className="dm-picker-list">
        {candidates.length === 0 ? (
          <div className="text-xs text-muted" style={{ padding: '8px 0' }}>
            No matching teammates.
          </div>
        ) : (
          candidates.map((u) => (
            <button
              key={u.id}
              type="button"
              className="dm-picker-row"
              onClick={() => handlePick(u.id)}
            >
              <Avatar initials={u.initials} variant={u.avatar} size="sm" />
              <div className="dm-picker-row-body">
                <div className="dm-picker-row-name">{u.name}</div>
                <div className="dm-picker-row-sub text-xs text-muted">
                  {ROLE_LABELS[u.role] || u.role}{u.email ? ` · ${u.email}` : ''}
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
