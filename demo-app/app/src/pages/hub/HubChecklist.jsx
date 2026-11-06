import { useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { fetchHubChecklist } from '../../lib/clientHubApi';
import { useHubRead, hubWhen } from './hubData';
import HubPhotos from './HubPhotos';
import HubFace from './HubFace';
import { sectionPath } from './hubNav';

// ONE CHECKLIST, ITEM BY ITEM (HUB-8, HUB-15): every item checked or not, the ones that did not
// apply, the cleaner's notes and the item photos. The item states are the office pop-up's own
// rule (checklistResultView via clientHubView.projectHubChecklist), so a property manager and a
// manager reading the same clean are never told different things. The cleaner shows with their
// photo (HUB-19, ./HubFace).
const STATE = {
  done: { label: 'Done', badge: 'green', icon: 'check' },
  na: { label: 'Did not apply', badge: 'slate', icon: null },
  notdone: { label: 'Not done', badge: 'red', icon: 'x' },
};

export default function HubChecklist() {
  const { buildingId, checklistId } = useParams();
  const read = useHubRead(() => fetchHubChecklist(buildingId, checklistId), [buildingId, checklistId]);
  const listHref = sectionPath(buildingId, 'checklists');

  if (read.loading) return <p className="text-muted">Loading the checklist…</p>;
  if (read.error) {
    return (
      <div className="hub-page">
        <BackLink to={listHref} label="Checklists" />
        {read.status === 404
          ? <EmptyState icon={<Icon name="check" size={28} />} title="Checklist not found" message={read.error} />
          : (
            <div className="card hub-card">
              <p className="text-sm">{read.error}</p>
              <button type="button" className="btn btn-outline" onClick={read.reload}>Try again</button>
            </div>
          )}
      </div>
    );
  }

  const c = read.data.checklist;
  return (
    <div className="hub-page">
      <BackLink to={listHref} label="Checklists" />
      <header className="hub-head">
        <h1 className="hub-title">{c.name}</h1>
        <div className="hub-badges">
          <Badge variant={c.complete ? 'green' : 'amber'}>{c.done} of {c.total} done</Badge>
          {c.naCount > 0 && <Badge variant="slate">{c.naCount} did not apply</Badge>}
          {c.notDone > 0 && <Badge variant="red">{c.notDone} not done</Badge>}
        </div>
        <div className="hub-head-sub hub-checklist-by text-xs text-muted">
          <span>{hubWhen(c.performedAt)}</span>
          {c.cleaner && (
            <span className="hub-person">
              <span aria-hidden="true">·</span>
              <HubFace buildingId={buildingId} name={c.cleaner} photo={c.cleanerPhoto} size="xs" />
              <span>{c.cleaner}</span>
            </span>
          )}
        </div>
      </header>

      {!c.hasSchema && (
        <p className="text-sm text-muted">This checklist was filled before its items were recorded one by one, so only its total is shown.</p>
      )}

      {c.areas.map((a) => (
        <section key={a.id} className="card hub-card">
          <div className="hub-area-head">
            <h2 className="hub-card-title">{a.label}</h2>
            <span className="text-xs text-muted tnum">{a.done} of {a.total}</span>
          </div>
          <ul className="hub-items">
            {a.items.map((i) => {
              const s = STATE[i.state] || STATE.notdone;
              return (
                <li key={i.key} className={`hub-item ${i.state}`}>
                  <div className="hub-item-top">
                    <span className="hub-item-label">{i.label}</span>
                    <Badge variant={s.badge}>{s.icon ? <Icon name={s.icon} size={12} /> : null} {s.label}</Badge>
                  </div>
                  {i.note && <div className="hub-item-note text-sm">“{i.note}”</div>}
                  {i.needsPhoto && i.state === 'notdone' && !i.photos.length && (
                    <div className="text-xs text-muted">This item needs a photo, and none was taken.</div>
                  )}
                  <HubPhotos photos={i.photos} label={`Photos: ${i.label}`} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
