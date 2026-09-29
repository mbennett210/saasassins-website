# Icons

All 49 glyphs of the app's `Icon` component, each rendered through the component itself into a standalone 24×24 SVG (file name = the `name` prop).

- Stroke icons: `fill="none"`, `stroke="currentColor"`, `stroke-width="2"`, round caps and joins. Four are filled (`phoneSolid`, `mailSolid`, `messagingSolid`, `grip`); `dollarCircle` draws its "$" as text.
- Ink: `currentColor`. Shown through `<img>` they render black; inline the SVG (or use `window.CleanSpace.Icon`) so the icon takes the colour of its text, as it does in the app.
- Sizes in use: 20px (nav, default), 14 to 15px (chevrons, search), 12px (in small buttons), 28px (empty states).
