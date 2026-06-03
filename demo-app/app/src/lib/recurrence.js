const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_INSTANCES = 52;

export const RECURRENCE_DEFAULTS = {
  daily:    { endCount: 30 },
  weekly:   { endCount: 12 },
  biweekly: { endCount: 6 },
  monthly:  { endCount: 3 },
};

export function expandRecurrence({ startAt, endAt, recurrence }) {
  if (!recurrence || !recurrence.frequency) return [];
  const base = new Date(startAt);
  const duration = new Date(endAt).getTime() - base.getTime();
  const { frequency, daysOfWeek, endType, endCount, endDate } = recurrence;

  const limit = endType === 'count' ? Math.min(endCount || 12, MAX_INSTANCES)
    : endType === 'date' ? MAX_INSTANCES
    : Math.min(RECURRENCE_DEFAULTS[frequency]?.endCount || 12, MAX_INSTANCES);
  const cutoff = endType === 'date' && endDate ? new Date(endDate) : null;

  const results = [];
  let cursor = new Date(base);

  const push = (d) => {
    if (cutoff && d > cutoff) return false;
    if (results.length >= limit) return false;
    const s = new Date(d);
    const e = new Date(s.getTime() + duration);
    results.push({ startAt: s.toISOString(), endAt: e.toISOString() });
    return true;
  };

  if (frequency === 'daily') {
    for (let i = 0; i < limit + 1; i++) {
      cursor.setDate(cursor.getDate() + 1);
      if (!push(cursor)) break;
    }
  } else if (frequency === 'weekly' && daysOfWeek?.length) {
    const sorted = [...daysOfWeek].sort((a, b) => a - b);
    let weekStart = new Date(base);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    for (let w = 0; w < limit * 2 && results.length < limit; w++) {
      for (const dow of sorted) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + dow);
        d.setHours(base.getHours(), base.getMinutes(), 0, 0);
        if (d <= base) continue;
        if (!push(d)) break;
      }
      weekStart.setDate(weekStart.getDate() + 7);
    }
  } else if (frequency === 'weekly') {
    for (let i = 0; i < limit + 1; i++) {
      cursor.setDate(cursor.getDate() + 7);
      if (!push(cursor)) break;
    }
  } else if (frequency === 'biweekly') {
    for (let i = 0; i < limit + 1; i++) {
      cursor.setDate(cursor.getDate() + 14);
      if (!push(cursor)) break;
    }
  } else if (frequency === 'monthly') {
    const baseDay = base.getDate();
    for (let i = 1; i <= limit + 1; i++) {
      const d = new Date(base);
      d.setMonth(d.getMonth() + i);
      const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(baseDay, maxDay));
      if (!push(d)) break;
    }
  }

  return results;
}

export function describeRecurrence(recurrence) {
  if (!recurrence) return '';
  const { frequency, daysOfWeek, endType, endCount, endDate } = recurrence;
  const freqLabel = frequency === 'biweekly' ? 'Every 2 weeks'
    : frequency.charAt(0).toUpperCase() + frequency.slice(1);

  let desc = freqLabel;
  if (frequency === 'weekly' && daysOfWeek?.length) {
    desc += ' on ' + daysOfWeek.map((d) => DAY_NAMES[d]).join(', ');
  }

  if (endType === 'count') desc += ` (${endCount} times)`;
  else if (endType === 'date' && endDate) {
    desc += ` until ${new Date(endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return desc;
}

export function previewEndDate({ startAt, recurrence }) {
  const instances = expandRecurrence({ startAt, endAt: startAt, recurrence });
  if (instances.length === 0) return null;
  return { count: instances.length + 1, lastDate: instances[instances.length - 1].startAt };
}
