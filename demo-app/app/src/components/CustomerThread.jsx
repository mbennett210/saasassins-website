// ONE building's conversation with its customers, from the office's side (client hub redesign,
// plan §3.4; D5). The SAME component in both places the office answers:
//   layout="pane"  Messaging → Customers, the middle pane (the message-pane / compose-bar kit)
//   layout="card"  the customer page's Messages tab (a detail card)
//
// Reads /api/client-messages/thread (lib/clientMessagesApi), oldest line at the top; marks the
// thread read up to the newest line it shows; polls every 30 s while the tab is visible (these
// tables have no realtime). While the customer waits for the office's reply, the header says how
// long (`waitingSince`, the server's rule; a reply sent here ends it) — a waiting message is not a
// client request, so this is where its wait is told (HUB-24 (c), 2026-10-12). Sending needs
// `hub.messages.reply`; without it the thread is read-only and says why — and so is an ARCHIVED
// customer's thread (CS-663: its hub logins have lost access, so the server takes no reply; the
// history stays readable). Every line is drawn the
// way the work-order drawer draws a customer conversation (`.wo-msg`: the customer on the left,
// the office on the right). Words through t() (UI_RULES §140); the people's own words, never.
//
// TEXTS (Daniel, 2026-10-28: "Customer thread, texted back"): a customer's line that came in as a
// text says so, with the number; when the newest customer line came by text, the composer says
// the reply is also texted there (or that the number has texts off: it replied STOP), and each
// office line says how its text went (`m.text`, lib/texting TEXT_BACK).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AutoGrowTextarea from './AutoGrowTextarea';
import EmptyState from './EmptyState';
import Icon from './Icon';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useFromHere } from '../hooks/useFromHere';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { fmtDate, fmtTime, minutesSince } from '../lib/dates';
import { TEXT_VIA, TEXT_BACK, displayPhone } from '../lib/texting';
import {
  fetchCustomerThread, sendCustomerMessage, markCustomerThreadRead, newMessageId,
} from '../lib/clientMessagesApi';

const POLL_MS = 30000;
const MINUTES_PER_DAY = 24 * 60;

// How long a customer's message has waited for the office's reply, in words: "Waiting just now",
// "Waiting 50m", "Waiting 2 days". `since` is a thread's `waitingSince` (lib/hubMessages); nothing
// when it is not waiting. Shared by this thread's header and Messaging → Customers' rows.
export function WaitedFor({ since, className = '' }) {
  const t = useT();
  const mins = minutesSince(since);
  if (mins == null) return null;
  let text;
  if (mins < 1) text = t('custMsg.wait.justNow');
  else if (mins < MINUTES_PER_DAY) text = t('custMsg.wait.for', { time: mins });
  else text = t('custMsg.wait.days', { count: Math.floor(mins / MINUTES_PER_DAY) });
  return <span className={`cmsg-wait ${className}`.trim()}>{text}</span>;
}
const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const stamp = (iso) => (iso ? `${fmtDate(iso, { month: 'short', day: 'numeric' })} · ${fmtTime(iso)}` : '');

// How an office line's text went, in words (one literal key per outcome: the catalog's scan).
const TEXT_OUTCOME_KEY = Object.freeze({
  [TEXT_BACK.sent]: 'custMsg.text.sent',
  [TEXT_BACK.sending]: 'custMsg.text.sending',
  [TEXT_BACK.optedOut]: 'custMsg.text.optedOut',
  [TEXT_BACK.notSetUp]: 'custMsg.text.notSetUp',
  [TEXT_BACK.sample]: 'custMsg.text.sample',
  [TEXT_BACK.failed]: 'custMsg.text.failed',
});
function textOutcome(t, text) {
  const key = text && TEXT_OUTCOME_KEY[text.status];
  return key ? t(key, { phone: displayPhone(text.to || '') }) : '';
}
// Where the next reply goes, said above the composer: the number the customer last texted from,
// or that it has texts off. Nothing when the newest customer line came from the hub.
function TextBackNote({ textBack, className }) {
  const t = useT();
  if (!textBack?.phone) return null;
  const phone = displayPhone(textBack.phone);
  return (
    <div className={className}>
      {textBack.optedOutAt
        ? t('custMsg.text.nextOff', { phone, date: fmtDate(textBack.optedOutAt, { month: 'short', day: 'numeric', year: 'numeric' }) })
        : t('custMsg.text.next', { phone })}
    </div>
  );
}

