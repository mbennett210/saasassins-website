// Demo seed for the Quality Control + Labor Variance modules.
//
// Rainier ships these engines EMPTY (records live in Supabase). The demo is
// mock-data-locked, so this module AUTHORS a believable janitorial dataset:
// published inspection templates, scored inspection records, a cross-account
// problems queue, and a night's worth of multi-cleaner time entries with
// deliberate over/under flags. Names are denormalized onto every record so the
// QC surfaces never need to reach into the main store.
//
// Built relative to `new Date()` at load so the variance "morning scan" always
// reads as "last night" no matter what day the demo is shown.

import { scoreInspection, flattenItems } from '../../lib/inspections';

// ── time helpers ──────────────────────────────────────────────────────────
function atDaysAgo(days, hour, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}
function minsAgo(mins) {
  const d = new Date();
  d.setMinutes(d.getMinutes() - mins);
  return d.toISOString();
}

// ── cleaners ──────────────────────────────────────────────────────────────
const MARIA = { userId: 'u-maria', userName: 'Maria Santos' };
const JAMES = { userId: 'u-james', userName: 'James Okoro' };
const PRIYA = { userId: 'u-priya', userName: 'Priya Nair' };

// ── inspection templates ──────────────────────────────────────────────────
const PASSFAIL = { type: 'passfail', passThreshold: 80 };
const NUMERIC5 = { type: 'numeric', max: 5, passThreshold: 80 };

const TEMPLATES = [
  {
    id: 'tmpl-office-nightly',
    name: 'Office Nightly Clean — Standard',
    kind: 'inspection',
    status: 'published',
    version: 3,
    scale: PASSFAIL,
    areas: [
      { id: 'a1', label: 'Restrooms', items: [
        { id: 'i1', label: 'Toilets & urinals sanitized', photoRequired: true },
        { id: 'i2', label: 'Floors mopped & dry' },
        { id: 'i3', label: 'Mirrors & sinks streak-free' },
        { id: 'i4', label: 'Supplies restocked (soap, paper)' },
      ] },
      { id: 'a2', label: 'Floors & Common Areas', items: [
        { id: 'i5', label: 'Carpets vacuumed' },
        { id: 'i6', label: 'Hard floors mopped' },
        { id: 'i7', label: 'Entrance glass cleaned' },
        { id: 'i8', label: 'Trash & recycling removed' },
      ] },
      { id: 'a3', label: 'Kitchen / Breakroom', items: [
        { id: 'i9', label: 'Counters & tables wiped' },
        { id: 'i10', label: 'Sink scrubbed' },
        { id: 'i11', label: 'Floor mopped' },
      ] },
    ],
  },
  {
    id: 'tmpl-medical',
    name: 'Medical Facility Inspection',
    kind: 'inspection',
    status: 'published',
    version: 2,
    scale: NUMERIC5,
    areas: [
      { id: 'm1', label: 'Exam Rooms', items: [
        { id: 'mi1', label: 'High-touch surfaces disinfected' },
        { id: 'mi2', label: 'Exam tables & paper changed' },
        { id: 'mi3', label: 'Biohazard handling correct' },
      ] },
      { id: 'm2', label: 'Restrooms', items: [
        { id: 'mi4', label: 'Sanitation & restock' },
        { id: 'mi5', label: 'Floor & fixture detail' },
      ] },
      { id: 'm3', label: 'Waiting & Reception', items: [
        { id: 'mi6', label: 'Seating wiped' },
        { id: 'mi7', label: 'Floors & glass' },
      ] },
    ],
  },
  {
    id: 'tmpl-restroom-spot',
    name: 'Restroom Spot Check',
    kind: 'inspection',
    status: 'published',
    version: 1,
    scale: PASSFAIL,
    areas: [
      { id: 'r1', label: 'Restroom', items: [
        { id: 'ri1', label: 'Stalls clean' },
        { id: 'ri2', label: 'Floor dry' },
        { id: 'ri3', label: 'Supplies stocked' },
        { id: 'ri4', label: 'Odor-free' },
      ] },
    ],
  },
];

