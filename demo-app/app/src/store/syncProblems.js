// What a save problem SAYS (CS-008). Pure and node-safe: the sync engine reports a problem as
// data — the refused actions with the server's reasons — and the blocking message
// (components/SyncProblemDialog) turns each action into words through the catalog, using the
// names in the CURRENT state (a refused customer delete is back in the list by then, so its
// name is there to show).
//
// One label per KIND of change, named by the record it touched when the state still has it.
// A change this table does not know reads "A change you made" — never a raw action type.
import { ACTIONS } from './reducer';
import { importCustomerCount } from '../lib/customerImport';

// Two reports that arrive before the first is dismissed become ONE message listing every
// refused change: a second dialog stacked on the first would hide the first one's list.
export function mergeSyncProblems(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  if (prev.kind === 'refused' && next.kind === 'refused') {
    return { ...next, refused: [...(prev.refused || []), ...(next.refused || [])] };
  }
  return next;
}

const byId = (list, id) => (Array.isArray(list) && id ? list.find((x) => x && x.id === id) || null : null);
const nameOf = (row) => (row && typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null);
// A label that names its record; with no name to show, the generic line instead of a blank.
const named = (key, name, param = 'name') => (name ? { key, params: { [param]: name } } : { key: 'syncProblem.change.other', params: {} });

// action -> { key, params }: the catalog line naming the change, and its placeholders.
export function describeRefusedAction(action, state) {
  const s = state || {};
  const userName = (id) => nameOf(byId(s.users, id));
  const clientName = (id) => nameOf(byId(s.clients, id));
  const lineOwner = (list, id) => userName(byId(list, id)?.userId);
  switch (action?.type) {
    case ACTIONS.UPDATE_USER: {
      const patch = action.patch && typeof action.patch === 'object' ? action.patch : {};
      if ('pay' in patch) return named('syncProblem.change.pay', userName(action.id));
      return named('syncProblem.change.member', userName(action.id));
    }
    case ACTIONS.ADD_USER:
      return named('syncProblem.change.addMember', nameOf(action.user));
    case ACTIONS.DELETE_USER:
      return named('syncProblem.change.removeMember', userName(action.id));
    case ACTIONS.UPDATE_PERMISSION:
      return { key: 'syncProblem.change.roles', params: {} };
    case ACTIONS.SET_USER_PERMISSION_OVERRIDE:
      return named('syncProblem.change.access', userName(action.userId));
    case ACTIONS.ADD_PAYROLL_LINE:
      return named('syncProblem.change.payLine', userName(action.line?.userId));
    case ACTIONS.UPDATE_PAYROLL_LINE:
    case ACTIONS.DELETE_PAYROLL_LINE:
      return named('syncProblem.change.payLine', lineOwner(s.payrollLines, action.id));
    case ACTIONS.ADD_REIMBURSEMENT:
      return named('syncProblem.change.reimbursement', userName(action.reimbursement?.userId));
    case ACTIONS.UPDATE_REIMBURSEMENT:
    case ACTIONS.DELETE_REIMBURSEMENT:
      return named('syncProblem.change.reimbursement', lineOwner(s.reimbursements, action.id));
    case ACTIONS.ADD_TIME_OFF:
      return named('syncProblem.change.timeOff', userName(action.entry?.userId));
    case ACTIONS.DELETE_TIME_OFF:
      return named('syncProblem.change.timeOff', lineOwner(s.timeOff, action.id));
    case ACTIONS.ADD_INVOICE:
      return { key: 'syncProblem.change.newInvoice', params: {} };
    case ACTIONS.UPDATE_INVOICE:
    case ACTIONS.SET_INVOICE_STATUS:
    case ACTIONS.DELETE_INVOICE:
      return action.id ? { key: 'syncProblem.change.invoice', params: { number: String(action.id) } } : named('syncProblem.change.other', null);
    case ACTIONS.ADD_INVOICE_PAYMENT:
    case ACTIONS.UPDATE_INVOICE_PAYMENT:
    case ACTIONS.REMOVE_INVOICE_PAYMENT:
      return action.id ? { key: 'syncProblem.change.payment', params: { number: String(action.id) } } : named('syncProblem.change.other', null);
    case ACTIONS.ADD_CLIENT:
      return named('syncProblem.change.newCustomer', nameOf(action.client), 'customer');
    case ACTIONS.UPDATE_CLIENT:
    case ACTIONS.UPDATE_CLIENT_OPS:
      return named('syncProblem.change.customer', clientName(action.id), 'customer');
    case ACTIONS.SAVE_SPECIAL_SERVICE:
    case ACTIONS.REMOVE_SPECIAL_SERVICE:
    case ACTIONS.MARK_SPECIAL_SERVICE_DONE:
    case ACTIONS.SET_NO_SPECIAL_SERVICES:
      return named('syncProblem.change.customer', clientName(action.clientId), 'customer');
    case ACTIONS.ARCHIVE_CLIENT:
      return named('syncProblem.change.archiveCustomer', clientName(action.id), 'customer');
    case ACTIONS.RESTORE_CLIENT:
      return named('syncProblem.change.restoreCustomer', clientName(action.id), 'customer');
    // The Customers import is one action, so a refusal is one line naming the whole file.
    case ACTIONS.IMPORT_CUSTOMERS:
      return { key: 'syncProblem.change.import', params: { count: importCustomerCount(action.ops) } };
    // A run of the Team import is one action too: one line naming its people.
    case ACTIONS.IMPORT_TEAM:
      return { key: 'syncProblem.change.importTeam', params: { count: (Array.isArray(action.ops) ? action.ops : []).length } };
    // …and so is each run that locates its buildings afterwards.
    case ACTIONS.LOCATE_BUILDINGS:
      return { key: 'syncProblem.change.locate', params: { count: Array.isArray(action.results) ? action.results.length : 0 } };
    case ACTIONS.UPDATE_OPS_SETTINGS:
      return { key: 'syncProblem.change.opsSettings', params: {} };
    case ACTIONS.UPDATE_COMPANY:
      return { key: 'syncProblem.change.company', params: {} };
    default:
      return { key: 'syncProblem.change.other', params: {} };
  }
}
