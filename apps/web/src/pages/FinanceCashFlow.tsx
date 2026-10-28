/**
 * The daily cash-flow forecast.
 *
 * A grid: one row per day of the month, one column per kind of spending, and
 * the figure in each cell is how much that kind still needs by that day. It is
 * the screen Finance works from, and it replaces a sheet tab of formulas.
 *
 * The method switch is the point of this page rather than an option on it. The
 * spreadsheet keeps only the *last* payment date per request, so a request
 * paid in two instalments looks unpaid until the later one — and every day in
 * between is overstated. Both answers are shown, and a banner says how far
 * apart they are, because which one to adopt is a decision for Finance and it
 * cannot be taken without seeing the difference in money.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CashFlowComparison, CashFlowResponse } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';

const isArabic = () => (document.documentElement.lang || 'en').startsWith('ar');

/** Egyptian pounds, no decimals: a forecast to the piastre is false precision. */
const money = (n: number) =>
  new Intl.NumberFormat(isArabic() ? 'ar-EG' : 'en-EG',
    { style: 'currency', currency: 'EGP', maximumFractionDigits: 0 }).format(n);

/** The month this page opens on: the one we are in. */
const thisMonth = () => new Intl.DateTimeFormat('en-CA',
  { year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (month: string) =>
  new Intl.DateTimeFormat(isArabic() ? 'ar-EG' : 'en-GB',
    { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T12:00:00Z`));

export function FinanceCashFlow() {
  const [month, setMonth] = useState(thisMonth);
  /* The correct figure by default. The other one overstates, and a forecast
     that overstates makes the company hold cash it does not need. */
  const [method, setMethod] = useState<'legacy' | 'accurate'>('accurate');

  const flow = useQuery({
    queryKey: qk.financeCashFlow(month, method),
    queryFn: () => api<CashFlowResponse>(
      `/finance/cash-flow?month=${month}&method=${method}`),
  });

  /* Fetched alongside, because the banner it feeds is the reason this page
     offers a choice of method at all. */
  const comparison = useQuery({
    queryKey: qk.financeCashFlowCompare(month),
    queryFn: () => api<CashFlowComparison>(`/finance/cash-flow/compare?month=${month}`),
  });

  const today = new Intl.DateTimeFormat('en-CA').format(new Date());

  /* Column totals for the foot of the table: what the month needs in all. The
     daily figures are running requirements, not daily spends, so these are a
     sum of rows and are labelled as such rather than as a monthly cost. */
  const totals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of flow.data?.days ?? []) {
      for (const [k, v] of Object.entries(d.columns)) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  }, [flow.data]);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Cash Flow</h1>
          <p className="pagehead__sub">
            What each kind of spending still needs, day by day.
          </p>
        </div>
        <div className="pagehead__tools">
          <button type="button" className="btn btn--ghost btn--sm"
                  aria-label="Previous month"
                  onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            <Icon name="left" size={14} />
          </button>
          <span className="cashflow__month">{monthLabel(month)}</span>
          <button type="button" className="btn btn--ghost btn--sm"
                  aria-label="Next month"
                  onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            <Icon name="right" size={14} />
          </button>
        </div>
      </header>

      {/* The difference between the two ways of counting, in money. Shown only
          when there is one: on a month where nothing was paid in instalments
          the two agree exactly, and saying so is more useful than a warning
          about a problem that is not there. */}
      {comparison.data && comparison.data.daysThatDiffer > 0 ? (
        <Card title="These figures differ from the old spreadsheet this month">
          <p>
            The spreadsheet asks for{' '}
            <strong>{money(comparison.data.legacyTotal - comparison.data.accurateTotal)}</strong>
            {' '}more than is really needed, across{' '}
            <strong>{comparison.data.daysThatDiffer}</strong>{' '}
            {comparison.data.daysThatDiffer === 1 ? 'day' : 'days'}.
            {' '}<strong>The figures below are the corrected ones.</strong>
          </p>
          <p className="field__hint">
            The spreadsheet keeps only the last payment date for each request,
            so a request paid in instalments looks unpaid until the final
            payment — and every day in between asks for money that has already
            gone out. Every payment is dated here, so the figure is right.
            Switch below to see the old numbers if you need to check something
            against them.
          </p>
          <ul className="cashflow__diffs">
            {comparison.data.differences.slice(0, 6).map((d) => (
              <li key={d.day}>
                <span className="cashflow__diffday">{d.day.slice(8)}</span>
                <s className="muted">{money(d.legacy)}</s>
                <strong>{money(d.accurate)}</strong>
              </li>
            ))}
            {comparison.data.differences.length > 6 ? (
              <li className="muted">
                and {comparison.data.differences.length - 6} more
              </li>
            ) : null}
          </ul>
        </Card>
      ) : comparison.data ? (
        <p className="field__hint cashflow__agree">
          <Icon name="check" size={13} /> Both ways of counting agree exactly this
          month — nothing was paid in instalments.
        </p>
      ) : null}

      {/* Worded so nobody has to be told what the difference is. "Corrected"
          and "old spreadsheet" say which is which; "legacy" and "accurate"
          would not. */}
      <div className="cashflow__methods" role="tablist" aria-label="Which figures">
        <button type="button" role="tab" aria-selected={method === 'accurate'}
                className={`btn btn--sm ${method === 'accurate' ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setMethod('accurate')}>
          Corrected figures
        </button>
        <button type="button" role="tab" aria-selected={method === 'legacy'}
                className={`btn btn--sm ${method === 'legacy' ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setMethod('legacy')}>
          As the old spreadsheet counted
        </button>
      </div>

      {/* Never ambiguous about which set is on screen. A number that quietly
          changed meaning is worse than one that was always wrong. */}
      {method === 'legacy' ? (
        <p className="state state--warning cashflow__viewing">
          Showing the old spreadsheet's figures, including its known
          overstatement. For checking against the sheet — not for deciding what
          to pay.
        </p>
      ) : null}

      {flow.isLoading ? <LoadingState label="Working out the month" />
       : flow.isError ? <ErrorState error={flow.error} onRetry={() => void flow.refetch()} />
       : !flow.data?.days.length ? (
         <p className="muted">Nothing to forecast for this month.</p>
       ) : (
        <div className="tablewrap">
          <table className="table cashflow__table">
            <thead>
              <tr>
                <th className="cashflow__daycol">Day</th>
                {flow.data.columns.map((c) => (
                  <th key={c.key} className="num">
                    {isArabic() ? c.labelAr : c.label}
                  </th>
                ))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {flow.data.days.map((d) => (
                <tr key={d.day} className={d.day === today ? 'is-today' : undefined}>
                  <td className="cashflow__daycol">{d.day.slice(8)}</td>
                  {flow.data!.columns.map((c) => (
                    <td key={c.key} className="num">
                      {/* Zero is drawn as a dash: a column of noughts is
                          harder to read past than a column of blanks. */}
                      {d.columns[c.key]
                        ? money(d.columns[c.key])
                        : <span className="muted">—</span>}
                    </td>
                  ))}
                  <td className="num"><strong>
                    {d.total ? money(d.total) : <span className="muted">—</span>}
                  </strong></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="cashflow__daycol">Sum</th>
                {flow.data.columns.map((c) => (
                  <td key={c.key} className="num">{money(totals[c.key] ?? 0)}</td>
                ))}
                <td className="num">
                  <strong>
                    {money(Object.values(totals).reduce((n, v) => n + v, 0))}
                  </strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="field__hint">
        Each figure is what is still owed on that day, not what is spent on it.
        A request appears from its due date and stays until it is paid, so the
        same money shows on every day it remains outstanding — and the sum at
        the foot adds those days together rather than totalling the month's
        spending.
      </p>
    </div>
  );
}