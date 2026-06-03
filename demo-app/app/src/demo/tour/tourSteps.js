// Guided demo tour steps (demo only). Each step spotlights a persistent element
// in the live CRM. Copy consistently reinforces that the platform is THEIRS to
// configure — what shows on the dashboard, which modules are on, the brand.
//
// `selector` targets an on-screen element (null/`placement:'center'` = no
// spotlight, centered intro card). All targets live in the CRM shell so the tour
// never has to navigate between routes.

export const TOUR_STEPS = [
  {
    selector: null,
    placement: 'center',
    title: 'Welcome — this demo is yours to shape',
    body: 'Click through the real product with live sample data. As you go, remember: everything here is configurable to how your business actually runs. Let’s take a quick look.',
  },
  {
    selector: '.main',
    placement: 'center',
    title: 'Your dashboard, your way',
    body: 'This is your command center — and you decide what lives on it. Revenue, today’s schedule, follow-ups, top clients: we configure the cards to surface what matters most to your business.',
  },
  {
    selector: '[data-tour="core"]',
    placement: 'right',
    title: 'Everything’s a module',
    body: 'Scheduling, CRM, sales pipeline, messaging, invoicing — all included in Core. We arrange and label these around your workflow, and roles control who sees what.',
  },
  {
    selector: '[data-tour="addons"]',
    placement: 'right',
    title: 'Add only what you need',
    body: 'Bolt on modules like Field Ops, Inventory, or QuickBooks as one-time add-ons — set up for your business, so you never pay for what you don’t use.',
  },
  {
    selector: '[data-tour="theme"]',
    placement: 'right',
    title: 'Make it your brand',
    body: 'Preview the whole platform in different brand colors. Your live deployment is set up in your company’s palette — this is your software, not a generic tool.',
  },
  {
    selector: '.pp-cart-fab',
    placement: 'left',
    title: 'Simple, transparent pricing',
    body: 'Core plus any add-ons you choose — one clear checkout, and you confirm your brand style there too. Ready whenever you are.',
  },
];
