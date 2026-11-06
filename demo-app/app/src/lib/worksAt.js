// THE CUSTOMERS A CLEANER WORKS AT — `users[].worksAt` (task #466 from Clean Corner's queue,
// the Team import; Daniel's pick 2026-11-03: "Link them; schedule decides").
//
// A list of customer ids, sparse: no field means none. It is a LINK the office keeps, never
// access. What a cleaner sees in their app still comes only from the cleans that name them
// (lib/crewScope crewScopeFromJobs, the rule since 2026-09-09, when standing crew was removed):
// nothing here reaches crew scope, door codes, `crew_assignments` or the crew projection
// (api/_lib/crewView trims users to their identity). It shows where the office works:
//   · Settings → Team, the "Works at" column, and a cleaner's own page (Profile), where it is changed;
//   · a customer's page, beside the cleaners on its upcoming cleans (ServiceSetupCard);
//   · the cleaner picker, which lists that customer's linked cleaners first (lib/pickerOptions).
//
// Pure / node-safe (no imports): the store's write point, the screens and the tests read it.

// The ids as stored: strings, each once, in stored order. [] for every member with none.
export function worksAtOf(user) {
  const src = Array.isArray(user?.worksAt) ? user.worksAt : [];
  const out = [];
  for (const id of src) if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  return out;
}

// The write point's rule (ADD_USER / UPDATE_USER): only ids of customers on file, each once.
// An empty result means the field is dropped (sparse).
export function cleanWorksAt(list, clients) {
  const known = new Set((Array.isArray(clients) ? clients : []).map((c) => c?.id).filter(Boolean));
  return worksAtOf({ worksAt: list }).filter((id) => known.has(id));
}

// A cleaner the link applies to: a Crew member who isn't disabled. A member who leaves Crew keeps
// the field (it comes back if they return), and no reader shows it meanwhile.
const linkable = (u) => !!u && u.role === 'crew' && u.status !== 'disabled';

// The cleaners linked to a customer, in roster order.
export function cleanersLinkedTo(users, clientId) {
  if (!clientId) return [];
  return (Array.isArray(users) ? users : []).filter((u) => linkable(u) && worksAtOf(u).includes(clientId));
}

// The same, as ids (the picker's order).
export function linkedCleanerIds(users, clientId) {
  return cleanersLinkedTo(users, clientId).map((u) => u.id);
}

// A cleaner's linked customers, as records still on file (an id whose customer is gone reads as
// nothing), for the Team column and the member page.
export function worksAtClients(user, clients) {
  const byId = new Map((Array.isArray(clients) ? clients : []).map((c) => [c?.id, c]));
  return worksAtOf(user).map((id) => byId.get(id)).filter(Boolean);
}
