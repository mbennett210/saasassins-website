// THE CLIENT HUB'S ACTION SLOTS — where the Message button, the Call button and the bell go
// (the client hub redesign, plan §3.1, 2026-10-08). Each is ONE list, read by every place that
// shows it, so a new control is one entry here and appears everywhere it should.
//
// HUB_ACTIONS — the Message + Call row: the desktop Home top bar (beside the property switcher),
//   the phone's Home row under the switcher, and Today's Visit under its photos. Ordered by
//   `order`; each Component gets { building, preview, readOnly, round } (readOnly: the office's
//   read-only preview, the layout's one flag — a write control disables itself on it, UI_RULES
//   §151; round: the icon alone in a circle, for the phone's "Your Account Manager" card, which
//   takes the row's place while the building has a manager — ./HubAccountManager.jsx, HUB-19).
//     Builder B: Message — { key: 'message', order: 10, Component: HubMessageButton }
// HUB_BELL — the notifications bell: the end of the desktop Home top bar and the phone's top bar.
//   Each Component gets { building, preview, readOnly }.
//     Builder B: { key: 'bell', Component: HubBell }
// (No placeholder entries: a control is listed the day it exists.)
import HubCallButton from './HubCallButton';
import HubMessageButton from './HubMessageButton';
import HubBell from './HubBell';

export const HUB_ACTIONS = Object.freeze([
  { key: 'message', order: 10, Component: HubMessageButton },
  { key: 'call', order: 20, Component: HubCallButton },
]);

export const HUB_BELL = Object.freeze([
  { key: 'bell', Component: HubBell },
]);

export const hubActions = () => [...HUB_ACTIONS].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
