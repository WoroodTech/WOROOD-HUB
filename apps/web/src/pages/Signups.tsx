/**
 * Requests for accounts, waiting on somebody.
 *
 * The form that feeds this is open to anyone who can reach the portal, so
 * this screen is the gate. It shows what a reviewer needs to decide — a name,
 * an address, a department — and nothing that could be replayed.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DecidedSignup, PendingSignup } from '../contract';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/States';

export function Signups() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  const [rejecting, setRejecting] = useState<PendingSignup | null>(null);

  const pending = useQuery({
    queryKey: ['signups', 'pending'],
    queryFn: () => api<PendingSignup[]>('/admin/signup/pending'),
  });

  const decided = useQuery({
    queryKey: ['signups', 'decided'],
    queryFn: () => api<DecidedSignup[]>('/admin/signup/decided'),
    enabled: tab === 'decided',
  });

  /*
   * Re-read the queue after anything is attempted — including a failure.
   *
   * On success this is obvious. On failure it matters just as much: a call
   * can fail after the server has already changed something, or fail because
   * somebody else dealt with the same request a moment ago. Refetching only
   * on success leaves a row on screen that is no longer there, and the next
   * click on it fails for a reason that makes no sense.
   */
  const refresh = () => {
    setRejecting(null);
    void qc.invalidateQueries({ queryKey: ['signups'] });
  };

  const approve = useMutation({
    mutationFn: (id: string) =>
      api(`/admin/signup/${id}/approve`, { method: 'POST' }),
    onSettled: refresh,
  });

  const reject = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      api(`/admin/signup/${v.id}/reject`,
          { method: 'POST', body: { reason: v.reason } }),
    onSettled: refresh,
  });

  /* Clear whatever the last attempt said before starting another. Otherwise
     a refusal that worked still sits under the banner from the approval that
     did not, and reads as though it failed too. */
  const begin = () => { approve.reset(); reject.reset(); };

  const busy = approve.isPending || reject.isPending;
  const waiting = pending.data ?? [];

  return (
    <>
      <div className="page">
        <header className="pagehead">
          <div>
            <h1 className="pagehead__title">Account requests</h1>
            <p className="pagehead__sub">
              People asking to join the portal. Approving one creates their
              account as an <strong>employee</strong> — anything beyond that is
              granted separately on Roles.
            </p>
          </div>
        </header>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'pending'}
                  className={`tabs__tab${tab === 'pending' ? ' is-active' : ''}`}
                  onClick={() => setTab('pending')}>
            Waiting{waiting.length ? ` (${waiting.length})` : ''}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'decided'}
                  className={`tabs__tab${tab === 'decided' ? ' is-active' : ''}`}
                  onClick={() => setTab('decided')}>
            Decided
          </button>
        </div>

        {approve.isError || reject.isError ? (
          <div className="banner banner--stale">
            {((approve.error ?? reject.error) as Error)?.message
              ?? 'That could not be saved.'}
          </div>
        ) : null}

        {tab === 'pending' ? (
          pending.isLoading ? <LoadingState label="Loading requests" />
          : pending.isError ? <ErrorState error={pending.error}
                                          onRetry={() => void pending.refetch()} />
          : !waiting.length ? (
            <EmptyState title="Nothing waiting"
                        hint="Requests for accounts will appear here." />
          ) : (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Department</th>
                    <th scope="col">Asked</th>
                    <th scope="col"><span className="visually-hidden">Decide</span></th>
                  </tr>
                </thead>
                <tbody>
                  {waiting.map((r) => (
                    <tr key={r.id}>
                      <td>{r.fullName}</td>
                      <td>{r.email}</td>
                      <td>{r.departmentName}</td>
                      <td>{formatDateTime(r.requestedAt)}</td>
                      <td>
                        <div className="rowtools">
                          <button type="button" className="notebtn" disabled={busy}
                                  onClick={() => { begin(); approve.mutate(r.id); }}>
                            Approve
                          </button>
                          <button type="button" className="notebtn" disabled={busy}
                                  onClick={() => { begin(); setRejecting(r); }}>
                            Refuse
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          decided.isLoading ? <LoadingState label="Loading" />
          : decided.isError ? <ErrorState error={decided.error}
                                          onRetry={() => void decided.refetch()} />
          : !decided.data?.length ? (
            <EmptyState title="Nothing decided yet" />
          ) : (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">By</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {decided.data.map((r) => (
                    <tr key={r.id}>
                      <td>{r.fullName}</td>
                      <td>{r.email}</td>
                      <td>
                        {r.status === 'APPROVED' ? 'Approved' : 'Refused'}
                        {/* The reason is why a refusal is not just a word:
                            it is what the person was told. */}
                        {r.reason ? (
                          <span className="muted"> · {r.reason}</span>
                        ) : null}
                      </td>
                      <td>{r.decidedBy ?? '—'}</td>
                      <td>{formatDateTime(r.decidedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {rejecting ? (
        <RefuseDialog person={rejecting} busy={busy}
                      onCancel={() => setRejecting(null)}
                      onConfirm={(reason) =>
                        reject.mutate({ id: rejecting.id, reason })} />
      ) : null}
    </>
  );
}

/**
 * Refusing, with the reason that will be sent.
 *
 * The reason is required and the dialog says where it goes. "No" with nothing
 * after it leaves somebody who may well belong here with nothing to act on,
 * and the next thing they do is ask again exactly as before.
 */
function RefuseDialog({ person, busy, onCancel, onConfirm }: {
  person: PendingSignup;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <div className="modal" role="dialog" aria-modal="true"
         aria-label={`Refuse ${person.fullName}`}>
      <button type="button" className="modal__scrim" aria-label="Cancel"
              onClick={onCancel} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">Refuse this request</h2>
          <button type="button" className="iconbtn" aria-label="Cancel"
                  onClick={onCancel}>
            <Icon name="minus" size={16} />
          </button>
        </header>

        <div className="modal__body">
          <p>
            <strong>{person.fullName}</strong> ({person.email}) will not get an
            account, and will be e-mailed the reason you give.
          </p>

          <label className="field">
            <span className="field__label">Reason</span>
            <textarea className="input" rows={3} maxLength={500} autoFocus
                      value={reason} disabled={busy}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. you already have an account under another address" />
          </label>

          <div className="modal__foot">
            {/* Focus starts on the text, and Cancel is first: the destructive
                one should not be where a stray Enter lands. */}
            <button type="button" className="btn btn--ghost" disabled={busy}
                    onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn--primary"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => onConfirm(reason.trim())}>
              {busy ? 'Sending…' : 'Refuse and tell them'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}