// WHO MAY MOVE OR CANCEL A SUPPLY ORDER, per order, for the screens that list many: the order queue
// (components/SupplyQueue: its row buttons and its bulk bar) and By building's "Awaiting your approval"
// cards (pages/Supplies, components/SupplyApprovalCards). S131 Wave 2: ONE place builds the inputs of
// lib/supplies' two rules — maySupplyDecide and maySupplyCancel, the ones the route judges with — from
// the viewer, their supply keys, and the building's approver resolved as the route resolves it
// (lib/notifications resolveSupplyApprover) with THAT approver's operations manager
// (supplyApproverOpsManagerId). So a card, a row's buttons, the bulk bar and the server cannot disagree
// about whose an order is; the queue's own copy of these lines went (II.5). The order page
// (pages/SupplyOrder) asks the same two rules about the approver its one-order read returns.
//
// The roster, the customers and the ops settings are read as slices (by reference), so a dispatch that
// touches none of them re-renders nobody.
import { useMemo } from 'react';
import { useSelector } from '../store';
import { useAuth } from './useAuth';
import { usePermission } from './usePermission';
import { resolveSupplyApprover } from '../lib/notifications';
import { maySupplyDecide, maySupplyCancel, supplyApproverOpsManagerId } from '../lib/supplies';

const selUsers = (s) => s.users;
const selClients = (s) => s.clients;
const selOps = (s) => s.opsSettings;

// → { approverOf(clientId), mayDecide(order, decision), mayCancel(order) }
export function useSupplyRules() {
  const users = useSelector(selUsers);
  const clients = useSelector(selClients);
  const opsSettings = useSelector(selOps);
  const { currentUser } = useAuth();
  const holdsRequest = usePermission('supplies.request');
  const holdsApprove = usePermission('supplies.approve');
  const holdsManage = usePermission('supplies.manage');
  const holdsDeliver = usePermission('supplies.deliver');
  return useMemo(() => {
    const roster = { users: users || [], clients: clients || [], opsSettings: opsSettings || {} };
    const selfId = currentUser?.id || null;
    const role = currentUser?.role || null;
    const approverOf = (clientId) => resolveSupplyApprover(roster, clientId);
    // The building's approver and their operations manager, as the route resolves them.
    const approvers = (order) => {
      const approverId = approverOf(order?.clientId)?.id || null;
      return { approverId, approverOpsManagerId: supplyApproverOpsManagerId(roster.users, approverId) };
    };
    return {
      approverOf,
      mayDecide: (order, decision) => {
        const { approverId, approverOpsManagerId } = approvers(order);
        return maySupplyDecide({
          request: order, decision, selfId, role, approverId, approverOpsManagerId, holdsApprove, holdsManage, holdsDeliver,
        });
      },
      mayCancel: (order) => {
        const { approverId, approverOpsManagerId } = approvers(order);
        return maySupplyCancel({
          request: order, selfId, role, approverId, approverOpsManagerId, holdsRequest, holdsApprove, holdsManage,
        });
      },
    };
  }, [users, clients, opsSettings, currentUser, holdsRequest, holdsApprove, holdsManage, holdsDeliver]);
}
