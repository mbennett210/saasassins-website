import { useState, useRef } from 'react';
import PopMenu from './PopMenu';
import { useAuth } from '../hooks/useAuth';
import { useStore } from '../store';
import { selectUsers } from '../store/selectors';
import { ROLE_LABELS } from '../lib/roles';
import Avatar from './Avatar';
import Icon from './Icon';

// The signed-in user chip. In authed (Supabase) mode it shows who you are + Sign
// out; an OWNER additionally gets a "View as" switcher that re-renders the app
// from any team member's role perspective. This is VIEW-ONLY — the server still
// enforces the real owner claim (app_metadata), so it cannot escalate privilege;
// it only changes the perspective the UI is drawn from. In local (no-Supabase)
// mode it falls back to the demo user-switcher so role behavior can be exercised
// without real accounts.
export default function UserSwitcher() {
  const {
    currentUser, authenticatedUser, viewAsUserId,
    setCurrentUser, setViewAs, signOut, authConfigured, claimRole,
  } = useAuth();
  const users = selectUsers(useStore());
  const [open, setOpen] = useState(false);
  // Sign-out can take several seconds now (a final bounded sync flush runs
  // before the cache wipe). Without visible progress, the tap looks dead —
  // second taps are swallowed by AuthProvider's re-entrancy guard and a user
  // who concludes the button is broken may close the tab mid-flush, skipping
  // the informed-choice dialog. Keep the menu open with a busy label instead.
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef(null);

  if (!currentUser) return null;

  // Full-roster picker, shared by the authed "View as" switcher and the local
  // sandbox switcher — the only difference is which action the pick dispatches.
  const rosterButtons = (onPick) => users.filter((u) => u.status !== 'disabled').map((u) => (
    <button
      key={u.id}
      type="button"
      className={`menu-option ${u.id === currentUser.id ? 'active' : ''}`}
      role="menuitem"
      onClick={() => { onPick(u.id); setOpen(false); }}
    >
      <Avatar initials={u.initials} variant={u.avatar} size="sm" />
      <span className="user-menu-item-text">
        <span className="user-menu-item-name">{u.name}</span>
        <span className="user-menu-item-role">{ROLE_LABELS[u.role]}{u.status === 'invited' ? ' · Invited' : ''}</span>
      </span>
    </button>
  ));

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
      <PopMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        className="user-menu"
        role="menu"
        sheetTitle="Account"
      >
        {authConfigured ? (
          <>
            <div className="user-menu-header">
              <span className="user-menu-caption">Signed in as</span>
              <span className="user-menu-email" title={authenticatedUser?.email}>{authenticatedUser?.email}</span>
            </div>
            {claimRole === 'owner' && (
              <>
                <div className="user-menu-divider" role="separator" />
                <div className="user-menu-header">
                  <span className="user-menu-caption">View as</span>
                </div>
                {viewAsUserId && authenticatedUser && viewAsUserId !== authenticatedUser.id && (
                  <button
                    type="button"
                    className="menu-option"
                    role="menuitem"
                    onClick={() => { setViewAs(null); setOpen(false); }}
                  >
                    <span className="user-menu-item-name">↩ Back to my view</span>
                  </button>
                )}
                {rosterButtons(setViewAs)}
              </>
            )}
            <div className="user-menu-divider" role="separator" />
            <button
              type="button"
              className="menu-option user-menu-signout"
              role="menuitem"
              disabled={signingOut}
              onClick={async () => {
                if (signingOut) return;
                setSigningOut(true);
                try { await signOut(); } finally { setSigningOut(false); setOpen(false); }
              }}
            >
              <Icon name="logout" size={16} />
              <span className="user-menu-item-name">{signingOut ? 'Signing out. Saving changes…' : 'Sign out'}</span>
            </button>
          </>
        ) : (
          <>
            <div className="user-menu-header">
              <span className="user-menu-caption">Switch view (sandbox)</span>
            </div>
            {/* Quick Super Admin <-> Crew toggle: one tap to each perspective so
               the client can experiment as either role. Jumps to the first owner /
               first active crew, so no hardcoded ids. Full roster stays below. */}
            {(() => {
              const owner = users.find((u) => u.role === 'owner');
              const crew = users.find((u) => u.role === 'crew' && u.status !== 'disabled');
              if (!owner || !crew) return null;
              return (
                <div className="user-quick-toggle">
                  <div className="segmented" role="group" aria-label="Switch view">
                    {[owner, crew].map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        role="menuitem"
                        className={`segmented-btn ${u.id === currentUser.id ? 'active' : ''}`}
                        onClick={() => { setCurrentUser(u.id); setOpen(false); }}
                      >
                        {ROLE_LABELS[u.role]}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
            <div className="user-menu-divider" role="separator" />
            <div className="user-menu-header">
              <span className="user-menu-caption">All users</span>
            </div>
            {rosterButtons(setCurrentUser)}
          </>
        )}
      </PopMenu>
    </div>
  );
}
