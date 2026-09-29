import { rangeBounds, SCHEDULE_DATE_PRESETS } from './applyFilters';
import {
  selectVisibleSitesFor, selectClientById, selectActiveUsers, selectServices,
  selectEffectiveTagIds, selectEffectiveJobStatus, selectIsJobUnassignedActionable,
} from '../../store/selectors';

// FilterSpec[] for the Schedule page (and reused, as a subset, by the Variance
// report). ctx = { state, user }. Option providers read live data; match
// predicates are pure and operate on a job. See useUrlFilters + applyFilters +
// CLEANSPACE_SWEPT.md §5.2 / §2.6.

// Exported: the ONE status → label vocabulary for cleans (global search reuses it).
export const STATUS_OPTIONS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
  { value: 'missed', label: 'Missed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export const scheduleFilterSpecs = [
  {
    key: 'loc',
    label: 'Locations',
    kind: 'multi',
    options: (ctx) => selectVisibleSitesFor(ctx.state, ctx.user).map((site) => ({
      value: site.id,
      label: selectClientById(ctx.state, site.clientId)?.name || '—',
    })),
    match: (job, value) => !!job.siteId && value.includes(job.siteId),
  },
  {
    key: 'cleaner',
    label: 'Cleaners',
    kind: 'multi',
    options: (ctx) => selectActiveUsers(ctx.state).map((u) => ({ value: u.id, label: u.name })),
    // A multi-cleaner clean matches if ANY selected cleaner is on it.
    match: (job, value) => (job.crewIds || []).some((id) => value.includes(id)),
  },
  {
    key: 'tag',
    label: 'Tags',
    kind: 'multi',
    options: (ctx) => (ctx.state.tags || [])
      .filter((t) => t.scope === 'client' || t.scope === 'all')
      .map((t) => ({ value: t.id, label: t.label })),
    match: (job, value, ctx) => selectEffectiveTagIds(ctx.state, job).some((id) => value.includes(id)),
  },
  {
    key: 'status',
    label: 'Status',
    kind: 'multi',
    options: () => STATUS_OPTIONS,
    match: (job, value) => value.includes(selectEffectiveJobStatus(job)),
  },
  {
    key: 'svc',
    label: 'Service',
    kind: 'multi',
    options: (ctx) => selectServices(ctx.state).map((s) => ({ value: s.id, label: s.name })),
    match: (job, value) => !!job.serviceId && value.includes(job.serviceId),
  },
  {
    key: 'range',
    label: 'Date range',
    kind: 'dateRange',
    // Forward vocabulary — the shared retrospective presets end at `now` and
    // hid the entire future schedule on this surface (2026-07-30).
    presets: SCHEDULE_DATE_PRESETS,
    match: (job, value) => {
      const { from, to } = rangeBounds(value);
      const t = new Date(job.startAt).getTime();
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    },
  },
  {
    key: 'size',
    label: 'Crew size',
    kind: 'toggle',
    defaultValue: '',
    options: () => [
      { value: '', label: 'Any' },
      { value: '1', label: 'Solo' },
      { value: '2', label: '2' },
      { value: '3', label: '3+' },
    ],
    match: (job, value) => {
      const n = (job.crewIds || []).length;
      if (value === '1') return n === 1;
      if (value === '2') return n === 2;
      if (value === '3') return n >= 3;
      return true;
    },
  },
  {
    key: 'assign',
    label: 'Assignment',
    kind: 'toggle',
    defaultValue: '',
    options: () => [
      { value: '', label: 'Any' },
      { value: 'unassigned', label: 'Unassigned' },
    ],
    // Unassigned = no ACTIVE crew resolves onto the clean (named, standing, or
    // supplement — the shared crewResolve rule, so a standing-covered clean is
    // NOT "unassigned") AND it still needs someone (not done/cancelled). Same
    // predicate as the toolbar count chip, so the number and the rows agree.
    match: (job, value, ctx) => value !== 'unassigned' || selectIsJobUnassignedActionable(ctx.state, job),
  },
  {
    key: 'recur',
    label: 'Recurrence',
    kind: 'toggle',
    defaultValue: '',
    options: () => [
      { value: '', label: 'Any' },
      { value: 'recurring', label: 'Recurring' },
      { value: 'oneoff', label: 'One-off' },
    ],
    match: (job, value) => {
      const isRecurring = !!(job.seriesId || job.recurrence);
      if (value === 'recurring') return isRecurring;
      if (value === 'oneoff') return !isRecurring;
      return true;
    },
  },
];
