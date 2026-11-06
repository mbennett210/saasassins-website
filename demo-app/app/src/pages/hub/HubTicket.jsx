import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useFromHere } from '../../hooks/useFromHere';
import { fetchHubTicket, sendHubMessage, reopenHubTicket, attachHubTicketPhoto } from '../../lib/clientHubApi';
import { HUB_TICKET_TEXT_MAX } from '../../lib/clientHubView';
import { WO_CLIENT_STAGES } from '../../lib/workOrders';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { useHub, useHubRead, hubWhen, hubDay, STAGE_BADGE } from './hubData';
import { sectionPath } from './hubNav';
import HubPhotos from './HubPhotos';

// ONE REQUEST, AS THE CUSTOMER SEES IT (HUB-13, WO-4, WO-8, WO-9, WO-10, WO-11). Matt's word is
// "request" (decision D6, 2026-10-08); the office's record is a ticket, and the URL stays
// /tickets/<id> because the emails already sent link there.
//
//   · the four stages in the customer's words (WO-8), with where this ticket is;
//   · what they wrote, and the photos they attached;
//   · once completed, the completion photo (WO-10 — the office cannot close it without one);
//   · the conversation: every message on THIS ticket (HUB-13), never an office note (WO-9 —
//     the server leaves those out of its query); and the way to answer;
//   · completed: reopen for seven days (WO-11), or raise a new ticket after that.
// In the office's READ-ONLY preview (the layout's `readOnly`, UI_RULES §151) every one of those
// controls — the reply, the photo, reopen, New request — is drawn where the customer sees it,
// disabled, with the sentence. A preview acting as the customer (the default) uses them for real.
export default function HubTicket() {
  const { buildingId, ticketId } = useParams();
  const { readOnly } = useHub();
  const nav = useFromHere();
  const toast = useToast();
  const read = useHubRead(() => fetchHubTicket(buildingId, ticketId), [buildingId, ticketId]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState('');
  const listHref = sectionPath(buildingId, 'tickets');

  if (read.loading) return <p className="text-muted">Loading the request…</p>;
  if (read.error) {
    return (
      <div className="hub-page">
        <BackLink to={listHref} label="Requests" />
        {read.status === 404
          ? <EmptyState icon={<Icon name="forms" size={28} />} title="Request not found" message={read.error} />
          : (
            <div className="card hub-card">
              <p className="text-sm">{read.error}</p>
              <button type="button" className="btn btn-outline" onClick={read.reload}>Try again</button>
            </div>
          )}
      </div>
    );
  }

  const t = read.data.ticket;
  const completed = t.stage === 'completed';

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || readOnly) return;
    setBusy('send');
    try {
      await sendHubMessage({ buildingId, ticketId, body: text });
      setDraft('');
      read.reload();   // the stage may have moved (answering "we need more information")
    } catch (e) { toast.error(e?.message || 'Your message could not be sent.'); }
    finally { setBusy(''); }
  };
  const reopen = async () => {
    if (busy || readOnly) return;
    setBusy('reopen');
    try {
      const r = await reopenHubTicket({ buildingId, ticketId });
      read.setData({ ticket: r.ticket });
      toast.success('Request reopened. It is back with your account manager.');
    } catch (e) { toast.error(e?.message || 'The request could not be reopened.'); }
    finally { setBusy(''); }
  };
  const attach = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy || readOnly) return;
    setBusy('photo');
    try {
      await attachHubTicketPhoto({ buildingId, ticketId, file });
      read.reload();
      toast.success('Photo added.');
    } catch (err) { toast.error(err?.message || 'The photo could not be added.'); }
    finally { setBusy(''); }
  };

  return (
    <div className="hub-page">
      <BackLink to={listHref} label="Requests" />
      <header className="hub-head">
        <h1 className="hub-title">{t.title}</h1>
        <div className="hub-badges">
          <Badge variant={STAGE_BADGE[t.stage] || 'slate'}>{t.stageLabel}</Badge>
          <Badge variant="slate">{t.typeLabel}</Badge>
          {t.categoryLabel && <Badge variant="blue">{t.categoryLabel}</Badge>}
          {/* The area of the building it is about (QR-16: a request made from an area's page). */}
          {t.area && <Badge variant="slate">{t.area}</Badge>}
          {t.urgent && <Badge variant="red">Urgent</Badge>}
        </div>
        <div className="hub-head-sub text-xs text-muted">
          Raised {hubWhen(t.createdAt)}{t.raisedBy ? ` by ${t.raisedBy}` : ''}
        </div>
      </header>

      <StageSteps stage={t.stage} />

      <section className="card hub-card">
        <div className="hub-sup-label text-xs">What you told us</div>
        <p className="hub-prose">{t.description}</p>
        <HubPhotos photos={t.photos} label="Your photos" />
        {!completed && (
          <div className="hub-actions">
            {readOnly ? (
              <button type="button" className="btn btn-secondary" disabled title={HUB_PREVIEW_NOTE}>
                <Icon name="camera" size={16} /> Add a photo
              </button>
            ) : (
              <label className="btn btn-secondary">
                <Icon name="camera" size={16} /> {busy === 'photo' ? 'Adding the photo…' : 'Add a photo'}
                <input type="file" accept="image/*" hidden onChange={attach} disabled={!!busy} />
              </label>
            )}
          </div>
        )}
      </section>

      {completed && t.completionPhotos.length > 0 && (
        <section className="card hub-card">
          <div className="hub-sup-label text-xs">Completed — the photo</div>
          <HubPhotos photos={t.completionPhotos} label="Completion photos" />
        </section>
      )}

      <section className="card hub-card">
        <div className="hub-sup-label text-xs">Conversation</div>
        {t.messages.length === 0
          ? <div className="text-sm text-muted">No messages yet. Your account manager will answer here.</div>
          : (
            <ol className="hub-thread">
              {t.messages.map((m) => (
                <li key={m.id} className={`hub-msg ${m.from === 'you' ? 'mine' : 'theirs'}`}>
                  <div className="hub-msg-who text-xs">{m.author}</div>
                  <div className="hub-msg-body">{m.body}</div>
                  {m.translation && <div className="hub-msg-trans text-xs">{m.translation}</div>}
                  <div className="hub-msg-at text-xs">{hubWhen(m.at)}</div>
                </li>
              ))}
            </ol>
          )}

        {!completed ? (
          <div className="hub-composer">
            <textarea
              className="input textarea-sm"
              rows={3}
              maxLength={HUB_TICKET_TEXT_MAX}
              placeholder={t.stage === 'needs_info' ? 'Answer your account manager…' : 'Add to this request…'}
              aria-label="Your message"
              value={draft}
              disabled={readOnly}
              onChange={(e) => setDraft(e.target.value)}
            />
            {readOnly && <p className="text-xs text-muted">{HUB_PREVIEW_NOTE}</p>}
            <button type="button" className="btn btn-primary" disabled={!draft.trim() || !!busy || readOnly} onClick={send}>
              {busy === 'send' ? 'Sending…' : 'Send'}
            </button>
          </div>
        ) : t.canReopen ? (
          <div className="hub-closed">
            <p className="text-sm">Completed {hubDay(t.resolvedAt)}. Not right? You can reopen it until {hubDay(t.reopenUntil)}.</p>
            {readOnly && <p className="text-xs text-muted">{HUB_PREVIEW_NOTE}</p>}
            <button type="button" className="btn btn-outline" disabled={!!busy || readOnly} onClick={reopen}>
              {busy === 'reopen' ? 'Reopening…' : 'Reopen request'}
            </button>
          </div>
        ) : (
          <div className="hub-closed">
            <p className="text-sm">Completed {hubDay(t.resolvedAt)}. If it comes back, send a new request.</p>
            {readOnly
              ? <button type="button" className="btn btn-outline" disabled title={HUB_PREVIEW_NOTE}>New request</button>
              : <Link className="btn btn-outline" to={`${listHref}/new`} state={nav}>New request</Link>}
          </div>
        )}
      </section>
    </div>
  );
}

// WO-8's four stages, in order, with this request's one marked. "We need more information" is
// a detour, not a step every ticket takes, so it is only ever marked when it is the stage.
function StageSteps({ stage }) {
  const done = (key) => (key === 'received' && stage !== 'received') || (key === 'working' && stage === 'completed');
  return (
    <ol className="hub-steps" aria-label="Where your request is">
      {WO_CLIENT_STAGES.map((s) => {
        const state = s.key === stage ? 'current' : done(s.key) ? 'done' : 'todo';
        return (
          <li key={s.key} className={`hub-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="hub-step-dot" aria-hidden>{state === 'done' ? <Icon name="check" size={12} /> : null}</span>
            <span className="hub-step-label text-xs">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
