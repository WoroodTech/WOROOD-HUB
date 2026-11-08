/**
 * Notes on an order, and the dialog for writing them.
 *
 * What these are, exactly: Shopify has no way to add a timeline comment --
 * `CommentEvent` is read-only in the Admin API. What can be written is the
 * order's `note`, and changing it does appear in the timeline as a
 * note-changed event carrying the text.
 *
 * That is said plainly in the dialog rather than left for somebody to work
 * out when their note does not look like a staff comment in Shopify.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderNotesResponse } from '../contract';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Icon } from './Icon';
import { ErrorState, LoadingState } from './States';

export function OrderNotesDialog({ orderId, orderName, onClose }: {
  orderId: string;
  orderName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const notes = useQuery({
    queryKey: ['order-notes', orderId],
    queryFn: () => api<OrderNotesResponse>(`/sales/orders/${orderId}/notes`),
  });

  /* Escape closes, as it does everywhere else a panel covers the page. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { box.current?.focus(); }, []);

  const done = () => {
    setDraft(''); setEditing(null);
    void qc.invalidateQueries({ queryKey: ['order-notes', orderId] });
  };

  const add = useMutation({
    mutationFn: () => api(`/sales/orders/${orderId}/notes`,
                          { method: 'POST', body: { body: draft.trim() } }),
    onSuccess: done,
  });

  const save = useMutation({
    mutationFn: (v: { id: string; body: string }) =>
      api(`/sales/orders/notes/${v.id}`, { method: 'PATCH', body: { body: v.body } }),
    onSuccess: done,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/sales/orders/notes/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });

  const busy = add.isPending || save.isPending || remove.isPending;
  const data = notes.data;

  return (
    <div className="modal" role="dialog" aria-modal="true"
         aria-label={`Notes on order ${orderName}`}>
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">Notes on {orderName}</h2>
          <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}>
            <Icon name="minus" size={16} />
          </button>
        </header>

        <div className="modal__body">
          {/* Said once, here, rather than left for somebody to discover when
              their note does not look like a staff comment in Shopify. */}
          <p className="hint">
            Notes are written into this order's note in Shopify, which shows on
            its timeline as a change to the note. Shopify does not let any app
            post a timeline comment directly.
          </p>

          {data?.publishError ? (
            <div className="banner banner--stale">
              <strong>The last note did not reach Shopify.</strong>
              <span className="banner__detail">{data.publishError}</span>
            </div>
          ) : null}

          {notes.isLoading ? <LoadingState label="Loading notes" />
           : notes.isError ? <ErrorState error={notes.error}
                                         onRetry={() => void notes.refetch()} />
           : (
            <>
              {data?.notes.length ? (
                <ul className="notelist">
                  {data.notes.map((n) => (
                    <li key={n.id} className="notelist__item">
                      <div className="notelist__meta">
                        <strong>{n.authorName}</strong>
                        <span className="notelist__when">
                          {formatDateTime(n.createdAt)}
                          {n.edited ? ' · edited' : ''}
                        </span>
                      </div>

                      {editing === n.id ? (
                        <EditRow initial={n.body} busy={busy}
                                 onCancel={() => setEditing(null)}
                                 onSave={(body) => save.mutate({ id: n.id, body })} />
                      ) : (
                        <>
                          <p className="notelist__body">{n.body}</p>
                          {/* Only your own: editing somebody else's would
                              change what they said while keeping their name
                              on it. */}
                          {n.mine ? (
                            <div className="notelist__tools">
                              <button type="button" className="notebtn" disabled={busy}
                                      onClick={() => setEditing(n.id)}>Edit</button>
                              <button type="button" className="notebtn"
                                      disabled={busy}
                                      onClick={() => remove.mutate(n.id)}>Remove</button>
                            </div>
                          ) : null}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No notes on this order yet.</p>
              )}

              {data?.canWrite ? (
                <div className="notecompose">
                  <textarea ref={box} className="input" rows={3} maxLength={2000}
                            placeholder="What should the rest of the team know?"
                            value={draft} disabled={busy}
                            onChange={(e) => setDraft(e.target.value)} />
                  <div className="notecompose__foot">
                    <span className="muted">{draft.length}/2000</span>
                    <button type="button" className="btn btn--primary"
                            disabled={busy || !draft.trim()}
                            onClick={() => add.mutate()}>
                      {add.isPending ? 'Publishing…' : 'Add note'}
                    </button>
                  </div>
                  {add.isError ? (
                    <p className="notecompose__error">
                      {(add.error as Error)?.message ?? 'The note could not be added.'}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="muted">You can read these notes but not add to them.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EditRow({ initial, busy, onCancel, onSave }: {
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="notecompose">
      <textarea className="input" rows={3} maxLength={2000} value={text}
                disabled={busy} onChange={(e) => setText(e.target.value)} />
      <div className="notecompose__foot">
        <button type="button" className="linkbtn" disabled={busy}
                onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn--primary"
                disabled={busy || !text.trim() || text === initial}
                onClick={() => onSave(text.trim())}>Save</button>
      </div>
    </div>
  );
}