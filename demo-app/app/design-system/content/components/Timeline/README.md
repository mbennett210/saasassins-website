# Timeline

The schedule's day view: a vertical track of cleans, each a status-tinted row-card with a coloured rail and a matching dot. It is the reference surface for the schedule (THEME_CLEANSPACE R7).

These are CSS classes (`.tl-*`) from `components/bundle.css`, laid out exactly as the Schedule page renders them.

## Anatomy

- Container: a white card, `.card.dash-card.tl-day-card`.
- `.tl-track` with a 2px `border-mid` line. Each `.tl-item.{status}` holds a 10px `.tl-dot`, a `.tl-time` label (10px/700 uppercase, ink) and a `.tl-card`.
- `.tl-card`: `10px 14px` padding, 12px corners, a 4px left rail, tinted by status. Done: `sched-card-done-bg` with a green rail. In progress: `sched-card-prog-bg`, amber. Missed: `sched-card-miss-bg`, red. Upcoming: `sched-card-upcoming-bg`, gold. Cancelled: `color-neutral-100`, slate.
- `.tl-card-head`: the title (13px, the customer in bold, then the service), `.tl-card-meta` for the status Badge, and `.tl-card-action`, a reserved 108px trailing slot for Reschedule. The crew line sits under it in `.text-xs.text-muted`.

## Rules

- Row-cards are never white on white: they pop off the white container by their fill.
- Badges share one axis and actions another, because the action slot is always reserved even when empty (R4).
- The rail colours are the constant status set; an upcoming clean is gold, not blue.

Known drift: a later "Timeline status variants" block in `index.css` refills the dots, so an upcoming dot renders a gold ring with a black centre and a cancelled dot a slate ring with a red centre, where R7 asks for solid gold and slate. The preview shows what renders today.
