import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { ApiError } from '../lib/api';

/** Shimmering placeholder lines, sized to what is coming. */
export function Skeleton({ lines = 3, height = 12 }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className="skeleton__bar"
          style={{ height, inlineSize: `${100 - i * (60 / Math.max(lines, 1))}%` }}
        />
      ))}
    </div>
  );
}

export function LoadingState({ label = 'Loading', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <Skeleton lines={lines} />
    </div>
  );
}

export function EmptyState({ icon = 'sparkles', title, hint }: { icon?: string; title: string; hint?: ReactNode }) {
  return (
    <div className="state state--empty">
      <span className="state__icon"><Icon name={icon} size={20} /></span>
      <p className="state__title">{title}</p>
      {hint ? <p className="state__hint">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const forbidden = error instanceof ApiError && error.forbidden;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className={`state state--error${compact ? ' state--compact' : ''}`} role="alert">
      <span className="state__icon state__icon--alert">
        <Icon name={forbidden ? 'lock' : 'warning'} size={20} />
      </span>
      <p className="state__title">{forbidden ? 'Not available to your account' : 'Could not load this'}</p>
      <p className="state__hint">{message}</p>
      {onRetry && !forbidden ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
          <Icon name="refresh" size={15} /> Try again
        </button>
      ) : null}
    </div>
  );
}

/** A widget key the portal has no component for -- never break the grid. */
export function PlaceholderState({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="state state--placeholder">
      <span className="state__icon"><Icon name="layout-grid" size={20} /></span>
      <p className="state__title">{label}</p>
      <p className="state__hint">{hint ?? 'This portal build has no component for this item yet. Nothing else on the page is affected.'}</p>
    </div>
  );
}
