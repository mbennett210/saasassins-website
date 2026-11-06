import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from '../../store';
import { selectCompany, selectCurrentUser } from '../../store/selectors';
import { IDENTITY } from '../../brand/identity.generated';
import { memberRoleEnglish } from '../../lib/roles';
import { REVIEW_MOCKUPS } from '../../review-mockups';

// A design question's mockup, drawn inside the question (UI_RULES §179). The template
// (review-mockups/<file>) holds no colour and no name of its own, so it follows a re-skin and
// passes the colour and name ledgers: when it's drawn here, its /*THEME*/ becomes a :root block
// of the live theme's values for every var() it reads, its /*WHO*/ the product, logo and the
// signed-in person, and its /*VIEW*/ the view it opens on.
//
// It is an iframe on the app's own origin (srcdoc), so its fonts, logo and scripts load as the
// app's do; it talks to Review only by postMessage, each side checking the other is its own
// window: it sends its height and a view tab pressed, Review sends the view an answer picks.
// A view tab never answers: only the question's answer is saved.
//
// It opens in its place: its room is reserved at the height it last had at this window width
// (kept per browser), it fades in once it has said its height, and its views share one height,
// so switching views moves nothing under it.
const HEIGHT_KEY = 'cs.reviewMockup.h';
const FALLBACK_H = 1052; // its height in a 1440px window (measured 2026-10-23)

const heightKey = (id) => `${id}:${Math.round(window.innerWidth / 40)}`;
function readHeights() {
  try { return JSON.parse(localStorage.getItem(HEIGHT_KEY) || '{}') || {}; } catch { return {}; }
}
function keepHeight(key, h) {
  try { localStorage.setItem(HEIGHT_KEY, JSON.stringify({ ...readHeights(), [key]: h })); } catch { /* private mode */ }
}

// The live theme's value for every custom property the template reads and doesn't set itself.
function themeBlock(html) {
  const own = new Set([...html.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = [...new Set([...html.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))].filter((n) => !own.has(n));
  const cs = getComputedStyle(document.body);
  const decls = used
    .map((n) => [n, cs.getPropertyValue(n).trim()])
    .filter(([, v]) => v && !/[<>{};]/.test(v));
  return `:root { ${decls.map(([n, v]) => `${n}: ${v};`).join(' ')} }`;
}

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const initialsOf = (name) => (name || '').split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

export default function MockupFrame({ id, view, onView, title }) {
  const mockup = REVIEW_MOCKUPS[id];
  const company = useSelector(selectCompany);
  const user = useSelector(selectCurrentUser);
  const frameRef = useRef(null);
  const [html, setHtml] = useState(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(null);
  const [shown, setShown] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // The view it opens on is fixed for this frame's life (a new srcdoc would reload it); later
  // views go by message.
  const [startView] = useState(view);
  const onViewRef = useRef(onView);
  useEffect(() => { onViewRef.current = onView; }, [onView]);

  useEffect(() => {
    let live = true;
    if (!mockup) { setFailed(true); return undefined; }
    mockup.load().then((t) => { if (live) setHtml(t); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [mockup]);

  const who = useMemo(() => ({
    product: IDENTITY.product.name,
    logo: company?.logoUrl ? new URL(company.logoUrl, window.location.href).href : '',
    name: user?.name || '',
    initials: user?.initials || initialsOf(user?.name),
    role: memberRoleEnglish(user),
  }), [company?.logoUrl, user]);

  // Built once per template: a new srcdoc reloads the frame and loses where Matt was in it.
  const srcDoc = useMemo(() => {
    if (!html) return null;
    return html
      .replace('/*THEME*/', () => themeBlock(html))
      .replace('/*WHO*/null', () => json(who))
      .replace('/*VIEW*/null', () => json(startView || null));
  }, [html]);

  // Read once, as the frame mounts.
  const [reserved] = useState(() => readHeights()[heightKey(id)] || FALLBACK_H);

  useEffect(() => {
    const onMsg = (e) => {
      const f = frameRef.current;
      const d = e.data;
      if (!f || e.source !== f.contentWindow || !d || d.source !== 'cs-mockup') return;
      if (d.type === 'height' && Number.isFinite(d.h)) {
        const h = Math.max(200, Math.min(6000, Math.ceil(d.h)));
        setHeight(h);
        setShown(true);
        keepHeight(heightKey(id), h);
      } else if (d.type === 'view' && typeof d.view === 'string') {
        onViewRef.current?.(d.view);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [id]);

  // An answer picked below switches the mockup to its view.
  useEffect(() => {
    const w = frameRef.current?.contentWindow;
    if (loaded && w && view) w.postMessage({ source: 'cs-review', type: 'view', view }, window.location.origin);
  }, [view, loaded]);

  if (failed) {
    return <div className="review-mockup-box review-mockup-failed">The mockup couldn’t be loaded. Reload the page to try again.</div>;
  }
  return (
    <div className="review-mockup-box" style={{ height: height ?? reserved }}>
      {srcDoc && (
        <iframe
          ref={frameRef}
          className={`review-mockup-frame${shown ? ' is-shown' : ''}`}
          title={title}
          srcDoc={srcDoc}
          onLoad={() => setLoaded(true)}
        />
      )}
    </div>
  );
}
