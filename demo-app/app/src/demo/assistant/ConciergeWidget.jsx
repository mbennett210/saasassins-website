import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import { askConcierge } from '../../lib/demoAssistant';
import { CONCIERGE_GREETING, CONCIERGE_DISCLOSURE, SUGGESTED_PROMPTS } from './conciergeKnowledge';
import './assistant.css';

// Prospect-facing demo concierge: a bottom-left chat launcher + panel. Answers
// product/pricing questions (grounded on the module catalog) and can DRIVE the
// demo — navigate the guided tour, add modules to the cart, open the cart, go to
// checkout — by executing the actions returned alongside each reply.
//
// The brain is lib/demoAssistant.js (live OpenAI proxy when configured, grounded
// local stub otherwise). Conversation state is in-memory only: it evaporates on
// reload, matching the demo's read-only-across-reloads ethos.

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Render **bold** spans; newlines are preserved by white-space:pre-wrap on the bubble.
function formatMessage(text) {
  return String(text)
    .split(/\*\*(.+?)\*\*/g)
    .map((seg, i) => (i % 2 ? <strong key={i}>{seg}</strong> : <span key={i}>{seg}</span>));
}

export default function ConciergeWidget({ onOpenCart }) {
  const navigate = useNavigate();
  const cart = useCart();

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(() => [{ id: 0, role: 'assistant', content: CONCIERGE_GREETING }]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const idRef = useRef(1);
  const revealRef = useRef(null);
  const logRef = useRef(null);
  const inputRef = useRef(null);

  const nextId = () => idRef.current++;

  // Keep the log pinned to the newest content / streamed token.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Focus the composer when the panel opens.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Cancel any in-flight typewriter on unmount.
  useEffect(() => () => clearTimeout(revealRef.current), []);

  const runActions = useCallback((actions) => {
    for (const a of actions) {
      if (a.type === 'navigate') navigate(a.route);
      else if (a.type === 'addToCart') cart.add(a.moduleId);
      else if (a.type === 'openCart') onOpenCart?.();
      else if (a.type === 'checkout') navigate('/checkout');
    }
  }, [navigate, cart, onOpenCart]);

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

    const { reply, actions } = await askConcierge({
      messages: history.map(({ role, content }) => ({ role, content })),
      context: { cartIds: cart.ids },
    });

    setSending(false);
    runActions(actions);
    streamReply(reply);
  }, [draft, sending, messages, cart.ids, runActions, streamReply]);

  const onSubmit = (e) => { e.preventDefault(); send(); };

  const showChips = messages.length === 1 && !sending;

  if (!open) {
    return (
      <button className="pp-concierge-fab" onClick={() => setOpen(true)} aria-label="Open the product concierge">
        <span className="pp-concierge-fab-icon" aria-hidden="true">💬</span>
        <span className="pp-concierge-fab-label">Ask</span>
      </button>
    );
  }

  return (
    <section className="pp-concierge-panel" role="dialog" aria-label="PolishPoint product concierge">
      <header className="pp-concierge-head">
        <span className="pp-concierge-title"><span aria-hidden="true">💬</span> PolishPoint concierge</span>
        <button className="pp-concierge-close" onClick={() => setOpen(false)} aria-label="Close concierge">×</button>
      </header>

      <div className="pp-concierge-log" ref={logRef} aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={`pp-msg pp-msg-${m.role}`}>
            {formatMessage(m.content)}
            {m.streaming && <span className="pp-msg-caret" aria-hidden="true">▋</span>}
          </div>
        ))}

        {sending && (
          <div className="pp-typing" aria-label="Concierge is typing"><span /><span /><span /></div>
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
          placeholder="Ask about features or pricing…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={sending}
          aria-label="Message the concierge"
        />
        <button className="pp-concierge-send" type="submit" disabled={sending || !draft.trim()} aria-label="Send message">→</button>
      </form>

      <p className="pp-concierge-disclosure">{CONCIERGE_DISCLOSURE}</p>
    </section>
  );
}
