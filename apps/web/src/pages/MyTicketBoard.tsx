/**
 * The employee's board: what is on them, and nothing else.
 *
 * Not the manager's board filtered by assignee. The columns differ because the
 * questions differ — PLANNING and ON_HOLD are states where nobody is holding
 * the ticket, so they have no place on a board that answers "what is mine".
 *
 * Cards drag, for the two moves that are theirs: starting something back up,
 * and sending work for review. The review drop asks what was done, the way the
 * manager's board asks for a date or a reason.
 *
 * They cannot park a ticket. Planning and on hold are the manager's decisions,
 * and letting somebody put their own ticket on hold is letting them stop their
 * own clock — so those columns are not on this board and the question does not
 * arise. Blocked, implementation and done are not reachable by dragging either:
 * blocking follows from raising a dependency, implementation from the requester
 * approving, and done is declared on the ticket.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MyBoardResponse } from '../contract';
import { api } from '../lib/api';
import { NewTicketButton } from './Tasks';
import { useToast } from '../lib/toast';
import { BoardColumn } from '../components/TicketBoard';
import { TicketListView, ViewToggle, useTicketView } from '../components/TicketViews';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';

export function MyTicketBoard() {
  const [view, setView] = useTicketView();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<string | null>(null);
  const [text, setText] = useState('');
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['tasks', 'board', 'mine'],
    queryFn: () => api<MyBoardResponse>('/tasks/board/mine'),
    refetchInterval: 60_000,
  });

  const move = useMutation({
    mutationFn: (body: { id: string; to: string; resolution?: string }) =>
      api(`/tasks/${body.id}/move`, { method: 'POST', body: { to: body.to, resolution: body.resolution } }),
    onSuccess: () => {
      setReview(null); setText('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: unknown) => {
      /* The API's own sentence. It knows why -- the wrong state, not yours to
         move -- and rewording it here would be a second explanation to keep in
         step with the first. */
      toast.push(e instanceof Error ? e.message : 'That move was not allowed.', 'warning');
      setReview(null); setText('');
    },
  });

  const onDrop = (id: string, _from: string, to: string) => {
    if (to === 'FOR_REVIEW') { setText(''); return setReview(id); }
    move.mutate({ id, to });
  };

  if (isPending) return <div className="page"><LoadingState label="Opening your board" lines={4} /></div>;
  if (error) return <div className="page"><ErrorState error={error} onRetry={() => void refetch()} /></div>;

  const total = data.columns.reduce((n, c) => n + c.cards.length, 0);
  const late = data.columns.find((c) => c.key === 'DELAYED')?.cards.length ?? 0;

  return (
    <div className="page board">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">My work</h1>
          <p className="pagehead__sub">
            {total === 0
              ? 'Nothing is on you at the moment.'
              : late > 0
                ? `${total} ticket${total === 1 ? '' : 's'}, ${late} past its date.`
                : `${total} ticket${total === 1 ? '' : 's'}, all within their dates.`}
          </p>
        </div>
        <div className="pagehead__tools"><NewTicketButton /></div>
      </header>

      {/* Tickets this person raised that are now sitting in review are waiting
          on them too — and they are on no column here, because they are not
          assigned to them. Without this line they are invisible until somebody
          chases. */}
      {data.awaitingMyReview > 0 ? (
        <p className="notice notice--warn">
          <Icon name="eye" size={15} />
          <span>
            {data.awaitingMyReview} ticket{data.awaitingMyReview === 1 ? '' : 's'} you
            raised {data.awaitingMyReview === 1 ? 'is' : 'are'} waiting for you to
            approve or send back.{' '}
            <Link to="/tasks?scope=requested&status=FOR_REVIEW" className="link">
              Look at {data.awaitingMyReview === 1 ? 'it' : 'them'}
            </Link>
          </span>
        </p>
      ) : null}

      {total === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing assigned to you"
          hint="When a manager gives you a ticket it appears here, and you are emailed."
        />
      ) : (
        <>
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
          </div>
          {view === 'list' ? <TicketListView columns={data.columns} /> : (
            <div className="board__scroll">
              {data.columns.map((c) => (
                <BoardColumn key={c.key} column={c} onDrop={onDrop}
                  collapsed={collapsed.has(c.key)}
                  onToggle={() => setCollapsed((s) => {
                    const n = new Set(s); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n;
                  })} />
              ))}
            </div>
          )}
        </>
      )}

      <p className="hint">
        <Icon name="info" size={13} />{' '}
        Drag a card to pick work back up or send it for review. Setting a date,
        asking another department and marking it done are on the ticket itself.
      </p>

      {review ? (
        <div className="modal" role="dialog" aria-modal="true">
          <button type="button" className="modal__scrim" aria-label="Close"
                  onClick={() => { setReview(null); setText(''); }} />
          <div className="modal__panel">
            <header className="modal__head">
              <h2 className="modal__title">What did you do?</h2>
            </header>
            <div className="modal__body">
              <p className="modal__sub">
                Whoever raised the ticket reads this while deciding whether to
                approve it, and it stays on the record.
              </p>
              <textarea className="input" rows={4} value={text} autoFocus
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Replaced the courier label template and reprinted the batch…" />
            </div>
            <footer className="modal__foot">
              <button type="button" className="btn btn--ghost"
                      onClick={() => { setReview(null); setText(''); }}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary"
                      disabled={text.trim().length < 3 || move.isPending}
                      onClick={() => move.mutate({ id: review, to: 'FOR_REVIEW', resolution: text })}>
                {move.isPending ? 'Sending…' : 'Send for review'}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}