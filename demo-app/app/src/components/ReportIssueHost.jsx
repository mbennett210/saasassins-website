import { useEffect, useState } from 'react';
import ReportIssueModal from './ReportIssueModal';

// The ONE "Report an issue" form for the signed-in app (CS-049). Every surface that offers it only
// ASKS, with the `cs:open-report` window event: the desktop sidebar's footer button, the phone
// menu's row (FloatingNav) and the cleaner's account menu on Home (the Cleaner Hub). AppLayout
// mounts this host once for EVERY role, office shell and crew shell alike — it used to live in the
// Sidebar, which the crew shell no longer draws, so a cleaner's ask would have reached nobody. The
// modal portals to <body>. (The crash screen files through lib/supportApi itself: the store, the
// router and Toast this modal needs are what crashed.)
export default function ReportIssueHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('cs:open-report', onOpen);
    return () => window.removeEventListener('cs:open-report', onOpen);
  }, []);
  return <ReportIssueModal open={open} onClose={() => setOpen(false)} />;
}
