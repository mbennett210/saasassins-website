// THE AGREEMENT MESSAGES' INPUTS (Matt's approved messages, 2026-10-19): the contracts module's
// tables are not in the shared record, so the run (api/reminders/run.js) and the contracts route
// reach them here.
//
//   queueServiceChange  the contracts route's `<id>/save`, when an ACTIVE agreement's frequency,
//                       scope or price changed (src/lib/contracts.js customerVisibleChange): ONE
//                       pending message per building it covers, its words' inputs in `payload`,
//                       for the next run to send (customer_messages, status 'pending'). Keyed by
//                       the contract, the save's moment and the building, so a retried save of
//                       the same change cannot queue twice, and a later change is a new message.
//   readContractDates   the dates the renewal notice (60 days before), the renewal offer (30) and
//                       the price-increase notice (30, a RISE only) are about: the contract
//                       module's own materialized reminder rows (contract_reminders, written on
//                       every save and topped up by the ops-alert cron — the same plan the office's
//                       bells ring on), for targets 28–60 days out, joined to the contract's status
//                       and buildings, and, for a price change, the year rows either side.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { queuePending } from './store.js';
import { contractSubjects } from '../contracts/store.js';
import { messageKey } from '../../../src/lib/reminderScheduler.js';
import { MESSAGE_KEY, DEFAULT_KEEP_DAYS, RENEWAL_NOTICE_LEAD_DAYS, RENEWAL_OFFER_LEAD_DAYS, PRICE_INCREASE_LEAD_DAYS, DAY_GRACE_DAYS } from '../../../src/lib/customerMessages.js';
import { REMINDER_KIND, CONTRACT_STATUS, toCents } from '../../../src/lib/contracts.js';
import { addDaysKey } from '../../../src/lib/dates.js';

const ORG = CLEANSPACE_ORG_ID;

export async function queueServiceChange(contract, changeLines, today, { now = Date.now() } = {}) {
  const ids = (contract?.clientIds || []).filter(Boolean);
  let queued = 0;
  for (const clientId of ids) {
    const ok = await queuePending({
      id: messageKey(MESSAGE_KEY.serviceChange, contract.id, now, clientId),
      templateKey: MESSAGE_KEY.serviceChange,
      channel: 'email',
      clientId,
      subjectId: contract.id,
      payload: { contractId: contract.id, summary: changeLines, effectiveDay: today },
      keepUntil: new Date(now + DEFAULT_KEEP_DAYS * 864e5).toISOString(),
    });
    if (ok) queued += 1;
  }
  return queued;
}

// → [{ contractId, kind, targetDate, clientIds, rise }] or null (a read failed: nothing is due).
export async function readContractDates(today) {
  const leads = [RENEWAL_NOTICE_LEAD_DAYS, RENEWAL_OFFER_LEAD_DAYS, PRICE_INCREASE_LEAD_DAYS];
  const from = addDaysKey(today, Math.min(...leads) - DAY_GRACE_DAYS);
  const to = addDaysKey(today, Math.max(...leads));
  try {
    const { data: rows, error } = await getSupabase().from('contract_reminders')
      .select('id, contract_id, kind, target_date')
      .eq('organization_id', ORG).in('kind', [REMINDER_KIND.renewal, REMINDER_KIND.price_increase])
      .gte('target_date', from).lte('target_date', to)
      .order('target_date', { ascending: true }).order('id', { ascending: true })
      .range(0, 999);
    if (error) throw new Error(error.message);
    if (!rows?.length) return [];
    const subjects = new Map((await contractSubjects(rows.map((r) => r.contract_id))).map((c) => [c.id, c]));
    const priced = [...new Set(rows.filter((r) => r.kind === REMINDER_KIND.price_increase).map((r) => r.contract_id))];
    const years = new Map();
    if (priced.length) {
      const { data: ys, error: e2 } = await getSupabase().from('contract_years')
        .select('id, contract_id, starts_on, monthly_cents')
        .eq('organization_id', ORG).in('contract_id', priced)
        .order('starts_on', { ascending: true }).order('id', { ascending: true })
        .range(0, 4999);
      if (e2) throw new Error(e2.message);
      for (const y of ys || []) {
        if (!years.has(y.contract_id)) years.set(y.contract_id, []);
        years.get(y.contract_id).push(y);
      }
    }
    const out = [];
    for (const r of rows) {
      const c = subjects.get(r.contract_id);
      if (!c || c.status !== CONTRACT_STATUS.active) continue;
      let rise = false;
      if (r.kind === REMINDER_KIND.price_increase) {
        const ys = years.get(r.contract_id) || [];
        const i = ys.findIndex((y) => y.starts_on === r.target_date);
        const now = i > 0 ? toCents(ys[i].monthly_cents) : null;
        const prev = i > 0 ? toCents(ys[i - 1].monthly_cents) : null;
        rise = now !== null && prev !== null && now > prev;
      }
      out.push({ contractId: r.contract_id, kind: r.kind, targetDate: r.target_date, clientIds: c.clientIds, rise });
    }
    return out;
  } catch (e) {
    console.error('[reminders] contract dates read failed:', e?.message || e);
    return null;
  }
}
