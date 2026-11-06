// The customer page's CONTRACT tab (CS-194, CON-1..CON-14). It loads this building's
// agreements from /api/contracts/for-client and renders the SAME ContractPanel the Contracts
// list drills into, so the two surfaces can never show a contract differently.
//
// It is its own component rather than a block inside ClientDetail because contracts live in
// their own tables, not `org_state`: this tab is the one part of the customer page that
// fetches, and keeping that seam visible stops anyone reaching for a store selector that
// does not exist.
import { useCallback, useEffect, useState } from 'react';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import { todayKey } from '../lib/dates';
import { CONTRACT_STATUS } from '../lib/contracts';
import * as contractsApi from '../lib/contractsApi';
import ContractPanel from './ContractPanel';
import ContractEditor from './ContractEditor';

// `onChanged` (optional): told after every save here, so the onboarding bar's Documents & contracts
// step reads the contract again (task 471).
export default function ClientContracts({ clientId, clients, onChanged = null }) {
  const toast = useToast();
  const canEdit = usePermission('contracts.edit');
  const [data, setData] = useState({ contracts: [], today: todayKey(), moneyVisible: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState(null);

  const reload = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    try {
      const contracts = await contractsApi.contractsForClient(clientId);
      // `contractsForClient` returns the rows; the shared flags ride on each one.
      setData({
        contracts,
        today: todayKey(),
        moneyVisible: contracts.length ? !!contracts[0].moneyVisible : data.moneyVisible,
      });
      setError(null);
    } catch (e) {
      setError(e?.message || 'Contracts could not be loaded.');
    } finally { setLoading(false); }
    // `data.moneyVisible` is only a carry-forward for an empty list, so it must not re-run
    // the fetch; the customer is the only real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);
  useEffect(() => { reload(); }, [reload]);

  const clientNames = Object.fromEntries((clients || []).map((c) => [c.id, c.name]));

  const guard = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
      await reload();
      onChanged?.();
      return true;
    } catch (e) {
      const msg = e?.code === 'building_already_contracted'
        ? `${e.message} (${(e.clientIds || []).map((id) => clientNames[id] || id).join(', ')})`
        : (e?.message || 'That did not save.');
      setEditError(msg);
      toast.error(msg);
      return false;
    } finally { setBusy(false); }
  };

  const save = async (payload, isNew) => {
    setEditError(null);
    const saved = await guard(
      () => (isNew ? contractsApi.createContract(payload) : contractsApi.saveContract(payload.id, payload)),
      isNew ? 'Contract added' : 'Contract saved',
    );
    if (saved) setEditing(null);
  };

  return (
    <>
      <ContractPanel
        contracts={data.contracts}
        today={data.today}
        moneyVisible={data.moneyVisible}
        clientNames={clientNames}
        canEdit={canEdit}
        loading={loading}
        error={error}
        busy={busy}
        emptyMessage="Add the signed agreement so this building's renewal, price changes and notice deadline are tracked."
        onNew={() => { setEditError(null); setEditing({ contract: null }); }}
        onEdit={(c) => { setEditError(null); setEditing({ contract: c }); }}
        onDelete={(c) => guard(() => contractsApi.deleteContract(c.id), 'Contract deleted')}
        onReminder={(id, patch) => guard(() => contractsApi.updateReminder(id, patch))}
        onUploadDocument={(c, file) => guard(() => contractsApi.uploadContractDocument(c.id, file), 'Signed contract attached')}
        onRemoveDocument={(c) => guard(() => contractsApi.deleteContractDocument(c.id, c.document?.storagePath), 'Signed contract removed')}
        onOpenDocument={async (c) => {
          if (!c.document?.storagePath) { toast.error('That file was never uploaded.'); return; }
          try {
            const url = await contractsApi.contractDocumentUrl(c.id, c.document.storagePath);
            if (url) window.open(url, '_blank', 'noopener');
            else toast.error('That file is not available here.');
          } catch (e) { toast.error(e?.message || 'The file could not be opened.'); }
        }}
      />
      <ContractEditor
        open={!!editing}
        contract={editing?.contract || null}
        clientId={clientId}
        clients={clients}
        moneyVisible={data.moneyVisible}
        busy={busy}
        error={editError}
        // CON-13's duplicate-from-previous: the ended agreements on THIS building, newest
        // first, are what a renewal is copied from.
        copyFrom={data.contracts.filter((c) => c.status === CONTRACT_STATUS.ended).slice(0, 2)}
        onSave={save}
        onClose={() => { setEditing(null); setEditError(null); }}
      />
    </>
  );
}
