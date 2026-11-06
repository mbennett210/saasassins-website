// Settings → Your account → Language (CS-193; Matt's LANG-3 + LANG-11: "follow the phone,
// with a switch in settings"). For EVERY role, cleaners included — a cleaner whose phone is
// in English but who reads Spanish needs this most of all.
//
// The choices name themselves in their own language ("Español", "Kreyòl ayisyen") — never
// translated — so a Spanish reader finds Spanish on a screen they cannot read yet. The
// first choice says which language the phone is giving them right now.
//
// The switch applies at once (no Save: UI_RULES §8, a toggle-like control changes the data
// and the screen IS the confirmation — here the whole app changes language under the
// finger). It writes the person's OWN row through SET_USER_LANGUAGE, whose value check is
// the write point (store/reducer.js), and a cleaner's save is merged on the server by the
// crew allowlist with the same check (api/_lib/crewMerge.js §a).
import Icon from './Icon';
import Select from './Select';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useT, useLanguage } from '../i18n/react';
import { AUTO_LANGUAGE, LANGUAGES, LANGUAGE_INFO, normalizeLanguageChoice } from '../i18n/languages';

export default function LanguageCard({ user }) {
  const t = useT();
  const { phone, lang } = useLanguage();
  const dispatch = useDispatch();
  const choice = normalizeLanguageChoice(user?.language);
  const phoneName = LANGUAGE_INFO[phone || 'en'].native;
  const options = [
    { value: AUTO_LANGUAGE, label: t('lang.auto', { language: phoneName }) },
    ...LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_INFO[code].native })),
  ];
  const setChoice = (value) => {
    if (!user?.id || value === choice) return;
    dispatch({ type: ACTIONS.SET_USER_LANGUAGE, userId: user.id, language: value });
  };
  return (
    <div className="card detail-card">
      <h3 className="dash-card-title"><Icon name="globe" size={16} /> {t('lang.title')}</h3>
      <p className="pref-row-desc">{t('lang.description')}</p>
      <Select value={choice} onChange={setChoice} options={options} ariaLabel={t('lang.title')} />
      {/* In the login-free demo, a line with no Spanish or Creole yet (one added since the
          last translation pass) shows bracketed placeholder text instead — said here, so
          nobody mistakes it for a translation. Absent from a real build. */}
      {import.meta.env.MODE === 'demo' && lang !== 'en' && (
        <p className="text-xs text-muted" style={{ marginTop: 'var(--space-2)' }}>{t('lang.demoNote')}</p>
      )}
    </div>
  );
}
