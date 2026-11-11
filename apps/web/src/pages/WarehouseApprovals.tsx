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

export function WarehouseApprovals() {
  const qc = useQueryClient();
  const [note, setNote] = useState<Record<string, string>>({});

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
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Warehouse approvals</h1>
          <p className="pagehead__sub">
            Changes to the ledger somebody has asked for. Approving one writes
            it to the sheet.
          </p>
        </div>
      </header>

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
    </div>
  );
}