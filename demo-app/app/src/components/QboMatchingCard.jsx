// Settings → Integrations · QuickBooks · NEEDS MATCHING (QB-12).
//
// Matt, 2026-09-29: "When a QuickBooks customer doesn't match an account in the app? (a) Put it on
// a 'needs matching' list for your analyst." Two views of one question:
//   · Only in QuickBooks — active QuickBooks customers with activity in the last twelve months that
//     reach no property here (neither linked nor under a linked parent), with the customer here
//     they most likely ARE (the same four-digit number, else the same name) — offered, never applied;
//   · Only here — this app's active customers with no QuickBooks link at all.
// "Link…" opens the Link-a-property dialog with the pair filled in; linking stays the owner's
// (PUT /api/quickbooks/links is owner-only by role), so anyone else sees the list and the reason.
// Names only — no figures — behind integrations.view, the same read the QuickBooks status uses.
// Never writes to QuickBooks. Written on the catalog from its first line (UI_RULES §140); a list
// table with search and 20 rows a page (§72, §50).
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { selectClients, selectClientStatus } from '../store/selectors';
import { getQboNeedsMatching } from '../lib/qboApi';
import { suggestAccountFor, accountsWithoutQuickBooks } from '../lib/qboRules';
import { customerLabel } from '../lib/customerNumber';
import { usePagedRows } from '../hooks/usePagedRows';
import { useTableSearch } from '../hooks/useTableSearch';
import { searchRows } from '../lib/searchRows';
import ListPager from './ListPager';
import TableSearch from './TableSearch';
import EmptyState from './EmptyState';
import { useT } from '../i18n/react';

