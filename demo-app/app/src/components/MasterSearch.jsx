import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { can } from '../lib/roles';
import { useIsMobile } from '../hooks/useIsMobile';
import { useFromHere } from '../hooks/useFromHere';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import Icon from './Icon';
import PopMenu from './PopMenu';
import EmptyState from './EmptyState';
import { rankEntries, groupRanked, normalize, terms } from '../lib/masterSearch/rank';
import { buildNavEntries, visiblePrimaryPages, buildLaunchpad } from '../lib/masterSearch/registry';
import { buildRecordCandidates, resolveRecordCandidate } from '../lib/masterSearch/sources';
import { loadRecents, pushRecent } from '../lib/masterSearch/recents';
import { IDENTITY } from '../brand/identity.generated.js';

// MasterSearch — the app's one global search surface (UI_RULES §116). Desktop: a field in
// the fixed top bar with an anchored results panel (PopMenu, §114). Mobile: a magnifier in
// the top row (plus a "Search" row in the FloatingNav menu, via the `cs:open-search`
// event) that grows LEFTWARD into one search bar across the top, Facebook-style: a back
// arrow at the far left, the field focused, and the page giving way to a full-screen search
// that shows a LAUNCHPAD (quick-action tiles, recents, the pages the tab tray doesn't show)
// until you type, then the ranked results. It finds pages, quick actions and records; ranks
// by match quality (lib/masterSearch/rank); shows only what the viewer may open (same
// predicate as the nav, page-scoped selectors for records); and navigates with a referrer
// so Back works.
//
// Mounted ONCE, inside .main (AppLayout), so it shares .main's stacking context with the
// bell floater and every content drawer: the bell paints above the bar, and a drawer or its
// scrim paints above both.

const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
const KBD_HINT = IS_MAC ? '⌘K' : 'Ctrl K';
const PLACEHOLDER = 'Search customers, pages, actions';
const RECENT_SHOWN = 6;
const PAGES_SHOWN = 8;
// The phone bar's fold-back (matches --duration-base, the .msearch-screen exit animation).
const CLOSE_MS = 200;
const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Store subscription that exists only while the panel is open: closed, the selector returns
// a constant (no re-render on any dispatch — this is always-mounted chrome); open, it
// returns the live snapshot, so results reflect every add/edit/delete as it happens.
const SELECT_STATE = (s) => s;
const SELECT_NOTHING = () => null;
const EMPTY_VIEW = { mode: 'closed', user: null, groups: [], flat: [], recents: [], actions: [], pages: [] };

function layout(groupsIn, q, mode) {
  const flat = [];
  const groups = groupsIn.map((g) => {
    const rows = [];
    for (const item of g.items) {
      const row = { type: 'result', entry: item, flatIndex: flat.length, showType: !!g.showType };
      flat.push(row);
      rows.push(row);
    }
    let more = 0;
    if (mode === 'query' && g.truncated) {
      const first = g.items[0];
      const to = typeof first?.seeAll === 'function' ? first.seeAll(q) : null;
      if (to) {
        // Only claim "See all N" where the destination actually filters to the query.
        const name = first.seeAllLabel || g.label;
        const label = first.seeAllFiltered ? `See all ${g.totalCount} in ${name}` : `Open ${name}`;
        const row = { type: 'more', to, label, flatIndex: flat.length };
        flat.push(row);
        rows.push(row);
      } else {
        more = g.totalCount - g.items.length;
      }
    }
    return { key: g.key, label: g.label, rows, more };
  });
  return { groups, flat };
}

