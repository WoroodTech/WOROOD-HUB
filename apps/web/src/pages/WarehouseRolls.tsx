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
import { Paged } from '../components/Paged';

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
  ['workshop', 'Workshop'],
  ['recon', 'Reconciliation'],
  ['history', 'History'],
  ['planning', 'Planning'],
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

      {/* Plan is the running order the workshop cuts in — not the demand
          forecast, which is the Planning tab and a different question. The
          two were wired to the same screen, so choosing Plan answered
          "what should we make" to somebody asking "what is next". */}
      {screen === 'plan' ? <RollsPlan /> : null}
      {screen === 'planning' ? <WarehousePlanning /> : null}
      {/* The counts above the table they summarise. The Apps Script has a
          Summary tab of its own; the screenshots of the running app put
          these figures at the top of Reconciliation instead, which is where
          somebody asking "how bad is it" is already standing. */}
      {screen === 'recon' ? <><RollsSummary /><RollsReconciliation /></> : null}
            {screen === 'history' ? <RollsHistory /> : null}
      {screen === 'workshop' ? <RollsWorkshop /> : null}

      {screen !== 'receive' ? null : (
      <>
      {/* Taking fabric in is what this screen is for; the register below is
          what it has taken in so far. */}
      {can('warehouse.rolls.receive') ? <ReceiveRolls /> : null}

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

/* ===================================================== the workshop ===== */

interface Workshop {
  open: any[]; cutting: any[]; production: any[]; quality: any[]; finished: any[];
  counts: Record<'open' | 'cutting' | 'production' | 'quality' | 'finished', number>;
}

const BENCHES = [
  ['open', 'Open'],
  ['cutting', 'Cutting'],
  ['production', 'In Production'],
  ['quality', 'Workshop Quality'],
  ['finished', 'Finish Rolls'],
] as const;

type Bench = typeof BENCHES[number][0];

/**
 * The workshop, one bench at a time.
 *
 * Five tabs rather than one list, because they are five different people's
 * work: cutting opens a job order and releases metres, production claims
 * what it made from a lot, quality counts it. A single list ordered by
 * status makes each of them read past the other two.
 *
 * The counts are on the tabs because the first question anybody asks on
 * this screen is where the queue is.
 */
function RollsWorkshop() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [bench, setBench] = useState<Bench>('open');
  const [q, setQ] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const shop = useQuery({
    queryKey: ['wh', 'workshop'],
    queryFn: () => api<Workshop>('/warehouse/stages/workshop'),
  });

  const act = useMutation({
    mutationFn: (v: { path: string; body: Record<string, unknown> }) =>
      api(`/warehouse/stages/${v.path}`, { method: 'POST', body: v.body }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['wh'] });
    },
    onError: (e: any) => setError(e?.message ?? 'That could not be recorded.'),
  });

  if (shop.isLoading) return <LoadingState label="Reading the workshop" />;
  if (shop.isError) {
    return <ErrorState error={shop.error} onRetry={() => void shop.refetch()} />;
  }

  const w = shop.data!;
  const needle = q.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);

  /* A lot is named by its order and number, which is how the workshop
     refers to it out loud: "WSO391-2". */
  const lotName = (l: any) => `${l.operationOrder}-${l.lot}`;

  return (
    <>
      <div className="tabs" role="tablist">
        {BENCHES.map(([key, label]) => (
          <button key={key} type="button" role="tab"
                  aria-selected={bench === key}
                  className={`tabs__tab${bench === key ? ' is-active' : ''}`}
                  onClick={() => setBench(key)}>
            {label} <span className="tabs__n">{w.counts[key]}</span>
          </button>
        ))}
      </div>

      {error ? <p className="state state--error">{error}</p> : null}

      {/* Finish Rolls is the only bench long enough to need finding
          something in; the others are a day's work. */}
      {bench === 'finished' ? (
        <label className="field">
          <span className="field__label">Search</span>
          <input className="input" value={q} placeholder="Job order or roll…"
                 onChange={(e) => setQ(e.target.value)} />
        </label>
      ) : null}

      {bench === 'open' ? (
        !w.open.length ? (
          <EmptyState icon="check" title="Nothing waiting"
                      hint="Everything handed over has been started." />
        ) : w.open.map((j) => (
          <Card key={j.operationOrder}
                title={`${j.operationOrder} · ${j.rolls}`}
                actions={<span className="rollpill is-s1">{j.metres} m</span>}>
            <p className="muted">
              Handed over by the warehouse
              {j.waitingSince ? ` · ${sheetDate(j.waitingSince)}` : ''}
              {j.expectedUnits ? ` · expected ${j.expectedUnits} pcs` : ''}
            </p>
            {can('warehouse.stage.cut') ? (
              <div className="formrow--actions">
                <button type="button" className="btn btn--primary btn--sm"
                        disabled={act.isPending}
                        onClick={() => act.mutate({
                          path: 'cut/start',
                          body: { operationOrder: j.operationOrder },
                        })}>
                  Add to cutting
                </button>
              </div>
            ) : null}
          </Card>
        ))
      ) : null}

      {bench === 'cutting' ? (
        !w.cutting.length ? (
          <EmptyState icon="check" title="Nothing in cutting" />
        ) : w.cutting.map((j) => (
          <Card key={j.operationOrder}
                title={`${j.operationOrder} · ${j.rolls}`}
                actions={<span className="rollpill is-s2">{j.metres} m</span>}>
            <p className="muted">
              {j.cut ? `${j.cut} m to production` : 'Not started'}
              {' · '}{j.left} m left
              {j.lots ? ` · ${j.lots} lot${j.lots === 1 ? '' : 's'}` : ''}
            </p>
            {can('warehouse.stage.cut') ? (
              <div className="noterow">
                <input className="input" type="number" min="0.01" step="0.01"
                       aria-label={`Metres cut on ${j.operationOrder}`}
                       placeholder={`Metres · up to ${j.left}`}
                       value={qty[j.operationOrder] ?? ''}
                       onChange={(e) => setQty(
                         (x) => ({ ...x, [j.operationOrder]: e.target.value }))} />
                <button type="button" className="btn btn--primary btn--sm"
                        disabled={act.isPending
                          || !(Number(qty[j.operationOrder]) > 0)}
                        onClick={() => act.mutate({
                          path: 'cut/lot',
                          body: {
                            operationOrder: j.operationOrder,
                            meters: Number(qty[j.operationOrder]),
                          },
                        })}>
                  Release a lot
                </button>
                {/* Only once something has been released: finishing with
                    nothing cut would leave the metres unaccounted for. */}
                {j.lots ? (
                  <button type="button" className="btn btn--ghost btn--sm"
                          disabled={act.isPending}
                          onClick={() => act.mutate({
                            path: 'cut/end',
                            body: { operationOrder: j.operationOrder },
                          })}>
                    Finish cutting
                  </button>
                ) : null}
              </div>
            ) : null}
          </Card>
        ))
      ) : null}

      {bench === 'production' ? (
        !w.production.length ? (
          <EmptyState icon="check" title="Nothing in production" />
        ) : w.production.map((l) => (
          <Card key={lotName(l)} title={lotName(l)}
                actions={<span className="rollpill is-s2">{l.meters} m</span>}>
            <p className="muted">
              Cut {l.cutAt ? sheetDate(l.cutAt) : ''}
              {l.cutBy ? ` by ${l.cutBy}` : ''}
            </p>
            {can('warehouse.stage.production') ? (
              <div className="noterow">
                <input className="input" type="number" min="1" step="1"
                       aria-label={`Pieces made from ${lotName(l)}`}
                       placeholder="Total quantity (pieces)"
                       value={qty[lotName(l)] ?? ''}
                       onChange={(e) => setQty(
                         (x) => ({ ...x, [lotName(l)]: e.target.value }))} />
                <button type="button" className="btn btn--primary btn--sm"
                        disabled={act.isPending || !(Number(qty[lotName(l)]) > 0)}
                        onClick={() => act.mutate({
                          path: 'production/send',
                          body: {
                            operationOrder: l.operationOrder, lot: l.lot,
                            quantity: Number(qty[lotName(l)]),
                          },
                        })}>
                  Record quantity
                </button>
              </div>
            ) : null}
          </Card>
        ))
      ) : null}

      {bench === 'quality' ? (
        !w.quality.length ? (
          <EmptyState icon="check" title="Nothing with quality" />
        ) : w.quality.map((l) => {
          const counted = l.status === 'Counted' || l.status === 'Difference';
          return (
            <Card key={lotName(l)} title={lotName(l)}
                  actions={
                    <span className={`rollpill ${counted ? 'is-s4' : 'is-s3'}`}>
                      {l.productionQty} pcs
                    </span>
                  }>
              <p className="muted">
                Production said {l.productionQty}
                {counted ? ` · quality counted ${l.qualityCount}` : ''}
                {/* The difference is the measurement, not an error — it is
                    what says whether pieces went missing between benches. */}
                {counted && l.difference ? (
                  <strong className={l.difference < 0 ? ' is-bad' : ''}>
                    {' '}({l.difference > 0 ? '+' : ''}{l.difference})
                  </strong>
                ) : null}
              </p>

              {can('warehouse.stage.quality') ? (
                <div className="noterow">
                  {!counted ? (
                    <>
                      <input className="input" type="number" min="0" step="1"
                             aria-label={`Pieces counted on ${lotName(l)}`}
                             placeholder="Quantity you counted"
                             value={qty[lotName(l)] ?? ''}
                             onChange={(e) => setQty(
                               (x) => ({ ...x, [lotName(l)]: e.target.value }))} />
                      <button type="button" className="btn btn--primary btn--sm"
                              disabled={act.isPending
                                || (qty[lotName(l)] ?? '') === ''}
                              onClick={() => act.mutate({
                                path: 'quality/count',
                                body: {
                                  operationOrder: l.operationOrder, lot: l.lot,
                                  counted: Number(qty[lotName(l)]),
                                },
                              })}>
                        Record the count
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn--primary btn--sm"
                            disabled={act.isPending}
                            onClick={() => act.mutate({
                              path: 'quality/handover',
                              body: {
                                operationOrder: l.operationOrder, lot: l.lot,
                              },
                            })}>
                      Send to the warehouse
                    </button>
                  )}
                </div>
              ) : null}
            </Card>
          );
        })
      ) : null}

      {bench === 'finished' ? (
        (() => {
          const rows = w.finished.filter(
            (j) => matches(`${j.operationOrder} ${j.rolls}`));
          if (!rows.length) {
            return <EmptyState icon="list" title="Nothing finished"
                               hint={needle ? 'Nothing matches that.' : ''} />;
          }
          return (
            <Card title="Finish rolls"
                  subtitle={`${rows.length} job order${rows.length === 1 ? '' : 's'}`}>
              <div className="tablewrap tablewrap--scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Job order</th>
                      <th scope="col">Rolls</th>
                      <th scope="col" className="is-end">Metres</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((j) => (
                      <tr key={j.operationOrder}>
                        <td className="mono">{j.operationOrder}</td>
                        <td>{j.rolls}</td>
                        <td className="is-end mono">{j.meters}</td>
                        <td><RollPill status={j.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })()
      ) : null}
    </>
  );
}

/* =================================================== receiving rolls ==== */

/** Today, as the sheet writes it. */
const today = () =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo' }).format(new Date());

interface Incoming {
  key: string;
  rollName: string; rollCode: string;
  ctn: string; meters: string; poNumber: string; note: string;
}

const blank = (): Incoming => ({
  key: crypto.randomUUID(),
  rollName: '', rollCode: '', ctn: '', meters: '', poNumber: '', note: '',
});

/**
 * Fabric arriving at the warehouse.
 *
 * A delivery is several rolls off one lorry, so they are built into a list
 * and saved together: saving each as it is typed means a half-entered
 * delivery when somebody is called away, and no way to tell which half.
 *
 * The received date is today and not editable, as the Apps Script has it —
 * a roll is entered when it is unloaded, and a date somebody can change is
 * one that drifts to whatever makes a report look right.
 */
function ReceiveRolls() {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Incoming[]>([]);
  const [draft, setDraft] = useState<Incoming>(blank());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const catalogue = useQuery({
    queryKey: qk.whRolls('catalogue'),
    queryFn: () => api<WarehouseRoll[]>('/warehouse/rolls'),
    staleTime: 10 * 60_000,
  });

  /* The names already in the register, so a roll arriving again is spelled
     the way it was spelled last time. */
  const names = Array.from(new Set(
    (catalogue.data ?? []).map((r) => r.rollName).filter(Boolean)));

  const save = useMutation({
    mutationFn: async () => {
      for (const r of rows) {
        await api('/warehouse/rolls/receive', {
          method: 'POST',
          body: {
            rollName: r.rollName.trim(),
            rollCode: r.rollCode.trim() || undefined,
            ctn: r.ctn.trim() || undefined,
            meters: Number(r.meters),
            poNumber: r.poNumber.trim() || undefined,
            note: r.note.trim() || undefined,
          },
        });
      }
      return rows.length;
    },
    onSuccess: (n) => {
      setDone(`${n} roll${n === 1 ? '' : 's'} received.`);
      setRows([]);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['wh'] });
    },
    onError: (e: any) => setError(e?.message ?? 'The rolls could not be saved.'),
  });

  const ready = draft.rollName.trim() && Number(draft.meters) > 0;

  const set = (k: keyof Incoming) => (v: string) =>
    setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Card title="Receive rolls">
      <div className="stackform">
        <label className="field">
          <span className="field__label">Roll</span>
          {/* A plain box with suggestions, not a picker: fabric arrives
              that the register has never seen, and a control that only
              offers what is already there cannot take the first roll of
              anything. The list is what has come before, so a roll arriving
              again is spelled the way it was spelled last time. */}
          <input className="input" list="wh-roll-names"
                 value={draft.rollName} maxLength={120}
                 placeholder="Search by name or code, e.g. Moon Dust or 36AB01"
                 onChange={(e) => set('rollName')(e.target.value)} />
          <datalist id="wh-roll-names">
            {names.map((n) => <option key={n} value={n} />)}
          </datalist>
        </label>

        <div className="formrow">
          <label className="field">
            <span className="field__label">CTN (supplier serial)</span>
            <input className="input mono" value={draft.ctn} maxLength={40}
                   placeholder="e.g. CTN005"
                   onChange={(e) => set('ctn')(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Length (metres)</span>
            <input className="input" type="number" min="0.01" step="0.01"
                   value={draft.meters} placeholder="e.g. 200"
                   onChange={(e) => set('meters')(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">
              Received on <span className="field__opt">today</span>
            </span>
            {/* Not editable, as the Apps Script has it: a roll is entered
                when it is unloaded, and a date somebody can change is one
                that drifts to whatever makes a report look right. */}
            <p className="field__fixed mono">{today()}</p>
          </label>
          <label className="field">
            <span className="field__label">P.O number of Q.D</span>
            <input className="input mono" value={draft.poNumber} maxLength={60}
                   placeholder="e.g. PO-1234"
                   onChange={(e) => set('poNumber')(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span className="field__label">
            Notes <span className="field__opt">optional</span>
          </span>
          <input className="input" value={draft.note} maxLength={200}
                 placeholder="Anything worth remembering about this roll"
                 onChange={(e) => set('note')(e.target.value)} />
        </label>

        <div className="formrow--actions">
          <button type="button" className="btn btn--ghost" disabled={!ready}
                  onClick={() => {
                    setRows((r) => [...r, draft]);
                    setDraft(blank());
                    setDone(null);
                  }}>
            Add roll to list
          </button>
        </div>

        {!rows.length ? (
          <p className="muted">No rolls in the list yet.</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Roll</th>
                  <th scope="col">CTN</th>
                  <th scope="col" className="is-end">Metres</th>
                  <th scope="col">P.O</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.rollName}</td>
                    <td className="mono">{r.ctn || '—'}</td>
                    <td className="is-end mono">{r.meters}</td>
                    <td className="mono">{r.poNumber || '—'}</td>
                    <td className="is-end">
                      <button type="button" className="linkbtn"
                              disabled={save.isPending}
                              onClick={() => setRows(
                                (x) => x.filter((y) => y.key !== r.key))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error ? <p className="state state--error">{error}</p> : null}
        {done ? <p className="notice" role="status">{done}</p> : null}

        <div className="formrow--actions">
          <button type="button" className="btn btn--primary"
                  disabled={!rows.length || save.isPending}
                  onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…'
              : `Save ${rows.length || ''} roll${rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Card>
  );
}

/* ======================================================= the plan ======= */

/**
 * The running order the workshop cuts in.
 *
 * Not the demand forecast — that is Planning, and a different question.
 * This is which rolls go next and in what order, which Operations sets and
 * the warehouse hands over from.
 *
 * Priority is the number in the order rather than a word, because the
 * question is always "what is next" and never "is this important".
 */
function RollsPlan() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rolls = useQuery({
    queryKey: qk.whRolls(''),
    queryFn: () => api<WarehouseRoll[]>('/warehouse/rolls'),
  });

  const plan = useMutation({
    mutationFn: (v: { rollId: string; priority?: string; plannedDate?: string }) =>
      api('/warehouse/rolls/plan', { method: 'POST', body: v }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['wh'] });
    },
    onError: (e: any) => setError(e?.message ?? 'The plan could not be saved.'),
  });

  if (rolls.isLoading) return <LoadingState label="Reading the register" />;
  if (rolls.isError) {
    return <ErrorState error={rolls.error} onRetry={() => void rolls.refetch()} />;
  }

  const all = rolls.data ?? [];

  /* Planned, in the order they will be cut. A roll with no priority sorts
     last rather than first: it is in the plan but nobody has placed it. */
  const planned = all
    .filter((r) => r.status === 'Planned')
    .sort((a, b) => (Number(a.planPriority) || 9e9) - (Number(b.planPriority) || 9e9));

  const inStock = all.filter((r) => r.status === 'Received');

  /*
   * The groups the warehouse sorts fabric by, taken from the names rather
   * than from a column: the register has no kind of its own, and the three
   * words appear in every roll's name.
   */
  const groupOf = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('innercap')) return 'Bamboo Innercap';
    if (n.includes('bamboo')) return 'Bamboo Plain';
    if (n.includes('printed')) return 'Printed';
    return 'Other';
  };

  const groups = ['Printed', 'Bamboo Innercap', 'Bamboo Plain', 'Other']
    .map((g) => {
      const rows = inStock.filter((r) => groupOf(r.rollName) === g);
      return {
        g,
        rolls: rows.length,
        metres: Math.round(rows.reduce((n, r) => n + (Number(r.meters) || 0), 0) * 10) / 10,
      };
    })
    .filter((x) => x.rolls);

  const needle = filter.trim().toLowerCase();
  const shown = inStock.filter((r) =>
    (!group || groupOf(r.rollName) === group)
    && (!needle
      || r.rollName.toLowerCase().includes(needle)
      || r.rollCode.toLowerCase().includes(needle)
      || r.ctn.toLowerCase().includes(needle)));

  const totalMetres = Math.round(
    planned.reduce((n, r) => n + (Number(r.meters) || 0), 0) * 10) / 10;
  const totalUnits = planned.reduce(
    (n, r) => n + (Number(r.expectedUnits) || 0), 0);

  /* Swapping two neighbours is two writes, which is what the sheet stores:
     a priority per roll, not a list. */
  const swap = (i: number, j: number) => {
    const a = planned[i]; const b = planned[j];
    if (!a || !b) return;
    plan.mutate({ rollId: a.rollId, priority: String(j + 1) });
    plan.mutate({ rollId: b.rollId, priority: String(i + 1) });
  };

  return (
    <>
      {error ? <p className="state state--error">{error}</p> : null}

      <Card title="Workshop order"
            subtitle={planned.length
              ? `${planned.length} roll${planned.length === 1 ? '' : 's'} · `
                + `${totalMetres} m · ~${totalUnits} units`
              : undefined}>
        {!planned.length ? (
          <p className="muted">Nothing is planned yet.</p>
        ) : (
          <ul className="attlist">
            {planned.map((r, i) => (
              <li key={r.rollId}>
                <div className="polines__row">
                  <span className="attrow__name">
                    <span className="rollpill is-s1">{i + 1}</span>
                    {' '}<strong>{r.rollName}</strong>
                    <span className="muted">
                      {' '}CTN {r.ctn || '—'} · {r.meters} m
                      {r.expectedUnits ? ` · ~${r.expectedUnits} units` : ''}
                      {' · '}{r.rollId}
                    </span>
                  </span>
                  <input className="input" type="date"
                         aria-label={`Planned date for ${r.rollName}`}
                         value={String(r.plannedDate ?? '').slice(0, 10)}
                         onChange={(e) => plan.mutate({
                           rollId: r.rollId, plannedDate: e.target.value,
                         })} />
                  <button type="button" className="iconbtn" aria-label="Move up"
                          disabled={i === 0 || plan.isPending}
                          onClick={() => swap(i, i - 1)}>↑</button>
                  <button type="button" className="iconbtn" aria-label="Move down"
                          disabled={i === planned.length - 1 || plan.isPending}
                          onClick={() => swap(i, i + 1)}>↓</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="In stock, not planned"
            subtitle={`${inStock.length} roll${inStock.length === 1 ? '' : 's'}`}
            actions={
              <input className="input input--sm" value={filter}
                     placeholder="Filter by name, code or CTN"
                     onChange={(e) => setFilter(e.target.value)} />
            }>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!group}
                  className={`tabs__tab${!group ? ' is-active' : ''}`}
                  onClick={() => setGroup('')}>
            All <span className="tabs__n">{inStock.length}</span>
          </button>
          {groups.map((x) => (
            <button key={x.g} type="button" role="tab"
                    aria-selected={group === x.g}
                    className={`tabs__tab${group === x.g ? ' is-active' : ''}`}
                    onClick={() => setGroup(x.g)}>
              {x.g} <span className="tabs__n">{x.rolls}</span>
              <span className="muted"> · {x.metres} m</span>
            </button>
          ))}
        </div>

        {!shown.length ? (
          <EmptyState icon="list" title="Nothing here"
                      hint={needle ? 'Nothing matches that.' : 'Everything is planned.'} />
        ) : (
          <Paged rows={shown} perPage={25} render={(page: WarehouseRoll[]) => (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Roll</th>
                    <th scope="col" className="is-end">CTN</th>
                    <th scope="col" className="is-end">Metres</th>
                    <th scope="col">Received</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {page.map((r) => (
                    <tr key={r.rollId}>
                      <td>{r.rollName}</td>
                      <td className="is-end mono">{r.ctn || '—'}</td>
                      <td className="is-end mono">{r.meters}</td>
                      <td className="muted">{sheetDate(r.received)}</td>
                      <td className="is-end">
                        <button type="button" className="btn btn--ghost btn--sm"
                                disabled={plan.isPending}
                                onClick={() => plan.mutate({
                                  rollId: r.rollId,
                                  priority: String(planned.length + 1),
                                })}>
                          + Add to plan
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )} />
        )}
      </Card>
    </>
  );
}