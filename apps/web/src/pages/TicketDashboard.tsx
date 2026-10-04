/**
 * The manager's figures.
 *
 * Counts, and the same counts per person. Deliberately nothing else — no
 * averages, no scores, no ratios, no "performance". This is the data a KPI
 * would be built from, and building the measure before anybody has agreed what
 * good looks like is how a team ends up managed by a number nobody chose.
 *
 * The per-person table lists everybody in the department, including people with
 * no tickets at all. A query grouped by assignee would leave them out, and a
 * person with nothing on them is often the most interesting row on the page.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { TicketDashboardResponse } from '../contract';
import { api } from '../lib/api';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';

/** One number, in the portal's own card. */
function Figure({ span, label, value, note, bad }: {
  span: number; label: string; value: number; note?: string; bad?: boolean;
}) {
  return (
    <div className="grid__cell tile" style={{ ['--span' as string]: String(span) }}>
      <div className="kpi">
        <div className="kpi__top"><span className="kpi__label">{label}</span></div>
        <span className={`kpi__value${bad ? ' kpi__value--bad' : ''}`}>{value}</span>
        <div className="kpi__foot">
          {note ? <span className="delta__label">{note}</span> : null}
        </div>
      </div>
    </div>
  );
}

/* Ordered as the lifecycle runs, not by size. A manager reads these to find
   where work is piling up, and that only works if the order means something. */
const TILES = [
  { key: 'unassigned', label: 'Awaiting assignment', tone: 'warning' },
  { key: 'planning', label: 'Planned', tone: 'neutral' },
  { key: 'onHold', label: 'On hold', tone: 'warning' },
  { key: 'assigned', label: 'Assigned', tone: 'neutral' },
  { key: 'inProgress', label: 'In progress', tone: 'accent' },
  { key: 'blocked', label: 'Waiting on others', tone: 'critical' },
  { key: 'forReview', label: 'For review', tone: 'warning' },
  { key: 'implementation', label: 'Being carried out', tone: 'accent' },
  { key: 'done', label: 'Done', tone: 'good' },
] as const;

export function TicketDashboard() {
  const [side, setSide] = useState<'doing' | 'requested'>('doing');
  const [departmentId, setDepartmentId] = useState('');

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['tasks', 'dashboard', side, departmentId],
    queryFn: () => api<TicketDashboardResponse>(
      `/tasks/dashboard?side=${side}${departmentId ? `&departmentId=${departmentId}` : ''}`),
    refetchInterval: 120_000,
  });

  if (isPending) return <div className="page"><LoadingState label="Counting" lines={4} /></div>;
  if (error) return <div className="page"><ErrorState error={error} onRetry={() => void refetch()} /></div>;

  if (data.empty === 'notAManager' || !data.totals) {
    return (
      <div className="page">
        <EmptyState
          icon="activity"
          title="These figures are for department managers"
          hint="They cover the work your department is doing and the work it has asked for."
        />
      </div>
    );
  }

  const t = data.totals;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Department figures</h1>
          <p className="pagehead__sub">
            {side === 'doing'
              ? 'Work your department is carrying out.'
              : 'Work your department has asked other departments for.'}
          </p>
        </div>
      </header>

      <div className="board__controls">
        <div className="ranges" role="group" aria-label="Which tickets">
          <button type="button" className={`ranges__btn${side === 'doing' ? ' is-active' : ''}`}
                  aria-pressed={side === 'doing'} onClick={() => setSide('doing')}>
            We are doing
          </button>
          <button type="button" className={`ranges__btn${side === 'requested' ? ' is-active' : ''}`}
                  aria-pressed={side === 'requested'} onClick={() => setSide('requested')}>
            We asked for
          </button>
        </div>

        {data.departments.length > 1 ? (
          <select className="input" value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
            <option value="">All my departments</option>
            {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
      </div>

      {/* Built from the same grid and the same card the sales dashboards use.
          A second visual language for "a number in a box" would be two things
          to keep in step, and the portal already has one. */}
      <div className="grid">
        <Figure span={3} label="Open now" value={t.total - t.done - t.cancelled}
                note={`${t.total} raised in all`} />
        {/* Late sits apart from the stages, and first.
        
            It is not a stage — a ticket is late *and* in progress, or late
            *and* waiting on another department. Among the stages it would
            imply the counts add up, and they do not: the same ticket is in two
            of them. */}
        <Figure span={3} label="Late" value={t.delayed} bad={t.delayed > 0}
                note={t.delayed === 0 ? 'nothing past its date' : 'past a date somebody promised'} />
        <Figure span={3} label="Sent back at least once" value={t.sentBackAtLeastOnce}
                note="not accepted first time" />
        <Figure span={3} label="Fast-tracked" value={t.fastTracked}
                note="raised skipping review" />

        {TILES.map((tile) => (
          <Figure key={tile.key} span={3} label={tile.label} value={(t as any)[tile.key]} />
        ))}
      </div>

      {side === 'doing' ? (
        <Card
          title="Your people"
          subtitle="Counts only. What good looks like is not decided here."
        >
          {data.people.length === 0 ? (
            <p className="muted">Nobody is in this department yet.</p>
          ) : (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th className="num">Active</th>
                    <th className="num">In progress</th>
                    <th className="num">Waiting on others</th>
                    <th className="num">For review</th>
                    <th className="num">Carrying out</th>
                    <th className="num">Done</th>
                    <th className="num">Late</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td className="num">{u.active}</td>
                      <td className="num">{u.inProgress}</td>
                      <td className="num">{u.blocked}</td>
                      <td className="num">{u.forReview}</td>
                      <td className="num">{u.implementation}</td>
                      <td className="num">{u.done}</td>
                      <td className={`num${u.delayed > 0 ? ' num--bad' : ''}`}>{u.delayed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">
            <Icon name="info" size={13} />{' '}
            Somebody with a high “waiting on others” is not slow — they are
            blocked, and the ticket says by whom.
          </p>
        </Card>
      ) : null}

      <p className="hint">
        <Link to="/tasks/board" className="link">Open the board</Link> to move work along.
      </p>
    </div>
  );
}