// With nothing typed, a phone shows the launchpad (the bar is always on screen above it, so
// there is no separate "search mode"); desktop shows Recent + Pages.
function computeView(state, isMobile, query) {
  const user = selectCurrentUser(state);
  const isCrew = user?.role === 'crew';
  const check = (key) => can(user, key, state.permissions, state.userPermissionOverrides);
  const opts = { isMobile };
  const q = query.trim();
  if (!q) {
    const navVisible = buildNavEntries(check, isMobile, isCrew);
    const liveByTo = new Map(navVisible.map((e) => [e.to, e]));
    // Recents re-validate against LIVE data and visibility: a deleted or now-hidden record,
    // or a page the viewer lost access to, drops out; renamed things show their new label.
    const recents = loadRecents(user?.id)
      .map((r) => (r.kind === 'record' && r.type
        ? resolveRecordCandidate(state, user, check, r.type, r.refId, opts)
        : liveByTo.get(r.to) || null))
      .filter(Boolean)
      .slice(0, RECENT_SHOWN);
    if (isMobile) {
      const { actions, pages } = buildLaunchpad(check, isMobile, isCrew);
      return { ...EMPTY_VIEW, mode: 'launchpad', user, recents, actions, pages };
    }
    const recentTos = new Set(recents.map((r) => r.to));
    const pages = visiblePrimaryPages(check, isMobile, isCrew).filter((p) => !recentTos.has(p.to)).slice(0, PAGES_SHOWN);
    const groupsIn = [];
    if (recents.length) groupsIn.push({ key: 'recent', label: 'Recent', items: recents, showType: true });
    if (pages.length) groupsIn.push({ key: 'pages', label: 'Pages', items: pages });
    return { mode: 'empty', user, ...layout(groupsIn, '', 'empty') };
  }
  const candidates = [...buildNavEntries(check, isMobile, isCrew), ...buildRecordCandidates(state, user, check, opts)];
  return { mode: 'query', user, ...layout(groupRanked(rankEntries(candidates, q)), q, 'query') };
}

