import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import AutoGrowTextarea from '../../components/AutoGrowTextarea';
import BackLink from '../../components/BackLink';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { fetchHubMessages, postHubMessage, markHubMessagesRead } from '../../lib/clientHubApi';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { HUB_MESSAGE_BODY_MAX, HUB_MESSAGES_POLL_MS, mergeHubLines } from '../../lib/hubMessages';
import { buildingPath } from './hubNav';
import { useHub, useHubRefresh, hubWhen } from './hubData';
import { reloadHubUpdates } from './hubUpdates';
import HubSectionHead from './HubSectionHead';

// MESSAGES (the client hub redesign, plan §3.4): the building's ONE thread with the office — every
// customer login that can see the building and the office staff who hold `hub.messages.view`
// (Matt's routing rule sends each line to the building's account manager). Read through
// GET /api/hub/messages, written through POST /api/hub/message (or the demo's twins, which share
// the office demo's store, so a reply typed on the office's Customers tab shows here).
//
//   · "Your account manager: Dana K." — the building's manager as the hub may name them (first
//     name + last initial), or "Your account team" when it has none;
//   · the thread oldest first, the customer's own lines on the right; "Load earlier" pages back
//     through `before` (the hub's year, 50 lines a read);
//   · the composer pinned above the phone's bottom tabs; Send mints the line's id here, and a
//     retried Send of the same words reuses it, so a lost answer never makes two lines;
//   · re-read every 30 s while the page is visible (a customer login has no realtime), and the
//     thread marked read on open and whenever a newer line arrives — then the bell's answer is
//     re-read, so the Messages badge clears.
// English (LANG-8), like every hub word.
const mintId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);

export default function HubMessages() {
  const { buildingId } = useParams();
  const { building, readOnly } = useHub();
  const back = <BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />;
  if (!building) {
    return (
      <div className="hub-page">
        <HubSectionHead back={back} title="Messages" />
        <p className="text-muted">Loading…</p>
      </div>
    );
  }
  // Keyed by the building, so moving to another building's thread starts clean.
  // In the office's READ-ONLY preview (the layout's `readOnly`, UI_RULES §151) nothing is written:
  // no Send, no read marker (the server refuses both, 403 preview-read-only); the screen says so
  // first. A preview acting as the customer (the default) sends and reads as the building's stand-in.
  return <Thread key={building.id} building={building} back={back} readOnly={!!readOnly} />;
}

