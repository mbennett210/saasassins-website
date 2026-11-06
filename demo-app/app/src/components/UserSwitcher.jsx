import { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import PopMenu from './PopMenu';
import PickerCapNote from './PickerCapNote';
import { useAuth } from '../hooks/useAuth';
import { useStore } from '../store';
import { selectUsers } from '../store/selectors';
import { roleLabel, memberRoleLabel, compareUsersByName } from '../lib/roles';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import { useT } from '../i18n/react';
import { usePermission } from '../hooks/usePermission';
import { clearHubPreview } from '../lib/hubPreview';
import Avatar from './Avatar';
import Badge from './Badge';
import Icon from './Icon';
import HubPreviewPicker from './HubPreviewPicker';

// The signed-in user chip. In authed (Supabase) mode it shows who you are + Sign
// out; an OWNER additionally gets a "View as" switcher that re-renders the app
// from any team member's role perspective. This is VIEW-ONLY — the server still
// enforces the real owner claim (app_metadata), so it cannot escalate privilege;
// it only changes the perspective the UI is drawn from. In local (no-Supabase)
// mode it falls back to the demo user-switcher so role behavior can be exercised
// without real accounts.
// The demo's way into the CUSTOMER hub (Phase 2 Wave 2 Round 2): a DEMO build only — the
// static `import.meta.env.MODE`, which folds to false in `npm run build`, so production never
// carries the entry (HubRoot holds the same gate). It opens the hub as the demo's customer
// contact, so it ends any office preview this tab was in first.
//
// THE LIVE APP'S WAY IN (the client hub redesign, plan §3.7 "Preview as customer"): for a holder
// of `hub.users.view`, "Preview the customer hub" opens a building picker (HubPreviewPicker), and
// the hub then shows that one building as its customers see it, read-only. The server checks the
// key again on every read (api/_lib/authz.js requireHubCaller).
const HUB_PREVIEW = import.meta.env.MODE === 'demo';

export default function UserSwitcher() {
  const navigate = useNavigate();
  const t = useT();
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const canPreviewHub = usePermission('hub.users.view');
  const ref = useRef(null);
  // The roster by name, searched, never all of it at once (UI_RULES §127; CS-722: View as drew
  // 1,544 rows): typing narrows first, then the first PICKER_MAX_VISIBLE show with the footnote.
  const [rosterQuery, setRosterQuery] = useState('');
  const roster = useMemo(() => {
    const q = rosterQuery.trim().toLowerCase();
    return (users || [])
      .filter((u) => u.status !== 'disabled' && (!q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)))
      .sort(compareUsersByName);
  }, [users, rosterQuery]);
  const { shown, noteMsg } = useMemo(() => capOptions(roster, PICKER_MAX_VISIBLE), [roster]);
  useEffect(() => { if (open) setRosterQuery(''); }, [open]);

  if (!currentUser) return null;

  // The roster picker, shared by the authed "View as" switcher and the local sandbox switcher —
  // the only difference is which action the pick dispatches.
  const rosterSearch = (
    <>
      <input
        className="input select-search"
        type="search"
        value={rosterQuery}
        onChange={(e) => setRosterQuery(e.target.value)}
        placeholder={t('common.typeToFilter')}
        aria-label={t('common.typeToFilter')}
      />
      <PickerCapNote note={noteMsg} />
    </>
  );
  const rosterButtons = (onPick) => shown.map((u) => (
    <button
      key={u.id}
      type="button"
      className={`menu-option ${u.id === currentUser.id ? 'active' : ''}`}
      role="menuitem"
      onClick={() => { onPick(u.id); setOpen(false); }}
    >
      <Avatar user={u} size="sm" />
      <span className="user-menu-item-text">
        <span className="user-menu-item-name">{u.name}</span>
        <span className="user-menu-item-role">{memberRoleLabel(t, u)}{u.status === 'invited' ? ` · ${t('userMenu.invited')}` : ''}</span>
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
        <Avatar user={currentUser} size="sm" />
        <span className="user-chip-text">
          <span className="user-chip-name">{currentUser.name}</span>
          <span className="user-chip-role">{memberRoleLabel(t, currentUser)}</span>
        </span>
        <span className="user-chip-caret" aria-hidden>▾</span>
      </button>
      <PopMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        className="user-menu"
        role="menu"
        sheetTitle={t('userMenu.account')}
      >
        {authConfigured ? (
          <>
            <div className="user-menu-header">
              <span className="user-menu-caption">{t('userMenu.signedInAs')}</span>
              <span className="user-menu-email" title={authenticatedUser?.email}>{authenticatedUser?.email}</span>
            </div>
            {claimRole === 'owner' && (
              <>
                <div className="user-menu-divider" role="separator" />
                <div className="user-menu-header">
                  <span className="user-menu-caption">{t('userMenu.viewAs')}</span>
                </div>
                {viewAsUserId && authenticatedUser && viewAsUserId !== authenticatedUser.id && (
                  <button
                    type="button"
                    className="menu-option"
                    role="menuitem"
                    onClick={() => { setViewAs(null); setOpen(false); }}
                  >
                    <span className="user-menu-item-name">{t('userMenu.backToMine')}</span>
                  </button>
                )}
                {rosterSearch}
                {rosterButtons(setViewAs)}
              </>
            )}
            {canPreviewHub && (
              <>
                <div className="user-menu-divider" role="separator" />
                <HubPreviewEntry t={t} onClick={() => { setOpen(false); setPickerOpen(true); }} />
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
              <span className="user-menu-item-name">{signingOut ? t('userMenu.signingOut') : t('userMenu.signOut')}</span>
            </button>
          </>
        ) : (
          <>
            <div className="user-menu-header">
              <span className="user-menu-caption">{t('userMenu.sandbox')}</span>
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
                  <div className="segmented" role="group" aria-label={t('userMenu.switchView')}>
                    {[owner, crew].map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        role="menuitem"
                        className={`segmented-btn ${u.id === currentUser.id ? 'active' : ''}`}
                        onClick={() => { setCurrentUser(u.id); setOpen(false); }}
                      >
                        {roleLabel(t, u.role)}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
            <div className="user-menu-divider" role="separator" />
            <div className="user-menu-header">
              <span className="user-menu-caption">{t('userMenu.allUsers')}</span>
            </div>
            {rosterSearch}
            {rosterButtons(setCurrentUser)}
            {HUB_PREVIEW && (
              <>
                <div className="user-menu-divider" role="separator" />
                <HubPreviewEntry t={t} onClick={() => { setOpen(false); clearHubPreview(); navigate('/hub'); }} />
              </>
            )}
          </>
        )}
      </PopMenu>
      {authConfigured && canPreviewHub && <HubPreviewPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

// The way into the CUSTOMER's view, set apart from the team rows above it (Daniel, 2026-10-09:
// "add a highlight on it so Matt can easily see that's the customer view"): the same amber wash
// as the hub's preview strip and banner, and a "Customer view" badge, so the row reads as a
// different place to go rather than one more person to view the app as.
function HubPreviewEntry({ t, onClick }) {
  return (
    <button type="button" className="menu-option user-menu-hub" role="menuitem" onClick={onClick}>
      <Icon name="building" size={16} />
      <span className="user-menu-item-text">
        <span className="user-menu-item-name">{t('userMenu.previewHub')}</span>
        <Badge variant="amber">{t('userMenu.customerView')}</Badge>
      </span>
    </button>
  );
}
