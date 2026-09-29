import { selectVisibleSitesFor, selectClientById, selectActiveUsers } from '../../store/selectors';

// FilterSpec[] for the Drive-time report — the same engine + facet vocabulary as
// varianceFilterSpecs, minus the group-by (a drive leg is already one row per
// cleaner per hop, so there's nothing to re-aggregate).
//
// ⚠️ The `loc` facet is applied by the server AFTER the legs are derived, not as a
// query filter: removing a middle clean before pairing would let its neighbours
// pair across it and fabricate a "drive" that contains a whole clean. A location
// filter here means "legs that START or END at these sites". See
// api/_lib/time/driveCompute.js.
export const driveFilterSpecs = [
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
      { value: '1', label: 'Over estimate' },
    ],
  },
];
