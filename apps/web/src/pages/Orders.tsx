import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OrderListResponse } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { ErrorState, LoadingState, EmptyState } from '../components/States';
import { StatusPill } from '../charts/DataTable';
import { Icon } from '../components/Icon';
import { formatDateTime, formatInteger, formatMoney } from '../lib/format';

const PAGE_SIZES = [25, 50, 100];

export function Orders() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: qk.orders(page, pageSize),
    queryFn: () => api<OrderListResponse>(`/sales/orders?page=${page}&pageSize=${pageSize}`),
    placeholderData: (prev) => prev,
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const redacted = !!data?.customerDataRedacted;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Orders</h1>
          <p className="pagehead__sub">
            Every order mirrored from the shop. This is a cash-on-delivery store, so most orders sit
            <strong> with a courier</strong> until the cash comes back.
          </p>
        </div>
      </header>

      {data ? (
        <ul className="totals">
          <li className="totals__item">
            <span className="totals__label">Ordered</span>
            <span className="totals__value" title={formatMoney(data.totals.sales, data.totals.currency)}>
              {formatMoney(data.totals.sales, data.totals.currency)}
            </span>
            <span className="totals__hint">value of all {formatInteger(data.total)} mirrored orders</span>
          </li>
          <li className="totals__item totals__item--good">
            <span className="totals__label">Collected</span>
            <span className="totals__value">{formatMoney(data.totals.collected, data.totals.currency)}</span>
            <span className="totals__hint">cash actually received</span>
          </li>
          <li className="totals__item totals__item--transit">
            <span className="totals__label">Outstanding</span>
            <span className="totals__value">{formatMoney(data.totals.outstanding, data.totals.currency)}</span>
            <span className="totals__hint">money in transit with couriers, not a shortfall</span>
          </li>
        </ul>
      ) : null}

      {redacted ? (
        <p className="notice notice--lock">
          <Icon name="lock" size={16} />
          <span>
            <strong>Customer columns are withheld from your account.</strong> Name, e-mail and city were never
            sent to this browser — they are not blanked out here, they are absent from the response.
          </span>
        </p>
      ) : null}

      {isPending ? <LoadingState label="Loading orders" lines={6} /> : null}
      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {data && !data.orders.length ? (
        <EmptyState icon="receipt" title="No orders on this page" hint="Try an earlier page." />
      ) : null}

      {data?.orders.length ? (
        <div className="panel">
          <div className="tablescroll">
            <table className="table table--orders">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Placed</th>
                  {!redacted ? <th scope="col">Customer</th> : null}
                  {!redacted ? <th scope="col">City</th> : null}
                  <th scope="col">Payment</th>
                  <th scope="col" className="is-end">Items</th>
                  <th scope="col" className="is-end">Ordered</th>
                  <th scope="col" className="is-end">Collected</th>
                  <th scope="col" className="is-end">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className={o.cancelledAt ? 'is-cancelled' : undefined}>
                    <td className="mono">
                      {o.name}
                      {o.test ? <span className="tag tag--test" title="Flagged as a test order by the shop.">test</span> : null}
                      {o.cancelledAt ? <span className="tag tag--warn">cancelled</span> : null}
                    </td>
                    <td>{formatDateTime(o.createdAt)}</td>
                    {!redacted ? (
                      <td>
                        <span className="cell-stack">
                          <span>{o.customer?.displayName ?? '--'}</span>
                          {o.customer?.email ? <span className="cell-sub">{o.customer.email}</span> : null}
                        </span>
                      </td>
                    ) : null}
                    {!redacted ? <td>{o.customer?.city ?? '--'}</td> : null}
                    <td><StatusPill value={o.financialStatus ?? ''} /></td>
                    <td className="is-end">{formatInteger(o.itemCount)}</td>
                    <td className="is-end">{formatMoney(o.totalPrice, o.currency)}</td>
                    <td className="is-end">{formatMoney(o.netPayment, o.currency)}</td>
                    <td className={`is-end${o.outstanding > 0 ? ' is-transit' : ''}`}>
                      {formatMoney(o.outstanding, o.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <p className="pager__count">
              {formatInteger((data.page - 1) * data.pageSize + 1)}–
              {formatInteger(Math.min(data.page * data.pageSize, data.total))} of {formatInteger(data.total)}
              {isFetching ? <span className="pager__fetching"> · refreshing…</span> : null}
            </p>
            <label className="pager__size">
              <span>Rows</span>
              <select
                className="select select--sm"
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              >
                {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <div className="pager__nav">
              <button type="button" className="btn btn--ghost btn--sm" disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <Icon name="left" size={15} /> Previous
              </button>
              <span className="pager__page">Page {data.page} of {pages}</span>
              <button type="button" className="btn btn--ghost btn--sm" disabled={page >= pages}
                      onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                Next <Icon name="right" size={15} />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
