// "Glass cleaner ×4 +2 more" — a supply request's one line, in the reader's language (the item
// as written). One implementation for the Supplies queue and the customer's Supplies tab: the
// parts come from lib/supplies supplyLinesSummary, the words from the catalog (UI_RULES §140).
import { useT } from '../i18n/react';
import { supplyLinesSummary } from '../lib/supplies';

export function useSupplyLinesText() {
  const t = useT();
  return (lines) => {
    const s = supplyLinesSummary(lines);
    if (!s) return '—';
    const head = t('supplyPage.lineQty', { item: s.name || t('supplyPage.item'), qty: s.qty });
    return s.more > 0 ? t('supplyPage.lineMore', { line: head, count: s.more }) : head;
  };
}
