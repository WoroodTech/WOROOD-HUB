/**
 * The dashboard panels that answer a question rather than show a total.
 *
 * Each one is in the Apps Script and each is built here from the portal's own
 * pieces — `Card`, the `.tile .kpi` tiles, `CategoryChart`, `SearchSelect`.
 * The thresholds and definitions are the Apps Script's, so a number somebody
 * already reads keeps meaning what it meant.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CategoryPayload, WarehouseItem } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/Searchselect';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { CategoryChart } from '../charts/CategoryChart';

/* ============================================ warehouse breakdown ======= */

interface WarehouseDetail {
  code: string;
  purpose: string;
  total: number;
  locations: { label: string; pieces: number; share: number }[];
}

export function WarehouseBreakdown() {
  /* Which warehouse the reader has opened, if any. */
  const [open, setOpen] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['wh', 'warehouse-detail'],
    queryFn: () => api<WarehouseDetail[]>('/warehouse/dashboard/warehouses'),
    staleTime: 60_000,
    refetchInterval: 10_000,
  });

  if (detail.isLoading) return <LoadingState label="Reading the warehouses" />;
  if (detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  return (
    <Card title="Your warehouses"
          subtitle="What is inside each one, and how it is split.">
      <div className="whgrid whgrid--wide">
        {(detail.data ?? []).map((w) => (
          /* A button, because the question a total raises is what is inside
             it — and the answer was two screens away. */
          <button type="button" className="whbox whbox--pick" key={w.code}
                  onClick={() => setOpen(w.code)}>
            <div className="whbox__head">
              <span className="whbox__code mono">{w.code}</span>
              <span className="whbox__purpose">{w.purpose}</span>
            </div>
            <p className="whbox__total">{w.total.toLocaleString()}</p>

            {w.locations.length ? (
              <ul className="whbox__locs">
                {w.locations.map((l) => (
                  <li key={l.label}>
                    <span className="whbox__loc">{l.label}</span>
                    {/* The bar makes the split readable at a glance; the
                        number is there for anyone who wants it exactly. */}
                    <span className="whbox__bar"
                          style={{ '--w': `${l.share}%` } as any} />
                    <span className="whbox__n mono">
                      {l.pieces.toLocaleString()}
                      <small>{l.share}%</small>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="whbox__none">no locations inside</p>
            )}
          </button>
        ))}
      </div>

      {open ? (
        <WarehouseInventoryDialog code={open} onClose={() => setOpen(null)} />
      ) : null}
    </Card>
  );
}

interface InventoryRow {
  item: string;
  total: number;
  locations: { label: string; pieces: number }[];
  elsewhere: { warehouse: string; pieces: number }[];
}

/**
 * What is inside one warehouse, searchable.
 *
 * Each row also shows the same item in every other warehouse, because the
 * question after "how many Sira in WH-02" is almost always "and where is the
 * rest" — and answering that from another screen means carrying the first
 * number in your head while you go and look.
 */
function WarehouseInventoryDialog({ code, onClose }: {
  code: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = useQuery({
    queryKey: ['wh', 'warehouse-inventory', code],
    queryFn: () => api<{
      warehouse: string; items: number; total: number; rows: InventoryRow[];
    }>(`/warehouse/dashboard/warehouses/${encodeURIComponent(code)}`),
  });

  const needle = q.trim().toLowerCase();
  const rows = (data.data?.rows ?? []).filter(
    (r) => !needle || r.item.toLowerCase().includes(needle));

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Inside ${code}`}>
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel">
        <div className="confirm__body">
          <h2 className="confirm__title">
            Inside {code}
            {data.data ? (
              <span className="muted">
                {' '}· {data.data.items} items · {data.data.total.toLocaleString()} pieces
              </span>
            ) : null}
          </h2>

          <label className="field">
            <span className="field__label">Search</span>
            <input className="input" value={q} autoFocus placeholder="Item name…"
                   onChange={(e) => setQ(e.target.value)} />
          </label>

          {data.isLoading ? <LoadingState label="Reading the warehouse" />
           : data.isError ? <ErrorState error={data.error} compact />
           : !rows.length ? (
             <p className="muted">
               {needle ? 'Nothing matches that.' : 'Nothing inside.'}
             </p>
           ) : (
            <div className="tablewrap tablewrap--scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className="is-end">Here</th>
                    <th scope="col">Split</th>
                    <th scope="col">Elsewhere</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.item}>
                      <td>{r.item}</td>
                      <td className="is-end mono">{r.total.toLocaleString()}</td>
                      <td className="muted">
                        {r.locations.map((l) => `${l.label}: ${l.pieces}`).join(' · ')}
                      </td>
                      <td className="muted">
                        {r.elsewhere.length
                          ? r.elsewhere.map((e) => `${e.warehouse}: ${e.pieces}`).join(' · ')
                          : 'nowhere else'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="confirm__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================ item search ============== */

interface FoundItem {
  item: WarehouseItem | null;
  total: number;
  retired: { warehouse: string; location: string; pieces: number }[];
  warehouses: {
    code: string; purpose: string; pieces: number; share: number;
    locations: { label: string; pieces: number; share: number }[];
  }[];
}

export function WarehouseFindItem() {
  const [item, setItem] = useState('');

  const items = useQuery({
    queryKey: qk.whItems,
    queryFn: () => api<WarehouseItem[]>('/warehouse/items'),
    staleTime: 30 * 60_000,
  });

  const found = useQuery({
    queryKey: ['wh', 'find', item],
    queryFn: () => api<FoundItem>(
      `/warehouse/dashboard/find?item=${encodeURIComponent(item)}`),
    enabled: !!item,
  });

  return (
    <Card title="Where is it?"
          subtitle="Pick an item to see how much of it sits in each warehouse.">
      <SearchSelect
        value={item} onChange={setItem}
        placeholder="Search by name or code…"
        options={(items.data ?? []).map((i) => ({
          value: i.name, label: i.name, hint: i.code,
        }))} />

      {!item ? null
       : found.isLoading ? <LoadingState label="Looking it up" />
       : found.isError ? (
         <ErrorState error={found.error} onRetry={() => void found.refetch()} />
       ) : !found.data!.warehouses.length ? (
         <EmptyState title="None in stock"
                     hint="This item has no balance in any counted warehouse." />
       ) : (
         <>
           <p className="whfind__total">
             <strong>{found.data!.total.toLocaleString()}</strong> pieces
             across {found.data!.warehouses.length} warehouse
             {found.data!.warehouses.length === 1 ? '' : 's'}
           </p>

           <div className="whgrid">
             {found.data!.warehouses.map((w) => (
               <div className="whbox" key={w.code}>
                 <div className="whbox__head">
                   <span className="whbox__code mono">{w.code}</span>
                   <span className="whbox__purpose">{w.purpose}</span>
                 </div>
                 <p className="whbox__total">
                   {w.pieces.toLocaleString()}
                   <small className="whbox__share">{w.share}% of all</small>
                 </p>

                 {w.locations.length ? (
                   <ul className="whbox__locs">
                     {w.locations.map((l) => (
                       <li key={l.label}>
                         <span className="whbox__loc">{l.label}</span>
                         <span className="whbox__bar"
                               style={{ '--w': `${l.share}%` } as any} />
                         <span className="whbox__n mono">
                           {l.pieces.toLocaleString()}
                           <small>{l.share}%</small>
                         </span>
                       </li>
                     ))}
                   </ul>
                 ) : null}
               </div>
             ))}
           </div>

           {found.data!.retired.length ? (
             <p className="muted whfind__retired">
               <Icon name="info" size={14} /> Also{' '}
               {found.data!.retired.map((r) =>
                 `${r.pieces} in ${r.warehouse}${r.location ? ` / ${r.location}` : ''}`)
                 .join(', ')}
               {' '}— warehouses no longer counted, so not in the total above.
             </p>
           ) : null}
         </>
       )}
    </Card>
  );
}

/* ============================================ run-out forecast ========= */

interface RunOut {
  bands: { urgent: number; soon: number };
  paceDays: number;
  rows: {
    item: string; pieces: number; perDay: number;
    days: number; band: 'urgent' | 'soon' | 'ok';
  }[];
  weeksAhead: number;
  /** Pieces left at the end of each week ahead, floored at zero. */
  outlook: { item: string; weeks: number[] }[];
}

export function WarehouseRunOut({ onPick }: { onPick?: (item: string) => void }) {
  const forecast = useQuery({
    queryKey: ['wh', 'run-out'],
    queryFn: () => api<RunOut>('/warehouse/dashboard/run-out'),
    staleTime: 60_000,
  });

  if (forecast.isLoading) return <LoadingState label="Working out the pace" />;
  if (forecast.isError) {
    return <ErrorState error={forecast.error} onRetry={() => void forecast.refetch()} />;
  }

  const f = forecast.data!;
  /* The widest bar is the longest run-out on screen, so the shape is
     readable whether that is nine days or ninety. */
  const widest = Math.max(...f.rows.map((r) => r.days), f.bands.soon * 2);

  return (
    <Card title="Run-out forecast"
          subtitle={`How long the stock in WH-02 lasts at the pace of the last `
            + `${f.paceDays} days, and what is left at the end of each of the `
            + `next ${f.weeksAhead} weeks.`}
          actions={
            <span className="fcleg">
              <span><i className="fcleg__dot is-urgent" /> under {f.bands.urgent} days</span>
              <span><i className="fcleg__dot is-soon" /> {f.bands.urgent}–{f.bands.soon}</span>
              <span><i className="fcleg__dot is-ok" /> over {f.bands.soon}</span>
            </span>
          }>
      {!f.rows.length ? (
        <EmptyState title="Nothing to forecast"
                    hint={`Nothing sold out of WH-02 in the last ${f.paceDays} days.`} />
      ) : (
        <ul className="fclist">
          {f.rows.map((r) => (
            <li key={r.item}>
              <button type="button" className="fcrow"
                      onClick={() => onPick?.(r.item)}
                      title={`${r.pieces} in stock · selling ${r.perDay} a day`}>
                <span className="fcrow__name">{r.item}</span>
                <span className="fcrow__track">
                  <i className={`fcrow__fill is-${r.band}`}
                     style={{ '--w': `${Math.max(2, (r.days / widest) * 100)}%` } as any} />
                </span>
                <span className={`fcrow__days is-${r.band}`}>
                  <strong>{r.days < 1 ? '<1' : Math.round(r.days)}</strong> days
                </span>
              </button>

              {/*
                * What is left at the end of each week.
                *
                * "Runs out in nine days" answers when; ordering asks what
                * will be on the shelf when the delivery lands, which is a
                * week or three from now. Zero is shown as a dash rather than
                * a nought, so an empty week reads as empty at a glance.
                */}
              {(() => {
                const weeks = f.outlook.find((o) => o.item === r.item)?.weeks;
                if (!weeks?.length) return null;
                return (
                  <span className="fcweeks">
                    {weeks.map((left, i) => (
                      <span key={i}
                            className={`fcweeks__cell${left ? '' : ' is-out'}`}
                            title={`End of week ${i + 1}`}>
                        <i className="fcweeks__label">w{i + 1}</i>
                        {left ? left : '—'}
                      </span>
                    ))}
                  </span>
                );
              })()}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ============================================ collections ============== */

export function WarehouseCollections({ warehouse }: { warehouse?: string }) {
  const collections = useQuery({
    queryKey: ['wh', 'collections', warehouse ?? ''],
    queryFn: () => api<CategoryPayload & { scope: string | null }>(
      `/warehouse/dashboard/collections${warehouse ? `?warehouse=${warehouse}` : ''}`),
    staleTime: 60_000,
  });

  return (
    <Card title="Stock by collection"
          subtitle={warehouse ? `In ${warehouse}` : 'All warehouses'}>
      {collections.isLoading ? <LoadingState label="Grouping" />
       : collections.isError ? (
         <ErrorState error={collections.error}
                     onRetry={() => void collections.refetch()} />
       ) : <CategoryChart payload={collections.data!} height={260} />}
    </Card>
  );
}

/* ============================================ defects ================== */

export function WarehouseDefects({ onPick }: { onPick?: (item: string) => void }) {
  const defects = useQuery({
    queryKey: ['wh', 'defects'],
    queryFn: () => api<{ item: string; pieces: number }[]>('/warehouse/dashboard/defects'),
    staleTime: 60_000,
  });

  return (
    <Card title="Most defects"
          subtitle="Items with the most pieces sitting in WH-04.">
      {defects.isLoading ? <LoadingState label="Counting" />
       : defects.isError ? (
         <ErrorState error={defects.error} onRetry={() => void defects.refetch()} />
       ) : !defects.data?.length ? (
         <EmptyState title="Nothing in WH-04" hint="No defects on hand." />
       ) : (
         <ul className="attlist">
           {defects.data.map((d) => (
             <li key={d.item}>
               <button type="button" className="attrow"
                       onClick={() => onPick?.(d.item)}>
                 <span className="attrow__name">{d.item}</span>
                 <span className="attrow__n mono">{d.pieces.toLocaleString()}</span>
               </button>
             </li>
           ))}
         </ul>
       )}
    </Card>
  );
}