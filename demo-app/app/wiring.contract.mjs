// The wiring contract — declared write-path pairs that `npm run lint:wiring` checks.
//
// WHY THIS EXISTS. On 2026-07-20 a client reported "edited jobs are not making changes
// downstream". The cause was one object literal in JobDetail's save(): the series patch
// omitted `clientId` entirely and sent four other fields unconditionally. Both halves
// were invisible to eslint, to the type system (there isn't one), and to every test —
// and the agent sweep running at the time did not find it either. It is, however,
// trivially decidable from the AST, which is what this contract turns on.
//
// A "write pair" is an entity that has BOTH a single-record write and a multi-record
// write reachable from the same component. Two rules follow from that shape:
//
//   R1 (silent drop)     — a field the SINGLE path writes that the MULTI path never
//                          carries. The user edits it, the multi-scope save reports
//                          success, and nothing changes anywhere.
//   R2 (unguarded spread)— a field in the MULTI patch whose presence is not guarded by
//                          a change comparison. The patch is spread onto every matched
//                          record, so an untouched field FLATTENS that field across all
//                          of them.
//
// Both are reported, never blocking — this file's job is to make the debt visible and
// named, not to stop a deploy. Intentional differences are declared here as
// `multiExclusions` (with a reason) or baselined via
// `npm --prefix app run lint:wiring -- --accept "<id>" --note "<why>"`.
//
// ⚠️ DO NOT delete a pair to silence a finding. Removing a declaration launders the
// debt: the pair becomes undeclared, which the checker reports as GREY drift and which
// CANNOT be baselined. The contractHash in the report exists so a quiet deletion is
// visible in the diff.

export const WRITE_PAIRS = [
  {
    id: 'jobs.update',
    entity: 'jobs',
    // Components where both paths are reachable. Checked only in these files, so an
    // unrelated component dispatching one of them is not a finding.
    files: [
      'pages/JobDetail.jsx',
      'components/NewJobModal.jsx',
      'pages/Schedule.jsx',
    ],
    single: 'UPDATE_JOB',
    multi: 'UPDATE_JOB_SERIES',
    // Fields the MULTI path must deliberately NOT carry. Each needs a reason — this is
    // the escape hatch, and an unexplained entry is indistinguishable from the bug.
    multiExclusions: {
      startAt: 'the uniform patch is spread onto every occurrence, so a date here would collapse the whole series onto one instant. Day moves ride `dayShift`, time moves ride `timePatch`, both of which re-derive each row on its OWN date. The reducer strips these defensively too.',
      endAt: 'same as startAt — see UPDATE_JOB_SERIES in store/reducer.js',
    },
  },
];

// Actions that fan a single patch across many records. R2 applies to these wherever
// they are dispatched, independently of the pair list above — a new component that
// dispatches one of these gets checked without needing a pair entry.
export const FANOUT_ACTIONS = [
  'UPDATE_JOB_SERIES',
];

// Identifier names treated as the store dispatcher.
export const DISPATCH_NAMES = ['dispatch', 'dispatchLocal'];
