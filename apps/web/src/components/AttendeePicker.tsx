/**
 * Picking colleagues to invite, from the employee directory.
 *
 * Search-then-add rather than a long multi-select: the directory grows and a
 * list of every employee is not something anyone scans. Chosen people stay
 * visible as chips above the search, because the thing you get wrong when
 * inviting six people is losing track of who you have already added.
 *
 * The organiser is never in this list. They are attending by definition, and
 * offering to invite yourself invites the question of what happens if you
 * don't.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DirectoryPerson } from '../contract';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Icon } from './Icon';

export interface AttendeePickerProps {
  /** Chosen people, in the order they were added. */
  value: DirectoryPerson[];
  onChange: (people: DirectoryPerson[]) => void;
  /** The room's capacity, so the limit is the real one and is said out loud. */
  capacity?: number;
  label?: string;
}

export function AttendeePicker({ value, onChange, capacity, label = 'Invite colleagues' }: AttendeePickerProps) {
  const { principal } = useAuth();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');

  /* The directory is a database query per keystroke otherwise. 250ms is short
     enough to feel immediate and long enough to skip most of a typed name. */
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(term.trim()), 250);
    return () => window.clearTimeout(t);
  }, [term]);

  const results = useQuery({
    queryKey: ['directory', debounced],
    queryFn: () => api<{ users: DirectoryPerson[] }>(
      `/users?q=${encodeURIComponent(debounced)}&limit=8`),
    enabled: debounced.length >= 2,
    staleTime: 60 * 1000,
  });

  const chosenIds = useMemo(() => new Set(value.map((p) => p.id)), [value]);

  /* Already invited, and the organiser, are filtered out of the results rather
     than shown as disabled rows -- a list where half the entries do nothing is
     worse than a shorter list. */
  const suggestions = (results.data?.users ?? [])
    .filter((u) => u.id !== principal?.id && !chosenIds.has(u.id));

  // The organiser occupies a seat too, which is why this is +1.
  const full = capacity !== undefined && value.length + 1 >= capacity;

  return (
    <div className="attendees">
      <div className="attendees__head">
        <span className="field__label">{label}</span>
        <span className="field__opt">
          {value.length
            ? `${value.length + 1} attending, including you`
            : 'Just you so far'}
          {capacity !== undefined ? ` · room seats ${capacity}` : ''}
        </span>
      </div>

      {value.length ? (
        <ul className="attendees__chosen">
          {value.map((p) => (
            <li key={p.id}>
              <span className="attendee">
                <span className="attendee__name">{p.fullName}</span>
                <button
                  type="button" className="attendee__remove"
                  aria-label={`Remove ${p.fullName}`}
                  onClick={() => onChange(value.filter((x) => x.id !== p.id))}
                >
                  <Icon name="minus" size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        className="input"
        value={term}
        placeholder={full ? 'The room is full' : 'Type a name or e-mail'}
        disabled={full}
        onChange={(e) => setTerm(e.target.value)}
      />

      {full ? (
        <p className="field__error">
          Every seat is taken. Remove someone, or book a larger room.
        </p>
      ) : debounced.length >= 2 ? (
        results.isFetching && !results.data ? (
          <p className="attendees__note">Searching…</p>
        ) : suggestions.length ? (
          <ul className="attendees__results">
            {suggestions.map((u) => (
              <li key={u.id}>
                <button
                  type="button" className="attendees__result"
                  onClick={() => { onChange([...value, u]); setTerm(''); }}
                >
                  <span className="attendees__resultName">{u.fullName}</span>
                  <span className="attendees__resultMeta">{u.jobTitle ?? u.email}</span>
                  <Icon name="plus" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="attendees__note">
            Nobody else matches “{debounced}”.
          </p>
        )
      ) : (
        <p className="attendees__note">
          Two letters is enough to search. They are notified, and the meeting
          appears on their home screen.
        </p>
      )}
    </div>
  );
}
