import { selectVisibleSitesFor, selectClientById, selectActiveUsers } from '../../store/selectors';

// FilterSpec[] for the Variance report — the SAME engine as the Schedule page
// (lib/filters), composed down to the facets a labor report supports. Unlike the
// schedule (which filters blob jobs in-memory via applyFilters), these values
// drive the bounded server query (siteIds / userIds / flaggedOnly), so the specs
// carry no match() predicate — they're consumed as the request shape. ctx =
// { state, user }. See CLEANSPACE_SWEPT.md §2.6 / §5.5.
export const varianceFilterSpecs = [
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
    key: 'cleaner',
    label: 'Cleaners',
    kind: 'multi',
    options: (ctx) => selectActiveUsers(ctx.state).map((u) => ({ value: u.id, label: u.name })),
  },
  {
    key: 'flagged',
    label: 'Flagged',
    kind: 'toggle',
    defaultValue: '',
    options: () => [
      { value: '', label: 'All' },
      { value: '1', label: 'Flagged only' },
    ],
  },
  {
    key: 'group',
    label: 'Group by',
    kind: 'toggle',
    defaultValue: 'clean',
    options: () => [
      { value: 'clean', label: 'Clean' },
      { value: 'cleaner', label: 'Cleaner' },
      { value: 'location', label: 'Location' },
    ],
  },
];
