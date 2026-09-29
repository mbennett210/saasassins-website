import { demoOverRealAuth } from '../lib/demoMode';

// Unmissable strip shown ONLY in the dangerous combination: real Supabase auth
// configured but the demo (localStorage-stub) backends engaged — i.e. a dev
// build running with VITE_TIME_STUB against real accounts. In this state the
// time clock, QC, variance, drive, security and account-media flows all LOOK
// live while saving to this browser only. That exact ambiguity cost months of
// crew punch data in production (Sept 1 incident); production builds now refuse
// the flag entirely (lib/demoMode.js), and this banner covers the dev-side hole.
export default function DemoBackendsBanner() {
  if (!demoOverRealAuth()) return null;
  return (
    <div
      role="alert"
      style={{
        background: 'var(--color-semantic-error-50)',
        color: 'var(--color-semantic-error-700)',
        borderBottom: '1px solid var(--color-semantic-error-400)',
        textAlign: 'center',
        fontWeight: 700,
        fontSize: 13,
        letterSpacing: '0.04em',
        padding: '6px 12px',
      }}
    >
      DEMO BACKENDS — clock-ins, QC and time data are NOT being saved to the server
    </div>
  );
}
