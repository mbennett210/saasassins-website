import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import FormField from './FormField';
import Avatar from './Avatar';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS, THREAD_TITLE_MAX } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import PickerCapNote from './PickerCapNote';
import { selectActiveUsers } from '../store/selectors';
import { roleLabel, compareUsersByName } from '../lib/roles';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import { useT } from '../i18n/react';

// New internal team thread starter. Permission gate (messaging.startInternalThread) is
// enforced at the call site (only admin / super admin see the trigger). Members are
// chosen explicitly at creation: pick a subset, or "Select all in org" — there's no
// implicit "everyone" anymore. The creator is always included as a member regardless.
export default function NewInternalThreadModal({ open, onClose }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const { currentUser } = useAuth();

  const [title, setTitle] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  // Tracks user ids the creator has added — the creator is implicitly included
  // by the reducer, so they don't need to be in this set.
  const [pickedIds, setPickedIds] = useState(() => new Set());

  const allOtherUsers = useMemo(() => {
    return selectActiveUsers(state).filter((u) => u.id !== currentUser?.id).sort(compareUsersByName);
  }, [state, currentUser]);

  // The team by name, never all of it at once (UI_RULES §127; CS-722): typing narrows first, then
  // the first PICKER_MAX_VISIBLE show with the footnote. "Select all" still picks everyone.
  const filteredUsers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return allOtherUsers;
    return allOtherUsers.filter((u) =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );
  }, [allOtherUsers, memberSearch]);
  const { shown, noteMsg } = useMemo(() => capOptions(filteredUsers, PICKER_MAX_VISIBLE), [filteredUsers]);

  useEffect(() => {
    if (open) {
      setTitle('');
      setFirstMessage('');
      setMemberSearch('');
      setPickedIds(new Set());
    }
  }, [open]);

  const trimmedTitle = title.trim();
  // A group thread needs at least one other member — a thread with only the
  // creator is structurally a note-to-self, which is not what this UI promises.
  const canCreate = trimmedTitle.length > 0 && pickedIds.size > 0;

  const togglePick = (id) => {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allOthersSelected = allOtherUsers.length > 0 && pickedIds.size === allOtherUsers.length;
  const handleSelectAll = () => {
    if (allOthersSelected) setPickedIds(new Set());
    else setPickedIds(new Set(allOtherUsers.map((u) => u.id)));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canCreate) return;
    const id = newId('cv');
    // Reducer adds the creator into participantUserIds itself — passing only the
    // explicitly-picked others keeps this UI focused on "who else is in the group."
    dispatch({
      type: ACTIONS.ADD_INTERNAL_CONVERSATION,
      id,
      title: trimmedTitle,
      firstMessage: firstMessage.trim(),
      authorUserId: currentUser?.id || null,
      participantUserIds: Array.from(pickedIds),
    });
    onClose();
    toast.success(t('messages.channelCreated', { title: trimmedTitle }));
    navigate(`/messaging/${id}?inbox=internal`);
  };

  if (!currentUser) return null;

  return (
    <Modal open={open} onClose={onClose} title={t('messages.newChannel')}>
      <form onSubmit={handleSubmit}>
        <div className="text-xs text-muted" style={{ marginBottom: 12 }}>
          {t('messages.newChannelIntro')}
        </div>

        <FormField label={t('messages.channelTitle')} required>
          <input
            className="input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('messages.channelTitlePlaceholder')}
            maxLength={THREAD_TITLE_MAX}
          />
        </FormField>

        <FormField label={pickedIds.size > 0 ? t('messages.membersSelected', { count: pickedIds.size }) : t('messages.members')} required>
          <div className="member-picker">
            <div className="member-picker-toolbar">
              <div className="thread-list-search" style={{ flex: 1 }}>
                <Icon name="search" size={14} />
                <input
                  className="thread-list-input"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder={t('messages.searchMembers')}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSelectAll}
                disabled={allOtherUsers.length === 0}
                title={allOthersSelected ? t('messages.clearMembers') : t('messages.selectEveryone')}
              >
                {allOthersSelected ? t('messages.clearAll') : t('messages.selectAllMembers')}
              </button>
            </div>

            <PickerCapNote note={noteMsg} />
            <div className="member-picker-list" role="listbox" aria-label={t('messages.teammates')}>
              {filteredUsers.length === 0 ? (
                <div className="text-xs text-muted" style={{ padding: '10px 4px' }}>
                  {allOtherUsers.length === 0 ? t('messages.noTeammates') : t('messages.noTeammatesMatch')}
                </div>
              ) : (
                shown.map((u) => {
                  const checked = pickedIds.has(u.id);
                  return (
                    <label key={u.id} className={`member-picker-row ${checked ? 'is-checked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePick(u.id)}
                      />
                      <Avatar user={u} size="sm" />
                      <div className="member-picker-row-body">
                        <div className="member-picker-row-name">{u.name}</div>
                        <div className="member-picker-row-sub text-xs text-muted">
                          {roleLabel(t, u.role)}{u.email ? ` · ${u.email}` : ''}
                        </div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </FormField>

        <FormField label={t('messages.firstMessage')}>
          <textarea
            className="input"
            rows={3}
            value={firstMessage}
            onChange={(e) => setFirstMessage(e.target.value)}
            placeholder={t('messages.firstMessagePlaceholder')}
          />
        </FormField>

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!canCreate}>
            {t('messages.createChannel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