// Helper: build an inspection record from a template + a rating map, scoring it
// with the same pure engine the product uses.
function makeInspection({ id, template, site, client, inspector, daysAgo, ratings, comments = {}, photoItems = [] }) {
  const areas = template.areas.map((a) => ({
    id: a.id,
    label: a.label,
    items: a.items.map((it) => ({
      id: it.id,
      label: it.label,
      rating: ratings[it.id] ?? 'na',
      comment: comments[it.id] || '',
      photo: photoItems.includes(it.id),
    })),
  }));
  const { overallScore, result } = scoreInspection(flattenItems(areas), template.scale);
  return {
    id,
    token: id,
    templateId: template.id,
    templateName: template.name,
    scale: template.scale,
    siteId: site.id,
    siteName: site.name,
    clientName: client,
    inspectorName: inspector,
    date: atDaysAgo(daysAgo, 9, 30),
    areas,
    overallScore,
    result,
  };
}

const SITES = {
  riverside: { id: 'site-riverside', name: 'Riverside Medical Center' },
  downtown: { id: 'site-downtown', name: 'Downtown Office Tower' },
  harborview: { id: 'site-harborview', name: 'Harborview Apartments' },
  lincoln: { id: 'site-lincoln', name: 'Lincoln Elementary' },
  techpark: { id: 'site-techpark', name: 'Tech Park — Building C' },
  grandview: { id: 'site-grandview', name: 'Grandview Mall' },
};

const INSPECTIONS = [
  makeInspection({
    id: 'insp-riverside', template: TEMPLATES[1], site: SITES.riverside, client: 'Riverside Health Group',
    inspector: 'Dana Whitfield', daysAgo: 0,
    ratings: { mi1: 5, mi2: 5, mi3: 4, mi4: 5, mi5: 4, mi6: 5, mi7: 5 },
    comments: { mi3: 'Minor dust on light cover, flagged to crew.' },
    photoItems: ['mi1', 'mi4'],
  }),
  makeInspection({
    id: 'insp-downtown', template: TEMPLATES[0], site: SITES.downtown, client: 'Meridian Property Mgmt',
    inspector: 'Dana Whitfield', daysAgo: 0,
    ratings: { i1: 'pass', i2: 'pass', i3: 'fail', i4: 'fail', i5: 'pass', i6: 'pass', i7: 'fail', i8: 'pass', i9: 'pass', i10: 'pass', i11: 'pass' },
    comments: { i3: 'Mirrors streaked on 3rd floor.', i4: 'Soap dispensers empty, 2nd floor men’s.', i7: 'Entrance glass smudged.' },
    photoItems: ['i4'],
  }),
  makeInspection({
    id: 'insp-harborview', template: TEMPLATES[0], site: SITES.harborview, client: 'Harborview Residential',
    inspector: 'Marcus Lee', daysAgo: 1,
    ratings: { i1: 'pass', i2: 'pass', i3: 'pass', i4: 'pass', i5: 'fail', i6: 'pass', i7: 'pass', i8: 'pass', i9: 'pass', i10: 'pass', i11: 'pass' },
    comments: { i5: 'Lobby carpet stain not treated.' },
  }),
  makeInspection({
    id: 'insp-lincoln', template: TEMPLATES[0], site: SITES.lincoln, client: 'Lincoln Unified School District',
    inspector: 'Marcus Lee', daysAgo: 1,
    ratings: { i1: 'fail', i2: 'pass', i3: 'pass', i4: 'fail', i5: 'pass', i6: 'fail', i7: 'pass', i8: 'pass', i9: 'pass', i10: 'fail', i11: 'pass' },
    comments: { i1: 'Two stalls missed in east wing.', i6: 'Gym floor not mopped.' },
  }),
  makeInspection({
    id: 'insp-techpark', template: TEMPLATES[0], site: SITES.techpark, client: 'Apex Coworking',
    inspector: 'Dana Whitfield', daysAgo: 2,
    ratings: { i1: 'pass', i2: 'pass', i3: 'pass', i4: 'pass', i5: 'pass', i6: 'pass', i7: 'pass', i8: 'pass', i9: 'pass', i10: 'pass', i11: 'pass' },
  }),
  makeInspection({
    id: 'insp-grandview', template: TEMPLATES[2], site: SITES.grandview, client: 'Grandview Retail Partners',
    inspector: 'Marcus Lee', daysAgo: 2,
    ratings: { ri1: 'pass', ri2: 'pass', ri3: 'pass', ri4: 'fail' },
    comments: { ri4: 'Lingering odor near east entrance restroom.' },
  }),
];

