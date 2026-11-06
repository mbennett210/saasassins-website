// PAY RATES BY BUILDING — the office's editor (PAY-7 / PAY-18, Matt 2026-09-29: "one cleaner
// might have two rate during the day gets $15 at abd building and at night gets $17 at yzd
// building"). Lives inside TeamDetail's "Employment & pay" card, under the main hourly rate,
// and is shown only for an HOURLY member (salary and per-visit have no hourly rate to override).
//
// It writes ONE field, `pay.buildingRates`, through lib/payRates' `setBuildingRate` — the same
// reader the pay run prices from — so a rate typed here and a rate paid there cannot diverge.
// The caller threads the value through TeamDetail's `pay` patch, which means it is gated by
// `payroll.rates.edit` (and the own-pay rule) exactly like the main rate, and the server's
// org_state guard already covers it: `pay` is in `protectedFingerprint`'s user tuple whole.
//
// A departed customer's rate can never match a punch (a punch carries the customer id), so it is
// shown as "Removed customer" with its Clear button rather than hidden — a stale row in a money
// field should be visible and removable, not invisible and priced-at-never.
import { useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import SearchSelect from '../../components/SearchSelect';
import { money } from '../../lib/dates';
import { buildingRatesOf, setBuildingRate } from '../../lib/payRates';

export default function BuildingRatesEditor({ pay, clients = [], canEdit = false, onChange }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ clientId: null, rate: '' });

  const rows = buildingRatesOf(pay);
  const mainRate = Number(pay?.hourlyRate) || 0;
  const nameOf = useMemo(() => {
    const m = new Map();
    for (const c of clients || []) if (c && c.id) m.set(c.id, c.name || c.id);
    return m;
  }, [clients]);
  // Only customers without an override yet — picking one twice is not a second rate, it is an
  // edit of the first, and `setBuildingRate` would silently replace it.
  const options = useMemo(() => {
    const taken = new Set(rows.map((r) => r.clientId));
    return (clients || [])
      .filter((c) => c && c.id && !taken.has(c.id))
      .map((c) => ({ value: c.id, label: c.name || c.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [clients, rows]);

  const commit = (clientId, rate) => onChange(setBuildingRate(pay, clientId, rate));
  const addDraft = () => {
    if (!draft.clientId) return;
    commit(draft.clientId, draft.rate);
    setDraft({ clientId: null, rate: '' });
    setAdding(false);
  };

  return (
    <div className="brate">
      <div className="brate-head">
        <span className="brate-title">Rates by building</span>
        <span className="text-xs text-muted">
          {rows.length === 0
            ? `Everywhere at ${money(mainRate)}/hr.`
            : `${rows.length} ${rows.length === 1 ? 'building' : 'buildings'} differ from the ${money(mainRate)}/hr main rate.`}
        </span>
      </div>

      {rows.length > 0 && (
        <div className="brate-rows">
          {rows.map((r) => {
            const known = nameOf.has(r.clientId);
            return (
              <div className="brate-row" key={r.clientId}>
                <span className="brate-name">
                  {known ? nameOf.get(r.clientId) : <span className="text-muted">Removed customer</span>}
                </span>
                <input
                  className="input brate-input" type="number" min="0" step="0.01"
                  value={r.hourlyRate} disabled={!canEdit}
                  aria-label={`Hourly rate at ${known ? nameOf.get(r.clientId) : 'a removed customer'}`}
                  onChange={(e) => commit(r.clientId, e.target.value)}
                />
                <span className="text-xs text-muted brate-unit">/hr</span>
                {canEdit && (
                  <button
                    type="button" className="btn-icon btn-icon-danger"
                    aria-label={`Remove the rate for ${known ? nameOf.get(r.clientId) : 'this removed customer'}`}
                    onClick={() => commit(r.clientId, null)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canEdit && !adding && options.length > 0 && (
        <button type="button" className="btn btn-outline brate-add" onClick={() => setAdding(true)}>Add a building rate</button>
      )}
      {canEdit && adding && (
        <div className="brate-row brate-new">
          <SearchSelect
            options={options} value={draft.clientId}
            onChange={(v) => setDraft((d) => ({ ...d, clientId: v }))}
            placeholder="Pick a building" searchPlaceholder="Search customers…"
          />
          <input
            className="input brate-input" type="number" min="0" step="0.01" placeholder={String(mainRate)}
            aria-label="Hourly rate at this building"
            value={draft.rate} onChange={(e) => setDraft((d) => ({ ...d, rate: e.target.value }))}
          />
          <span className="text-xs text-muted brate-unit">/hr</span>
          <button type="button" className="btn btn-primary" onClick={addDraft} disabled={!draft.clientId || draft.rate === ''}>Add</button>
          <button type="button" className="btn btn-outline" onClick={() => { setAdding(false); setDraft({ clientId: null, rate: '' }); }}>Cancel</button>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-xs text-muted brate-note">
          Every clock-in is paid at its building&rsquo;s rate. Overtime past 40 hours in a week is
          paid on the week&rsquo;s <strong>blended</strong> rate — that week&rsquo;s pay divided by
          that week&rsquo;s hours — as federal law requires, so the premium is the same whichever
          building the overtime fell at. Remember to press <strong>Save pay</strong>.
        </p>
      )}
    </div>
  );
}
