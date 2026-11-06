// The CONTRACT panel — one component for the customer page's Contract tab and the Contracts
// list's drill-in, so the two can never show a contract differently (CS-194, CON-1..CON-14).
//
// It reads: the active agreement, its buildings, its per-year prices, its extra-service
// lines, its reminders and the signed PDF; past contracts collapse underneath.
//
// 🔴 MONEY IS HIDDEN, NOT ZERO. A viewer without `invoices.view` gets a payload whose prices
// are null and whose `moneyVisible` is false (CS-019). Every figure here reads that flag and
// prints "Hidden" — printing "$0.00" would say the contract is free, which is a different and
// much worse claim than "you may not see this".
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { fmtDate } from '../lib/dates';
import { moneyCents } from '../lib/money';
import {
  CONTRACT_STATUS, CONTRACT_STATUS_LABELS, CONTRACT_STATUS_VARIANTS,
  TERM_TYPE_LABELS, REMINDER_KIND_LABELS, REMINDER_STATUS, DEFAULT_SNOOZE_DAYS,
  annualValueCents, monthlyCentsOn, linesMonthlyCents, cancellationDeadline, reminderIsDue,
} from '../lib/contracts';
import { addDaysKey } from '../lib/dates';
import Badge from './Badge';
import Icon from './Icon';
import EmptyState from './EmptyState';
import ConfirmDialog from './ConfirmDialog';
import ListPager from './ListPager';
import { usePagedRows } from '../hooks/usePagedRows';

