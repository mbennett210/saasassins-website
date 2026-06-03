export default function Badge({ variant = 'slate', children, style }) {
  return <span className={`badge ${variant}`} style={style}>{children}</span>;
}

// Maps a status string to a badge variant.
export function statusBadgeVariant(status) {
  const map = {
    Paid: 'green', Active: 'green', Confirmed: 'green', Available: 'green',
    Pending: 'amber', 'On Site': 'amber',
    Overdue: 'red', Missed: 'red', Cancelled: 'red',
    'In Progress': 'blue',
    Inactive: 'slate', 'Off Duty': 'slate',
  };
  return map[status] || 'slate';
}
