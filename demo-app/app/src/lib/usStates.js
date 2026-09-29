// US state / territory abbreviations for the structured-address State picker.
// A forced dropdown (not a free-text field) so the value is always a canonical
// 2-letter code and never a mix of "FL" / "Florida" / "Fla." (Add Contact modal).
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', 'GU', 'AS', 'MP',
];

// {value,label} options for a Select, with a leading blank so "no state yet" is
// representable. Clean Space is FL-based, so callers may default the field to 'FL'.
export const US_STATE_OPTIONS = [
  { value: '', label: 'State' },
  ...US_STATES.map((s) => ({ value: s, label: s })),
];
