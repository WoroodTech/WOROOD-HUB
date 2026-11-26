/**
 * Edits and deletes waiting on a manager.
 *
 * The before and after are shown together, because a change described in the
 * abstract ("set the quantity to 4") tells a manager nothing about whether it
 * is right. What is on the row now, and what it would become, side by side,
 * is the whole decision.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WarehouseApproval } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';

/** The fields an edit may change, with the labels the ledger uses. */
const FIELD_LABEL: Record<string, string> = {
  item: 'Item',
  nationalOrder: 'Local order',
  globalOrder: 'Global order',
  patch: 'Patch',
  stockIn: 'Stock in',
  stockOut: 'Stock out',
  warehouse: 'Warehouse',
  location: 'Location',
};

export function WarehouseApprovals({ view }: {
  view?: 'approvals' | 'edits' | 'deletes';
} = {}) {
  const qc = useQueryClient();
  const [note, setNote] = useState<Record<string, string>>({});
  /*
   * Which of the three it shows.
   *
   * Given one, the tab bar goes: the page is a tab inside Find an order and
   * two rows of tabs for the same choice is one row too many. Without it
   * the page keeps its own bar, for anything that still links here.
   */
  const [own, setTab] = useState<'queue' | 'edits' | 'deletes'>('queue');
  const tab = view ? (view === 'approvals' ? 'queue' : view) : own;

  const pending = useQuery({
    queryKey: qk.whApprovals,
    queryFn: () => api<WarehouseApproval[]>('/warehouse/approvals'),
  });

  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; note?: string }) =>
      api(`/warehouse/approvals/${v.id}/decide`, {
        method: 'POST', body: { approve: v.approve, note: v.note },
      }),
    /* Settled rather than success: a refusal can arrive because somebody
       else just decided it, and the list on screen is then wrong either
       way. */
    onSettled: () => void qc.invalidateQueries({ queryKey: ['wh'] }),
  });

  if (pending.isLoading) return <LoadingState label="Loading requests" />;
  if (pending.isError) {
    return <ErrorState error={pending.error} onRetry={() => void pending.refetch()} />;
  }

  const rows = pending.data ?? [];

  return (
    <div className={`page${view ? ' page--embedded' : ''}`}>
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Warehouse approvals</h1>
          <p className="pagehead__sub">
            Changes to the ledger somebody has asked for. Approving one writes
            it to the sheet.
          </p>
        </div>
      </header>

      {view ? null : (
      <div className="tabs" role="tablist">
        {([['queue', 'Waiting'], ['edits', 'Edit log'], ['deletes', 'Delete log']] as const)
          .map(([key, label]) => (
            <button key={key} type="button" role="tab"
                    aria-selected={tab === key}
                    className={`tabs__tab${tab === key ? ' is-active' : ''}`}
                    onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
      </div>
      )}

      {/* What the approvals actually did. Kept append-only in the sheet and
          shown nowhere until now — an approval that leaves no record of
          what it changed is not much of a control. */}
      {tab !== 'queue' ? <ChangeLog which={tab} /> : null}

      {tab !== 'queue' ? null : (
      <>
      {decide.isError ? (
        <p className="notice notice--warn" role="alert">
          {(decide.error as Error)?.message ?? 'That could not be decided.'}
        </p>
      ) : null}

      {!rows.length ? (
        <EmptyState title="Nothing waiting"
                    hint="Edit and delete requests appear here." />
      ) : rows.map((r) => (
        <Card key={r.id}
              title={`${r.kind === 'DELETE' ? 'Remove' : 'Change'} row ${r.rowNumber}`}
              subtitle={`${r.requestedByName} · ${new Date(r.requestedAt).toLocaleString()}`}>
          <p className="whappr__reason">{r.reason}</p>

          {r.snapshot ? (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Now</th>
                    {r.kind === 'EDIT' ? <th scope="col">Would become</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(FIELD_LABEL).map(([key, label]) => {
                    const now = (r.snapshot as any)[key];
                    const next = r.changes[key];
                    const changing = r.kind === 'EDIT' && next !== undefined
                      && String(next) !== String(now ?? '');

                    /* Only the fields that say something: an edit listing
                       eight unchanged rows buries the one that matters. */
                    if (r.kind === 'EDIT' && !changing && !now) return null;

                    return (
                      <tr key={key} className={changing ? 'is-changing' : undefined}>
                        <td>{label}</td>
                        <td className="mono">
                          {now === '' || now === 0 || now === undefined
                            ? <span className="muted">—</span> : String(now)}
                        </td>
                        {r.kind === 'EDIT' ? (
                          <td className="mono">
                            {changing
                              ? <strong>{String(next)}</strong>
                              : <span className="muted">unchanged</span>}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {r.kind === 'DELETE' ? (
            <p className="muted whappr__note">
              The row stays in the sheet with its quantities cleared. Removing
              it outright would shift every row below by one, and every other
              request waiting on a row number would then point at the wrong
              movement.
            </p>
          ) : null}

          <label className="field">
            <span className="field__label">
              Note <span className="field__opt">optional</span>
            </span>
            <input className="input" maxLength={300}
                   value={note[r.id] ?? ''}
                   onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))} />
          </label>

          <div className="modal__foot">
            {/* Refuse first: the one that writes to the sheet should not be
                where a stray Enter lands. */}
            <button type="button" className="btn btn--ghost"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({
                      id: r.id, approve: false, note: note[r.id],
                    })}>
              Refuse
            </button>
            <button type="button" className="notebtn"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({
                      id: r.id, approve: true, note: note[r.id],
                    })}>
              {decide.isPending ? 'Saving…' : 'Approve and apply'}
            </button>
          </div>
        </Card>
      ))}
      </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- change log -- */

interface Change {
  at: string; action: string; by: string;
  kind: string; reference: string;
  before: string; after: string;
  requestedBy: string; approvedBy: string; approvedAt: string;
}

/**
 * What was edited, or what was deleted.
 *
 * Before and after side by side, because the useful question about a change
 * is what it changed — not that one happened. Newest first: the thing being
 * looked for is almost always recent.
 */
function ChangeLog({ which }: { which: 'edits' | 'deletes' }) {
  const log = useQuery({
    queryKey: ['wh', 'approval-log', which],
    queryFn: () => api<Change[]>(`/warehouse/approvals/log/${which}`),
  });

  if (log.isLoading) return <LoadingState label="Reading the log" />;
  if (log.isError) {
    return <ErrorState error={log.error} onRetry={() => void log.refetch()} />;
  }

  const rows = log.data ?? [];
  const title = which === 'edits' ? 'Edit log' : 'Delete log';

  if (!rows.length) {
    return (
      <Card title={title}>
        <EmptyState icon="list" title="Nothing yet"
                    hint={which === 'edits'
                      ? 'No approved edit has been applied.'
                      : 'Nothing has been deleted.'} />
      </Card>
    );
  }

  return (
    <Card title={title} subtitle={`${rows.length} most recent, newest first.`}>
      <div className="tablewrap tablewrap--scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Kind</th>
              <th scope="col">Reference</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Asked by</th>
              <th scope="col">Approved by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={i}>
                <td className="mono">{c.at}</td>
                <td>{c.kind || '—'}</td>
                <td className="mono">{c.reference || '—'}</td>
                <td className="muted">{c.before || '—'}</td>
                {/* A delete has no after, and showing an empty cell says
                    that more plainly than repeating the before would. */}
                <td className="muted">{c.after || '—'}</td>
                <td>{c.requestedBy || c.by || '—'}</td>
                <td>{c.approvedBy || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}