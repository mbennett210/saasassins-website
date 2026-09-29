// The IANA timezone list for the Settings → Company picker.
//
// Sourced from the browser's own zone database (Intl.supportedValuesOf) so it never
// goes stale as zones change their rules — with a small curated fallback for engines
// that don't implement it. Labels carry the CURRENT offset ("America/Los_Angeles
// (UTC−07:00)") because an IANA id alone doesn't tell an operator whether they've
// picked the right one, and picking wrong re-dates every job in the company.

// Deliberately short: this is a last-resort fallback, not a maintained list. Any
// engine new enough to run this app has supportedValuesOf; these are here so the
// picker degrades to "usable" rather than "empty" if it doesn't.
const FALLBACK_ZONES = [
  'America/Anchorage', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/New_York', 'America/Phoenix', 'Pacific/Honolulu', 'UTC',
];

export function listTimezones() {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones?.length ? zones : FALLBACK_ZONES;
  } catch {
    return FALLBACK_ZONES;
  }
}

// The Settings → Company timezone picker is CURATED to US zones (2026-08-03).
// The org runs on Seattle / Pacific, and the incident showed that offering the
// full ~400-entry IANA list lets an operator flip the WHOLE company's calendar
// to a wrong zone (e.g. Africa/Johannesburg). This is the continental-US set
// plus AK/HI/AZ, Pacific first — the only zones this org would ever legitimately
// use. The server (orgStateGuard) independently owner-gates the field.
const US_ZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Phoenix',
  'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu',
];
export function usTimezoneOptions(at = new Date()) {
  return US_ZONES.map((tz) => {
    const off = offsetLabel(tz, at);
    return { value: tz, label: off ? `${tz} (UTC${off})` : tz };
  });
}

// Current UTC offset of `tz`, as "−07:00" / "+08:00" / "+00:00".
// Derived by reading one instant's wall clock in the zone and re-reading those same
// fields as UTC — the difference is the offset. No zone table needed.
export function offsetLabel(tz, at = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const part of dtf.formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value);
    if (p.hour === 24) p.hour = 0;
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, at.getUTCMilliseconds());
    const mins = Math.round((asUtc - at.getTime()) / 60000);
    const sign = mins < 0 ? '−' : '+'; // U+2212, matches the minus used elsewhere in the UI
    const abs = Math.abs(mins);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

// Options for the picker, sorted west→east by current offset then by name, so the
// US zones an operator is most likely to want cluster near the top rather than
// scattering through a 400-entry alphabetical list.
export function timezoneOptions(at = new Date()) {
  return listTimezones()
    .map((tz) => ({ tz, off: offsetLabel(tz, at) }))
    .map(({ tz, off }) => ({
      value: tz,
      label: off ? `${tz} (UTC${off})` : tz,
      _sort: off ? (off.startsWith('−') ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6))) : 0,
    }))
    .sort((a, b) => a._sort - b._sort || a.value.localeCompare(b.value))
    .map(({ value, label }) => ({ value, label }));
}
