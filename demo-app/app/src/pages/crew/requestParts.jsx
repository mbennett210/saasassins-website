// The pieces both Client Requests screens draw (pages/crew/CrewRequests — the list — and
// pages/crew/CrewRequest — one request): the page head with its round back button, a request's
// "when" and building, and the request card. Every word is a catalog line (`crewRequests.*`,
// UI_RULES §140); a request's title, details, building and the manager's name travel as written.
// The `.crew-req-` classes are this module's (index.css, UI_RULES §142).
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import Badge from '../../components/Badge';
import { useBackTarget } from '../../hooks/useBackTarget';
import { useFromHere } from '../../hooks/useFromHere';
import { crewPaths } from '../../lib/crewPaths';
import { crewRequestOverdue } from '../../lib/crewRequests';
import { dayKey, addDaysKey } from '../../lib/dates';
import { useT } from '../../i18n/react';

// "Today, 4:15 PM" · "Yesterday, 9:02 AM" · "Mon, Oct 5, 7:30 AM" — in the org's zone.
export function requestWhen(t, iso, now = Date.now()) {
  if (!iso) return '';
  const today = dayKey(new Date(now));
  const k = dayKey(iso);
  if (k === today) return t('crewRequests.when.today', { at: iso });
  if (k === addDaysKey(today, -1)) return t('crewRequests.when.yesterday', { at: iso });
  return t('crewRequests.when.earlier', { at: iso });
}

// The building a request is for (a cleaner may work several).
export function requestPlace(t, r) {
  if (r.clientName && r.siteName && r.siteName !== r.clientName) return t('crewRequests.place', { customer: r.clientName, site: r.siteName });
  return r.clientName || r.siteName || '';
}

// The round back button and the title, as the board draws them (Home is where Back lands from a
// direct link; a referrer wins — hooks/useBackTarget).
export function CrewPageHead({ title, sub, fallback }) {
  const t = useT();
  const { href, label, goBack } = useBackTarget(fallback);
  return (
    <header className="crew-req-head">
      <a className="crew-req-back" href={href} onClick={goBack} aria-label={label || t('back.back')}>
        <Icon name="chevronLeft" size={20} />
      </a>
      <div className="crew-req-head-text">
        <h1 className="crew-req-head-title">{title}</h1>
        {sub ? <p className="crew-req-head-sub">{sub}</p> : null}
      </div>
    </header>
  );
}

export function RequestCard({ r, done = false }) {
  const t = useT();
  const nav = useFromHere();
  const overdue = !done && crewRequestOverdue(r);
  const place = requestPlace(t, r);
  return (
    <article className={`card crew-req-card${overdue ? ' is-overdue' : ''}${done ? ' is-done' : ''}`}>
      <div className="crew-req-card-top">
        {done
          ? <Badge variant="green">{t('crewRequests.completedChip')}</Badge>
          : <Badge variant={overdue ? 'red' : 'amber'}>{overdue ? t('crewRequests.overdue') : t('crewRequests.assigned')}</Badge>}
        <span className="crew-req-when">{done && r.resolvedAt ? requestWhen(t, r.resolvedAt) : requestWhen(t, r.createdAt)}</span>
      </div>
      {place ? <p className="crew-req-place"><Icon name="building" size={14} /> {place}</p> : null}
      <h2 className="crew-req-title">{r.title}</h2>
      {r.description ? <p className="crew-req-desc">{r.description}</p> : null}
      {r.managerName ? <p className="crew-req-from"><Icon name="user" size={14} /> {t('crewRequests.from', { name: r.managerName })}</p> : null}
      <Link className="crew-req-open" to={crewPaths.request(r.id)} state={nav}>
        {done ? t('crewRequests.viewDone') : t('crewRequests.view')} <Icon name="chevronRight" size={16} />
      </Link>
    </article>
  );
}
