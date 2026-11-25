/**
 * Planning and costing.
 *
 * Three things in one screen because they are one question asked three ways:
 * what does a piece cost, what should we make next, and what are the numbers
 * behind both.
 *
 * The constants are editable by an admin only. They decide what every open
 * job order is measured against, so the screen says so rather than leaving
 * somebody to find out.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { ErrorState, EmptyState, LoadingState } from '../components/States';

interface CostReport {
  month: string;
  pieces: number; metres: number;
  produced: { a: number; b: number; c: number };
  overhead: { rent: number; utilities: number; salaries: number; indirect: number; total: number };
  perPiece: { fabric: number; overhead: number; total: number };
  prices: { gradeAPlus: number; gradeA: number; gradeB: number; gradeC: number };
  revenue: number; cost: number; margin: number;
  pricesMissing: boolean; noProduction: boolean;
}

interface DemandPlan {
  weeks: number;
  allowance: { shortagePct: number; checkPct: number; wastePct: number; total: number };
  unitsPerMeter: number;
  rows: {
    item: string; sold: number; perWeek: number; onHand: number;
    weeksOfCover: number | null; make: number; metres: number;
  }[];
  totals: { pieces: number; metres: number };
}

const money = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function WarehousePlanning() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [tab, setTab] = useState<'demand' | 'costs' | 'settings'>('demand');

  const canManage = can('warehouse.tx.manage');

  /*
   * Two numbers the planner decides, not constants.
   *
   * How long production takes is a fact about the workshop. How much stock
   * to hold behind it, and what a season will add to demand, are
   * judgements — and the plan was built on neither, so it ordered the same
   * amount for a quiet February and for the week before Eid.
   */
  const [safetyDays, setSafetyDays] = useState(30);
  const [boostPct, setBoostPct] = useState(0);

  const demand = useQuery({
    queryKey: ['wh', 'demand', safetyDays, boostPct],
    queryFn: () => api<DemandPlan>(
      `/warehouse/demand?safetyDays=${safetyDays}&boostPct=${boostPct}`),
    enabled: tab === 'demand',
    staleTime: 5 * 60_000,
  });

  const report = useQuery({
    queryKey: ['wh', 'cost-report', month],
    queryFn: () => api<CostReport>(`/warehouse/costs/report?month=${month}`),
    enabled: tab === 'costs',
  });

  const costs = useQuery({
    queryKey: ['wh', 'costs'],
    queryFn: () => api<any>('/warehouse/costs'),
    enabled: tab === 'settings',
  });

  const settings = useQuery({
    queryKey: ['wh', 'settings'],
    queryFn: () => api<any>('/warehouse/settings'),
    enabled: tab === 'settings',
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['wh'] });

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Planning</h1>
          <p className="pagehead__sub">
            What to make next, what a piece costs, and the numbers behind both.
          </p>
        </div>
      </header>

      <div className="tabs" role="tablist">
        {([['demand', 'What to make'], ['costs', 'Cost per piece'],
           ['settings', 'The numbers']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k}
                  className={`tabs__tab${tab === k ? ' is-active' : ''}`}
                  onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {/* ------------------------------------------------- demand -- */}

      {/* The two judgements the plan rests on, where the plan is. Behind a
          settings page they would be set once and forgotten, and the
          season changes four times a year. */}
      {tab === 'demand' ? (
        <div className="formrow no-print">
          <label className="field">
            <span className="field__label">
              Safety stock <span className="field__opt">days</span>
            </span>
            <input className="input" type="number" min="0" max="180" step="1"
                   value={safetyDays}
                   onChange={(e) => setSafetyDays(
                     Math.max(0, Number(e.target.value) || 0))} />
            <span className="field__hint">
              Left on the shelf once a run arrives.
            </span>
          </label>
          <label className="field">
            <span className="field__label">
              Season boost <span className="field__opt">%</span>
            </span>
            <input className="input" type="number" min="0" max="300" step="5"
                   value={boostPct}
                   onChange={(e) => setBoostPct(
                     Math.max(0, Number(e.target.value) || 0))} />
            <span className="field__hint">
              Added to the pace. Ramadan and Eid are most of the year.
            </span>
          </label>
        </div>
      ) : null}

      {tab === 'demand' ? (
        demand.isLoading ? <LoadingState label="Reading 26 weeks of sales" />
        : demand.isError ? (
          <ErrorState error={demand.error} onRetry={() => void demand.refetch()} />
        ) : (
          <>
            <div className="grid">
              {([
                ['Pieces to make', demand.data!.totals.pieces.toLocaleString()],
                ['Fabric needed', `${money(demand.data!.totals.metres)} m`],
                ['Allowance', `${demand.data!.allowance.total}%`],
              ] as const).map(([label, value]) => (
                <div className="grid__cell" key={label} style={{ '--span': 4 } as any}>
                  <div className="tile"><div className="kpi">
                    <div className="kpi__top"><p className="kpi__label">{label}</p></div>
                    <p className="kpi__value">{value}</p>
                  </div></div>
                </div>
              ))}
            </div>

            <Card title="What to make"
                  subtitle={`From ${demand.data!.weeks} weeks of sales, to reach eight weeks of cover.`}>
              <p className="muted qcsummary">
                {/* The allowances are why this is not simply sales minus
                    stock, and saying so stops somebody "correcting" it. */}
                The {demand.data!.allowance.total}% allowance covers shortage{' '}
                {demand.data!.allowance.shortagePct}%, quality checks{' '}
                {demand.data!.allowance.checkPct}% and waste{' '}
                {demand.data!.allowance.wastePct}%. Fabric at{' '}
                {demand.data!.unitsPerMeter} pieces per metre.
              </p>

              {!demand.data!.rows.length ? (
                <EmptyState title="Nothing to make"
                            hint="Everything that sold has enough cover." />
              ) : (
                <div className="tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Item</th>
                        <th scope="col" className="is-end">Sold</th>
                        <th scope="col" className="is-end">A week</th>
                        <th scope="col" className="is-end">On hand</th>
                        <th scope="col" className="is-end">Cover</th>
                        <th scope="col" className="is-end">Make</th>
                        <th scope="col" className="is-end">Metres</th>
                      </tr>
                    </thead>
                    <tbody>
                      {demand.data!.rows.map((r) => (
                        <tr key={r.item}>
                          <td>{r.item}</td>
                          <td className="is-end mono">{r.sold}</td>
                          <td className="is-end mono">{r.perWeek}</td>
                          <td className="is-end mono">{r.onHand}</td>
                          {/* Under two weeks is the one that needs cutting
                              this week rather than next. */}
                          <td className={`is-end mono${(r.weeksOfCover ?? 99) < 2
                            ? ' whline__have is-bad' : ''}`}>
                            {r.weeksOfCover === null ? '—' : `${r.weeksOfCover}w`}
                          </td>
                          <td className="is-end mono"><strong>{r.make}</strong></td>
                          <td className="is-end mono">{money(r.metres)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )
      ) : null}

      {/* -------------------------------------------------- costs -- */}

      {tab === 'costs' ? (
        <>
          <Card title="Which month">
            <label className="field">
              <span className="field__label">Month</span>
              <input className="input mono" type="month" value={month}
                     onChange={(e) => setMonth(e.target.value)} />
            </label>
          </Card>

          {report.isLoading ? <LoadingState label="Working out the cost" />
           : report.isError ? (
             <ErrorState error={report.error} onRetry={() => void report.refetch()} />
           ) : (
             <>
               {report.data!.noProduction ? (
                 <p className="notice notice--warn">
                   {/* A cost of zero looks like a cheap month rather than an
                       empty one. */}
                   No job order was closed in {report.data!.month}, so there is
                   nothing to cost.
                 </p>
               ) : null}

               {report.data!.pricesMissing && !report.data!.noProduction ? (
                 <p className="notice notice--warn">
                   <Icon name="info" size={16} /> No selling prices have been
                   entered, so the margin below is not a real figure. Set them
                   under <strong>The numbers</strong>.
                 </p>
               ) : null}

               <div className="grid">
                 {([
                   ['Pieces made', report.data!.pieces.toLocaleString()],
                   ['Cost each', money(report.data!.perPiece.total)],
                   ['Revenue', money(report.data!.revenue)],
                   ['Margin', money(report.data!.margin)],
                 ] as const).map(([label, value], i) => (
                   <div className="grid__cell" key={label} style={{ '--span': 3 } as any}>
                     <div className="tile"><div className="kpi">
                       <div className="kpi__top"><p className="kpi__label">{label}</p></div>
                       <p className={`kpi__value${i === 3 && report.data!.margin < 0
                         ? ' is-bad' : ''}`}>{value}</p>
                     </div></div>
                   </div>
                 ))}
               </div>

               <Card title="Where the cost comes from">
                 <div className="tablewrap">
                   <table className="table">
                     <tbody>
                       <tr>
                         <td>Fabric, per piece</td>
                         <td className="is-end mono">{money(report.data!.perPiece.fabric)}</td>
                       </tr>
                       <tr>
                         <td>
                           Overhead, per piece
                           <small className="muted">
                             {' '}· rent, utilities, salaries and indirect, spread
                             across everything the month made
                           </small>
                         </td>
                         <td className="is-end mono">{money(report.data!.perPiece.overhead)}</td>
                       </tr>
                       <tr>
                         <td><strong>Total</strong></td>
                         <td className="is-end mono">
                           <strong>{money(report.data!.perPiece.total)}</strong>
                         </td>
                       </tr>
                     </tbody>
                   </table>
                 </div>

                 <h3 className="subhead">The month&rsquo;s overhead</h3>
                 <div className="tablewrap">
                   <table className="table">
                     <tbody>
                       {([
                         ['Rent', report.data!.overhead.rent],
                         ['Utilities', report.data!.overhead.utilities],
                         ['Salaries', report.data!.overhead.salaries],
                         ['Indirect', report.data!.overhead.indirect],
                       ] as const).map(([label, value]) => (
                         <tr key={label}>
                           <td>{label}</td>
                           <td className="is-end mono">{money(value)}</td>
                         </tr>
                       ))}
                       <tr>
                         <td><strong>Total</strong></td>
                         <td className="is-end mono">
                           <strong>{money(report.data!.overhead.total)}</strong>
                         </td>
                       </tr>
                     </tbody>
                   </table>
                 </div>
               </Card>
             </>
           )}
        </>
      ) : null}

      {/* ----------------------------------------------- settings -- */}

      {tab === 'settings' ? (
        costs.isLoading || settings.isLoading ? <LoadingState label="Reading the numbers" />
        : costs.isError ? (
          <ErrorState error={costs.error} onRetry={() => void costs.refetch()} />
        ) : (
          <NumbersPanel costs={costs.data} settings={settings.data}
                        canManage={canManage} onChanged={refresh} />
        )
      ) : null}
    </div>
  );
}

function NumbersPanel({ costs, settings, canManage, onChanged }: {
  costs: any; settings: any; canManage: boolean; onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));

  const saveCosts = useMutation({
    mutationFn: (body: any) => api('/warehouse/costs', { method: 'POST', body }),
    onSuccess: () => { setDraft({}); onChanged(); },
  });

  const saveSettings = useMutation({
    mutationFn: (body: any) => api('/warehouse/settings', { method: 'POST', body }),
    onSuccess: () => { setDraft({}); onChanged(); },
  });

  const field = (key: string, fallback: number) =>
    draft[key] ?? String(fallback ?? '');

  return (
    <>
      <Card title="Costs and prices"
            subtitle="Monthly overheads, the fabric rate, and what a piece sells for.">
        <div className="formrow">
          {([['rent', 'Rent, a month'], ['utilities', 'Utilities, a month'],
             ['fabric', 'Fabric, a metre']] as const).map(([key, label]) => (
            <label className="field" key={key}>
              <span className="field__label">{label}</span>
              <input className="input mono" type="number" min="0" step="1"
                     disabled={!canManage}
                     value={field(key, costs[key])}
                     onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
            </label>
          ))}
        </div>

        <h3 className="subhead">Selling price, by grade</h3>
        <div className="formrow">
          {([['gradeAPlus', 'A+'], ['gradeA', 'A'],
             ['gradeB', 'B'], ['gradeC', 'C']] as const).map(([key, label]) => (
            <label className="field" key={key}>
              <span className="field__label">{label}</span>
              <input className="input mono" type="number" min="0" step="1"
                     disabled={!canManage}
                     value={field(key, costs.prices[key])}
                     onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
            </label>
          ))}
        </div>

        <h3 className="subhead">This month</h3>
        <div className="formrow">
          <label className="field">
            <span className="field__label">Month</span>
            <input className="input mono" type="month" value={month}
                   onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Salaries</span>
            <input className="input mono" type="number" min="0" step="1"
                   disabled={!canManage}
                   value={field('salary', costs.salaries?.[month] ?? 0)}
                   onChange={(e) => setDraft((d) => ({ ...d, salary: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field__label">Indirect expenses</span>
            <input className="input mono" type="number" min="0" step="1"
                   disabled={!canManage}
                   value={field('indirect', costs.indirect?.[month] ?? 0)}
                   onChange={(e) => setDraft((d) => ({ ...d, indirect: e.target.value }))} />
          </label>
        </div>

        {saveCosts.isError ? (
          <p className="notice notice--warn">{(saveCosts.error as Error)?.message}</p>
        ) : null}

        {canManage ? (
          <div className="modal__foot">
            <button type="button" className="notebtn"
                    disabled={saveCosts.isPending || !Object.keys(draft).length}
                    onClick={() => saveCosts.mutate({
                      rent: draft.rent !== undefined ? Number(draft.rent) : undefined,
                      utilities: draft.utilities !== undefined ? Number(draft.utilities) : undefined,
                      fabric: draft.fabric !== undefined ? Number(draft.fabric) : undefined,
                      prices: Object.fromEntries(
                        ['gradeAPlus', 'gradeA', 'gradeB', 'gradeC']
                          .filter((k) => draft[k] !== undefined)
                          .map((k) => [k, Number(draft[k])])),
                      salary: draft.salary !== undefined
                        ? { month, amount: Number(draft.salary) } : undefined,
                      indirect: draft.indirect !== undefined
                        ? { month, amount: Number(draft.indirect) } : undefined,
                    })}>
              {saveCosts.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <p className="muted whappr__note">
            <Icon name="info" size={14} /> Only a manager or an admin can change these.
          </p>
        )}
      </Card>

      <Card title="Planning constants"
            subtitle="What every expected figure in the module is built from.">
        <p className="notice notice--warn">
          {/* Changing this moves the yardstick under every job order that is
              already open, which is why it is admin-only there and here. */}
          <Icon name="info" size={16} /> Pieces per metre decides what every
          open job order is measured against. Changing it changes those
          expectations. Admin only.
        </p>

        <div className="formrow">
          {([['unitsPerMeter', 'Pieces per metre'],
             ['shortagePct', 'Shortage %'],
             ['checkPct', 'Quality check %'],
             ['wastePct', 'Waste %'],
             ['overdueDays', 'Overdue after, days']] as const).map(([key, label]) => (
            <label className="field" key={key}>
              <span className="field__label">{label}</span>
              <input className="input mono" type="number" min="0" step="0.01"
                     disabled={!canManage}
                     value={field(key, settings?.[key])}
                     onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
            </label>
          ))}
        </div>

        {saveSettings.isError ? (
          <p className="notice notice--warn">{(saveSettings.error as Error)?.message}</p>
        ) : null}

        {canManage ? (
          <div className="modal__foot">
            <button type="button" className="notebtn"
                    disabled={saveSettings.isPending}
                    onClick={() => saveSettings.mutate(Object.fromEntries(
                      ['unitsPerMeter', 'shortagePct', 'checkPct', 'wastePct', 'overdueDays']
                        .filter((k) => draft[k] !== undefined)
                        .map((k) => [k, Number(draft[k])])))}>
              {saveSettings.isPending ? 'Saving…' : 'Save the constants'}
            </button>
          </div>
        ) : null}
      </Card>
    </>
  );
}