// Client Requests — the cleaner's list (Matt's Cleaner Hub board "Client Requests"; plan
// docs/plans/2026-10-13-cleaner-hub.md §3 D3, brief C §2). PHONE FIRST: designed at 390 × 844.
//
// What the office routed to this cleaner (`problem_reports.crew_user_ids`, set from the work-order
// drawer): a card per open request — "Assigned to you" (red "Overdue" past its deadline), when it
// came in, the building, the title and its details, "From {First L.}, your account manager", and
// "View & complete →" to the request page. Then the ones completed this week. Every word is a
// catalog line (`crewRequests.*`, UI_RULES §140); titles, details, names and buildings travel as
// written (LANG-7).
//
// ONE read (hooks/useMyRequests — GET /api/qc/problems/mine, EP-380), shared with the request page
// and Home's tile; the phone keeps the last answer, so with no signal the list still shows, said as
// such. The owner's View-as reads the person on screen (the server allows it with problems.manage).
import { useMyRequests } from '../../hooks/useMyRequests';
import { crewPaths } from '../../lib/crewPaths';
import { useT } from '../../i18n/react';
import { CrewPageHead, RequestCard } from './requestParts';

export default function CrewRequests() {
  const t = useT();
  const { data, loading, error, offline, savedAt, refresh } = useMyRequests();
  const open = data?.open || [];
  const done = data?.recentDone || [];
  return (
    <div className="page page-narrow crew-req-page">
      <CrewPageHead title={t('crewRequests.title')} fallback={crewPaths.home()} />

      {savedAt ? <p className="crew-req-note" role="status">{t('crewRequests.offlineKept', { at: savedAt })}</p> : null}

      {!data ? (
        loading ? <p className="text-muted text-sm">{t('common.loading')}</p>
          : offline ? <p className="crew-req-note" role="status">{t('crewRequests.offlineNone')}</p>
            : (
              <div className="crew-req-failed" role="alert">
                <p>{t('crewRequests.loadFailed')}</p>
                {error ? <button type="button" className="btn btn-primary crew-req-retry" onClick={refresh}>{t('crewRequests.tryAgain')}</button> : null}
              </div>
            )
      ) : (
        <>
          <p className="crew-req-count">{t('crewRequests.count', { count: open.length })}</p>
          <div className="crew-req-list">
            {open.map((r) => <RequestCard key={r.id} r={r} />)}
          </div>
          <p className="crew-req-empty">{t('crewRequests.empty')}</p>
          {done.length ? (
            <section className="crew-req-done" aria-labelledby="crew-req-done-h">
              <h2 id="crew-req-done-h" className="crew-req-section">{t('crewRequests.doneHeading')}</h2>
              <div className="crew-req-list">
                {done.map((r) => <RequestCard key={r.id} r={r} done />)}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
