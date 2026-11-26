/**
 * Return issues, and the log of batch sheets sent out.
 *
 * Both are lists somebody works through rather than reports they read, so
 * open items come first and the action on each is in reach. The three counts
 * on an issue — shipped, returned, unexpected — sit side by side, because
 * reading them together is the whole point of logging them separately.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WarehouseItem,
  WarehousePatch, WarehousePatchComment, WarehousePlace, WarehouseReturnIssue,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/Searchselect';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { WarehouseFiles } from '../components/WarehouseFiles';
import { useAuth } from '../lib/auth';

function sheetDate(v: string | number | undefined): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000)
      .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return String(v ?? '') || '—';
}

/* ================================================== return issues ====== */

export function WarehouseReturnIssues() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'Open' | 'Resolved' | ''>('Open');
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const [logging, setLogging] = useState(false);

  const issues = useQuery({
    queryKey: qk.whIssues(`${status}|${asked}`),
    queryFn: () => {
      const p = new URLSearchParams();
      if (status) p.set('status', status);
      if (asked) p.set('q', asked);
      return api<WarehouseReturnIssue[]>(`/warehouse/returns?${p}`);
    },
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['wh'] });

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Return issues</h1>
          <p className="pagehead__sub">
            Parcels that came back wrong. Logged by whoever opened them, closed
            with what was done about it.
          </p>
        </div>
        <button type="button" className="notebtn" onClick={() => setLogging((v) => !v)}>
          {logging ? 'Cancel' : 'Log an issue'}
        </button>
      </header>

      {logging ? <LogIssue onDone={() => { setLogging(false); refresh(); }} /> : null}

      <div className="formrow">
        <div className="tabs" role="tablist">
          {([['Open', 'Open'], ['Resolved', 'Resolved'], ['', 'All']] as const)
            .map(([k, label]) => (
              <button key={label} type="button" role="tab" aria-selected={status === k}
                      className={`tabs__tab${status === k ? ' is-active' : ''}`}
                      onClick={() => setStatus(k)}>
                {label}
              </button>
            ))}
        </div>
        <label className="field">
          <span className="field__label">Search</span>
          <input className="input" value={q} maxLength={80}
                 placeholder="Order, patch, item or person"
                 onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') setAsked(q.trim()); }} />
        </label>
      </div>

      {issues.isLoading ? <LoadingState label="Reading issues" />
       : issues.isError ? (
         <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />
       ) : !issues.data?.length ? (
         <EmptyState title="Nothing here"
                     hint={status === 'Open' ? 'No open issues.' : 'Nothing matches.'} />
       ) : issues.data.map((it) => (
         <IssueCard key={it.id} issue={it} onChanged={refresh} />
       ))}
    </div>
  );
}

