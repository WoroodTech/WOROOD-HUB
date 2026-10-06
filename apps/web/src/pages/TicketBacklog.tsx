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
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { Badge } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';
import { PRIORITY_TONE, NewTicketButton } from './Tasks';
import { localNow } from './TaskDetail';

interface BacklogResponse {
  empty: 'notAManager' | null;
  departments: Array<{ id: string; name: string }>;
  groups: Array<{ key: 'NEW' | 'PLANNING' | 'ON_HOLD' | 'CANCELLED'; cards: BoardCard[] }>;
}

/* The four states a ticket rests in before anybody is working on it, and what
   a manager can do to each. The actions differ by section because the decision
   differs: a new ticket needs a decision, a planned one needs starting, a held
   one needs reviving or re-dating, a cancelled one needs reviving or nothing.

   Assign is not among them. Choosing who does the work happens when the work
   starts, not when it is scheduled -- naming somebody for next Tuesday only
   means reassigning them on Tuesday. */
const GROUP = {
  NEW: {
    title: 'New tickets',
    hint: 'Nobody has looked at these yet. Plan one, park it, or cancel it.',
    icon: 'bell',
    actions: ['plan', 'hold', 'cancel'] as const,
    empty: 'Nothing new has come in.',
  },
  PLANNING: {
    title: 'Planning',
    hint: 'A date, no person yet. Starting one is where you choose who does it.',
    icon: 'calendar',
    actions: ['start', 'cancel'] as const,
    empty: 'Nothing is scheduled.',
  },
  ON_HOLD: {
    title: 'On hold',
    hint: 'Parked with a reason. Resume puts it straight into progress.',
    icon: 'clock',
    actions: ['plan', 'resume', 'cancel'] as const,
    empty: 'Nothing is parked.',
  },
  CANCELLED: {
    title: 'Cancelled',
    hint: 'Dropped in the last month. Planning one brings it back.',
    icon: 'minus',
    actions: ['plan'] as const,
    empty: 'Nothing has been cancelled this month.',
  },
} as const;

const ACTION_LABEL = {
  plan: { label: 'Plan', icon: 'calendar' },
  hold: { label: 'Hold', icon: 'clock' },
  cancel: { label: 'Cancel', icon: 'minus' },
  start: { label: 'Start', icon: 'right' },
  resume: { label: 'Resume', icon: 'refresh' },
} as const;

type Dialog =
  | null
  | { kind: 'plan'; card: BoardCard }
  | { kind: 'hold'; card: BoardCard }
  | { kind: 'cancel'; card: BoardCard }
  /* Starting asks two things at once -- who, and by when -- because they are
     one decision. Picking somebody without a date leaves a commitment nobody
     made; picking a date without somebody leaves it on nobody. */
  | { kind: 'start'; card: BoardCard };

