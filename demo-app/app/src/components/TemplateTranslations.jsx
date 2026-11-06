import { useMemo, useState } from 'react';
import Badge from './Badge';
import { useT } from '../i18n/react';
import { LANGUAGE_INFO } from '../i18n/languages';
import { demoBackendsEngaged } from '../lib/demoMode';
import {
  TRANSLATED_LANGUAGES, translatableNodes, translationState, withTranslation, translationProgress,
} from '../lib/checklistI18n';

// The demo has no server, so nothing translates a line there (lib/qcApi's stub saves as typed).
const DEMO = demoBackendsEngaged();

// The Translations view of one checklist or inspection template (CS-193, CS-850): every section and
// item, its English, and its Spanish / Creole beside it. OPTIONAL. The server translates each line
// itself when the template is saved (POST /api/qc/templates/save → src/lib/checklistI18n
// fillSchemaTranslations), so lines appear here after Save; nothing is checked and nothing waits
// for anyone. The office may read the lines and change any of them: its own wording then stays
// while the English it was written for stays ("Edited"); cleared, the line goes back to the
// server's translation at the next save. Nothing is saved here — this edits the editor's own areas,
// which its Save draft / Save & publish write; cleaners see a line once the template is published.
export default function TemplateTranslations({ areas, onChange, name = '', nameI18n = null, onNameChange }) {
  const t = useT();
  const [lang, setLang] = useState(TRANSLATED_LANGUAGES[0]);

  // The template's NAME is a line like any other (CS-850), listed first; its lines ride the
  // version's schema as `nameI18n`.
  const nameNode = useMemo(() => ({ label: (name || '').trim(), i18n: nameI18n || undefined }), [name, nameI18n]);
  const nodes = useMemo(() => [
    ...(nameNode.label ? [{ kind: 'name', id: 'name', node: nameNode }] : []),
    ...translatableNodes(areas),
  ], [areas, nameNode]);
  const progress = useMemo(() => {
    const p = translationProgress(areas, lang);
    if (!nameNode.label) return p;
    return { ...p, total: p.total + 1, [translationState(nameNode, lang)]: p[translationState(nameNode, lang)] + 1 };
  }, [areas, lang, nameNode]);
  const languageName = LANGUAGE_INFO[lang].native;

  // Replace ONE section or item, by kind and id (a section's id and an item's never collide in
  // meaning even if they did in spelling).
  const update = (entry, fn) => (entry.kind === 'name' ? onNameChange?.(fn(nameNode).i18n || null) : onChange((areas || []).map((a) => {
    if (a.id !== entry.areaId) return a;
    if (entry.kind === 'area') return fn(a);
    return { ...a, items: (a.items || []).map((i) => (i.id === entry.id ? fn(i) : i)) };
  })));
  const kindWord = (kind) => (kind === 'name' ? t('translations.name') : kind === 'area' ? t('translations.section') : t('translations.item'));

  const stateBadge = (state) => {
    if (state === 'machine') return <Badge variant="green">{t('translations.auto')}</Badge>;
    if (state === 'human') return <Badge variant="blue">{t('translations.edited')}</Badge>;
    return <Badge variant="slate">{t('translations.pending')}</Badge>;
  };

  return (
    <div className="tpl-translations">
      <p className="form-help">{t('translations.introAuto')}</p>
      <div className="segmented" role="tablist" aria-label={t('translations.languageAria')}>
        {TRANSLATED_LANGUAGES.map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={lang === l}
            className={`segmented-btn ${lang === l ? 'active' : ''}`}
            onClick={() => setLang(l)}
          >
            {LANGUAGE_INFO[l].native}
          </button>
        ))}
      </div>

      <div className="tpl-tr-bar">
        <span className="text-sm">{t('translations.summary', { done: progress.machine + progress.human, total: progress.total, language: languageName })}</span>
      </div>
      {DEMO && <p className="tpl-tr-note text-xs text-muted" role="status">{t('translations.demoNote')}</p>}

      {nodes.length === 0 ? (
        <p className="text-sm text-muted">{t('translations.nothing')}</p>
      ) : (
        <ul className="tpl-tr-list">
          {nodes.map((entry) => {
            const { node } = entry;
            const state = translationState(node, lang);
            const line = state === 'pending' ? '' : node.i18n[lang].label;
            return (
              <li key={`${entry.kind}:${entry.id}`} className={`tpl-tr-row ${entry.kind !== 'item' ? 'is-section' : ''}`}>
                <div className="tpl-tr-en">
                  <span className="tpl-tr-kind">{kindWord(entry.kind)}</span>
                  <span lang="en">{node.label}</span>
                </div>
                <input
                  className="input"
                  lang={lang}
                  value={line}
                  placeholder={t('translations.placeholder', { language: languageName })}
                  aria-label={t('translations.inputAria', { english: node.label, language: languageName })}
                  onChange={(e) => update(entry, (n) => withTranslation(n, lang, e.target.value))}
                />
                <div className="tpl-tr-meta">{stateBadge(state)}</div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="form-help">{t('translations.saveNote')}</p>
    </div>
  );
}
