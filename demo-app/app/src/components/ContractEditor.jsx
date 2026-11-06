// The contract form (CS-194, CON-1..CON-14). ONE editor for create and edit, used by the
// customer page's Contract tab and by the Contracts list.
//
// 🔴 CON-13 IS THE DESIGN BRIEF, NOT A NICETY. Matt: "It's hundreds of them. We will enter
// them ourselves." So:
//   · the term drives everything it can — typing 36 months fills the end date and lays out
//     three year-price rows at the monthly price already typed, ready to be raised where the
//     contract rises. Nobody re-types a flat schedule.
//   · every default is the common case (active, fixed term, 36 months, 30 days' notice).
//   · it is one plain form, top to bottom, so Tab goes where a typist expects; nothing opens
//     a sub-dialog to collect a number.
//   · "Copy from…" clones the last contract on the same building — the renewal case, which is
//     most of the book — and leaves only the dates and the price to change.
//   · a derived field STOPS deriving the moment it is typed into, so a hand-entered end date
//     or year price is never overwritten by a later term change.
//
// 🔴 MONEY. Prices are entered in dollars and held as INTEGER CENTS from the first keystroke
// (lib/contracts centsFromInput parses the STRING, so 1250.75 is 125075 and never a float).
// A viewer without `invoices.view` gets `moneyVisible: false` and the price fields are not
// rendered at all — their save omits them, and the server ignores money from them anyway.
import { useMemo, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import SearchSelect from './SearchSelect';
import ListPager from './ListPager';
import { usePagedRows } from '../hooks/usePagedRows';
import {
  CONTRACT_STATUS, CONTRACT_STATUSES, CONTRACT_STATUS_LABELS,
  TERM_TYPE, TERM_TYPES, TERM_TYPE_LABELS, SERVICE_FREQUENCY_SUGGESTIONS,
  derivedEndDate, normalizeYearRows, centsFromInput, inputFromCents, toCount,
} from '../lib/contracts';
import { newContractId } from '../lib/contractsApi';
import { fmtDate } from '../lib/dates';
import { isArchivedCustomer } from '../lib/customerStatus';

const day = (key) => (key ? fmtDate(key, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

const DEFAULTS = {
  status: CONTRACT_STATUS.active,
  termType: TERM_TYPE.fixed,
  termMonths: 36,
  cancellationNoticeDays: 30,
};

// A contract -> the form's own shape (strings where the inputs want strings).
function toForm(c, clientId) {
  if (!c) {
    return {
      ...DEFAULTS,
      id: newContractId(),
      name: '',
      isMaster: false,
      clientIds: clientId ? [clientId] : [],
      startDate: '',
      endDate: '',
      renewalTermMonths: '',
      serviceFrequency: '',
      squareFootage: '',
      specialTerms: '',
      monthly: '',
      years: [],
      lines: [],
      endTouched: false,
      yearsTouched: false,
    };
  }
  return {
    id: c.id,
    name: c.name || '',
    status: c.status,
    isMaster: !!c.isMaster,
    clientIds: [...(c.clientIds || [])],
    startDate: c.startDate || '',
    endDate: c.endDate || '',
    termType: c.termType,
    termMonths: c.termMonths ?? '',
    renewalTermMonths: c.renewalTermMonths ?? '',
    cancellationNoticeDays: c.cancellationNoticeDays ?? '',
    serviceFrequency: c.serviceFrequency || '',
    squareFootage: c.squareFootage ?? '',
    specialTerms: c.specialTerms || '',
    monthly: inputFromCents(c.baseMonthlyCents),
    years: (c.years || []).map((y) => ({ yearNumber: y.yearNumber, startsOn: y.startsOn, monthly: inputFromCents(y.monthlyCents) })),
    lines: (c.lines || []).map((l) => ({ id: l.id, description: l.description, monthly: inputFromCents(l.monthlyCents) })),
    // An existing contract's dates and prices are already the office's, so nothing here
    // re-derives them behind their back.
    endTouched: true,
    yearsTouched: true,
  };
}

export default function ContractEditor({
  open, contract, clientId, clients, moneyVisible, busy, error, onSave, onClose, copyFrom,
}) {
  const [form, setForm] = useState(() => toForm(contract, clientId));
  const [seed, setSeed] = useState(open);
  // Re-seed when the dialog opens on a different record, without an effect (which would
  // paint one frame of the previous contract first).
  if (open !== seed) { setSeed(open); if (open) setForm(toForm(contract, clientId)); }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // The end date follows the term until someone types one (CON-13).
  const setTerm = (patch) => setForm((f) => {
    const next = { ...f, ...patch };
    if (!next.endTouched) {
      next.endDate = derivedEndDate({ startDate: next.startDate, termMonths: next.termMonths }) || '';
    }
    return next;
  });

  // The year grid, prefilled from the term at the monthly price already typed, and
  // recomputed whenever the term or the start date moves — until the office edits a row,
  // after which only its SHAPE follows (rows added or dropped), never its prices.
  const yearRows = useMemo(() => normalizeYearRows(
    form.yearsTouched ? form.years.map((y, i) => ({ yearNumber: i + 1, startsOn: y.startsOn, monthlyCents: centsFromInput(y.monthly) })) : [],
    { startDate: form.startDate, termMonths: form.termMonths, baseMonthlyCents: centsFromInput(form.monthly) },
  ), [form.years, form.yearsTouched, form.startDate, form.termMonths, form.monthly]);

  const setYear = (i, value) => setForm((f) => {
    const rows = yearRows.map((y, idx) => ({
      yearNumber: y.yearNumber, startsOn: y.startsOn,
      monthly: idx === i ? value : inputFromCents(y.monthlyCents),
    }));
    return { ...f, years: rows, yearsTouched: true };
  });

  // No URL param: a dialog's scroll position must not leak into the address bar and survive
  // the dialog closing (usePagedRows' own rule for a table inside a modal).
  const yearPager = usePagedRows(yearRows, { resetKey: `${form.startDate}|${form.termMonths}` });

  // `clients` is the whole roster (it names the buildings already on the contract); the ones to
  // ADD are the customers we serve — an archived customer is never offered (CS-663).
  const clientOptions = useMemo(() => (clients || [])
    .filter((c) => !isArchivedCustomer(c))
    .map((c) => ({ value: c.id, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label)), [clients]);

  const addBuilding = (id) => { if (id && !form.clientIds.includes(id)) set({ clientIds: [...form.clientIds, id] }); };
  const dropBuilding = (id) => set({ clientIds: form.clientIds.filter((x) => x !== id) });

  const problems = [];
  if (!form.clientIds.length) problems.push('Pick at least one building.');
  if (!form.startDate) problems.push('A contract needs a start date.');
  if (form.endDate && form.startDate && form.endDate < form.startDate) problems.push('The end date is before the start date.');
  if (moneyVisible && form.monthly && centsFromInput(form.monthly) === null) problems.push('The monthly price is not an amount.');

  const submit = (e) => {
    e.preventDefault();
    if (problems.length || busy) return;
    const payload = {
      id: form.id,
      name: form.name.trim() || null,
      status: form.status,
      isMaster: form.clientIds.length > 1 ? true : form.isMaster,
      clientIds: form.clientIds,
      startDate: form.startDate,
      endDate: form.endDate || null,
      termType: form.termType,
      termMonths: toCount(form.termMonths),
      renewalTermMonths: toCount(form.renewalTermMonths),
      cancellationNoticeDays: form.cancellationNoticeDays === '' ? null : Math.max(0, Number(form.cancellationNoticeDays) || 0),
      serviceFrequency: form.serviceFrequency.trim() || null,
      squareFootage: toCount(form.squareFootage),
      specialTerms: form.specialTerms.trim() || null,
      lines: form.lines.filter((l) => l.description.trim()).map((l) => ({
        id: l.id, description: l.description.trim(), monthlyCents: centsFromInput(l.monthly) ?? 0,
      })),
    };
    // A viewer who may not see revenue sends NO money at all: the server ignores it from
    // them anyway, and omitting it keeps the request honest about what it is asking for.
    if (moneyVisible) {
      payload.baseMonthlyCents = centsFromInput(form.monthly) ?? 0;
      payload.years = yearRows.map((y) => ({ yearNumber: y.yearNumber, startsOn: y.startsOn, monthlyCents: y.monthlyCents ?? 0 }));
    }
    onSave(payload, !contract);
  };

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title={contract ? 'Edit contract' : 'Add contract'} size="lg">
      <form onSubmit={submit} className="ct-form">
        {!contract && !!(copyFrom || []).length && (
          <div className="callout callout-info ct-copy">
            <span>Renewing an existing agreement?</span>
            {copyFrom.map((c) => (
              <button key={c.id} type="button" className="btn btn-secondary"
                onClick={() => setForm({ ...toForm(c), id: form.id, status: CONTRACT_STATUS.active, startDate: '', endDate: '', endTouched: false })}>
                Copy from {c.name || `the ${c.startDate} agreement`}
              </button>
            ))}
          </div>
        )}

        {/* Four groups, in the order the paper agreement reads: who it covers, its term,
            the service, then the money. Tab still runs top to bottom, left to right. */}
        <h4 className="ct-h ct-group-h">Agreement</h4>
        <div className="ct-grid">
          <FormField label="Buildings">
            <div className="ct-buildings">
              {form.clientIds.map((id) => (
                <span key={id} className="ct-chip">
                  {(clients || []).find((c) => c.id === id)?.name || id}
                  <button type="button" className="chip-remove" aria-label="Remove building" onClick={() => dropBuilding(id)}>×</button>
                </span>
              ))}
              <SearchSelect value="" onChange={addBuilding} options={clientOptions} placeholder="Add a building…" allowClear={false} />
            </div>
          </FormField>

          <FormField label="Agreement name" name="ct-name" value={form.name} onChange={(e) => set({ name: e.target.value })}
            placeholder="Only for a master agreement over several buildings" />

          <FormField label="Status" as="select" name="ct-status" value={form.status}
            onChange={(e) => set({ status: e.target.value })}
            options={CONTRACT_STATUSES.map((s) => ({ value: s, label: CONTRACT_STATUS_LABELS[s] }))} />
        </div>

        <h4 className="ct-h ct-group-h">Term</h4>
        <div className="ct-grid">
          <FormField label="Term type" as="select" name="ct-term-type" value={form.termType}
            onChange={(e) => setTerm({ termType: e.target.value })}
            options={TERM_TYPES.map((t) => ({ value: t, label: TERM_TYPE_LABELS[t] }))} />

          <FormField label="Start date" type="date" name="ct-start" value={form.startDate}
            onChange={(e) => setTerm({ startDate: e.target.value })} required />

          <FormField label="Term length (months)" type="number" name="ct-months" value={form.termMonths}
            onChange={(e) => setTerm({ termMonths: e.target.value })} min="1"
            help="Fills the end date and the year grid below." />

          <FormField label="End date" type="date" name="ct-end" value={form.endDate}
            onChange={(e) => set({ endDate: e.target.value, endTouched: true })}
            help={form.endTouched ? undefined : 'Following the term length.'} />

          {form.termType === TERM_TYPE.auto_renew && (
            <FormField label="Renews every (months)" type="number" name="ct-renew" value={form.renewalTermMonths}
              onChange={(e) => set({ renewalTermMonths: e.target.value })} min="1" placeholder="12" />
          )}

          <FormField label="Cancellation notice (days)" type="number" name="ct-notice" value={form.cancellationNoticeDays}
            onChange={(e) => set({ cancellationNoticeDays: e.target.value })} min="0"
            help="A reminder lands 60 days before the deadline." />
        </div>

        <h4 className="ct-h ct-group-h">Service</h4>
        <div className="ct-grid">
          <FormField label="Service frequency" name="ct-freq" value={form.serviceFrequency}
            onChange={(e) => set({ serviceFrequency: e.target.value })} list="ct-freq-list" placeholder="5x per week, nights" />
          <datalist id="ct-freq-list">
            {SERVICE_FREQUENCY_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
          </datalist>

          <FormField label="Square footage" type="number" name="ct-sqft" value={form.squareFootage}
            onChange={(e) => set({ squareFootage: e.target.value })} min="0" />
        </div>

        <h4 className="ct-h ct-group-h">Price</h4>
        {moneyVisible && (
          <>
            <div className="ct-grid">
              <FormField label="Monthly price ($)" name="ct-monthly" value={form.monthly} inputMode="decimal"
                onChange={(e) => set({ monthly: e.target.value })} placeholder="1250.75"
                help="Year 1. Later years are below." />
            </div>
            <div className="ct-subh">Price by contract year</div>
            <div className="table-wrap mobile-stack ct-years">
              <table>
                <thead><tr><th>Year</th><th>Starts</th><th>Monthly ($)</th></tr></thead>
                <tbody>
                  {/* Paged through the shared pager (UI_RULES §50). The grid is bounded by
                      MAX_CONTRACT_YEARS, so the pager renders NOTHING on every ordinary
                      contract and only appears on a term past twenty years. */}
                  {yearPager.pageRows.map((y) => (
                    <tr key={y.yearNumber}>
                      <td className="cell-primary" data-label="Year">Year {y.yearNumber}</td>
                      <td data-label="Starts" className="ct-nowrap">{day(y.startsOn)}</td>
                      <td data-label="Monthly">
                        <input className="input" inputMode="decimal" aria-label={`Year ${y.yearNumber} monthly price`}
                          value={inputFromCents(y.monthlyCents)} onChange={(e) => setYear(y.yearNumber - 1, e.target.value)} />
                      </td>
                    </tr>
                  ))}
                  {!yearRows.length && <tr className="stack-plain"><td colSpan={3} className="text-muted">Enter a start date and a term length.</td></tr>}
                </tbody>
              </table>
              <ListPager pager={yearPager} noun="years" />
            </div>
          </>
        )}

        <div className="ct-subh">Extra services</div>
        <div className="ct-lines">
          {form.lines.map((l, i) => (
            <div className="ct-line" key={l.id || i}>
              <input className="input" aria-label="Service" placeholder="Floor care" value={l.description}
                onChange={(e) => set({ lines: form.lines.map((x, idx) => (idx === i ? { ...x, description: e.target.value } : x)) })} />
              {moneyVisible && (
                <input className="input ct-line-money" aria-label="Monthly price" inputMode="decimal" placeholder="250.00" value={l.monthly}
                  onChange={(e) => set({ lines: form.lines.map((x, idx) => (idx === i ? { ...x, monthly: e.target.value } : x)) })} />
              )}
              <button type="button" className="btn btn-link ct-danger" onClick={() => set({ lines: form.lines.filter((_, idx) => idx !== i) })}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary" onClick={() => set({ lines: [...form.lines, { description: '', monthly: '' }] })}>
            Add a service
          </button>
        </div>

        <h4 className="ct-h ct-group-h">Special terms</h4>
        <FormField label="Anything else the agreement says" as="textarea" name="ct-terms" value={form.specialTerms}
          onChange={(e) => set({ specialTerms: e.target.value })} rows={3} />

        {!!problems.length && <div className="callout callout-warning">{problems.join(' ')}</div>}
        {error && <div className="callout callout-warning">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !!problems.length}>
            {busy ? 'Saving…' : contract ? 'Save contract' : 'Add contract'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
