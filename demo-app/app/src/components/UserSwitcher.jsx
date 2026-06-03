import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useStore } from '../store';
import { selectUsers } from '../store/selectors';
import { ROLE_LABELS } from '../lib/roles';
import Avatar from './Avatar';

// Prototype-only chip for demoing role behavior. Lets you hop across users.
export default function UserSwitcher() {
  const { currentUser, setCurrentUser } = useAuth();
  const users = useStore() ? selectUsers(useStore()) : [];
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!currentUser) return null;

  return (
    <div className="user-switcher" ref={ref}>
      <button
        type="button"
        className="user-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Avatar initials={currentUser.initials} variant={currentUser.avatar} size="sm" />
        <span className="user-chip-text">
          <span className="user-chip-name">{currentUser.name}</span>
          <span className="user-chip-role">{ROLE_LABELS[currentUser.role]}</span>
        </span>
        <span className="user-chip-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="user-menu" role="listbox">
          <div className="user-menu-label">Switch user (demo)</div>
          {users.filter((u) => u.status !== 'disabled').map((u) => (
            <button
              key={u.id}
              type="button"
              className={`user-menu-item ${u.id === currentUser.id ? 'active' : ''}`}
              onClick={() => { setCurrentUser(u.id); setOpen(false); }}
            >
              <Avatar initials={u.initials} variant={u.avatar} size="sm" />
              <span className="user-menu-item-text">
                <span className="user-menu-item-name">{u.name}</span>
                <span className="user-menu-item-role">{ROLE_LABELS[u.role]}{u.status === 'invited' ? ' · Invited' : ''}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
