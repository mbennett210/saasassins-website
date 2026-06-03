export default function Toggle({ on, onChange }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      <div className="toggle-thumb" />
    </button>
  );
}
