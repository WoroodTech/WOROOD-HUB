/**
 * Reports.
 *
 * What sold over a date range, from where, in which collection, and what came
 * back. The equivalent of the Apps Script's largest feature, which the module
 * did not have.
 *
 * Export is the browser's own print-to-PDF rather than a generated file:
 * what is on the screen is what goes on the page, there is nothing to keep
 * in step, and it prints on any machine without a server round trip.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CategoryPayload, SeriesPayload } from '../contract';
import { api } from '../lib/api';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { SeriesChart } from '../charts/SeriesChart';
import { CategoryChart } from '../charts/CategoryChart';
import { Icon } from '../components/Icon';
import { ExportCsv } from '../components/ExportCsv';

interface Preset { key: string; label: string; from: string; to: string }

interface Report {
  range: { from: string; to: string; days: number };
  builtAt: string;
  totals: {
    units: number; orders: number; items: number;
    returned: number; returnRate: number; received: number;
    perDay: number; rows: number;
  };
  daily: SeriesPayload;
  byWarehouse: CategoryPayload;
  byCollection: CategoryPayload;
  byKind: { kind: string; units: number }[];
  topSellers: {
    item: string; quantity: number; orders: number;
    returned: number; returnRate: number; trend: number[];
  }[];
  mostReturned: {
    item: string; quantity: number; returned: number; returnRate: number;
  }[];
  /** Pieces a day, with what that leaves on the shelf. */
  fastMovers: {
    item: string; quantity: number; perDay: number;
    stock: number; daysOfCover: number | null; forecast30: number;
  }[];
  /** Ranked by how little cover is left, not by how fast it sells. */
  actNow: {
    item: string; perDay: number; stock: number;
    daysOfCover: number | null; forecast30: number;
    needed30: number; priority: 'now' | 'soon' | 'watch';
  }[];
  /** On the shelf, nothing sold in the range. */
  slowMovers: { item: string; stock: number }[];
  demandForecast: {
    item: string; forecast30: number; stock: number; shortfall: number;
  }[];
  movementByWarehouse: {
    warehouse: string; in: number; out: number; net: number;
  }[];
  /** WH-02's two shelves, the stock anything can be promised from. */
  sellableStock: number;
  trendWeeks: number;
}

