import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useStore } from '../store';
import { selectUsers } from '../store/selectors';
import { ROLE_LABELS } from '../lib/roles';
import Avatar from './Avatar';

// Prototype-only chip for demoing role behavior. Lets you hop across users.
// The demo has no real auth, so this always renders the user-switcher; the
// formatted header/divider mirrors the live app's signed-in menu styling.
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
        aria-haspopup="menu"
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
        <div className="user-menu" role="menu">
          <div className="user-menu-header">
            <span className="user-menu-caption">Switch user (demo)</span>
          </div>
          <div className="user-menu-divider" role="separator" />
          {users.filter((u) => u.status !== 'disabled').map((u) => (
            <button
              key={u.id}
              type="button"
              className={`user-menu-item ${u.id === currentUser.id ? 'active' : ''}`}
              role="menuitem"
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