export function TicketBacklog() {
  const [departmentId, setDepartmentId] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [value, setValue] = useState('');
  const toast = useToast();
  const queryClient = useQueryClient();

  /* Which reading of the department filter applies.
  
     An administrator is asking "what did that department ask for"; a manager is
     asking "what did that department ask of us". Same control, two questions,
     so the label has to say which -- an unlabelled filter that quietly means
     something else to the person beside you is worse than no filter. */
  const { can } = useAuth();
  const oversees = can('tasks.item.manage-any') || can('tasks.item.view-any');

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['tasks', 'backlog', departmentId],
    queryFn: () => api<BacklogResponse>(
      `/tasks/backlog${departmentId ? `?departmentId=${departmentId}` : ''}`),
    refetchInterval: 60_000,
  });

  const [due, setDue] = useState('');

  const { data: people } = useQuery({
    queryKey: ['tasks', 'people', dialog?.card.departmentId],
    queryFn: () => api<TaskPerson[]>(`/tasks/departments/${dialog!.card.departmentId}/people`),
    enabled: dialog?.kind === 'start',
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
    } else if (dialog.kind === 'cancel') {
      act.mutate({ id, path: '/cancel', body: { reason: value.trim() } });
    } else {
      /* One call carrying both. The date used to follow as a second request,
         which the API refused -- the date is the assignee's to set, and the
         manager is not the assignee -- and the refusal was swallowed, so the
         date picked here silently never existed. */
      act.mutate({ id, path: '/assign', body: {
        assigneeId: value,
        dueAt: due ? new Date(due).toISOString() : undefined,
      } });
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
          <h1 className="pagehead__title">Backlog</h1>
          <p className="pagehead__sub">
            {waiting === 0
              ? 'Nothing waiting. Everything raised has somebody on it.'
              : `${waiting} ticket${waiting === 1 ? '' : 's'} with nobody on ${waiting === 1 ? 'it' : 'them'}.`}
          </p>
        </div>
        <span className="pagehead__tools">
          <NewTicketButton />
        </span>
        {data.departments.length > 1 ? (
          <select className="input" value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)} aria-label={oversees ? 'Requested by' : 'Asked of us by'}
                  title={oversees
                    ? 'Everything the chosen department asked for, wherever it went'
                    : 'What the chosen department asked of yours'}>
            <option value="">{oversees ? 'Every department' : 'Everything we are doing'}</option>
            {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
      </header>

      {data.groups.map((group) => {
        const g = GROUP[group.key];
        return (
          <section key={group.key} className={`dgroup dgroup--${group.key}`}>
            <header className="dgroup__head">
              <span className="dgroup__title">
                <Icon name={g.icon} size={15} /> {g.title}
                {group.cards.length > 0 ? (
                  <span className="dgroup__n">{group.cards.length}</span>
                ) : null}
              </span>
              <span className="dgroup__hint">{g.hint}</span>
            </header>

            {group.cards.length === 0 ? (
              <p className="dgroup__empty">{g.empty}</p>
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
                      {g.actions.map((a) => {
                        const meta = ACTION_LABEL[a];
                        return (
                          <button
                            key={a} type="button" className="btn btn--ghost btn--sm"
                            disabled={act.isPending}
                            onClick={() => {
                              /* Resume asks the same two questions as Start --
                                 who, and by when -- with whoever had it before
                                 the hold already chosen. Usually that is the
                                 answer; the dialog is there for when it is not. */
                              const startsWork = a === 'start' || a === 'resume';
                              setValue('');
                              setDue('');
                              setDialog({ kind: startsWork ? 'start' : a, card: c } as Dialog);
                            }}
                          >
                            <Icon name={meta.icon} size={14} /> {meta.label}
                          </button>
                        );
                      })}
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
                    : dialog.kind === 'cancel' ? 'Why is it being cancelled?'
                      : dialog.card.status === 'ON_HOLD'
                        ? 'Who picks it back up, and by when?'
                        : 'Who starts it, and by when?'}
              </h2>
            </header>

            <div className="modal__body">
              <p className="modal__sub mono">{dialog.card.reference} — {dialog.card.title}</p>

              {dialog.kind === 'plan' ? (
                <>
                  <input className="input" type="datetime-local" value={value}
                         min={localNow()} onChange={(e) => setValue(e.target.value)} autoFocus />
                  <p className="hint">
                    A date, not a person. Who does it is decided when it starts —
                    naming somebody for next Tuesday usually means reassigning
                    them on Tuesday.
                  </p>
                </>
              ) : dialog.kind === 'hold' ? (
                <>
                  <textarea className="input" rows={3} value={value} autoFocus
                            onChange={(e) => setValue(e.target.value)}
                            placeholder="Waiting on the supplier to confirm stock…" />
                  <p className="hint">
                    Whoever raised it is told, with your reason. The reason shows
                    on the ticket's history, so anybody can see it later.
                  </p>
                </>
              ) : dialog.kind === 'cancel' ? (
                <>
                  <textarea className="input" rows={3} value={value} autoFocus
                            onChange={(e) => setValue(e.target.value)}
                            placeholder="The campaign was dropped…" />
                  <p className="hint">
                    It stays in Cancelled for a month, and can be planned back
                    into life from there. The reason stays on the record.
                  </p>
                </>
              ) : (
                <>
                  <div className="field field--wide">
                    <span className="field__label">Who does it</span>
                    <select className="input" value={value} autoFocus
                            onChange={(e) => setValue(e.target.value)}>
                      <option value="">Choose somebody…</option>
                      {(people ?? []).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}{u.jobTitle ? ` — ${u.jobTitle}` : ''}{u.isManager ? ' (manager)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field field--wide">
                    <span className="field__label">Due by (optional)</span>
                    <input className="input" type="datetime-local" value={due}
                           min={localNow()} onChange={(e) => setDue(e.target.value)} />
                  </div>
                  <p className="hint">
                    Work starts the moment you choose somebody, and they are
                    emailed. Leave the date blank and they will set their own.
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