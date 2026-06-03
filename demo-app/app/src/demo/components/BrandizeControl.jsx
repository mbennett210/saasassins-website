import { useState } from 'react';
import { useStore, useDispatch, ACTIONS } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useToast } from '../../components/Toast';
import { PALETTES, PALETTE_KEYS, applyPalette, saveBrand, loadBrand, initialsFrom } from '../brandTheme';
import '../demo.css';

// "Try it with your brand" — lets a prospect see the demo as their own business:
// type a company name and pick a brand palette, applied live across the whole
// demo + CRM. Persists (company name via the store, palette via localStorage);
// "Reset demo" reverts everything to PolishPoint.

export default function BrandizeControl() {
  const company = selectCompany(useStore());
  const dispatch = useDispatch();
  const toast = useToast();
  const [name, setName] = useState(company.name === 'PolishPoint' ? '' : company.name);
  const [palette, setPalette] = useState(loadBrand().palette || 'blue');

  // Live-preview a palette the moment a swatch is clicked (and persist it).
  const pick = (key) => {
    setPalette(key);
    applyPalette(key);
    saveBrand({ palette: key });
  };

  const apply = (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (clean) {
      dispatch({
        type: ACTIONS.UPDATE_COMPANY,
        patch: { name: clean, logoInitials: initialsFrom(clean), logoUrl: null },
      });
      toast.success(`Now showing as ${clean}`);
    } else {
      dispatch({
        type: ACTIONS.UPDATE_COMPANY,
        patch: { name: 'PolishPoint', logoInitials: 'PP', logoUrl: '/polishpoint-logo.png' },
      });
      toast.success('Reverted to PolishPoint');
    }
    applyPalette(palette);
    saveBrand({ palette });
  };

  return (
    <section className="pp-brandize">
      <div className="pp-brandize-text">
        <h2>See it as your business</h2>
        <p>Type your company name and pick a brand style — the whole demo reskins instantly.</p>
      </div>
      <form className="pp-brandize-form" onSubmit={apply}>
        <input
          className="pp-brandize-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your company name"
          aria-label="Your company name"
          maxLength={40}
        />
        <div className="pp-brandize-swatches" role="group" aria-label="Brand style">
          {PALETTE_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`pp-swatch${palette === key ? ' is-active' : ''}`}
              style={{ '--swatch': PALETTES[key].swatch }}
              onClick={() => pick(key)}
              aria-label={PALETTES[key].label}
              aria-pressed={palette === key}
              title={PALETTES[key].label}
            />
          ))}
        </div>
        <button type="submit" className="btn btn-primary">Apply</button>
      </form>
    </section>
  );
}
