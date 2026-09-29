# AutoGrowTextarea

A textarea that grows downward with its content instead of showing a drag handle.

## Props

- `value` and any textarea props. `rows` (default 2) is the starting and minimum height. `className` defaults to `'input'`, so it looks like every other field.

## Behaviour

It never caps its own height: when it outgrows its container, the container scrolls (each New Job column on desktop, the whole card on a phone). It re-fits on every value change and on resize, before paint, so it never flashes at the wrong height.

## Rules

Use it for notes and instructions anywhere the text length varies. Never let a textarea expand past its container with the native handle.