// ── problems / punch-list queue (cross-account) ───────────────────────────
const PROBLEMS = [
  { id: 'prob-1', title: 'Soap dispensers empty — 2nd floor men’s', siteName: 'Downtown Office Tower', clientName: 'Meridian Property Mgmt', severity: 'high', status: 'open', reportedBy: 'Dana Whitfield', date: atDaysAgo(0, 9, 40), note: 'Reported during nightly inspection. Restock + check supply par level.' },
  { id: 'prob-2', title: 'Lobby carpet stain not treated', siteName: 'Harborview Apartments', clientName: 'Harborview Residential', severity: 'medium', status: 'open', reportedBy: 'Marcus Lee', date: atDaysAgo(1, 8, 15), note: 'Coffee stain near elevators. Needs spot extraction.' },
  { id: 'prob-3', title: 'Gym floor missed — east wing', siteName: 'Lincoln Elementary', clientName: 'Lincoln Unified School District', severity: 'medium', status: 'acknowledged', reportedBy: 'Marcus Lee', date: atDaysAgo(1, 8, 20), note: 'Crew lead acknowledged; re-clean scheduled tonight.' },
  { id: 'prob-4', title: 'Burned-out light — stairwell B', siteName: 'Grandview Mall', clientName: 'Grandview Retail Partners', severity: 'low', status: 'resolved', reportedBy: 'Maria Santos', date: atDaysAgo(3, 19, 0), note: 'Reported to property maintenance; bulb replaced.' },
];

