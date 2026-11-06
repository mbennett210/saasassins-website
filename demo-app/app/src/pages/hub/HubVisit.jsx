import { useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { fetchHubVisit } from '../../lib/clientHubApi';
import { fmtDuration } from '../../lib/dates';
import { buildingPath } from './hubNav';
import { hubActions } from './hubSlots';
import { useHub, useHubRead, useHubRefresh, hubVisitDay, hubTime, stepText } from './hubData';
import HubCrewBand from './HubCrewBand';
import HubFace from './HubFace';
import HubSectionHead from './HubSectionHead';

// TODAY'S VISIT — the crew status's second tap (Matt's boards mobile-02 / web-02, plan §3.2,
// 2026-10-08): the live band, the visit timeline, who is on site (HUB-5: first name + last
// initial, how long, and the location check), the visit's own before/after photos, Message + Call
// with "Account Manager · Dana K.", and the next three visits. Each person's photo shows over
// their initials (HUB-19, ./HubFace).
//
// The timeline follows the cleaner's save: there is no live item count — a checklist is done when
// it is saved (Daniel, 2026-10-08). The photos are the ones the crew takes in the guided visit
// (before on arrival, after at the end), so the caption says so; the board's "Uploaded by the
// crew when the checklist is complete" is not true of a before photo.
//
// Read from GET /api/hub/visit (or the demo's twin), and again every minute while open.
export default function HubVisit() {
  const { buildingId } = useParams();
  const { building, preview, readOnly } = useHub();
  const read = useHubRead(() => fetchHubVisit(buildingId), [buildingId]);
  useHubRefresh(read.reload);
  const back = <BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />;

  if (read.loading) return <div className="hub-page">{back}<p className="text-muted">Loading today's visit…</p></div>;
  if (read.error) {
    return (
      <div className="hub-page">
        <HubSectionHead back={back} title="Today's Visit" building={building} />
        {read.status === 404
          ? <EmptyState icon={<Icon name="building" size={28} />} title="Building not found" message={read.error} />
          : (
            <div className="card hub-card">
              <p className="text-sm">{read.error}</p>
              <button type="button" className="btn btn-outline" onClick={read.reload}>Try again</button>
            </div>
          )}
      </div>
    );
  }

  const v = read.data;
  const crew = v.crew;
  const hasVisit = crew?.state && crew.state !== 'none';
  return (
    <div className="hub-page hub-visit">
      <HubSectionHead back={back} title="Today's Visit" building={building} />
      <HubCrewBand crew={crew} buildingId={buildingId} variant="visit" />

      <div className="hub-visit-grid">
        <section className="card hub-card hub-visit-timeline">
          <h2 className="hub-card-title">Visit timeline</h2>
          {hasVisit ? <Timeline steps={v.timeline} crew={crew} /> : (
            <p className="text-sm text-muted">No visit today. The next one shows here on its day.</p>
          )}
          {v.onSite?.length > 0 && <OnSite people={v.onSite} buildingId={buildingId} />}
        </section>

        <section className="card hub-card hub-visit-photos">
          <h2 className="hub-card-title">Photos from today</h2>
          <VisitPhotos photos={v.photos} />
          <div className="hub-actions hub-visit-actions">
            {hubActions().map((a) => <a.Component key={a.key} building={building} preview={preview} readOnly={readOnly} />)}
          </div>
          <div className="hub-visit-manager text-xs">
            {v.manager ? (
              <>
                <HubFace buildingId={buildingId} name={v.manager.name} photo={v.manager.photo} size="xs" />
                <span>Account Manager · {v.manager.name}</span>
              </>
            ) : 'Your account team'}
          </div>
        </section>
      </div>

      <section className="card hub-card">
        <h2 className="hub-card-title">Upcoming visits</h2>
        {v.upcoming?.length ? (
          <ul className="hub-upcoming">
            {v.upcoming.map((u) => (
              <li key={u.startAt} className="hub-upcoming-item">
                <span className="hub-upcoming-icon" aria-hidden><Icon name="schedule" size={18} /></span>
                <span className="hub-upcoming-text">
                  <span className="hub-upcoming-day">{hubVisitDay(u.startAt)}</span>
                  <span className="text-xs text-muted">{hubTime(u.startAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">No upcoming visits scheduled.</p>}
      </section>
    </div>
  );
}

// The visit's steps, each done, under way or pending (lib/hubVisit.js).
function Timeline({ steps, crew }) {
  return (
    <ol className="hub-timeline" aria-label="Visit timeline">
      {(steps || []).map((s) => {
        const { label, detail } = stepText(s, crew);
        return (
          <li key={s.key} className={`hub-tl-step is-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="hub-tl-dot" aria-hidden />
            <span className="hub-tl-text">
              <span className="hub-tl-label">{label}</span>
              <span className="hub-tl-detail text-xs">{detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// HUB-5: who is on site now — first name + last initial, how long, and whether the clock-in passed
// the location check, with their photo (HUB-19). Nothing else.
function OnSite({ people, buildingId }) {
  return (
    <div className="hub-onsite-block">
      <div className="hub-sup-label text-xs">On site now</div>
      <ul className="hub-onsite">
        {people.map((p, i) => (
          <li key={`${p.name}-${p.since}-${i}`} className="hub-onsite-row">
            <div className="hub-onsite-person">
              <HubFace buildingId={buildingId} name={p.name} photo={p.photo} size="md" />
              <div className="hub-onsite-who">
                <span className="hub-onsite-name">{p.name}</span>
                <span className="text-xs text-muted">on site {fmtDuration(p.minutesOnSite)}</span>
              </div>
            </div>
            {p.locationVerified
              ? <Badge variant="green">Location verified</Badge>
              : <Badge variant="slate">Location not verified</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// BEFORE / AFTER / +N, as drawn. Each photo opens full size (a short-lived signed URL).
function VisitPhotos({ photos }) {
  const before = photos?.before || [];
  const after = photos?.after || [];
  const more = photos?.more || 0;
  if (!before.length && !after.length) return <p className="text-sm text-muted">Photos show here as the crew takes them.</p>;
  const tile = (p, tag) => (
    <a key={p.id} className="hub-visit-photo" href={p.url || p.thumbUrl} target="_blank" rel="noopener noreferrer">
      <img src={p.thumbUrl || p.url} alt={p.caption || `${tag} photo`} loading="lazy" />
      <span className="hub-visit-photo-tag text-xs">{tag}</span>
    </a>
  );
  return (
    <>
      <div className="hub-visit-photo-grid">
        {before.map((p) => tile(p, 'Before'))}
        {after.map((p) => tile(p, 'After'))}
        {more > 0 && <span className="hub-visit-photo is-more">+{more}</span>}
      </div>
      <p className="text-xs text-muted">Taken by the crew before and after the clean.</p>
    </>
  );
}
