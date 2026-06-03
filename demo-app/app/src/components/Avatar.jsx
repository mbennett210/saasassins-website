export default function Avatar({ initials, variant = 1, size = 'sm' }) {
  return (
    <div className={`avatar avatar-${size} avatar-${variant}`}>{initials}</div>
  );
}
