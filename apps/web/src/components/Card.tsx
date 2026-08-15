import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { formatAge, formatDateTime } from '../lib/format';

export interface CardProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Grid columns out of twelve. */
  width?: number;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'quiet';
  className?: string;
}

export function Card({ title, subtitle, width, actions, footer, children, tone = 'default', className }: CardProps) {
  return (
    <section
      className={`card${tone === 'quiet' ? ' card--quiet' : ''}${className ? ` ${className}` : ''}`}
      style={width ? ({ ['--span' as string]: String(width) }) : undefined}
    >
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title">{title}</h2>
          {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="card__actions">{actions}</div> : null}
      </header>
      <div className="card__body">{children}</div>
      {footer ? <footer className="card__foot">{footer}</footer> : null}
    </section>
  );
}

/** How old the figures are. Always visible -- never a bare number with no age. */
export function DataAge({ seconds, generatedAt, stale }: {
  seconds: number | null | undefined;
  generatedAt?: string | null;
  stale?: boolean;
}) {
  const label = formatAge(seconds);
  return (
    <span
      className={`age${stale ? ' age--stale' : ''}`}
      title={generatedAt ? `Generated ${formatDateTime(generatedAt)} (Africa/Cairo)` : undefined}
    >
      <Icon name="clock" size={13} />
      {label}
    </span>
  );
}

export function Badge({ tone = 'neutral', icon, children, title }: {
  tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'info' | 'accent';
  icon?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  );
}

/** The open-bucket marker. A provisional figure is not a wrong figure, but it
 *  will move, and the reader has to know that before they quote it. */
export function ProvisionalTag({ what = 'figure' }: { what?: string }) {
  return (
    <Badge tone="warning" icon="clock" title={`This ${what} covers a bucket that is still open, so it will keep moving today.`}>
      Provisional
    </Badge>
  );
}
