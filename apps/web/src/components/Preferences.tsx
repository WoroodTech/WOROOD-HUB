/**
 * The appearance controls that sit in the top bar: colour scheme and language.
 *
 * Both are one button each. The theme button cycles light -> dark -> system and
 * says which of the three it is on, because a two-state toggle cannot express
 * "follow the machine" and users who set that expect it to stay set.
 */

import { useAppearance, type Locale, type ThemeMode } from '../lib/theme';
import { Icon } from './Icon';

const THEME_COPY: Record<ThemeMode, { label: string; icon: string; next: string }> = {
  light: { label: 'Light', icon: 'sun', next: 'Switch to dark' },
  dark: { label: 'Dark', icon: 'moon', next: 'Follow system setting' },
  system: { label: 'System', icon: 'contrast', next: 'Switch to light' },
};

export function ThemeToggle() {
  const { mode, resolved, cycleMode } = useAppearance();
  const copy = THEME_COPY[mode];
  return (
    <button
      type="button"
      className="pref"
      onClick={cycleMode}
      title={`Appearance: ${copy.label}${mode === 'system' ? ` (currently ${resolved})` : ''}. ${copy.next}.`}
      aria-label={`Appearance: ${copy.label}. ${copy.next}`}
    >
      <Icon name={copy.icon} size={16} />
      <span className="pref__label">{copy.label}</span>
    </button>
  );
}

const NEXT_LOCALE: Record<Locale, Locale> = { en: 'ar', ar: 'en' };
const LOCALE_LABEL: Record<Locale, string> = { en: 'EN', ar: 'ع' };

export function LocaleToggle() {
  const { locale, setLocale } = useAppearance();
  const next = NEXT_LOCALE[locale];
  return (
    <button
      type="button"
      className="pref"
      onClick={() => setLocale(next)}
      title={next === 'ar' ? 'Switch to Arabic (right-to-left)' : 'Switch to English (left-to-right)'}
      aria-label={next === 'ar' ? 'Switch to Arabic, right to left' : 'Switch to English, left to right'}
    >
      <Icon name="globe" size={16} />
      <span className="pref__label">{LOCALE_LABEL[locale]}</span>
    </button>
  );
}
