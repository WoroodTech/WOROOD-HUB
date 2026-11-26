/**
 * QR labels, and the register of printed papers.
 *
 * The labels print on a 50 × 30 mm label printer or many to an A4 sheet, and
 * the sizes are in millimetres rather than pixels — a label that is 5% out
 * does not fit the stock it is printed on.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { WarehouseItem } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { qrPath } from '../lib/qr';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/Searchselect';
import { EmptyState, ErrorState, LoadingState } from '../components/States';

interface Label {
  name: string; code: string; group: string; qr: string; copies: number;
}

function sheetDate(v: string | number | undefined): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000)
      .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return String(v ?? '') || '—';
}

/* ======================================================== labels ======= */

export function WarehouseLabels() {
  const [lines, setLines] = useState([{ id: '1', item: '', copies: '1' }]);
  const [paper, setPaper] = useState<'label' | 'a4'>('label');
  const [sheet, setSheet] = useState<Label[] | null>(null);

  const items = useQuery({
    queryKey: qk.whItems,
    queryFn: () => api<WarehouseItem[]>('/warehouse/items'),
    staleTime: 30 * 60_000,
  });

  const build = useMutation({
    mutationFn: () => api<{ labels: Label[]; total: number }>('/warehouse/labels', {
      method: 'POST',
      body: {
        lines: lines
          .filter((l) => l.item && Number(l.copies) > 0)
          .map((l) => ({ item: l.item, copies: Number(l.copies) })),
      },
    }),
    onSuccess: (res) => setSheet(res.labels),
  });

  const ready = lines.some((l) => l.item && Number(l.copies) > 0);

  return (
    <div className="page">
      <header className="pagehead no-print">
        <div>
          <h1 className="pagehead__title">QR labels</h1>
          <p className="pagehead__sub">
            The code on each label is the item&rsquo;s own, so a scan matches
            the catalogue.
          </p>
        </div>
      </header>

      <div className="no-print">
        <Card title="What to print">
          {lines.map((line) => (
            <div className="whline" key={line.id}>
              <SearchSelect
                value={line.item}
                onChange={(v: string) => setLines((ls) =>
                  ls.map((l) => (l.id === line.id ? { ...l, item: v } : l)))}
                placeholder="Find an item…"
                options={(items.data ?? []).map((i) => ({
                  value: i.name, label: i.name, hint: i.code,
                }))} />
              <input className="input whline__qty" type="number" min="1" max="200" step="1"
                     value={line.copies}
                     onChange={(e) => setLines((ls) =>
                       ls.map((l) => (l.id === line.id ? { ...l, copies: e.target.value } : l)))} />
              <span className="whline__have">copies</span>
              <button type="button" className="iconbtn" aria-label="Remove"
                      disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((l) => l.id !== line.id))}>
                <Icon name="minus" size={15} />
              </button>
            </div>
          ))}

          <button type="button" className="btn btn--ghost"
                  onClick={() => setLines((ls) => [...ls,
                    { id: String(Date.now()), item: '', copies: '1' }])}>
            Add another item
          </button>

          <label className="field" style={{ marginBlockStart: 14 }}>
            <span className="field__label">Paper</span>
            <select className="input" value={paper}
                    onChange={(e) => setPaper(e.target.value as any)}>
              <option value="label">Label printer — 50 × 30 mm</option>
              <option value="a4">A4 sheet (many labels)</option>
            </select>
          </label>

          {build.isError ? (
            <p className="notice notice--warn">{(build.error as Error)?.message}</p>
          ) : null}

          <div className="modal__foot">
            <button type="button" className="notebtn" disabled={!ready || build.isPending}
                    onClick={() => build.mutate()}>
              {build.isPending ? 'Building…' : 'Make the labels'}
            </button>
            {sheet ? (
              <button type="button" className="notebtn"
                      onClick={() => {
                        const pageStyle = document.createElement('style');
                        pageStyle.textContent = paper === 'label'
                          ? '@page { size: 50mm 30mm; margin: 0; }'
                          : '@page { size: A4; margin: 8mm; }';
                        document.head.appendChild(pageStyle);
                        const done = () => {
                          pageStyle.remove();
                          window.removeEventListener('afterprint', done);
                        };
                        window.addEventListener('afterprint', done);
                        window.print();
                      }}>
                Print
              </button>
            ) : null}
          </div>
        </Card>
      </div>

      {sheet ? <LabelSheet labels={sheet} paper={paper} /> : null}
    </div>
  );
}

