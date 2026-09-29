// One employee's HR record — the shared HR-fields + Documents cards in a modal, plus
// a link to the full Settings → Team profile (roles / overrides / time-clock live
// there). Opened from the Employees tab.
import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useFromHere } from '../../hooks/useFromHere';
import Modal from '../../components/Modal';
import Avatar from '../../components/Avatar';
import EmployeeHrFieldsCard from '../../components/EmployeeHrFieldsCard';
import EmployeeDocumentsCard from '../../components/EmployeeDocumentsCard';
import { useSelector } from '../../store';
import { selectCurrentUser } from '../../store/selectors';
import { ROLE_LABELS } from '../../lib/roles';

export default function EmployeeHrPanel({ user, onClose }) {
  const currentUser = useSelector(useCallback((s) => selectCurrentUser(s), []));
  const nav = useFromHere();
  return (
    <Modal open onClose={onClose} title={user.name} size="lg">
      <div className="hr-panel">
        <div className="hr-panel-head">
          <Avatar initials={user.initials} variant={user.avatar} size="md" />
          <div className="hr-panel-who">
            <div className="hr-panel-name">{user.name}</div>
            <div className="text-xs text-muted">{ROLE_LABELS[user.role]} · {user.email}</div>
          </div>
          <Link className="btn btn-outline" to={`/settings/team/${user.id}`} state={nav} onClick={onClose}>Full profile &amp; permissions →</Link>
        </div>
        <EmployeeHrFieldsCard user={user} />
        <EmployeeDocumentsCard user={user} currentUserId={currentUser && currentUser.id} />
      </div>
    </Modal>
  );
}
