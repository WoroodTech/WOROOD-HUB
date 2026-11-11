/**
 * The warehouse dashboard.
 *
 * Built from the portal's own pieces: the KPI tiles the finance and sales
 * screens use, and `SeriesChart` / `CategoryChart` from `charts/`. Nothing
 * here is a warehouse-specific copy of something that already exists — a
 * second set that looked almost the same would drift apart the first time
 * either was touched.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  CategoryPayload, SeriesPayload, TablePayload, WarehousePlace,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState } from '../components/States';
import { SeriesChart } from '../charts/SeriesChart';
import { CategoryChart } from '../charts/CategoryChart';

interface Tiles {
  inStock: number;
  warehouses: number;
  low: number;
  lowAt: number;
  outOfStock: number;
  negative: number;
  /** How many item/place rows that is — usually more than the item count. */
  negativePlaces: number;
  negativeDetail: { item: string; where: string; balance: number }[];
}

interface Charts {
  trend: SeriesPayload;
  byWarehouse: CategoryPayload;
  byLocation: CategoryPayload | null;
  low: TablePayload;
}

export function WarehouseDashboard() {
  /* Which warehouse the location chart is showing. Null means none is
     chosen, and that chart is simply absent rather than empty. */
  const [focus, setFocus] = useState<string | null>(null);
  const [showNegative, setShowNegative] = useState(false);

  const tiles = useQuery({
    queryKey: ['wh', 'tiles'],
    queryFn: () => api<Tiles>('/warehouse/dashboard/tiles'),
    staleTime: 60_000,
  });

  const charts = useQuery({
    queryKey: ['wh', 'charts', focus ?? ''],
    queryFn: () => api<Charts>(
      `/warehouse/dashboard/charts${focus ? `?warehouse=${encodeURIComponent(focus)}` : ''}`),
    staleTime: 60_000,
  });

  const places = useQuery({
    queryKey: qk.whWarehouses,
    queryFn: () => api<WarehousePlace[]>('/warehouse/warehouses'),
    staleTime: 30 * 60_000,
  });

  if (tiles.isLoading) return <LoadingState label="Reading the warehouse sheet" />;
  if (tiles.isError) {
    return <ErrorState error={tiles.error} onRetry={() => void tiles.refetch()} />;
  }

  const t = tiles.data!;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Warehouse</h1>
          <p className="pagehead__sub">
            Everything here is read from the warehouse sheet, and counted the
            same way it is there.
          </p>
        </div>
      </header>

      {/* The same tiles as the finance and sales screens, with the same
          classes — so a change to how a KPI looks reaches all three. */}
      <div className="grid">
        <div className="grid__cell" style={{ '--span': 3 } as any}>
          <div className="kpi">
            <div className="kpi__top"><p className="kpi__label">Pieces in stock</p></div>
            <p className="kpi__value">{t.inStock.toLocaleString()}</p>
            <p className="kpi__sub">across {t.warehouses} warehouses</p>
          </div>
        </div>

        <div className="grid__cell" style={{ '--span': 3 } as any}>
          <div className="kpi">
            <div className="kpi__top"><p className="kpi__label">Running low</p></div>
            <p className="kpi__value">{t.low.toLocaleString()}</p>
            {/* The threshold is on the tile rather than in the code: "47
                running low" means nothing without it. */}
            <p className="kpi__sub">at {t.lowAt} pieces or fewer · sellable</p>
          </div>
        </div>

        <div className="grid__cell" style={{ '--span': 3 } as any}>
          <div className="kpi">
            <div className="kpi__top"><p className="kpi__label">Out of stock</p></div>
            <p className="kpi__value">{t.outOfStock.toLocaleString()}</p>
            {/* Sellable places only. A piece in the workshop was never
                sellable, so counting it here would make the number lie. */}
            <p className="kpi__sub">items in WH-02 · Local and Global</p>
          </div>
        </div>

        <div className="grid__cell" style={{ '--span': 3 } as any}>
          <button type="button"
                  className={`kpi kpi--pick${showNegative ? ' is-on' : ''}`}
                  aria-pressed={showNegative}
                  disabled={!t.negative}
                  onClick={() => setShowNegative((v) => !v)}>
            <div className="kpi__top"><p className="kpi__label">Negative balance</p></div>
            <p className="kpi__value">{t.negative.toLocaleString()}</p>
            <p className="kpi__sub">
              {t.negative
                ? `item${t.negative === 1 ? '' : 's'} · tap for details`
                : 'nothing below zero'}
            </p>
          </button>
        </div>
      </div>

      {showNegative && t.negativeDetail.length ? (
        <Card title="Below zero">
          <p className="muted" style={{ marginBlockStart: 0 }}>
            {t.negative} item{t.negative === 1 ? '' : 's'} across{' '}
            {t.negativePlaces} place{t.negativePlaces === 1 ? '' : 's'}, already
            below zero in the sheet. Posting cannot take anything further down,
            but it cannot put these right either — they need an Open Balance or
            a count.
          </p>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Where</th>
                  <th scope="col" className="is-end">Balance</th>
                </tr>
              </thead>
              <tbody>
                {t.negativeDetail.map((n) => (
                  <tr key={`${n.item}|${n.where}`}>
                    <td>{n.item}</td>
                    <td className="mono">{n.where}</td>
                    <td className="is-end mono">{n.balance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {charts.isLoading ? <LoadingState label="Building the charts" />
       : charts.isError ? (
         <ErrorState error={charts.error} onRetry={() => void charts.refetch()} />
       ) : (
         <>
           <Card title="Stock in and out · last 60 days">
             <SeriesChart payload={charts.data!.trend} height={260} />
           </Card>

           <div className="panes">
             <Card title="Stock by warehouse">
               <CategoryChart payload={charts.data!.byWarehouse} height={240} />

               {/* The focus picker sits with the chart it changes, rather
                   than in a toolbar away from the thing it affects. */}
               <div className="tabs" role="tablist" style={{ marginBlockStart: 12 }}>
                 {(places.data ?? []).map((p) => (
                   <button key={p.code} type="button" role="tab"
                           aria-selected={focus === p.code}
                           className={`tabs__tab${focus === p.code ? ' is-active' : ''}`}
                           disabled={!p.locations.length}
                           title={p.locations.length
                             ? `Show what is inside ${p.code}`
                             : `${p.code} has no locations inside it`}
                           onClick={() => setFocus(focus === p.code ? null : p.code)}>
                     {p.code}
                   </button>
                 ))}
               </div>
             </Card>

             <Card title={focus ? `Inside ${focus}` : 'Running low'}>
               {focus && charts.data!.byLocation ? (
                 <CategoryChart payload={charts.data!.byLocation} height={240} />
               ) : charts.data!.low.rows.length ? (
                 <div className="tablewrap">
                   <table className="table">
                     <thead>
                       <tr>
                         <th scope="col">Item</th>
                         <th scope="col" className="is-end">Sellable</th>
                       </tr>
                     </thead>
                     <tbody>
                       {charts.data!.low.rows.map((r) => (
                         <tr key={String(r.item)}>
                           <td>{String(r.item)}</td>
                           <td className="is-end mono">{String(r.balance)}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               ) : (
                 <p className="muted">
                   <Icon name="check" size={15} /> Nothing is running low.
                 </p>
               )}
             </Card>
           </div>
         </>
       )}
    </div>
  );
}