// ── time entries → the variance "morning scan" ────────────────────────────
// One row per cleaner per clean. expectedMinutesSnapshot = the per-account
// expected clean time captured at clock-in (the variance baseline).
function entry(o) {
  return {
    approvalStatus: 'pending',
    geofenceResult: 'inside',
    distanceM: 24,
    ...o,
  };
}
const TIME_ENTRIES = [
  // Riverside — single cleaner, ran 60m long → OVER (red)
  entry({ id: 't1', jobId: 'job-a', siteId: SITES.riverside.id, siteName: SITES.riverside.name, clientId: 'c-riverside', clientName: 'Riverside Health Group', ...MARIA, clockInAt: atDaysAgo(1, 18, 2), clockOutAt: atDaysAgo(1, 22, 2), durationMinutes: 240, expectedMinutesSnapshot: 180, scheduledStart: atDaysAgo(1, 18, 0) }),
  // Downtown — two cleaners, labor 210 vs 240 expected → UNDER (amber); one off-site override
  entry({ id: 't2', jobId: 'job-b', siteId: SITES.downtown.id, siteName: SITES.downtown.name, clientId: 'c-meridian', clientName: 'Meridian Property Mgmt', ...MARIA, clockInAt: atDaysAgo(1, 19, 5), clockOutAt: atDaysAgo(1, 20, 55), durationMinutes: 110, expectedMinutesSnapshot: 240, scheduledStart: atDaysAgo(1, 19, 0) }),
  entry({ id: 't3', jobId: 'job-b', siteId: SITES.downtown.id, siteName: SITES.downtown.name, clientId: 'c-meridian', clientName: 'Meridian Property Mgmt', ...JAMES, clockInAt: atDaysAgo(1, 19, 8), clockOutAt: atDaysAgo(1, 20, 48), durationMinutes: 100, expectedMinutesSnapshot: 240, scheduledStart: atDaysAgo(1, 19, 0), geofenceResult: 'override', distanceM: 520 }),
  // Harborview — single cleaner, 125 vs 120 → ON TARGET (green)
  entry({ id: 't4', jobId: 'job-c', siteId: SITES.harborview.id, siteName: SITES.harborview.name, clientId: 'c-harborview', clientName: 'Harborview Residential', ...JAMES, clockInAt: atDaysAgo(1, 21, 0), clockOutAt: atDaysAgo(1, 23, 5), durationMinutes: 125, expectedMinutesSnapshot: 120, scheduledStart: atDaysAgo(1, 21, 0), approvalStatus: 'approved' }),
  // Lincoln — single cleaner, 150 vs 90 → OVER (red)
  entry({ id: 't5', jobId: 'job-d', siteId: SITES.lincoln.id, siteName: SITES.lincoln.name, clientId: 'c-lincoln', clientName: 'Lincoln Unified School District', ...PRIYA, clockInAt: atDaysAgo(1, 18, 30), clockOutAt: atDaysAgo(1, 21, 0), durationMinutes: 150, expectedMinutesSnapshot: 90, scheduledStart: atDaysAgo(1, 18, 30) }),
  // Tech Park — IN PROGRESS right now (no clock-out) → incomplete (blue)
  entry({ id: 't6', jobId: 'job-e', siteId: SITES.techpark.id, siteName: SITES.techpark.name, clientId: 'c-apex', clientName: 'Apex Coworking', ...MARIA, clockInAt: minsAgo(72), clockOutAt: null, durationMinutes: null, expectedMinutesSnapshot: 60, scheduledStart: minsAgo(75) }),
  // Grandview — two cleaners, labor 175 vs 180 → ON TARGET (green)
  entry({ id: 't7', jobId: 'job-f', siteId: SITES.grandview.id, siteName: SITES.grandview.name, clientId: 'c-grandview', clientName: 'Grandview Retail Partners', ...MARIA, clockInAt: atDaysAgo(1, 20, 0), clockOutAt: atDaysAgo(1, 21, 30), durationMinutes: 90, expectedMinutesSnapshot: 180, scheduledStart: atDaysAgo(1, 20, 0), approvalStatus: 'approved' }),
  entry({ id: 't8', jobId: 'job-f', siteId: SITES.grandview.id, siteName: SITES.grandview.name, clientId: 'c-grandview', clientName: 'Grandview Retail Partners', ...PRIYA, clockInAt: atDaysAgo(1, 20, 5), clockOutAt: atDaysAgo(1, 21, 30), durationMinutes: 85, expectedMinutesSnapshot: 180, scheduledStart: atDaysAgo(1, 20, 0), approvalStatus: 'approved' }),
];

// Per-account expected clean time (the Operations baseline that drives variance).
const EXPECTED_MINS_BY_CLIENT = {
  'Riverside Health Group': 180,
  'Meridian Property Mgmt': 240,
  'Harborview Residential': 120,
  'Lincoln Unified School District': 90,
  'Apex Coworking': 60,
  'Grandview Retail Partners': 180,
};

export function buildQualitySeed() {
  return {
    version: 1,
    opsSettings: { basis: 'labor', thresholds: { overMins: 15, underMins: 15 }, geofenceRadiusFt: 250 },
    templates: TEMPLATES,
    inspections: INSPECTIONS,
    problems: PROBLEMS,
    timeEntries: TIME_ENTRIES,
    expectedMinsByClient: EXPECTED_MINS_BY_CLIENT,
  };
}
