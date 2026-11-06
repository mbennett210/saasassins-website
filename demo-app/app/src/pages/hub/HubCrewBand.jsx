import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useFromHere } from '../../hooks/useFromHere';
import { sectionPath } from './hubNav';
import { CREW_LOOK, crewLine, hubTime, timelinessText } from './hubData';
import HubFace from './HubFace';

// THE CREW STATUS BAND (Matt's boards mobile-01/-03, web-01/-02): "Same card, same position on
// Home, both mobile and web — only the color, icon, and copy change based on visit status." The
// state and every word's source is ONE rule (lib/hubVisit.js), served by /api/hub/home and
// /api/hub/visit; this only draws it.
//
//   variant 'home'   the Home band: "CREW STATUS", the state, its line, and the way to the
//                    visit timeline (tap 2, Matt's note s1). The whole band is the link.
//   variant 'visit'  Today's Visit's head: "LIVE" while on site, "Crew on site now", the arrival
//                    with how early, and the lead's face with "+N" for the rest: their photo over
//                    their initials (./HubFace; Matt's HUB-19 answer, "a photo next to each
//                    cleaner's name").
export default function HubCrewBand({ crew, buildingId, variant = 'home' }) {
  const nav = useFromHere();
  const state = crew?.state || 'none';
  const look = CREW_LOOK[state] || CREW_LOOK.none;
  const live = state === 'on_site';

  if (variant === 'visit') {
    const arrived = live || state === 'done'
      ? [`Arrived ${hubTime(crew?.arrivedAt)}`, timelinessText(crew?.timeliness)].filter(Boolean).join(', ')
      : crewLine(crew);
    const people = crew?.crew;
    return (
      <section className={`hub-crew hub-crew-visit is-${look.tone}`} aria-live="polite">
        <span className="hub-crew-icon" aria-hidden><Icon name={look.icon} size={22} />{live && <span className="hub-crew-dot" />}</span>
        <div className="hub-crew-text">
          <div className="hub-crew-kicker text-xs">{live ? 'Live' : 'Crew status'}</div>
          <div className="hub-crew-title">{live ? 'Crew on site now' : look.title}</div>
          <div className="hub-crew-line text-sm">{arrived}{state === 'done' && crew?.checkedOutAt ? ` · Checked out ${hubTime(crew.checkedOutAt)}` : ''}</div>
          {people?.lead && (
            <div className="hub-crew-people text-sm">
              <span className="hub-crew-faces" aria-hidden>
                <HubFace buildingId={buildingId} initials={people.initials?.[0] || ''} photo={people.photos?.[0] || null} className="hub-crew-face" />
                {people.others > 0 && <span className="hub-crew-face">+{people.others}</span>}
              </span>
              <span>{people.others ? `${people.lead} and team` : people.lead}</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <Link className={`hub-crew is-${look.tone}`} to={sectionPath(buildingId, 'visit')} state={nav}>
      <span className="hub-crew-icon" aria-hidden><Icon name={look.icon} size={22} />{live && <span className="hub-crew-dot" />}</span>
      <span className="hub-crew-text">
        <span className="hub-crew-kicker text-xs">Crew status{live ? ' · Live' : ''}</span>
        <span className="hub-crew-title">{look.title}</span>
        <span className="hub-crew-line text-sm">{crewLine(crew)}</span>
      </span>
      <span className="hub-crew-go text-sm">
        <span className="hub-only-desktop">View visit timeline →</span>
        <span className="hub-only-phone" aria-hidden><Icon name="chevronRight" size={20} /></span>
      </span>
    </Link>
  );
}
