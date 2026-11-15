/**
 * The dashboard panels that answer a question rather than show a total.
 *
 * Each one is in the Apps Script and each is built here from the portal's own
 * pieces — `Card`, the `.tile .kpi` tiles, `CategoryChart`, `SearchSelect`.
 * The thresholds and definitions are the Apps Script's, so a number somebody
 * already reads keeps meaning what it meant.
 */
import { useState } from 'react';
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
  const detail = useQuery({
    queryKey: ['wh', 'warehouse-detail'],
    queryFn: () => api<WarehouseDetail[]>('/warehouse/dashboard/warehouses'),
    staleTime: 60_000,
  });

  if (detail.isLoading) return <LoadingState label="Reading the warehouses" />;
  if (detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  return (
    <Card title="Your warehouses"
          subtitle="What is inside each one, and how it is split.">
      <div className="whgrid">
        {(detail.data ?? []).map((w) => (
          <div className="whbox" key={w.code}>
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
          </div>
        ))}
      </div>
    </Card>
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
          subtitle={`How many days the stock in WH-02 lasts at the pace of the last ${f.paceDays} days.`}
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