function Thread({ building, back, readOnly = false }) {
  const bid = building.id;
  const [lines, setLines] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [manager, setManager] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [earlier, setEarlier] = useState({ busy: false, error: '' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const pending = useRef(null); // { id, body } of a Send not yet answered
  const readUpTo = useRef(null); // the newest line already marked read
  const scrollDown = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Mark the thread read up to the newest line read, once per newer line; then the badge.
  const markRead = useCallback((incoming) => {
    const newest = incoming.length ? incoming[incoming.length - 1] : null;
    if (readOnly || !newest?.createdAt) return;
    if (readUpTo.current && Date.parse(newest.createdAt) <= Date.parse(readUpTo.current)) return;
    readUpTo.current = newest.createdAt;
    markHubMessagesRead(bid, newest.createdAt).then(() => reloadHubUpdates()).catch(() => { /* the next read tries again */ });
  }, [bid, readOnly]);

  // The newest page: the first read, every poll, and Try again.
  const latest = useCallback(async (first = false) => {
    const nearBottom = typeof window !== 'undefined'
      && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    try {
      const r = await fetchHubMessages(bid);
      if (!alive.current) return;
      const incoming = Array.isArray(r?.messages) ? r.messages : [];
      if (first === true) { setHasMore(!!r?.hasMore); scrollDown.current = true; } else if (nearBottom) scrollDown.current = true;
      setLines((cur) => mergeHubLines(cur, incoming));
      setManager(r?.manager || null);
      setStatus('ready');
      setError('');
      markRead(incoming);
    } catch (e) {
      if (!alive.current || first !== true) return;
      setStatus('error');
      setError(e?.message || 'Your messages could not be loaded.');
    }
  }, [bid, markRead]);

  useEffect(() => { latest(true); }, [latest]);
  useHubRefresh(latest, HUB_MESSAGES_POLL_MS);

  // After the first read and after a Send (or a poll while at the bottom): show the newest line.
  useEffect(() => {
    if (!scrollDown.current) return;
    scrollDown.current = false;
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [lines]);

  const retry = () => { setStatus('loading'); latest(true); };

  const loadEarlier = async () => {
    const oldest = lines[0];
    if (!oldest || earlier.busy) return;
    setEarlier({ busy: true, error: '' });
    try {
      const r = await fetchHubMessages(bid, { before: oldest.createdAt });
      if (!alive.current) return;
      setLines((cur) => mergeHubLines(Array.isArray(r?.messages) ? r.messages : [], cur));
      setHasMore(!!r?.hasMore);
      setEarlier({ busy: false, error: '' });
    } catch (e) {
      if (alive.current) setEarlier({ busy: false, error: e?.message || 'Earlier messages could not be loaded.' });
    }
  };

  const send = async (e) => {
    e?.preventDefault?.();
    const body = draft.trim();
    if (readOnly || !body || sending) return;
    const id = pending.current?.body === body ? pending.current.id : mintId();
    pending.current = { id, body };
    setSending(true);
    setSendError('');
    try {
      const r = await postHubMessage({ buildingId: bid, body, id });
      if (!alive.current) return;
      pending.current = null;
      setDraft('');
      scrollDown.current = true;
      if (r?.message) setLines((cur) => mergeHubLines(cur, [r.message]));
    } catch (err) {
      if (alive.current) setSendError(err?.message || "Your message wasn't sent. Try again.");
    } finally {
      if (alive.current) setSending(false);
    }
  };

  let thread;
  if (status === 'loading') thread = <p className="text-sm text-muted">Loading…</p>;
  else if (status === 'error') {
    thread = (
      <>
        <p className="text-sm">{error}</p>
        <div className="hub-actions"><button type="button" className="btn btn-outline" onClick={retry}>Try again</button></div>
      </>
    );
  } else if (!lines.length) {
    thread = <EmptyState icon={<Icon name="messaging" size={28} />} title="No messages yet" message="Send your account manager a message." />;
  } else {
    thread = (
      <>
        {hasMore && (
          <div className="hub-msgs-earlier">
            <button type="button" className="btn btn-outline" onClick={loadEarlier} disabled={earlier.busy}>
              {earlier.busy ? 'Loading…' : 'Load earlier'}
            </button>
            {earlier.error && <span className="text-xs">{earlier.error}</span>}
          </div>
        )}
        <ol className="hub-thread">
          {lines.map((m) => (
            <li key={m.id} className={`hub-msg ${m.mine ? 'mine' : 'theirs'}`}>
              <div className="hub-msg-who text-xs">{m.authorName}</div>
              <div className="hub-msg-body">{m.body}</div>
              <div className="hub-msg-at text-xs">{hubWhen(m.createdAt)}</div>
            </li>
          ))}
        </ol>
      </>
    );
  }

  return (
    <div className="hub-page hub-msgs">
      <HubSectionHead back={back} title="Messages" building={building} />
      {status === 'ready' && (
        <p className="hub-msgs-manager text-sm">{manager?.name ? `Your account manager: ${manager.name}` : 'Your account team'}</p>
      )}
      <section className="card hub-card" aria-label="Conversation">{thread}</section>
      <form className="card hub-msg-compose" onSubmit={send}>
        <div className="hub-msg-field">
          <AutoGrowTextarea
            className="hub-msg-input"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); }}
            maxLength={HUB_MESSAGE_BODY_MAX}
            placeholder="Write a message…"
            aria-label="Your message"
            disabled={readOnly}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={readOnly || !draft.trim() || sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        {sendError && <div className="form-error hub-msg-error" role="alert">{sendError}</div>}
        {readOnly && <p className="text-xs text-muted hub-msg-error">{HUB_PREVIEW_NOTE}</p>}
      </form>
    </div>
  );
}
