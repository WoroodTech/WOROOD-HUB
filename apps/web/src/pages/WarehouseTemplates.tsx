/**
 * The order template — the paper that goes with a patch.
 *
 * Laid out as the existing one is: the serial at the top, the patch's facts
 * in a row of boxes, the items grouped by collection with a tick box against
 * each, the total, and three signature columns at the foot.
 *
 * Orders only. Transfers and quality checks on the same patch are left out,
 * because the paper is a list of what was sold and a transfer on it reads as
 * another order.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { WarehousePatchLog } from './WarehouseReturns';
import { WarehouseQc } from './WarehouseQc';

interface TemplateLine { item: string; order: string; quantity: number; kind: string }
interface TemplateGroup { group: string; total: number; lines: TemplateLine[] }

interface Template {
  patch: string;
  found: boolean;
  date?: string | number;
  enteredBy?: string;
  orders: number;
  items: number;
  total: number;
  groups: TemplateGroup[];
}

function sheetDate(v: string | number | undefined): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000)
      .toISOString().slice(0, 10);
  }
  return String(v ?? '') || '—';
}

/**
 * The four things a patch sheet is about, as the Apps Script groups them.
 *
 * They were four places in the portal — a page for the template, another
 * for the patch log, a third for quality — so following one patch from
 * printed sheet to quality and back meant leaving the screen each time and
 * carrying its number in your head. These are one subject at four moments.
 *
 * "Upload Shopify orders" is deliberately not here: it is the Apps Script's
 * way round having no connection to Shopify, and the portal has one.
 */
const TEMPLATE_TABS = [
  ['tpl', 'Order Template'],
  ['log', 'Patch Log'],
  ['qc', 'In Quality'],
  ['qcin', 'Receiving From Quality'],
] as const;

type TemplateTab = typeof TEMPLATE_TABS[number][0];

