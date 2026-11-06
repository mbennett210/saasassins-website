// Keeps the screen's language in step with the signed-in person (CS-193; LANG-3, LANG-11).
// Headless; mounted once in App's BackgroundServices, for every role.
//
//   1. Their SAVED choice (users[].language, Settings → Account) drives the i18n runtime:
//      'auto' follows this phone, anything else wins over it. An owner viewing as a team
//      member sees that member's language for the visit, without it becoming this device's.
//   2. What THIS phone says is RECORDED on their own row (users[].phoneLanguage) whenever it
//      differs from what is stored — the server cannot ask a phone, and it writes their
//      alerts, notifications and texts in their language (LANG-4). Written once per change,
//      never on every load, so a stable phone costs nothing. Only the person actually signed
//      in is recorded: the phone in someone's hand is theirs, not the one they view as.
//   3. Signed in, the SERVER'S LINES for the language on screen (what this build's bundle lacks,
//      translated by the server — CS-851) are fetched once per session and build and merged
//      over the bundle (src/i18n/runtime refreshServerLines); an office tab does the same for
//      every language its roster reads, since it writes their bell rows.
import { useCallback, useEffect } from 'react';
import { useDispatch, useSelector } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectAuthenticatedUser, selectCurrentUser } from '../store/selectors';
import { setLanguageChoice, getLanguageSnapshot, ensureCatalog, refreshServerLines } from '../i18n/runtime';
import { useLanguage } from '../i18n/react';
import { userLanguage, SOURCE_LANGUAGE } from '../i18n/languages';
import { fetchLines } from '../lib/i18nApi';
import { SUPERVISOR_ROLES } from '../lib/roles';

export default function LanguageSync() {
  const dispatch = useDispatch();
  const me = useSelector(selectAuthenticatedUser);
  const viewed = useSelector(selectCurrentUser);
  // Whether my roster row exists (a claim-only login has none yet, and a write would no-op).
  const myId = me?.id || null;
  const onRoster = useSelector(useCallback((s) => !!myId && (s.users || []).some((u) => u.id === myId), [myId]));

  const viewingOther = !!viewed && !!me && viewed.id !== me.id;
  const choice = viewingOther ? userLanguage(viewed) : (me?.language ?? null);
  useEffect(() => {
    setLanguageChoice(choice, { persist: !viewingOther });
  }, [choice, viewingOther]);

  const { lang: shown } = useLanguage();
  useEffect(() => {
    if (!me?.id || !shown || shown === SOURCE_LANGUAGE) return;
    ensureCatalog(shown).then(() => refreshServerLines(shown, fetchLines));
  }, [me?.id, shown]);

  const storedPhone = me?.phoneLanguage ?? null;
  useEffect(() => {
    if (!me?.id || !onRoster) return;
    const phone = getLanguageSnapshot().phone ?? null;
    if (phone !== storedPhone) {
      dispatch({ type: ACTIONS.SET_USER_LANGUAGE, userId: me.id, phoneLanguage: phone });
    }
  }, [me?.id, onRoster, storedPhone, dispatch]);

  // 4. An OFFICE tab writes bell rows for other people (a message to a cleaner, a clean
  //    assigned, an account's notes changed), and each row is written in its recipient's
  //    language — so it loads the languages its roster reads, in the background. A crew
  //    tab never writes anyone else's row (the server derives those), so it loads nothing
  //    it does not show.
  const office = SUPERVISOR_ROLES.includes(me?.role);
  const rosterLangs = useSelector(useCallback(
    (s) => [...new Set((s.users || []).filter((u) => u && u.status === 'active').map(userLanguage))].sort().join(','),
    [],
  ));
  useEffect(() => {
    if (!office || !rosterLangs) return;
    for (const lang of rosterLangs.split(',')) ensureCatalog(lang).then(() => refreshServerLines(lang, fetchLines));
  }, [office, rosterLangs]);

  return null;
}
