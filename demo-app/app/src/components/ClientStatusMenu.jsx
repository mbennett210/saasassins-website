import { useRef, useState } from 'react';
import PopMenu from './PopMenu';
import Badge, { DERIVED_STATUS_VARIANTS } from './Badge';
import { useT } from '../i18n/react';

// The company status pill in the ClientDetail header. Lead/Active auto-derive from
// real work (selectClientStatus); clicking the badge sets a manual override that
// wins over the derived value (Inactive is override-only). A viewer without
// clients.edit sees a plain, non-interactive badge, and so does an ARCHIVED customer
// (CS-663): the archive is left by Restore, never by the status menu.
const STATUS_META = {
  lead:     { label: 'Lead',     variant: 'amber' },
  active:   { label: 'Active',   variant: 'green' },
  inactive: { label: 'Inactive', variant: 'slate' },
  vendor:   { label: 'Vendor',   variant: 'slate' },
};
// Lead/Active/Inactive are the sales STATUS; Vendor is the company TYPE. They share
// one menu (blended by request); Vendor sits under a divider to hint the difference.
// Picking Vendor sets type=vendor; picking a status un-vendors and sets the status.
const ORDER = ['lead', 'active', 'inactive', 'vendor'];

export default function ClientStatusMenu({ value, canEdit, onChange }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  if (value === 'archived') return <Badge variant={DERIVED_STATUS_VARIANTS.archived}>{t('custArchive.badge')}</Badge>;
  // A new customer reads "Onboarding" until every step on its onboarding bar is green (task 471);
  // the menu can't pick it (it ends by itself), and Inactive or Vendor picked here still win.
  const meta = value === 'onboarding'
    ? { label: t('onboarding.badge'), variant: DERIVED_STATUS_VARIANTS.onboarding }
    : (STATUS_META[value] || STATUS_META.lead);

  if (!canEdit) return <Badge variant={meta.variant}>{meta.label}</Badge>;

  const choose = (st) => { if (st !== value) onChange(st); setOpen(false); };

  return (
    <div className="status-menu" ref={wrapRef}>
      <button
        type="button"
        className="badge-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change status"
      >
        <Badge variant={meta.variant}>{meta.label}</Badge>
        <span className="status-caret" aria-hidden>▾</span>
      </button>
      <PopMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        className="status-popover"
        role="listbox"
        sheetTitle="Status"
      >
        {ORDER.map((st) => {
          const m = STATUS_META[st];
          return (
            <button
              key={st}
              type="button"
              role="option"
              aria-selected={value === st}
              className={`menu-option ${st === 'vendor' ? 'status-typed' : ''} ${value === st ? 'on' : ''}`}
              onClick={() => choose(st)}
            >
              <span className={`status-dot status-dot-${m.variant}`} aria-hidden />
              <span>{m.label}</span>
            </button>
          );
        })}
      </PopMenu>
    </div>
  );
}