export function WarehouseTemplates() {
  const [tab, setTab] = useState<TemplateTab>('tpl');
  const [typed, setTyped] = useState('');
  const [patch, setPatch] = useState('');
  const [serial, setSerial] = useState<string | null>(null);
  const [copy, setCopy] = useState(1);

  const template = useQuery({
    queryKey: ['wh', 'template', patch],
    queryFn: () => api<Template>(
      `/warehouse/orders/template?patch=${encodeURIComponent(patch)}`),
    enabled: !!patch,
  });

  /*
   * A serial is taken before printing, and the count of prints is kept.
   *
   * Four copies of the same sheet all look official; knowing there are four
   * is the difference between a reprint and a piece of paper nobody can
   * account for.
   */
  const reserve = useMutation({
    mutationFn: () => api<{ serial: string }>('/warehouse/documents/reserve', {
      method: 'POST',
      body: {
        type: 'PATCH', ref: patch,
        units: template.data?.total ?? 0,
        items: String(template.data?.items ?? 0),
      },
    }),
    onSuccess: (res) => { setSerial(res.serial); setCopy(1); },
  });

  const recordPrint = useMutation({
    mutationFn: () => api<{ copy: number }>('/warehouse/documents/printed', {
      method: 'POST', body: { serial },
    }),
    onSuccess: (res) => { setCopy(res.copy); window.print(); },
  });

  const t = template.data;

  return (
    <div className="page">
      <header className="pagehead no-print">
        <div>
          <h1 className="pagehead__title">Templates</h1>
          <p className="pagehead__sub">
            A patch from printed sheet to quality and back.
          </p>
        </div>
      </header>

      <div className="tabs tabs--stretch no-print" role="tablist">
        {TEMPLATE_TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab"
                  aria-selected={tab === key}
                  className={`tabs__tab${tab === key ? ' is-active' : ''}`}
                  onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {/* "Open template" jumps to the sheet itself with the number already
          in the box — the next thing anybody does with a patch, and it was
          two screens and a retyped number away. */}
      {tab === 'log' ? (
        <WarehousePatchLog onOpenTemplate={(n) => {
          setTyped(n); setPatch(n); setSerial(null); setTab('tpl');
        }} />
      ) : null}
      {/* One page, two questions: what quality still holds, and what it has
          handed back for the warehouse to count. The tab chooses which. */}
      {tab === 'qc' ? <WarehouseQc side="holding" /> : null}
      {tab === 'qcin' ? <WarehouseQc side="returning" /> : null}

      {tab !== 'tpl' ? null : (
      <>
      <div className="no-print">
        <Card title="Which patch">
          <div className="formrow">
            <label className="field">
              <span className="field__label">Patch number</span>
              <input className="input mono" value={typed} maxLength={20}
                     autoFocus
                     onChange={(e) => setTyped(e.target.value)}
                     onKeyDown={(e) => {
                       if (e.key === 'Enter' && typed.trim()) {
                         setPatch(typed.trim()); setSerial(null);
                       }
                     }} />
            </label>
            <div className="modal__foot" style={{ alignSelf: 'end' }}>
              <button type="button" className="notebtn" disabled={!typed.trim()}
                      onClick={() => { setPatch(typed.trim()); setSerial(null); }}>
                Find it
              </button>
            </div>
          </div>

          {t?.found ? (
            <div className="modal__foot">
              {!serial ? (
                <button type="button" className="notebtn"
                        disabled={reserve.isPending}
                        onClick={() => reserve.mutate()}>
                  {reserve.isPending ? 'Taking a serial…' : 'Take a serial and print'}
                </button>
              ) : (
                <button type="button" className="notebtn"
                        disabled={recordPrint.isPending}
                        onClick={() => recordPrint.mutate()}>
                  {recordPrint.isPending ? 'Recording…' : `Print ${serial}`}
                </button>
              )}
            </div>
          ) : null}

          {reserve.isError ? (
            <p className="notice notice--warn">{(reserve.error as Error)?.message}</p>
          ) : null}
        </Card>
      </div>

      {!patch ? null
       : template.isLoading ? <LoadingState label="Reading the patch" />
       : template.isError ? (
         <ErrorState error={template.error} onRetry={() => void template.refetch()} />
       ) : !t?.found ? (
         <EmptyState title={`Nothing on patch ${patch}`}
                     hint="No orders are booked against it." />
       ) : (
         <article className="otpl">
           <header className="otpl__head">
             <p className="otpl__brand">WOROOD</p>
             <p className="otpl__sub">WOROOD DESIGNS</p>
             <div className="otpl__serial">
               <span>SERIAL #</span>
               <strong>{serial ?? '—'}</strong>
             </div>
           </header>

           <div className="otpl__facts">
             {([
               ['PATCH #', t.patch],
               ['DATE', sheetDate(t.date)],
               ['ORDERS', String(t.orders)],
               ['ITEMS', String(t.items)],
               ['TOTAL QUANTITY', String(t.total)],
               ['ENTERED BY', t.enteredBy || '—'],
             ] as const).map(([label, value]) => (
               <div className="otpl__fact" key={label}>
                 <span>{label}</span>
                 <strong>{value}</strong>
               </div>
             ))}
           </div>

           {/* The group totals, read before the detail: whoever picks walks
               the shelves by collection. */}
           <div className="otpl__groups">
             {t.groups.map((g) => (
               <div className="otpl__fact otpl__fact--wide" key={g.group}>
                 <span>{g.group.toUpperCase()}</span>
                 <strong>{g.total}</strong>
               </div>
             ))}
           </div>

           <table className="otpl__table">
             <thead>
               <tr>
                 <th>ITEM</th>
                 <th className="is-end">ORDER</th>
                 <th className="is-end">QUANTITY</th>
               </tr>
             </thead>
             <tbody>
               {t.groups.map((g) => (
                 <>
                   <tr className="otpl__grouprow" key={g.group}>
                     <td>{g.group}</td>
                     <td />
                     <td className="is-end">{g.total} pcs</td>
                   </tr>
                   {g.lines.map((l, i) => (
                     <tr key={`${g.group}-${i}`}>
                       <td>
                         {/* Ticked off as each is picked. */}
                         <span className="otpl__tick" aria-hidden="true" />
                         {l.item}
                       </td>
                       <td className="is-end mono">{l.order || '—'}</td>
                       <td className="is-end mono">{l.quantity}</td>
                     </tr>
                   ))}
                 </>
               ))}
             </tbody>
           </table>

           <div className="otpl__total">
             <span>TOTAL QUANTITY</span>
             <strong>{t.total}</strong>
           </div>

           <footer className="otpl__sign">
             {/* Three columns, signed in order: quality checks it, senior
                 quality approves it, the warehouse takes it. */}
             <div>
               <span>SENIOR QUALITY</span>
               <small>Printed on {new Date().toLocaleString()}</small>
             </div>
             <div>
               <span>QUALITY</span>
               <small>Copy #{copy}</small>
             </div>
             <div>
               <span>WAREHOUSE</span>
               <small>
                 Patch #{t.patch} · {t.orders} order{t.orders === 1 ? '' : 's'}
                 {' '}· {t.total} pcs
               </small>
             </div>
           </footer>
         </article>
       )}
      </>
      )}
    </div>
  );
}