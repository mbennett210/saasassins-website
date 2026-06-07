// In-content info points for the demo "tour". One gentle, pinging "i" pin per CRM
// surface, placed right after that page's header TITLE text and keyed by route —
// so the whole tour lives in the demo layer with no markup added to the CRM pages.
//
// The InfoPinLayer measures the title text (via a Range, so the pin lands just
// after the words rather than at the header block's far-right edge) and shows
// `title`/`body` in a small bubble beside the pin on click.
//
//   path / match : 'exact' → pathname === path; 'prefix' → path or path + '/…'.
//   selector     : the page's title element. Pages hand-roll their header as
//                  either <h1 class="page-head-title"> or <div class="page-head">
//                  <h1>; this combined selector catches both.
//   side         : which way the info bubble opens from the pin.
//
// Note: the dashboard lives at /demo in the marketing demo (the index route is the
// product landing page). Messaging uses a custom header (no .page-head) and is
// intentionally not listed yet — it needs its own title selector before it gets a pin.

const TITLE = '.page-head-title, .page-head h1';

export const INFO_POINTS = [
  {
    key: 'dashboard', path: '/demo', match: 'exact', selector: TITLE, side: 'bottom',
    title: 'Your dashboard',
    body: 'Your command center. We configure which cards surface here — revenue, today’s schedule, follow-ups — around what matters most to your business.',
  },
  {
    key: 'schedule', path: '/schedule', match: 'prefix', selector: TITLE, side: 'bottom',
    title: 'Scheduling & calendar',
    body: 'Jobs, crews, and the calendar in one place — schedule work, assign your team, and keep the day organized.',
  },
  {
    key: 'clients', path: '/contacts', match: 'prefix', selector: TITLE, side: 'bottom',
    title: 'Your CRM',
    body: 'The people (Contacts) and companies (Accounts) you serve — the heart of the platform, with full history on each.',
  },
  {
    key: 'pipeline', path: '/pipeline', match: 'prefix', selector: TITLE, side: 'bottom',
    title: 'Sales pipeline',
    body: 'Track every deal through the stages your team actually uses — drag cards along as work progresses.',
  },
  {
    key: 'invoices', path: '/invoices', match: 'prefix', selector: TITLE, side: 'bottom',
    title: 'Invoices & payments',
    body: 'Log invoices and payments here. Add the Invoicing + Quoting module for online card payments and automatic reminders.',
  },
  {
    key: 'marketing', path: '/marketing', match: 'prefix', selector: TITLE, side: 'bottom',
    title: 'Marketing',
    body: 'Multi-step email sequences with shared rotation inboxes and AI-routed replies — an add-on module.',
  },
  {
    key: 'settings', path: '/settings', match: 'prefix', selector: TITLE, side: 'bottom',
    title: 'Make it yours',
    body: 'Company details, team, roles & permissions, and services — configured to exactly how you run.',
  },
];

// Every info point whose route matches the current pathname.
export function pointsForPath(pathname) {
  return INFO_POINTS.filter((p) =>
    p.match === 'exact'
      ? pathname === p.path
      : pathname === p.path || pathname.startsWith(`${p.path}/`),
  );
}
