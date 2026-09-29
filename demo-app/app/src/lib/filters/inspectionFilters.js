import { rangeBounds, isDayKey } from './applyFilters';
import { selectVisibleSitesFor, selectClientById, selectActiveUsers } from '../../store/selectors';
import { INSPECTION_RESULTS, resultLabel } from '../inspections';

// FilterSpec[] for the Quality-hub inspection records — the SAME engine as Schedule
// + Variance (lib/filters), composed to the facets an inspection list supports. Like
// Variance (and unlike the Schedule), the values shape the SERVER read: the specs carry
// no match() predicate, and inspectionListQuery below turns them into the filters
// qcApi.listInspections / inspectionFigures / exportInspections send. They used to run
// in the browser over the org's newest 200 inspections, so once the org passed 200 a
// location's, an inspector's or an older range's inspections fell out of the list, its
// figures and its CSV. ctx = { state, user }. See CLEANSPACE_SWEPT.md §2.6.
export const inspectionFilterSpecs = [
  {
    key: 'loc',
    label: 'Locations',
    kind: 'multi',
    options: (ctx) => selectVisibleSitesFor(ctx.state, ctx.user).map((site) => ({
      value: site.id,
      label: selectClientById(ctx.state, site.clientId)?.name || '—',
    })),
  },
  {
    key: 'result',
    label: 'Result',
    kind: 'multi',
    options: () => INSPECTION_RESULTS.map((value) => ({ value, label: resultLabel(value) })),
  },
  {
    key: 'inspector',
    label: 'Inspector',
    kind: 'multi',
    options: (ctx) => selectActiveUsers(ctx.state).map((u) => ({ value: u.id, label: u.name })),
  },
  {
    key: 'range',
    label: 'Date range',
    kind: 'dateRange',
  },
];

// The facet values → the inspection filters the server reads:
//   { filters: { siteIds, results, inspectorIds, fromIso, toIso } } | { error }
// Call it when the read RUNS, never earlier: a rolling preset ("7d", "This week") is
// resolved against `now`. A range that ends now goes up with no end at all, since nothing
// is performed later; a browser clock running behind the server's would otherwise hide an
// inspection submitted a moment ago. The bounds are the engine's (applyFilters.rangeBounds,
// org-zone days, a custom range running through the last millisecond of its end day). A
// custom range that ends before it starts, or holds a date that isn't one (a truncated
// link), is an { error }, not a query: the engine would leave that bound open, and a read
// must not widen.
export function inspectionListQuery(values = {}, now = new Date()) {
  const list = (v) => (Array.isArray(v) && v.length ? v : null);
  const custom = values.range || {};
  if ((custom.from && !isDayKey(custom.from)) || (custom.to && !isDayKey(custom.to))) {
    return { error: 'One of those dates isn’t a real date. Pick the dates again.' };
  }
  const { from, to } = rangeBounds(values.range || null, now);
  if (from && to && from.getTime() > to.getTime()) {
    return { error: 'The start date is after the end date.' };
  }
  return {
    filters: {
      siteIds: list(values.loc),
      results: list(values.result),
      inspectorIds: list(values.inspector),
      fromIso: from ? from.toISOString() : null,
      toIso: to && to.getTime() !== now.getTime() ? to.toISOString() : null,
    },
  };
}
