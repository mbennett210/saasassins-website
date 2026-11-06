# Avatar

Initials on a black disc in gold letters: the one avatar treatment in Clean Space. A team member who has added a profile photo shows it in the same disc (UI_RULES §141).

## Props

- `user`: a team member's row. The avatar reads its `initials`, its colour (`avatar`) and its `photo` from it, so one person's letters can never sit under another's face. Pass it for every team member; contacts, customers and companies pass `initials` instead and never show a photo.
- `initials`: one or two letters, when there is no `user`.
- `size`: `'xs'` 20px (9px letters), `'sm'` 28px (10px, the default), `'md'` 36px (12px), `'lg'` 48px (16px), `'xl'` 64px (20px, the profile cards where a person sets their photo).
- `variant`: 1 to 5, when there is no `user`. All five resolve to `color-brand-primary-500` in Clean Space (owner call, 2026-08-16: black background, gold lettering for everyone), so the number no longer changes the colour.
- `centred`: the initials sit in the disc's middle by their ink, worked out by code (`components/Centred.jsx`, kind "ink", the styling vault's "Icons sit in the middle"). Opted into per screen: Settings → Team's list (UI_RULES §191); every other avatar draws its initials as it always has.

## Look

A `badge-radius` disc with weight-600 letters in `color-brand-secondary-500` (gold on the black holds 14:1). A photo fills the disc (`object-fit: cover`) and appears only once it has loaded: until then, and if it never loads, the initials show. The box never changes size, so a photo arriving moves nothing on the page.

## Rules

- The photo is a signed link the app asks for in batches (`lib/avatarUrls.js`); a link that fails is asked for once more, then the initials stay.
- The image is decorative (`alt=""`): the person's name is always written beside their avatar.
