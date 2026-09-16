/**
 * Administration → Departments.
 *
 * One question: who runs each department. It matters because Module 3 made the
 * org chart load-bearing — a ticket is raised to a department and that
 * department's manager is the only person who can put somebody on it — and
 * because authority here is a position rather than a role, there is nowhere
 * else in the product to set it.
 *
 * A department with no active manager is shown first and marked, not buried in
 * a list. Losing the last one takes the department out of service silently:
 * the module stops offering it as a destination, and anything already raised to
 * it can never be assigned by anybody.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';

interface Manager {
  id: string; name: string; jobTitle?: string | null; email: string; active: boolean;
}
interface Department {
  id: string; name: string; nameAr?: string | null;
  parentId?: string | null; parentName?: string | null;
  headCount: number; managers: Manager[]; reachable: boolean;
}
interface Candidate { id: string; name: string; jobTitle?: string | null; isManager: boolean }

export function Departments() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState<Department | null>(null);

  const overview = useQuery({
    queryKey: ['admin', 'departments', 'overview'],
    queryFn: () => api<{ departments: Department[] }>('/admin/departments/overview'),
  });

  const change = useMutation({
    mutationFn: ({ path, method }: { path: string; method: string }) =>
      api<{ departments: Department[] }>(path, { method }),
    onSuccess: (data) => {
      queryClient.setQueryData(['admin', 'departments', 'overview'], data);
      /* Managing a department is what grants the right to assign, and that is
         resolved into the principal on every request — so the navigation and
         the queue appear for the new manager as soon as they reload. */
      void queryClient.invalidateQueries({ queryKey: ['hub'] });
      setPicking(null);
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'That did not go through.', 'warning'),
  });

  const departments = overview.data?.departments ?? [];
  const unreachable = departments.filter((d) => !d.reachable);
  const ordered = [...unreachable, ...departments.filter((d) => d.reachable)];

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Departments</h1>
          <p className="pagehead__sub">
            Who runs each department. This is a position in the org chart, not a role:
            a manager here can hand out work in this department and everything below it,
            and nowhere else. More than one is allowed on purpose — it is how cover during
            leave works without giving anybody company-wide authority.
          </p>
        </div>
      </header>

      {unreachable.length > 0 ? (
        <div className="banner banner--stale">
          <Icon name="warning" size={16} />
          <span>
            <strong>
              {unreachable.length === 1
                ? `${unreachable[0].name} has no active manager.`
                : `${unreachable.length} departments have no active manager.`}
            </strong>{' '}
            Nobody can be put on a ticket raised to {unreachable.length === 1 ? 'it' : 'them'},
            and the person who raised it would not be told. The module hides
            {unreachable.length === 1 ? ' it' : ' them'} from the department picker until this is fixed.
          </span>
        </div>
      ) : null}

      {overview.isPending ? <LoadingState lines={6} /> : null}
      {overview.error ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : null}

      <div className="deptgrid">
        {ordered.map((d) => (
          <Card
            key={d.id}
            title={d.name}
            subtitle={[
              d.parentName ? `under ${d.parentName}` : null,
              `${d.headCount} ${d.headCount === 1 ? 'person' : 'people'}`,
            ].filter(Boolean).join(' · ')}
            actions={d.reachable
              ? null
              : <Badge tone="critical" icon="warning">No manager</Badge>}
          >
            {d.managers.length === 0 ? (
              <EmptyState icon="users" title="Nobody runs this department"
                hint="Tickets raised to it cannot be assigned." />
            ) : (
              <ul className="peoplelist">
                {d.managers.map((m) => (
                  <li key={m.id} className="peoplelist__row">
                    <span className="peoplelist__name">{m.name}</span>
                    <span className="peoplelist__meta">{m.jobTitle}</span>
                    {!m.active ? <Badge tone="warning">Suspended</Badge> : null}
                    <button
                      type="button" className="iconbtn iconbtn--xs iconbtn--danger"
                      aria-label={`Remove ${m.name} as manager`}
                      disabled={change.isPending}
                      onClick={() => change.mutate({
                        path: `/admin/departments/${d.id}/managers/${m.id}`, method: 'DELETE',
                      })}
                    >
                      <Icon name="minus" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn btn--ghost btn--sm btn--block"
              onClick={() => setPicking(d)} style={{ marginBlockStart: 12 }}>
              <Icon name="plus" size={14} /> Add a manager
            </button>
          </Card>
        ))}
      </div>

      {picking ? (
        <ManagerPicker department={picking} onClose={() => setPicking(null)} />
      ) : null}
    </div>
  );
}

function ManagerPicker({ department, onClose }: {
  department: Department;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState('');

  const candidates = useQuery({
    queryKey: ['admin', 'departments', department.id, 'candidates'],
    queryFn: () => api<{ candidates: Candidate[] }>(`/admin/departments/${department.id}/candidates`),
  });

  const add = useMutation({
    mutationFn: () => api<{ departments: Department[] }>(
      `/admin/departments/${department.id}/managers`,
      { method: 'POST', body: { userId: chosen } }),
    onSuccess: (data) => {
      queryClient.setQueryData(['admin', 'departments', 'overview'], data);
      void queryClient.invalidateQueries({ queryKey: ['hub'] });
      onClose();
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not add them.', 'warning'),
  });

  const list = candidates.data?.candidates ?? [];
  const available = list.filter((c) => !c.isManager);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Add a manager to ${department.name}`}>
      <button type="button" className="modal__scrim" onClick={onClose} aria-label="Close" />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">Who runs {department.name}?</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={16} />
          </button>
        </header>

        <div className="modal__body">
          {candidates.isPending ? <LoadingState lines={4} /> : null}
          {available.length === 0 && !candidates.isPending ? (
            <EmptyState
              icon="users"
              title="Nobody left to choose"
              hint={`Only active members of ${department.name} can run it. Move somebody into the department from Administration → People first.`}
            />
          ) : (
            <div className="field field--wide">
              <span className="field__label">Active members of {department.name}</span>
              <div className="pickerlist">
                {available.map((c) => (
                  <button key={c.id} type="button"
                    className={`pickerlist__row${chosen === c.id ? ' is-on' : ''}`}
                    onClick={() => setChosen(c.id)}>
                    <span className="pickerlist__name">{c.name}</span>
                    <span className="pickerlist__meta">{c.jobTitle}</span>
                  </button>
                ))}
              </div>
              <span className="hint">
                They will be able to assign and redirect work in {department.name} and in any
                department underneath it, and they will see its queue on their home screen.
                They will not gain anything anywhere else.
              </span>
            </div>
          )}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Back</button>
          <button type="button" className="btn btn--primary"
            disabled={!chosen || add.isPending}
            onClick={() => add.mutate()}>
            {add.isPending ? 'Adding…' : 'Make them a manager'}
          </button>
        </footer>
      </div>
    </div>
  );
}
