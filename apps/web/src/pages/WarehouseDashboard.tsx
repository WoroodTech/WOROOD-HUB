/**
 * The warehouse dashboard.
 *
 * Built from the portal's own pieces: the KPI tiles the finance and sales
 * screens use, and `SeriesChart` / `CategoryChart` from `charts/`. Nothing
 * here is a warehouse-specific copy of something that already exists — a
 * second set that looked almost the same would drift apart the first time
 * either was touched.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import {
  WarehouseBreakdown, WarehouseCollections, WarehouseDefects,
  WarehouseFindItem, WarehouseRunOut,
} from './WarehouseInsights';

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
  const navigate = useNavigate();

  /* Tapping an item anywhere on this page opens its card, which is where
     every follow-up question about it is answered. */
  const openItem = (item: string) =>
    navigate(`/warehouse/item?item=${encodeURIComponent(item)}`);

  /* Which warehouse the location chart is showing. Null means none is
     chosen, and that chart is simply absent rather than empty. */
  const [focus, setFocus] = useState<string | null>(null);
  /* Which headline count the reader has opened, if any. */
  const [band, setBand] = useState<'low' | 'out' | null>(null);
  const [showNegative, setShowNegative] = useState(false);

  const tiles = useQuery({
    queryKey: ['wh', 'tiles'],
    queryFn: () => api<Tiles>('/warehouse/dashboard/tiles'),
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchInterval: 10_000,
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
      <SheetStatusBanner />
      {band ? <StockBandDialog band={band} onClose={() => setBand(null)} /> : null}
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
          <div className="tile"><div className="kpi">
            <div className="kpi__top"><p className="kpi__label">Pieces in stock</p></div>
            <p className="kpi__value">{t.inStock.toLocaleString()}</p>
            <p className="kpi__sub">across {t.warehouses} warehouses</p>
          </div>
          </div>
        </div>

        <div className="grid__cell" style={{ '--span': 3 } as any}>
          {/* A count is a question — which 47? — so the tile answers it. */}
          <div className="tile">
            <button type="button" className="kpi kpi--pick"
                    onClick={() => setBand('low')}>
              <div className="kpi__top"><p className="kpi__label">Running low</p></div>
              <p className="kpi__value">{t.low.toLocaleString()}</p>
              {/* The threshold is on the tile rather than in the code: "47
                  running low" means nothing without it. */}
              <p className="kpi__sub">at {t.lowAt} pieces or fewer · sellable</p>
            </button>
          </div>
        </div>

        <div className="grid__cell" style={{ '--span': 3 } as any}>
          <div className="tile">
            <button type="button" className="kpi kpi--pick"
                    onClick={() => setBand('out')}>
              <div className="kpi__top"><p className="kpi__label">Out of stock</p></div>
              <p className="kpi__value">{t.outOfStock.toLocaleString()}</p>
              {/* Sellable places only. A piece in the workshop was never
                  sellable, so counting it here would make the number lie. */}
              <p className="kpi__sub">items in WH-02 · Local and Global</p>
            </button>
          </div>
        </div>

        <div className="grid__cell" style={{ '--span': 3 } as any}>
          {/* `.tile` is what the stylesheet draws the card with — the rule
              is `.tile .kpi`, so a bare `.kpi` renders with no background at
              all. The sales and finance tiles wrap it the same way. */}
          <div className="tile">
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
           <WarehouseFindItem />

           {/* The forecast sits high: it is the only panel here that says
               something has to be done, and soon. */}
           <WarehouseRunOut onPick={openItem} />

           <Card title="Stock in and out · last 60 days">
             <SeriesChart payload={charts.data!.trend} height={260} />
           </Card>

           <WarehouseBreakdown />

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

             <WarehouseCollections warehouse={focus ?? undefined} />
           </div>

           <div className="panes">
             <WarehouseDefects onPick={openItem} />

             <Card title={focus ? `Inside ${focus}` : 'Running low'}>
               {/* The card above counts every item at or below the
                   threshold; this lists the lowest few of them. They were the
                   same rule all along — 47 against 28 read as a miscount
                   because nothing here said the table was a top slice. */}
               {!focus && charts.data!.low.rows.length && t
                 && charts.data!.low.rows.length < t.low ? (
                 <p className="muted">
                   The {charts.data!.low.rows.length} lowest of {t.low} items
                   at or below {t.lowAt} pieces.
                 </p>
               ) : null}
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

/* ------------------------------------------------------- sheet status -- */

/**
 * Whether movements are actually reaching Scarves Inventory.
 *
 * Every movement is queued and sent by the warehouse worker. With the
 * connection off the queue holds, and because balances are computed from the
 * portal's own ledger they keep moving — so receiving raised WH-01 on this
 * dashboard and left no row in the sheet, with nothing anywhere to say why.
 *
 * Renders nothing while the sheet is live and the queue is clear, which is
 * almost always.
 */
function SheetStatusBanner() {
  const status = useQuery({
    queryKey: ['warehouse', 'sheet-status'],
    queryFn: () => api<{
      mode: string; writing: boolean;
      pending: number; failed: number; oldestPending: string | null;
    }>('/warehouse/sheet-status'),
    /* Cheap, and the answer changes when somebody fixes the server. */
    refetchInterval: 60_000,
  });

  const s = status.data;
  if (!s) return null;
  if (s.writing && !s.pending && !s.failed) return null;

  return (
    <p className="notice notice--warn" role="status">
      {!s.writing ? (
        <>
          <strong>Nothing is being written to Scarves Inventory.</strong>{' '}
          The sheet connection is {s.mode === 'dry' ? 'in dry mode' : 'off'},
          so movements are being kept and will go out once it is live.
          Balances here are the portal's own and stay correct.
        </>
      ) : s.failed ? (
        <><strong>{s.failed}</strong> movement{s.failed === 1 ? '' : 's'} could
          not be written to the sheet.</>
      ) : (
        <><strong>{s.pending}</strong> movement{s.pending === 1 ? '' : 's'} waiting
          to reach the sheet.</>
      )}
    </p>
  );
}

/* -------------------------------------------------- items behind a count -- */

interface BandRow {
  item: string;
  balance: number;
  places: { where: string; qty: number }[];
}

/**
 * The items making up "running low" or "out of stock".
 *
 * Counted on the server from the same map the tile is counted from, so this
 * list and that number cannot disagree — which is exactly what writing the
 * rule twice would eventually cause.
 *
 * Each row carries where the pieces actually sit, because "Sira: 4" is a
 * different problem from "Sira: 4, all of them in WH-05".
 */
function StockBandDialog({ band, onClose }: {
  band: 'low' | 'out';
  onClose: () => void;
}) {
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = useQuery({
    queryKey: ['warehouse', 'behind', band],
    queryFn: () => api<{ band: string; lowAt: number; total: number; rows: BandRow[] }>(
      `/warehouse/stock/behind?band=${band}`),
  });

  const title = band === 'out' ? 'Out of stock' : 'Running low';
  const needle = q.trim().toLowerCase();
  const rows = (data.data?.rows ?? []).filter(
    (r) => !needle || r.item.toLowerCase().includes(needle));

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="modal__scrim" aria-label="Close"
              onClick={onClose} />
      <div className="modal__panel">
        <div className="confirm__body">
          <h2 className="confirm__title">
            {title}
            {data.data ? <span className="muted"> · {data.data.total} items</span> : null}
          </h2>
          <p className="confirm__text muted">
            {band === 'out'
              ? 'Nothing sellable left in WH-02, Local or Global.'
              : `At ${data.data?.lowAt ?? 20} sellable pieces or fewer.`}
          </p>

          <label className="field">
            <span className="field__label">Search</span>
            <input className="input" value={q} autoFocus
                   placeholder="Item name…"
                   onChange={(e) => setQ(e.target.value)} />
          </label>

          {data.isLoading ? <LoadingState label="Counting" />
           : data.isError ? <ErrorState error={data.error} compact />
           : !rows.length ? (
             <p className="muted">
               {needle ? 'Nothing matches that.' : 'Nothing in this band.'}
             </p>
           ) : (
            <div className="tablewrap tablewrap--scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className="is-end">Sellable</th>
                    <th scope="col">Where the pieces are</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.item}>
                      <td>{r.item}</td>
                      <td className="is-end mono">{r.balance}</td>
                      <td className="muted">
                        {r.places.length
                          ? r.places.map((p) => `${p.where}: ${p.qty}`).join(' · ')
                          : 'nowhere'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="confirm__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}