// Merge pages by id, oldest first — a poll's newest page never drops the older ones already shown.
function mergeLines(prev, next) {
  const byId = new Map();
  for (const m of [...(prev || []), ...(next || [])]) if (m && m.id) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

function Line({ m }) {
  const t = useT();
  const customer = m.authorRole === 'client';
  const who = m.authorName || (customer ? t('custMsg.thread.customer') : t('custMsg.thread.staff'));
  const texted = customer && m.via === TEXT_VIA;
  const outcome = !customer ? textOutcome(t, m.text) : '';
  return (
    <div className={`wo-msg ${customer ? 'client' : 'us'}`}>
      <span className={`wo-msg-av ${customer ? 'client' : ''}`} aria-hidden="true">{initialsOf(who) || (customer ? 'C' : 'S')}</span>
      <div className="wo-bub">
        <div className="wo-msg-who">{who}{texted && <> · {t('custMsg.text.from', { phone: displayPhone(m.phone || '') })}</>}</div>
        <div>{m.body}</div>
        <div className="wo-msg-at">{stamp(m.createdAt)}{outcome && <> · {outcome}</>}</div>
      </div>
    </div>
  );
}

export default function CustomerThread({ clientId, layout = 'card', onBack, onActivity }) {
  const t = useT();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canReply = usePermission('hub.messages.reply');
  const [data, setData] = useState(null);       // { client, manager, hasMore, readAt, waitingSince, textBack }
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const scrollRef = useRef(null);
  // CS-663: an archived customer's thread is history — readable, never answered.
  const archived = !!data?.client?.archived;
  const writable = canReply && !archived;
  // `ctx` is read by the DEMO adapter only (who is signed in on the demo's switcher).
  const ctx = { user: currentUser };
  const onActivityRef = useRef(onActivity);
  useEffect(() => { onActivityRef.current = onActivity; }, [onActivity]);

  // The newest page; merged into what is shown, then the thread is marked read up to its last line.
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!clientId) return;
    const who = { user: currentUser };
    try {
      const r = await fetchCustomerThread(clientId, {}, who);
      setData((prev) => ({
        client: r.client, manager: r.manager, readAt: r.readAt, waitingSince: r.waitingSince || null, textBack: r.textBack || null,
        hasMore: prev ? prev.hasMore : r.hasMore,
      }));
      setLines((prev) => mergeLines(prev, r.messages));
      setError('');
      const newest = r.messages?.[r.messages.length - 1]?.createdAt || null;
      if (newest && (!r.readAt || Date.parse(newest) > Date.parse(r.readAt))) {
        await markCustomerThreadRead(clientId, newest, who);
        onActivityRef.current?.();
      }
    } catch (e) {
      if (!quiet) setError(errorText(t, e, 'custMsg.error.load'));
    }
  }, [clientId, t, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new building: start clean.
  useEffect(() => {
    setData(null); setLines([]); setError(''); setDraft(''); setSendError('');
    load();
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  // While the tab is visible, look again every 30 s.
  useEffect(() => {
    if (!clientId) return undefined;
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load({ quiet: true });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [clientId, load]);

  // Keep the newest line in view in the messaging pane.
  useEffect(() => {
    if (layout === 'pane' && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines.length, layout]);

  const loadOlder = async () => {
    const oldest = lines[0]?.createdAt;
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const r = await fetchCustomerThread(clientId, { before: oldest }, ctx);
      setLines((prev) => mergeLines(r.messages, prev));
      setData((prev) => ({ ...(prev || {}), hasMore: r.hasMore }));
    } catch (e) {
      setError(errorText(t, e, 'custMsg.error.load'));
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async (e) => {
    e?.preventDefault?.();
    const text = draft.trim();
    if (!text || sending || !writable) return;
    setSending(true);
    setSendError('');
    try {
      const r = await sendCustomerMessage({ clientId, body: text, id: newMessageId() }, ctx);
      setLines((prev) => mergeLines(prev, [r.message]));
      // The office has answered: the wait is over (the next read says the same).
      setData((prev) => (prev ? { ...prev, waitingSince: null } : prev));
      setDraft('');
      onActivity?.();
    } catch (err) {
      setSendError(errorText(t, err, 'custMsg.error.send', { 'building-archived': 'custArchive.threadNotice' }));
    } finally {
      setSending(false);
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && layout === 'pane') { e.preventDefault(); send(); }
  };

  const customerName = data?.client?.name || '';
  const managerLine = data?.manager?.name ? t('custMsg.thread.manager', { name: data.manager.name }) : t('custMsg.thread.noManager');
  const body = (
    <>
      {data?.hasMore && (
        <button type="button" className="btn btn-outline" onClick={loadOlder} disabled={loadingOlder}>
          {loadingOlder ? t('common.loading') : t('custMsg.thread.loadEarlier')}
        </button>
      )}
      {error && (
        <div className="form-error">
          {error}{' '}
          <button type="button" className="btn btn-link" onClick={() => load()}>{t('common.retry')}</button>
        </div>
      )}
      {!data && !error && <div className="wo-thread-empty">{t('common.loading')}</div>}
      {data && lines.length === 0 && (
        <EmptyState icon={<Icon name="messaging" size={24} />} title={t('custMsg.thread.empty')} message={t('custMsg.thread.emptyHint')} />
      )}
      {lines.map((m) => <Line key={m.id} m={m} />)}
    </>
  );

  if (layout === 'pane') {
    return (
      <section className="message-pane">
        <div className="message-pane-head">
          {onBack && (
            <button type="button" className="btn-icon btn-icon-ghost msg-back-btn" onClick={onBack} aria-label={t('custMsg.thread.back')}>
              <Icon name="chevronLeft" size={20} />
            </button>
          )}
          <div className="message-pane-titles">
            <div className="message-pane-name">
              <Link to={`/clients/${encodeURIComponent(clientId)}?tab=messages`} state={nav} title={t('custMsg.thread.openCustomer')}>{customerName}</Link>
            </div>
            <div className="message-pane-sub text-xs text-muted">
              {managerLine}
              {data?.waitingSince && <> · <WaitedFor since={data.waitingSince} /></>}
            </div>
          </div>
        </div>
        <div className="message-pane-scroll" ref={scrollRef}>{body}</div>
        {writable ? (
          <form className="compose-bar" onSubmit={send}>
            <TextBackNote textBack={data?.textBack} className="compose-hint compose-hint-text" />
            <div className="compose-row">
              <div className="compose-input-wrap">
                <AutoGrowTextarea
                  className="compose-input"
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKey}
                  placeholder={t('custMsg.thread.placeholder', { customer: customerName })}
                  aria-label={t('custMsg.thread.placeholder', { customer: customerName })}
                  maxLength={4000}
                />
              </div>
              <div className="compose-row-actions">
                <button type="submit" className="btn btn-gold compose-send" disabled={sending || !draft.trim()}>
                  {sending ? t('custMsg.thread.sending') : t('custMsg.thread.send')}
                </button>
              </div>
            </div>
            {sendError && <div className="form-error">{sendError}</div>}
            <div className="compose-hint">{t('custMsg.thread.shared')}</div>
          </form>
        ) : (
          <div className="compose-readonly"><Icon name="lock" size={16} /><span>{archived ? t('custArchive.threadNotice') : t('custMsg.thread.noReply')}</span></div>
        )}
      </section>
    );
  }

  return (
    <div className="card detail-card">
      <div className="wo-thread-head">
        <h3>{t('custMsg.customerTab')}</h3>
        <span className="text-xs text-muted">
          {managerLine}
          {data?.waitingSince && <> · <WaitedFor since={data.waitingSince} /></>}
        </span>
      </div>
      {!archived && <p className="text-xs text-muted">{t('custMsg.thread.shared')}</p>}
      <div className="wo-thread">{body}</div>
      {writable ? (
        <>
          <TextBackNote textBack={data?.textBack} className="text-xs text-muted" />
          <form className="wo-composer" onSubmit={send}>
            <AutoGrowTextarea
              className="input wo-composer-input"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('custMsg.thread.placeholder', { customer: customerName })}
              aria-label={t('custMsg.thread.placeholder', { customer: customerName })}
              maxLength={4000}
            />
            <button type="submit" className="btn btn-primary" disabled={sending || !draft.trim()}>
              {sending ? t('custMsg.thread.sending') : t('custMsg.thread.send')}
            </button>
          </form>
          {sendError && <div className="form-error">{sendError}</div>}
        </>
      ) : (
        <p className="text-sm text-muted">{archived ? t('custArchive.threadNotice') : t('custMsg.thread.noReply')}</p>
      )}
    </div>
  );
}
