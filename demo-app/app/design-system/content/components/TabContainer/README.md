# TabContainer

A segmented pill for switching views: Day, Week, Month, Cleaner on the schedule; Today, Yesterday on a report.

## Props

- `tabs`: string[]; the labels are the values.
- `active`: the selected label. `onChange(label)`.
- `className`: extra classes for placement; the §7 look is built in.

Pages often write the same markup by hand (`<div class="tab-container-line" role="group" aria-label="Period">` with `.tab-btn` buttons); the component renders exactly that.

## One look

`tab-container tab-container-line` (UI_RULES §7): a white track with a `card-border` hairline, a full pill with a 3px inset, equal-width segments that hug their content, and a solid black active segment with white text. This is the schedule's segmented rail (THEME_CLEANSPACE R7). The component always renders it; the older bare `tab-container` look (an 8% ink glass track with 12px corners) is retired.

A segment lays out an icon or a count with a 6px gap. A total rides in `.control-count` (a neutral pill, translucent white on the active segment; a chip carries the same one); an unread count rides in `.inbox-toggle-unread`.

Segments are full pills with 13px/600 labels in `text-body`; the active one fills black with white text. At 640px and below the line variant becomes a one-line scrolling rail with a right-edge fade (R8).

## Rules

Don't invent another selector style: `.segmented` (Match all / Match any) and the messaging inbox toggle are the only siblings; they render the same way, and `test-control-parity.mjs` holds them to one declaration. Underline tabs are `SectionTabs` (UI_RULES §69).
