import { useLocation } from 'react-router-dom';

function deriveFromLabel(pathname, search) {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');

  if (pathname === '/' || pathname === '/dashboard') return 'Dashboard';
  if (pathname === '/contacts' || pathname === '/clients') {
    // Accept legacy ?tab=accounts deep-links as 'Clients' for the breadcrumb.
    return (tab === 'clients' || tab === 'accounts') ? 'Clients' : 'Contacts';
  }
  if (pathname === '/schedule') return 'Schedule';
  if (pathname === '/pipeline') return 'Pipeline';
  if (pathname === '/invoices') return 'Invoices';
  if (pathname === '/messaging') return 'Messaging';
  if (pathname === '/settings/team') return 'Team';
  if (pathname === '/settings/account') return 'Account';
  if (pathname === '/settings/company') return 'Company';
  if (pathname === '/settings/services') return 'Services';
  if (pathname === '/settings/tags') return 'Tags';
  if (pathname === '/settings/roles') return 'Roles';
  if (pathname === '/settings/notifications') return 'Reminders';
  if (pathname === '/settings/integrations') return 'Integrations';
  return null;
}

export function useFromHere() {
  const { pathname, search } = useLocation();
  return { from: `${pathname}${search}`, fromLabel: deriveFromLabel(pathname, search) };
}
