import { hubActions } from './hubSlots';
import HubFace from './HubFace';

// "YOUR ACCOUNT MANAGER" ON HOME (HUB-19 — Matt's Option 2 of 2026-11-02, the take Daniel picked,
// "B · Slim row", with the name as first name + last initial): the building's manager, only while
// they are still one (decision D4: the projected supervisor), with their photo (./HubFace).
//   · HubManagerCard, the phone: one slim card under the property switcher with the face, "Your
//     Account Manager", the name and the Message + Call slots (./hubSlots.js) as round buttons. It
//     takes the place of the phone's Message + Call row, which Home hides while it shows.
//   · HubManagerLine, the computer: one line under the building's name in the greeting; Message
//     and Call stay in the top bar.
// A building with no manager shows neither, and Message and Call stay as they were (they reach the
// office).
const managerOf = (building) => (building?.supervisor?.name ? building.supervisor : null);

export function HubManagerCard({ building, preview, readOnly }) {
  const m = managerOf(building);
  if (!m) return null;
  return (
    <section className="hub-am hub-only-phone" aria-label="Your Account Manager">
      <HubFace buildingId={building.id} name={m.name} photo={m.photo} className="avatar avatar-1 hub-face-am" />
      <div className="hub-am-text">
        <span className="hub-am-kicker text-xs">Your Account Manager</span>
        <span className="hub-am-name">{m.name}</span>
      </div>
      <div className="hub-am-actions">
        {hubActions().map((a) => <a.Component key={a.key} building={building} preview={preview} readOnly={readOnly} round />)}
      </div>
    </section>
  );
}

export function HubManagerLine({ building }) {
  const m = managerOf(building);
  if (!m) return null;
  return (
    <div className="hub-am-line text-sm">
      <HubFace buildingId={building.id} name={m.name} photo={m.photo} className="avatar avatar-1 hub-face-line" />
      <span className="hub-am-line-text">
        <span className="text-muted">Your Account Manager</span> · <strong>{m.name}</strong>
      </span>
    </div>
  );
}

export const hasHubManager = (building) => !!managerOf(building);
