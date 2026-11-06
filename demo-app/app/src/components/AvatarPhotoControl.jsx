import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import AvatarPhotoEditor from './AvatarPhotoEditor';
import Centred from './Centred';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { uploadAvatar, removeAvatar } from '../lib/avatarApi';
import { decodeImage, closeBitmap } from '../lib/imageCanvas';
import { photoVersionOf } from '../lib/userPhoto';

// A team member's PROFILE PHOTO on their profile card (UI_RULES §141): the large avatar, and
// "Add photo" / "Change photo" / "Remove photo" beside it. Settings → Your account shows it for
// you; Team → a member's Profile tab for that member, when the viewer may set it (the page
// decides: `settings.team.edit`, or your own record — the upload route's own rule).
//
// The flow: pick (tapping the avatar opens the picker too) → crop (AvatarPhotoEditor) → the
// device shrinks it → /api/avatars/upload stores the bytes and answers the new version → THIS
// dispatches SET_USER_PHOTO, so the record goes through the normal guarded save. Remove asks
// first (ConfirmDialog), then empties the member's folder and clears the field.
//
// The picker is a plain `accept="image/*"` input with NO `capture`: on an iPhone that offers
// Take Photo and Photo Library (capture would force the camera), and a HEIC photo arrives as a
// JPEG. A file the browser cannot decode gets a sentence, never a silent failure.
//
//   user      the member's roster row (initials, colour, photo)
//   canEdit   may this viewer set it — without it the card shows the avatar alone
//   self      the viewer is this member (the remove question says "your initials")
//   justAdded the member was added a moment ago (the add-member pop-up's last step, HUB-19): the
//             upload route stores a photo only for a member on the SAVED team, and the add is
//             saved a moment after it is made (store/sync.js), so a "not on the team" answer is
//             asked again a few times before it is a failure
//   centred   its buttons' words sit in their middle by code (./Centred), opted into per screen
//             (Daniel's pick, 2026-11-02, "Only this pop-up": the add-member pop-up's last step)
//   children  the card's own lines beside the avatar (the role, its description)
const JUST_ADDED_TRIES = 4;
const JUST_ADDED_WAIT_MS = 1500;
async function uploadFor(blob, userId, justAdded) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await uploadAvatar(blob, { userId });
    } catch (err) {
      if (!justAdded || err?.code !== 'not-on-team' || tries >= JUST_ADDED_TRIES) throw err;
      await new Promise((resolve) => { setTimeout(resolve, JUST_ADDED_WAIT_MS); });
    }
  }
}

export default function AvatarPhotoControl({ user, canEdit = false, self = false, justAdded = false, centred = false, children }) {
  const words = (s) => (centred ? <Centred>{s}</Centred> : s);
  const t = useT();
  const toast = useToast();
  const dispatch = useDispatch();
  const inputRef = useRef(null);
  const [picked, setPicked] = useState(null); // { bitmap, src }
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pickError, setPickError] = useState(null);
  const hasPhoto = !!photoVersionOf(user);

  // Free the decoded photo and its object URL whenever the editor lets go of them.
  useEffect(() => () => {
    if (picked) { closeBitmap(picked.bitmap); URL.revokeObjectURL(picked.src); }
  }, [picked]);

  if (!user) return null;
  const first = (user.name || '').split(' ')[0] || user.name || '';

  const openPicker = () => { setPickError(null); inputRef.current?.click(); };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file again must still fire a change
    if (!file) return;
    const bitmap = await decodeImage(file);
    if (!bitmap) { setPickError(t('avatarPhoto.notAnImage')); return; }
    setPicked({ bitmap, src: URL.createObjectURL(file) });
  };

  const use = async (blob) => {
    setBusy(true);
    try {
      const { v } = await uploadFor(blob, user.id, justAdded);
      dispatch({ type: ACTIONS.SET_USER_PHOTO, userId: user.id, photo: { v } });
      setPicked(null);
      toast.success(t('avatarPhoto.saved'));
    } catch (err) {
      toast.error(errorText(t, err, 'avatarPhoto.saveFailed', { 'bad-photo': 'avatarPhoto.notAnImage' }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeAvatar({ userId: user.id });
      dispatch({ type: ACTIONS.SET_USER_PHOTO, userId: user.id, photo: null });
      toast.success(t('avatarPhoto.removed'));
    } catch (err) {
      toast.error(errorText(t, err, 'avatarPhoto.removeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avatar-photo">
      {canEdit ? (
        <button
          type="button"
          className="avatar-photo-trigger"
          onClick={openPicker}
          disabled={busy}
          aria-label={t('avatarPhoto.pickFor', { name: user.name || '' })}
        >
          <Avatar user={user} size="xl" />
        </button>
      ) : (
        <Avatar user={user} size="xl" />
      )}
      <div className="avatar-photo-body">
        {children}
        {canEdit && (
          <div className="avatar-photo-actions">
            <button type="button" className="btn btn-outline" onClick={openPicker} disabled={busy}>
              {words(hasPhoto ? t('avatarPhoto.change') : t('avatarPhoto.add'))}
            </button>
            {hasPhoto && (
              <button type="button" className="btn btn-link" onClick={() => setConfirmRemove(true)} disabled={busy}>
                {words(t('avatarPhoto.remove'))}
              </button>
            )}
          </div>
        )}
        {pickError && <p className="avatar-photo-error" role="alert">{pickError}</p>}
        {canEdit && (
          <input ref={inputRef} type="file" accept="image/*" className="avatar-photo-input" onChange={onFile} tabIndex={-1} aria-hidden="true" />
        )}
      </div>
      {picked && (
        <AvatarPhotoEditor
          open
          bitmap={picked.bitmap}
          src={picked.src}
          busy={busy}
          onCancel={() => setPicked(null)}
          onUse={use}
        />
      )}
      <ConfirmDialog
        open={confirmRemove}
        title={t('avatarPhoto.confirmRemove.title')}
        message={self ? t('avatarPhoto.confirmRemove.self') : t('avatarPhoto.confirmRemove.other', { name: first })}
        confirmLabel={t('avatarPhoto.remove')}
        variant="danger"
        onConfirm={remove}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}
