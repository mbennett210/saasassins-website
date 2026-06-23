import { useState, useRef, useEffect, useCallback } from 'react';
import { useCart } from '../cart/CartContext';
import { askProspectBot, submitLead } from '../../lib/prospectAssistant';
import {
  PROSPECT_GREETING,
  PROSPECT_DISCLOSURE,
  SUGGESTED_PROMPTS,
  EMAIL_RE,
  CONTACT,
} from './prospectKnowledge';
import './assistant.css';

// Prospect-facing sales Q&A bot: a bottom-RIGHT chat launcher + panel that sits
// just to the LEFT of the cart FAB. Answers sales questions about how SaaSassins
// builds PolishPoint-style, customer-owned software (pricing, ownership, timeline,
// stack, process, case studies) and captures leads — it takes NO in-app actions.
//
// The brain is lib/prospectAssistant.js (live LLM proxy when configured, grounded
// local stub otherwise). Mounted once above <Routes> (App.jsx) so the single
// instance survives navigation across the landing, live demo, and checkout — its
// conversation persists. sessionStorage keeps it across reloads within the session.

const STORAGE_KEY = 'pp.demo.prospectbot.v1';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function loadMessages() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.map((m, i) => ({ id: i, role: m.role, content: m.content }));
    }
  } catch {
    /* corrupt / unavailable storage — fall back to a fresh greeting */
  }
  return [{ id: 0, role: 'assistant', content: PROSPECT_GREETING }];
}

// Linkify URLs + emails inside a plain-text segment so the booking link and
// contact address are clickable. Trailing sentence punctuation (e.g. the period
// after "…contact.html.") is kept OUT of the href so the link doesn't 404.
function linkify(text, keyPrefix) {
  const re = /(https?:\/\/[^\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  const parts = [];
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<span key={`${keyPrefix}-t${i}`}>{text.slice(last, m.index)}</span>);
    const isEmail = m[0].includes('@');
    let val = m[0];
    let trail = '';
    if (!isEmail) {
      const tm = val.match(/[).,;:!?]+$/);
      if (tm) { trail = tm[0]; val = val.slice(0, val.length - trail.length); }
    }
    const href = isEmail ? `mailto:${val}` : val;
    parts.push(
      <a key={`${keyPrefix}-l${i}`} href={href} target="_blank" rel="noreferrer">{val}</a>,
    );
    if (trail) parts.push(<span key={`${keyPrefix}-tr${i}`}>{trail}</span>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) parts.push(<span key={`${keyPrefix}-t${i}`}>{text.slice(last)}</span>);
  return parts;
}

// Render **bold** spans; newlines are preserved by white-space:pre-wrap on the bubble.
function formatMessage(text) {
  return String(text)
    .split(/\*\*(.+?)\*\*/g)
    .map((seg, i) => (i % 2 ? <strong key={i}>{seg}</strong> : <span key={i}>{linkify(seg, i)}</span>));
}

export default function ProspectBot() {
  const cart = useCart();

  const bootRef = useRef(null);
  if (bootRef.current === null) bootRef.current = loadMessages();

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(bootRef.current);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const idRef = useRef(bootRef.current.length);
  const revealRef = useRef(null);
  const logRef = useRef(null);
  const inputRef = useRef(null);

  const nextId = () => idRef.current++;

  // Persist the transcript (sans transient streaming state) so it survives a
  // reload. Skip while a reply is mid-stream to avoid writing partial content.
  useEffect(() => {
    if (messages.some((m) => m.streaming)) return;
    try {
      const persistable = messages.map(({ role, content }) => ({ role, content }));
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch {
      /* quota / private mode — silently drop */
    }
  }, [messages]);

  // Keep the log pinned to the newest content / streamed token.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Focus the composer when the panel opens.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Cancel any in-flight typewriter on unmount.
  useEffect(() => () => clearTimeout(revealRef.current), []);

  // Reveal the reply with a light typewriter effect (instant under reduced motion).
  const streamReply = useCallback((fullText) => {
    const id = nextId();
    setMessages((m) => [...m, { id, role: 'assistant', content: '', streaming: true }]);

    if (prefersReducedMotion()) {
      setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, content: fullText, streaming: false } : msg)));
      return;
    }
    const stepSize = Math.max(2, Math.round(fullText.length / 60));
    let i = 0;
    const tick = () => {
      i = Math.min(fullText.length, i + stepSize);
      const slice = fullText.slice(0, i);
      setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, content: slice } : msg)));
      if (i < fullText.length) revealRef.current = setTimeout(tick, 18);
      else setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, streaming: false } : msg)));
    };
    revealRef.current = setTimeout(tick, 18);
  }, []);

  const send = useCallback(async (textArg) => {
    const text = (typeof textArg === 'string' ? textArg : draft).trim();
    if (!text || sending) return;

    const userMsg = { id: nextId(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setDraft('');
    setSending(true);

    const wire = history.map(({ role, content }) => ({ role, content }));

    // If the prospect typed an email, capture it as a lead rather than answering.
    const emailMatch = text.match(EMAIL_RE);
    if (emailMatch) {
      await submitLead({ email: emailMatch[0], messages: wire, context: { cartCount: cart.count } });
      setSending(false);
      streamReply(
        `Perfect — got it. The team will reach out (${CONTACT.responseTime}). Prefer to grab a ` +
        `slot now? Book here: ${CONTACT.bookingUrl} . Anything else I can answer in the meantime?`,
      );
      return;
    }

    const { reply } = await askProspectBot({ messages: wire, context: { cartCount: cart.count } });

    setSending(false);
    streamReply(reply);
  }, [draft, sending, messages, cart.count, streamReply]);

  const onSubmit = (e) => { e.preventDefault(); send(); };

  const showChips = messages.length === 1 && !sending;

  if (!open) {
    return (
      <button
        className="pp-concierge-fab pp-concierge-fab--right"
        onClick={() => setOpen(true)}
        aria-label="Open the questions chat"
      >
        <span className="pp-concierge-fab-icon" aria-hidden="true">💬</span>
        <span className="pp-concierge-fab-label">Questions?</span>
      </button>
    );
  }

  return (
    <section className="pp-concierge-panel pp-concierge-panel--right" role="dialog" aria-label="Questions about PolishPoint">
      <header className="pp-concierge-head">
        <span className="pp-concierge-title"><span aria-hidden="true">💬</span> Questions? Chat with us</span>
        <button className="pp-concierge-close" onClick={() => setOpen(false)} aria-label="Close chat">×</button>
      </header>

      <div className="pp-concierge-log" ref={logRef} aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={`pp-msg pp-msg-${m.role}`}>
            {formatMessage(m.content)}
            {m.streaming && <span className="pp-msg-caret" aria-hidden="true">▋</span>}
          </div>
        ))}

        {sending && (
          <div className="pp-typing" aria-label="Assistant is typing"><span /><span /><span /></div>
        )}

        {showChips && (
          <div className="pp-concierge-chips">
            {SUGGESTED_PROMPTS.map((p) => (
              <button key={p} type="button" className="pp-chip" onClick={() => send(p)}>{p}</button>
            ))}
          </div>
        )}
      </div>

      <form className="pp-concierge-compose" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          className="pp-concierge-input"
          type="text"
          placeholder="Ask about pricing, ownership, timelines…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={sending}
          aria-label="Message the assistant"
        />
        <button className="pp-concierge-send" type="submit" disabled={sending || !draft.trim()} aria-label="Send message">→</button>
      </form>

      <p className="pp-concierge-disclosure">{PROSPECT_DISCLOSURE}</p>
    </section>
  );
}
