// The whole-order moves the office makes on supply orders — approve · decline · reopen (decide) and
// Submit to supplier — for ONE order or the queue's bulk batch (UI_RULES §132), shared by the order
// queue (components/SupplyQueue) and the order page (pages/SupplyOrder), so both say the same thing
// the same way. Behind an in-flight guard, so a double tap sends once; ONE result toast that names
// every order that did not move and why (the route's codes). `onDone(decision, done)` runs after a
// call that moved anything, for the caller to re-read.
import { useRef, useState } from 'react';
import { useStore } from '../store';
import { selectUserById } from '../store/selectors';
import { useAuth } from './useAuth';
import { useToast } from '../components/Toast';
import * as suppliesApi from '../lib/suppliesApi';
import { useT } from '../i18n/react';

// The words of a batch's partial results (the route's codes), one sentence each.
const PARTIAL_KEY = {
  stale: 'supplyPage.toast.partialStale',
  not_yours: 'supplyPage.toast.partialNotYours',
  illegal_move: 'supplyPage.toast.partialMoved',
  not_found: 'supplyPage.toast.partialGone',
  reason_required: 'supplyPage.toast.partialOther',
  has_deliveries: 'supplyPage.toast.partialDelivered',
};

export function useSupplyMoves({ ctx, onDone } = {}) {
  const t = useT();
  const toast = useToast();
  const state = useStore();
  const { currentUser } = useAuth();
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  // Who a move tells (lib/supplyFlow): a LIVE person other than you — named in the toast for one.
  const notifiedName = (id) => (id && id !== currentUser?.id ? selectUserById(state, id)?.name || null : null);

  async function run(rows, decision, reason = '') {
    if (!rows.length || busy.current) return false;
    busy.current = true; setWorking(true);
    try {
      const ids = rows.map((r) => r.id);
      const { results } = decision === 'submit'
        ? await suppliesApi.submitOrders({ ids }, ctx)
        : await suppliesApi.decideRequests({ ids, decision, reason }, ctx);
      const done = results.filter((x) => x.ok);
      const parts = [];
      const told = () => notifiedName(rows[0].requestedByUserId);
      if (done.length) {
        if (decision === 'approve') parts.push(done.length === 1 ? t('supplyPage.toast.approved') : t('supplyPage.toast.approvedN', { count: done.length }));
        else if (decision === 'reject') parts.push(told() ? t('supplyPage.toast.rejectedNotified', { name: told() }) : t('supplyPage.toast.rejected'));
        else if (decision === 'submit') parts.push(done.length === 1 ? t('supplyPage.toast.submittedSupplier') : t('supplyPage.toast.submittedSupplierN', { count: done.length }));
        else parts.push(t('supplyPage.toast.reopened'));
      }
      const byCode = results.filter((x) => !x.ok).reduce((a, x) => ({ ...a, [x.code]: (a[x.code] || 0) + 1 }), {});
      for (const [code, count] of Object.entries(byCode)) parts.push(t(PARTIAL_KEY[code] || 'supplyPage.toast.partialOther', { count }));
      const text = parts.join(' ');
      if (!done.length) toast.error(text);
      else if (Object.keys(byCode).length) toast.info(text);
      else toast.success(text);
      if (onDone) onDone(decision, done);
      return done.length > 0;
    } catch {
      toast.error(t('supplyPage.toast.failed'));
      return false;
    } finally {
      busy.current = false; setWorking(false);
    }
  }
  return { run, working };
}