const HIDDEN = 'Hidden';
const money = (cents, visible) => (visible ? moneyCents(cents) : HIDDEN);
const day = (key) => (key ? fmtDate(key, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

// The Term tile's figure: the length, in years when it divides evenly ("3 years"), so it sits
// at the same size as the two money figures beside it. The date range goes underneath.
function termLength(contract) {
  const m = Number(contract.termMonths) || 0;
  if (!m) return contract.endDate ? `Ends ${day(contract.endDate)}` : 'Open-ended';
  if (m % 12 === 0) return `${m / 12} year${m === 12 ? '' : 's'}`;
  return `${m} month${m === 1 ? '' : 's'}`;
}

// The sentence under a reminder row. Due today reads as due; everything else counts down.
function reminderWhen(r, today) {
  if (r.status === REMINDER_STATUS.done) return `Done ${r.doneAt ? fmtDate(r.doneAt) : ''}`.trim();
  if (reminderIsDue(r, today)) return 'Due now';
  if (r.status === REMINDER_STATUS.snoozed) return `Snoozed until ${day(r.nextDueOn)}`;
  return `Reminds ${day(r.nextDueOn)}`;
}

function ContractBody({
  contract, today, moneyVisible, clientNames, canEdit,
  onReminder, onUploadDocument, onOpenDocument, onRemoveDocument, busy,
}) {
  const nav = useFromHere();
  // Every table here pages through the shared pager (UI_RULES §50). None of them has a URL
  // param: they live inside a detail panel (and inside a modal on the Contracts list), where
  // a page number in the address bar would survive the panel closing. In practice all three
  // are short enough that ListPager renders nothing — the rule is what stops a 25-year
  // schedule or a long extras list painting the whole collection when one arrives.
  // The reminder whose note is open, and its draft — lifted out of the row so the row's
  // buttons can live inside the <table> (see the table below).
  const [noteId, setNoteId] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const yearPager = usePagedRows(contract.years || [], { resetKey: contract.id });
  const linePager = usePagedRows(contract.lines || [], { resetKey: contract.id });
  const reminderPager = usePagedRows(contract.reminders || [], { resetKey: contract.id });
  const monthly = monthlyCentsOn(contract, contract.years, today);
  const linesTotal = linesMonthlyCents(contract.lines);
  const annual = annualValueCents(contract, { years: contract.years, lines: contract.lines }, today);
  const notice = cancellationDeadline(contract);
  const names = clientNames || {};

  return (
    <div className="ct-body">
      {/* Three equal tiles: no lead-metric stripe here, since none of the three outranks
          the others on an agreement, and every figure sits at the same size. */}
      <div className="overview-kpis ct-kpis">
        <div className="detail-card kpi">
          <div className="kpi-label">Annual value</div>
          <div className="stat-card-value">{money(annual, moneyVisible)}</div>
          <div className="kpi-sub">{moneyVisible ? 'This contract year, plus extras' : 'Visible to billing roles'}</div>
        </div>
        <div className="detail-card kpi">
          <div className="kpi-label">Monthly</div>
          <div className="stat-card-value">{money(monthly, moneyVisible)}</div>
          <div className="kpi-sub">{moneyVisible && linesTotal ? `+ ${moneyCents(linesTotal)} extras` : 'Base service'}</div>
        </div>
        <div className="detail-card kpi">
          <div className="kpi-label">Term</div>
          <div className="stat-card-value">{termLength(contract)}</div>
          <div className="kpi-sub">{day(contract.startDate)} – {day(contract.endDate)}</div>
        </div>
      </div>

      {/* `.detail-dl` lays out one <div><dt/><dd/></div> per row (label left, value right);
          bare dt/dd children fall outside that grid and stack as loose lines. */}
      <div className="detail-card ct-details">
        <dl className="detail-dl">
          <div>
            <dt>Buildings</dt>
            <dd>
              {(contract.clientIds || []).map((id) => (
                <span key={id} className="ct-building">
                  <Link className="linklike" to={`/clients/${id}`} state={nav}>{names[id] || id}</Link>
                </span>
              ))}
              {contract.isMaster && <Badge variant="blue">Master agreement</Badge>}
            </dd>
          </div>
          <div><dt>Term type</dt><dd>{TERM_TYPE_LABELS[contract.termType] || contract.termType}</dd></div>
          <div><dt>Auto-renew</dt><dd>{contract.termType === 'auto_renew' ? `Yes, every ${contract.renewalTermMonths || 12} months` : 'No'}</dd></div>
          <div>
            <dt>Cancellation notice</dt>
            <dd>{contract.cancellationNoticeDays ? `${contract.cancellationNoticeDays} days${notice ? ` — give notice by ${day(notice)}` : ''}` : '—'}</dd>
          </div>
          <div><dt>Service frequency</dt><dd>{contract.serviceFrequency || '—'}</dd></div>
          <div><dt>Square footage</dt><dd>{contract.squareFootage ? `${contract.squareFootage.toLocaleString('en-US')} sq ft` : '—'}</dd></div>
          {contract.specialTerms && <div><dt>Special terms</dt><dd className="ct-pre">{contract.specialTerms}</dd></div>}
        </dl>
      </div>

      <h4 className="ct-h">Price by contract year</h4>
      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>Year</th><th>Starts</th><th>Monthly</th></tr></thead>
          <tbody>
            {yearPager.pageRows.map((y) => (
              <tr key={y.id || y.yearNumber} className={y.startsOn <= today ? 'ct-year-current' : ''}>
                <td className="cell-primary" data-label="Year">Year {y.yearNumber}{y.startsOn <= today && (!contract.years.some((o) => o.startsOn <= today && o.startsOn > y.startsOn)) ? ' · current' : ''}</td>
                <td data-label="Starts" className="ct-nowrap">{day(y.startsOn)}</td>
                <td data-label="Monthly" className="ct-money">{money(y.monthlyCents, moneyVisible)}</td>
              </tr>
            ))}
            {!(contract.years || []).length && <tr className="stack-plain"><td colSpan={3} className="text-muted">No year schedule yet.</td></tr>}
          </tbody>
        </table>
        <ListPager pager={yearPager} noun="years" />
      </div>

      {!!(contract.lines || []).length && (
        <>
          <h4 className="ct-h">Extra services</h4>
          <div className="table-wrap mobile-stack">
            <table>
              <thead><tr><th>Service</th><th>Monthly</th></tr></thead>
              <tbody>
                {linePager.pageRows.map((l) => (
                  <tr key={l.id}>
                    <td className="cell-primary" data-label="Service">{l.description}</td>
                    <td data-label="Monthly" className="ct-money">{money(l.monthlyCents, moneyVisible)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ListPager pager={linePager} noun="services" />
          </div>
        </>
      )}

      <h4 className="ct-h">Reminders</h4>
      <p className="text-sm text-muted ct-sub">
        Each one reaches the account’s manager and the owner 60 days ahead — renewals, price changes,
        the end date and the cancellation-notice deadline.
      </p>
      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>Reminder</th><th>Date</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {/* Written inline rather than as a <ReminderRow> component so these dense
                `btn-sm` row actions sit visibly INSIDE the <table> — the 28px tier is for a
                data row and nothing else (UI_RULES §115, button-size-lint). The note editor's
                state is lifted here for the same reason, which also matches how ClientDetail
                edits a note in place. */}
            {reminderPager.pageRows.map((r) => {
              const done = r.status === REMINDER_STATUS.done;
              const due = reminderIsDue(r, today);
              const editingNote = noteId === r.id;
              return (
                <tr key={r.id} className={done ? 'ct-rem-done' : ''}>
                  <td className="cell-primary" data-label="Reminder">
                    <span className="truncate">{REMINDER_KIND_LABELS[r.kind] || r.kind}</span>
                    {r.note && !editingNote && <div className="text-xs text-muted truncate" title={r.note}>“{r.note}”</div>}
                    {editingNote && (
                      <div className="ct-rem-note">
                        <input className="input" value={noteDraft} autoFocus placeholder="What happened?"
                          onChange={(e) => setNoteDraft(e.target.value)} />
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                          onClick={() => { onReminder(r.id, { note: noteDraft }); setNoteId(null); }}>Save note</button>
                      </div>
                    )}
                  </td>
                  <td data-label="Date" className="ct-nowrap">{day(r.targetDate)}</td>
                  <td data-label="Status" className="ct-nowrap">
                    {done ? <Badge variant="slate">Done</Badge>
                      : due ? <Badge variant="amber">Due now</Badge>
                        : <span className="text-sm text-muted">{reminderWhen(r, today)}</span>}
                  </td>
                  <td className="cell-actions ct-rem-actions">
                    {canEdit && !done && (
                      <>
                        <button type="button" className="btn btn-link btn-sm" disabled={busy}
                          onClick={() => onReminder(r.id, { status: REMINDER_STATUS.done })}>Mark done</button>
                        <button type="button" className="btn btn-link btn-sm" disabled={busy}
                          onClick={() => onReminder(r.id, { status: REMINDER_STATUS.snoozed, snoozeUntil: addDaysKey(today, DEFAULT_SNOOZE_DAYS) })}>
                          Snooze {DEFAULT_SNOOZE_DAYS}d
                        </button>
                      </>
                    )}
                    {canEdit && done && (
                      <button type="button" className="btn btn-link btn-sm" disabled={busy}
                        onClick={() => onReminder(r.id, { status: REMINDER_STATUS.pending })}>Reopen</button>
                    )}
                    {canEdit && (
                      <button type="button" className="btn btn-link btn-sm"
                        onClick={() => { setNoteId(editingNote ? null : r.id); setNoteDraft(r.note || ''); }}>
                        {r.note ? 'Edit note' : 'Add note'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!(contract.reminders || []).length && (
              <tr className="stack-plain"><td colSpan={4} className="text-muted">Nothing coming up on this contract.</td></tr>
            )}
          </tbody>
        </table>
        <ListPager pager={reminderPager} noun="reminders" />
      </div>

      <h4 className="ct-h">Signed contract</h4>
      <div className="ct-doc">
        {contract.document ? (
          <>
            <Icon name="invoices" size={16} />
            <button type="button" className="linklike" onClick={() => onOpenDocument(contract)}>{contract.document.name}</button>
            {!contract.document.storagePath && <span className="text-xs text-muted"> (not uploaded)</span>}
            {canEdit && <button type="button" className="btn btn-link ct-danger" onClick={() => onRemoveDocument(contract)}>Remove</button>}
          </>
        ) : <span className="text-sm text-muted">No signed copy attached.</span>}
        {canEdit && (
          <label className="btn btn-secondary ct-upload">
            {contract.document ? 'Replace' : 'Attach PDF'}
            <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" hidden
              onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onUploadDocument(contract, f); }} />
          </label>
        )}
      </div>
    </div>
  );
}

// The agreement's heading row: its name (left out inside the Contracts dialog, whose own title
// already names it), the status, and Edit / Delete at the right where they are in reach
// without scrolling past the reminders.
function ContractHead({ contract, showTitle, canEdit, onEdit, onDelete }) {
  return (
    <header className="ct-card-head">
      {showTitle && <h3 className="ct-title">{contract.name || 'Service agreement'}</h3>}
      <Badge variant={CONTRACT_STATUS_VARIANTS[contract.status]}>{CONTRACT_STATUS_LABELS[contract.status]}</Badge>
      {canEdit && (
        <div className="ct-head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onEdit(contract)}>Edit contract</button>
          <button type="button" className="btn btn-link ct-danger" onClick={() => onDelete(contract)}>Delete</button>
        </div>
      )}
    </header>
  );
}

export default function ContractPanel({
  contracts, today, moneyVisible, clientNames, canEdit, loading, error,
  onNew, onEdit, onDelete, onReminder, onUploadDocument, onOpenDocument, onRemoveDocument,
  busy, emptyMessage, inDialog = false,
}) {
  const [confirm, setConfirm] = useState(null);
  const [showPast, setShowPast] = useState(false);
  const list = contracts || [];
  const current = list.filter((c) => c.status === CONTRACT_STATUS.active || c.status === CONTRACT_STATUS.draft);
  const past = list.filter((c) => c.status === CONTRACT_STATUS.ended || c.status === CONTRACT_STATUS.cancelled);

  if (loading) return <div className="ct-loading">Loading contracts…</div>;
  if (error) return <div className="callout callout-warning">{error}</div>;

  if (!list.length) {
    return (
      <EmptyState
        icon={<Icon name="tag" size={28} />}
        title="No contract on file"
        message={emptyMessage || 'Add the signed agreement so its renewal, price changes and notice deadline are tracked.'}
        action={canEdit && onNew && <button className="btn btn-primary" onClick={() => onNew()}>Add contract</button>}
      />
    );
  }

  // One agreement = its heading row + its body, laid straight onto the page (or the dialog).
  // It is NOT wrapped in a card: the tiles, the details and the tables are each their own
  // box already, and a card around them drew a box inside a box.
  const agreement = (c) => (
    <section className="ct-card" key={c.id}>
      <ContractHead contract={c} showTitle={!inDialog} canEdit={canEdit} onEdit={onEdit} onDelete={(x) => setConfirm(x)} />
      <ContractBody
        contract={c} today={today} moneyVisible={moneyVisible} clientNames={clientNames} canEdit={canEdit}
        onReminder={onReminder}
        onUploadDocument={onUploadDocument} onOpenDocument={onOpenDocument} onRemoveDocument={onRemoveDocument}
        busy={busy}
      />
    </section>
  );

  return (
    <div className="ct-panel">
      {current.map(agreement)}

      {canEdit && onNew && (
        <div className="ct-newrow">
          <button type="button" className="btn btn-secondary" onClick={() => onNew()}>
            Add another contract
          </button>
        </div>
      )}

      {!!past.length && (
        <div className="ct-past">
          <button type="button" className="btn btn-link" onClick={() => setShowPast((v) => !v)} aria-expanded={showPast}>
            {showPast ? 'Hide' : 'Show'} past contracts ({past.length})
          </button>
          {showPast && past.map(agreement)}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Delete this contract?"
        message="Its year prices, extra services, reminders and the signed copy go with it. This cannot be undone."
        confirmLabel="Delete contract"
        variant="danger"
        onConfirm={() => { const c = confirm; setConfirm(null); if (c) onDelete(c); }}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
