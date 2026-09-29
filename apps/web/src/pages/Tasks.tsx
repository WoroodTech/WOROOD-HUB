/**
 * Tickets, three questions deep.
 *
 * The tabs are not filters over one list — they are three different questions,
 * and an employee arrives with one of them in mind. "Assigned to me" is what
 * you owe; "My requests" is what you are owed; "Awaiting assignment" is what
 * your department owes somebody and nobody has picked up yet. A manager sees
 * the queue first, because a ticket with nobody on it is the only kind the
 * requester cannot chase.
 *
 * Nothing here decides who may see what. The server returns what this employee
 * is allowed, and a ticket they are not on never reaches the browser — the
 * absence is the gate, exactly as it is for portlets.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  TaskDepartmentOption, TaskDetail, TaskListResponse,
  TaskPriority, TaskSummary,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';

type Scope = 'assigned' | 'requested' | 'contributing' | 'queue' | 'department' | 'all';

export const STATUS_LABEL: Record<string, string> = {
  NEW: 'Awaiting assignment', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked', RESOLVED: 'Resolved', CLOSED: 'Closed',
  REJECTED: 'Not accepted', CANCELLED: 'Cancelled',
};

export const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warning' | 'critical' | 'info' | 'accent'> = {
  NEW: 'warning', ASSIGNED: 'info', IN_PROGRESS: 'accent', BLOCKED: 'critical',
  RESOLVED: 'good', CLOSED: 'neutral', REJECTED: 'neutral', CANCELLED: 'neutral',
};

export const PRIORITY_TONE: Record<string, 'neutral' | 'warning' | 'critical'> = {
  LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warning', URGENT: 'critical',
};

/** Overdue sits BESIDE the status, never instead of it. "In progress and late"
 *  is a different fact from "late", and the second one hides the first. */
export function TaskStatusBadges({ task }: { task: TaskSummary }) {
  return (
    <>
      <Badge tone={STATUS_TONE[task.status] ?? 'neutral'}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
      {task.slaState === 'OVERDUE' ? (
        <Badge tone="critical" icon="warning"
          title={task.status === 'BLOCKED'
            ? 'Past its date, and waiting on another department.'
            : 'Past the date the assignee committed to.'}>
          {task.status === 'BLOCKED' ? 'Late — waiting' : 'Late'}
        </Badge>
      ) : null}
      {task.slaState === 'DUE_SOON' ? <Badge tone="warning" icon="clock">Due soon</Badge> : null}
      {task.priority === 'HIGH' || task.priority === 'URGENT'
        ? <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority === 'URGENT' ? 'Urgent' : 'High'}</Badge>
        : null}
    </>
  );
}

export function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <Link className={`taskrow${task.slaState === 'OVERDUE' ? ' taskrow--late' : ''}`} to={`/tasks/${task.id}`}>
      <span className="taskrow__ref">{task.reference}</span>
      <span className="taskrow__main">
        <span className="taskrow__title">{task.title}</span>
        <span className="taskrow__meta">
          {task.department}
          {' · '}
          {task.assigneeName ? `with ${task.assigneeName}` : 'nobody yet'}
          {' · raised by '}{task.requesterName}
          {task.dueAt ? ` · due ${formatDate(task.dueAt)}` : ''}
          {task.openBlockerCount > 0 ? ` · waiting on ${task.openBlockerCount}` : ''}
        </span>
      </span>
      <span className="taskrow__side"><TaskStatusBadges task={task} /></span>
      <Icon name="right" size={15} />
    </Link>
  );
}

/* ------------------------------------------------------------------ page -- */

