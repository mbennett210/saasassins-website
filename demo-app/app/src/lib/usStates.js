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

// A spreadsheet's state, whatever way it was typed — "FL", "fl", "Florida", "Fla." — as the
// canonical code the picker stores; null when it is not a US state (the Customers import then
// leaves the state blank and says so, rather than store a value the picker cannot show).
const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
  'washington dc': 'DC', 'puerto rico': 'PR', 'virgin islands': 'VI', 'us virgin islands': 'VI',
  guam: 'GU', 'american samoa': 'AS', 'northern mariana islands': 'MP',
  // The common short forms people type.
  fla: 'FL', calif: 'CA', mass: 'MA', penn: 'PA', tenn: 'TN', tex: 'TX', wash: 'WA',
};
export function normalizeUsState(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  // "FL", "fl", "Fl.", "D.C.": a code, with or without its dots; else a name.
  const key = s.toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  const code = key.toUpperCase();
  if (US_STATES.includes(code)) return code;
  return STATE_NAMES[key] || null;
}
