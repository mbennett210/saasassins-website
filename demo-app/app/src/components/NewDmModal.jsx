import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import Avatar from './Avatar';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import PickerCapNote from './PickerCapNote';
import { roleLabel, compareUsersByName } from '../lib/roles';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import { useT } from '../i18n/react';
import { selectActiveUsers, selectDmConversationBetween } from '../store/selectors';
import { newId } from '../lib/ids';

// 1:1 direct-message starter. Pick another user; if a DM thread already exists between
// the current user and the picked user, route to it instead of spawning a duplicate.
// The team by name, never all of it at once (UI_RULES §127; CS-722: 1,541 rows, 7,706 nodes):
// typing narrows first, then the first PICKER_MAX_VISIBLE show with the footnote.
export default function NewDmModal({ open, onClose }) {
  const t = useT();
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
    const others = selectActiveUsers(state).filter((u) => u.id !== currentUser?.id).sort(compareUsersByName);
    const q = search.trim().toLowerCase();
    if (!q) return others;
    return others.filter((u) =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );
  }, [state, currentUser, search]);
  const { shown, noteMsg } = useMemo(() => capOptions(candidates, PICKER_MAX_VISIBLE), [candidates]);

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
    toast.success(t('messages.dmOpened', { name: other?.name || t('messages.someone') }));
    navigate(`/messaging/${id}?inbox=dm`);
  };

  return (
    <Modal open={open} onClose={onClose} title={t('messages.newDmModalTitle')}>
      <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
        {t('messages.newDmIntro')}
      </div>

      <div className="thread-list-search" style={{ marginBottom: 8 }}>
        <Icon name="search" size={14} />
        <input
          className="thread-list-input"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('messages.searchTeammates')}
        />
      </div>

      <PickerCapNote note={noteMsg} />
      <div className="dm-picker-list">
        {candidates.length === 0 ? (
          <div className="text-xs text-muted" style={{ padding: '8px 0' }}>
            {t('messages.noMatchingTeammates')}
          </div>
        ) : (
          shown.map((u) => (
            <button
              key={u.id}
              type="button"
              className="dm-picker-row"
              onClick={() => handlePick(u.id)}
            >
              <Avatar user={u} size="sm" />
              <div className="dm-picker-row-body">
                <div className="dm-picker-row-name">{u.name}</div>
                <div className="dm-picker-row-sub text-xs text-muted">
                  {roleLabel(t, u.role)}{u.email ? ` · ${u.email}` : ''}
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Modal>
  );
}
