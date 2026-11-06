// A customer's satisfaction-survey answers (Matt's approved messages, 2026-10-19): the customer
// page's Activity → Surveys. Every survey sent to them, newest first — its rating (1–5) and
// comment once answered, else "Not answered" (or "Closed" once the link has expired). Read from
// EP-426 (qc.view + an office role); mounted only while its tab is open, so an unopened tab makes
// no request. A failed read says so with Try again, never "No surveys yet".
import { useEffect, useState } from 'react';
import Badge from './Badge';
import EmptyState from './EmptyState';
import ListPager from './ListPager';
import { usePagedRows } from '../hooks/usePagedRows';
import { fmtDate } from '../lib/dates';
import { listClientSurveys } from '../lib/surveysApi';

const variantFor = (rating) => (rating >= 4 ? 'green' : rating === 3 ? 'amber' : 'red');

export default function ClientSurveys({ client }) {
  const [load, setLoad] = useState({ rows: null, error: null });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    listClientSurveys(client.id)
      .then((r) => { if (alive) setLoad({ rows: r.surveys || [], error: null }); })
      .catch((e) => { if (alive) setLoad({ rows: null, error: e }); });
    return () => { alive = false; };
  }, [client.id, reload]);
  const rows = load.rows || [];
  const pager = usePagedRows(rows, { resetKey: client.id });
  const answered = rows.filter((r) => r.rating);
  const average = answered.length ? (answered.reduce((s, r) => s + r.rating, 0) / answered.length) : null;

  if (load.error) {
    return (
      <div className="card detail-card">
        <p className="form-error">The survey answers couldn’t load.</p>
        <button type="button" className="btn btn-outline" onClick={() => { setLoad({ rows: null, error: null }); setReload((k) => k + 1); }}>Try again</button>
      </div>
    );
  }
  if (!load.rows) return <div className="card detail-card text-muted">Loading the survey answers…</div>;
  if (!rows.length) {
    return <EmptyState icon="check" title="No surveys yet" description="A short satisfaction survey is emailed to this customer every three months once Settings → Customer Reminders has it on." />;
  }
  return (
    <div className="card detail-card">
      <div className="section-head">
        <h3>Satisfaction surveys</h3>
        {average != null && <Badge variant={variantFor(Math.round(average))}>{`Average ${average.toFixed(1)} of 5 · ${answered.length} answered`}</Badge>}
      </div>
      <div className="mobile-stack">
        <table className="table">
          <thead>
            <tr><th>Sent</th><th>Rating</th><th>Comment</th><th>Answered</th></tr>
          </thead>
          <tbody>
            {pager.pageRows.map((s) => (
              <tr key={s.id}>
                <td data-label="Sent">{fmtDate(s.sentAt)}</td>
                <td data-label="Rating">
                  {s.rating
                    ? <Badge variant={variantFor(s.rating)}>{`${s.rating} of 5`}</Badge>
                    : <Badge variant="slate">{Date.parse(s.expiresAt) < Date.now() ? 'Closed' : 'Not answered'}</Badge>}
                </td>
                <td data-label="Comment">{s.comment || <span className="text-muted">—</span>}</td>
                <td data-label="Answered">{s.answeredAt ? fmtDate(s.answeredAt) : <span className="text-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun="surveys" />
    </div>
  );
}
