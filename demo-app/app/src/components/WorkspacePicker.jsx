// Shared "which Google Workspace?" selector + readiness warning for the connect
// flows (Settings → Connected Inboxes and Marketing → Inboxes). Both route
// through the same OAuth backend, so both choose the Workspace the same way.
//
// - The <select> appears only when 2+ Workspaces are registered (with 0 or 1
//   the Workspace is unambiguous, so the flow stays a single click).
// - A readiness warning appears whenever the chosen Workspace isn't 'active'
//   yet (pending admin approval / unfinished setup / error), so the user is
//   told it may fail BEFORE they hit the Google popup — not left with a
//   dead-on-arrival error afterward.

import { useStore } from '../store';
import { selectOAuthWorkspaces } from '../store/selectors';

const NOT_READY_LABEL = {
  pending: 'awaiting admin approval',
  setup: 'not finished setting up',
  error: 'in an error state',
};

export default function WorkspacePicker({ value, onChange, id = 'connect-workspace' }) {
  const state = useStore();
  const workspaces = selectOAuthWorkspaces(state);
  const selected = workspaces.find((w) => w.id === value) || null;
  const showSelect = workspaces.length >= 2;
  const notReady = selected && selected.status && selected.status !== 'active';

  if (!showSelect && !notReady) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      {showSelect && (
        <>
          <label className="form-label" htmlFor={id}>Which workspace is this mailbox in?</label>
          <select
            id={id}
            className="form-input"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            style={{ width: '100%' }}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}{w.domains?.length ? `. ${w.domains[0]}` : ''}
              </option>
            ))}
          </select>
          <div className="text-xs text-muted" style={{ marginTop: 4 }}>
            Pick the Google Workspace this mailbox belongs to. If you sign into an account from a
            different workspace, Google blocks it. Come back and pick the matching one.
          </div>
        </>
      )}
      {notReady && (
        <div
          className="text-sm"
          style={{ marginTop: showSelect ? 8 : 0, padding: '8px 10px', borderRadius: 8, background: 'var(--color-semantic-warning-50)', border: '1px solid var(--color-semantic-warning-200)', color: 'var(--color-semantic-warning-700)' }}
        >
          <strong>{selected.label}</strong> is {NOT_READY_LABEL[selected.status] || selected.status}.
          Connecting may fail until a Super Admin finishes its setup under{' '}
          <strong>Settings → Integrations → Google Workspaces</strong>.
        </div>
      )}
    </div>
  );
}
