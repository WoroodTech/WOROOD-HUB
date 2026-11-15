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
  WarehousePatch, WarehousePatchComment, WarehousePlace, WarehouseReturnIssue,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
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

      {issue.attachment ? (
        <p>
          <a href={issue.attachment} target="_blank" rel="noreferrer" className="ordername">
            <Icon name="info" size={14} /> Photo
          </a>
        </p>
      ) : null}

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

function LogIssue({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({
    order: '', orderType: '', shippedPatch: '',
    shippedItems: '', returnedItems: '', unexpectedItems: '',
    warehouse: '', location: '', attachment: '',
  });

  const places = useQuery({
    queryKey: qk.whWarehouses,
    queryFn: () => api<WarehousePlace[]>('/warehouse/warehouses'),
    staleTime: 30 * 60_000,
  });

  const log = useMutation({
    mutationFn: () => api('/warehouse/returns', { method: 'POST', body: f }),
    onSuccess: onDone,
  });

  const locations = places.data?.find((p) => p.code === f.warehouse)?.locations ?? [];
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  return (
    <Card title="Log a return issue">
      <div className="formrow">
        <label className="field">
          <span className="field__label">Order number</span>
          <input className="input mono" value={f.order} maxLength={60}
                 onChange={(e) => set('order')(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">
            Patch it was shipped on <span className="field__opt">optional</span>
          </span>
          <input className="input mono" value={f.shippedPatch} maxLength={60}
                 onChange={(e) => set('shippedPatch')(e.target.value)} />
        </label>
      </div>

      <div className="formrow">
        <label className="field">
          <span className="field__label">What was shipped</span>
          <input className="input" value={f.shippedItems} maxLength={300}
                 placeholder="3 Azalea Printed Cotton"
                 onChange={(e) => set('shippedItems')(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">What came back</span>
          <input className="input" value={f.returnedItems} maxLength={300}
                 placeholder="2 Azalea Printed Cotton"
                 onChange={(e) => set('returnedItems')(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">
            Unexpected <span className="field__opt">things nobody sent</span>
          </span>
          <input className="input" value={f.unexpectedItems} maxLength={300}
                 onChange={(e) => set('unexpectedItems')(e.target.value)} />
        </label>
      </div>

      <div className="formrow">
        <label className="field">
          <span className="field__label">Returned into</span>
          <SearchSelect value={f.warehouse}
                        onChange={(v: string) => setF((s) => ({ ...s, warehouse: v, location: '' }))}
                        placeholder="Choose…"
                        options={(places.data ?? []).map((p) => ({ value: p.code, label: p.code }))} />
        </label>
        {locations.length ? (
          <label className="field">
            <span className="field__label">Location</span>
            <SearchSelect value={f.location} onChange={set('location')}
                          placeholder="Choose…"
                          options={locations.map((l) => ({ value: l, label: l }))} />
          </label>
        ) : null}
        <label className="field">
          <span className="field__label">
            Photo link <span className="field__opt">optional</span>
          </span>
          <input className="input" value={f.attachment} maxLength={500}
                 onChange={(e) => set('attachment')(e.target.value)} />
        </label>
      </div>

      {log.isError ? (
        <p className="notice notice--warn">{(log.error as Error)?.message}</p>
      ) : null}

      <div className="modal__foot">
        <button type="button" className="notebtn"
                disabled={log.isPending || !f.order.trim() || !f.warehouse}
                onClick={() => log.mutate()}>
          {log.isPending ? 'Saving…' : 'Log it'}
        </button>
      </div>
    </Card>
  );
}

/* ====================================================== patch log ====== */

export function WarehousePatchLog() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const patches = useQuery({
    queryKey: qk.whPatches(status),
    queryFn: () => api<WarehousePatch[]>(
      `/warehouse/patches${status ? `?status=${status}` : ''}`),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['wh'] });

  if (patches.isLoading) return <LoadingState label="Reading the patch log" />;
  if (patches.isError) {
    return <ErrorState error={patches.error} onRetry={() => void patches.refetch()} />;
  }

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Patch log</h1>
          <p className="pagehead__sub">
            Batch sheets that have been sent, and the conversation on each.
          </p>
        </div>
      </header>

      <div className="tabs" role="tablist">
        {([['', 'All'], ['Open', 'Open'], ['Closed', 'Closed']] as const).map(([k, label]) => (
          <button key={label} type="button" role="tab" aria-selected={status === k}
                  className={`tabs__tab${status === k ? ' is-active' : ''}`}
                  onClick={() => setStatus(k)}>
            {label}
          </button>
        ))}
      </div>

      {!patches.data?.length ? (
        <EmptyState title="Nothing sent" hint="No batch sheets have gone out." />
      ) : (
        <Card title={`${patches.data.length} patch${patches.data.length === 1 ? '' : 'es'}`}>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Patch</th>
                  <th scope="col">Last sent</th>
                  <th scope="col">By</th>
                  <th scope="col" className="is-end">Sent</th>
                  <th scope="col" className="is-end">Orders</th>
                  <th scope="col" className="is-end">Units</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="is-end">Notes</th>
                </tr>
              </thead>
              <tbody>
                {patches.data.map((p) => (
                  <tr key={p.patch}>
                    <td>
                      <button type="button" className="ordername"
                              onClick={() => setOpen(open === p.patch ? null : p.patch)}>
                        {p.patch}
                      </button>
                    </td>
                    <td>{sheetDate(p.lastSent)}</td>
                    <td>{p.sentBy || '—'}</td>
                    {/* More than once is usually a reprint, and sometimes a
                        mistake worth noticing — so it is marked. */}
                    <td className={`is-end mono${p.timesSent > 1 ? ' whline__have is-bad' : ''}`}>
                      {p.timesSent || '—'}
                    </td>
                    <td className="is-end mono">{p.orders || '—'}</td>
                    <td className="is-end mono">{p.units || '—'}</td>
                    <td>
                      <span className={`rollpill ${p.status === 'Closed' ? 'is-s5' : 'is-s1'}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="is-end mono">{p.comments || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {open ? <PatchDetail patch={open} onChanged={refresh} /> : null}
    </div>
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