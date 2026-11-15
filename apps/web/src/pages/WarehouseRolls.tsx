/**
 * Rolls and job orders.
 *
 * Two lists and a detail panel: the register on one side, job orders on the
 * other, and opening an order shows its batches and what the workshop is
 * holding. The actions each person can take are the ones their permissions
 * allow, and the server refuses the rest.
 *
 * The cycle runs Received → Planned → Issued → Reported → Delivered →
 * Closed, and the workshop's own stages sit inside Issued.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WarehouseBatch, WarehouseJobOrder, WarehouseRoll, WarehouseStageOverview,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useAuth } from '../lib/auth';

/** A sheet date: a serial number, or text for a hand-typed row. */
function sheetDate(v: string | number): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000)
      .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return String(v ?? '') || '—';
}

export function WarehouseRolls() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const rolls = useQuery({
    queryKey: qk.whRolls(status),
    queryFn: () => api<WarehouseRoll[]>(
      `/warehouse/rolls${status ? `?status=${status}` : ''}`),
  });

  const jobs = useQuery({
    queryKey: qk.whJobs(''),
    queryFn: () => api<WarehouseJobOrder[]>('/warehouse/rolls/jobs'),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['wh'] });

  if (rolls.isLoading) return <LoadingState label="Reading the roll register" />;
  if (rolls.isError) {
    return <ErrorState error={rolls.error} onRetry={() => void rolls.refetch()} />;
  }

  const counts = (rolls.data ?? []).reduce((m, r) => {
    m[r.status] = (m[r.status] ?? 0) + 1;
    return m;
  }, {} as Record<string, number>);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Rolls</h1>
          <p className="pagehead__sub">
            Fabric from arrival to a closed job order.
          </p>
        </div>
      </header>

      {/* The cycle as counts, and as a filter — the same tabs component the
          dashboard uses for warehouses. */}
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!status}
                className={`tabs__tab${!status ? ' is-active' : ''}`}
                onClick={() => setStatus('')}>
          All <span className="tabs__n">{(rolls.data ?? []).length}</span>
        </button>
        {['Received', 'Planned', 'Issued', 'Reported', 'Delivered', 'Closed'].map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s}
                  className={`tabs__tab${status === s ? ' is-active' : ''}`}
                  disabled={!counts[s] && status !== s}
                  onClick={() => setStatus(status === s ? '' : s)}>
            {s} <span className="tabs__n">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="panes">
        <Card title="The register"
              subtitle={status ? `${status} rolls` : 'Every roll'}>
          {!rolls.data?.length ? (
            <EmptyState title="No rolls"
                        hint={status ? `Nothing is ${status.toLowerCase()}.` : 'The register is empty.'} />
          ) : (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Roll</th>
                    <th scope="col">CTN</th>
                    <th scope="col" className="is-end">Metres</th>
                    <th scope="col">Status</th>
                    <th scope="col">Order</th>
                  </tr>
                </thead>
                <tbody>
                  {rolls.data.map((r) => (
                    <tr key={r.rollId}>
                      <td>
                        <span className="mono">{r.rollId}</span>
                        {r.rollName ? <small className="muted"> · {r.rollName}</small> : null}
                      </td>
                      <td className="mono">{r.ctn || '—'}</td>
                      <td className="is-end mono">{r.meters.toLocaleString()}</td>
                      <td><RollPill status={r.status} /></td>
                      <td>
                        {r.operationOrder ? (
                          <button type="button" className="ordername"
                                  onClick={() => setOpen(r.operationOrder)}>
                            {r.operationOrder}
                          </button>
                        ) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Job orders" subtitle="What is at the workshop, and what came back.">
          {jobs.isLoading ? <LoadingState label="Reading job orders" />
           : !jobs.data?.length ? (
             <EmptyState title="No job orders" hint="Nothing has been issued yet." />
           ) : (
             <ul className="attlist">
               {jobs.data.map((j) => (
                 <li key={j.operationOrder}>
                   <button type="button"
                           className={`attrow${open === j.operationOrder ? ' is-on' : ''}`}
                           onClick={() => setOpen(
                             open === j.operationOrder ? null : j.operationOrder)}>
                     <span className="attrow__name">
                       <span className="mono">{j.operationOrder}</span>
                       <small className="muted">
                         {' '}· {j.rolls} roll{j.rolls === 1 ? '' : 's'} ·{' '}
                         {j.meters.toLocaleString()}m
                       </small>
                     </span>
                     <span className="jobstat">
                       {j.status}
                       {j.variance ? (
                         /* The one number that says whether the order went
                            well: delivered against expected. */
                         <small className={j.variance < 0 ? 'is-bad' : ''}>
                           {j.variance > 0 ? '+' : ''}{j.variance}
                         </small>
                       ) : null}
                     </span>
                   </button>
                 </li>
               ))}
             </ul>
           )}
        </Card>
      </div>

      {open ? (
        <JobOrderDetail operationOrder={open} canManage={can('warehouse.tx.manage')}
                        onChanged={refresh} />
      ) : null}
    </div>
  );
}

/* ================================================= job order detail ==== */

function JobOrderDetail({ operationOrder, canManage, onChanged }: {
  operationOrder: string; canManage: boolean; onChanged: () => void;
}) {
  const batches = useQuery({
    queryKey: qk.whBatches(operationOrder),
    queryFn: () => api<WarehouseBatch[]>(
      `/warehouse/rolls/jobs/${encodeURIComponent(operationOrder)}/batches`),
  });

  const stages = useQuery({
    queryKey: qk.whStages(operationOrder),
    queryFn: () => api<WarehouseStageOverview>(
      `/warehouse/rolls/jobs/${encodeURIComponent(operationOrder)}/stages`),
  });

  const close = useMutation({
    mutationFn: () => api('/warehouse/rolls/close', {
      method: 'POST', body: { operationOrder },
    }),
    onSuccess: onChanged,
  });

  const open = (batches.data ?? []).filter((b) => b.status !== 'Received').length;

  return (
    <Card title={operationOrder}
          subtitle="Batches reported by the workshop, and what the warehouse counted."
          actions={canManage ? (
            <button type="button" className="notebtn"
                    disabled={close.isPending || !!open}
                    title={open ? `${open} batch${open === 1 ? '' : 'es'} still to receive` : ''}
                    onClick={() => close.mutate()}>
              {close.isPending ? 'Closing…' : 'Close the order'}
            </button>
          ) : undefined}>

      {close.isError ? (
        <p className="notice notice--warn" role="alert">
          {(close.error as Error)?.message ?? 'That could not be closed.'}
        </p>
      ) : null}

      {/* ----------------------------------------------- the batches -- */}

      {batches.isLoading ? <LoadingState label="Reading batches" />
       : !batches.data?.length ? (
         <EmptyState title="Nothing reported"
                     hint="The workshop has not reported production on this order." />
       ) : (
         <div className="tablewrap">
           <table className="table">
             <thead>
               <tr>
                 <th scope="col">Batch</th>
                 <th scope="col">Reported</th>
                 <th scope="col" className="is-end">Workshop</th>
                 <th scope="col" className="is-end">Warehouse</th>
                 <th scope="col" className="is-end">Difference</th>
                 <th scope="col">Status</th>
               </tr>
             </thead>
             <tbody>
               {batches.data.map((b) => {
                 const ws = b.workshop.a + b.workshop.b + b.workshop.c;
                 const wh = b.received.a + b.received.b + b.received.c;
                 const diff = b.status === 'Received' ? wh - ws : null;
                 return (
                   <tr key={b.batch}>
                     <td className="mono">{b.batch}</td>
                     <td>
                       {sheetDate(b.reportedAt)}
                       {b.reportedBy ? <small className="muted"> · {b.reportedBy}</small> : null}
                     </td>
                     <td className="is-end mono" title={`A ${b.workshop.a} · B ${b.workshop.b} · C ${b.workshop.c}`}>
                       {ws.toLocaleString()}
                     </td>
                     <td className="is-end mono"
                         title={b.status === 'Received'
                           ? `A ${b.received.a} · B ${b.received.b} · C ${b.received.c}`
                           : 'not received yet'}>
                       {b.status === 'Received' ? wh.toLocaleString() : '—'}
                     </td>
                     {/* Both counts stay, and the gap between them is shown.
                         It is the measurement, not an error to resolve. */}
                     <td className={`is-end mono${diff ? ' whline__have is-bad' : ''}`}>
                       {diff === null ? '—' : diff === 0 ? '0' : `${diff > 0 ? '+' : ''}${diff}`}
                     </td>
                     <td>{b.status}{b.fullyDelivered ? ' · final' : ''}</td>
                   </tr>
                 );
               })}
             </tbody>
           </table>
         </div>
       )}

      {/* ------------------------------------------ the workshop lots -- */}

      {stages.data?.lots?.length ? (
        <>
          <h3 className="subhead">At the workshop</h3>
          <div className="grid">
            {[
              ['Metres cut', stages.data.totals.metersCut],
              ['Produced', stages.data.totals.produced],
              ['Counted', stages.data.totals.counted],
              ['Difference', stages.data.totals.difference],
            ].map(([label, value]) => (
              <div className="grid__cell" key={String(label)} style={{ '--span': 3 } as any}>
                <div className="tile"><div className="kpi">
                  <div className="kpi__top"><p className="kpi__label">{label}</p></div>
                  <p className={`kpi__value${label === 'Difference' && Number(value) < 0
                    ? ' is-bad' : ''}`}>
                    {Number(value) > 0 && label === 'Difference' ? '+' : ''}
                    {Number(value).toLocaleString()}
                  </p>
                </div></div>
              </div>
            ))}
          </div>

          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Lot</th>
                  <th scope="col" className="is-end">Metres</th>
                  <th scope="col" className="is-end">Produced</th>
                  <th scope="col" className="is-end">Counted</th>
                  <th scope="col" className="is-end">Difference</th>
                  <th scope="col">Where</th>
                </tr>
              </thead>
              <tbody>
                {stages.data.lots.map((l) => (
                  <tr key={l.lot}>
                    <td className="mono">{l.lot}</td>
                    <td className="is-end mono">{l.meters.toLocaleString()}</td>
                    <td className="is-end mono">{l.productionQty || '—'}</td>
                    <td className="is-end mono">{l.qualityCount || '—'}</td>
                    <td className={`is-end mono${l.difference < 0 ? ' whline__have is-bad' : ''}`}>
                      {l.difference ? `${l.difference > 0 ? '+' : ''}${l.difference}` : '—'}
                    </td>
                    <td>{l.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {open ? (
        <p className="muted whappr__note">
          <Icon name="info" size={14} /> {open} batch{open === 1 ? '' : 'es'} still
          to receive. The order cannot be closed until they are — closing loses
          whatever the workshop is holding, and the register has no way to show
          it again.
        </p>
      ) : null}
    </Card>
  );
}

/* ====================================================== status pill ==== */

function RollPill({ status }: { status: string }) {
  /* The six states, in cycle order. Anything else came from somebody typing
     in the sheet, and is shown as it is rather than guessed at. */
  const known = ['Received', 'Planned', 'Issued', 'Reported', 'Delivered', 'Closed'];
  const i = known.indexOf(status);
  return (
    <span className={`rollpill${i >= 0 ? ` is-s${i}` : ' is-unknown'}`}>
      {status || '—'}
    </span>
  );
}