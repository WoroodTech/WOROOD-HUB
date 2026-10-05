/**
 * Bring parked work onto the board.
 *
 * Two questions, in order: which ticket — from what is planned or on hold —
 * and then who does it and by when. The second step is the same decision as
 * Start in the backlog, sent in one request so the date and the person land
 * together or not at all.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardCard, TaskPerson } from '../contract';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { formatDate } from '../lib/format';
import { localNow } from '../pages/TaskDetail';
import { Icon } from './Icon';

interface Backlog {
  groups: Array<{ key: string; cards: BoardCard[] }>;
}

export function AddTaskDialog({ departmentId, onClose }: { departmentId?: string; onClose: () => void }) {
  const [source, setSource] = useState<'PLANNING' | 'ON_HOLD'>('PLANNING');
  const [picked, setPicked] = useState<BoardCard | null>(null);
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const toast = useToast();
  const queryClient = useQueryClient();

  const backlog = useQuery({
    queryKey: ['tasks', 'backlog', departmentId ?? ''],
    queryFn: () => api<Backlog>(`/tasks/backlog${departmentId ? `?departmentId=${departmentId}` : ''}`),
  });

  const people = useQuery({
    queryKey: ['tasks', 'people', picked?.departmentId],
    queryFn: () => api<TaskPerson[]>(`/tasks/departments/${picked!.departmentId}/people`),
    enabled: !!picked,
  });

  const start = useMutation({
    mutationFn: () => api(`/tasks/${picked!.id}/assign`, {
      method: 'POST',
      body: { assigneeId: who, dueAt: due ? new Date(due).toISOString() : undefined },
    }),
    onSuccess: () => {
      toast.push(`${picked!.reference} is under way.`, 'good');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
    onError: (e: unknown) => toast.push(e instanceof Error ? e.message : 'That did not work.', 'warning'),
  });

  const list = backlog.data?.groups.find((g) => g.key === source)?.cards ?? [];

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Add a task to the board">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">{picked ? 'Who does it, and by when?' : 'Add a task to the board'}</h2>
        </header>

        <div className="modal__body">
          {!picked ? (
            <>
              <div className="ranges" role="group" aria-label="From">
                <button type="button" className={`ranges__btn${source === 'PLANNING' ? ' is-active' : ''}`}
                        onClick={() => setSource('PLANNING')}>
                  <Icon name="calendar" size={14} /> Planning
                </button>
                <button type="button" className={`ranges__btn${source === 'ON_HOLD' ? ' is-active' : ''}`}
                        onClick={() => setSource('ON_HOLD')}>
                  <Icon name="clock" size={14} /> On hold
                </button>
              </div>

              {backlog.isPending ? <p className="muted">Loading…</p>
                : list.length === 0 ? (
                  <p className="muted addtask__empty">
                    Nothing {source === 'PLANNING' ? 'is planned' : 'is on hold'} right now.
                  </p>
                ) : (
                  <ul className="addtask__list">
                    {list.map((c) => (
                      <li key={c.id}>
                        <button type="button" className="addtask__item"
                                onClick={() => { setPicked(c); setWho(c.heldAssigneeId ?? ''); }}>
                          <span className="addtask__title">{c.title}</span>
                          <span className="addtask__meta">
                            <span className="mono">{c.reference}</span>
                            {c.plannedFor ? ` · planned ${formatDate(c.plannedFor)}` : ''}
                            {` · ${c.requesterName}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </>
          ) : (
            <>
              <p className="modal__sub"><span className="mono">{picked.reference}</span> — {picked.title}</p>
              <div className="field field--wide">
                <span className="field__label">Who does it</span>
                <select className="input" value={who} onChange={(e) => setWho(e.target.value)} autoFocus>
                  <option value="">Choose somebody…</option>
                  {(people.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}{u.jobTitle ? ` — ${u.jobTitle}` : ''}{u.isManager ? ' (manager)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field field--wide">
                <span className="field__label">Due by</span>
                <input className="input" type="datetime-local" value={due} min={localNow()}
                       onChange={(e) => setDue(e.target.value)} />
              </div>
              <p className="hint">Work starts the moment you choose somebody, and they are emailed.</p>
            </>
          )}
        </div>

        <footer className="modal__foot">
          {picked ? (
            <button type="button" className="btn btn--ghost" onClick={() => setPicked(null)}>Back</button>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          {picked ? (
            <button type="button" className="btn btn--primary"
                    disabled={!who || !due || start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? 'Starting…' : 'Start it'}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}