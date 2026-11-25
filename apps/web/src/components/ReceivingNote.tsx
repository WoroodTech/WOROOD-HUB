/**
 * The paper the workshop and the warehouse both sign.
 *
 * A job order comes back in batches, and each batch is a claim: the
 * workshop says it made so many of each grade, and the warehouse counts
 * them. The note puts those two columns side by side with the difference
 * between them, because that difference is the whole reason the paper
 * exists — somebody has to account for it before anybody signs.
 *
 * Three signatures, as the Apps Script has it: the workshop that made it,
 * the agent who brought it, and the keeper who put it away. One signature
 * would say the pieces arrived; three say who to ask when they do not add
 * up.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { LoadingState, ErrorState } from './States';

interface Batch {
  batch: number;
  reportedAt: string | number;
  reportedBy: string;
  workshop: { total: number; a: number; b: number; c: number; global: number };
  warehouse: { total: number; a: number; b: number; c: number; global: number };
}

interface Job {
  operationOrder: string;
  /* How many rolls went into it — the register holds a count, not names. */
  rolls: number;
  expectedUnits: number;
}

/** Day/month/year, whichever shape the sheet gave us. */
function day(value: string | number): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return d.toLocaleDateString('en-GB',
      { day: 'numeric', month: 'short', year: '2-digit' });
  }
  return String(value ?? '').trim() || '—';
}

export function ReceivingNote({ job, batch, onClose }: {
  job: Job;
  /** Which batch of this job order the paper is for. */
  batch: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const batches = useQuery({
    queryKey: ['wh', 'batches', job.operationOrder],
    queryFn: () => api<Batch[]>(
      `/warehouse/rolls/jobs/${encodeURIComponent(job.operationOrder)}/batches`),
  });

  const all = batches.data ?? [];
  const b = all.find((x) => x.batch === batch);

  /* What came back before this one, so the paper says where the job order
     stands rather than only what is on the trolley today. */
  const before = all
    .filter((x) => x.batch < batch)
    .reduce((n, x) => n + x.warehouse.total, 0);

  const serial = `${job.operationOrder}/${batch}`;

  const rows = b ? [
    /* Global is part of grade A, not a fourth grade — it is the same
       quality going to a different market. */
    ['A+ (Global)', b.workshop.global, b.warehouse.global],
    ['A (Local)', b.workshop.a - b.workshop.global, b.warehouse.a - b.warehouse.global],
    ['B', b.workshop.b, b.warehouse.b],
    ['C', b.workshop.c, b.warehouse.c],
  ] as const : [];

  return (
    <div className="modal" role="dialog" aria-modal="true"
         aria-label={`Receiving note ${serial}`}>
      <button type="button" className="modal__scrim no-print"
              aria-label="Close" onClick={onClose} />
      <div className="modal__panel">
        {batches.isLoading ? <LoadingState label="Reading the batches" />
         : batches.isError ? <ErrorState error={batches.error} compact />
         : !b ? <p className="muted">That batch is not on this job order.</p>
         : (
          <article className="docpaper">
            <header className="docpaper__head">
              <div>
                <strong>Worood Designs</strong>
                <p className="muted">Production receiving note — workshop</p>
              </div>
              <div className="is-end">
                <p className="muted">Serial #</p>
                <strong className="mono">{serial}</strong>
              </div>
            </header>

            <dl className="kv">
              <dt>Job order</dt><dd className="mono">{job.operationOrder}</dd>
              <dt>Received on</dt><dd>{day(b.reportedAt)}</dd>
              <dt>Rolls</dt>
              <dd>{job.rolls ? `${job.rolls}` : '—'}</dd>
            </dl>

            <h3>
              IN — received from the workshop · {job.operationOrder} · Patch {batch}
            </h3>

            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Grade</th>
                  <th scope="col" className="is-end">Reported by the workshop</th>
                  <th scope="col" className="is-end">Received by the warehouse</th>
                  <th scope="col" className="is-end">Difference</th>
                  {/* Ticked by hand on the printed paper, against the
                      pieces in front of whoever is counting. */}
                  <th scope="col">Check point</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, said, got]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="is-end mono">{said}</td>
                    <td className="is-end mono">{got}</td>
                    <td className={`is-end mono${got - said ? ' is-bad' : ''}`}>
                      {got - said}
                    </td>
                    <td><span className="docpaper__tick" /></td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="is-end mono"><strong>{b.workshop.total}</strong></td>
                  <td className="is-end mono"><strong>{b.warehouse.total}</strong></td>
                  <td className="is-end mono">
                    <strong>{b.warehouse.total - b.workshop.total}</strong>
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>

            <dl className="kv">
              <dt>Should produce (job order)</dt>
              <dd className="mono">{job.expectedUnits}</dd>
              <dt>Received before this patch</dt><dd className="mono">{before}</dd>
              <dt>This patch</dt><dd className="mono">{b.warehouse.total}</dd>
              {/* What the job order still owes, never below nothing: more
                  than expected is a counting question, not a debt. */}
              <dt>Remaining</dt>
              <dd className="mono">
                {Math.max(0, job.expectedUnits - before - b.warehouse.total)}
              </dd>
            </dl>

            <footer className="docpaper__signs">
              <span>Workshop</span>
              <span>Warehouse agent</span>
              <span>Warehouse keeper</span>
            </footer>

            <p className="muted docpaper__foot">
              {serial} · {new Date().toLocaleString('en-GB')}
            </p>
          </article>
        )}

        <div className="confirm__actions no-print">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn--primary"
                  disabled={!b}
                  onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </div>
      </div>
    </div>
  );
}