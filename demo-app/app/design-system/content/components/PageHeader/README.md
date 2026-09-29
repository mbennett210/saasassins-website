# PageHeader

The title row at the top of a list or settings page, with that page's actions on the right.

## Props

- `title`: the page's name, the same words as its nav row ("Customers", "Schedule", "Invoices").
- `actions`: optional; usually one or two filled buttons.

## Look

`.page-head` is a flex row with 10px gaps and 20px below it. `.page-head-title` is 20px/700 `text-primary`. `.page-head-actions` sits on the right with 8px between buttons. At 640px and below the head stacks and the buttons share the width.

## Rules

Actions are filled role pairs (UI_RULES §11), for example Import CSV (`btn-gold`) with Add Customer (`btn-primary`). No "+" in the labels.
