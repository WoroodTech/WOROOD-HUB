/**
 * The three screens that look an item or a movement up.
 *
 * `ItemCard` answers "where is it"; `FindEdit` answers "what happened to it";
 * `CreateItem` adds one. They share the catalogue and the balance read, so
 * they live together rather than fetching the same two things three times.
 *
 * Built from the portal's own pieces — `Card`, `SearchSelect`, the KPI tiles,
 * the table styles. Nothing here is a warehouse-shaped copy of something that
 * already exists.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WarehouseBalance, WarehouseItem, WarehouseMovement,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/Searchselect';
import { ErrorState, EmptyState, LoadingState } from '../components/States';

/* ===================================================== item card ======== */

export function WarehouseItemCard() {
  const [item, setItem] = useState('');

  const items = useQuery({
    queryKey: qk.whItems,
    queryFn: () => api<WarehouseItem[]>('/warehouse/items'),
    staleTime: 30 * 60_000,
  });

  const balances = useQuery({
    queryKey: qk.whItemBalances(item),
    queryFn: () => api<WarehouseBalance[]>(
      `/warehouse/item/${encodeURIComponent(item)}/balances`),
    enabled: !!item,
  });

  const movements = useQuery({
    queryKey: qk.whMovements(`item=${item}`),
    queryFn: () => api<WarehouseMovement[]>(
      `/warehouse/movements?item=${encodeURIComponent(item)}&limit=50`),
    enabled: !!item,
  });

  const chosen = items.data?.find((i) => i.name === item);
  const total = (balances.data ?? []).reduce((n, b) => n + b.balance, 0);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Item card</h1>
          <p className="pagehead__sub">
            Where one item sits, and what has happened to it.
          </p>
        </div>
      </header>

      <Card title="Find an item">
        <SearchSelect
          value={item} onChange={setItem}
          placeholder="Search by name or code…"
          options={(items.data ?? []).map((i) => ({
            value: i.name, label: i.name, hint: i.code,
          }))} />
      </Card>

      {!item ? (
        <EmptyState title="Pick an item"
                    hint="Its balance in every warehouse, and its recent movements." />
      ) : balances.isLoading ? <LoadingState label="Reading balances" />
      : balances.isError ? (
        <ErrorState error={balances.error} onRetry={() => void balances.refetch()} />
      ) : (
        <>
          <div className="grid">
            <div className="grid__cell" style={{ '--span': 4 } as any}>
              <div className="tile"><div className="kpi">
                <div className="kpi__top"><p className="kpi__label">On hand</p></div>
                <p className="kpi__value">{total.toLocaleString()}</p>
                <p className="kpi__sub">
                  across {(balances.data ?? []).filter((b) => b.balance !== 0).length} places
                </p>
              </div>
              </div>
            </div>
            {chosen ? (
              <>
                <div className="grid__cell" style={{ '--span': 4 } as any}>
                  <div className="tile"><div className="kpi">
                    <div className="kpi__top"><p className="kpi__label">Code</p></div>
                    <p className="kpi__value mono">{chosen.code}</p>
                    <p className="kpi__sub">{chosen.group}</p>
                  </div>
                  </div>
                </div>
                <div className="grid__cell" style={{ '--span': 4 } as any}>
                  <div className="tile"><div className="kpi">
                    <div className="kpi__top"><p className="kpi__label">Made of</p></div>
                    <p className="kpi__value" style={{ fontSize: '1.1rem' }}>
                      {chosen.material}
                    </p>
                    <p className="kpi__sub">{chosen.color} · {chosen.kind}</p>
                  </div>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <Card title="Where it is">
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Warehouse</th>
                    <th scope="col">Location</th>
                    <th scope="col" className="is-end">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(balances.data ?? [])
                    .filter((b) => b.balance !== 0)
                    .sort((a, b) => b.balance - a.balance)
                    .map((b) => (
                      <tr key={`${b.warehouse}|${b.location}`}>
                        <td className="mono">{b.warehouse}</td>
                        <td>{b.location || <span className="muted">—</span>}</td>
                        {/* Red below zero: it is the one number on this
                            screen that means somebody has to go and count. */}
                        <td className={`is-end mono${b.balance < 0 ? ' whline__have is-bad' : ''}`}>
                          {b.balance.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Recent movements">
            {movements.isLoading ? <LoadingState label="Reading the ledger" />
             : !movements.data?.length ? (
               <EmptyState title="Nothing yet" hint="No movements for this item." />
             ) : <MovementTable rows={movements.data} />}
          </Card>
        </>
      )}
    </div>
  );
}

/* ===================================================== find / edit ====== */

export function WarehouseFind() {
  const [filters, setFilters] = useState({ item: '', warehouse: '', order: '', patch: '' });
  const [asked, setAsked] = useState('');

  const items = useQuery({
    queryKey: qk.whItems,
    queryFn: () => api<WarehouseItem[]>('/warehouse/items'),
    staleTime: 30 * 60_000,
  });

  const movements = useQuery({
    queryKey: qk.whMovements(asked),
    queryFn: () => api<WarehouseMovement[]>(`/warehouse/movements?${asked}&limit=200`),
    enabled: !!asked,
  });

  const search = () => {
    const q = new URLSearchParams();
    if (filters.item) q.set('item', filters.item);
    if (filters.warehouse) q.set('warehouse', filters.warehouse);
    if (filters.order) q.set('order', filters.order.trim());
    if (filters.patch) q.set('patch', filters.patch.trim());
    setAsked(q.toString());
  };

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Find a movement</h1>
          <p className="pagehead__sub">
            Look one up by item, order or patch. Changing or removing one is a
            request a manager decides.
          </p>
        </div>
      </header>

      <Card title="Search">
        <div className="formrow">
          <label className="field">
            <span className="field__label">Item</span>
            <SearchSelect
              value={filters.item}
              onChange={(v: string) => setFilters((f) => ({ ...f, item: v }))}
              placeholder="Any item"
              options={(items.data ?? []).map((i) => ({ value: i.name, label: i.name }))} />
          </label>
          <label className="field">
            <span className="field__label">Order number</span>
            <input className="input mono" value={filters.order} maxLength={60}
                   onChange={(e) => setFilters((f) => ({ ...f, order: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field__label">Patch number</span>
            <input className="input mono" value={filters.patch} maxLength={60}
                   onChange={(e) => setFilters((f) => ({ ...f, patch: e.target.value }))} />
          </label>
        </div>
        <div className="modal__foot">
          <button type="button" className="notebtn" onClick={search}
                  disabled={!filters.item && !filters.order && !filters.patch}>
            Search
          </button>
        </div>
      </Card>

      {!asked ? null
       : movements.isLoading ? <LoadingState label="Reading the ledger" />
       : movements.isError ? (
         <ErrorState error={movements.error} onRetry={() => void movements.refetch()} />
       ) : !movements.data?.length ? (
         <EmptyState title="Nothing matches" hint="Try a different reference." />
       ) : (
         <Card title={`${movements.data.length} movement${movements.data.length === 1 ? '' : 's'}`}>
           <MovementTable rows={movements.data} withRow />
         </Card>
       )}
    </div>
  );
}

/* ===================================================== create item ===== */

interface ItemOptions {
  coding: {
    colors: Record<string, string>;
    kinds: Record<string, string>;
    materials: Record<string, string>;
  };
  used: { colors: string[]; kinds: string[]; materials: string[] };
}

export function WarehouseNewItem() {
  const qc = useQueryClient();
  const [color, setColor] = useState('');
  const [kind, setKind] = useState('');
  const [material, setMaterial] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const options = useQuery({
    queryKey: qk.whCoding,
    queryFn: () => api<ItemOptions>('/warehouse/items/options'),
    staleTime: 30 * 60_000,
  });

  /* What the sheet will compute, shown as they pick. The three parts each
     have to have a code, and saying which one is missing is the difference
     between "it did not work" and "add the colour to Keys first". */
  const preview = useQuery({
    queryKey: ['wh', 'item-preview', color, kind, material],
    queryFn: () => api<{ code: string | null; name: string; group: string; missing: string[] }>(
      '/warehouse/items/preview', { method: 'POST', body: { color, kind, material } }),
    enabled: !!(color && kind && material),
  });

  const create = useMutation({
    mutationFn: () => api<{ code: string; name: string; note: string }>('/warehouse/items', {
      method: 'POST', body: { color, kind, material },
    }),
    onSuccess: (res) => {
      setDone(`${res.name} — code ${res.code}. ${res.note}`);
      setColor(''); setKind(''); setMaterial('');
      void qc.invalidateQueries({ queryKey: ['wh'] });
    },
  });

  const ready = !!(color && kind && material)
    && !!preview.data?.code && !create.isPending;

  if (options.isLoading) return <LoadingState label="Reading the coding tables" />;
  if (options.isError) {
    return <ErrorState error={options.error} onRetry={() => void options.refetch()} />;
  }

  const o = options.data!;
  const pick = (names: string[], codes: Record<string, string>) =>
    names.map((n) => ({ value: n, label: n, hint: codes[n] ?? 'no code yet' }));

  return (
    <div className="page page--narrow">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Create an item</h1>
          <p className="pagehead__sub">
            A colour, a kind and a material. The sheet works out the code, the
            name and the QR from those three.
          </p>
        </div>
      </header>

      {done ? (
        <p className="notice" role="status">
          <Icon name="check" size={16} /> {done}
        </p>
      ) : null}

      {create.isError ? (
        <p className="notice notice--warn" role="alert">
          {(create.error as Error)?.message ?? 'That could not be created.'}
        </p>
      ) : null}

      <Card title="The three parts">
        <label className="field">
          <span className="field__label">Colour</span>
          <SearchSelect value={color} onChange={setColor} placeholder="Choose…"
                        options={pick(o.used.colors, o.coding.colors)} />
        </label>
        <label className="field">
          <span className="field__label">Kind</span>
          <SearchSelect value={kind} onChange={setKind} placeholder="Choose…"
                        options={pick(o.used.kinds, o.coding.kinds)} />
        </label>
        <label className="field">
          <span className="field__label">Material</span>
          <SearchSelect value={material} onChange={setMaterial} placeholder="Choose…"
                        options={pick(o.used.materials, o.coding.materials)} />
        </label>
      </Card>

      {preview.data ? (
        <Card title="What the sheet will make">
          {preview.data.code ? (
            <div className="grid">
              <div className="grid__cell" style={{ '--span': 6 } as any}>
                <div className="tile"><div className="kpi">
                  <div className="kpi__top"><p className="kpi__label">Code</p></div>
                  <p className="kpi__value mono">{preview.data.code}</p>
                  <p className="kpi__sub">{preview.data.group}</p>
                </div>
                </div>
              </div>
              <div className="grid__cell" style={{ '--span': 6 } as any}>
                <div className="tile"><div className="kpi">
                  <div className="kpi__top"><p className="kpi__label">Name in the ledger</p></div>
                  <p className="kpi__value" style={{ fontSize: '1.05rem' }}>
                    {preview.data.name}
                  </p>
                  <p className="kpi__sub">this is what movements will say</p>
                </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="notice notice--warn">
              The Keys tab has no code for {preview.data.missing.join(', ')}.
              Add it there first — without a code the item would be created
              with <span className="mono">#N/A</span> where its code should be.
            </p>
          )}
        </Card>
      ) : null}

      <div className="modal__foot">
        <button type="button" className="notebtn" disabled={!ready}
                onClick={() => { setDone(null); create.mutate(); }}>
          {create.isPending ? 'Creating…' : 'Create the item'}
        </button>
      </div>
    </div>
  );
}

/* ===================================================== shared =========== */

function MovementTable({ rows, withRow }: {
  rows: WarehouseMovement[]; withRow?: boolean;
}) {
  return (
    <div className="tablewrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Kind</th>
            {withRow ? <th scope="col">Item</th> : null}
            <th scope="col">Reference</th>
            <th scope="col">Where</th>
            <th scope="col" className="is-end">In</th>
            <th scope="col" className="is-end">Out</th>
            <th scope="col">By</th>
            {withRow ? <th scope="col" className="is-end">Row</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.rowNumber}>
              <td className="mono">{m.date}</td>
              <td>{m.kind}</td>
              {withRow ? <td>{m.item}</td> : null}
              <td className="mono">
                {m.nationalOrder || m.globalOrder || m.patch || <span className="muted">—</span>}
              </td>
              <td className="mono">
                {m.warehouse}{m.location ? ` / ${m.location}` : ''}
              </td>
              <td className="is-end mono">{m.stockIn || ''}</td>
              <td className="is-end mono">{m.stockOut || ''}</td>
              <td>{m.enteredBy}</td>
              {/* The sheet's own row number, so somebody can go and look at
                  the line this came from. */}
              {withRow ? <td className="is-end mono muted">{m.rowNumber}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}