export function Tasks({ fixedScope }: { fixedScope?: Scope }) {
  const { principal } = useAuth();
  const [scope, setScope] = useState<Scope>(fixedScope ?? 'assigned');
  /* Everything, not just what is open.
     Filtering finished work out by default is how a ticket somebody closed an
     hour ago becomes unfindable: the person who raised it, the person who did
     it and the manager all go looking for it and it is simply not on screen.
     They still have access -- being on a ticket never expires -- so the answer
     is to show it, and to sink it below the live work rather than hide it. */
  const [status, setStatus] = useState<'open' | 'closed' | ''>('');
  const [q, setQ] = useState('');
  const [composing, setComposing] = useState(false);

  const effective = fixedScope ?? scope;
  const params = useMemo(() => {
    const s = new URLSearchParams({ scope: effective, pageSize: '50' });
    if (status) s.set('status', status);
    if (q.trim()) s.set('q', q.trim());
    return s.toString();
  }, [effective, status, q]);

  const list = useQuery({
    queryKey: qk.tasks(params),
    queryFn: () => api<TaskListResponse>(`/tasks?${params}`),
  });

  const counts = list.data?.counts;
  const managesSomething = (principal?.managedDepartmentIds?.length ?? 0) > 0;

  const TABS: Array<[Scope, string, number | undefined]> = [
    ...(managesSomething ? ([['queue', 'Awaiting assignment', counts?.queue]] as Array<[Scope, string, number | undefined]>) : []),
    ['assigned', 'Assigned to me', counts?.assigned],
    ['requested', 'My requests', counts?.requested],
    ['contributing', "I'm on it", undefined],
    ...(managesSomething ? ([['department', 'My department', undefined]] as Array<[Scope, string, number | undefined]>) : []),
  ];

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">
            {fixedScope === 'queue' ? 'Department queue'
              : fixedScope === 'all' ? 'All tickets' : 'Tasks & tickets'}
          </h1>
          <p className="pagehead__sub">
            {fixedScope === 'queue'
              ? 'Raised to a department you run and waiting for somebody to be put on it. Assigning is the only thing that moves a ticket out of here.'
              : fixedScope === 'all'
                ? 'Every ticket in the company, read-only. This view exists to answer "where is it", not to act.'
                : 'Ask a colleague or another department for something, and see what has been asked of you. A ticket is private to the people on it.'}
          </p>
        </div>
        <div className="pagehead__tools">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setComposing(true)}>
            <Icon name="plus" size={15} /> <span className="btn__label">New ticket</span>
          </button>
        </div>
      </header>

      {/* Gone once you are looking at them: the banner exists to point you at
          a tab you are not on, and a prompt that survives being followed reads
          as a fault. It returns on a later visit if they are still unanswered,
          which is correct -- they still are. */}
      {counts && counts.awaitingMe > 0 && !fixedScope && scope !== 'requested' ? (
        <div className="banner banner--ok">
          <Icon name="check" size={16} />
          <span>
            {counts.awaitingMe === 1 ? 'One ticket you raised has been' : `${counts.awaitingMe} tickets you raised have been`} resolved
            and {counts.awaitingMe === 1 ? 'is' : 'are'} waiting for you to accept or send back.
            <button type="button" className="link" onClick={() => { setScope('requested'); setStatus('open'); }}>
              Show them
            </button>
          </span>
        </div>
      ) : null}

      {!fixedScope ? (
        <div className="switchrow">
          <div className="switch" role="group" aria-label="Which tickets">
            {TABS.map(([key, label, count]) => (
              <button
                key={key} type="button" aria-pressed={scope === key}
                className={`switch__btn${scope === key ? ' is-on' : ''}`}
                onClick={() => setScope(key)}
              >
                {label}
                {count ? <span className="switch__count">{count}</span> : null}
              </button>
            ))}
          </div>
          <div className="switch" role="group" aria-label="Open or closed">
            {([['', 'Everything'], ['open', 'Open'], ['closed', 'Finished']] as const).map(([key, label]) => (
              <button
                key={key || 'any'} type="button" aria-pressed={status === key}
                className={`switch__btn${status === key ? ' is-on' : ''}`}
                onClick={() => setStatus(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="tasksearch">
        <Icon name="search" size={15} />
        <input
          className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search by title or reference, e.g. TK-1042"
          aria-label="Search tickets"
        />
      </div>

      <Card
        title={fixedScope === 'queue' ? 'Waiting for you to assign' : 'Tickets'}
        subtitle={list.data ? `${list.data.total} matching` : undefined}
      >
        {list.isPending ? <LoadingState lines={6} /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
        {list.data && list.data.items.length === 0 ? (
          <EmptyState
            icon="check"
            title={fixedScope === 'queue' ? 'Nothing waiting' : 'Nothing here'}
            hint={fixedScope === 'queue'
              ? 'Every ticket raised to your department has somebody on it.'
              : 'Raise one when you need something from a colleague or another department.'}
          />
        ) : null}
        {list.data && list.data.items.length > 0 ? (
          <div className="tasklist">
            {list.data.items.map((t) => <TaskRow key={t.id} task={t} />)}
          </div>
        ) : null}
      </Card>

      {composing ? <NewTicket onClose={() => setComposing(false)} /> : null}
    </div>
  );
}

/* --------------------------------------------------------------- compose -- */

function NewTicket({ onClose }: { onClose: () => void }) {
  const { principal } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const departments = useQuery({
    queryKey: qk.taskDepartments,
    queryFn: () => api<TaskDepartmentOption[]>('/tasks/departments'),
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('NORMAL');
  const [departmentId, setDepartmentId] = useState('');
  const [forMyself, setForMyself] = useState(false);

  const mine = departments.data?.find((d) => d.isMine);
  const target = forMyself ? mine?.id : (departmentId || principal?.departmentId || '');

  const create = useMutation({
    mutationFn: () => api<TaskDetail>('/tasks', {
      method: 'POST',
      body: {
        title, description: description || undefined, priority,
        departmentId: target || undefined,
        assignToSelf: forMyself ? principal?.id : undefined,
      },
    }),
    onSuccess: (t) => {
      toast.push(forMyself
        ? `${t.reference} is on your own list.`
        : `${t.reference} is with ${t.department}. Their manager will put somebody on it.`, 'good');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['portlet'] });
      onClose();
      navigate(`/tasks/${t.id}`);
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not raise it.', 'warning'),
  });

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="New ticket">
      <button type="button" className="modal__scrim" onClick={onClose} aria-label="Close" />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">New ticket</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={16} />
          </button>
        </header>

        <div className="modal__body">
          <label className="field field--wide">
            <span className="field__label">What do you need?</span>
            <input className="input" value={title} maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Replace the fridge thermostat in the cold room" />
          </label>

          <label className="field field--wide">
            <span className="field__label">Detail <span className="field__opt">optional</span></span>
            <textarea className="input" rows={4} value={description} maxLength={8000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything the person picking this up would otherwise have to come and ask you." />
          </label>

          <label className="checkline">
            <input type="checkbox" checked={forMyself} onChange={(e) => setForMyself(e.target.checked)} />
            <span>
              <strong>This one is for me.</strong>
              <span className="hint"> It goes straight onto your own list instead of your manager's queue.
                Your manager can still see it and hand it to somebody else.</span>
            </span>
          </label>

          {!forMyself ? (
            <label className="field field--wide">
              <span className="field__label">Which department?</span>
              <select className="input" value={departmentId || principal?.departmentId || ''}
                onChange={(e) => setDepartmentId(e.target.value)}>
                {(departments.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.isMine ? ' — yours' : ''}
                  </option>
                ))}
              </select>
              <span className="hint">
                Their manager decides who works on it. Only they, the person they pick and anybody
                they bring in will see this ticket.
              </span>
            </label>
          ) : null}

          <div className="field">
            <span className="field__label">How urgent?</span>
            <div className="switch">
              {(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as TaskPriority[]).map((p) => (
                <button key={p} type="button" aria-pressed={priority === p}
                  className={`switch__btn${priority === p ? ' is-on' : ''}`}
                  onClick={() => setPriority(p)}>
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            <span className="hint">
              Urgency is yours to state. The date is theirs to commit to — they set it when they pick it up.
            </span>
          </div>
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary"
            disabled={title.trim().length < 3 || create.isPending}
            onClick={() => create.mutate()}>
            {create.isPending ? 'Sending…' : 'Raise it'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function TaskQueue() { return <Tasks fixedScope="queue" />; }
export function AllTasks() { return <Tasks fixedScope="all" />; }
