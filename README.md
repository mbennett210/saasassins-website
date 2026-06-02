# SaaSassins — Dev Studio Marketing Site

Static marketing site for SaaSassins, a dev studio that builds custom software businesses own forever. Zero build step — pure HTML, CSS, and vanilla JavaScript.

## Structure

```
.
├── index.html         Home / landing
├── about.html         Our story, values, tech stack
├── showcase.html      Product showcase (PolishPoint case study + pipeline)
├── contact.html       Calendly CTA + message form
├── css/
│   ├── tokens.css     Design tokens (colors, spacing, motion) — edit here to re-theme
│   └── style.css      Layout, components, animations
├── js/
│   └── main.js        Nav, scroll reveal, counters, FAQ, calculator, spotlight
├── images/            Logos + product screenshots
├── vercel.json        Deploy config (clean URLs, cache headers, security headers)
└── .gitignore
```

## Design System

The entire color/motion system lives in `css/tokens.css`. To re-theme:
1. Edit the CSS custom properties in `:root`
2. `style.css` reads only from those tokens — no hard-coded colors

Palette: blood red (`--red-*`) + near-black (`--dark-*`) + charcoal gradient (`--char-*`) + metallic silver (`--silver-*`).

## Local Development

```bash
# Serve locally
python3 -m http.server 8000
# → http://localhost:8000
```

No build step, no dependencies to install.

## Deploy to Vercel

```bash
# From this directory
vercel              # preview deploy
vercel --prod       # production deploy
```

Or connect the repo in the Vercel dashboard — pushes to `main` auto-deploy.

## Swapping Later

- **Calendly URL** — set in `js/main.js` inside `openCalendly()`
- **Email** — `hello@saasassins.com` across all pages + the contact form's mailto handler
- **PolishPoint live URL** — `showcase.html` has a placeholder pointing to `https://polishpoint.app`
- **Product screenshots** — replace `images/polishpoint-*.png` as the product evolves; add new products as `images/[product]-*.png` and duplicate the showcase-card block
