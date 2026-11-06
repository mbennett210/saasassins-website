import { useLocation } from 'react-router-dom';
import Icon from './Icon';
import SyncIndicator from './SyncIndicator';
import { useAuth } from '../hooks/useAuth';
import { useBackTarget } from '../hooks/useBackTarget';
import { useCrewPreview } from '../hooks/useCrewPreview';
import { crewPaths, isCrewAppPath } from '../lib/crewPaths';
import { useT } from '../i18n/react';

// The crew shell's chrome (the Cleaner Hub, 2026-10-13; UI_RULES §165). A cleaner's app has no
// sidebar and no tab bar (plan D6): Home is the hub, and every screen has a way back. Three pieces,
// one file, so the shell's whole frame reads in one place:
//
//   CrewPreviewLine  the owner's View-as a cleaner is a PREVIEW (D8): one line says whose app this
//                    is and that actions are off, with the way back to their own view (the
//                    sidebar's switcher is not drawn here).
//   CrewBackBar      an office page a cleaner can open that has no back of its own (Messages,
//                    Settings, Keys, Deliveries, Quality, a page that isn't found) gets a slim
//                    "← Home" bar — to where they came from when there is a referrer, else Home.
//   CrewPageHead     the cleaner-app screens' own header: a round back button, the title and the
//                    line under it, and a slot on the right.

// The pages that already draw a back of their own, so the bar would be a second one (UI_RULES
// §108, one back per page): a clean's page (DetailHeader), a settings page under the hub
// (SettingsLayout's BackLink, or the detail's DetailHeader), and an open conversation (its own back
// on a phone — CSS hides the bar there below the single-pane width, where that back shows).
// Every cleaner-app screen under /my-day draws CrewPageHead.
const HAS_OWN_BACK = [/^\/schedule\/[^/]+/, /^\/settings\/.+/];
export function needsCrewBackBar(pathname) {
  const p = String(pathname || '');
  if (isCrewAppPath(p)) return false;
  return !HAS_OWN_BACK.some((re) => re.test(p));
}

export function CrewPreviewLine() {
  const t = useT();
  const { previewing, name } = useCrewPreview();
  const { setViewAs } = useAuth();
  if (!previewing) return null;
  return (
    <div className="crew-shell-preview" role="status">
      <Icon name="user" size={15} />
      <span className="crew-shell-preview-text">{t('crewShell.preview', { name })}</span>
      <button type="button" className="btn btn-link" onClick={() => setViewAs(null)}>{t('userMenu.backToMine')}</button>
    </div>
  );
}

export function CrewBackBar() {
  const t = useT();
  const { pathname } = useLocation();
  const { href, label, goBack } = useBackTarget(crewPaths.home(), t('crewShell.home'));
  if (!needsCrewBackBar(pathname)) return null;
  return (
    <div className="crew-shell-backbar">
      <a className="crew-shell-back" href={href} onClick={goBack}>
        <Icon name="chevronLeft" size={18} />
        <span>{label}</span>
      </a>
      <SyncIndicator />
    </div>
  );
}

// `backTo` is where the round button goes with no referrer (Home by default); the referrer wins
// (hooks/useBackTarget), so a stop opened from Today's Stops goes back there.
export function CrewPageHead({ title, sub = null, backTo = null, right = null }) {
  const t = useT();
  const { href, label, goBack } = useBackTarget(backTo || crewPaths.home(), t('crewShell.home'));
  return (
    <header className="crew-shell-head">
      <a className="crew-shell-head-back" href={href} onClick={goBack} aria-label={t('crewShell.backTo', { place: label })}>
        <Icon name="chevronLeft" size={20} />
      </a>
      <div className="crew-shell-head-text">
        <h1 className="crew-shell-head-title">{title}</h1>
        {sub ? <p className="crew-shell-head-sub">{sub}</p> : null}
      </div>
      <div className="crew-shell-head-right">
        <SyncIndicator />
        {right}
      </div>
    </header>
  );
}
