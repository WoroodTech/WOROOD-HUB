import type { ReactNode } from 'react';
import { formatTime } from '../lib/format';
import type { BusyBlock } from '../lib/api';

export function Card({
  title,
  action,
  children,
  className = '',
  tight = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  tight?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <h3>{title}</h3>
          {action}
        </header>
      )}
      <div className={`card-body${tight ? ' tight' : ''}`}>{children}</div>
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    CONFIRMED: 'badge-ok',
    PENDING: 'badge-warn',
    CANCELLED: 'badge-bad',
    COMPLETED: 'badge-mute',
    ACTIVE: 'badge-ok',
    MAINTENANCE: 'badge-warn',
    INACTIVE: 'badge-mute',
  };
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return <span className={`badge ${map[status] ?? 'badge-mute'}`}>{label}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ padding: 20, justifyContent: 'center', color: 'var(--ink-500)' }}>
      <span className="spinner" />
      {label && <span style={{ fontSize: 13 }}>{label}</span>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const message =
    (error as { message?: string })?.message ?? 'Something went wrong. Please try again.';
  return <div className="alert alert-bad">{message}</div>;
}

/**
 * Horizontal day timeline. Busy blocks are positioned as a percentage of the
 * room's bookable window, so it works for any opening hours.
 */
export function DayTimeline({
  from,
  to,
  busy,
}: {
  from: string;
  to: string;
  busy: BusyBlock[];
}) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const span = Math.max(end - start, 1);

  return (
    <div>
      <div className="timeline">
        {busy.map((block, index) => {
          const blockStart = Math.max(new Date(block.startsAt).getTime(), start);
          const blockEnd = Math.min(new Date(block.endsAt).getTime(), end);
          if (blockEnd <= blockStart) return null;
          const left = ((blockStart - start) / span) * 100;
          const width = ((blockEnd - blockStart) / span) * 100;
          return (
            <div
              key={index}
              className={`timeline-block${block.kind === 'BLACKOUT' ? ' blackout' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${block.title ?? 'Busy'} — ${formatTime(block.startsAt)}–${formatTime(block.endsAt)}`}
            >
              {width > 9 ? formatTime(block.startsAt) : ''}
            </div>
          );
        })}
      </div>
      <div className="timeline-scale">
        <span>{formatTime(from)}</span>
        <span>{formatTime(to)}</span>
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="card-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="card-body">{children}</div>
        {footer && (
          <div className="card-head" style={{ borderTop: '1px solid var(--line)', borderBottom: 'none', justifyContent: 'flex-end' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
