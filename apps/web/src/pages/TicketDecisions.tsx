/**
 * The manager's morning: everything with nobody on it.
 *
 * Three groups asking the same question three ways — what has nobody holding
 * it, and what did I decide about each. New is undecided, Planned has a date,
 * On hold has a reason. All three empty the moment somebody is assigned, which
 * is what makes this a queue rather than a list.
 *
 * Rows, not cards. The screen is vertical so the width is free, and a row wide
 * enough to carry the decision buttons is a row a manager can clear without
 * opening anything. Cards would waste the width and hide the actions.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardCard, TaskPerson } from '../contract';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Badge } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';
import { PRIORITY_TONE } from './Tasks';
import { localNow } from './TaskDetail';

interface DecisionsResponse {
  empty: 'notAManager' | null;
  departments: Array<{ id: string; name: string }>;
  groups: Array<{ key: 'NEW' | 'PLANNING' | 'ON_HOLD'; cards: BoardCard[] }>;
}

const GROUP = {
  NEW: {
    title: 'Waiting on you',
    hint: 'Nobody has looked at these yet. Plan one, hold it, or give it to somebody.',
    icon: 'bell',
    empty: 'Nothing new has come in.',
  },
  PLANNING: {
    title: 'Planned',
    hint: 'A date, no person yet. They leave here when somebody picks them up.',
    icon: 'calendar',
    empty: 'Nothing is planned for later.',
  },
  ON_HOLD: {
    title: 'On hold',
    hint: 'Parked with a reason. Nothing moves until you assign them.',
    icon: 'clock',
    empty: 'Nothing is parked.',
  },
} as const;

type Dialog =
  | null
  | { kind: 'plan'; card: BoardCard }
  | { kind: 'hold'; card: BoardCard }
  | { kind: 'assign'; card: BoardCard };

export function TicketDecisions() {
  const [departmentId, setDepartmentId] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [value, setValue] = useState('');
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['tasks', 'decisions', departmentId],
    queryFn: () => api<DecisionsResponse>(
      `/tasks/decisions${departmentId ? `?departmentId=${departmentId}` : ''}`),
    refetchInterval: 60_000,
  });

  const { data: people } = useQuery({
    queryKey: ['tasks', 'people', dialog?.card.departmentId],
    queryFn: () => api<TaskPerson[]>(`/tasks/departments/${dialog!.card.departmentId}/people`),
    enabled: dialog?.kind === 'assign',
  });

  const act = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body: unknown }) =>
      api(`/tasks/${id}${path}`, { method: 'POST', body }),
    onSuccess: () => {
      setDialog(null); setValue('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: unknown) => {
      toast.push(e instanceof Error ? e.message : 'That did not work.', 'warning');
    },
  });

  const submit = () => {
    if (!dialog) return;
    const id = dialog.card.id;
    if (dialog.kind === 'plan') {
      act.mutate({ id, path: '/plan', body: { plannedFor: new Date(value).toISOString() } });
    } else if (dialog.kind === 'hold') {
      act.mutate({ id, path: '/hold', body: { reason: value.trim() } });
    } else {
      act.mutate({ id, path: '/assign', body: { assigneeId: value } });
    }
  };

  if (isPending) return <div className="page"><LoadingState label="Gathering what needs deciding" lines={4} /></div>;
  if (error) return <div className="page"><ErrorState error={error} onRetry={() => void refetch()} /></div>;

  if (data.empty === 'notAManager') {
    return (
      <div className="page">
        <EmptyState
          icon="list"
          title="This queue is for department managers"
          hint="It holds the tickets nobody is working on yet. Your own work is on the board."
        />
      </div>
    );
  }

  const waiting = data.groups.reduce((n, g) => n + g.cards.length, 0);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Decisions</h1>
          <p className="pagehead__sub">
            {waiting === 0
              ? 'Nothing is waiting on you. Everything raised has somebody on it.'
              : `${waiting} ticket${waiting === 1 ? '' : 's'} with nobody on ${waiting === 1 ? 'it' : 'them'}.`}
          </p>
        </div>
        {data.departments.length > 1 ? (
          <select className="input" value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
            <option value="">All my departments</option>
            {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
      </header>

      {data.groups.map((group) => {
        const g = GROUP[group.key];
        return (
          <section key={group.key} className="dgroup">
            <header className="dgroup__head">
              <span className="dgroup__title">
                <Icon name={g.icon} size={15} /> {g.title}
              </span>
              <span className="dgroup__hint">{g.hint}</span>
            </header>

            {group.cards.length === 0 ? (
              /* A shape where the rows would be, rather than a sentence saying
                 there are none. It reads as "this is a list and it is empty" at
                 a glance, and keeps the three containers a similar height while
                 a manager scans down them. */
              <div className="dskeleton" aria-label={`No tickets in ${g.title}`}>
                {[0, 1].map((i) => (
                  <div key={i} className="dskeleton__row" aria-hidden="true">
                    <span className="dskeleton__bar dskeleton__bar--title" />
                    <span className="dskeleton__bar dskeleton__bar--meta" />
                  </div>
                ))}
                <p className="dskeleton__note">{g.empty}</p>
              </div>
            ) : (
              <ul className="drows">
                {group.cards.map((c) => (
                  <li key={c.id} className="drow">
                    <Link to={`/tasks/${c.id}`} className="drow__main">
                      <span className="drow__top">
                        <span className="mono drow__ref">{c.reference}</span>
                        {c.priority === 'URGENT' || c.priority === 'HIGH' ? (
                          <Badge tone={PRIORITY_TONE[c.priority]}>{c.priority.toLowerCase()}</Badge>
                        ) : null}
                        {c.fastTrack ? (
                          <span className="drow__flag" title="Fast-tracked — skips review">
                            <Icon name="sparkles" size={11} /> fast
                          </span>
                        ) : null}
                      </span>
                      <span className="drow__title">{c.title}</span>
                      <span className="drow__meta">
                        {c.requesterName}
                        {c.requesterDepartmentName ? ` · ${c.requesterDepartmentName}` : ''}
                        {' · raised '}{formatDate(c.createdAt)}
                        {/* The date is the whole point of a planned ticket, and
                            the reason is the whole point of a held one. Each
                            group shows the one that matters to it. */}
                        {group.key === 'PLANNING' && c.plannedFor
                          ? ` · planned ${formatDate(c.plannedFor)}` : ''}
                      </span>
                    </Link>

                    <span className="drow__actions">
                      <button type="button" className="btn btn--ghost btn--sm"
                              onClick={() => { setDialog({ kind: 'assign', card: c }); setValue(''); }}>
                        <Icon name="user" size={14} /> Assign
                      </button>
                      {group.key !== 'PLANNING' ? (
                        <button type="button" className="btn btn--ghost btn--sm"
                                onClick={() => { setDialog({ kind: 'plan', card: c }); setValue(''); }}>
                          <Icon name="calendar" size={14} /> Plan
                        </button>
                      ) : null}
                      {group.key !== 'ON_HOLD' ? (
                        <button type="button" className="btn btn--ghost btn--sm"
                                onClick={() => { setDialog({ kind: 'hold', card: c }); setValue(''); }}>
                          <Icon name="clock" size={14} /> Hold
                        </button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {dialog ? (
        <div className="modal" role="dialog" aria-modal="true">
          <button type="button" className="modal__scrim" onClick={() => setDialog(null)} aria-label="Close" />
          <div className="modal__panel">
            <header className="modal__head">
              <h2 className="modal__title">
                {dialog.kind === 'plan' ? 'When should this be worked on?'
                  : dialog.kind === 'hold' ? 'Why is it on hold?'
                    : 'Who should do this?'}
              </h2>
            </header>

            <div className="modal__body">
              <p className="modal__sub mono">{dialog.card.reference} — {dialog.card.title}</p>

              {dialog.kind === 'plan' ? (
                <>
                  <input className="input" type="datetime-local" value={value}
                         min={localNow()} onChange={(e) => setValue(e.target.value)} autoFocus />
                  <p className="hint">
                    A date, not a person. Whoever is free on the day picks it up —
                    naming somebody a fortnight early usually means reassigning
                    them when the fortnight arrives.
                  </p>
                </>
              ) : dialog.kind === 'hold' ? (
                <>
                  <textarea className="input" rows={3} value={value} autoFocus
                            onChange={(e) => setValue(e.target.value)}
                            placeholder="Waiting on the supplier to confirm stock…" />
                  <p className="hint">
                    Whoever raised it is told, with your reason. A ticket on hold
                    with no sentence is one nobody can explain later.
                  </p>
                </>
              ) : (
                <>
                  <select className="input" value={value} autoFocus
                          onChange={(e) => setValue(e.target.value)}>
                    <option value="">Choose somebody…</option>
                    {(people ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}{u.jobTitle ? ` — ${u.jobTitle}` : ''}{u.isManager ? ' (manager)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="hint">
                    You are on the list — a manager can take a ticket themselves.
                    They are emailed either way.
                  </p>
                </>
              )}
            </div>

            <footer className="modal__foot">
              <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary"
                      disabled={!value.trim() || act.isPending} onClick={submit}>
                {act.isPending ? 'Saving…' : 'Do it'}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}