export default function QboMatchingCard({ isOwner, onLink, reloadKey = 0 }) {
  const t = useT();
  const state = useStore();
  const clients = selectClients(state);
  const [phase, setPhase] = useState('loading'); // loading | ready | error
  const [data, setData] = useState(null);
  const [view, setView] = useState('qbo'); // qbo | app
  const [q, setQ] = useTableSearch('mq');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setPhase('loading');
    getQboNeedsMatching()
      .then((d) => { if (alive) { setData(d); setPhase('ready'); } })
      .catch(() => { if (alive) setPhase('error'); });
    return () => { alive = false; };
  }, [reloadKey, nonce]);

  const linkedClientIds = useMemo(() => data?.linkedClientIds || [], [data]);
  const qboRows = useMemo(() => (data?.customers || []).map((c) => ({
    ...c, suggestion: suggestAccountFor(c.name, clients, linkedClientIds),
  })), [data, clients, linkedClientIds]);
  const appRows = useMemo(
    () => accountsWithoutQuickBooks(clients, linkedClientIds, { isActive: (c) => selectClientStatus(state, c) === 'active' })
      .slice().sort((a, b) => customerLabel(a).localeCompare(customerLabel(b), 'en', { numeric: true })),
    [clients, linkedClientIds, state],
  );
  const all = view === 'qbo' ? qboRows : appRows;
  const rows = useMemo(() => searchRows(all, q, (r) => (view === 'qbo'
    ? `${r.name} ${r.parentName || ''} ${r.suggestion ? customerLabel(r.suggestion) : ''}`
    : `${customerLabel(r)} ${r.city || ''}`)), [all, q, view]);
  const pager = usePagedRows(rows, { param: 'mpage', resetKey: `${view}|${q}` });

  if (phase === 'loading' && !data) return <div className="qbo-matching text-sm text-muted">{t('common.loading')}</div>;
  if (phase === 'error') {
    return (
      <section className="qbo-matching">
        <div className="form-error">{t('qboMatch.error')}</div>
        <button type="button" className="btn btn-outline qbo-note" onClick={() => setNonce((n) => n + 1)}>{t('common.retry')}</button>
      </section>
    );
  }
  if (!data || data.connected === false) return null;
  const counts = data.counts || {};

  return (
    <section className="qbo-matching">
      <div className="table-head">
        <h3 className="table-head-title">{t('qboMatch.title')}</h3>
        <p className="text-sm text-muted qbo-matching-intro">{t('qboMatch.intro')}</p>
        <div className="table-controls">
          <TableSearch value={q} onChange={setQ} placeholder={t('qboMatch.search')} />
          {q && <span className="table-count">{t('qboMatch.shownOf', { shown: rows.length, total: all.length })}</span>}
          <span className="spacer" />
          <div className="segmented" role="group" aria-label={t('qboMatch.viewLabel')}>
            <button type="button" className={`segmented-btn ${view === 'qbo' ? 'active' : ''}`} aria-pressed={view === 'qbo'} onClick={() => setView('qbo')}>
              {t('qboMatch.viewQbo', { count: qboRows.length })}
            </button>
            <button type="button" className={`segmented-btn ${view === 'app' ? 'active' : ''}`} aria-pressed={view === 'app'} onClick={() => setView('app')}>
              {t('qboMatch.viewApp', { count: appRows.length })}
            </button>
          </div>
        </div>
      </div>

      {view === 'qbo' && !data.activityKnown && (
        <div className="callout callout-warning qbo-matching-note">
          <span>{t('qboMatch.activityPending')}</span>
          <button type="button" className="btn btn-outline" onClick={() => setNonce((n) => n + 1)}>{t('qboMatch.checkAgain')}</button>
        </div>
      )}
      {view === 'qbo' && data.activityKnown && (
        <p className="text-xs text-muted qbo-matching-intro">
          {t('qboMatch.leftOut', {
            linked: counts.linked || 0, covered: counts.covered || 0, quiet: counts.quiet || 0,
            inactive: Math.max(0, (counts.total || 0) - (counts.active || 0)),
          })}
        </p>
      )}
      {!isOwner && <p className="text-xs text-muted qbo-matching-intro">{t('qboMatch.ownerOnly')}</p>}

      {all.length === 0 ? (
        <EmptyState title={view === 'qbo' ? t('qboMatch.allMatchedQbo') : t('qboMatch.allMatchedApp')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('common.noMatches')} />
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table>
              {view === 'qbo' ? (
                <>
                  <thead>
                    <tr>
                      <th>{t('qboMatch.col.qbo')}</th>
                      <th>{t('qboMatch.col.under')}</th>
                      <th>{t('qboMatch.col.suggested')}</th>
                      {isOwner && <th aria-label={t('qboMatch.col.action')} />}
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageRows.map((r) => (
                      <tr key={r.id}>
                        <td className="cell-primary" data-label={t('qboMatch.col.qbo')}><span className="name">{r.name}</span></td>
                        <td data-label={t('qboMatch.col.under')}>{r.parentName || '—'}</td>
                        <td data-label={t('qboMatch.col.suggested')}>{r.suggestion ? customerLabel(r.suggestion) : '—'}</td>
                        {isOwner && (
                          <td className="text-right cell-actions" data-label="">
                            <button type="button" className="btn btn-outline btn-sm"
                              onClick={() => onLink({ clientId: r.suggestion?.id || '', entityType: 'customer', entityId: r.id })}>
                              {t('qboMatch.link')}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead>
                    <tr>
                      <th>{t('qboMatch.col.customer')}</th>
                      <th>{t('qboMatch.col.city')}</th>
                      {isOwner && <th aria-label={t('qboMatch.col.action')} />}
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageRows.map((c) => (
                      <tr key={c.id}>
                        <td className="cell-primary" data-label={t('qboMatch.col.customer')}><span className="name">{customerLabel(c)}</span></td>
                        <td data-label={t('qboMatch.col.city')}>{c.city || '—'}</td>
                        {isOwner && (
                          <td className="text-right cell-actions" data-label="">
                            <button type="button" className="btn btn-outline btn-sm"
                              onClick={() => onLink({ clientId: c.id, entityType: 'customer', entityId: '' })}>
                              {t('qboMatch.link')}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </div>
          <ListPager pager={pager} noun={t('pager.noun.customers')} />
        </>
      )}
    </section>
  );
}
