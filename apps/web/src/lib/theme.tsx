/**
 * Appearance preferences: colour scheme and writing direction.
 *
 * Both are stamped on <html> as attributes -- `data-theme` and `dir` -- so the
 * stylesheet, the chart palette and any third-party surface all read the same
 * single source of truth. Nothing here re-renders the tree to change a colour:
 * CSS custom properties do that. What we *do* broadcast is a `wh:appearance`
 * event, because the charts paint to a <canvas>/<svg> with literal hex values
 * and have to be told to repaint.
 *
 * `system` is a real, persisted choice -- not the absence of one. A user who
 * picked "system" keeps following the OS after a reload; a user who picked
 * light stays light even at night.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Direction = 'ltr' | 'rtl';
export type Locale = 'en' | 'ar';

const THEME_KEY = 'worood.appearance.theme';
const LOCALE_KEY = 'worood.appearance.locale';

/** Arabic is the only RTL locale the portal ships; direction follows locale. */
const DIR_OF: Record<Locale, Direction> = { en: 'ltr', ar: 'rtl' };

export const APPEARANCE_EVENT = 'wh:appearance';

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key) as T | null;
    return raw && allowed.includes(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: preference is session-only */ }
}

interface AppearanceValue {
  mode: ThemeMode;
  /** What the mode actually resolves to right now. */
  resolved: 'light' | 'dark';
  locale: Locale;
  dir: Direction;
  setMode: (mode: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
  /** Cycles light -> dark -> system, for the single-button control. */
  cycleMode: () => void;
}

const AppearanceContext = createContext<AppearanceValue | null>(null);

const prefersDark = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(
    () => readStored(THEME_KEY, ['light', 'dark', 'system'] as const, 'system'),
  );
  const [locale, setLocaleState] = useState<Locale>(
    () => readStored(LOCALE_KEY, ['en', 'ar'] as const, 'en'),
  );
  const [systemDark, setSystemDark] = useState(prefersDark);

  /* Follow the OS only while the mode is `system`, but keep the listener alive
     regardless so switching back to `system` is instantly correct. */
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const dir = DIR_OF[locale];

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('dir', dir);
    root.setAttribute('lang', locale);
    /* Suppress transitions for one frame: flipping every token at once would
       otherwise animate the whole page, which reads as a glitch, not polish. */
    root.classList.add('is-theming');
    const t = window.setTimeout(() => root.classList.remove('is-theming'), 90);
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: { theme: resolved, dir } }));
    return () => window.clearTimeout(t);
  }, [resolved, dir, locale]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    write(THEME_KEY, next);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    write(LOCALE_KEY, next);
  }, []);

  const cycleMode = useCallback(() => {
    setMode(mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light');
  }, [mode, setMode]);

  const value = useMemo<AppearanceValue>(
    () => ({ mode, resolved, locale, dir, setMode, setLocale, cycleMode }),
    [mode, resolved, locale, dir, setMode, setLocale, cycleMode],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used inside <AppearanceProvider>');
  return ctx;
}

/**
 * Charts hold literal colours, so they subscribe to the appearance event and
 * repaint. Returns a number that changes on every switch -- use it as a React
 * key or a dependency, not as a value.
 */
export function useAppearanceVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(APPEARANCE_EVENT, bump);
    return () => window.removeEventListener(APPEARANCE_EVENT, bump);
  }, []);
  return version;
}
