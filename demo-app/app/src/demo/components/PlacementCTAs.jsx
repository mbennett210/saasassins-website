import { useLocation } from 'react-router-dom';
import { IS_DEMO } from '../isDemo';
import { modulesForPlacement } from '../modules.catalog';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import ModuleCTA from './ModuleCTA';
import InfoButton from './InfoButton';
import '../placement.css';

// Route-aware in-context surface. Mounted once at the bottom of <main> (AppLayout)
// behind IS_DEMO; picks the module(s) relevant to the current feature page and
// renders their CTAs plus a glowing info button. Returns null when the route has
// no mapped module, so it only appears "in the relevant section". Driven off each
// module's `placements` in the catalog — add a module there and it shows up here
// automatically. No pricing, no cart: each CTA points to a Strike Call.

const ROUTE_PLACEMENT = [
  { match: (p) => p === '/' || p === '/demo', key: 'dashboard' },
  { match: (p) => p.startsWith('/invoices'), key: 'invoices' },
  { match: (p) => p.startsWith('/schedule'), key: 'schedule' },
  { match: (p) => p.startsWith('/contacts'), key: 'clients' },
  { match: (p) => p.startsWith('/pipeline'), key: 'pipeline' },
  { match: (p) => p.startsWith('/settings/team'), key: 'team' },
  { match: (p) => p.startsWith('/settings/integrations'), key: 'integrations' },
];

export default function PlacementCTAs() {
  const { pathname } = useLocation();
  const company = selectCompany(useStore());
  if (!IS_DEMO) return null;

  const hit = ROUTE_PLACEMENT.find((r) => r.match(pathname));
  if (!hit) return null;
  const mods = modulesForPlacement(hit.key);
  if (mods.length === 0) return null;

  return (
    <section className="pp-placement" aria-label="Related modules for this area">
      <div className="pp-placement-head">
        <h3>Also available for this area</h3>
        <InfoButton title="About modules" glowKey="placement:about" label="About modules">
          <p className="pp-info-lead">
            Your {company.name} platform includes every core feature shown here. These modules
            extend it — each one custom-built and integrated for your business. Book a call and
            we'll scope exactly what you need.
          </p>
        </InfoButton>
      </div>
      {mods.map((m) => (
        <ModuleCTA key={m.id} moduleId={m.id} variant="inline" />
      ))}
    </section>
  );
}
