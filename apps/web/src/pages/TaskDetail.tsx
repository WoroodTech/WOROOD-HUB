/**
 * One ticket.
 *
 * Which buttons appear is not decided here. The server returns capability
 * flags on every response and this screen honours them; re-deriving "am I the
 * assignee, or do I manage this department, and is the status right for it" in
 * the browser is how the two answers drift apart. The API refuses the call
 * independently, so a hidden button is a courtesy and the guard is the rule.
 *
 * The dependency strip is the one piece of interface that exists purely to
 * answer a question somebody would otherwise have to ask a human: "why has
 * this not moved?" It names the department and the age, and nothing else,
 * because the blocking ticket is another department's work and its title and
 * conversation are not the requester's to read.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  TaskDepartmentOption, TaskDetail as TaskDetailPayload, TaskDependency,
  TaskPerson, TaskPriority,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate, formatDateTime, formatTime } from '../lib/format';
import { STATUS_LABEL, TaskStatusBadges } from './Tasks';

/** `YYYY-MM-DDTHH:mm` in the browser's own zone, which is what a
 *  datetime-local input compares against. Rounded up to the next minute so the
 *  current minute does not become unselectable halfway through it. */
function localNow(): string {
  const d = new Date(Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ROLE_LABEL: Record<string, string> = {
  REQUESTER: 'Raised it', ASSIGNEE: 'Working on it', CONTRIBUTOR: 'Helping',
  PAST_ASSIGNEE: 'Worked on it before', OBSERVER: 'Redirected it',
};

const EVENT_SENTENCE: Record<string, (p: any) => string> = {
  CREATED: (p) => p.selfAssigned ? 'raised it for themselves' : 'raised it',
  REQUEST_EDITED: () => 'edited the request',
  ASSIGNED: (p) => `put ${p.assigneeName ?? 'somebody'} on it`,
  REASSIGNED: (p) => `moved it to ${p.assigneeName ?? 'somebody else'}`,
  TRANSFERRED: (p) => `sent it to another department — ${p.reason ?? ''}`,
  REJECTED: (p) => `did not accept it — ${p.reason ?? ''}`,
  CANCELLED: (p) => `cancelled it — ${p.reason ?? ''}`,
  STARTED: () => 'started work',
  DUE_SET: (p) => p.dueAt ? `committed to ${formatDate(p.dueAt)}` : 'removed the date',
  COMMENTED: () => 'commented',
  CONTRIBUTOR_ADDED: (p) => `brought in ${p.name ?? 'a colleague'}`,
  CONTRIBUTOR_REMOVED: () => 'removed a contributor',
  DEPENDENCY_ADDED: (p) => `asked another department for something (${p.childReference ?? ''})`,
  DEPENDENCY_RELEASED: () => 'dropped a dependency',
  BLOCKED: (p) => `blocked, waiting on ${p.childReference ?? 'another ticket'}`,
  UNBLOCKED: (p) => p.childStatus && p.childStatus !== 'CLOSED'
    ? `unblocked — ${p.childReference} was ${String(p.childStatus).toLowerCase()}`
    : 'unblocked, the work it waited on is done',
  RESOLVED: (p) => `resolved it — ${p.resolution ?? ''}`,
  RESOLUTION_REJECTED: (p) => `sent it back — ${p.reason ?? ''}`,
  CLOSED: () => 'accepted the resolution and closed it',
  REOPENED: (p) => `reopened it — ${p.reason ?? ''}`,
  OVERDUE: () => 'passed its date',
  DUE_SOON: () => 'is due within a day',
  ESCALATED: (p) => `had nobody on it after ${p.hours ?? 24} hours`,
};

type Dialog =
  | null
  | { kind: 'assign' }
  | { kind: 'transfer' }
  | { kind: 'dependency' }
  | { kind: 'contributor' }
  | { kind: 'due' }
  | { kind: 'reason'; action: string; heading: string; verb: string; hint?: string };

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [comment, setComment] = useState('');

  const task = useQuery({
    queryKey: qk.task(id),
    queryFn: () => api<TaskDetailPayload>(`/tasks/${id}`),
    enabled: !!id,
  });

  const act = useMutation({
    mutationFn: ({ path, body, method = 'POST' }: { path: string; body?: unknown; method?: string }) =>
      api<TaskDetailPayload>(`/tasks/${id}${path}`, { method, body }),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.task(id), updated);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['portlet'] });
      setDialog(null);
      setComment('');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'That did not go through.', 'warning'),
  });

  if (task.isPending) return <div className="page"><LoadingState lines={8} /></div>;
  if (task.error) return <div className="page"><ErrorState error={task.error} onRetry={() => void task.refetch()} /></div>;
  const t = task.data!;
  const a = t.access;
  const blocking = t.blockedBy.filter((d) => !d.releasedAt);

  return (
    <div className="page">
      <header className="pagehead pagehead--stack">
        <div>
          <p className="pagehead__meta">
            <Link className="link" to="/tasks">Tasks &amp; tickets</Link>
            {' · '}<span className="taskref">{t.reference}</span>
          </p>
          <h1 className="pagehead__title">{t.title}</h1>
          <p className="pagehead__sub">
            {t.requesterName}{t.requesterDepartment ? ` (${t.requesterDepartment})` : ''}
            {' '}asked {t.department} on {formatDate(t.createdAt)}
            {t.assigneeName ? ` · ${t.assigneeName} is on it` : ' · nobody on it yet'}
            {t.dueAt ? ` · due ${formatDate(t.dueAt)}` : ''}
            {t.reopenedCount > 0 ? ` · reopened ${t.reopenedCount}×` : ''}
          </p>
          <p className="taskbadges"><TaskStatusBadges task={t} /></p>
        </div>
      </header>

      {blocking.length > 0 ? <BlockedStrip deps={blocking} /> : null}

      {/* Managers of the asking department are here to keep track of what
          their own people have requested, not to run somebody else's queue.
          Saying so removes the obvious question about the missing buttons. */}
      {a.managesRequestingDepartment && !a.managesDepartment && !a.isRequester && !a.isAssignee ? (
        <div className="banner banner--quiet">
          <Icon name="info" size={16} />
          <span>
            You can see this because it was raised by {t.requesterDepartment}, which you run.
            {' '}{t.department} decides who works on it and when.
          </span>
        </div>
      ) : null}

      {t.status === 'RESOLVED' ? (
        <div className={`banner ${a.canConfirmResolution ? 'banner--ok' : 'banner--quiet'}`}>
          <Icon name="check" size={16} />
          <span>
            <strong>Resolved.</strong> {t.statusReason}
            {a.canConfirmResolution
              ? ' Accept it to close, or send it back if it is not done.'
              : ' Waiting for the person who raised it to accept or send it back.'}
          </span>
        </div>
      ) : null}

      {(t.status === 'REJECTED' || t.status === 'CANCELLED') && t.statusReason ? (
        <div className="banner banner--quiet">
          <Icon name="info" size={16} />
          <span><strong>{STATUS_LABEL[t.status]}.</strong> {t.statusReason}</span>
        </div>
      ) : null}

      <div className="taskcols">
        <div className="taskcols__main">
          <Card
            title="The request"
            subtitle={a.canEditRequest
              ? 'You can still change this — once somebody is put on it, changes become comments.'
              : undefined}
          >
            {t.description
              ? <p className="taskdesc">{t.description}</p>
              : <p className="hint">No detail was given beyond the title.</p>}
          </Card>

          <Card title="What has happened" subtitle={`${t.comments.length} comment${t.comments.length === 1 ? '' : 's'}`}>
            <Timeline task={t} />
            {a.canComment ? (
              <div className="commentbox">
                <textarea
                  className="input" rows={3} value={comment} maxLength={8000}
                  placeholder="Add something the others on this ticket should know"
                  onChange={(e) => setComment(e.target.value)}
                />
                <button type="button" className="btn btn--primary btn--sm"
                  disabled={!comment.trim() || act.isPending}
                  onClick={() => act.mutate({ path: '/comments', body: { body: comment.trim() } })}>
                  Comment
                </button>
              </div>
            ) : (
              <p className="hint">
                You can read this ticket but not add to it.
              </p>
            )}
          </Card>
        </div>

        <aside className="taskcols__side">
          <Card title="What you can do">
            <div className="taskactions">
              {a.canAssign ? (
                <button type="button" className="btn btn--primary btn--block" onClick={() => setDialog({ kind: 'assign' })}>
                  <Icon name="users" size={15} /> {t.assigneeId ? 'Move it to somebody else' : 'Assign it'}
                </button>
              ) : null}
              {a.canWork && t.status === 'ASSIGNED' ? (
                <button type="button" className="btn btn--primary btn--block"
                  onClick={() => act.mutate({ path: '/start' })}>
                  <Icon name="check" size={15} /> Start work
                </button>
              ) : null}
              {a.canWork ? (
                <button type="button" className="btn btn--ghost btn--block" onClick={() => setDialog({ kind: 'due' })}>
                  <Icon name="calendar" size={15} /> {t.dueAt ? 'Change the date' : 'Commit to a date'}
                </button>
              ) : null}
              {a.canResolve ? (
                <button type="button" className="btn btn--ghost btn--block"
                  onClick={() => setDialog({
                    kind: 'reason', action: '/resolve', heading: 'Mark it resolved', verb: 'Resolve',
                    hint: 'Say what you did. The person who raised it accepts or sends it back.',
                  })}>
                  <Icon name="check" size={15} /> Mark resolved
                </button>
              ) : null}
              {/* Wider than the rest of the assignee's controls: a manager
                  often knows before the assignee does that another department
                  has to be involved. */}
              {a.canAddDependency ? (
                <button type="button" className="btn btn--ghost btn--block" onClick={() => setDialog({ kind: 'dependency' })}>
                  <Icon name="right" size={15} /> Need another department
                </button>
              ) : null}
              {a.canConfirmResolution ? (
                <>
                  <button type="button" className="btn btn--primary btn--block"
                    onClick={() => act.mutate({ path: '/confirm' })}>
                    <Icon name="check" size={15} /> Accept and close
                  </button>
                  <button type="button" className="btn btn--ghost btn--block"
                    onClick={() => setDialog({
                      kind: 'reason', action: '/reject-resolution', heading: 'Send it back', verb: 'Send back',
                      hint: 'Say what is still missing. It goes back to the same person.',
                    })}>
                    <Icon name="left" size={15} /> Not done yet
                  </button>
                </>
              ) : null}
              {a.canManageContributors ? (
                <button type="button" className="btn btn--ghost btn--block" onClick={() => setDialog({ kind: 'contributor' })}>
                  <Icon name="plus" size={15} /> Bring in a colleague
                </button>
              ) : null}
              {a.canTransfer ? (
                <button type="button" className="btn btn--ghost btn--block" onClick={() => setDialog({ kind: 'transfer' })}>
                  <Icon name="refresh" size={15} /> Wrong department
                </button>
              ) : null}
              {a.canReject ? (
                <button type="button" className="btn btn--ghost btn--block"
                  onClick={() => setDialog({
                    kind: 'reason', action: '/reject', heading: 'Refuse this ticket', verb: 'Refuse',
                    hint: 'The person who raised it is told, with your reason.',
                  })}>
                  <Icon name="minus" size={15} /> Not for us
                </button>
              ) : null}
              {a.canReopen ? (
                <button type="button" className="btn btn--ghost btn--block"
                  onClick={() => setDialog({
                    kind: 'reason', action: '/reopen', heading: 'Reopen it', verb: 'Reopen',
                    hint: 'Say what came back. It returns to whoever had it.',
                  })}>
                  <Icon name="refresh" size={15} /> Reopen
                </button>
              ) : null}
              {a.canCancel ? (
                <button type="button" className="btn btn--danger btn--block"
                  onClick={() => setDialog({
                    kind: 'reason', action: '/cancel', heading: 'Cancel this ticket', verb: 'Cancel it',
                    hint: 'Everyone on it is told. Anything you asked another department for is not cancelled with it — they are asked to decide.',
                  })}>
                  <Icon name="minus" size={15} /> Cancel it
                </button>
              ) : null}
              {!a.canAssign && !a.canWork && !a.canAddDependency && !a.canConfirmResolution && !a.canCancel && !a.canReopen ? (
                <p className="hint">Nothing to do from here — you are on this ticket to follow it.</p>
              ) : null}
            </div>
          </Card>

          <Card title="Who is on it" subtitle="Nobody else in the department can see this ticket">
            <ul className="peoplelist">
              {t.participants.map((p) => (
                <li key={`${p.userId}-${p.role}`} className="peoplelist__row">
                  <span className="peoplelist__name">{p.name}</span>
                  <span className="peoplelist__meta">{p.jobTitle}</span>
                  <Badge tone={p.role === 'ASSIGNEE' ? 'accent' : 'neutral'}>{ROLE_LABEL[p.role] ?? p.role}</Badge>
                  {a.canManageContributors && p.role === 'CONTRIBUTOR' ? (
                    <button type="button" className="iconbtn iconbtn--xs iconbtn--danger" aria-label={`Remove ${p.name}`}
                      onClick={() => act.mutate({ path: `/contributors/${p.userId}`, method: 'DELETE' })}>
                      <Icon name="minus" size={13} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>

          {/* What we asked OTHER departments for. This read `t.blocking` --
              the tickets this one is holding up -- which is the opposite list,
              and on a blocked ticket it is empty. The effect was that the
              person waiting had no route to the thing they were waiting on:
              the banner named the department and stopped there. */}
          {t.blockedBy.length > 0 ? (
            <Card title="Asked of other departments"
                  subtitle="Raised for this ticket. It moves again when they come back.">
              <ul className="deplist">
                {t.blockedBy.map((d) => <DependencyRow key={d.linkId} dep={d} />)}
              </ul>
            </Card>
          ) : null}

          {t.blocking.length > 0 ? (
            <Card title="This is holding something up"
                  subtitle="Another ticket is waiting on this one">
              <ul className="deplist">
                {t.blocking.map((d) => <DependencyRow key={d.linkId} dep={d} />)}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>

      {dialog ? (
        <TaskDialog
          dialog={dialog} task={t}
          busy={act.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(path, body) => act.mutate({ path, body })}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ dependency -- */

function BlockedStrip({ deps }: { deps: TaskDependency[] }) {
  /* A department saying "done" is not the same as the work being accepted, so
     a resolved dependency does not release the block on its own -- the person
     who asked for it still has to agree it is what they needed. That is
     correct, and it is useless unless the screen says so and takes them
     there: this banner used to name the department and stop, leaving somebody
     looking at a blocked ticket with nothing to click. */
  const answered = deps.filter((d) => d.status === 'RESOLVED' && d.readable);

  return (
    <div className={`banner ${answered.length > 0 ? 'banner--ok' : 'banner--stale'}`}>
      <Icon name={answered.length > 0 ? 'check' : 'clock'} size={16} />
      <span>
        {answered.length > 0 ? (
          <>
            <strong>
              {answered.map((d) => d.department).join(' and ')} say it is done.
            </strong>{' '}
            Open{' '}
            {answered.map((d, i) => (
              <span key={d.linkId}>
                {i > 0 ? ' and ' : ''}
                <Link className="link" to={`/tasks/${d.itemId}`}>{d.reference}</Link>
              </span>
            ))}{' '}
            and accept it — this one carries on the moment you do. Send it back instead if it
            is not what you needed.
          </>
        ) : (
          <>
            <strong>Waiting on {deps.map((d) => d.department).join(' and ')}.</strong>{' '}
            {deps.map((d) => (
              <span key={d.linkId}>
                {d.readable
                  ? <Link className="link" to={`/tasks/${d.itemId}`}>{d.reference}</Link>
                  : d.reference}
                {' '}asked {formatDate(d.raisedAt)}, now{' '}
                {STATUS_LABEL[d.status]?.toLowerCase() ?? d.status}
                {d.dueAt ? `, expected ${formatDate(d.dueAt)}` : ''}.{' '}
              </span>
            ))}
            It moves again on its own as soon as that comes back.
          </>
        )}
      </span>
    </div>
  );
}

function DependencyRow({ dep }: { dep: TaskDependency }) {
  return (
    <li className="deplist__row">
      <span className="deplist__ref">
        {dep.readable ? <Link className="link" to={`/tasks/${dep.itemId}`}>{dep.reference}</Link> : dep.reference}
      </span>
      <span className="deplist__main">
        {/* Absent rather than blanked: an empty field invites the reader to
            wonder what was taken out. */}
        {dep.title ?? <em className="hint">Another department's ticket</em>}
        <span className="deplist__meta">
          {dep.department} · asked {formatDate(dep.raisedAt)}
          {dep.dueAt ? ` · expected ${formatDate(dep.dueAt)}` : ''}
        </span>
      </span>
      {dep.status === 'RESOLVED' && dep.readable && !dep.releasedAt
        ? <Badge tone="good" icon="check">Needs your nod</Badge>
        : <Badge tone={dep.releasedAt ? 'neutral' : 'warning'}>
            {STATUS_LABEL[dep.status] ?? dep.status}
          </Badge>}
    </li>
  );
}

/* -------------------------------------------------------------- timeline -- */

function Timeline({ task }: { task: TaskDetailPayload }) {
  /* Comments and events are one stream, because they are one story. An event
     list beside a comment list makes the reader reconstruct the order in their
     head, and they will get it wrong. */
  const entries = [
    ...task.events
      .filter((e) => e.type !== 'COMMENTED')
      .map((e) => ({
        at: e.createdAt, key: `e-${e.id}`, kind: 'event' as const,
        who: e.actorName ?? 'The system',
        text: (EVENT_SENTENCE[e.type] ?? (() => e.type.toLowerCase().replace(/_/g, ' ')))(e.payload ?? {}),
      })),
    ...task.comments.map((c) => ({
      at: c.createdAt, key: `c-${c.id}`, kind: 'comment' as const,
      who: c.authorName, text: c.body,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (entries.length === 0) return <EmptyState icon="clock" title="Nothing yet" />;

  return (
    <ol className="timeline">
      {entries.map((e) => (
        <li key={e.key} className={`timeline__row timeline__row--${e.kind}`}>
          <span className="timeline__dot" aria-hidden="true" />
          <div className="timeline__body">
            <p className="timeline__who">
              <strong>{e.who}</strong>
              <span className="timeline__when" title={formatDateTime(e.at)}>
                {formatDate(e.at)} {formatTime(e.at)}
              </span>
            </p>
            <p className="timeline__text">{e.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------------------------------------- dialogs -- */

function TaskDialog({ dialog, task, busy, onClose, onSubmit }: {
  dialog: NonNullable<Dialog>;
  task: TaskDetailPayload;
  busy: boolean;
  onClose: () => void;
  onSubmit: (path: string, body?: unknown) => void;
}) {
  const [text, setText] = useState('');
  const [choice, setChoice] = useState('');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('NORMAL');
  const [dueAt, setDueAt] = useState(task.dueAt ? task.dueAt.slice(0, 16) : '');

  const people = useQuery({
    queryKey: qk.taskPeople(task.departmentId),
    queryFn: () => api<TaskPerson[]>(`/tasks/departments/${task.departmentId}/people`),
    enabled: dialog.kind === 'assign' || dialog.kind === 'contributor',
  });

  const departments = useQuery({
    queryKey: qk.taskDepartments,
    queryFn: () => api<TaskDepartmentOption[]>('/tasks/departments'),
    enabled: dialog.kind === 'transfer' || dialog.kind === 'dependency',
  });

  const heading =
    dialog.kind === 'assign' ? 'Who should do this?'
      : dialog.kind === 'transfer' ? 'Send it to another department'
        : dialog.kind === 'dependency' ? 'Ask another department'
          : dialog.kind === 'contributor' ? 'Bring in a colleague'
            : dialog.kind === 'due' ? 'When will it be done?'
              : dialog.heading;

  const ready =
    dialog.kind === 'assign' || dialog.kind === 'contributor' ? !!choice
      : dialog.kind === 'transfer' ? !!choice && text.trim().length >= 3
        : dialog.kind === 'dependency' ? !!choice && title.trim().length >= 3
          : dialog.kind === 'due' ? true
            : text.trim().length >= 3;

  const submit = () => {
    if (dialog.kind === 'assign') onSubmit('/assign', { assigneeId: choice, note: text.trim() || undefined });
    else if (dialog.kind === 'contributor') onSubmit('/contributors', { userId: choice });
    else if (dialog.kind === 'transfer') onSubmit('/transfer', { departmentId: choice, reason: text.trim() });
    else if (dialog.kind === 'dependency') {
      onSubmit('/dependencies', {
        departmentId: choice, title: title.trim(),
        description: text.trim() || undefined, priority,
      });
    } else if (dialog.kind === 'due') {
      onSubmit('/due', { dueAt: dueAt ? new Date(dueAt).toISOString() : null });
    } else {
      /* One field, chosen by the route. Sending both "just in case" is what
         broke /cancel: the ValidationPipe runs with forbidNonWhitelisted, so a
         field the DTO does not declare is a 400 rather than something quietly
         ignored -- which is the behaviour we want, and it caught this. */
      const body = dialog.action === '/resolve'
        ? { resolution: text.trim() }
        : { reason: text.trim() };
      onSubmit(dialog.action, body);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={heading}>
      <button type="button" className="modal__scrim" onClick={onClose} aria-label="Close" />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">{heading}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={16} />
          </button>
        </header>

        <div className="modal__body">
          {dialog.kind === 'assign' || dialog.kind === 'contributor' ? (
            <div className="field field--wide">
              <span className="field__label">
                {dialog.kind === 'assign' ? `In ${task.department}` : `From ${task.department}`}
              </span>
              <div className="pickerlist">
                {(people.data ?? [])
                  .filter((p) => dialog.kind === 'assign' || p.id !== task.assigneeId)
                  .map((p) => (
                    <button key={p.id} type="button"
                      className={`pickerlist__row${choice === p.id ? ' is-on' : ''}`}
                      onClick={() => setChoice(p.id)}>
                      <span className="pickerlist__name">{p.name}</span>
                      <span className="pickerlist__meta">{p.jobTitle}</span>
                      {p.isManager ? <Badge tone="info">Manager</Badge> : null}
                    </button>
                  ))}
              </div>
              <span className="hint">
                {dialog.kind === 'assign'
                  ? 'They set the date once they pick it up, and they are the only person who can move it along.'
                  : 'They will be able to read the ticket and comment, but not change it.'}
              </span>
            </div>
          ) : null}

          {dialog.kind === 'transfer' || dialog.kind === 'dependency' ? (
            <label className="field field--wide">
              <span className="field__label">Which department?</span>
              <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Choose…</option>
                {(departments.data ?? [])
                  .filter((d) => d.id !== task.departmentId)
                  .map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          ) : null}

          {dialog.kind === 'dependency' ? (
            <>
              <label className="field field--wide">
                <span className="field__label">What do you need from them?</span>
                <input className="input" value={title} maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Approve the revised artwork for the Eid sleeve" />
                <span className="hint">
                  They see this and nothing else — not this ticket, not its conversation. Write it as
                  a request that stands on its own.
                </span>
              </label>
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
              </div>
            </>
          ) : null}

          {dialog.kind === 'due' ? (
            <label className="field field--wide">
              <span className="field__label">Date and time</span>
              {/* The past is not offered. The API refuses it anyway -- "a
                  commitment in the past is not a commitment" -- and a picker
                  that lets somebody choose a date it is going to reject wastes
                  their time to teach them a rule the calendar could have shown
                  them. `min` wants local wall-clock, not an ISO instant. */}
              <input className="input" type="datetime-local" value={dueAt}
                min={localNow()}
                onChange={(e) => setDueAt(e.target.value)} />
              <span className="hint">
                This is your commitment, not the requester's wish. Once it passes, the ticket is
                marked late — it keeps its status, so it still shows whether anyone is working on it.
                Leave it empty to remove the date.
              </span>
            </label>
          ) : null}

          {dialog.kind !== 'contributor' && dialog.kind !== 'due' ? (
            <label className="field field--wide">
              <span className="field__label">
                {dialog.kind === 'assign' ? 'A note for them' : dialog.kind === 'dependency' ? 'Detail'
                  : dialog.kind === 'transfer' ? 'Why is it not yours?' : 'Reason'}
                {dialog.kind === 'assign' || dialog.kind === 'dependency'
                  ? <span className="field__opt"> optional</span> : null}
              </span>
              <textarea className="input" rows={3} value={text} maxLength={2000}
                onChange={(e) => setText(e.target.value)} />
              {dialog.kind === 'reason' && dialog.hint ? <span className="hint">{dialog.hint}</span> : null}
            </label>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Back</button>
          <button type="button" className="btn btn--primary" disabled={!ready || busy} onClick={submit}>
            {busy ? 'Working…' : dialog.kind === 'reason' ? dialog.verb : 'Confirm'}
          </button>
        </footer>
      </div>
    </div>
  );
}