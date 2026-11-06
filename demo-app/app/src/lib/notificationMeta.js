// How each kind of notification LOOKS in the bell's phone list (components/MobileNotificationList):
// the icon it wears, the filter chip it sits under, and whether it is an ALERT — the only rows
// that list colours (red). Keyed by the eventKey of every entry in NOTIFICATION_GROUPS
// (lib/notifications.js).
//
// 🔴 EVERY catalog event has a row here, and test-notification-meta.mjs fails the build when one
// is added there without one. The table used to live inside the component and missed eight
// (2026-10-03): those rows fell back to a grey bell, and one of them was the URGENT WORK ORDER,
// so the most pressing thing on the list looked like the least.
//
// Plain JS, no JSX, so the test can import it under node. Words are catalog keys (CS-193).

// The chips, in the order they show. Each event below names exactly one.
export const NOTIFICATION_FILTERS = [
  { id: 'alerts',   labelKey: 'notif.filter.alerts' },
  { id: 'messages', labelKey: 'notif.filter.messages' },
  { id: 'work',     labelKey: 'notif.filter.work' },
  { id: 'supplies', labelKey: 'notif.filter.supplies' },
  { id: 'money',    labelKey: 'notif.filter.money' },
];

// icon: an Icon.jsx name · filter: a NOTIFICATION_FILTERS id · alert: something is going wrong
// right now (a missed clean, an urgent ticket, money overdue), so the row's icon turns red.
export const EVENT_META = {
  // messaging
  newClientMessage:        { icon: 'mail',         filter: 'messages' },
  newDM:                   { icon: 'messaging',    filter: 'messages' },
  newInternalMessage:      { icon: 'messaging',    filter: 'messages' },
  marketingReplyAssigned:  { icon: 'mail',         filter: 'messages' },
  inboxExpired:            { icon: 'warning',      filter: 'messages', alert: true },
  // the schedule and the clock
  jobCreatedOrRescheduled: { icon: 'schedule',     filter: 'work' },
  jobCancelled:            { icon: 'schedule',     filter: 'work',     alert: true },
  shiftMissed:             { icon: 'warning',      filter: 'alerts',   alert: true },
  offSitePunch:            { icon: 'mapPin',       filter: 'alerts',   alert: true },
  // QR Wave 2: a cleaner filled in for someone from a scan — the schedule changed, nothing is wrong.
  scanFillIn:              { icon: 'schedule',     filter: 'work' },
  // operations
  accountOpsUpdated:       { icon: 'settings',     filter: 'work' },
  keyCustody:              { icon: 'lock',         filter: 'work' },
  keyLost:                 { icon: 'lock',         filter: 'alerts',   alert: true },
  reminderFailed:          { icon: 'warning',      filter: 'alerts',   alert: true },
  // Task #507: a building's special service is coming up — work to line up, not an emergency.
  specialServiceDue:       { icon: 'schedule',     filter: 'work' },
  // supplies
  supplyRequestSubmitted:  { icon: 'box',          filter: 'supplies' },
  supplyRequestApproved:   { icon: 'box',          filter: 'supplies' },
  supplyRequestCancelled:  { icon: 'box',          filter: 'supplies' },
  // the supply orders (S131): the order's news, to the person who asked and the account manager
  supplyOrderApproved:     { icon: 'check',        filter: 'supplies' },
  supplyOrderDeclined:     { icon: 'box',          filter: 'supplies' },
  supplyItemsDelivered:    { icon: 'box',          filter: 'supplies' },
  supplyItemBackordered:   { icon: 'clock',        filter: 'supplies' },
  supplyItemCancelled:     { icon: 'box',          filter: 'supplies' },
  supplyOrderCompleted:    { icon: 'check',        filter: 'supplies' },
  supplyOrderDue:          { icon: 'box',          filter: 'supplies' },
  supplyOrderOverdue:      { icon: 'box',          filter: 'supplies' },
  supplyBudgetExceeded:    { icon: 'dollarCircle', filter: 'supplies' },
  // quality: work orders, inspections, checklists, reviews
  problemReported:         { icon: 'warning',      filter: 'work' },
  ticketUrgent:            { icon: 'warning',      filter: 'alerts',   alert: true },
  ticketUnanswered:        { icon: 'messaging',    filter: 'alerts',   alert: true },
  inspectionFailed:        { icon: 'forms',        filter: 'work' },
  // HUB-7: "go back and redo this area" is work owed right now, read on a phone in the building.
  inspectionRedo:          { icon: 'warning',      filter: 'alerts',   alert: true },
  // The Cleaner Hub's Client Requests: a request put on a cleaner's list, and one they completed.
  crewRequestAssigned:     { icon: 'forms',        filter: 'work' },
  crewRequestCompleted:    { icon: 'check',        filter: 'work' },
  checklistDue:            { icon: 'forms',        filter: 'work' },
  inspectionDue:           { icon: 'forms',        filter: 'work' },
  // The client hub redesign: a customer wrote in their building's Messages — a message to answer.
  customerMessage:         { icon: 'messaging',    filter: 'messages' },
  // money: invoices, contracts, sales
  invoicePaid:             { icon: 'dollarCircle', filter: 'money' },
  invoiceOverdue:          { icon: 'invoices',     filter: 'money',    alert: true },
  contractReminder:        { icon: 'repeat',       filter: 'money' },
  // HR warnings: a warning to sign is the employee's to act on; the unsigned reminder the supervisor's.
  hrWarningToSign:         { icon: 'warning',      filter: 'alerts',   alert: true },
  hrWarningUnsigned:       { icon: 'warning',      filter: 'work' },
  // Task #468: a cleaner quiet in the app for 30 days — the office's to look at, not an emergency.
  crewQuiet:               { icon: 'user',         filter: 'work' },
  newLead:                 { icon: 'user',         filter: 'money' },
  quoteSigned:             { icon: 'check',        filter: 'money' },
};

// A row whose event is unknown (an old row from a retired event) still renders: a plain bell,
// shown under All only.
const FALLBACK = { icon: 'bell', filter: null };

export const notificationMeta = (eventKey) => EVENT_META[eventKey] || FALLBACK;
