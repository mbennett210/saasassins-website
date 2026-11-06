// "AWAITING YOUR APPROVAL" (S131 Wave 2, brief A; the AM Hub's boards am-web-08 / am-mobile-08):
// over By building's table, the supply orders waiting for a decision THIS viewer may make —
// `orders` is lib/supplies supplyAwaitingApproval over hooks/useSupplyRules, the rule the queue's
// bulk bar and the route read, so a card is never offered that the server would refuse.
//
// One tinted box, its label once, then one row per order (a card on a phone): the building and its
// items × quantity, "#SO-1049 · Requested by {First L.} · {when}" (the number opens the order's page)
// and the asker's note — the cleaner's words to their account manager — then Decline and Approve.
// Decline asks for a reason in the ONE decline dialog (components/SupplyDeclineModal, 3+ characters);
// Approve is one tap. Both go through the existing decide door by hooks/useSupplyMoves: its in-flight
// guard (a double tap sends once), its one toast naming whoever was told, and `onChanged` to re-read.
// The oldest CARDS_SHOWN are listed (the longest waiting first); "Review all N in Requests" opens
// the queue's Pending approval tab, with its bulk Approve, for the rest.
//
// LANGUAGES (CS-193, UI_RULES §140): every word is a catalog line; item names, names and the note
// travel as written.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useSupplyMoves } from '../hooks/useSupplyMoves';
import { hubPersonName } from '../lib/clientHub';
import SupplyDeclineModal from './SupplyDeclineModal';
import { useT } from '../i18n/react';

const CARDS_SHOWN = 3;
// A card names this many items, then "+N more".
const ITEMS_SHOWN = 4;

export default function SupplyApprovalCards({ orders, ctx, online, onChanged, onShowAll }) {
  const t = useT();
  const nav = useFromHere();
  const moves = useSupplyMoves({ ctx, onDone: () => { if (onChanged) onChanged(); } });
  const [declining, setDeclining] = useState(null);
  const list = Array.isArray(orders) ? orders : [];
  if (!list.length) return null;
  const shown = list.slice(0, CARDS_SHOWN);
  const off = moves.working || !online;
  const itemsText = (lines) => {
    const parts = (lines || []).map((l) => t('supplyPage.bld.itemQty', { item: l.name || t('supplyPage.item'), qty: l.qty }));
    const head = parts.slice(0, ITEMS_SHOWN).join(', ');
    return parts.length > ITEMS_SHOWN ? `${head} ${t('supplyPage.bld.moreItems', { count: parts.length - ITEMS_SHOWN })}` : head;
  };
  const title = t('supplyPage.bld.approvals.title');

  return (
    <section className="supply-bld-approvals" aria-label={title}>
      <h2 className="supply-bld-approvals-head"><span className="supply-bld-approvals-dot" aria-hidden />{title}</h2>
      <ul className="supply-bld-approvals-list">
        {shown.map((o) => (
          <li key={o.id} className="supply-bld-approval">
            <div className="supply-bld-approval-text">
              <span className="supply-bld-approval-title">
                {/* i18n-ok: the building's name and its items' names, as stored */}
                <span>{o.buildingName || '—'}</span>
                <span className="supply-bld-approval-sep" aria-hidden> — </span>
                <span className="supply-bld-approval-items">{itemsText(o.lines)}</span>
              </span>
              <span className="text-xs text-muted supply-bld-approval-meta">
                {/* i18n-ok: the order's number, as stored */}
                <Link className="linklike supply-bld-order-head" to={`/supplies/orders/${encodeURIComponent(o.id)}`} state={nav}>{o.no ? `#${o.no}` : t('supplyPage.order.noNumber')}</Link>
                {' · '}
                {t('supplyPage.bld.approvals.requested', { name: hubPersonName(o.requestedByName) || '—', when: o.createdAt })}
              </span>
              {/* i18n-ok: the asker's own note to their account manager, shown as written */}
              {o.note ? <span className="text-xs text-muted supply-bld-approval-note">“{o.note}”</span> : null}
            </div>
            <div className="supply-bld-approval-actions">
              <button type="button" className="btn btn-outline" disabled={off} onClick={() => setDeclining(o)}>{t('supplyPage.reject')}</button>
              <button type="button" className="btn btn-gold" disabled={off} onClick={() => moves.run([o], 'approve')}>{t('supplyPage.approve')}</button>
            </div>
          </li>
        ))}
      </ul>
      {list.length > CARDS_SHOWN && onShowAll && (
        <button type="button" className="btn btn-link supply-bld-approvals-all" onClick={onShowAll}>{t('supplyPage.bld.approvals.all', { count: list.length })}</button>
      )}
      {declining && (
        <SupplyDeclineModal
          request={declining} working={moves.working}
          onDecline={async (reason) => { if (await moves.run([declining], 'reject', reason)) setDeclining(null); }}
          onClose={() => setDeclining(null)}
        />
      )}
    </section>
  );
}