function LabelSheet({ labels, paper }: { labels: Label[]; paper: 'label' | 'a4' }) {
  /* Expanded once: the copies are what goes on paper, and recomputing the
     QR for each copy of the same code would be the same work many times. */
  const printed = useMemo(() => {
    const out: Label[] = [];
    for (const l of labels) {
      for (let i = 0; i < l.copies; i++) out.push(l);
    }
    return out;
  }, [labels]);

  const codes = useMemo(() => {
    const m = new Map<string, { path: string; size: number }>();
    for (const l of labels) if (!m.has(l.qr)) m.set(l.qr, qrPath(l.qr));
    return m;
  }, [labels]);

  return (
    <div className={`labelsheet labelsheet--${paper}`}>
      {printed.map((l, i) => {
        const qr = codes.get(l.qr)!;
        return (
          <div className="qrlabel" key={i}>
            <svg className="qrlabel__qr"
                 viewBox={`0 0 ${qr.size} ${qr.size}`}
                 /* Four modules of white around it. Without the quiet zone a
                    scanner cannot find the code at all, and a label printed
                    edge to edge is the commonest reason one will not read. */
                 style={{ padding: `${(4 / qr.size) * 100}%` }}
                 aria-label={`QR code for ${l.code}`}>
              <path d={qr.path} fill="currentColor" />
            </svg>
            <div className="qrlabel__text">
              <strong className="qrlabel__code">{l.code}</strong>
              <span className="qrlabel__name">{l.name}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ===================================================== documents ======= */

interface Doc {
  rowNumber: number;
  serial: string; type: string; transaction: string; ref: string;
  units: number; items: string;
  created: string | number; createdBy: string;
  timesPrinted: number; lastPrinted: string | number; lastPrintedBy: string;
}

export function WarehouseDocuments() {
  const [type, setType] = useState('');

  const docs = useQuery({
    queryKey: ['wh', 'documents', type],
    queryFn: () => api<Doc[]>(`/warehouse/documents${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  });

  if (docs.isLoading) return <LoadingState label="Reading the document register" />;
  if (docs.isError) {
    return <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;
  }

  const types = [...new Set((docs.data ?? []).map((d) => d.type))].filter(Boolean);
  const reprinted = (docs.data ?? []).filter((d) => d.timesPrinted > 1).length;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Documents</h1>
          <p className="pagehead__sub">
            Every paper printed, by serial, and how many times each has gone
            through a printer.
          </p>
        </div>
      </header>

      {reprinted ? (
        <p className="notice" role="status">
          {/* A quality note printed four times is four pieces of paper that
              all look official. Knowing there are four is the point of
              keeping the count. */}
          <Icon name="info" size={16} /> {reprinted} document
          {reprinted === 1 ? ' has' : 's have'} been printed more than once.
        </p>
      ) : null}

      {types.length > 1 ? (
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!type}
                  className={`tabs__tab${!type ? ' is-active' : ''}`}
                  onClick={() => setType('')}>All</button>
          {types.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={type === t}
                    className={`tabs__tab${type === t ? ' is-active' : ''}`}
                    onClick={() => setType(type === t ? '' : t)}>{t}</button>
          ))}
        </div>
      ) : null}

      {!docs.data?.length ? (
        <EmptyState title="Nothing printed"
                    hint="Serials appear here as papers are reserved." />
      ) : (
        <Card title={`${docs.data.length} document${docs.data.length === 1 ? '' : 's'}`}>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Serial</th>
                  <th scope="col">Kind</th>
                  <th scope="col">For</th>
                  <th scope="col" className="is-end">Units</th>
                  <th scope="col">Created</th>
                  <th scope="col" className="is-end">Printed</th>
                  <th scope="col">Last</th>
                </tr>
              </thead>
              <tbody>
                {docs.data.map((d) => (
                  <tr key={d.serial}>
                    <td className="mono">{d.serial}</td>
                    <td>{d.type}</td>
                    <td className="mono">{d.ref || d.transaction || '—'}</td>
                    <td className="is-end mono">{d.units || '—'}</td>
                    <td>
                      {sheetDate(d.created)}
                      {d.createdBy ? <small className="muted"> · {d.createdBy}</small> : null}
                    </td>
                    {/* Zero means a serial was taken and nothing was ever
                        printed, which is itself worth seeing. */}
                    <td className={`is-end mono${d.timesPrinted > 1 ? ' whline__have is-bad' : ''}`}>
                      {d.timesPrinted}
                    </td>
                    <td>
                      {d.timesPrinted ? (
                        <>
                          {sheetDate(d.lastPrinted)}
                          {d.lastPrintedBy
                            ? <small className="muted"> · {d.lastPrintedBy}</small> : null}
                        </>
                      ) : <span className="muted">not yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}