// Contracts — the book (CS-194, Matt's CON-1..CON-14). Every signed agreement, what is
// coming up on it, and what the book is worth.
//
// Matt: "It's hundreds of them. We will enter them ourselves." So this page is built for a
// list of hundreds, not a demo of three: twenty rows a page through the shared pager
// (UI_RULES §50), the filters in the URL so Back restores the exact view, and the two
// vocabularies the office uses — Manager and Customer.
//
// 🔴 THE MONEY ON THIS PAGE IS REVENUE. The server serves prices only to a holder of
// `invoices.view` (CS-019) and says so in `moneyVisible`; the value column and the book total
// are then hidden rather than zeroed, because "$0.00" is a claim about the contract and
// "Hidden" is a claim about the viewer.
//
// A contract whose EVERY building is archived has left the book (CS-663; the server says so in
// `buildingsArchived` and leaves it out of the book value): it stays listed with its history,
// marked "Customer archived", out of the active count and the "due now" count.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useStore } from '../store';
import { selectClients, selectUserById } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { usePagedRows } from '../hooks/usePagedRows';
import { useT } from '../i18n/react';
import { SUPERVISOR_ROLES } from '../lib/roles';
import { fmtDate, todayKey } from '../lib/dates';
import { moneyCents } from '../lib/money';
import {
  CONTRACT_STATUS, CONTRACT_STATUS_LABELS, CONTRACT_STATUS_VARIANTS,
  REMINDER_KIND_LABELS, REMINDER_STATUS, reminderIsDue,
} from '../lib/contracts';
import * as contractsApi from '../lib/contractsApi';
import Badge from '../components/Badge';
import Icon from '../components/Icon';
import FormField from '../components/FormField';
import FilterSelect from '../components/FilterSelect';
import EmptyState from '../components/EmptyState';
import ListPager from '../components/ListPager';
import Modal from '../components/Modal';
import ContractPanel from '../components/ContractPanel';
import ContractEditor from '../components/ContractEditor';

