/**
 * Posting a stock movement.
 *
 * One form for all nine kinds rather than nine screens. The kind decides what
 * it asks for — a transfer needs somewhere to go, a receiving needs a patch
 * number, `Shortage & Over` needs a direction — and the sidebar entries are
 * the same form arriving with the kind already chosen, which is what the Apps
 * Script's separate Receiving/Transfer/Returns tabs actually are.
 *
 * Everything here is also checked on the server. What this does is stop
 * somebody filling a form for a minute before being told the warehouse has
 * none of it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WarehouseBalance, WarehouseItem, WarehousePlace, WarehouseTxType,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/Searchselect';
import { ErrorState, LoadingState } from '../components/States';

interface Line { id: string; item: string; quantity: string; }

const blankLine = (): Line => ({
  id: Math.random().toString(36).slice(2), item: '', quantity: '',
});

export function WarehousePost({ fixedType }: { fixedType?: string }) {
  const qc = useQueryClient();

  const [type, setType] = useState(fixedType ?? '');
  const [warehouse, setWarehouse] = useState('');
  const [location, setLocation] = useState('');
  const [toWarehouse, setToWarehouse] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [nationalOrder, setNationalOrder] = useState('');
  const [globalOrder, setGlobalOrder] = useState('');
  const [patch, setPatch] = useState('');
  const [direction, setDirection] = useState<'in' | 'out' | ''>('');
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [done, setDone] = useState<string | null>(null);

  /*
   * One key per attempt, not per render.
   *
   * It identifies this posting on the server, so a connection that drops
   * after the post was accepted does not put the same movement in twice when
   * the button is pressed again. A new one is minted only once a posting has
   * actually gone through.
   */
  const [opId, setOpId] = useState(() => crypto.randomUUID());

  const types = useQuery({
    queryKey: qk.whTypes,
    queryFn: () => api<WarehouseTxType[]>('/warehouse/types'),
    staleTime: 60 * 60_000,
  });

  const places = useQuery({
    queryKey: qk.whWarehouses,
    queryFn: () => api<WarehousePlace[]>('/warehouse/warehouses'),
    staleTime: 30 * 60_000,
  });

  const items = useQuery({
    queryKey: qk.whItems,
    queryFn: () => api<WarehouseItem[]>('/warehouse/items'),
    staleTime: 30 * 60_000,
  });

  const balances = useQuery({
    queryKey: qk.whBalances,
    queryFn: () => api<WarehouseBalance[]>('/warehouse/balances'),
    staleTime: 60_000,
  });

  const chosen = types.data?.find((t) => t.key === type) ?? null;
  const isTransfer = chosen?.mode === 'transfer';
  const takesStock = chosen?.mode === 'out' || isTransfer
    || (chosen?.mode === 'sel' && direction === 'out');

  const locationsOf = (code: string) =>
    places.data?.find((p) => p.code === code)?.locations ?? [];

  /* A warehouse with no sub-locations takes none, so a location left over
     from the previous choice would be sent and refused. */
  useEffect(() => { setLocation(''); }, [warehouse]);
  useEffect(() => { setToLocation(''); }, [toWarehouse]);

  /**
   * What is in the place being taken from, per item.
   *
   * Shown beside each line as it is picked. The server refuses an overdraw
   * anyway; this means somebody sees the number before filling in the rest of
   * the form rather than after.
   */
  const stockHere = useMemo(() => {
    const map = new Map<string, number>();
    if (!takesStock || !warehouse) return map;
    for (const b of balances.data ?? []) {
      if (b.warehouse !== warehouse) continue;
      if ((b.location ?? '') !== (location ?? '')) continue;
      map.set(b.item.toLowerCase(), b.balance);
    }
    return map;
  }, [balances.data, warehouse, location, takesStock]);

  const post = useMutation({
    mutationFn: () => api<{ alreadyPosted: boolean; rows: number }>('/warehouse/post', {
      method: 'POST',
      body: {
        type, opId,
        warehouse, location: location || undefined,
        toWarehouse: isTransfer ? toWarehouse : undefined,
        toLocation: isTransfer ? (toLocation || undefined) : undefined,
        nationalOrder: nationalOrder.trim() || undefined,
        globalOrder: globalOrder.trim() || undefined,
        patch: patch.trim() || undefined,
        direction: chosen?.mode === 'sel' ? (direction || undefined) : undefined,
        lines: lines
          .filter((l) => l.item && l.quantity)
          .map((l) => ({ item: l.item, quantity: Number(l.quantity) })),
      },
    }),
    onSuccess: (res) => {
      setDone(res.alreadyPosted
        ? 'That was already posted — nothing was added a second time.'
        : `Posted. ${res.rows} row${res.rows === 1 ? '' : 's'} on their way to the sheet.`);
      setLines([blankLine()]);
      setNationalOrder(''); setGlobalOrder(''); setPatch('');
      /* A fresh key: the next posting is a different posting. */
      setOpId(crypto.randomUUID());
      void qc.invalidateQueries({ queryKey: ['wh'] });
    },
  });

  const filled = lines.filter((l) => l.item && Number(l.quantity) > 0);
  const ready = !!type && !!warehouse && filled.length > 0
    && (!chosen?.needsLocation || !!location || locationsOf(warehouse).length === 0)
    && (!isTransfer || !!toWarehouse)
    && (chosen?.mode !== 'sel' || !!direction)
    && (!chosen?.needsOrder || !!(nationalOrder.trim() || globalOrder.trim()))
    && (chosen?.duplicateBy !== 'patch' || !!patch.trim())
    && !post.isPending;

  if (types.isLoading || places.isLoading) return <LoadingState label="Loading the warehouse" />;
  if (types.isError) return <ErrorState error={types.error} onRetry={() => void types.refetch()} />;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">
            {chosen ? chosen.kind : 'Post a movement'}
          </h1>
          <p className="pagehead__sub">
            Goes to the warehouse sheet. Every balance here is read from it,
            and nothing is counted anywhere else.
          </p>
        </div>
      </header>

      {done ? (
        <p className="notice" role="status">
          <Icon name="check" size={16} /> {done}
        </p>
      ) : null}

      {post.isError ? (
        <p className="notice notice--warn" role="alert">
          {(post.error as Error)?.message ?? 'That could not be posted.'}
        </p>
      ) : null}

      <div className="stackform">
        {!fixedType ? (
          <label className="field">
            <span className="field__label">Kind of movement</span>
            <SearchSelect
              value={type} onChange={(v: string) => { setType(v); setDirection(''); }}
              placeholder="Choose…"
              options={(types.data ?? []).map((t) => ({
                value: t.key, label: t.kind,
                hint: t.managerOnly ? 'needs the manage permission' : undefined,
              }))} />
          </label>
        ) : null}

        {chosen?.mode === 'sel' ? (
          <label className="field">
            <span className="field__label">Which way</span>
            {/* `Shortage & Over` can go either way, and the server refuses it
                without an answer rather than guessing. */}
            <select className="input" value={direction}
                    onChange={(e) => setDirection(e.target.value as any)}>
              <option value="">Choose…</option>
              <option value="in">Stock in — there is more than the ledger says</option>
              <option value="out">Stock out — there is less</option>
            </select>
          </label>
        ) : null}

        <div className="formrow">
          <label className="field">
            <span className="field__label">
              {isTransfer ? 'Out of which warehouse' : 'Warehouse'}
            </span>
            <SearchSelect
              value={warehouse} onChange={setWarehouse}
              placeholder="Choose…"
              options={(places.data ?? []).map((p) => ({ value: p.code, label: p.code }))} />
          </label>

          {locationsOf(warehouse).length ? (
            <label className="field">
              <span className="field__label">
                Location{chosen?.needsLocation ? '' : ' '}
                {chosen?.needsLocation ? null : <span className="field__opt">optional</span>}
              </span>
              <SearchSelect
                value={location} onChange={setLocation}
                placeholder="Choose…"
                options={locationsOf(warehouse).map((l) => ({ value: l, label: l }))} />
            </label>
          ) : null}
        </div>

        {isTransfer ? (
          <div className="formrow">
            <label className="field">
              <span className="field__label">Into which warehouse</span>
              <SearchSelect
                value={toWarehouse} onChange={setToWarehouse}
                placeholder="Choose…"
                options={(places.data ?? []).map((p) => ({ value: p.code, label: p.code }))} />
            </label>
            {locationsOf(toWarehouse).length ? (
              <label className="field">
                <span className="field__label">Location</span>
                <SearchSelect
                  value={toLocation} onChange={setToLocation}
                  placeholder="Choose…"
                  options={locationsOf(toWarehouse).map((l) => ({ value: l, label: l }))} />
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="formrow">
          {chosen?.needsOrder ? (
            <>
              <label className="field">
                <span className="field__label">
                  Local order number <span className="field__opt">or the global one</span>
                </span>
                <input className="input mono" value={nationalOrder} maxLength={60}
                       onChange={(e) => setNationalOrder(e.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Global order number</span>
                <input className="input mono" value={globalOrder} maxLength={60}
                       onChange={(e) => setGlobalOrder(e.target.value)} />
              </label>
            </>
          ) : null}

          {chosen?.duplicateBy === 'patch' ? (
            <label className="field">
              <span className="field__label">Patch number</span>
              <input className="input mono" value={patch} maxLength={60}
                     onChange={(e) => setPatch(e.target.value)} />
            </label>
          ) : null}
        </div>

        {/* ------------------------------------------------------ lines -- */}

        <div className="whlines">
          <div className="whlines__head">
            <span className="field__label">Items</span>
            {takesStock && warehouse ? (
              <span className="whlines__note">
                showing what {warehouse}{location ? ` / ${location}` : ''} holds
              </span>
            ) : null}
          </div>

          {lines.map((line) => {
            const have = stockHere.get(line.item.toLowerCase());
            const want = Number(line.quantity);
            /* Red only once both are known and the sum is wrong — a half
               filled line is not a mistake yet. */
            const over = takesStock && have !== undefined && want > 0 && want > have;

            return (
              <div className="whline" key={line.id}>
                <SearchSelect
                  value={line.item}
                  onChange={(v: string) => setLines((ls) =>
                    ls.map((l) => (l.id === line.id ? { ...l, item: v } : l)))}
                  placeholder="Find an item…"
                  options={(items.data ?? []).map((it) => ({
                    value: it.name, label: it.name, hint: it.code,
                  }))} />

                <input className="input whline__qty" type="number" min="1" step="1"
                       placeholder="Qty" value={line.quantity}
                       aria-invalid={over}
                       onChange={(e) => setLines((ls) =>
                         ls.map((l) => (l.id === line.id ? { ...l, quantity: e.target.value } : l)))} />

                {takesStock && line.item ? (
                  <span className={`whline__have${over || (have ?? 0) <= 0 ? ' is-bad' : ''}`}>
                    {have === undefined ? '—' : `${have} here`}
                  </span>
                ) : <span className="whline__have" />}

                <button type="button" className="iconbtn" aria-label="Remove this line"
                        disabled={lines.length === 1}
                        onClick={() => setLines((ls) => ls.filter((l) => l.id !== line.id))}>
                  <Icon name="minus" size={15} />
                </button>
              </div>
            );
          })}

          <button type="button" className="btn btn--ghost"
                  onClick={() => setLines((ls) => [...ls, blankLine()])}>
            Add another item
          </button>
        </div>

        <div className="modal__foot">
          <button type="button" className="notebtn" disabled={!ready}
                  onClick={() => { setDone(null); post.mutate(); }}>
            {post.isPending ? 'Posting…'
             : `Post ${filled.length || ''} item${filled.length === 1 ? '' : 's'}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}