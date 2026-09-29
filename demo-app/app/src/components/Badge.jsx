export default function Badge({ variant = 'slate', children, style }) {
  return <span className={`badge ${variant}`} style={style}>{children}</span>;
}

// Maps a status string to a badge variant.
export function statusBadgeVariant(status) {
  const map = {
    Paid: 'green', Active: 'green', Confirmed: 'green', Available: 'green',
    Pending: 'amber', 'On Site': 'amber', Prospect: 'amber',
    Overdue: 'red', Missed: 'red', Cancelled: 'red',
    'In Progress': 'blue',
    Inactive: 'slate', 'Off Duty': 'slate',
  };
  return map[status] || 'slate';
}

// Display label for a client/company status (prospect → active → inactive).
export function clientStatusLabel(status) {
  return status === 'prospect' ? 'Prospect' : status === 'inactive' ? 'Inactive' : 'Active';
}

// Company badge variants (the ONE map its color reads from, shared by the
// Contacts hub, ClientDetail header, and the contact's Company section so they
// can't drift). Two DIFFERENT axes share this map because a company shows ONE
// badge: its derived customer status (Jobber-style) OR, for a supplier, its Type.
//   - lead / active  -> derived STATUS (no work yet / has a job or invoice)
//   - vendor         -> manual TYPE (a company you buy from; off the sales track,
//                       so it has no Lead/Active). Neutral slate.
// The value comes from selectClientBadgeStatus (Type wins over derived status).
export const DERIVED_STATUS_VARIANTS = { lead: 'amber', active: 'green', inactive: 'slate', vendor: 'slate' };
