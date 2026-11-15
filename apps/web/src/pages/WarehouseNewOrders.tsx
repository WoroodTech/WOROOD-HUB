/**
 * New orders — a patch of Shopify orders.
 *
 * The keeper works from a printed sheet: type a reference, the items arrive
 * from Shopify, add the next order, and save the patch when the sheet is
 * done. Nothing is written until the last step, because the orders are one
 * piece of paper and a half-posted patch cannot be told apart from a whole
 * one.
 *
 * The patch number and the warehouse are decided by the server and shown
 * rather than asked for.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Confirmdialog';
import { ErrorState, LoadingState } from '../components/States';

interface Line { item: string; quantity: number; onHand: number; known: boolean }
interface PatchOrder { reference: string; scope: 'local' | 'global'; lines: Line[] }

export function WarehouseNewOrders() {
  const qc = useQueryClient();
  const [orders, setOrders] = useState<PatchOrder[]>([]);
  const [reference, setReference] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const patch = useQuery({
    queryKey: ['wh', 'next-patch'],
    queryFn: () => api<string>('/warehouse/orders/next-patch'),
  });

  const lookup = useMutation({
    mutationFn: (ref: string) =>
      api<PatchOrder>(`/warehouse/orders/lookup?reference=${encodeURIComponent(ref)}`),
    onSuccess: (order) => {
      setOrders((o) => [...o, order]);
      setReference('');
    },
  });

  const save = useMutation({
    mutationFn: () => api<{ patch: string; orders: number; rows: number; pieces: number }>(
      '/warehouse/orders/patch', { method: 'POST', body: { orders } }),
    onSuccess: (res) => {
      setDone(`Patch ${res.patch} saved — ${res.orders} order`
        + `${res.orders === 1 ? '' : 's'}, ${res.pieces} pieces.`);
      setOrders([]);
      void qc.invalidateQueries({ queryKey: ['wh'] });
    },
  });

  const alreadyAdded = (ref: string) =>
    orders.some((o) => o.reference.replace(/^#/, '').toLowerCase()
      === ref.trim().replace(/^#/, '').toLowerCase());

  const pieces = orders.reduce(
    (n, o) => n + o.lines.reduce((m, l) => m + l.quantity, 0), 0);
  const unknown = orders.flatMap((o) => o.lines.filter((l) => !l.known));

  /*
   * What WH-02 would hold once the whole patch is taken.
   *
   * Several orders on one patch can want the same item, and each on its own
   * can fit while together they do not — so the running figure is what the
   * keeper needs to see, not the starting one.
   */
  const shortfall = (() => {
    const left = new Map<string, number>();
    for (const o of orders) {
      for (const l of o.lines) {
        const key = l.item.toLowerCase();
        if (!left.has(key)) left.set(key, l.onHand);
        left.set(key, left.get(key)! - l.quantity);
      }
    }
    return [...left.entries()].filter(([, n]) => n < 0);
  })();

  if (patch.isLoading) return <LoadingState label="Reading the last patch" />;
  if (patch.isError) {
    return <ErrorState error={patch.error} onRetry={() => void patch.refetch()} />;
  }

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">New orders</h1>
          <p className="pagehead__sub">
            Book a sheet of Shopify orders against one patch. Nothing is
            written until you save.
          </p>
        </div>
      </header>

      {done ? (
        <p className="notice" role="status">
          <Icon name="check" size={16} /> {done}
        </p>
      ) : null}

      <div className="grid">
        <div className="grid__cell" style={{ '--span': 4 } as any}>
          <div className="tile"><div className="kpi">
            <div className="kpi__top"><p className="kpi__label">Patch</p></div>
            <p className="kpi__value mono">{patch.data}</p>
            <p className="kpi__sub">the next one · fixed</p>
          </div></div>
        </div>
        <div className="grid__cell" style={{ '--span': 4 } as any}>
          <div className="tile"><div className="kpi">
            <div className="kpi__top"><p className="kpi__label">Out of</p></div>
            <p className="kpi__value mono">WH-02</p>
            <p className="kpi__sub">everything sells from here</p>
          </div></div>
        </div>
        <div className="grid__cell" style={{ '--span': 4 } as any}>
          <div className="tile"><div className="kpi">
            <div className="kpi__top"><p className="kpi__label">On this patch</p></div>
            <p className="kpi__value">{orders.length}</p>
            <p className="kpi__sub">
              {pieces} piece{pieces === 1 ? '' : 's'}
            </p>
          </div></div>
        </div>
      </div>

      <Card title="Add an order">
        <div className="formrow">
          <label className="field">
            <span className="field__label">Order number</span>
            <input className="input mono" value={reference} maxLength={60}
                   placeholder="#1234"
                   autoFocus
                   onChange={(e) => setReference(e.target.value)}
                   onKeyDown={(e) => {
                     if (e.key === 'Enter' && reference.trim()
                         && !alreadyAdded(reference)) {
                       lookup.mutate(reference.trim());
                     }
                   }} />
          </label>
          <div className="modal__foot" style={{ alignSelf: 'end' }}>
            <button type="button" className="notebtn"
                    disabled={!reference.trim() || lookup.isPending
                      || alreadyAdded(reference)}
                    onClick={() => lookup.mutate(reference.trim())}>
              {lookup.isPending ? 'Looking it up…' : 'Next order'}
            </button>
          </div>
        </div>

        {alreadyAdded(reference) && reference.trim() ? (
          <p className="notice notice--warn">That order is already on this patch.</p>
        ) : null}

        {lookup.isError ? (
          <p className="notice notice--warn">{(lookup.error as Error)?.message}</p>
        ) : null}
      </Card>

      {unknown.length ? (
        <p className="notice notice--warn" role="alert">
          {/* Shown rather than hidden: an order that looks complete and is
              not is the worse failure. */}
          <Icon name="info" size={16} /> {unknown.length} line
          {unknown.length === 1 ? '' : 's'} are not items in the sheet —{' '}
          {unknown.map((l) => l.item).slice(0, 3).join(', ')}
          {unknown.length > 3 ? ', …' : ''}. Create them first, or take them
          off the patch.
        </p>
      ) : null}

      {shortfall.length ? (
        <p className="notice notice--warn" role="alert">
          <Icon name="info" size={16} /> WH-02 does not hold enough for the
          whole patch: {shortfall.map(([item, n]) => `${item} (${-n} short)`)
            .slice(0, 3).join(', ')}.
        </p>
      ) : null}

      {orders.map((o, i) => (
        <Card key={o.reference}
              title={o.reference}
              subtitle={`${o.scope === 'global' ? 'Global' : 'Local'} · `
                + `${o.lines.reduce((n, l) => n + l.quantity, 0)} pieces`}
              actions={
                <button type="button" className="btn btn--ghost"
                        onClick={() => setOrders((os) => os.filter((_, j) => j !== i))}>
                  Remove
                </button>
              }>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="is-end">Quantity</th>
                  <th scope="col" className="is-end">In WH-02</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l, j) => (
                  <tr key={j}>
                    <td>
                      {l.item}
                      {!l.known ? (
                        <small className="muted"> · not in the sheet</small>
                      ) : null}
                    </td>
                    <td className="is-end mono">{l.quantity}</td>
                    <td className={`is-end mono${l.known && l.onHand < l.quantity
                      ? ' whline__have is-bad' : ''}`}>
                      {l.known ? l.onHand : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {orders.length ? (
        <div className="modal__foot">
          <button type="button" className="notebtn"
                  disabled={save.isPending || !!unknown.length || !!shortfall.length}
                  onClick={() => setConfirming(true)}>
            {save.isPending ? 'Saving…' : `Save patch ${patch.data}`}
          </button>
        </div>
      ) : null}

      {save.isError ? (
        <p className="notice notice--warn" role="alert">
          {(save.error as Error)?.message}
        </p>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Save patch ${patch.data}?`}
          body={`${orders.length} order${orders.length === 1 ? '' : 's'}, `
            + `${pieces} pieces out of WH-02. All of them go to the sheet `
            + 'together — this is the point at which stock moves.'}
          confirmLabel="Save the patch"
          busy={save.isPending}
          onConfirm={() => { setConfirming(false); setDone(null); save.mutate(); }}
          onCancel={() => setConfirming(false)} />
      ) : null}
    </div>
  );
}