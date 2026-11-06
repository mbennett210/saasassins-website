// The customer page's DOCUMENTS tab (client hub redesign, plan 2026-10-08 §3.6): what this
// building's customer downloads from the hub's Documents page.
//   · the SERVICE AGREEMENT line — the building's active contract (its name, the day it started,
//     whether a signed copy is on file), linking to the Contract tab where it is kept. The hub
//     shows the same contract (the server's `agreement`), never its price;
//   · the building's documents and the company's own (CustomerDocumentsCard, the one list).
// Mounted only while the tab is active (ClientDetail), like the Contract tab: documents live in
// their own table, and an unopened tab must not make a request on every customer page.
//
// LANGUAGES: every word is a catalog line (`custDocs.*`); a contract's name shows as written.
import { useEffect, useState } from 'react';
import { usePermission } from '../hooks/usePermission';
import { useT } from '../i18n/react';
import { fmtDate } from '../lib/dates';
import { CONTRACT_STATUS } from '../lib/contracts';
import * as contractsApi from '../lib/contractsApi';
import Badge from './Badge';
import CustomerDocumentsCard from './CustomerDocumentsCard';

/**
 * @param clientId       the building
 * @param onOpenContract () => void — show the Contract tab
 */
export default function ClientDocuments({ clientId, onOpenContract }) {
  const t = useT();
  const canViewContracts = usePermission('contracts.view');
  const [agreement, setAgreement] = useState(undefined); // undefined while loading, null for none

  useEffect(() => {
    if (!canViewContracts || !clientId) return undefined;
    let live = true;
    contractsApi.contractsForClient(clientId)
      .then((list) => { if (live) setAgreement((list || []).find((c) => c.status === CONTRACT_STATUS.active) || null); })
      .catch(() => { if (live) setAgreement(null); });
    return () => { live = false; };
  }, [clientId, canViewContracts]);

  const started = agreement?.startDate ? fmtDate(agreement.startDate, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const hasFile = !!(agreement?.document && (agreement.document.storagePath || agreement.document.name));

  return (
    <div>
      {canViewContracts && (
        <div className="card detail-card">
          <div className="overview-card-head">
            <h3>{t('custDocs.agreement.title')}</h3>
            {onOpenContract && (
              <button type="button" className="btn btn-outline" onClick={onOpenContract}>{t('custDocs.agreement.open')}</button>
            )}
          </div>
          {agreement === undefined ? (
            <p className="text-muted text-sm">{t('common.loading')}</p>
          ) : agreement ? (
            <>
              <div className="flex-row" style={{ gap: 'var(--gap-inline)', flexWrap: 'wrap' }}>
                <strong>{agreement.name || t('custDocs.agreement.fallbackName')}</strong>
                {started && <span className="text-muted text-sm">{t('custDocs.agreement.started', { date: started })}</span>}
                <Badge variant={hasFile ? 'green' : 'amber'}>{t(hasFile ? 'custDocs.agreement.fileOnFile' : 'custDocs.agreement.noFile')}</Badge>
              </div>
              <p className="text-xs text-muted" style={{ marginBottom: 0 }}>{t('custDocs.agreement.hint')}</p>
            </>
          ) : (
            <p className="text-muted text-sm" style={{ marginBottom: 0 }}>{t('custDocs.agreement.none')}</p>
          )}
        </div>
      )}
      <CustomerDocumentsCard clientId={clientId} />
    </div>
  );
}
