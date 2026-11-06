// The satisfaction survey at /survey/:token (Matt's approved messages, 2026-10-19): the customer
// opens the link in their quarterly email — no sign-in, no app shell; the link's token is the
// capability (EP-424 reads it, EP-425 records the answer). A 1–5 rating and an optional comment;
// the answer can be changed from the same link until it closes. English (LANG-8): the words are
// catalog lines (publicSurvey.*) rendered in English, as the shared inspection report's are.
//
// WHY THERE IS NO SURVEY, told apart (the PublicInspection pattern): 400/404 = the link names no
// survey ("not found"); 410 = it closed; anything else, or no answer at all, is a try-again
// sentence with a Try again button.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { english } from '../i18n/core';
import { getPublicSurvey, answerPublicSurvey } from '../lib/surveysApi';

const NOT_FOUND = new Set([400, 404]);
const RATINGS = [1, 2, 3, 4, 5];

function Card({ children }) {
  return <div className="public-report"><div className="public-report-card public-survey">{children}</div></div>;
}

export default function PublicSurvey() {
  const { token } = useParams();
  // loading | open | answered | expired | not-found | unavailable
  const [view, setView] = useState({ status: 'loading' });
  const [rating, setRating] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setView({ status: 'loading' });
    getPublicSurvey(token)
      .then((s) => {
        if (!alive) return;
        setView({ status: s.state, company: s.company || '' });
        if (s.rating) setRating(s.rating);
        if (s.comment) setComment(s.comment);
      })
      .catch((e) => { if (alive) setView({ status: NOT_FOUND.has(Number(e?.status)) ? 'not-found' : Number(e?.status) === 410 ? 'expired' : 'unavailable' }); });
    return () => { alive = false; };
  }, [token]);
  useEffect(() => load(), [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!rating) { setError(english('publicSurvey.pickRating')); return; }
    setBusy(true);
    setError('');
    try {
      await answerPublicSurvey(token, { rating, comment });
      setView((v) => ({ ...v, status: 'answered' }));
      setEditing(false);
    } catch (err) {
      if (Number(err?.status) === 410) setView((v) => ({ ...v, status: 'expired' }));
      else setError(err?.code === 'survey-limit' ? err.message : english('publicSurvey.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (view.status === 'loading') return <Card>{english('common.loading')}</Card>;
  if (view.status === 'not-found') {
    return <Card><h1>{english('publicSurvey.notFoundTitle')}</h1><p className="text-muted">{english('publicSurvey.notFoundBody')}</p></Card>;
  }
  if (view.status === 'expired') {
    return <Card><h1>{english('publicSurvey.closedTitle')}</h1><p className="text-muted">{english('publicSurvey.closedBody')}</p></Card>;
  }
  if (view.status === 'unavailable') {
    return (
      <Card>
        <h1>{english('publicSurvey.unavailableTitle')}</h1>
        <p className="text-muted">{english('publicSurvey.unavailableBody')}</p>
        <button type="button" className="btn btn-primary" onClick={load}>{english('publicSurvey.tryAgain')}</button>
      </Card>
    );
  }
  if (view.status === 'answered' && !editing) {
    return (
      <Card>
        <h1>{english('publicSurvey.thanksTitle')}</h1>
        <p className="text-muted">{english('publicSurvey.thanksBody')}</p>
        <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>{english('publicSurvey.change')}</button>
      </Card>
    );
  }

  const title = view.company ? english('publicSurvey.title', { company: view.company }) : english('publicSurvey.titlePlain');
  return (
    <Card>
      <h1>{title}</h1>
      <p className="text-muted">{english('publicSurvey.intro')}</p>
      <form onSubmit={submit} className="public-survey-form">
        <div className="form-label" id="survey-rating-label">{english('publicSurvey.ratingLabel')}</div>
        <div className="public-survey-ratings" role="radiogroup" aria-labelledby="survey-rating-label">
          {RATINGS.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={english('publicSurvey.ratingOption', { n })}
              className={`btn public-survey-rating${rating === n ? ' btn-primary' : ' btn-outline'}`}
              onClick={() => { setRating(n); setError(''); }}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="public-survey-scale text-muted">
          <span>{english('publicSurvey.rating.1')}</span>
          <span>{english('publicSurvey.rating.5')}</span>
        </div>
        <label className="form-label" htmlFor="survey-comment">
          {english('publicSurvey.commentLabel')} <span className="text-muted">{english('publicSurvey.commentOptional')}</span>
        </label>
        <textarea
          id="survey-comment"
          className="input"
          rows={4}
          maxLength={1000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary public-survey-submit" disabled={busy}>
          {busy ? english('publicSurvey.sending') : english('publicSurvey.submit')}
        </button>
      </form>
    </Card>
  );
}
