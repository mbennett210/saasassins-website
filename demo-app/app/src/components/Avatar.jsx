import { useState } from 'react';
import { useAvatarUrl } from '../lib/avatarUrls';
import Centred from './Centred';

// The one avatar (UI_RULES §141). Initials on the member's colour disc, always; a TEAM MEMBER's
// photo, when they have one, is layered over the initials once it has loaded, so:
//   · the box never changes size (no layout shift): the image fills the disc it sits in;
//   · until it loads, and if it never does, the initials show — a link that fails is asked for
//     ONCE more (an expired link), then the initials stay;
//   · contacts, customers and companies pass `initials` / `variant` and never have a photo.
// Pass `user` for a team member: its `initials`, `avatar` (the colour number) and `photo` are
// read from the row, so a call site cannot pair one person's photo with another's letters.
// `centred` sets the initials in the disc's middle by code (components/Centred, kind "ink"), opt-in
// where a screen is measured for it: Settings → Team's list (UI_RULES §191).
export default function Avatar({ user, initials, variant = 1, size = 'sm', centred = false }) {
  const letters = user ? (user.initials ?? initials) : initials;
  const colour = (user ? user.avatar : null) || variant || 1;
  const { url, key, retry } = useAvatarUrl(user);
  // Which link finished loading, and how many times this photo's link failed (keyed by the
  // member's photo version, so a new photo starts over).
  const [loaded, setLoaded] = useState(null);
  const [failures, setFailures] = useState({});
  const failed = key ? failures[key] || 0 : 0;
  const showPhoto = !!url && failed < 2;
  const onError = () => {
    if (!key) return;
    setFailures((f) => ({ ...f, [key]: (f[key] || 0) + 1 }));
    if (failed === 0) retry();
  };
  return (
    <div className={`avatar avatar-${size} avatar-${colour}`}>
      {centred && letters ? <Centred kind="ink">{letters}</Centred> : letters}
      {showPhoto && (
        <img
          className={`avatar-img${loaded === url ? ' is-loaded' : ''}`}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(url)}
          onError={onError}
        />
      )}
    </div>
  );
}