function IssueCard({ issue, onChanged }: {
  issue: WarehouseReturnIssue; onChanged: () => void;
}) {
  const [comment, setComment] = useState('');
  const [open, setOpen] = useState(false);

  const update = useMutation({
    mutationFn: (status: 'Open' | 'Resolved') => api('/warehouse/returns/update', {
      method: 'POST', body: { id: issue.id, status, comment },
    }),
    onSuccess: onChanged,
  });

  return (
    <Card title={`Order ${issue.order}`}
          subtitle={`${issue.id} · ${sheetDate(issue.loggedAt)}`
            + (issue.enteredBy ? ` · ${issue.enteredBy}` : '')}
          actions={
            <span className={`rollpill ${issue.status === 'Resolved' ? 'is-s4' : 'is-s2'}`}>
              {issue.status}
            </span>
          }>

      {/* The three counts together. Reading them side by side is why they are
          three fields and not one description. */}
      <div className="grid">
        {([
          ['Shipped', issue.shippedItems],
          ['Came back', issue.returnedItems],
          ['Unexpected', issue.unexpectedItems],
        ] as const).map(([label, value]) => (
          <div className="grid__cell" key={label} style={{ '--span': 4 } as any}>
            <div className="tile"><div className="kpi">
              <div className="kpi__top"><p className="kpi__label">{label}</p></div>
              <p className="kpi__value" style={{ fontSize: '1rem' }}>
                {value || <span className="muted">—</span>}
              </p>
            </div></div>
          </div>
        ))}
      </div>

      <p className="muted qcsummary">
        {issue.warehouse}{issue.location ? ` / ${issue.location}` : ''}
        {issue.shippedPatch ? ` · patch ${issue.shippedPatch}` : ''}
        {issue.orderType ? ` · ${issue.orderType}` : ''}
      </p>

      {/*
        * The issue's own photographs.
        *
        * A link kept in the sheet still shows, because issues logged before
        * this one existed have one and it is the only picture they have.
        * New ones go into the portal's store instead.
        */}
      {issue.attachment ? (
        <p>
          <a href={issue.attachment} target="_blank" rel="noreferrer" className="ordername">
            <Icon name="info" size={14} /> Photo (link)
          </a>
        </p>
      ) : null}

      <WarehouseFiles kind="return-issue" subjectId={issue.id} />

      {issue.comment ? (
        <p className="whappr__reason">
          <strong>{issue.handledBy || 'Resolved'}:</strong> {issue.comment}
        </p>
      ) : null}

      {!open ? (
        <div className="modal__foot">
          <button type="button" className="notebtn" onClick={() => setOpen(true)}>
            {issue.status === 'Open' ? 'Close this' : 'Reopen'}
          </button>
        </div>
      ) : (
        <div className="qcform">
          <label className="field">
            <span className="field__label">
              {issue.status === 'Open' ? 'What was done' : 'Why it is being reopened'}
            </span>
            <input className="input" value={comment} maxLength={300} autoFocus
                   onChange={(e) => setComment(e.target.value)} />
          </label>

          {update.isError ? (
            <p className="notice notice--warn">{(update.error as Error)?.message}</p>
          ) : null}

          <div className="modal__foot">
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="notebtn"
                    disabled={update.isPending
                      || (issue.status === 'Open' && !comment.trim())}
                    onClick={() => update.mutate(
                      issue.status === 'Open' ? 'Resolved' : 'Open')}>
              {update.isPending ? 'Saving…'
               : issue.status === 'Open' ? 'Close it' : 'Reopen it'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Where a return may go. The server enforces the same two. */
const RETURN_WAREHOUSES = ['WH-02', 'WH-05'];

function LogIssue({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({
    order: '', orderType: '', shippedPatch: '',
    shippedItems: '', returnedItems: '', unexpectedItems: '',
    warehouse: '', location: '',
  });

  /*
   * The issue's own id, once it exists.
   *
   * Photographs need something to belong to and there is nothing until the
   * issue is logged, so the form saves first and then offers to attach. The
   * issue is the thing that matters; a photograph can follow.
   */
  const [loggedId, setLoggedId] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  /*
   * The patch follows the order number.
   *
   * Looked up when the box loses focus rather than on every keystroke: an
   * order number is typed digit by digit and none of the partial ones are
   * worth a request.
   */
  const findPatch = async (order: string) => {
    if (!order.trim()) return;
    setLookingUp(true);
    try {
      const r = await api<{ patch: string | null }>(
        `/warehouse/returns/patch-for-order?order=${encodeURIComponent(order)}`);
      /* Only when nobody has typed one: a patch somebody chose themselves
         is a decision, and overwriting it would undo that silently. */
      if (r.patch) setF((x) => (x.shippedPatch ? x : { ...x, shippedPatch: r.patch! }));
    } catch {
      /* The form still works without it. */
    } finally {
      setLookingUp(false);
    }
  };

  const places = useQuery({
    queryKey: qk.whWarehouses,
    queryFn: () => api<WarehousePlace[]>('/warehouse/warehouses'),
    staleTime: 30 * 60_000,
  });

  const log = useMutation({
    mutationFn: () => api<{ ok: boolean; id: string }>(
      '/warehouse/returns', { method: 'POST', body: f }),
    onSuccess: (res) => { setLoggedId(res.id); },
  });

  const locations = places.data?.find((p) => p.code === f.warehouse)?.locations ?? [];
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  return (
    <Card title="Log a return issue">
      <div className="formrow">
        <label className="field">
          <span className="field__label">Order number</span>
          <input className="input mono" value={f.order} maxLength={60}
                 onBlur={(e) => void findPatch(e.target.value)}
                 onChange={(e) => set('order')(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">
            Patch it was shipped on <span className="field__opt">optional</span>
          </span>
          {/* Filled from the order, and still editable: the ledger knows
              which patch an order went out on, so typing it was a field
              that could be wrong about the one thing tying this issue to
              what was actually shipped. */}
          <input className="input mono" value={f.shippedPatch} maxLength={60}
                 placeholder={lookingUp ? 'looking it up…' : 'from the order'}
                 onChange={(e) => set('shippedPatch')(e.target.value)} />
        </label>
      </div>

      {/*
        * Picked from the catalogue, not typed.
        *
        * These three were free text, so "3 Azalea Printed Cotton", "3 azalea
        * printed", "Azalea x3" and a misspelling were four different things
        * to anybody reading the issue later and to every count made from it.
        * The catalogue is the list of items that exist; choosing from it
        * means the name on an issue is a name the ledger also uses.
        *
        * What is stored is unchanged — "3 Azalea Printed Cotton, 1 Pink
        * Plain Cotton" — because the sheet's column is read by the Apps
        * Script and by people, and neither wants a different shape.
        */}
      <ItemPicker label="What was shipped"
                  value={f.shippedItems}
                  onChange={set('shippedItems')} />
      <ItemPicker label="What came back"
                  value={f.returnedItems}
                  onChange={set('returnedItems')} />
      <ItemPicker label="Unexpected"
                  hint="things nobody sent"
                  value={f.unexpectedItems}
                  onChange={set('unexpectedItems')} />

      <div className="formrow">
        <label className="field">
          <span className="field__label">Returned into</span>
          <SearchSelect value={f.warehouse}
                        onChange={(v: string) => setF((s) => ({ ...s, warehouse: v, location: '' }))}
                        placeholder="Choose…"
                        /* WH-02 or WH-05 only, as the Apps Script has it:
                           "A return goes to WH-02 or WH-05 only". The
                           server refuses the rest anyway, and offering a
                           choice that will be refused wastes somebody's
                           form. */
                        options={(places.data ?? [])
                          .filter((p) => RETURN_WAREHOUSES.includes(p.code))
                          .map((p) => ({ value: p.code, label: p.code }))} />
        </label>
        {locations.length ? (
          <label className="field">
            <span className="field__label">Location</span>
            <SearchSelect value={f.location} onChange={set('location')}
                          placeholder="Choose…"
                          options={locations.map((l) => ({ value: l, label: l }))} />
          </label>
        ) : null}
      </div>

      {/*
        * Photographs, once the issue exists.
        *
        * This was a box asking for a Drive link, so the picture lived in
        * somebody's own Drive, was readable by anybody holding the link, and
        * broke when that person left — on a return dispute, which is exactly
        * when it matters.
        */}
      {loggedId ? (
        <>
          <p className="notice" role="status">
            <Icon name="check" size={16} /> Logged as{' '}
            <strong className="mono">{loggedId}</strong>. Attach photographs
            now, or close this and add them from the issue.
          </p>
          <WarehouseFiles kind="return-issue" subjectId={loggedId} />
        </>
      ) : null}

      {log.isError ? (
        <p className="notice notice--warn">{(log.error as Error)?.message}</p>
      ) : null}

      <div className="modal__foot">
        {/* Once it is logged the button closes the form instead of logging
            it again — the issue is in, and what is left is optional. */}
        {loggedId ? (
          <button type="button" className="notebtn" onClick={onDone}>
            Done
          </button>
        ) : (
          <button type="button" className="notebtn"
                  disabled={log.isPending || !f.order.trim() || !f.warehouse}
                  onClick={() => log.mutate()}>
            {log.isPending ? 'Saving…' : 'Log it'}
          </button>
        )}
      </div>
    </Card>
  );
}

/* ====================================================== patch log ====== */

export function WarehousePatchLog({ onOpenTemplate }: {
  /** Opens the Order Template tab on this patch, when shown as a tab. */
  onOpenTemplate?: (patch: string) => void;
} = {}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const { can } = useAuth();

  const patches = useQuery({
    queryKey: qk.whPatches(status),
    queryFn: () => api<WarehousePatch[]>(
      `/warehouse/patches${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['wh'] });

  /*
   * A note and a decision are one act.
   *
   * Reporting a problem with nothing written is a patch nobody can act on,
   * so the comment goes with the status rather than being a separate step
   * somebody may not take.
   */
  const act = useMutation({
    mutationFn: async (v: {
      patch: string;
      status: 'Complete' | 'Issue reported' | 'Resolved';
      comment?: string;
    }) => {
      if (v.comment?.trim()) {
        await api('/warehouse/patches/comment', {
          method: 'POST', body: { patch: v.patch, body: v.comment.trim() },
        });
      }
      return api('/warehouse/patches/status', {
        method: 'POST', body: { patch: v.patch, status: v.status },
      });
    },
    onSuccess: (_r, v) => {
      setNote((n) => ({ ...n, [v.patch]: '' }));
      refresh();
    },
  });

  if (patches.isLoading) return <LoadingState label="Reading the patch log" />;
  if (patches.isError) {
    return <ErrorState error={patches.error} onRetry={() => void patches.refetch()} />;
  }

  const needle = q.trim().toLowerCase();
  const rows = (patches.data ?? []).filter(
    (p) => !needle
      || p.patch.toLowerCase().includes(needle)
      || (p.sentBy ?? '').toLowerCase().includes(needle));

  return (
    <>
      <Card title="Which patches">
        <div className="tabs" role="tablist">
          {/* The four words the sheet actually holds. "Open" and "Closed"
              were the portal's own, and matched nothing in the column. */}
          {([['', 'All'], ['Sent', 'Waiting'], ['Issue reported', 'Issue reported'],
             ['Complete', 'Complete'], ['Resolved', 'Resolved']] as const)
            .map(([k, label]) => (
              <button key={label} type="button" role="tab"
                      aria-selected={status === k}
                      className={`tabs__tab${status === k ? ' is-active' : ''}`}
                      onClick={() => setStatus(k)}>
                {label}
              </button>
            ))}
        </div>

        <label className="field">
          <span className="field__label">Patch number or person</span>
          <input className="input" value={q} placeholder="e.g. 6267"
                 onChange={(e) => setQ(e.target.value)} />
        </label>
      </Card>

      {act.isError ? <ErrorState error={act.error} compact /> : null}

      {!rows.length ? (
        <EmptyState icon="list" title="Nothing here"
                    hint={needle ? 'Nothing matches that.'
                      : 'No batch sheets have gone out.'} />
      ) : rows.map((p) => {
        const sent = p.status === 'Sent';
        const reported = p.status === 'Issue reported';
        return (
          <Card key={p.patch}
                title={`Patch #${p.patch}`}
                actions={
                  <span className={`rollpill ${
                    p.status === 'Complete' || p.status === 'Resolved' ? 'is-s5'
                    : reported ? 'is-s2' : 'is-s1'}`}>
                    {p.status}
                  </span>
                }>
            <p className="muted">
              Sent by <strong>{p.sentBy || 'somebody'}</strong>
              {' · '}{sheetDate(p.lastSent)}
              {' · '}{p.orders} order{p.orders === 1 ? '' : 's'}
              {' · '}{p.units} pcs
              {/* More than once is usually a reprint, and sometimes a
                  mistake worth noticing. */}
              {p.timesSent > 1 ? ` · sent ${p.timesSent} times` : ''}
            </p>

            {p.closedBy ? (
              <p className="muted">
                {p.status} by <strong>{p.closedBy}</strong>
                {p.closedAt ? ` · ${sheetDate(p.closedAt)}` : ''}
              </p>
            ) : null}

            {sent || reported ? (
              <div className="noterow">
                <input className="input" maxLength={500}
                       value={note[p.patch] ?? ''}
                       placeholder="Something wrong? Write it here — comments can never be deleted"
                       onChange={(e) =>
                         setNote((n) => ({ ...n, [p.patch]: e.target.value }))} />

                {sent ? (
                  <>
                    <button type="button" className="btn btn--ghost btn--sm"
                            disabled={act.isPending || !(note[p.patch] ?? '').trim()}
                            title={(note[p.patch] ?? '').trim() ? undefined
                              : 'Say what is wrong first'}
                            onClick={() => act.mutate({
                              patch: p.patch, status: 'Issue reported',
                              comment: note[p.patch],
                            })}>
                      Report a problem
                    </button>
                    <button type="button" className="btn btn--primary btn--sm"
                            disabled={act.isPending}
                            onClick={() => act.mutate({
                              patch: p.patch, status: 'Complete',
                              comment: note[p.patch],
                            })}>
                      Complete — all correct
                    </button>
                  </>
                ) : null}

                {/* A manager's answer to a reported problem, which is why it
                    is their permission and not the warehouse's. */}
                {reported && can('warehouse.tx.manage') ? (
                  <button type="button" className="btn btn--primary btn--sm"
                          disabled={act.isPending}
                          onClick={() => act.mutate({
                            patch: p.patch, status: 'Resolved',
                            comment: note[p.patch],
                          })}>
                    Resolve
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="formrow--actions">
              <button type="button" className="btn btn--ghost btn--sm"
                      onClick={() => setOpen(open === p.patch ? null : p.patch)}>
                {open === p.patch ? 'Close conversation'
                  : `Conversation${p.comments ? ` (${p.comments})` : ''}`}
              </button>
              {/* Straight to the sheet itself, with the number already in
                  the box — the next thing anybody does with a patch. */}
              {onOpenTemplate ? (
                <button type="button" className="btn btn--ghost btn--sm"
                        onClick={() => onOpenTemplate(p.patch)}>
                  Open template
                </button>
              ) : null}
            </div>

            {open === p.patch ? (
              <PatchDetail patch={p.patch} onChanged={refresh} />
            ) : null}
          </Card>
        );
      })}
    </>
  );
}


function PatchDetail({ patch, onChanged }: { patch: string; onChanged: () => void }) {
  const [text, setText] = useState('');

  const comments = useQuery({
    queryKey: qk.whPatchComments(patch),
    queryFn: () => api<WarehousePatchComment[]>(
      `/warehouse/patches/${encodeURIComponent(patch)}/comments`),
  });

  const add = useMutation({
    mutationFn: () => api('/warehouse/patches/comment', {
      method: 'POST', body: { patch, comment: text },
    }),
    onSuccess: () => { setText(''); onChanged(); },
  });

  return (
    <Card title={patch} subtitle="Notes on this patch.">
      {comments.isLoading ? <LoadingState label="Reading notes" />
       : !comments.data?.length ? (
         <p className="muted">Nothing noted yet.</p>
       ) : (
         <ul className="qcrounds">
           {comments.data.map((c, i) => (
             <li className="qcround" key={i}>
               <div className="qcround__head">
                 <span><strong>{c.by}</strong> · {sheetDate(c.at)}</span>
               </div>
               <p style={{ margin: 0, fontSize: 13 }}>{c.comment}</p>
             </li>
           ))}
         </ul>
       )}

      <div className="qcform">
        <label className="field">
          <span className="field__label">Add a note</span>
          <input className="input" value={text} maxLength={500}
                 onChange={(e) => setText(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter' && text.trim()) add.mutate();
                 }} />
        </label>
        <div className="modal__foot">
          <button type="button" className="notebtn"
                  disabled={add.isPending || !text.trim()}
                  onClick={() => add.mutate()}>
            {add.isPending ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------- item picker -- */

/** One line of a picked list: the item as the ledger names it, and how many. */
interface PickedLine { item: string; quantity: string }

/**
 * Items chosen from the catalogue, kept as the text the sheet expects.
 *
 * The column holds "3 Azalea Printed Cotton, 1 Pink Plain Cotton" and is
 * read by the Apps Script and by people, so that is still what is stored.
 * What changes is how it is produced: the names come from the catalogue
 * rather than from typing, so an issue cannot name an item that does not
 * exist or spell one three different ways.
 *
 * Text typed before this existed is parsed back into lines where it can be,
 * and left alone where it cannot — an old issue is not worth losing.
 */
function ItemPicker({ label, hint, value, onChange }: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const items = useQuery({
    queryKey: qk.whItems,
    queryFn: () => api<WarehouseItem[]>('/warehouse/items'),
    staleTime: 30 * 60_000,
  });

  /* "3 Azalea Printed Cotton" → { quantity: 3, item: 'Azalea Printed Cotton' } */
  const lines: PickedLine[] = value.trim()
    ? value.split(',').map((part) => {
        const m = part.trim().match(/^(\d+)\s+(.*)$/);
        return m
          ? { quantity: m[1], item: m[2].trim() }
          : { quantity: '1', item: part.trim() };
      }).filter((l) => l.item)
    : [];

  /*
   * The rows on screen, which are not quite the rows that are stored.
   *
   * What is stored is the sheet's one text column, and a row with no item
   * chosen yet has nothing to put in it — so "+ Add an item" wrote a blank
   * row, the blank was filtered out on the way to the column, and the row
   * came back from the column as though it had never been added. The button
   * worked; there was simply nowhere for its row to live.
   *
   * So empty rows live here until they are filled in, and the column keeps
   * holding only real ones.
   */
  const [extra, setExtra] = useState(0);
  const rows = [...lines,
    ...Array.from({ length: extra }, () => ({ item: '', quantity: '1' }))];

  const write = (next: PickedLine[]) => {
    const real = next.filter((l) => l.item);
    /* However many of the blanks are still blank. */
    setExtra(next.length - real.length);
    onChange(real
      .map((l) => `${Number(l.quantity) || 1} ${l.item}`)
      .join(', '));
  };

  const set = (i: number, patch: Partial<PickedLine>) =>
    write(rows.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="field">
      <span className="field__label">
        {label}{hint ? <span className="field__opt"> {hint}</span> : null}
      </span>

      {rows.map((l, i) => (
        <div key={i} className="polines__row">
          <SearchSelect
            value={l.item}
            onChange={(v: string) => set(i, { item: v })}
            placeholder="Search the catalogue…"
            options={(items.data ?? []).map((it) => ({
              value: it.name, label: it.name,
            }))} />
          <input className="input" type="number" min="1" step="1"
                 aria-label="Quantity"
                 value={l.quantity}
                 onChange={(e) => set(i, { quantity: e.target.value })} />
          <button type="button" className="btn btn--ghost btn--sm"
                  onClick={() => write(rows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}

      <button type="button" className="btn btn--ghost btn--sm"
              onClick={() => setExtra((n) => n + 1)}>
        + Add an item
      </button>
    </div>
  );
}