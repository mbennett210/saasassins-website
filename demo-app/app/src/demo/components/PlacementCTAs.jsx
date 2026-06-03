import { useLocation } from 'react-router-dom';
import { IS_DEMO } from '../isDemo';
import { modulesForPlacement } from '../modules.catalog';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import ModuleCTA from './ModuleCTA';
import InfoButton from './InfoButton';
import '../placement.css';

// Route-aware in-context upsell. Mounted once at the bottom of <main> (AppLayout)
// behind IS_DEMO; picks the add-on(s) relevant to the current feature page and
// renders their add-to-cart CTAs plus a glowing info button. Returns null when
// the route has no mapped module, so it only appears "in the relevant section".
// Driven off each module's `placements` in the catalog — add a module there and
// it shows up here automatically.

const ROUTE_PLACEMENT = [
  { match: (p) => p === '/', key: 'dashboard' },
  { match: (p) => p.startsWith('/invoices'), key: 'invoices' },
  { match: (p) => p.startsWith('/schedule'), key: 'schedule' },
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
    <section className="pp-placement" aria-label="Recommended add-ons for this area">
      <div className="pp-placement-head">
        <h3>Recommended add-on{mods.length > 1 ? 's' : ''} for this area</h3>
        <InfoButton title="About add-on modules" glowKey="placement:about" label="About add-on modules">
          <p className="pp-info-lead">
            Your {company.name} platform includes every core feature shown here. Add-on modules are
            optional one-time purchases that extend it — tailored and integrated for your business.
            Add any to your cart, keep exploring, and confirm everything at checkout.
          </p>
        </InfoButton>
      </div>
      {mods.map((m) => (
        <ModuleCTA key={m.id} moduleId={m.id} variant="inline" />
      ))}
    </section>
  );
}
