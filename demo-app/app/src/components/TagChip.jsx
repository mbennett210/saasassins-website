// Small pill rendering a single tag. Color conventions removed — every tag
// reads with the same neutral chrome (matches GHL). The `tag.color` field
// is left untouched in storage for forward/backward data compatibility.
// onRemove (optional) renders an × affordance.

export default function TagChip({ tag, onRemove, size = 'sm' }) {
  if (!tag) return null;
  const cls = `tag-chip ${size === 'xs' ? 'tag-xs' : ''}`;
  return (
    <span className={cls}>
      <span className="tag-label">{tag.label}</span>
      {onRemove && (
        <button
          type="button"
          className="tag-remove"
          aria-label={`Remove ${tag.label}`}
          onClick={(e) => { e.stopPropagation(); onRemove(tag); }}
        >
          ×
        </button>
      )}
    </span>
  );
}
