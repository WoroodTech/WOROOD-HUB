/**
 * One comment, put on many orders.
 *
 * The file is read here rather than uploaded: a spreadsheet that cannot be
 * parsed is caught before anything leaves the browser, and the API never has
 * to know what an .xlsx is. What goes up is the comment and a list of
 * references.
 *
 * Nothing about this screen blocks. The upload returns as soon as the
 * references have been checked, and the run is watched by polling — so a slow
 * run is a progress bar rather than a frozen tab, and closing the tab does
 * not stop it.
 */
import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../lib/api';
import { Icon } from './Icon';

const MAX_ORDERS = 500;

interface RunStatus {
  id: string;
  status: 'CHECKING' | 'REFUSED' | 'RUNNING' | 'DONE' | 'CANCELLED';
  total: number;
  published: number;
  failed: number;
  refusedReason: string | null;
  failures: { reference: string; error: string }[];
}

export function BulkCommentDialog({ onClose }: { onClose: () => void }) {
  const [body, setBody] = useState('');
  const [refs, setRefs] = useState<string[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunStatus | null>(null);
  const timer = useRef<number | null>(null);

  /* Watch a running job. Stops on its own when the run ends, and on unmount,
     so closing the dialog does not leave a request going round forever. */
  useEffect(() => {
    if (!run || (run.status !== 'RUNNING' && run.status !== 'CHECKING')) return;
    timer.current = window.setInterval(async () => {
      try {
        const next = await api<RunStatus>(`/sales/orders/bulk-comment/${run.id}`);
        setRun(next);
      } catch { /* a blip; the next tick tries again */ }
    }, 2000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [run?.id, run?.status]);

  /**
   * Read the references out of the file.
   *
   * Takes the first column of the first sheet and skips anything that looks
   * like a header. A file is one column of order references — that is what
   * the people doing this produce, and asking them to name a column would be
   * a rule to get wrong.
   */
  const readFile = async (file: File) => {
    setFileError(null);
    setRefs(null);
    setFileName(file.name);
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('empty');

      const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false });
      const found: string[] = [];
      for (const row of rows) {
        const cell = row?.[0];
        if (cell === undefined || cell === null) continue;
        const v = String(cell).trim();
        if (!v) continue;
        /* A header has no digits in it; every order reference does. */
        if (!/\d/.test(v)) continue;
        found.push(v);
      }

      if (!found.length) {
        setFileError('No order references in the first column of that file.');
        return;
      }

      /* De-duplicated here as well as on the server, so the count on screen
         is the count that will run. */
      const unique = [...new Set(found.map((r) => r.replace(/^#/, '')))]
        .map((r) => `#${r}`);

      if (unique.length > MAX_ORDERS) {
        setFileError(
          `That file has ${unique.length} orders. The most that can go in one `
          + `run is ${MAX_ORDERS} — split it and send the rest separately.`);
        setRefs(null);
        return;
      }

      setRefs(unique);
    } catch {
      setFileError('That file could not be read. A .xlsx or .csv with the references in the first column.');
    }
  };

  const send = async () => {
    if (!refs || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api<RunStatus>('/sales/orders/bulk-comment', {
        method: 'POST',
        body: { body: body.trim(), references: refs },
      });
      setRun(started);
    } catch (e: any) {
      setError(e?.message ?? 'That could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    try {
      await api(`/sales/orders/bulk-comment/${run.id}/cancel`, { method: 'POST' });
      setRun({ ...run, status: 'CANCELLED' });
    } catch { /* it probably finished between the click and the call */ }
  };

  const ready = !!refs?.length && body.trim().length > 0 && !busy;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Comment on orders">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel modal__panel--wide">
        <header className="modal__head">
          <h2 className="modal__title">Comment on orders</h2>
          <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}>
            <Icon name="minus" size={16} />
          </button>
        </header>

        <div className="modal__body">
          {run ? (
            <RunProgress run={run} onCancel={cancel} onClose={onClose} />
          ) : (
            <>
              <label className="field">
                <span className="field__label">The comment</span>
                <textarea className="input" rows={3} maxLength={4000} autoFocus
                          value={body} onChange={(e) => setBody(e.target.value)}
                          placeholder="Goes on every order in the file, published to its Shopify note." />
              </label>

              <label className="field">
                <span className="field__label">
                  The orders <span className="field__opt">.xlsx or .csv, references in the first column</span>
                </span>
                <input className="input" type="file" accept=".xlsx,.xls,.csv"
                       onChange={(e) => {
                         const f = e.target.files?.[0];
                         if (f) void readFile(f);
                       }} />
              </label>

              {fileError ? (
                <p className="notice notice--warn">{fileError}</p>
              ) : refs ? (
                <p className="notice">
                  <strong>{refs.length}</strong> order{refs.length === 1 ? '' : 's'} in {fileName}.
                  {' '}Every reference is checked against this portal before anything is published.
                </p>
              ) : null}

              {error ? <p className="notice notice--warn">{error}</p> : null}

              <div className="modal__foot">
                <button type="button" className="btn btn--ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="notebtn" disabled={!ready} onClick={() => void send()}>
                  {busy ? 'Checking…' : `Comment on ${refs?.length ?? 0} orders`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * How a run is going.
 *
 * A refusal and a failure are shown differently on purpose: a refusal means
 * nothing was published and the file can be fixed, while a failure means some
 * comments are already on orders and only the rest need attention.
 */
function RunProgress({ run, onCancel, onClose }: {
  run: RunStatus;
  onCancel: () => void;
  onClose: () => void;
}) {
  if (run.status === 'REFUSED') {
    return (
      <>
        <p className="notice notice--warn">
          <strong>Nothing was published.</strong> {run.refusedReason}
        </p>
        <div className="modal__foot">
          <button type="button" className="notebtn" onClick={onClose}>Close</button>
        </div>
      </>
    );
  }

  const done = run.published + run.failed;
  const pct = run.total ? Math.round((done / run.total) * 100) : 0;
  const finished = run.status === 'DONE' || run.status === 'CANCELLED';

  return (
    <>
      <p className="bulkrun__line">
        {finished
          ? `${run.published} of ${run.total} published`
          : `Publishing… ${done} of ${run.total}`}
        {run.failed ? <span className="bulkrun__bad"> · {run.failed} failed</span> : null}
      </p>

      <div className="bulkrun__track" role="progressbar"
           aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span className="bulkrun__fill" style={{ inlineSize: `${pct}%` }} />
      </div>

      {!finished ? (
        <p className="bulkrun__hint">
          This keeps going if you close the window — Shopify is written to one
          order at a time, so five hundred takes a few minutes.
        </p>
      ) : null}

      {run.failures.length ? (
        <div className="bulkrun__fails">
          <p className="bulkrun__failhead">These were not published:</p>
          <ul>
            {run.failures.map((f) => (
              <li key={f.reference}>
                <span className="mono">{f.reference}</span> — {f.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="modal__foot">
        {finished ? (
          <button type="button" className="notebtn" onClick={onClose}>Close</button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={onCancel}>
              Stop
            </button>
            <button type="button" className="notebtn" onClick={onClose}>
              Leave it running
            </button>
          </>
        )}
      </div>
    </>
  );
}