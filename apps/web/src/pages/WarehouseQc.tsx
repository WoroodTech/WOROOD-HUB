/**
 * Quality check.
 *
 * A batch arrives in WH-05, quality counts it, hands pieces back saying where
 * each goes, and the warehouse keeper counts and confirms. Only the confirm
 * writes stock — so the two sides of that step are deliberately different
 * screens within this one, and each is only usable by whoever holds the right
 * permission.
 *
 * What quality said and what the keeper counted are both shown, side by side,
 * at every stage. The gap between them is the thing this exists to surface.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WarehouseQcBatch, WarehouseQcLine, WarehousePlace,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useAuth } from '../lib/auth';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/Searchselect';
import { EmptyState, ErrorState, LoadingState } from '../components/States';

function sheetDate(v: string | number | undefined): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000)
      .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return String(v ?? '') || '—';
}

/** What is still with quality on a line. */
const left = (l: WarehouseQcLine) => Math.max(0, l.got - l.done - l.short);

export function WarehouseQc({ side }: {
  /**
   * Which half of the cycle to show, when this is a tab rather than a page.
   *
   * The Apps Script splits it in two because the two are different people's
   * work: `In Quality` is what quality still holds, `Receiving From
   * Quality` is what it has handed back and the warehouse has yet to count.
   * One list holding both means each desk reads past the other's rows.
   *
   * Left out, the page shows everything — which is what the Rolls and QC
   * page itself wants.
   */
  side?: 'holding' | 'returning';
} = {}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [cycle, setCycle] = useState<'A' | 'Q' | 'W'>('A');
  const [state, setState] = useState<'open' | 'complete' | 'all'>('open');
  const [newest, setNewest] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const batches = useQuery({
    queryKey: qk.whQc(cycle),
    queryFn: () => api<WarehouseQcBatch[]>(
      `/warehouse/qc${cycle !== 'A' ? `?cycle=${cycle}` : ''}`),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['wh'] });

  /* A batch is "returning" once quality has handed something back and the
     warehouse has not confirmed it; everything else it still holds. */
  const shown = (batches.data ?? []).filter((b) => {
    if (!side) return true;
    /* "Waiting for warehouse" is the handover: quality has let go of it and
       the warehouse has not counted it yet. Everything before that, quality
       still holds. */
    const handedBack = b.status === 'Waiting for warehouse';
    return side === 'returning' ? handedBack : !handedBack;
  });

  if (batches.isLoading) return <LoadingState label="Reading quality batches" />;
  if (batches.isError) {
    return <ErrorState error={batches.error} onRetry={() => void batches.refetch()} />;
  }

  /*
   * Open or complete, and newest first by default.
   *
   * A batch that is done is history: it is worth being able to find, and it
   * is not worth scrolling past to reach the ones that still need somebody.
   * The Apps Script defaults to Open for exactly that reason.
   */
  const settled = (b: WarehouseQcBatch) =>
    b.status === 'Complete' || b.status === 'Cancelled';

  const rows = shown
    .filter((b) => (state === 'all' ? true
      : state === 'open' ? !settled(b) : settled(b)))
    .sort((a, b) => {
      const at = String(a.updated ?? a.created ?? '');
      const bt = String(b.updated ?? b.created ?? '');
      return newest ? bt.localeCompare(at) : at.localeCompare(bt);
    });

  /*
   * What is outstanding, in three numbers.
   *
   * Quality holding forty templates is a different problem from quality
   * holding four thousand pieces, and a shortage is a third thing again —
   * so they are counted apart rather than summed into one tile.
   */
  const outstanding = shown.filter((b) => !settled(b));
  const withQuality = outstanding.reduce((n, b) => n
    + b.lines.reduce((m, l) => m + (Number(l.sent) || 0), 0), 0);
  const shortage = shown.reduce((n, b) => n
    + (b.state?.shortages?.length ?? 0), 0);

  const counts = rows.reduce((m, b) => {
    m[b.status] = (m[b.status] ?? 0) + 1;
    return m;
  }, {} as Record<string, number>);

  return (
    <div className={`page${side ? ' page--embedded' : ''}`}>
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Quality check</h1>
          <p className="pagehead__sub">
            Stock routed through WH-05, from arrival to back in the warehouse.
          </p>
        </div>
      </header>

      {/*
        * What is outstanding, in three numbers.
        *
        * Quality holding forty templates is a different problem from quality
        * holding four thousand pieces, and a shortage is a third thing
        * again — so they are counted apart rather than summed into one.
        */}
      <section className="totalsgrid" aria-label="With quality">
        <div className="tile">
          <button type="button" className="kpi kpi--pick"
                  onClick={() => { setState('open'); setCycle('A'); }}>
            <div className="kpi__top"><p className="kpi__label">Open templates</p></div>
            <p className="kpi__value">{outstanding.length}</p>
            <p className="kpi__sub">
              {outstanding.length ? 'still open' : 'nothing open'}
            </p>
          </button>
        </div>
        <div className="tile">
          <div className="kpi">
            <div className="kpi__top">
              <p className="kpi__label">Item and quantity with quality</p>
            </div>
            <p className="kpi__value">{withQuality.toLocaleString()}</p>
            <p className="kpi__sub">pieces on open templates</p>
          </div>
        </div>
        <div className="tile">
          <div className="kpi">
            <div className="kpi__top"><p className="kpi__label">Shortage</p></div>
            <p className="kpi__value">{shortage}</p>
            <p className="kpi__sub">
              {shortage ? 'lines short' : 'no shortage'}
            </p>
          </div>
        </div>
      </section>

      {/* Two cycles share this: Q.C for Worood Quality, W.Q for Workshop
          Quality. Somebody in one team sees only theirs; a manager sees both
          and can filter. */}
      <div className="tabs" role="tablist">
        {([['A', 'All'], ['Q', 'Worood Quality'], ['W', 'Workshop Quality']] as const)
          .map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={cycle === k}
                    className={`tabs__tab${cycle === k ? ' is-active' : ''}`}
                    onClick={() => { setCycle(k); setOpen(null); }}>
              {label}
            </button>
          ))}
      </div>

      <div className="formrow">
        <div className="tabs" role="tablist">
          {([['open', 'Open'], ['complete', 'Complete'], ['all', 'All']] as const)
            .map(([k, label]) => (
              <button key={k} type="button" role="tab"
                      aria-selected={state === k}
                      className={`tabs__tab${state === k ? ' is-active' : ''}`}
                      onClick={() => { setState(k); setOpen(null); }}>
                {label}
              </button>
            ))}
        </div>
        <label className="field">
          <span className="field__label">Order</span>
          <select className="input input--sm" value={newest ? 'new' : 'old'}
                  onChange={(e) => setNewest(e.target.value === 'new')}>
            <option value="new">Newest first</option>
            <option value="old">Oldest first</option>
          </select>
        </label>
      </div>

      {/*
        * Confirmed hand-backs, ready for signatures.
        *
        * The paper is what the warehouse and quality both sign, so it is
        * printed after the count rather than before it — and it belongs on
        * the receiving side of the screen, where the person who just
        * counted is standing.
        */}
      {side === 'returning' ? <ReceivedToPrint batches={shown} /> : null}

      <p className="muted qcsummary">
        {(['New', 'With quality', 'Waiting for warehouse', 'Complete'] as const)
          .filter((s) => counts[s])
          .map((s) => `${counts[s]} ${s.toLowerCase()}`)
          .join(' · ') || 'nothing here'}
      </p>

      {!rows.length ? (
        <EmptyState title="No batches"
                    hint="A transfer into WH-05 opens one automatically." />
      ) : rows.map((b) => (
        <Card key={b.serial}
              title={b.serial}
              subtitle={`${b.location} · opened ${sheetDate(b.created)}`
                + (b.createdBy ? ` by ${b.createdBy}` : '')}
              actions={<QcPill status={b.status} />}>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="is-end">Sent</th>
                  <th scope="col" className="is-end">Arrived</th>
                  <th scope="col" className="is-end">Back</th>
                  <th scope="col" className="is-end">Short</th>
                  <th scope="col" className="is-end">With quality</th>
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.item}>
                    <td>{l.item}</td>
                    <td className="is-end mono">{l.sent || '—'}</td>
                    {/* What arrived against what was sent: the first place a
                        discrepancy can show, and the cheapest to fix. */}
                    <td className={`is-end mono${b.state.received && l.got !== l.sent
                      ? ' whline__have is-bad' : ''}`}>
                      {b.state.received ? l.got : '—'}
                    </td>
                    <td className="is-end mono">{l.done || '—'}</td>
                    <td className="is-end mono">{l.short || '—'}</td>
                    <td className="is-end mono"><strong>{left(l)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {b.state.rounds?.length ? (
            <>
              <h3 className="subhead">Hand-backs</h3>
              <ul className="qcrounds">
                {b.state.rounds.map((r) => (
                  <li key={r.n} className={`qcround is-${r.status.toLowerCase()}`}>
                    <div className="qcround__head">
                      <span>
                        <strong>#{r.n}</strong> · {r.by} · {sheetDate(r.at)}
                      </span>
                      <span className="qcround__status">{r.status}</span>
                    </div>
                    <ul className="qcround__lines">
                      {r.lines.map((l, i) => {
                        const took = r.confirmedLines?.find(
                          (c) => c.item === l.item && c.warehouse === l.warehouse
                            && (c.location ?? '') === (l.location ?? ''))?.quantity;
                        return (
                          <li key={i}>
                            <span>{l.item}</span>
                            <span className="mono">
                              {l.warehouse}{l.location ? ` / ${l.location}` : ''}
                            </span>
                            <span className="mono">
                              {l.quantity}
                              {/* What quality offered, and what the keeper
                                  took. The ledger got the second one. */}
                              {took !== undefined && took !== l.quantity ? (
                                <strong className="qcround__took"> → {took}</strong>
                              ) : null}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    {r.recallReason ? (
                      <p className="qcround__note">Recalled: {r.recallReason}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {b.state.shortages?.length ? (
            <p className="muted whappr__note">
              <Icon name="info" size={14} />{' '}
              {b.state.shortages.map((s) =>
                `${s.quantity} ${s.item} — ${s.reason}`).join('; ')}
            </p>
          ) : null}

          <QcActions batch={b} canConfirm={can('warehouse.tx.write')}
                     onChanged={() => { refresh(); setOpen(null); }}
                     open={open === b.serial}
                     onToggle={() => setOpen(open === b.serial ? null : b.serial)} />
        </Card>
      ))}
    </div>
  );
}

/* ===================================================== the actions ===== */

function QcActions({ batch, canConfirm, onChanged, open, onToggle }: {
  batch: WarehouseQcBatch; canConfirm: boolean;
  onChanged: () => void; open: boolean; onToggle: () => void;
}) {
  const waiting = batch.state.rounds?.find((r) => r.status === 'Waiting');

  if (batch.status === 'Complete' || batch.status === 'Cancelled') return null;

  return (
    <>
      <div className="modal__foot">
        <button type="button" className="notebtn" onClick={onToggle}>
          {open ? 'Close'
           : batch.status === 'New' ? 'Count what arrived'
           : waiting ? (canConfirm ? 'Count and confirm' : 'See the hand-back')
           : 'Hand some back'}
        </button>
      </div>

      {open ? (
        batch.status === 'New' ? <QcReceive batch={batch} onDone={onChanged} />
        : waiting ? <QcConfirm batch={batch} round={waiting} canConfirm={canConfirm}
                               onDone={onChanged} />
        : <QcHandBack batch={batch} onDone={onChanged} />
      ) : null}
    </>
  );
}

/* --------------------------------------------------------- receive ---- */

function QcReceive({ batch, onDone }: { batch: WarehouseQcBatch; onDone: () => void }) {
  const [counts, setCounts] = useState<Record<string, string>>(
    /* Pre-filled with what the transfer said: the common case is that it all
       arrived, and typing the same numbers again invites typos. */
    Object.fromEntries(batch.lines.map((l) => [l.item, String(l.sent)])));

  const receive = useMutation({
    mutationFn: () => api('/warehouse/qc/receive', {
      method: 'POST',
      body: {
        serial: batch.serial,
        counted: batch.lines.map((l) => ({
          item: l.item, got: Number(counts[l.item] ?? 0),
        })),
      },
    }),
    onSuccess: onDone,
  });

  return (
    <div className="qcform">
      <p className="muted">
        What actually arrived. If it differs from what was sent, say what
        arrived — the difference is recorded here rather than found later.
      </p>
      {batch.lines.map((l) => (
        <div className="qcform__row" key={l.item}>
          <span>{l.item}</span>
          <span className="muted mono">sent {l.sent}</span>
          <input className="input whline__qty" type="number" min="0" step="1"
                 value={counts[l.item] ?? ''}
                 onChange={(e) => setCounts((c) => ({ ...c, [l.item]: e.target.value }))} />
        </div>
      ))}
      {receive.isError ? (
        <p className="notice notice--warn">{(receive.error as Error)?.message}</p>
      ) : null}
      <div className="modal__foot">
        <button type="button" className="notebtn" disabled={receive.isPending}
                onClick={() => receive.mutate()}>
          {receive.isPending ? 'Saving…' : 'Record what arrived'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- hand back ---- */

function QcHandBack({ batch, onDone }: { batch: WarehouseQcBatch; onDone: () => void }) {
  const [lines, setLines] = useState<{
    id: string; item: string; quantity: string; warehouse: string; location: string;
  }[]>([{ id: '1', item: '', quantity: '', warehouse: '', location: '' }]);

  const places = useQuery({
    queryKey: qk.whWarehouses,
    queryFn: () => api<WarehousePlace[]>('/warehouse/warehouses'),
    staleTime: 30 * 60_000,
  });

  const hand = useMutation({
    mutationFn: () => api('/warehouse/qc/hand-back', {
      method: 'POST',
      body: {
        serial: batch.serial,
        lines: lines.filter((l) => l.item && Number(l.quantity) > 0).map((l) => ({
          item: l.item, quantity: Number(l.quantity),
          warehouse: l.warehouse, location: l.location || undefined,
        })),
      },
    }),
    onSuccess: onDone,
  });

  const locationsOf = (code: string) =>
    places.data?.find((p) => p.code === code)?.locations ?? [];

  const available = batch.lines.filter((l) => left(l) > 0);

  return (
    <div className="qcform">
      <p className="muted">
        Nothing moves yet. The warehouse keeper counts this and confirms, and
        that is what reaches the ledger.
      </p>

      {lines.map((line) => {
        const avail = batch.lines.find((l) => l.item === line.item);
        const over = avail && Number(line.quantity) > left(avail);
        return (
          <div className="qcform__hand" key={line.id}>
            <SearchSelect
              value={line.item}
              onChange={(v: string) => setLines((ls) =>
                ls.map((l) => (l.id === line.id ? { ...l, item: v } : l)))}
              placeholder="Item…"
              options={available.map((l) => ({
                value: l.item, label: l.item, hint: `${left(l)} with quality`,
              }))} />

            <input className="input whline__qty" type="number" min="1" step="1"
                   placeholder="Qty" value={line.quantity} aria-invalid={over}
                   onChange={(e) => setLines((ls) =>
                     ls.map((l) => (l.id === line.id ? { ...l, quantity: e.target.value } : l)))} />

            <SearchSelect
              value={line.warehouse}
              onChange={(v: string) => setLines((ls) =>
                ls.map((l) => (l.id === line.id ? { ...l, warehouse: v, location: '' } : l)))}
              placeholder="To…"
              options={(places.data ?? []).map((p) => ({ value: p.code, label: p.code }))} />

            {locationsOf(line.warehouse).length ? (
              <SearchSelect
                value={line.location}
                onChange={(v: string) => setLines((ls) =>
                  ls.map((l) => (l.id === line.id ? { ...l, location: v } : l)))}
                placeholder="Where…"
                options={locationsOf(line.warehouse).map((l) => ({ value: l, label: l }))} />
            ) : <span />}

            <button type="button" className="iconbtn" aria-label="Remove"
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((l) => l.id !== line.id))}>
              <Icon name="minus" size={15} />
            </button>
          </div>
        );
      })}

      <button type="button" className="btn btn--ghost"
              onClick={() => setLines((ls) => [...ls,
                { id: String(Date.now()), item: '', quantity: '', warehouse: '', location: '' }])}>
        Add another
      </button>

      {hand.isError ? (
        <p className="notice notice--warn">{(hand.error as Error)?.message}</p>
      ) : null}

      <div className="modal__foot">
        <button type="button" className="notebtn" disabled={hand.isPending}
                onClick={() => hand.mutate()}>
          {hand.isPending ? 'Saving…' : 'Hand back'}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- confirm ---- */

function QcConfirm({ batch, round, canConfirm, onDone }: {
  batch: WarehouseQcBatch; round: any; canConfirm: boolean; onDone: () => void;
}) {
  const [counts, setCounts] = useState<Record<number, string>>(
    Object.fromEntries(round.lines.map((l: any, i: number) => [i, String(l.quantity)])));
  const [reason, setReason] = useState('');

  const confirm = useMutation({
    mutationFn: () => api('/warehouse/qc/confirm', {
      method: 'POST',
      body: {
        serial: batch.serial, round: round.n,
        counted: round.lines
          .map((l: any, i: number) => ({
            item: l.item, warehouse: l.warehouse, location: l.location,
            quantity: Number(counts[i] ?? 0),
          }))
          .filter((c: any) => c.quantity > 0),
      },
    }),
    onSuccess: onDone,
  });

  const recall = useMutation({
    mutationFn: () => api('/warehouse/qc/recall', {
      method: 'POST', body: { serial: batch.serial, round: round.n, reason },
    }),
    onSuccess: onDone,
  });

  if (!canConfirm) {
    return (
      <p className="muted whappr__note">
        <Icon name="info" size={14} /> Waiting for the warehouse to count this.
        Confirming it is what writes the stock, so it is theirs to do.
      </p>
    );
  }

  return (
    <div className="qcform">
      <p className="muted">
        Count what is actually there. What you enter is what reaches the
        ledger — not what quality said they were handing over.
      </p>

      {round.lines.map((l: any, i: number) => (
        <div className="qcform__row" key={i}>
          <span>{l.item}</span>
          <span className="muted mono">
            {l.warehouse}{l.location ? ` / ${l.location}` : ''} · offered {l.quantity}
          </span>
          <input className="input whline__qty" type="number" min="0" step="1"
                 value={counts[i] ?? ''}
                 onChange={(e) => setCounts((c) => ({ ...c, [i]: e.target.value }))} />
        </div>
      ))}

      {confirm.isError ? (
        <p className="notice notice--warn">{(confirm.error as Error)?.message}</p>
      ) : null}

      <div className="modal__foot">
        {/* Recall first: the one that writes stock should not be where a
            stray Enter lands. */}
        <input className="input" placeholder="Reason, if sending it back"
               value={reason} maxLength={200}
               onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn--ghost"
                disabled={recall.isPending || !reason.trim()}
                onClick={() => recall.mutate()}>
          Send back to quality
        </button>
        <button type="button" className="notebtn" disabled={confirm.isPending}
                onClick={() => confirm.mutate()}>
          {confirm.isPending ? 'Saving…' : 'Confirm and move the stock'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ pill ---- */

function QcPill({ status }: { status: string }) {
  const tone = status === 'Complete' ? 'is-s4'
    : status === 'Waiting for warehouse' ? 'is-s2'
    : status === 'Cancelled' ? 'is-s5'
    : status === 'New' ? 'is-s0' : 'is-s1';
  return <span className={`rollpill ${tone}`}>{status}</span>;
}

/* ------------------------------------------- confirmed, ready to print -- */

/**
 * What has been counted and is waiting to be signed.
 *
 * A difference is marked, because the paper with a difference on it is the
 * one somebody will be asked about — and finding it afterwards in a list
 * that does not say which is a search through every sheet.
 */
function ReceivedToPrint({ batches }: { batches: WarehouseQcBatch[] }) {
  const rows = batches.flatMap((b) =>
    (b.state?.rounds ?? [])
      .filter((r: any) => r.status === 'Confirmed')
      .map((r: any) => {
        const counted = (r.confirmedLines ?? [])
          .reduce((n: number, l: any) => n + (Number(l.quantity) || 0), 0);
        const said = (r.lines ?? [])
          .reduce((n: number, l: any) => n + (Number(l.quantity) || 0), 0);
        return {
          key: `${b.serial}-${r.n}`,
          serial: b.serial,
          round: r.n,
          counted,
          by: r.confirmedBy ?? '',
          at: String(r.confirmedAt ?? ''),
          different: counted !== said,
        };
      }));

  if (!rows.length) return null;

  return (
    <Card title="Received — print the template for signatures">
      <ul className="attlist">
        {rows.map((r) => (
          <li key={r.key}>
            <span className="attrow">
              <span className="attrow__name">
                <span className="mono">{r.serial}</span>
                <span className="muted">
                  {' '}{r.counted} pcs · {r.by}{r.at ? ` · ${r.at}` : ''}
                  {r.different ? ' · ' : ''}
                </span>
                {r.different ? (
                  <span className="is-bad">difference</span>
                ) : null}
              </span>
              <button type="button" className="btn btn--ghost btn--sm"
                      onClick={() => window.print()}>
                Print
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}