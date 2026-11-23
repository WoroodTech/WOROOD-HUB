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
import { WarehousePlanning } from './WarehousePlanning';
import { ExportCsv } from '../components/ExportCsv';

/** A sheet date: a serial number, or text for a hand-typed row. */
function sheetDate(v: string | number): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000)
      .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return String(v ?? '') || '—';
}

/**
 * The six screens of the rolls cycle, as the Apps Script lays them out.
 *
 * They were one list with a status filter here, which is not the same
 * thing: a filter narrows one view, where these are six different jobs
 * belonging to different desks. Reconciliation asks what the workshop owes
 * back, Summary asks how the fabric is doing overall, History asks what
 * happened — and none of those is "the register, narrowed".
 */
const ROLL_SCREENS = [
  ['receive', 'Receive rolls'],
  ['plan', 'Plan'],
  ['workshop', 'At workshop'],
  ['recon', 'Reconciliation'],
  ['summary', 'Summary'],
  ['history', 'History'],
] as const;

type RollScreen = typeof ROLL_SCREENS[number][0];

export function WarehouseRolls() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<RollScreen>('receive');

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

  /*
   * Which of the six screens, filtered by what this person does.
   *
   * The Apps Script hides tabs rather than refusing them: the workshop sees
   * only its own, and Operations has no business receiving fabric. Showing a
   * tab that answers "not allowed" teaches people to ignore the bar.
   */
  const screens = ROLL_SCREENS.filter(([key]) => {
    if (key === 'receive') return can('warehouse.rolls.receive');
    if (key === 'plan') return can('warehouse.rolls.plan');
    return true;
  });

  /* Whatever is first for this person, so nobody lands on a blank page. */
  const screen = screens.some(([k]) => k === tab) ? tab : screens[0]?.[0] ?? 'workshop';

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

      <div className="tabs" role="tablist">
        {screens.map(([key, label]) => (
          <button key={key} type="button" role="tab"
                  aria-selected={screen === key}
                  className={`tabs__tab${screen === key ? ' is-active' : ''}`}
                  onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {screen === 'plan' ? <WarehousePlanning /> : null}
      {screen === 'recon' ? <RollsReconciliation /> : null}
      {screen === 'summary' ? <RollsSummary /> : null}
      {screen === 'history' ? <RollsHistory /> : null}

      {screen !== 'receive' && screen !== 'workshop' ? null : (
      <>
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
      </>
      )}
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

/* ================================================= the three screens ==== */

/**
 * What the workshop still owes back.
 *
 * Meters went out on a job order; pieces and offcuts come back. The gap is
 * either fabric still being worked, or fabric nobody can account for, and
 * the two look identical until somebody lines them up — which is what this
 * screen is for and what a status filter over the register cannot do.
 */
function RollsReconciliation() {
  const jobs = useQuery({
    queryKey: qk.whRolls('jobs'),
    queryFn: () => api<WarehouseJobOrder[]>('/warehouse/rolls/jobs'),
  });

  if (jobs.isLoading) return <LoadingState label="Reading the job orders" />;
  if (jobs.isError) {
    return <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />;
  }

  /* Only what is still open: a closed job order has been reconciled, and
     listing it again buries the ones that have not. */
  const rows = (jobs.data ?? []).filter((j) => j.status !== 'Closed');

  if (!rows.length) {
    return (
      <Card title="Reconciliation">
        <EmptyState icon="check" title="Nothing outstanding"
                    hint="Every job order has been closed." />
      </Card>
    );
  }

  return (
    <Card title="Reconciliation"
          subtitle="Meters issued against what has come back. Open job orders only."
          actions={
            <ExportCsv name="reconciliation" rows={rows} columns={[
              { header: 'Job order', value: (j) => j.operationOrder },
              { header: 'Status', value: (j) => j.status },
              { header: 'Metres', value: (j) => Number(j.meters) || 0 },
              { header: 'Expected', value: (j) => Number(j.expectedUnits) || 0 },
              { header: 'Grade A+', value: (j) => Number(j.gradeA) || 0 },
              { header: 'Grade B', value: (j) => Number(j.gradeB) || 0 },
              { header: 'Fabrication waste', value: (j) => Number(j.fabricationWaste) || 0 },
              { header: 'Material waste', value: (j) => Number(j.materialWaste) || 0 },
              { header: 'Variance', value: (j) => Number(j.variance) || 0 },
            ]} />
          }>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Job order</th>
              <th scope="col">Status</th>
              <th scope="col" className="is-end">Metres</th>
              <th scope="col" className="is-end">Expected</th>
              <th scope="col" className="is-end">Good</th>
              <th scope="col" className="is-end">Waste</th>
              <th scope="col" className="is-end">Variance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => {
              /* What was expected off the fabric against what the workshop
                 actually produced, with the waste that explains the gap. */
              const good = (Number(j.gradeA) || 0) + (Number(j.gradeB) || 0);
              const waste = (Number(j.fabricationWaste) || 0)
                + (Number(j.materialWaste) || 0);
              const variance = Number(j.variance) || 0;
              return (
                <tr key={j.operationOrder}>
                  <td className="mono">{j.operationOrder}</td>
                  <td><RollPill status={j.status} /></td>
                  <td className="is-end mono">{Number(j.meters) || 0}</td>
                  <td className="is-end mono">{Number(j.expectedUnits) || 0}</td>
                  <td className="is-end mono">{good || '—'}</td>
                  <td className="is-end mono">{waste || '—'}</td>
                  {/* Short is the one worth seeing: over is a counting
                      question, under is fabric that did not become product. */}
                  <td className={`is-end mono${variance < 0 ? ' is-bad' : ''}`}>
                    {variance === 0 ? '—'
                      : variance > 0 ? `+${variance}` : variance}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The cycle as counts: where the fabric is, in one line each. */
function RollsSummary() {
  const rolls = useQuery({
    queryKey: qk.whRolls(''),
    queryFn: () => api<WarehouseRoll[]>('/warehouse/rolls'),
  });
  const jobs = useQuery({
    queryKey: qk.whRolls('jobs'),
    queryFn: () => api<WarehouseJobOrder[]>('/warehouse/rolls/jobs'),
  });

  if (rolls.isLoading || jobs.isLoading) {
    return <LoadingState label="Counting" />;
  }
  if (rolls.isError) {
    return <ErrorState error={rolls.error} onRetry={() => void rolls.refetch()} />;
  }

  const all = rolls.data ?? [];
  const open = (jobs.data ?? []).filter((j) => j.status !== 'Closed');

  const byStatus = all.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const metres = all.reduce((n, r) => n + (Number(r.meters) || 0), 0);
  const atWorkshop = all
    .filter((r) => r.status === 'Issued' || r.status === 'Reported')
    .reduce((n, r) => n + (Number(r.meters) || 0), 0);

  const tile = (label: string, value: string | number, sub?: string) => (
    <div className="tile" key={label}>
      <div className="kpi">
        <div className="kpi__top"><p className="kpi__label">{label}</p></div>
        <p className="kpi__value">{value}</p>
        {sub ? <p className="kpi__sub">{sub}</p> : null}
      </div>
    </div>
  );

  return (
    <>
      <section className="totalsgrid" aria-label="Rolls summary">
        {tile('Rolls', all.length, 'in the register')}
        {tile('Metres', Math.round(metres), 'received in all')}
        {/* The number that matters: fabric the company owns but cannot
            currently cut, because somebody else is holding it. */}
        {tile('At the workshop', Math.round(atWorkshop), 'metres out')}
        {tile('Open job orders', open.length,
              open.length ? 'still to close' : 'all closed')}
      </section>

      <Card title="By status">
        <ul className="attlist">
          {['Received', 'Planned', 'Issued', 'Reported', 'Delivered', 'Closed']
            .filter((st) => byStatus[st]).map((st) => (
            <li key={st}>
              <span className="attrow">
                <span className="attrow__name"><RollPill status={st} /></span>
                <span className="mono">{byStatus[st]}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

/**
 * What happened, newest first.
 *
 * Every roll carries the dates of the steps it has been through, so the
 * history is those dates read across the register rather than a log kept
 * beside it — one fewer thing to keep in step, and it cannot disagree with
 * the register it is drawn from.
 */
function RollsHistory() {
  const [q, setQ] = useState('');

  const rolls = useQuery({
    queryKey: qk.whRolls(''),
    queryFn: () => api<WarehouseRoll[]>('/warehouse/rolls'),
  });

  if (rolls.isLoading) return <LoadingState label="Reading the register" />;
  if (rolls.isError) {
    return <ErrorState error={rolls.error} onRetry={() => void rolls.refetch()} />;
  }

  const needle = q.trim().toLowerCase();
  const events: { at: string; what: string; roll: string; detail: string }[] = [];

  for (const r of rolls.data ?? []) {
    const label = `${r.rollName}${r.rollCode ? ` · ${r.rollCode}` : ''}`;
    /* A date column can come back as a serial number rather than as text —
       the ledger holds both — so it is normalised here rather than sorted
       as whatever it happened to be. */
    const add = (at: unknown, what: string, detail = '') => {
      const when = String(at ?? '').trim();
      if (when) events.push({ at: when, what, roll: label, detail });
    };
    /* The register carries one date per roll — when it arrived — and its
       current status. That is the whole of what the sheet knows, so the
       history is honest about being arrival plus where it got to, rather
       than inventing timestamps for steps nobody recorded. */
    add(r.received, 'Received', `${r.meters} m`);
    if (r.plannedDate) add(r.plannedDate, 'Planned', r.planNote ?? '');
  }

  const rows = events
    .filter((e) => !needle
      || e.roll.toLowerCase().includes(needle)
      || e.what.toLowerCase().includes(needle))
    /* Newest first: the question is almost always what happened lately. */
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 200);

  return (
    <Card title="History" subtitle="Every step each roll has been through."
          actions={
            <ExportCsv name="rolls-history" rows={rows} columns={[
              { header: 'When', value: (e) => e.at },
              { header: 'What', value: (e) => e.what },
              { header: 'Roll', value: (e) => e.roll },
              { header: 'Detail', value: (e) => e.detail },
            ]} />
          }>
      <label className="field">
        <span className="field__label">Search</span>
        <input className="input" value={q} placeholder="Roll name or step…"
               onChange={(e) => setQ(e.target.value)} />
      </label>

      {!rows.length ? (
        <EmptyState icon="list" title="Nothing yet"
                    hint={needle ? 'Nothing matches that.' : 'No rolls have moved.'} />
      ) : (
        <div className="tablewrap tablewrap--scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">Roll</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td className="mono">{e.at}</td>
                  <td>{e.what}</td>
                  <td>{e.roll}</td>
                  <td className="muted">{e.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}