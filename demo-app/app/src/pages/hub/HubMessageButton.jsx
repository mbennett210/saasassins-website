import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useFromHere } from '../../hooks/useFromHere';
import { sectionPath } from './hubNav';

// MESSAGE (the redesign's Message + Call row, plan §3.4): opens the building's thread with the
// office. The HUB_ACTIONS slot (./hubSlots.js) places it on Home and Today's Visit, before Call.
// It carries its referrer, so the Messages page's back arrow returns to where it was tapped.
//
// `round`: the icon alone in a circle, for the phone's "Your Account Manager" row (HUB-19, Matt's
// Option 2 as Daniel picked it, "B · Slim row", 2026-11-02); its name is said to a screen reader.
export default function HubMessageButton({ building, round = false }) {
  const nav = useFromHere();
  if (!building?.id) return null;
  const to = sectionPath(building.id, 'messages');
  if (round) {
    const who = building.supervisor?.name || 'your account manager';
    return (
      <Link className="btn btn-outline hub-round" to={to} state={nav} title={`Message ${who}`} aria-label={`Message ${who}`}>
        <Icon name="messaging" size={18} />
      </Link>
    );
  }
  return (
    <Link className="btn btn-outline hub-action" to={to} state={nav} aria-label="Message account manager">
      <Icon name="messaging" size={16} /> Message
    </Link>
  );
}
