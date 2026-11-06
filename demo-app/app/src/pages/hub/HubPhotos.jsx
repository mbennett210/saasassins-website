// A row of photos in the client hub: a ticket's, its completion photos, a checklist item's.
// Each is a short-lived signed URL the server minted for this one read (the projection's
// HUB_PHOTO_FIELDS: id, url, thumbUrl, caption); a tap opens the full photo. Nothing to
// render, nothing rendered.
export default function HubPhotos({ photos, label = 'Photos' }) {
  const list = Array.isArray(photos) ? photos.filter((p) => p && (p.thumbUrl || p.url)) : [];
  if (!list.length) return null;
  return (
    <div className="hub-photos" role="group" aria-label={label}>
      {list.map((p) => (
        <a key={p.id} className="hub-photo" href={p.url || p.thumbUrl} target="_blank" rel="noopener noreferrer">
          <img src={p.thumbUrl || p.url} alt={p.caption || label} loading="lazy" />
        </a>
      ))}
    </div>
  );
}
