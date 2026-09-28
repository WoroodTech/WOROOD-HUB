/**
 * One meeting, and the two buttons that answer it.
 *
 * Where the link in an invitation email lands. `RequireAuth` bounces an
 * unauthenticated visitor to the login screen recording this path, and Login
 * returns them here — so the email can carry one button, the person signs in
 * once, and they arrive at the question rather than at a list to search.
 *
 * Deliberately not a token that answers without signing in. A link that accepts
 * on click is a link anyone with access to the mailbox can act on, and "did
 * Nadia actually agree to this" should have one answer.
 */
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Reservation } from '../contract';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDateTime, formatTime, formatWeekday } from '../lib/format';

export function Invitation() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: r, isPending, error, refetch } = useQuery({
    queryKey: ['mr', 'invitation', id],
    queryFn: () => api<Reservation>(`/meeting-rooms/reservations/${id}`),
    enabled: !!id,
  });

  const respond = useMutation({
    mutationFn: (response: 'ACCEPTED' | 'DECLINED') =>
      api<Reservation>(`/meeting-rooms/reservations/${id}/response`, {
        method: 'POST', body: { response },
      }),
    onSuccess: (updated) => {
      toast.push(updated.myResponse === 'ACCEPTED'
        ? 'You are going. The organiser has been told.'
        : 'You declined. The organiser has been told.', 'good');
      void queryClient.invalidateQueries({ queryKey: ['mr'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e: unknown) => {
      toast.push(e instanceof Error ? e.message : 'That did not work.', 'warning');
    },
  });

  if (isPending) return <div className="page"><LoadingState label="Opening the invitation" lines={4} /></div>;

  if (error) {
    /* A 404 here usually means the person is not on the invitation rather than
       that the meeting is missing -- the API says so plainly, and repeating its
       wording is better than a generic failure that sends somebody hunting. */
    const notMine = error instanceof ApiError && (error.notFound || error.forbidden);
    return (
      <div className="page">
        <ErrorState
          error={notMine
            ? new Error('This invitation is not addressed to you, or the meeting no longer exists.')
            : error}
          onRetry={notMine ? undefined : () => void refetch()}
        />
      </div>
    );
  }

  const start = new Date(r.startsAt);
  const end = new Date(r.endsAt);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const past = end.getTime() <= Date.now();
  const cancelled = r.status === 'CANCELLED';
  const answered = r.myResponse === 'ACCEPTED' || r.myResponse === 'DECLINED';
  /* The timestamp is on the attendee row rather than the reservation, because
     each person answers separately. */
  const myAnsweredAt = r.attendees.find((a) => a.response === r.myResponse
    && a.response !== 'INVITED')?.respondedAt ?? null;

  /* Four reasons the buttons should not be there, and each gets its own
     sentence. "You cannot respond" tells somebody nothing they can use. */
  const closed =
    cancelled ? 'This meeting was cancelled, so there is nothing to answer.'
    : past ? 'This meeting has already finished.'
    : r.myRole !== 'attendee'
      ? (r.myRole === 'organiser'
          ? 'You organised this meeting, so there is nothing for you to answer.'
          : 'You are not on the invitation list for this meeting.')
      : null;

  return (
    <div className="page invitepage">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">{r.title}</h1>
          <p className="pagehead__sub">
            {r.organiser.fullName} invited you · <span className="mono">{r.reference}</span>
          </p>
        </div>
        {cancelled ? <Badge tone="warning" icon="warning">cancelled</Badge>
          : answered ? (
            <Badge tone={r.myResponse === 'ACCEPTED' ? 'good' : 'neutral'}
                   icon={r.myResponse === 'ACCEPTED' ? 'check' : 'minus'}>
              {r.myResponse === 'ACCEPTED' ? 'going' : 'declined'}
            </Badge>
          ) : null}
      </header>

      <Card title="The meeting">
        <dl className="factlist">
          <div>
            <dt>When</dt>
            <dd>
              {formatWeekday(r.startsAt)},{' '}
              <span className="mono">{formatTime(r.startsAt)} – {formatTime(r.endsAt)}</span>
            </dd>
          </div>
          <div>
            <dt>How long</dt>
            <dd>{minutes < 60 ? `${minutes} minutes`
              : minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
              : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}</dd>
          </div>
          <div>
            <dt>Where</dt>
            <dd>
              {r.room.name}
              {r.room.floor ? `, floor ${r.room.floor}` : ''}
              {r.room.location ? ` — ${r.room.location}` : ''}
            </dd>
          </div>
          <div><dt>Organiser</dt><dd>{r.organiser.fullName}</dd></div>
          <div><dt>Attending</dt><dd>{r.attendeeCount} people</dd></div>
          {r.description ? (
            <div><dt>Notes</dt><dd>{r.description}</dd></div>
          ) : null}
        </dl>

        {r.attendees?.length ? (
          <ul className="invitepage__guests">
            {r.attendees.map((a) => (
              <li key={a.userId ?? a.email} className="idtag">
                <Icon
                  name={a.response === 'ACCEPTED' ? 'check'
                    : a.response === 'DECLINED' ? 'minus' : 'clock'}
                  size={12}
                />
                {a.name}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {closed ? (
        <p className="notice notice--warn">
          <Icon name="warning" size={15} />
          <span>{closed}</span>
        </p>
      ) : (
        <Card
          title={answered ? 'Change your answer' : 'Can you make it?'}
          subtitle={answered
            ? `You ${r.myResponse === 'ACCEPTED' ? 'accepted' : 'declined'} this. You can still change it.`
            : 'The organiser is told either way.'}
        >
          <div className="invitepage__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={respond.isPending || r.myResponse === 'ACCEPTED'}
              onClick={() => respond.mutate('ACCEPTED')}
            >
              <Icon name="check" size={15} /> Accept
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={respond.isPending || r.myResponse === 'DECLINED'}
              onClick={() => respond.mutate('DECLINED')}
            >
              <Icon name="minus" size={15} /> Decline
            </button>
          </div>
          {myAnsweredAt ? (
            <p className="muted invitepage__answered">
              Answered {formatDateTime(myAnsweredAt)}.
            </p>
          ) : null}
        </Card>
      )}
    </div>
  );
}