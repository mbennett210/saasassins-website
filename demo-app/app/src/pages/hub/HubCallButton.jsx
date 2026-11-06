import { IDENTITY } from '../../brand/identity.generated.js';
import Icon from '../../components/Icon';

// CALL (HUB-18, the redesign's Message + Call row): the building's account manager's OWN phone,
// from their profile (the view's projected supervisor — only while they are still the building's
// manager, decision D4); with no manager, or none on file, the company's main number. A real tel:
// link, one tap on a phone, the whole point of HUB-12 / HUB-18.
//
// `round`: the icon alone in a circle, for the phone's "Your Account Manager" row (HUB-19, Matt's
// Option 2 as Daniel picked it, "B · Slim row", 2026-11-02); its name is said to a screen reader.
export default function HubCallButton({ building, round = false }) {
  const own = building?.supervisor?.phone || '';
  const phone = own || IDENTITY.company.phone || '';
  const dial = String(phone).replace(/[^\d+]/g, '');
  if (!dial) return null;
  const who = own && building?.supervisor?.name ? building.supervisor.name : 'the office';
  if (round) {
    return (
      <a className="btn btn-primary hub-round" href={`tel:${dial}`} title={`Call ${who}`} aria-label={`Call ${who}`}>
        <Icon name="phone" size={18} />
      </a>
    );
  }
  return (
    <a className="btn btn-primary hub-action" href={`tel:${dial}`} title={`Call ${who}`}>
      <Icon name="phone" size={16} /> Call
    </a>
  );
}
