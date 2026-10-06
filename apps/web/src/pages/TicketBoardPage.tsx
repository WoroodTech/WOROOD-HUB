/**
 * The manager's board.
 *
 * Two boards, really, behind one screen. **Doing** is work this department is
 * carrying out — the manager's own pipeline, and cards move. **Requested** is
 * work this department asked another department for — visible, followable, and
 * not draggable, because moving somebody else's ticket through their states is
 * not oversight.
 *
 * That is not a filter over one list. It is two different relationships to the
 * same ticket, and the actions differ, which is why it is a pair of tabs rather
 * than a dropdown.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardResponse } from '../contract';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { BoardColumn } from '../components/TicketBoard';
import { Icon } from '../components/Icon';
import { TicketListView, ViewToggle, useTicketView } from '../components/TicketViews';
import { AddTaskDialog } from '../components/AddTaskDialog';
import { STATUS_SHORT, NewTicketButton } from './Tasks';
import { localNow } from './TaskDetail';
import { useAuth } from '../lib/auth';
import { MyTicketBoard } from './MyTicketBoard';
import type { TaskPerson } from '../contract';

/** What a drop needs before it can be completed. The API is the authority and
 *  refuses without these; this is only so the dialog opens on the drop rather
 *  than after a round trip that reads as a failure. */
type Pending =
  | { kind: 'plan'; id: string; to: string }
  | { kind: 'hold'; id: string; to: string }
  | { kind: 'assign'; id: string; to: string; departmentId: string }
  | { kind: 'start'; id: string; to: string; departmentId: string }
  | { kind: 'review'; id: string; to: string }
  | null;

export function TicketBoardPage() {
  const { principal } = useAuth();

  /* One entry in the sidebar, two boards behind it.
  
     A manager gets their department's work with the doing/requested filter; an
     employee gets their own. Deciding here rather than with two nav entries
     means there is one place called "Board" and it shows you yours -- which is
     what somebody expects from the word, and what stopped the two entries
     lighting each other up. */
  const isManager = (principal?.managedDepartmentIds?.length ?? 0) > 0;
  if (!isManager) return <MyTicketBoard />;

  return <ManagerBoard />;
}