export function WarehouseReports() {
  const presets = useQuery({
    queryKey: ['wh', 'report-presets'],
    queryFn: () => api<Preset[]>('/warehouse/reports/presets'),
    staleTime: 60 * 60_000,
  });

  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [chosen, setChosen] = useState('last-30');

  /* The default range is picked once the presets arrive, rather than
     guessed here and corrected a moment later. */
  const active = range
    ?? presets.data?.find((p) => p.key === chosen)
    ?? presets.data?.[0];

  const report = useQuery({
    queryKey: ['wh', 'report', active?.from, active?.to],
    queryFn: () => api<Report>(
      `/warehouse/reports?from=${active!.from}&to=${active!.to}`),
    enabled: !!active,
  });

  if (presets.isLoading) return <LoadingState label="Loading" />;

  const r = report.data;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Reports</h1>
          <p className="pagehead__sub">
            What sold, from where, and what came back — over any two dates.
          </p>
        </div>
      </header>

      <div className="no-print">
        <Card title="Over which dates">
          <div className="tabs" role="tablist">
            {(presets.data ?? []).map((p) => (
              <button key={p.key} type="button" role="tab"
                      aria-selected={!range && chosen === p.key}
                      className={`tabs__tab${!range && chosen === p.key ? ' is-active' : ''}`}
                      onClick={() => { setChosen(p.key); setRange(null); }}>
                {p.label}
              </button>
            ))}
          </div>

          <div className="formrow" style={{ marginBlockStart: 12 }}>
            <label className="field">
              <span className="field__label">From</span>
              <input className="input mono" type="date" value={active?.from ?? ''}
                     onChange={(e) => setRange({
                       from: e.target.value, to: active?.to ?? e.target.value,
                     })} />
            </label>
            <label className="field">
              <span className="field__label">To</span>
              <input className="input mono" type="date" value={active?.to ?? ''}
                     onChange={(e) => setRange({
                       from: active?.from ?? e.target.value, to: e.target.value,
                     })} />
            </label>
          </div>

          {/*
            * Under the filters, because that is what they act on.
            *
            * The browser's own print is both buttons: Print sends it to the
            * printer and the same dialogue saves it as a PDF. A second route
            * to a PDF would be a second renderer to keep in step with this
            * page, and it would drift.
            *
            * Whatever is on screen is what comes out — the range chosen
            * above, the tables below it — because print hides the controls
            * rather than rebuilding the report.
            */}
          {r ? (
            <div className="formrow--actions" style={{ marginBlockStart: 12 }}>
              {/* The numbers, to sort their own way or send to somebody
                  without a login. Top sellers is the table people actually
                  take away; the rest of the page is on the PDF. */}
              <ExportCsv name="warehouse-report" rows={r.topSellers} columns={[
                { header: 'Item', value: (x) => x.item },
                { header: 'Sold', value: (x) => x.quantity },
                { header: 'Orders', value: (x) => x.orders },
                { header: 'Returned', value: (x) => x.returned },
                { header: 'Return rate %', value: (x) => x.returnRate },
              ]} />
              <button type="button" className="btn btn--ghost btn--sm"
                      onClick={() => window.print()}>
                <Icon name="download" size={14} /> Export PDF
              </button>
              <button type="button" className="btn btn--primary btn--sm"
                      onClick={() => window.print()}>
                Print
              </button>
            </div>
          ) : null}
        </Card>
      </div>

      {report.isLoading ? <LoadingState label="Reading the ledger" />
       : report.isError ? (
         <ErrorState error={report.error} onRetry={() => void report.refetch()} />
       ) : !r ? null
       : !r.totals.units ? (
         <EmptyState title="Nothing sold in that range"
                     hint="Try a wider one." />
       ) : (
         <>
           <p className="muted qcsummary">
             {r.range.from} to {r.range.to} · {r.range.days} days ·
             built {new Date(r.builtAt).toLocaleString()}
           </p>

           <div className="grid">
             {([
               ['Pieces sold', r.totals.units.toLocaleString()],
               ['Orders', r.totals.orders.toLocaleString()],
               ['A day', String(r.totals.perDay)],
               ['Returned', `${r.totals.returned} · ${r.totals.returnRate}%`],
               /* What actually left, once returns are taken off — the
                  figure the other four get mistaken for. */
               ['Net sold', (r.totals.units - r.totals.returned).toLocaleString()],
               /* WH-02's two shelves: what can be promised to a customer
                  today, which is not the same as what the company holds. */
               ['Sellable stock', r.sellableStock.toLocaleString()],
             ] as const).map(([label, value]) => (
               <div className="grid__cell" key={label} style={{ '--span': 3 } as any}>
                 <div className="tile"><div className="kpi">
                   <div className="kpi__top"><p className="kpi__label">{label}</p></div>
                   <p className="kpi__value">{value}</p>
                 </div></div>
               </div>
             ))}
           </div>

           <Card title="Sold, day by day">
             <SeriesChart payload={r.daily} height={240} />
           </Card>

           <div className="panes">
             <Card title="By warehouse">
               <CategoryChart payload={r.byWarehouse} height={240} />
             </Card>
             <Card title="By collection">
               <CategoryChart payload={r.byCollection} height={240} />
             </Card>
           </div>

           {/* What to do something about, before anything else on the page:
               it is the only panel here that is a decision rather than a
               description. */}
           {r.actNow.length ? (
             <Card title="Act now"
                   subtitle="Least cover first. Needed is the shortfall against the next 30 days.">
               <div className="tablewrap">
                 <table className="table">
                   <thead>
                     <tr>
                       <th scope="col">Item</th>
                       <th scope="col">Priority</th>
                       <th scope="col" className="is-end">A day</th>
                       <th scope="col" className="is-end">Stock</th>
                       <th scope="col" className="is-end">Days of cover</th>
                       <th scope="col" className="is-end">Needed · 30d</th>
                     </tr>
                   </thead>
                   <tbody>
                     {r.actNow.map((x) => (
                       <tr key={x.item}>
                         <td>{x.item}</td>
                         <td>
                           <span className={`idtag idtag--${
                             x.priority === 'now' ? 'danger'
                             : x.priority === 'soon' ? 'warn' : 'info'}`}>
                             {x.priority === 'now' ? 'Now'
                              : x.priority === 'soon' ? 'Soon' : 'Watch'}
                           </span>
                         </td>
                         <td className="is-end mono">{x.perDay}</td>
                         <td className="is-end mono">{x.stock}</td>
                         <td className="is-end mono">
                           {x.daysOfCover === null ? '—' : x.daysOfCover}
                         </td>
                         <td className="is-end mono">
                           {x.needed30 > 0 ? <strong>{x.needed30}</strong> : '—'}
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
             </Card>
           ) : null}

           <div className="panes">
             {r.fastMovers.length ? (
               <Card title="Fast movers"
                     subtitle="By pieces a day, not by total — a rate says what is moving now.">
                 <div className="tablewrap tablewrap--scroll">
                   <table className="table">
                     <thead>
                       <tr>
                         <th scope="col">Item</th>
                         <th scope="col" className="is-end">A day</th>
                         <th scope="col" className="is-end">Days left</th>
                       </tr>
                     </thead>
                     <tbody>
                       {r.fastMovers.map((x) => (
                         <tr key={x.item}>
                           <td>{x.item}</td>
                           <td className="is-end mono">{x.perDay}</td>
                           <td className="is-end mono">
                             {x.daysOfCover === null ? '—' : x.daysOfCover}
                           </td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               </Card>
             ) : null}

             {r.slowMovers.length ? (
               <Card title="Slow movers"
                     subtitle="On the shelf, nothing sold in this range.">
                 <div className="tablewrap tablewrap--scroll">
                   <table className="table">
                     <thead>
                       <tr>
                         <th scope="col">Item</th>
                         <th scope="col" className="is-end">Stock</th>
                       </tr>
                     </thead>
                     <tbody>
                       {r.slowMovers.map((x) => (
                         <tr key={x.item}>
                           <td>{x.item}</td>
                           <td className="is-end mono">{x.stock}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               </Card>
             ) : null}
           </div>

           {r.demandForecast.length ? (
             <Card title={`Demand · next 30 days`}
                   subtitle={`From the ${r.trendWeeks} weeks behind today, averaged — one quiet week does not halve it.`}>
               <div className="tablewrap tablewrap--scroll">
                 <table className="table">
                   <thead>
                     <tr>
                       <th scope="col">Item</th>
                       <th scope="col" className="is-end">Forecast</th>
                       <th scope="col" className="is-end">Stock</th>
                       <th scope="col" className="is-end">Short by</th>
                     </tr>
                   </thead>
                   <tbody>
                     {r.demandForecast.map((x) => (
                       <tr key={x.item}>
                         <td>{x.item}</td>
                         <td className="is-end mono">{x.forecast30}</td>
                         <td className="is-end mono">{x.stock}</td>
                         <td className="is-end mono">
                           {x.shortfall > 0 ? <strong>{x.shortfall}</strong> : '—'}
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
             </Card>
           ) : null}

           {r.movementByWarehouse.length ? (
             <Card title="Movement per warehouse">
               <div className="tablewrap">
                 <table className="table">
                   <thead>
                     <tr>
                       <th scope="col">Warehouse</th>
                       <th scope="col" className="is-end">In</th>
                       <th scope="col" className="is-end">Out</th>
                       <th scope="col" className="is-end">Net</th>
                     </tr>
                   </thead>
                   <tbody>
                     {r.movementByWarehouse.map((x) => (
                       <tr key={x.warehouse}>
                         <td className="mono">{x.warehouse}</td>
                         <td className="is-end mono">{x.in.toLocaleString()}</td>
                         <td className="is-end mono">{x.out.toLocaleString()}</td>
                         <td className="is-end mono">
                           {/* Signed, because the direction is the point. */}
                           {x.net > 0 ? `+${x.net.toLocaleString()}` : x.net.toLocaleString()}
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
             </Card>
           ) : null}

           <Card title="Top sellers"
                 subtitle={`With the last ${r.trendWeeks} weeks beside each.`}>
             <div className="tablewrap">
               <table className="table">
                 <thead>
                   <tr>
                     <th scope="col">Item</th>
                     <th scope="col" className="is-end">Sold</th>
                     <th scope="col" className="is-end">Orders</th>
                     <th scope="col" className="is-end">Returned</th>
                     <th scope="col">Trend</th>
                   </tr>
                 </thead>
                 <tbody>
                   {r.topSellers.map((s) => (
                     <tr key={s.item}>
                       <td>{s.item}</td>
                       <td className="is-end mono">{s.quantity}</td>
                       <td className="is-end mono">{s.orders}</td>
                       {/* The rate, not just the count: two returns out of
                           three is a problem the count alone hides. */}
                       <td className={`is-end mono${s.returnRate > 20
                         ? ' whline__have is-bad' : ''}`}>
                         {s.returned ? `${s.returned} · ${s.returnRate}%` : '—'}
                       </td>
                       <td><Sparkline weeks={s.trend} /></td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </Card>

           {r.mostReturned.length ? (
             <Card title="Returned most"
                   subtitle="A different list from the one above, and the one worth acting on.">
               <div className="tablewrap">
                 <table className="table">
                   <thead>
                     <tr>
                       <th scope="col">Item</th>
                       <th scope="col" className="is-end">Sold</th>
                       <th scope="col" className="is-end">Returned</th>
                       <th scope="col" className="is-end">Rate</th>
                     </tr>
                   </thead>
                   <tbody>
                     {r.mostReturned.map((s) => (
                       <tr key={s.item}>
                         <td>{s.item}</td>
                         <td className="is-end mono">{s.quantity}</td>
                         <td className="is-end mono">{s.returned}</td>
                         <td className={`is-end mono${s.returnRate > 20
                           ? ' whline__have is-bad' : ''}`}>{s.returnRate}%</td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
             </Card>
           ) : null}

           <Card title="By kind of movement">
             <div className="tablewrap">
               <table className="table">
                 <tbody>
                   {r.byKind.map((k) => (
                     <tr key={k.kind}>
                       <td>{k.kind}</td>
                       <td className="is-end mono">{k.units.toLocaleString()}</td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </Card>
         </>
       )}
    </div>
  );
}

/**
 * Eight weeks, as a small bar run.
 *
 * Inline SVG rather than a chart component: fifty of these on one page, and
 * a full chart each would make the table slow to open and slower to print.
 */
function Sparkline({ weeks }: { weeks: number[] }) {
  const max = Math.max(1, ...weeks);
  return (
    <svg className="spark" viewBox={`0 0 ${weeks.length * 6} 20`}
         role="img" aria-label={`Last ${weeks.length} weeks`}>
      {weeks.map((v, i) => {
        const h = Math.max(1, (v / max) * 18);
        return (
          <rect key={i} x={i * 6} y={20 - h} width="4" height={h}
                rx="1" fill="currentColor"
                opacity={i === weeks.length - 1 ? 1 : 0.45} />
        );
      })}
    </svg>
  );
}