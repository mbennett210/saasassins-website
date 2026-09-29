import { useState, useEffect, useMemo } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectCompany, selectCurrentUser } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import { usTimezoneOptions, offsetLabel } from '../../lib/timezones';
import { getOrgTimezone, todayKey, composeIso, fmtTime } from '../../lib/dates';

// A concrete before/after for the timezone-change confirmation: take 9:00 AM today
// as the OLD zone reads it, and show what that same instant reads as in the NEW zone.
// This is exactly what the danger is — the stored instant doesn't move, its
// displayed wall-clock does — so showing it beats any abstract warning.
function shiftExample(fromTz, toTz) {
  try {
    const instant = composeIso(todayKey(fromTz), '09:00', fromTz);
    const after = fmtTime(instant, toTz);
    if (!after || after === '9:00 AM') return null; // same offset → nothing to illustrate
    return after;
  } catch {
    return null;
  }
}

export default function SettingsCompany() {
  const state = useStore();
  const company = selectCompany(state);
  const isSuperAdmin = selectCurrentUser(state)?.role === 'owner';
  const dispatch = useDispatch();
  const toast = useToast();
  // A Super Admin's alone: the key is in OWNER_ONLY (lib/roles.js), so can() never gives
  // it to another role, as the server refuses the field from anyone else (orgStateGuard).
  const canEditTimezone = usePermission('settings.company.timezone');
  const [form, setForm] = useState(company);
  const [tzConfirm, setTzConfirm] = useState(null); // { from, to, patch } while confirming a tz change

  useEffect(() => { setForm(company); }, [company]);

  // CURATED to US zones (2026-08-03): the full IANA list let a wrong pick flip the
  // whole org's calendar to another continent (the "South Africa time" incident).
  // The org is Seattle/Pacific; this is US-only, Pacific first. Server also
  // owner-gates the field (orgStateGuard).
  const tzOptions = useMemo(() => usTimezoneOptions(), []);
  // The live blob predates this field (it was never written), so an org with no
  // timezone set is running on the date layer's LA default. Read the resolved value
  // back from that layer rather than re-deriving it here — an empty select would
  // imply "unset / anything goes" when scheduling is very much using a zone.
  const effectiveTz = form.timezone || getOrgTimezone();

  const commit = (patch) => {
    dispatch({ type: ACTIONS.UPDATE_COMPANY, patch });
    toast.success('Company saved');
  };

  const save = (e) => {
    e.preventDefault();
    const patch = {
      name: form.name,
      owner: form.owner,
      logoInitials: (form.logoInitials || '').toUpperCase().slice(0, 3),
      invoicePrefix: form.invoicePrefix,
      address: form.address,
      phone: form.phone,
      email: form.email,
      businessHours: form.businessHours,
      taxRate: Number(form.taxRate) || 0,
    };
    // Only a Super Admin's save may carry the timezone — an Admin editing the phone
    // number must not silently write back a field they can't see or change.
    if (!canEditTimezone) { commit(patch); return; }

    patch.timezone = effectiveTz;
    // Changing the org timezone re-interprets every existing job, invoice date and
    // reminder at once (the danger is display-wide, not per-record) — so a change is
    // gated behind an explicit confirm. An unchanged timezone saves straight through
    // so editing the phone number never triggers the dialog.
    const prevTz = company.timezone || getOrgTimezone();
    if (effectiveTz !== prevTz) { setTzConfirm({ from: prevTz, to: effectiveTz, patch }); return; }
    commit(patch);
  };

  const confirmMsg = tzConfirm && (() => {
    const example = shiftExample(tzConfirm.from, tzConfirm.to);
    const toLabel = `${tzConfirm.to} (UTC${offsetLabel(tzConfirm.to)})`;
    const fromLabel = `${tzConfirm.from} (UTC${offsetLabel(tzConfirm.from)})`;
    return `Every scheduled job, invoice date and reminder is read in the organization's timezone. Changing it from ${fromLabel} to ${toLabel} re-reads all existing records in the new zone${example ? `. A job now showing 9:00 AM will show ${example}` : ''}. No jobs are moved and nothing is re-saved; only how existing times are displayed changes. This affects everyone in the company.`;
  })();

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Company</h1>
      </div>

      <form className="card detail-card" onSubmit={save}>
        <div className="form-row">
          <FormField label="Company name" required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <FormField label="Owner" value={form.owner || ''} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
        </div>
        <div className="form-row">
          <FormField label="Logo initials" value={form.logoInitials || ''} onChange={(e) => setForm({ ...form, logoInitials: e.target.value })} help="2–3 characters shown as a badge" />
          <FormField label="Invoice prefix" value={form.invoicePrefix || ''} onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value })} help="e.g., INV or CS" />
          <FormField label="Default tax rate (%)" type="number" step="0.01" min="0" value={form.taxRate ?? 0} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />
        </div>
        <FormField label="Business address" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        <div className="form-row">
          <FormField label="Phone" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <FormField label="Email" type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <FormField label="Business hours" value={form.businessHours || ''} onChange={(e) => setForm({ ...form, businessHours: e.target.value })} />
        {canEditTimezone ? (
          <FormField
            label="Timezone"
            as="select"
            options={tzOptions}
            value={effectiveTz}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            help="Every job, invoice date and reminder is read in this zone. So a schedule looks the same to your office, your crews, and staff working from anywhere else. Changing it re-dates existing jobs."
          />
        ) : (
          // Read-only for everyone else, with the reason in visible text (no tooltips on touch).
          // A locked select like TeamDetail's Role/Status (the themed select dims when
          // disabled), holding only the zone in use so it reads it even off the US list.
          <FormField
            label="Timezone"
            as="select"
            options={[{ value: effectiveTz, label: tzOptions.find((o) => o.value === effectiveTz)?.label || effectiveTz }]}
            value={effectiveTz}
            disabled
            help={isSuperAdmin
              ? 'Changing the timezone is switched off for your access. Turn it back on in Settings → Roles, or on your Access tab under Team.'
              : 'Only a Super Admin can change the company timezone.'}
          />
        )}
        <div className="modal-actions">
          <button type="submit" className="btn btn-primary">Save Company</button>
        </div>
      </form>

      <ConfirmDialog
        open={!!tzConfirm}
        title="Change the organization timezone?"
        message={confirmMsg}
        confirmLabel="Change timezone"
        cancelLabel="Keep current"
        variant="danger"
        onConfirm={() => tzConfirm && commit(tzConfirm.patch)}
        onClose={() => { setTzConfirm(null); setForm((f) => ({ ...f, timezone: company.timezone })); }}
      />
    </div>
  );
}
