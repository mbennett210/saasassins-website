export default function Toggle({ on, onChange, disabled = false }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'on' : 'off'}${disabled ? ' toggle-locked' : ''}`}
      onClick={() => { if (!disabled) onChange(!on); }}
      aria-pressed={on}
      disabled={disabled}
    >
      <div className="toggle-thumb" />
    </button>
  );
}
