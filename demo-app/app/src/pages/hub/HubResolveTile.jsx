import { english } from '../../i18n/core';
import { formatResolveDuration } from '../../lib/resolveTime';
import { sectionPath } from './hubNav';
import HubTile from './HubTile';

// Home's TIME-TO-RESOLVE tile (Matt, the Oct 6 call: "The clients can see … how long Clean Space
// takes to resolve your issues. On average, 22 minutes."; plan 2026-10-11 §4). "Average time to
// resolve", the figure ("22 min") and "5 requests closed in the last 30 days"; with none closed,
// "No requests closed in the last 30 days." alone — never a made-up zero.
//
// The figure covers only the building's requests from the hub (D11), so the customer can check it
// against their own Requests list, which the tile opens. It reads Home's own answer (`home.resolve`,
// GET /api/hub/home, built by lib/hubHome hubResolveTile on the server and in the demo), so it
// costs no read of its own. Its words are catalog lines rendered in English: everything a customer
// reads stays English (LANG-8, UI_RULES §140).
//
// Beside Requests from the desktop up; on a phone a full-width row under the first pair of tiles
// (HubHome gives it a wide slot, which the stylesheet narrows back to one tile from 641px, and the
// grid's dense flow lifts the next tile up beside Requests).
export default function HubResolveTile({ building, home }) {
  const r = home?.resolve;
  let body;
  if (!r) body = english('common.loading');
  else if (!r.count) body = english('resolveTime.hub.none', { days: r.days });
  else {
    body = (
      <>
        <span className="hub-tile-figure">{formatResolveDuration(r.meanMs)}</span>
        <span className="hub-tile-line text-muted">{english('resolveTime.hub.closed', { count: r.count, days: r.days })}</span>
      </>
    );
  }
  return (
    <div className="hub-tile-frame">
      <HubTile
        to={sectionPath(building.id, 'tickets')}
        icon="clock"
        tone="blue"
        title={english('resolveTime.hub.title')}
        cta={english('resolveTime.hub.cta')}
      >
        {body}
      </HubTile>
    </div>
  );
}