// The component owns the DOM refs and passes them IN; the hook touches them only inside
// handlers and effects, and never returns them — so the object handed to the render tree
// is ref-free (react-hooks/refs).
function useMasterSearch(inputRef, wrapRef) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const fromHere = useFromHere();

  const [open, setOpen] = useState(false);
  // Phone only: the bar is folding back into the spyglass. The screen stays mounted (with
  // its content) for that short exit, then unmounts.
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const returnFocusRef = useRef(null);
  const touchYRef = useRef(null);
  const closeTimerRef = useRef(null);

  const state = useSelector(open ? SELECT_STATE : SELECT_NOTHING);
  const view = useMemo(() => (state ? computeView(state, isMobile, query) : EMPTY_VIEW), [state, isMobile, query]);
  const safeIndex = view.flat.length ? Math.min(activeIndex, view.flat.length - 1) : -1;

  useEffect(() => { setActiveIndex(0); }, [query, open]);
  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  const openSearch = useCallback(({ captureFocus = false } = {}) => {
    if (captureFocus) {
      const ae = document.activeElement;
      returnFocusRef.current = ae && ae !== document.body && !wrapRef.current?.contains(ae) ? ae : null;
    }
    clearTimeout(closeTimerRef.current);
    setClosing(false);
    setOpen(true);
  }, [wrapRef]);

  // clear: drop the typed query · restore: return focus to where the user was before a
  // hotkey open (else blur) · blur: leave the field (after a navigation).
  const close = useCallback(({ clear = true, restore = false, blur = false } = {}) => {
    const finish = () => {
      setOpen(false);
      setClosing(false);
      if (clear) setQuery('');
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (restore && back && document.contains(back)) back.focus();
      else if (restore || blur) inputRef.current?.blur();
    };
    // Phone: fold the bar back into the spyglass, then unmount. Desktop, reduced motion or
    // an already-closed search close at once.
    if (isMobile && open && !prefersReducedMotion()) {
      inputRef.current?.blur(); // the keyboard drops with the fold
      setClosing(true);
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(finish, CLOSE_MS);
      return;
    }
    finish();
  }, [inputRef, isMobile, open]);
  // The phone screen's back arrow (and Escape): focus goes back to whatever opened it.
  const closeClear = useCallback(() => close({ clear: true, restore: true }), [close]);

  const onFieldFocus = () => openSearch();

  // Dragging the phone results drops the keyboard (iOS keyboardDismissMode .onDrag), so
  // more of the list shows while you browse. A threshold keeps a tap a tap.
  const onBodyTouchStart = (e) => { touchYRef.current = e.touches[0]?.clientY ?? null; };
  const onBodyTouchMove = (e) => {
    const y0 = touchYRef.current;
    const y = e.touches[0]?.clientY;
    if (y0 == null || y == null || Math.abs(y - y0) < 10) return;
    touchYRef.current = null;
    if (document.activeElement === inputRef.current) inputRef.current.blur();
  };

  const activate = (row, { newTab = false } = {}) => {
    if (!row) return;
    const to = row.type === 'more' ? row.to : row.entry.to;
    if (row.type === 'result') {
      const e = row.entry;
      pushRecent(view.user?.id, { kind: e.kind, type: e.type, refId: e.refId, to: e.to, label: e.label, icon: e.icon || e.groupIcon });
    }
    if (newTab) {
      window.open(to, '_blank', 'noopener');
      return;
    }
    // Record A → record B remounts via App.jsx KeyedByParam; pages with a deep-linkable tab
    // (ClientDetail ?tab, Messaging ?inbox, Quality ?tab) re-read it on navigation — so a
    // search from the page you're already on lands exactly where the result points.
    navigate(to, { state: fromHere, replace: to === `${location.pathname}${location.search}` });
    close({ clear: true, blur: true });
  };

  const onChange = (e) => {
    setQuery(e.target.value);
    if (!open) setOpen(true); // typing always (re)opens — e.g. after Escape or a selection
  };

  const onKeyDown = (e) => {
    const n = view.flat.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openSearch(); return; }
      if (n) setActiveIndex((i) => (Math.min(i, n - 1) + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActiveIndex((i) => (Math.min(i, n - 1) - 1 + n) % n);
    } else if (e.key === 'Enter') {
      if (!open || safeIndex < 0) return;
      e.preventDefault();
      activate(view.flat[safeIndex], { newTab: e.metaKey || e.ctrlKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't also close a modal/picker underneath
      if (query) setQuery(''); // first Escape clears, second closes
      else close({ clear: true, restore: true });
    } else if (e.key === 'Tab') {
      // Desktop: tabbing out of the combobox closes its panel. The phone search screen is a
      // dialog, so Tab just moves on through it.
      if (open && !isMobile) close({ clear: false });
    }
  };

  // Phone: Escape from a hardware keyboard closes the screen even when the field isn't
  // focused (a drag dropped the keyboard). The field's own Escape (clear first) stops
  // propagation, so the two never both fire.
  useEffect(() => {
    if (!open || !isMobile) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close({ clear: true, restore: true }); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isMobile, close]);

  // The highlighted row stays in view as the arrows move past the panel's scroll edge.
  useEffect(() => {
    if (!open || safeIndex < 0) return;
    document.getElementById(`msearch-opt-${safeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, safeIndex]);

  // Global Ctrl/Cmd+K. Desktop refuses to open a panel that something covers (a modal,
  // sheet, drawer or scrim over the top bar): hit-test the field instead of guessing classes.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key || '').toLowerCase() !== 'k') return;
      if (open) { e.preventDefault(); close({ clear: false, restore: true }); return; }
      if (isMobile) {
        if (document.querySelector('.modal-overlay, .sheet-backdrop')) return;
        e.preventDefault();
        flushSync(() => openSearch({ captureFocus: true }));
        inputRef.current?.focus();
        return;
      }
      const el = inputRef.current;
      const r = el?.getBoundingClientRect();
      const hit = r && r.width ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      if (!hit || !wrapRef.current?.contains(hit)) return;
      e.preventDefault();
      openSearch({ captureFocus: true });
      el.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, isMobile, openSearch, close, inputRef, wrapRef]);

  // Other surfaces (the FloatingNav menu's "Search" row) open search by event, exactly like
  // the spyglass: flushSync + a synchronous focus keep it inside the tap, so iOS raises the
  // keyboard.
  useEffect(() => {
    const onOpen = () => {
      flushSync(() => openSearch({ captureFocus: true }));
      inputRef.current?.focus();
    };
    window.addEventListener('cs:open-search', onOpen);
    return () => window.removeEventListener('cs:open-search', onOpen);
  }, [openSearch, inputRef]);

  return {
    isMobile, open, closing, query, setQuery, view, safeIndex, setActiveIndex,
    openSearch, close, closeClear, activate, onChange, onKeyDown, onFieldFocus,
    onBodyTouchStart, onBodyTouchMove,
  };
}

// Emphasize where the query matched: the first occurrence of each term, preferring one
// that starts a word ("pay" in "Payroll", not inside "Repay").
function Highlight({ text, ts }) {
  const str = String(text ?? '');
  if (!ts.length || !str) return str;
  const lower = str.toLowerCase();
  const ranges = [];
  for (const t of ts) {
    const first = lower.indexOf(t);
    let i = first;
    while (i > 0 && /[a-z0-9]/.test(lower[i - 1])) i = lower.indexOf(t, i + 1);
    if (i < 0) i = first;
    if (i >= 0) ranges.push([i, i + t.length]);
  }
  if (!ranges.length) return str;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out = [];
  let pos = 0;
  merged.forEach(([a, b], k) => {
    if (a > pos) out.push(str.slice(pos, a));
    out.push(<mark key={k} className="msearch-hl">{str.slice(a, b)}</mark>);
    pos = b;
  });
  if (pos < str.length) out.push(str.slice(pos));
  return out;
}

function Results({ s, listId }) {
  const { view, safeIndex, setActiveIndex, activate, query } = s;
  if (!view.flat.length) {
    return (
      <EmptyState
        icon={<Icon name="search" size={26} />}
        title={view.mode === 'query' ? 'No matches' : 'Search everything'}
        message={view.mode === 'query' ? 'Try a name, a number, or a page.' : 'Find any page, action or record.'}
      />
    );
  }
  const ts = terms(query);
  return (
    <div className="msearch-results" role="listbox" id={listId} aria-label="Search results">
      {view.groups.map((g) => {
        const capId = `msearch-cap-${g.key}`;
        return (
          <div className="msearch-group" role="group" aria-labelledby={capId} key={g.key}>
            <div className="msearch-cap" id={capId} role="presentation">{g.label}</div>
            {g.rows.map((row) => {
              const isActive = row.flatIndex === safeIndex;
              const common = {
                id: `msearch-opt-${row.flatIndex}`,
                type: 'button',
                role: 'option',
                tabIndex: -1,
                'aria-selected': isActive,
                onMouseMove: () => setActiveIndex(row.flatIndex),
                onMouseDown: (ev) => ev.preventDefault(), // keep focus in the field (combobox)
                onClick: (ev) => activate(row, { newTab: ev.metaKey || ev.ctrlKey }),
              };
              if (row.type === 'more') {
                return (
                  <button key={common.id} {...common} className={`msearch-opt msearch-seeall ${isActive ? 'kb-active' : ''}`}>
                    <span className="msearch-opt-icon"><Icon name="chevronRight" size={15} /></span>
                    <span className="msearch-opt-text"><span className="msearch-opt-label">{row.label}</span></span>
                  </button>
                );
              }
              const e = row.entry;
              // Explain a keyword-only match ONLY when the row doesn't already show why it
              // matched (every term visible in the label/sublabel = no hint needed).
              const shown = normalize(`${e.label} ${e.sublabel || ''}`);
              const hintShown = e.hint && !ts.every((t) => shown.includes(t));
              const tag = row.showType ? e.typeLabel : (hintShown ? `“${e.hint}”` : '');
              return (
                <button key={common.id} {...common} className={`msearch-opt ${isActive ? 'kb-active' : ''}`}>
                  <span className="msearch-opt-icon"><Icon name={e.icon || e.groupIcon || 'chevronRight'} size={16} /></span>
                  <span className="msearch-opt-text">
                    <span className="msearch-opt-label"><Highlight text={e.label} ts={ts} /></span>
                    {e.sublabel ? <span className="msearch-opt-sub">{e.sublabel}</span> : null}
                  </span>
                  {tag ? <span className="msearch-opt-tag">{tag}</span> : null}
                </button>
              );
            })}
            {g.more > 0 ? <div className="msearch-more" role="presentation">+{g.more} more, keep typing to narrow</div> : null}
          </div>
        );
      })}
    </div>
  );
}

// `ref` arrives as a plain prop (React 19) and is only attached / read in a handler.
function SearchInput({ ref, s, listId, iconSize = 15 }) {
  const { query, open, view, safeIndex, onChange, onKeyDown, onFieldFocus, setQuery } = s;
  return (
    <>
      <Icon name="search" size={iconSize} className="msearch-field-icon" />
      <input
        ref={ref}
        type="search"
        className="msearch-input"
        placeholder={PLACEHOLDER}
        aria-label={`Search ${IDENTITY.name}`}
        value={query}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onFocus={onFieldFocus}
        role="combobox"
        aria-expanded={open}
        aria-controls={open && view.flat.length ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && safeIndex >= 0 ? `msearch-opt-${safeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {query ? (
        <button
          type="button"
          className="input-clear"
          aria-label="Clear search"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={(ev) => { ev.stopPropagation(); setQuery(''); ref.current?.focus(); }}
        >
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </>
  );
}

// A screen-reader announcement of the result count as the query changes.
function LiveCount({ s }) {
  const { open, view } = s;
  const n = view.flat.filter((r) => r.type === 'result').length;
  const text = open && view.mode === 'query' ? (n ? `${n} result${n === 1 ? '' : 's'}` : 'No results') : '';
  return <div className="sr-only" aria-live="polite">{text}</div>;
}

// The phone search screen's content until you type (UI_RULES §116): quick-action tiles,
// recents, and the pages the tab tray doesn't show. All of it is permission-filtered upstream
// (registry.buildLaunchpad, live-validated recents), and a tap behaves exactly like picking
// a result: it lands in recents and navigates with a referrer.
function Launchpad({ s }) {
  const { view, activate } = s;
  const { actions, recents, pages } = view;
  const pick = (entry) => activate({ type: 'result', entry });
  if (!actions.length && !recents.length && !pages.length) {
    return <EmptyState icon={<Icon name="search" size={26} />} title="Search everything" message="Find any page, action or record." />;
  }
  return (
    <div className="msearch-lp">
      {actions.length ? (
        <section aria-labelledby="msearch-lp-actions">
          <h3 className="msearch-cap msearch-lp-cap" id="msearch-lp-actions">Quick actions</h3>
          <div className="msearch-lp-tiles">
            {actions.map((a) => (
              <button key={a.id} type="button" className="msearch-lp-tile" onClick={() => pick(a)}>
                <span className="msearch-lp-tile-icon">
                  <Icon name={a.glyph || 'plus'} size={16} />
                  <span className="msearch-lp-tile-plus"><Icon name="plus" size={9} strokeWidth={3} /></span>
                </span>
                <span className="msearch-lp-tile-label">{a.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {recents.length ? (
        <section aria-labelledby="msearch-lp-recent">
          <h3 className="msearch-cap msearch-lp-cap" id="msearch-lp-recent">Recent</h3>
          <div className="msearch-lp-chips">
            {recents.map((r) => (
              <button key={r.id} type="button" className="chip" onClick={() => pick(r)}>
                <Icon name={r.icon || r.groupIcon || 'chevronRight'} size={14} />
                <span>{r.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {pages.length ? (
        <section aria-labelledby="msearch-lp-goto">
          <h3 className="msearch-cap msearch-lp-cap" id="msearch-lp-goto">Go to</h3>
          <div className="msearch-lp-pages">
            {pages.map((p) => (
              <button key={p.id} type="button" className="msearch-lp-page" onClick={() => pick(p)}>
                <span className="msearch-lp-page-icon"><Icon name={p.icon} size={20} /></span>
                <span className="msearch-lp-page-label">{p.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// Crew don't get global search at all, desktop or mobile (owner decision, 2026-09-22): no
// field, no magnifier, no hotkey, no FloatingNav "Search" row. The desktop bar band stays —
// the bell sits in it and every page is laid out beneath it — it's just empty. The gate reads
// the EFFECTIVE (view-as) user, like the rest of the UI, and only non-crew mount the search
// itself, so crew never register its listeners.
export default function MasterSearch() {
  const user = useSelector(selectCurrentUser);
  const isMobile = useIsMobile();
  if (user?.role === 'crew') return isMobile ? null : <div className="topbar" />;
  return <GlobalSearch />;
}

function GlobalSearch() {
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const screenRef = useRef(null);
  const s = useMasterSearch(inputRef, wrapRef);
  // The phone screen pads its scroller by the on-screen keyboard, so every row stays
  // reachable above it (the keyboard shrinks only the visual viewport).
  useKeyboardInset(screenRef, s.isMobile && s.open);

  if (s.isMobile) {
    const listId = 'msearch-list-mobile';
    // Facebook-style (owner pick, 2026-09-22): the spyglass grows LEFTWARD into one search
    // bar across the top, a back arrow appears at the far left, and the page gives way to a
    // full-screen search. The field is focused inside the tap (flushSync + a synchronous
    // focus), so iOS raises the keyboard at once. Portaled to <body> (§105): it covers the
    // bell and the FloatingNav; the field's opening animation starts exactly on the spyglass.
    return (
      <>
        <button
          type="button"
          className="msearch-trigger"
          aria-label="Search"
          aria-haspopup="dialog"
          aria-expanded={s.open}
          onClick={() => { flushSync(() => s.openSearch({ captureFocus: true })); inputRef.current?.focus(); }}
        >
          <Icon name="search" size={18} />
        </button>
        {s.open ? createPortal(
          <div
            ref={screenRef}
            className={`msearch-screen${s.closing ? ' is-closing' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label="Search"
          >
            <div className="msearch-screen-bar">
              <button type="button" className="msearch-back" aria-label="Close search" onClick={s.closeClear}>
                <Icon name="arrowLeft" size={22} />
              </button>
              <div className="msearch-field msearch-screen-field" role="search">
                <SearchInput ref={inputRef} s={s} listId={listId} iconSize={18} />
              </div>
            </div>
            <div className="msearch-screen-body" onTouchStart={s.onBodyTouchStart} onTouchMove={s.onBodyTouchMove}>
              {s.view.mode === 'launchpad' ? <Launchpad s={s} /> : <Results s={s} listId={listId} />}
            </div>
          </div>,
          document.body,
        ) : null}
        <LiveCount s={s} />
      </>
    );
  }

  const listId = 'msearch-list';
  return (
    <div className="topbar">
      <div className="msearch" ref={wrapRef} role="search">
        <div className="msearch-shell" onClick={() => { s.openSearch(); inputRef.current?.focus(); }}>
          <SearchInput ref={inputRef} s={s} listId={listId} />
          {!s.query ? <kbd className="msearch-kbd" aria-hidden="true">{KBD_HINT}</kbd> : null}
        </div>
        <PopMenu open={s.open} onClose={() => s.close({ clear: false })} anchorRef={wrapRef} className="msearch-menu" sheetTitle="Search">
          <Results s={s} listId={listId} />
          <div className="msearch-foot" aria-hidden="true">
            <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> to move</span>
            <span><kbd>Enter</kbd> to open</span>
            <span><kbd>Esc</kbd> to close</span>
          </div>
        </PopMenu>
        <LiveCount s={s} />
      </div>
    </div>
  );
}
