import { useNavigate } from 'react-router-dom';
import type { TablePayload } from '../contract';
import { formatValue } from '../lib/format';
import { Icon } from '../components/Icon';

/**
 * The store is cash on delivery, so PENDING is the *normal* state of a healthy
 * order -- money in transit with a courier, not a failure. It is never styled as
 * an error.
 */
export function StatusPill({ value }: { value: string }) {
  const v = String(value ?? '').toUpperCase();
  const map: Record<string, { tone: string; label: string; title: string }> = {
    PAID: { tone: 'good', label: 'Paid', title: 'Collected in full.' },
    PARTIALLY_PAID: { tone: 'info', label: 'Part paid', title: 'Some of the value has been collected.' },
    PENDING: { tone: 'transit', label: 'With courier', title: 'Cash on delivery: placed and awaiting collection. This is the normal state for most orders here.' },
    AUTHORIZED: { tone: 'info', label: 'Authorised', title: 'Authorised, not yet captured.' },
    REFUNDED: { tone: 'info', label: 'Refunded', title: 'Returned to the customer.' },
    PARTIALLY_REFUNDED: { tone: 'info', label: 'Part refunded', title: 'Partly returned to the customer.' },
    VOIDED: { tone: 'warn', label: 'Voided', title: 'Payment voided.' },
    CANCELLED: { tone: 'warn', label: 'Cancelled', title: 'Order cancelled.' },
    EXPIRED: { tone: 'warn', label: 'Expired', title: 'Payment window expired.' },
  };
  const hit = map[v] ?? { tone: 'neutral', label: v ? v.toLowerCase().replace(/_/g, ' ') : '--', title: '' };
  return <span className={`pill pill--${hit.tone}`} title={hit.title}>{hit.label}</span>;
}

export function DataTable({ payload, currency = 'EGP', maxRows }: {
  payload: TablePayload; currency?: string; maxRows?: number;
}) {
  const navigate = useNavigate();
  const rows = maxRows ? payload.rows.slice(0, maxRows) : payload.rows;
  const redacted = payload.redactedColumns ?? [];

  if (!payload.rows.length) {
    return <p className="chart-empty">No rows for this range.</p>;
  }

  return (
    <div className="tablewrap">
      {redacted.length ? (
        <p className="notice notice--lock">
          <Icon name="lock" size={15} />
          <span>
            {redacted.length === 1 ? 'One column is' : `${redacted.length} columns are`} withheld from your account
            ({redacted.join(', ')}). The rows are complete; those fields were never sent.
          </span>
        </p>
      ) : null}

      <div className="tablescroll">
        <table className="table">
          <thead>
            <tr>
              {payload.columns.map((col) => (
                <th key={col.key} scope="col" className={col.align === 'end' ? 'is-end' : undefined}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              /*
               * A row that can be opened says so and behaves like a link.
               *
               * A table of references with no way through to any of them is
               * a list somebody then has to search for by hand. The payload
               * carries the path; the row carries the id.
               */
              const link = (payload as any).rowLink && row.id
                ? String((payload as any).rowLink).replace(':id', String(row.id))
                : null;

              return (
                <tr key={String(row[payload.columns[0].key] ?? i)}
                    className={link ? 'is-clickable' : undefined}
                    tabIndex={link ? 0 : undefined}
                    role={link ? 'link' : undefined}
                    onClick={link ? () => navigate(link) : undefined}
                    onKeyDown={link ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(link);
                      }
                    } : undefined}>
                  {payload.columns.map((col) => {
                    const value = row[col.key];
                    return (
                      <td key={col.key} className={col.align === 'end' ? 'is-end' : undefined}>
                        {col.format === 'status'
                          ? <StatusPill value={String(value ?? '')} />
                          : formatValue(value, col.format, currency)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {maxRows && payload.rows.length > maxRows ? (
        <p className="tablewrap__more">Showing the first {maxRows} of {payload.rows.length} rows.</p>
      ) : null}
    </div>
  );
}