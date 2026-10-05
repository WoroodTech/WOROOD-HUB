/**
 * The two ways to look at the same tickets: columns, or a list grouped by
 * status.
 *
 * The board is for moving work; the list is for reading it — every ticket on
 * one screen with its person, date, priority and estimate in aligned columns,
 * which is what somebody wants when they are asked "what is everyone on".
 * Both read the same data, so switching never refetches and never disagrees.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { BoardCard, BoardColumnData } from '../contract';
import { Icon } from './Icon';
import { formatDate } from '../lib/format';
import { STATUS_SHORT } from '../pages/Tasks';

export type TicketView = 'board' | 'list';

/** The view lives in the URL, so a link to "the list" opens the list and a
 *  reload does not drop somebody back on a board they had switched away from. */
export function useTicketView(): [TicketView, (v: TicketView) => void] {
  const [params, setParams] = useSearchParams();
  const view: TicketView = params.get('view') === 'list' ? 'list' : 'board';
  const set = (v: TicketView) => {
    const next = new URLSearchParams(params);
    if (v === 'list') next.set('view', 'list'); else next.delete('view');
    setParams(next, { replace: true });
  };
  return [view, set];
}

export function ViewToggle({ view, onChange }: { view: TicketView; onChange: (v: TicketView) => void }) {
  return (
    <div className="ranges" role="group" aria-label="View">
      <button type="button" className={`ranges__btn${view === 'board' ? ' is-active' : ''}`}
              aria-pressed={view === 'board'} onClick={() => onChange('board')}>
        <Icon name="grip" size={14} /> Board
      </button>
      <button type="button" className={`ranges__btn${view === 'list' ? ' is-active' : ''}`}
              aria-pressed={view === 'list'} onClick={() => onChange('list')}>
        <Icon name="list" size={14} /> List
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- formatting -- */

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const PRIORITY_LABEL: Record<string, string> = {
  LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent',
};

/* ------------------------------------------------------------------ list -- */

export function TicketListView({ columns }: { columns: BoardColumnData[] }) {
  const navigate = useNavigate();
  const [closed, setClosed] = useState<Set<string>>(new Set());

  /* Delayed is left out. On the board it is a lens over the other columns; in
     a list grouped by status it would print every late ticket twice. Lateness
     shows instead as a red date on the ticket's own row. */
  const groups = columns.filter((c) => c.key !== 'DELAYED');
  const toggle = (k: string) => setClosed((s) => {
    const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n;
  });

  return (
    <div className="tlist">
      {groups.map((g) => {
        const open = !closed.has(g.key);
        return (
          <section key={g.key} className={`tlist__group bcol--${g.key}`}>
            <header className="tlist__ghead">
              <button type="button" className="bcol__fold" onClick={() => toggle(g.key)}
                      aria-expanded={open} aria-label={open ? 'Collapse group' : 'Expand group'}>
                <Icon name={open ? 'down' : 'right'} size={13} />
              </button>
              <span className="bcol__pill">
                <span className="bcol__dot" aria-hidden="true" />
                {STATUS_SHORT[g.key] ?? g.key}
              </span>
              <span className="tlist__gcount">{g.cards.length}</span>
            </header>

            {open ? (
              g.cards.length === 0 ? (
                <p className="tlist__empty">No tickets here.</p>
              ) : (
                <div className="tlist__table" role="table">
                  <div className="tlist__row tlist__row--head" role="row">
                    <span role="columnheader">Name</span>
                    <span role="columnheader">Assignee</span>
                    <span role="columnheader">Due date</span>
                    <span role="columnheader">Priority</span>
                    <span role="columnheader">Status</span>
                  </div>
                  {g.cards.map((c) => (
                    <ListRow key={c.id} card={c} onOpen={() => navigate(`/tasks/${c.id}`)} />
                  ))}
                </div>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ListRow({ card, onOpen }: { card: BoardCard; onOpen: () => void }) {
  const late = card.slaState === 'OVERDUE';
  const when = card.dueAt ?? card.plannedFor;

  return (
    <div className="tlist__row" role="row" tabIndex={0}
         onClick={onOpen}
         onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <span className="tlist__name" role="cell">
        <span className="tlist__dot" aria-hidden="true" />
        <span className="tlist__title">{card.title}</span>
        <span className="mono tlist__ref">{card.reference}</span>
        {!card.internal ? (
          <span className="tlist__ext" title={`From ${card.requesterDepartmentName ?? 'another department'}`}>
            <Icon name="globe" size={11} />
          </span>
        ) : null}
      </span>

      <span role="cell">
        {card.assigneeName ? (
          <span className="tlist__who" title={card.assigneeName}>
            <span className="tcard__who">{initials(card.assigneeName)}</span>
            <span className="tlist__whoname">{card.assigneeName}</span>
          </span>
        ) : <span className="muted">—</span>}
      </span>

      <span role="cell" className={late ? 'tcard__date--late' : 'tlist__muted'}>
        {when ? formatDate(when) : <Icon name="calendar" size={14} />}
      </span>

      <span role="cell" className={`tcard__flag tcard__flag--${card.priority}`}>
        <Icon name="warning" size={11} /> {PRIORITY_LABEL[card.priority] ?? card.priority}
      </span>

      <span role="cell">
        <span className={`tlist__status bcol--${card.status}`}>
          {STATUS_SHORT[card.status] ?? card.status}
        </span>
      </span>

    </div>
  );
}