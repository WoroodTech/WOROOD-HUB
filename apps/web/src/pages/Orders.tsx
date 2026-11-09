import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OrderListResponse, OrderPaymentReference } from '../contract';
import { api, apiRaw } from '../lib/api';
import { qk } from '../lib/keys';
import { ErrorState, LoadingState, EmptyState } from '../components/States';
import { OrderNotesDialog } from '../components/OrderNotes';
import { BulkCommentDialog } from '../components/BulkComment';
import { StatusPill } from '../charts/DataTable';
import { Icon } from '../components/Icon';
import { formatDateTime, formatInteger, formatMoney } from '../lib/format';

const PAGE_SIZES = [25, 50, 100];

/**
 * The gateway's reference for an order's payment.
 *
 * Shows the first identifier the gateway actually filled, and says which one
 * it was. Gateways disagree about where they put the number, so two orders
 * paid through different providers can show different fields — and without
 * the label underneath, somebody matching a statement would paste one into a
 * column meant for the other.
 */
function PaymentReference({ payment }: { payment?: OrderPaymentReference | null }) {
  if (!payment) return <span className="muted">—</span>;

  const found = payment.id ? { value: payment.id, from: 'payment id' }
    : payment.authorization ? { value: payment.authorization, from: 'authorization' }
    : null;

  if (!found) {
    /*
     * The gateway issued no reference. Which gateway it was is the useful
     * thing to say: "Cash on Delivery (COD)" explains the empty reference
     * completely, where "none given" leaves somebody reconciling wondering
     * whether the order was paid at all.
     *
     * The name comes from the gateway itself, so a provider added later
     * reads correctly without anything changing here.
     */
    if (payment.gateway) {
      return (
        <span className="payref">
          <span className="payref__value payref__value--plain">{payment.gateway}</span>
          <span className="payref__from">no reference issued</span>
        </span>
      );
    }
    return (
      <span className="muted"
            title="No successful payment transaction on this order">
        none given
      </span>
    );
  }

  return (
    <span className="payref">
      <span className="payref__value">{found.value}</span>
      <span className="payref__from">
        {found.from}{payment.gateway ? ` · ${payment.gateway}` : ''}
        {payment.hasReceipt ? ' · receipt' : ''}
      </span>
    </span>
  );
}

export function Orders() {
  /* Which order's notes are open, with its name — the dialog's heading needs
     it and the row already has it, so it travels rather than being fetched. */
  const [notesFor, setNotesFor] = useState<{ id: string; name: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: qk.orders(page, pageSize),
    queryFn: () => api<OrderListResponse>(`/sales/orders?page=${page}&pageSize=${pageSize}`),
    placeholderData: (prev) => prev,
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  /* The server decides, not this component. `paymentDataRedacted` says the
     column is absent by rule rather than because every order on this page
     happened to have no reference — which would otherwise look the same. */
  const showPayment = data ? data.paymentDataRedacted !== true : false;
  const redacted = !!data?.customerDataRedacted;

  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  /*
   * Take the export and hand the file over.
   *
   * A POST, because taking it moves the boundary: the next export starts
   * where this one ended. The file comes back in the response rather than
   * from a link, so a refresh cannot take a second one by accident.
   */
  const runExport = async () => {
    setExporting(true);
    setExportNote(null);
    try {
      const res = await apiRaw('/sales/orders/payment-export', { method: 'POST' });
      const rows = Number(res.headers.get('X-Export-Rows') ?? 0);
      if (!rows) {
        /* The boundary still moved — see the service. Said plainly so nobody
           presses it again expecting a different answer. */
        setExportNote({ text: 'Nothing new since the last export.' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1]
        ?? 'payment-references.csv';
      a.click();
      URL.revokeObjectURL(url);
      setExportNote({ text: `${rows} order${rows === 1 ? '' : 's'} exported.` });
    } catch (e: any) {
      setExportNote({ text: e?.message ?? 'The export could not be taken.', bad: true });
    } finally {
      setExporting(false);
    }
  };

  return (
    /* The dialog is a sibling of the page, not a child of it: nesting it
       inside the table would put a modal inside a scrolling container. */
    <>
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Orders</h1>
          <p className="pagehead__sub">
            Every order mirrored from the shop. This is a cash-on-delivery store, so most orders sit
            <strong> with a courier</strong> until the cash comes back.
          </p>
        </div>

        {/* The actions that belong to the page rather than to one row. The
            notes icon used to sit on every line, which put the same control
            fifty times on screen for something nobody does fifty times. */}
        {showPayment ? (
          <div className="pagehead__tools">
            <button type="button" className="notebtn" disabled={exporting}
                    onClick={() => void runExport()}>
              {exporting ? 'Preparing…' : 'Export payment IDs'}
            </button>
            <button type="button" className="notebtn"
                    onClick={() => setBulkOpen(true)}>
              Comment on orders
            </button>

          </div>
        ) : null}
      </header>

      {exportNote ? (
        <p className={`notice${exportNote.bad ? ' notice--warn' : ''}`}>
          {exportNote.text}
        </p>
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
                  {/* Present only when the API sent references at all — the
                      permission decides, not this component. */}
                  {showPayment ? <th scope="col">Gateway reference</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className={o.cancelledAt ? 'is-cancelled' : undefined}>
                    <td className="mono">
                      {/* The name opens the order's notes. The icon that used
                          to do it sat on every row for something nobody does
                          on every row, and the name is where somebody looks
                          when they want that order anyway. */}
                      <button type="button" className="ordername"
                              onClick={() => setNotesFor({ id: o.id, name: o.name })}>
                        {o.name}
                      </button>
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
                    {showPayment ? (
                      <td><PaymentReference payment={o.payment} /></td>
                    ) : null}
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

    {notesFor ? (
      <OrderNotesDialog orderId={notesFor.id} orderName={notesFor.name}
                        onClose={() => setNotesFor(null)} />
    ) : null}
    {bulkOpen ? <BulkCommentDialog onClose={() => setBulkOpen(false)} /> : null}
    </>
  );
}