const STATUS_TABS = ['active', 'all', CONTRACT_STATUS.draft, CONTRACT_STATUS.ended];
const STATUS_TAB_LABELS = { active: 'Active', all: 'All', draft: 'Drafts', ended: 'Ended' };
const day = (key) => (key ? fmtDate(key, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

// The soonest thing still outstanding on a contract — the column the office scans for.
function nextReminder(contract, today) {
  return (contract.reminders || [])
    .filter((r) => r.status !== REMINDER_STATUS.done)
    .sort((a, b) => String(a.nextDueOn).localeCompare(String(b.nextDueOn)))
    .find((r) => r.targetDate >= today) || null;
}

export default function Contracts() {
  const t = useT();
  const state = useStore();
  const toast = useToast();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canEdit = usePermission('contracts.edit');

  const [params, setParams] = useSearchParams();
  const setParam = useCallback((patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: true }), [setParams]);

  const status = STATUS_TABS.includes(params.get('status')) ? params.get('status') : 'active';
  const mgrFilter = params.get('mgr') || '';
  const custFilter = params.get('cust') || '';
  const openId = params.get('c') || '';

  const [data, setData] = useState({ contracts: [], today: todayKey(), moneyVisible: false, bookValueCents: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);      // { contract } | { contract: null }
  const [editError, setEditError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await contractsApi.listContracts());
      setError(null);
    } catch (e) {
      setError(e?.message || 'Contracts could not be loaded.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // The WHOLE roster: it names every building on a contract, an archived one included (CS-663).
  // The editor offers only the customers we serve (ContractEditor leaves archived ones out).
  const clients = selectClients(state) || [];
  const clientNames = useMemo(
    () => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients],
  );
  const managers = useMemo(() => (state.users || [])
    .filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '')), [state.users]);
  const supervisorOf = useCallback((contract) => {
    for (const id of contract.clientIds || []) {
      const sup = clients.find((c) => c.id === id)?.supervisorId;
      if (sup) return sup;
    }
    return null;
  }, [clients]);

  const { today, moneyVisible } = data;
  const rows = useMemo(() => (data.contracts || [])
    .filter((c) => (status === 'all' ? true : status === 'active' ? c.status === CONTRACT_STATUS.active : c.status === status))
    .filter((c) => !mgrFilter || supervisorOf(c) === mgrFilter)
    .filter((c) => !custFilter || (c.clientIds || []).includes(custFilter))
    .sort((a, b) => {
      const an = nextReminder(a, today);
      const bn = nextReminder(b, today);
      if (an && bn) return an.nextDueOn.localeCompare(bn.nextDueOn);
      if (an) return -1;
      if (bn) return 1;
      return String(a.endDate || '9999').localeCompare(String(b.endDate || '9999'));
    }), [data.contracts, status, mgrFilter, custFilter, supervisorOf, today]);

  const pager = usePagedRows(rows, { param: 'page', resetKey: `${status}|${mgrFilter}|${custFilter}` });

  // The headline figures. `bookValueCents` is the server's sum over EVERY active contract,
  // not the filtered page — the book is the book. The upcoming counts follow the filter,
  // because that is the list in front of you.
  // A contract that left the book (every building archived, CS-663) rings nobody, so its
  // reminders are not "due now" and it is not one of the active contracts the book counts.
  const dueNow = rows.reduce((n, c) => (c.buildingsArchived ? n : n + (c.reminders || []).filter((r) => reminderIsDue(r, today)).length), 0);
  const activeInBook = (data.contracts || []).filter((c) => c.status === CONTRACT_STATUS.active && !c.buildingsArchived).length;

  const open = (data.contracts || []).find((c) => c.id === openId) || null;

  const mgrOptions = [
    { value: '', label: 'All managers' },
    ...managers.map((m) => ({ value: m.id, label: m.id === currentUser?.id ? `${m.name} (me)` : m.name })),
  ];
  const custOptions = [
    { value: '', label: 'All customers' },
    ...clients
      .filter((c) => !mgrFilter || c.supervisorId === mgrFilter)
      .map((c) => ({ value: c.id, label: c.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  // ── the write paths, all through the API (never a direct store write) ──────
  const guard = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
      await reload();
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
    const okSaved = await guard(
      () => (isNew ? contractsApi.createContract(payload) : contractsApi.saveContract(payload.id, payload)),
      isNew ? 'Contract added' : 'Contract saved',
    );
    if (okSaved) setEditing(null);
  };

  const panelProps = {
    today,
    moneyVisible,
    clientNames,
    canEdit,
    busy,
    onEdit: (c) => { setEditError(null); setEditing({ contract: c }); },
    onDelete: (c) => guard(() => contractsApi.deleteContract(c.id), 'Contract deleted'),
    onReminder: (id, patch) => guard(() => contractsApi.updateReminder(id, patch)),
    onUploadDocument: (c, file) => guard(() => contractsApi.uploadContractDocument(c.id, file), 'Signed contract attached'),
    onRemoveDocument: (c) => guard(() => contractsApi.deleteContractDocument(c.id, c.document?.storagePath), 'Signed contract removed'),
    onOpenDocument: async (c) => {
      if (!c.document?.storagePath) { toast.error('That file was never uploaded.'); return; }
      try {
        const url = await contractsApi.contractDocumentUrl(c.id, c.document.storagePath);
        if (url) window.open(url, '_blank', 'noopener');
        else toast.error('That file is not available here.');
      } catch (e) { toast.error(e?.message || 'The file could not be opened.'); }
    },
  };

  return (
    <div className="ct-page">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Contracts</h1>
          <p className="text-sm text-muted">
            {moneyVisible
              ? <>Book value <strong>{moneyCents(data.bookValueCents)}</strong> a year across {activeInBook} active contracts.</>
              : <>{activeInBook} active contracts. Contract value is visible to billing roles.</>}
            {dueNow > 0 && <> · <strong>{dueNow}</strong> reminder{dueNow === 1 ? '' : 's'} due now.</>}
          </p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => { setEditError(null); setEditing({ contract: null }); }}>
            Add contract
          </button>
        )}
      </div>

      <div className="filter-bar">
        <FormField label="Status">
          <div className="tab-container-line" role="group" aria-label="Status">
            {STATUS_TABS.map((s) => (
              <button key={s} type="button" className={`tab-btn ${status === s ? 'active' : ''}`}
                onClick={() => setParam({ status: s === 'active' ? null : s, page: null })}>
                {STATUS_TAB_LABELS[s]}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Manager">
          <FilterSelect ariaLabel="Manager" value={mgrFilter} options={mgrOptions}
            onChange={(v) => setParam({ mgr: v, cust: null, page: null })} />
        </FormField>
        <FormField label="Customer">
          <FilterSelect ariaLabel="Customer" value={custFilter} options={custOptions}
            onChange={(v) => setParam({ cust: v, page: null })} />
        </FormField>
      </div>

      {loading ? (
        <div className="ct-loading">Loading contracts…</div>
      ) : error ? (
        <div className="callout callout-warning">{error} <button type="button" className="linklike" onClick={reload}>Retry</button></div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="tag" size={28} />}
          title={data.contracts.length ? 'No contracts match these filters' : 'No contracts yet'}
          message={data.contracts.length
            ? 'Clear a filter to see the rest of the book.'
            : 'Add the signed agreements so renewals, price changes and notice deadlines are tracked for you.'}
          action={canEdit && !data.contracts.length && (
            <button className="btn btn-primary" onClick={() => setEditing({ contract: null })}>Add contract</button>
          )}
        />
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Manager</th>
                <th>Term</th>
                <th>Next reminder</th>
                <th>Annual value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((c) => {
                const next = nextReminder(c, today);
                const sup = supervisorOf(c);
                const supName = sup ? selectUserById(state, sup)?.name : null;
                const label = c.name || (c.clientIds || []).map((id) => clientNames[id] || id).join(', ') || 'Service agreement';
                return (
                  <tr key={c.id} className="ct-row" onClick={() => setParam({ c: c.id })}>
                    <td className="cell-primary" data-label="Contract">
                      <span className="truncate" title={label}>{label}</span>
                      {(c.clientIds || []).length > 1 && <Badge variant="blue">{c.clientIds.length} buildings</Badge>}
                    </td>
                    <td data-label="Manager">{supName || <span className="text-muted">Unassigned</span>}</td>
                    <td data-label="Term">{day(c.startDate)} – {day(c.endDate)}</td>
                    <td data-label="Next reminder">
                      {next ? (
                        // A contract that left the book (every building archived) rings nobody, so
                        // its next date is shown without a Due mark (CS-663).
                        <span className={reminderIsDue(next, today) && !c.buildingsArchived ? 'ct-due' : ''}>
                          {REMINDER_KIND_LABELS[next.kind]} · {day(next.targetDate)}
                          {reminderIsDue(next, today) && !c.buildingsArchived && <> <Badge variant="amber">Due</Badge></>}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td data-label="Annual value" className="ct-money">
                      {moneyVisible ? moneyCents(c.annualValueCents) : <span className="text-muted">Hidden</span>}
                    </td>
                    <td data-label="Status">
                      <Badge variant={CONTRACT_STATUS_VARIANTS[c.status]}>{CONTRACT_STATUS_LABELS[c.status]}</Badge>
                      {c.buildingsArchived && <> <Badge variant="slate">{t('custArchive.contractBadge')}</Badge></>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ListPager pager={pager} noun="contracts" />
        </div>
      )}

      {/* The drill-in. A master agreement has no single customer page to open, so the whole
          panel lives here too — one component, so the two surfaces cannot disagree. */}
      <Modal open={!!open} onClose={() => setParam({ c: null })} title={open ? (open.name || 'Service agreement') : ''} size="lg">
        {open && (
          <>
            <p className="text-sm text-muted ct-sub">
              {(open.clientIds || []).map((id) => (
                <Link key={id} className="linklike" to={`/clients/${id}`} state={nav}>{clientNames[id] || id}</Link>
              )).reduce((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}
            </p>
            <ContractPanel contracts={[open]} inDialog {...panelProps} />
          </>
        )}
      </Modal>

      <ContractEditor
        open={!!editing}
        contract={editing?.contract || null}
        clients={clients}
        moneyVisible={moneyVisible}
        busy={busy}
        error={editError}
        copyFrom={[]}
        onSave={save}
        onClose={() => { setEditing(null); setEditError(null); }}
      />
    </div>
  );
}
