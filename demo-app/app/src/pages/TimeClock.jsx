import TimeClockHistory from '../components/TimeClockHistory';

// Manager Time Clock: every crew clock-in / clock-out, org-wide, newest first.
// The account, crew-member and job pages show the same history scoped to them;
// the Variance report analyses it against expected time. Route-gated time.view.
export default function TimeClock() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Time Clock</h1>
          <p className="page-sub">
            Every crew clock-in and clock-out: who, where, when, how long. The same history
            appears on each account’s <strong>Time clock</strong> tab, each crew member’s page and
            each clean; the Variance report compares it against expected time.
          </p>
        </div>
      </div>
      <TimeClockHistory title="All punches" defaultPeriod="7d" />
    </div>
  );
}