function ManagerBoard() {
  const [view, setView] = useTicketView();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const toggleColumn = (k: string) => setCollapsed((s) => {
    const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n;
  });
  const [departmentId, setDepartmentId] = useState<string>('');
  const [pending, setPending] = useState<Pending>(null);
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
    queryKey: ['tasks', 'board', departmentId],
    /* Only work this department is carrying out. Watching another
       department's pipeline was a read-only board whose cards refused to move
       -- which reads as broken rather than as deliberate. Work we asked for is
       followed on the ticket itself, where there is room to say what is
       happening. */
    queryFn: () => api<BoardResponse>(
      `/tasks/board?side=doing${departmentId ? `&departmentId=${departmentId}` : ''}`),
    refetchInterval: 60_000,
  });

  const move = useMutation({
    mutationFn: (body: {
      id: string; to: string; plannedFor?: string; reason?: string;
      assigneeId?: string; resolution?: string;
    }) =>
      api(`/tasks/${body.id}/move`, { method: 'POST', body: {
        to: body.to, plannedFor: body.plannedFor, reason: body.reason,
        assigneeId: body.assigneeId, resolution: body.resolution,
      } }),
    onSuccess: () => {
      setPending(null); setValue('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: unknown) => {
      /* The API's sentence, verbatim. It knows why — the wrong department, the
         wrong transition, a missing assignee — and rewording it here would mean
         two explanations that drift apart. */
      toast.push(e instanceof Error ? e.message : 'That move was not allowed.', 'warning');
      setPending(null); setValue('');
    },
  });

  /* A drop the API can complete on its own goes straight through. One that
     needs a date, a reason or a person opens the smallest possible dialog.
     Deciding here rather than asking the server first keeps the gesture
     feeling immediate; the server still refuses anything this gets wrong. */
  const onDrop = (id: string, _from: string, to: string) => {
    if (to === 'PLANNING') return setPending({ kind: 'plan', id, to });
    if (to === 'ON_HOLD') return setPending({ kind: 'hold', id, to });
    if (to === 'FOR_REVIEW') return setPending({ kind: 'review', id, to });

    if (to === 'IN_PROGRESS') {
      const card = data?.columns.flatMap((c) => c.cards).find((c) => c.id === id);
      /* A parked ticket has nobody on it, so starting means choosing somebody.
         One gesture, one question, and the API does both. */
      if (!card?.assigneeId) {
        return setPending({ kind: 'start', id, to, departmentId: card?.departmentId ?? departmentId });
      }
      return move.mutate({ id, to });
    }

    if (to === 'ASSIGNED') {
      /* The department doing the work, which on this side of the board is the
         department the card belongs to -- and what decides who can be picked. */
      const card = data?.columns.flatMap((c) => c.cards).find((c) => c.id === id);
      return setPending({
        kind: 'assign', id, to,
        departmentId: card?.departmentId ?? departmentId,
      });
    }
    move.mutate({ id, to });
  };

  /* Only fetched once an assign dialog is open. The list is per department and
     most drops are not assignments. */
  const { data: people } = useQuery({
    queryKey: ['tasks', 'people', (pending as any)?.departmentId ?? ''],
    queryFn: () => api<TaskPerson[]>(
      `/tasks/departments/${(pending as any).departmentId}/people`),
    enabled: (pending?.kind === 'assign' || pending?.kind === 'start')
      && !!(pending as any).departmentId,
  });

  if (isPending) return <div className="page"><LoadingState label="Opening the board" lines={5} /></div>;
  if (error) return <div className="page"><ErrorState error={error} onRetry={() => void refetch()} /></div>;

  if (data.empty === 'notAManager') {
    return (
      <div className="page">
        <EmptyState
          icon="grip"
          title="This board is for department managers"
          hint="It shows the work your department is doing and the work it has asked for. Your own tickets are on your board."
        />
      </div>
    );
  }

  return (
    <div className="page board">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Board</h1>
          <p className="pagehead__sub">
            Work your department is carrying out. Drag a card to move it along.
          </p>
        </div>
        <div className="pagehead__tools"><NewTicketButton /></div>
      </header>

      <div className="board__controls">
        <ViewToggle view={view} onChange={setView} />
        {view === 'board' ? (
          <button type="button" className="btn btn--ghost btn--sm"
                  onClick={() => setCollapsed(collapsed.size ? new Set()
                    : new Set(data.columns.map((c) => c.key)))}>
            <Icon name={collapsed.size ? 'expand' : 'shrink'} size={14} />
            {collapsed.size ? 'Expand all' : 'Collapse all'}
          </button>
        ) : null}
        {data.departments.length > 1 ? (
          <select
            className="input" value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            aria-label={oversees ? 'Requested by' : 'Asked of us by'}
          >
            <option value="">{oversees ? 'Every department' : 'Everything we are doing'}</option>
            {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
      </div>

      {/* Horizontal scroll rather than wrapping. A board that wraps stops being
          a board -- the left-to-right order is the lifecycle, and reading it
          across two rows loses that. */}
      {view === 'list' ? (
        <TicketListView columns={data.columns} />
      ) : (
        <div className="board__scroll">
          {data.columns.map((c) => (
            <BoardColumn
              key={c.key} column={c}
              onDrop={c.droppable ? onDrop : undefined}
              collapsed={collapsed.has(c.key)}
              onToggle={() => toggleColumn(c.key)}
            />
          ))}
          {/* The way onto the board for parked work. A column of its own at the
              end, so it is where the eye arrives after reading the lifecycle,
              and transparent so it never reads as a status. */}
          <section className="bcol bcol--add">
            <button type="button" className="bcol__addbtn" onClick={() => setAdding(true)}>
              <Icon name="plus" size={15} /> Add task
            </button>
          </section>
        </div>
      )}

      {adding ? (
        <AddTaskDialog departmentId={departmentId || undefined} onClose={() => setAdding(false)} />
      ) : null}

      {pending ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__panel">
            <h2 className="modal__title">
              Move to {STATUS_SHORT[pending.to] ?? pending.to}
            </h2>

            {pending.kind === 'plan' ? (
              <>
                <p className="modal__sub">
                  A planned ticket needs a date. Nobody is assigned yet — that
                  happens when the work actually starts.
                </p>
                <input
                  className="input" type="datetime-local" value={value}
                  min={localNow()}
                  onChange={(e) => setValue(e.target.value)} autoFocus
                />
              </>
            ) : pending.kind === 'hold' ? (
              <>
                <p className="modal__sub">
                  Say why. A ticket on hold with no reason is one nobody can
                  explain later, and nobody dares close.
                </p>
                <textarea
                  className="input" rows={3} value={value}
                  onChange={(e) => setValue(e.target.value)} autoFocus
                  placeholder="Waiting on the supplier to confirm stock…"
                />
              </>
            ) : pending.kind === 'review' ? (
              <>
                <p className="modal__sub">
                  Say what was done. Whoever raised the ticket reads this while
                  they decide whether to approve it, and it stays on the record.
                </p>
                <textarea
                  className="input" rows={4} value={value} autoFocus
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Replaced the courier label template and reprinted the batch…"
                />
              </>
            ) : (
              <>
                <p className="modal__sub">
                  {pending.kind === 'start'
                    ? 'Nobody is on this yet. Whoever you pick starts on it now, and is emailed.'
                    : 'Choose who it goes to. You are on the list — a manager can take a ticket themselves.'}
                </p>
                <select
                  className="input" value={value}
                  onChange={(e) => setValue(e.target.value)} autoFocus
                >
                  <option value="">Choose somebody…</option>
                  {(people ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}{u.jobTitle ? ` — ${u.jobTitle}` : ''}{u.isManager ? ' (manager)' : ''}
                    </option>
                  ))}
                </select>
                {people && people.length === 0 ? (
                  <p className="muted">
                    Nobody active in that department. An administrator can add
                    people to it.
                  </p>
                ) : null}
              </>
            )}

            <div className="modal__actions">
              <button type="button" className="btn btn--ghost"
                      onClick={() => { setPending(null); setValue(''); }}>
                Cancel
              </button>
              <button
                type="button" className="btn btn--primary"
                disabled={!value.trim() || move.isPending}
                onClick={() => move.mutate({
                  id: pending.id, to: pending.to,
                  plannedFor: pending.kind === 'plan' ? new Date(value).toISOString() : undefined,
                  reason: pending.kind === 'hold' ? value : undefined,
                  assigneeId: pending.kind === 'assign' || pending.kind === 'start' ? value : undefined,
                  resolution: pending.kind === 'review' ? value : undefined,
                })}
              >
                Move it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}