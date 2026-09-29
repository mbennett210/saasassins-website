# Icon

The app's one icon set: 49 hand-picked stroke glyphs on a 24px grid.

## Props

- `name`: a registry key (listed below). An unknown name renders nothing.
- `size`: in px (default 20). `strokeWidth` (default 2). `className` and any SVG attribute pass through.

## Look

`fill: none`, `stroke: currentColor`, round caps and joins, so an icon takes the colour of the text around it. Sizes in use: 20 (the nav and the default), 14 to 15 (chevrons, the search magnifier), 12 inside `.btn-sm`, 28 in empty states. In the nav, strokes carry `vector-effect: non-scaling-stroke` so they draw a crisp 2px line at any size (UI_RULES §110). Four glyphs are filled (`phoneSolid`, `mailSolid`, `messagingSolid`, `grip`), and `dollarCircle` draws its "$" as text.

## Names

dashboard · schedule · clients · invoices · reminders · messaging · settings · search · plus · edit · trash · check · x · camera · bell · bellOff · building · chart · dollarCircle · user · lock · logout · archive · tag · filter · mail · phone · mapPin · phoneSolid · mailSolid · messagingSolid · chevronRight · chevronLeft · arrowLeft · chevronUp · chevronDown · resizeGrip · dots · star · moon · folder · forms · expand · repeat · warning · paperclip · upload · box · grip

## Rules

- Icons label and categorise; they never replace a verb on a button, and `plus` never prefixes a create button (§12).
- The same glyphs ship as SVG files in the Icons asset group, for places that can't run the component.
