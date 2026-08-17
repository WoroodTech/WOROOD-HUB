/**
 * Transient confirmations.
 *
 * A toast is for feedback the user asked for and will not miss if they blink --
 * "layout reset", "copied". It is never the only place an error is reported:
 * failures belong in the surface that failed, where they persist. The live
 * region is polite for the same reason.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { Icon } from '../components/Icon';

export type ToastTone = 'neutral' | 'good' | 'warning';

interface Toast { id: number; message: string; tone: ToastTone }

interface ToastValue { push: (message: string, tone?: ToastTone) => void }

const ToastContext = createContext<ToastValue | null>(null);

const LIFETIME_MS = 3200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => () => { timers.current.forEach(window.clearTimeout); }, []);

  const push = useCallback((message: string, tone: ToastTone = 'neutral') => {
    const id = (seq.current += 1);
    setToasts((prev) => [...prev.slice(-2), { id, message, tone }]);
    timers.current.push(
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), LIFETIME_MS),
    );
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toaster" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast toast--${t.tone}`} key={t.id}>
            <Icon name={t.tone === 'good' ? 'check' : t.tone === 'warning' ? 'warning' : 'info'} size={15} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  /* A toast is a nicety. Rendering outside the provider (a test, a story)
     should not crash the surface under test. */
  return ctx ?? { push: () => {} };
}
