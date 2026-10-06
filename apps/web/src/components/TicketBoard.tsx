/**
 * The board: a column, a card, and the drag behaviour between them.
 *
 * Shared by the manager's board and the employee's, because the card is the
 * same object in both and the only difference is whether it can be picked up.
 * Drag is a property of the card, sent by the server — not a prop set by
 * whichever screen happens to be rendering it — so a card the API would refuse
 * to move cannot be made to look draggable by a mistake in one page.
 *
 * Plain HTML drag and drop rather than a library. There is one gesture here,
 * the browsers agree on it, and the whole behaviour is under a hundred lines;
 * a dependency would be larger than the thing it replaced.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { BoardCard, BoardColumnData } from '../contract';
import { Badge } from './Card';
import { Icon } from './Icon';
import { formatDate } from '../lib/format';
import { STATUS_LABEL, STATUS_SHORT, STATUS_TONE } from '../pages/Tasks';

/* --------------------------------------------------------------- the card -- */

/** Two initials, for the avatar. Name truncated to nothing at 290px; initials
 *  plus a tooltip answer "whose is this" in the space of a full stop. */
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function TicketCard({ card }: { card: BoardCard }) {
  const late = card.slaState === 'OVERDUE';
  const when = card.dueAt ?? card.plannedFor;

  return (
    <Link
      to={`/tasks/${card.id}`}
      className={`tcard${card.draggable ? ' tcard--grab' : ''}`}
      draggable={card.draggable}
      onDragStart={(e) => {
        if (!card.draggable) return;
        e.dataTransfer.setData('text/ticket-id', card.id);
        e.dataTransfer.setData('text/ticket-status', card.status);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <span className="tcard__title">{card.title}</span>

      {/* In the Delayed column the real status is the one thing the header
          cannot tell you. Everywhere else it already did. */}
      {late ? (
        <span className="tcard__realstatus">
          <Badge tone={STATUS_TONE[card.status]}>{STATUS_LABEL[card.status]}</Badge>
        </span>
      ) : null}

      {/* Signals, not sentences. Each is a fact somebody checks before
          clicking, and an icon with a number reads faster than a phrase. */}
      <span className="tcard__signals">
        {/* Where it came from, at a glance.
        
            An external ticket is a promise to somebody outside the team, and it
            is read differently from one the team raised for itself -- so it is
            on the card rather than two clicks away. The tooltip names the
            department, because the icon alone says "elsewhere" and not
            "where". */}
        <span
          className={`tcard__signal${card.internal ? '' : ' tcard__signal--ext'}`}
          title={card.internal
            ? `Raised and done inside ${card.departmentName} — ${card.requesterName}`
            : `${card.requesterDepartmentName ?? 'Another department'} asked ${card.departmentName} — ${card.requesterName}`}
        >
          <Icon name={card.internal ? 'home' : 'globe'} size={12} />
          {/* The department *doing* the work, not the one that asked.
          
              An administrator filtering by Marketing is looking at everything
              Marketing wanted, and already knows that much -- what they cannot
              see from the filter is who ended up with each one. The tooltip
              names both, so the direction is never a guess. */}
          {card.internal ? 'internal' : card.departmentName}
        </span>
        {card.waitingOn > 0 ? (
          <span className="tcard__signal tcard__signal--warn"
                title={`Waiting on ${card.waitingOn} other ticket(s)`}>
            <Icon name="clock" size={12} /> {card.waitingOn}
          </span>
        ) : null}
        {card.reviewRejectionCount > 0 ? (
          <span className="tcard__signal tcard__signal--bad"
                title={`Sent back ${card.reviewRejectionCount} time(s)`}>
            <Icon name="refresh" size={12} /> {card.reviewRejectionCount}
          </span>
        ) : null}
        {card.fastTrack ? (
          <span className="tcard__signal" title="Fast-tracked — skips review">
            <Icon name="sparkles" size={12} />
          </span>
        ) : null}
      </span>

      <span className="tcard__foot">
        <span
          className={`tcard__who${card.assigneeName ? '' : ' tcard__who--none'}`}
          title={card.assigneeName ?? 'Nobody assigned yet'}
        >
          {card.assigneeName ? initials(card.assigneeName) : '—'}
        </span>

        {when ? (
          <span className={`tcard__date${late ? ' tcard__date--late' : ''}`}
                title={card.dueAt ? 'Due' : 'Planned for'}>
            <Icon name="calendar" size={12} /> {formatDate(when)}
          </span>
        ) : null}

        <span className={`tcard__flag tcard__flag--${card.priority}`}>
          <Icon name="warning" size={11} />
          {card.priority.charAt(0) + card.priority.slice(1).toLowerCase()}
        </span>
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------- the column -- */

export function BoardColumn({
  column, onDrop, collapsed, onToggle,
}: {
  column: BoardColumnData;
  onDrop?: (ticketId: string, from: string, to: string) => void;
  /** A collapsed column is a narrow strip with its name and count. It still
   *  accepts drops -- folding a column away should not make it unreachable. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const [over, setOver] = useState(false);
  const droppable = column.droppable && !!onDrop;

  return (
    <section
      className={`bcol bcol--${column.key}${over ? ' bcol--over' : ''}${collapsed ? ' bcol--collapsed' : ''}`}
      onDragOver={(e) => {
        if (!droppable) return;
        /* preventDefault is what makes an element a drop target at all --
           without it the browser refuses and the card springs back with no
           explanation. */
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!droppable) return;
        e.preventDefault();
        const id = e.dataTransfer.getData('text/ticket-id');
        const from = e.dataTransfer.getData('text/ticket-status');
        if (id && from !== column.key) onDrop!(id, from, column.key);
      }}
    >
      <header className="bcol__head">
        {onToggle ? (
          <button type="button" className="bcol__fold" onClick={onToggle}
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? 'Expand column' : 'Collapse column'}>
            <Icon name={collapsed ? 'right' : 'down'} size={13} />
          </button>
        ) : null}
        <span className="bcol__pill">
          <span className="bcol__dot" aria-hidden="true" />
          {STATUS_SHORT[column.key] ?? column.key}
        </span>
        <span className="bcol__count">{column.cards.length}</span>
      </header>

      {collapsed ? null : <div className="bcol__cards">
        {column.cards.length === 0 ? (
          <p className="bcol__empty">Nothing here</p>
        ) : column.cards.map((c) => <TicketCard key={c.id} card={c} />)}
      </div>}
    </section>
  );
}