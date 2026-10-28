/**
 * Finance requests: raising one, following it, and deciding on it.
 *
 * Four screens that share a file because they share a shape. The thing worth
 * knowing about all of them: every button that changes something is drawn from
 * a flag the server sent (`canDecide`, `canEdit`, `canDelete`), not from a
 * guess made here about who the person is. The server decides and the page
 * reflects it, so the two cannot disagree.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FinanceApprovalsResponse, FinanceEdit, FinanceFile, FinanceFileUploadTicket,
  FinancePayment,
  FinanceFormConfig, FinanceOutstanding, FinancePayments, FinanceRequest,
  FinanceRequestDetail, FinanceRequestsResponse, PurchaseOrder,
  ZohoAccountLists, ZohoVendor,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';
import { useAuth } from '../lib/auth';

const isArabic = () => (document.documentElement.lang || 'en').startsWith('ar');

/** Today, as a date input wants it. */
const today = () => new Intl.DateTimeFormat('en-CA').format(new Date());

/** Egyptian pounds, grouped, with the currency the portal works in. */
const money = (n: number) =>
  new Intl.NumberFormat(isArabic() ? 'ar-EG' : 'en-EG',
    { style: 'currency', currency: 'EGP', maximumFractionDigits: 2 }).format(n);

/** The colour of a state. Label text carries the meaning; this is support. */
const tone = (r: FinanceRequest) =>
  r.label === 'Rejected' ? 'danger'
  : r.label === 'Complete' ? 'good'
  : r.label === 'Open' ? 'warn' : 'info';

function StateTag({ r }: { r: FinanceRequest }) {
  return (
    <span className={`idtag idtag--${tone(r)}`}>
      {isArabic() ? r.labelAr : r.label}
    </span>
  );
}

/* ------------------------------------------------------------- my list -- */

export function Finance() {
  const list = useQuery({
    queryKey: qk.financeList('mine'),
    queryFn: () => api<FinanceRequestsResponse>('/finance/requests?mine=true&limit=50'),
  });

  if (list.isLoading) return <LoadingState label="Loading your requests" />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const items = list.data?.requests ?? [];

  return (
    <div className="page">
      {/* pagehead is the portal's own header: title and sub on the left, tools
          on the right, wrapping onto their own line only when there is no room.
          Writing a bespoke one here is what put the button under the heading. */}
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">My Requests</h1>
          <p className="pagehead__sub">
            Money you have asked for, and where each request has got to.
          </p>
        </div>
        <div className="pagehead__tools">
          <Link className="btn btn--primary btn--sm" to="/finance/new">
            <Icon name="plus" size={15} /> <span className="btn__label">New request</span>
          </Link>
        </div>
      </header>

      {!items.length ? (
        <EmptyState icon="list" title="Nothing yet"
                    hint="Requests you raise will appear here with their progress." />
      ) : <RequestTable items={items} />}
    </div>
  );
}

/* ------------------------------------------------------------ all/queue -- */

export function FinanceAll() {
  const [state, setState] = useState('');
  const list = useQuery({
    queryKey: qk.financeList(`all:${state}`),
    queryFn: () => api<FinanceRequestsResponse>(
      `/finance/requests?limit=100${state ? `&state=${state}` : ''}`),
  });

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">All Requests</h1>
          <p className="pagehead__sub">
            Your department's requests — or the whole company's, if you are in Finance.
          </p>
        </div>
        <div className="pagehead__tools">
          <select className="input input--sm" value={state}
                  onChange={(e) => setState(e.target.value)}>
            <option value="">Any state</option>
            <option value="open">Still open</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </header>

      {list.isLoading ? <LoadingState label="Loading" />
       : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} />
       : !list.data?.requests.length
         ? <EmptyState icon="table" title="Nothing matches" hint="Try another state." />
         : <RequestTable items={list.data.requests} showRequester />}
    </div>
  );
}

export function FinanceApprovals() {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');

  const queue = useQuery({
    queryKey: qk.financeApprovals,
    queryFn: () => api<FinanceApprovalsResponse>('/finance/approvals'),
  });

  const decideChange = useMutation({
    mutationFn: (v: { editId: string; decision: 'APPROVED' | 'REJECTED'; reason?: string }) =>
      api(`/finance/edits/${v.editId}/decide`, {
        method: 'POST', body: { decision: v.decision, reason: v.reason },
      }),
    onSuccess: () => {
      setReason('');
      void qc.invalidateQueries({ queryKey: qk.financeApprovals });
      void qc.invalidateQueries({ queryKey: qk.finance });
    },
  });

  if (queue.isLoading) return <LoadingState label="Loading your queue" />;
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;

  const items = queue.data?.requests ?? [];
  /* Changes to approved requests belong here too. They used to live behind a
     separate endpoint nothing read, so the only sign one needed deciding was a
     notification -- and a notification scrolls away. */
  const edits = queue.data?.edits ?? [];

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Approvals</h1>
          <p className="pagehead__sub">
            New requests and changes to approved ones, waiting for your decision.
          </p>
        </div>
      </header>

      {!items.length && !edits.length ? (
        <EmptyState icon="check" title="Nothing waiting"
                    hint="When something needs your approval it will appear here." />
      ) : null}

      {edits.length ? (
        <Card title={`Changes to approved requests (${edits.length})`}>
          {decideChange.isError ? <ErrorState error={decideChange.error} compact /> : null}
          <ul className="changelist">
            {edits.map((c) => (
              <li key={c.id} className="changelist__item changelist__item--manager_pending">
                <div className="changelist__head">
                  <Link to={`/finance/requests/${c.requestId}`}>{c.reference}</Link>
                  <strong>{c.requestedBy.fullName}</strong>
                  <span className="muted">{formatDate(c.createdAt)}</span>
                </div>
                {c.newAmount !== null ? (
                  <p className="changelist__money">
                    {c.amountBefore !== null
                      ? <s className="muted">{money(c.amountBefore)}</s> : null}
                    {' → '}<strong>{money(c.newAmount)}</strong>
                  </p>
                ) : null}
                {c.newDescription ? <p>“{c.newDescription}”</p> : null}
                <p className="muted">{c.reason}</p>

                {c.canDecide ? (
                  <div className="decideblock">
                    <label className="field">
                      <span className="field__label">
                        Reason <span className="field__opt">required to refuse</span>
                      </span>
                      <textarea className="input" rows={2} value={reason} maxLength={1000}
                                onChange={(e) => setReason(e.target.value)} />
                    </label>
                    <div className="formrow--actions decideblock__actions">
                      <button type="button" className="btn btn--danger btn--sm"
                              disabled={!reason.trim() || decideChange.isPending}
                              onClick={() => decideChange.mutate({
                                editId: c.id, decision: 'REJECTED', reason })}>
                        Refuse
                      </button>
                      <button type="button" className="btn btn--primary btn--sm"
                              disabled={decideChange.isPending}
                              onClick={() => decideChange.mutate({
                                editId: c.id, decision: 'APPROVED',
                                reason: reason || undefined })}>
                        Agree
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {items.length ? (
        <Card title={`New requests (${items.length})`}>
          <RequestTable items={items} showRequester />
        </Card>
      ) : null}
    </div>
  );
}

function RequestTable({ items, showRequester }: {
  items: FinanceRequest[]; showRequester?: boolean;
}) {
  return (
    <div className="tablewrap">
      <table className="table">
        <thead>
          <tr>
            <th>Reference</th>
            <th className="col--desc">Description</th>
            {showRequester ? <th>Requested by</th> : null}
            <th>Due</th>
            <th className="num">Amount</th>
            <th>State</th>
            <th>Waiting on</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/finance/requests/${r.id}`}>{r.reference}</Link></td>
              {/* Clipped to one line with the full text on hover: a long
                  description used to push the next column off the row. */}
              <td className="col--desc" title={r.description}>
                <span className="clip">{r.description}</span>
              </td>
              {showRequester ? <td>{r.requester.fullName}</td> : null}
              <td>{formatDate(r.dueDate)}</td>
              {/* Three different things, and they must not look alike: a
                  figure, one nobody has set yet, and one this reader may not
                  see. The server removes the field rather than zeroing it. */}
              <td className="num">
                {r.hidden?.includes('requestedAmount')
                  ? <span className="muted">—</span>
                  : r.requestedAmount === null || r.requestedAmount === undefined
                    ? <span className="muted">to be priced</span>
                    : money(r.requestedAmount)}
              </td>
              <td><StateTag r={r} /></td>
              <td className="muted">{r.waitingOn ? titleOf(r.waitingOn) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const titleOf = (step: string) =>
  step === 'MANAGER' ? 'Department manager'
  : step === 'PURCHASES' ? 'Purchases' : 'Finance';

/* ---------------------------------------------------------- new request -- */

export function FinanceNew() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  /* One request: the person's own department, the bank list, and which fields
     to show. There is no department picker -- a request is always for your own
     department, as it is in the app this replaces. */
  const form = useQuery({
    queryKey: qk.financeForm,
    queryFn: () => api<FinanceFormConfig>('/finance/request-form'),
  });

  const [type, setType] = useState('');
  const [description, setDescription] = useState('');
  const [moreDetails, setMore] = useState('');
  const [dueDate, setDue] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setMethod] = useState('');
  const [accountNumber, setAccount] = useState('');
  const [bankName, setBank] = useState('');
  const [beneficiaryName, setBeneficiary] = useState('');
  const [sendToPurchases, setToPurchases] = useState(false);

  const dept = form.data?.department ?? null;

  /* A `choice` department switches between two shapes as the requester picks,
     so both arrived with the configuration and the swap costs no round trip. */
  const route: 'finance' | 'purchases' =
    dept?.route === 'purchases' ? 'purchases'
    : dept?.route === 'choice' ? (sendToPurchases ? 'purchases' : 'finance')
    : 'finance';
  const fields = form.data?.fields?.[route] ?? null;

  const needsBeneficiary =
    paymentMethod === 'Bank Account Number' || paymentMethod === 'IBAN';
  const needsBank = paymentMethod === 'Bank Account Number';

  const create = useMutation({
    mutationFn: () => api<FinanceRequest>('/finance/requests', {
      method: 'POST',
      body: {
        description,
        moreDetails: moreDetails || undefined,
        dueDate,
        /* Only what this shape of request actually carries. Sending an amount
           on a Purchases request would be a guess somebody then has to undo. */
        ...(fields?.type ? { type } : {}),
        ...(fields?.amount ? { requestedAmount: Number(amount) } : {}),
        ...(fields?.payment ? {
          paymentMethod,
          accountNumber,
          ...(needsBank ? { bankName } : {}),
          ...(needsBeneficiary ? { beneficiaryName } : {}),
        } : {}),
        ...(dept?.route === 'choice' ? { sendToPurchases } : {}),
      },
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.finance });
      navigate(`/finance/requests/${r.id}`);
    },
  });

  if (form.isLoading) return <LoadingState label="Loading" />;
  if (form.isError) return <ErrorState error={form.error} onRetry={() => void form.refetch()} />;

  /* Somebody with no department, or in one that does not raise requests, is
     told plainly rather than shown an empty picker. */
  if (!dept) {
    return (
      <div className="page page--narrow">
        <header className="pagehead">
          <div><h1 className="pagehead__title">New Request</h1></div>
        </header>
        <EmptyState
          icon="alert"
          title="You cannot raise a request yet"
          hint="Your department does not raise finance requests, or you have not been added to one. An administrator can sort this out."
        />
      </div>
    );
  }

  const label = isArabic() ? (dept.nameAr ?? dept.name) : dept.name;
  const ready = description.trim() && dueDate
    && (!fields?.moreDetailsRequired || moreDetails.trim())
    && (!fields?.type || type)
    && (!fields?.amount || Number(amount) > 0)
    && (!fields?.payment || (paymentMethod && accountNumber.trim().length >= 4
        && (!needsBeneficiary || beneficiaryName.trim().length >= 2)
        && (!needsBank || bankName)));

  return (
    <div className="page page--narrow">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">New Request</h1>
          <p className="pagehead__sub">
            For <strong>{label}</strong>.{' '}
            {dept.route === 'purchases'
              ? 'Purchases will price it and arrange the payment.'
              : 'It goes to your department manager first, then to Finance.'}
          </p>
        </div>
      </header>

      <Card title="What do you need?">
        <div className="stackform">
          {/* The choice comes first, because it changes the rest of the form. */}
          {dept.route === 'choice' ? (
            <label className="field field--check">
              <input type="checkbox" checked={sendToPurchases}
                     onChange={(e) => setToPurchases(e.target.checked)} />
              <span>
                Purchases should buy this
                <span className="field__opt"> — they will decide the cost and the payment</span>
              </span>
            </label>
          ) : null}

          {fields?.type ? (
            <label className="field">
              <span className="field__label">Type</span>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">Choose…</option>
                {dept.requestTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          ) : null}

          <label className="field">
            <span className="field__label">Description</span>
            <input className="input" value={description} maxLength={300}
                   placeholder={(isArabic() ? dept.placeholderAr : dept.placeholder) ?? ''}
                   onChange={(e) => setDescription(e.target.value)} />
          </label>

          <label className="field">
            <span className="field__label">
              More details
              {!fields?.moreDetailsRequired ? <span className="field__opt"> optional</span> : null}
            </span>
            <textarea className="input" rows={3} value={moreDetails} maxLength={1000}
                      onChange={(e) => setMore(e.target.value)} />
          </label>

          <div className="formrow">
            <label className="field">
              <span className="field__label">Needed by</span>
              {/* A due date in the past is always a mistake: the request has
                  not been approved yet, let alone paid. */}
              <input className="input" type="date" value={dueDate} min={today()}
                     onChange={(e) => setDue(e.target.value)} />
            </label>

            {fields?.amount ? (
              <label className="field">
                <span className="field__label">Amount (EGP)</span>
                <input className="input" type="number" min="0.01" step="0.01" value={amount}
                       onChange={(e) => setAmount(e.target.value)} />
              </label>
            ) : null}
          </div>

          {fields?.payment ? (
            <>
              <div className="formrow">
                <label className="field">
                  <span className="field__label">How should the money be sent?</span>
                  <select className="input" value={paymentMethod}
                          onChange={(e) => { setMethod(e.target.value); setBank(''); }}>
                    <option value="">Choose…</option>
                    <option>Wallet Number</option>
                    <option>InstaPay Number</option>
                    <option>Bank Account Number</option>
                    <option>IBAN</option>
                  </select>
                </label>

                {needsBank ? (
                  <label className="field">
                    <span className="field__label">Bank</span>
                    <select className="input" value={bankName}
                            onChange={(e) => setBank(e.target.value)}>
                      <option value="">Choose…</option>
                      {form.data?.banks.map((b) => (
                        <option key={b.name} value={b.name}>
                          {isArabic() ? (b.nameAr ?? b.name) : b.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>

              <div className="formrow">
                <label className="field">
                  <span className="field__label">
                    {paymentMethod === 'IBAN' ? 'IBAN'
                     : paymentMethod === 'Bank Account Number' ? 'Account number'
                     : paymentMethod ? paymentMethod : 'Number'}
                  </span>
                  <input className="input mono" value={accountNumber} maxLength={200}
                         onChange={(e) => setAccount(e.target.value)} />
                </label>

                {/* A bank transfer has to say who is being paid: the account
                    number alone does not tell Finance whose it is. */}
                {needsBeneficiary ? (
                  <label className="field">
                    <span className="field__label">Beneficiary (the account holder)</span>
                    <input className="input" value={beneficiaryName} maxLength={100}
                           onChange={(e) => setBeneficiary(e.target.value)} />
                  </label>
                ) : null}
              </div>
            </>
          ) : (
            <p className="field__hint">
              Purchases will decide the cost and how it is paid, so there is nothing
              to fill in here.
            </p>
          )}

          {create.isError ? <ErrorState error={create.error} compact /> : null}

          <div className="formrow--actions">
            <Link className="btn btn--ghost" to="/finance">Cancel</Link>
            <button type="button" className="btn btn--primary"
                    disabled={!ready || create.isPending}
                    onClick={() => create.mutate()}>
              Send for approval
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- detail -- */

export function FinanceRequestPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const { principal, can: may } = useAuth();
  const canRecordPayments = may('finance.payment.record');
  const canDecidePurchases = may('finance.purchases.decide') || may('finance.request.manage');
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [pricing, setPricing] = useState<Record<string, string>>({
    type: '', requestedAmount: '', vendorName: '',
    paymentMethod: '', accountNumber: '', bankName: '', beneficiaryName: '',
  });

  /* The bank list, for the pricing fields. Only fetched where it is needed. */
  const banks = useQuery({
    queryKey: qk.financeForm,
    queryFn: () => api<FinanceFormConfig>('/finance/request-form'),
    select: (d) => d.banks,
  });

  const payments = useQuery({
    queryKey: qk.financePayments(id),
    queryFn: () => api<FinancePayments>(`/finance/requests/${id}/payments`),
    enabled: !!id,
  });

  const files = useQuery({
    queryKey: qk.financeFiles(id),
    queryFn: () => api<FinanceFile[]>(`/finance/requests/${id}/files`),
    enabled: !!id,
  });

  const item = useQuery({
    queryKey: qk.financeItem(id),
    queryFn: () => api<FinanceRequestDetail>(`/finance/requests/${id}`),
    enabled: !!id,
  });

  /* Changes asked for on this request. Fetched alongside rather than folded
     into the request, because a request usually has none and this keeps the
     main query small. */
  const changes = useQuery({
    queryKey: qk.financeEdits(id),
    queryFn: () => api<FinanceEdit[]>(`/finance/requests/${id}/edits`),
    enabled: !!id,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.financeItem(id) });
    void qc.invalidateQueries({ queryKey: qk.financeEdits(id) });
    void qc.invalidateQueries({ queryKey: qk.finance });
    void qc.invalidateQueries({ queryKey: qk.financeApprovals });
  };

  const decide = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED') =>
      api(`/finance/requests/${id}/decide`, {
        method: 'POST',
        body: {
          decision, reason: reason.trim() || undefined,
          ...(r?.needsPricing && decision === 'APPROVED' ? { pricing } : {}),
        },
      }),
    onSuccess: () => { setReason(''); refresh(); },
  });

  /* Two different things that both change a request, kept apart because they
     are: one is the author correcting something nobody has agreed to yet, the
     other is asking several people to agree to something different. */
  const editInPlace = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/finance/requests/${id}`, { method: 'PATCH', body }),
    onSuccess: () => { setEditing(false); refresh(); },
  });

  const askForChange = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/finance/requests/${id}/edits`, { method: 'POST', body }),
    onSuccess: () => { setAsking(false); refresh(); },
  });

  const decideChange = useMutation({
    mutationFn: (v: { editId: string; decision: 'APPROVED' | 'REJECTED'; reason?: string }) =>
      api(`/finance/edits/${v.editId}/decide`, {
        method: 'POST', body: { decision: v.decision, reason: v.reason },
      }),
    onSuccess: refresh,
  });

  const withdrawChange = useMutation({
    mutationFn: (editId: string) =>
      api(`/finance/edits/${editId}/withdraw`, { method: 'POST' }),
    onSuccess: refresh,
  });

  const addNote = useMutation({
    mutationFn: (body: string) => api(`/finance/requests/${id}/notes`, {
      method: 'POST', body: { body },
    }),
    onSuccess: () => { setNote(''); refresh(); },
  });

  if (item.isLoading) return <LoadingState label="Loading" />;
  if (item.isError || !item.data) {
    return <ErrorState error={item.error} onRetry={() => void item.refetch()} />;
  }

  const r = item.data;

  return (
    <div className="page page--narrow">
      <Link to="/finance" className="backlink">
        <Icon name="left" size={13} /> My requests
      </Link>

      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">{r.reference}</h1>
          <p className="pagehead__sub">
            {r.requester.fullName} · {isArabic() ? (r.departmentNameAr ?? r.departmentName)
                                                 : r.departmentName}
            {r.type ? ` · ${r.type}` : ''}
          </p>
        </div>
        <div className="pagehead__tools">
          <StateTag r={r} />
          {/* While it is Open the author edits it outright; once approved the
              same button asks everybody who approved it to agree again. */}
          {r.canEdit ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
              <Icon name="sparkles" size={14} /> Edit
            </button>
          ) : null}
          {!r.canEdit && r.approvalState === 'APPROVED'
            && r.requester.id === principal?.id
            && !changes.data?.some((c) => c.waitingOn) ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsking(true)}>
              <Icon name="sparkles" size={14} /> Ask for a change
            </button>
          ) : null}
        </div>
      </header>

      {editing ? (
        <EditInPlace r={r} busy={editInPlace.isPending} error={editInPlace.error}
                     onCancel={() => setEditing(false)}
                     onSave={(body: Record<string, unknown>) => editInPlace.mutate(body)} />
      ) : null}

      {asking ? (
        <AskForChange r={r} busy={askForChange.isPending} error={askForChange.error}
                      onCancel={() => setAsking(false)}
                      onSend={(body: Record<string, unknown>) => askForChange.mutate(body)} />
      ) : null}

      {changes.data?.length ? (
        <ChangeList
          changes={changes.data}
          onDecide={(editId, decision, reason) =>
            decideChange.mutate({ editId, decision, reason })}
          onWithdraw={(editId) => withdrawChange.mutate(editId)}
          busy={decideChange.isPending || withdrawChange.isPending}
          error={decideChange.error}
        />
      ) : null}

      <Card title="The request">
        <dl className="kv">
          <dt>Description</dt><dd>{r.description}</dd>
          {r.moreDetails ? <><dt>More details</dt><dd>{r.moreDetails}</dd></> : null}
          <dt>Needed by</dt><dd>{formatDate(r.dueDate)}</dd>
          {!r.hidden?.includes('requestedAmount') ? (
            <>
              <dt>Amount</dt>
              <dd>{r.requestedAmount === null || r.requestedAmount === undefined
                ? <span className="muted">Purchases will price this</span>
                : <strong>{money(r.requestedAmount)}</strong>}</dd>
            </>
          ) : null}
          {r.paymentMethod ? <><dt>Payment</dt>
            <dd>{r.paymentMethod}{r.paymentDetails ? ` — ${r.paymentDetails}` : ''}</dd></> : null}
          {r.vendorName ? <><dt>Supplier</dt><dd>{r.vendorName}</dd></> : null}
          <dt>Route</dt>
          <dd>{r.route === 'purchases' ? 'Bought by Purchases' : 'Paid by Finance'}</dd>
          {r.waitingOn ? <><dt>Waiting on</dt><dd>{titleOf(r.waitingOn)}</dd></> : null}
          {r.rejectionReason
            ? <><dt>Rejected because</dt><dd>{r.rejectionReason}</dd></> : null}
        </dl>
      </Card>

      {/* Drawn from the server's own answer, so the button appears exactly when
          pressing it would work. */}
      {r.canDecide ? (
        <Card title={`Your decision — ${titleOf(r.waitingOn!)}`}>
          <div className="decideblock">
          {/* Purchases does not wave a request through: it says what the thing
              costs and how it is paid, because the request arrived carrying
              none of that and Finance cannot pay an approval with no figure. */}
          {r.needsPricing ? (
            <PricingFields value={pricing} onChange={setPricing} banks={banks.data ?? []} />
          ) : null}
          <label className="field">
            <span className="field__label">Reason <span className="field__opt">required to reject</span></span>
            <textarea className="input" rows={2} value={reason} maxLength={1000}
                      onChange={(e) => setReason(e.target.value)} />
          </label>
          {decide.isError ? <ErrorState error={decide.error} compact /> : null}
          {/* Reject sits left of Approve and carries the danger colour, so the
              destructive one is never the button under the thumb. The spacing
              comes from decideblock below: buttons pressed against the text
              box get clicked by accident. */}
          <div className="formrow--actions decideblock__actions">
            <button type="button" className="btn btn--danger"
                    disabled={!reason.trim() || decide.isPending}
                    onClick={() => decide.mutate('REJECTED')}>
              Reject
            </button>
            <button type="button" className="btn btn--primary" disabled={decide.isPending}
                    onClick={() => decide.mutate('APPROVED')}>
              Approve
            </button>
          </div>
          </div>
        </Card>
      ) : null}

      <Card title="Progress">
        {!r.approvals.length ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ol className="trail">
            {r.approvals.map((a, i) => (
              <li key={i} className={`trail__item trail__item--${a.decision.toLowerCase()}`}>
                <div className="trail__head">
                  <strong>{titleOf(a.step)}</strong>
                  <span className={`idtag idtag--${a.decision === 'APPROVED' ? 'good' : 'danger'}`}>
                    {a.decision === 'APPROVED' ? 'Approved' : 'Rejected'}
                  </span>
                  <span className="muted">{a.decidedBy} · {formatDate(a.at)}</span>
                </div>
                {/* The amount as it stood when this decision was taken, so an
                    approval cannot be read as covering a different number. */}
                {a.amountAtDecision !== null ? (
                  <span className="muted trail__amount">at {money(a.amountAtDecision)}</span>
                ) : null}
                {a.reason ? <p>{a.reason}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* Only where there is something to show: a request nobody has paid and
          that this reader may not see money on has no payments card at all. */}
      {!payments.data?.hidden
        && (payments.data?.payments.length || r.canDecide || r.approvalState === 'APPROVED') ? (
        <PaymentsCard
          requestId={id}
          requestType={r.type}
          data={payments.data}
          canRecord={canRecordPayments && r.approvalState === 'APPROVED'}
          onChanged={() => {
            void qc.invalidateQueries({ queryKey: qk.financePayments(id) });
            void qc.invalidateQueries({ queryKey: qk.financeItem(id) });
            void qc.invalidateQueries({ queryKey: qk.financeOutstanding });
          }}
        />
      ) : null}

      {/* Only for a vendor payment: petty cash has nobody to order from, and
          an ordinary expense is paid rather than ordered. */}
      {r.type === 'Vendors Payments' && r.approvalState === 'APPROVED' ? (
        <PurchaseOrderCard
          requestId={id}
          canDraft={canDecidePurchases}
          onChanged={() => {
            void qc.invalidateQueries({ queryKey: qk.financePurchaseOrder(id) });
            void qc.invalidateQueries({ queryKey: qk.financeItem(id) });
          }}
        />
      ) : null}

      <FilesCard
        requestId={id}
        files={files.data ?? []}
        onChanged={() => void qc.invalidateQueries({ queryKey: qk.financeFiles(id) })}
      />

      <Card title="Notes">
        <div className="noterow">
          <textarea className="input" rows={2} value={note} maxLength={2000}
                    placeholder="Add a note" onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn btn--sm btn--primary"
                  disabled={!note.trim() || addNote.isPending}
                  onClick={() => addNote.mutate(note)}>
            Add
          </button>
        </div>
        <ul className="newscomments__list">
          {r.notes.map((n) => (
            <li key={n.id}>
              <div className="newscomments__head">
                <strong>{n.author}</strong>
                <span className="muted">{formatDate(n.at)}</span>
                {n.internal ? <span className="idtag idtag--muted">Internal</span> : null}
              </div>
              <p>{n.body}</p>
            </li>
          ))}
          {!r.notes.length ? <li className="muted">Nothing yet.</li> : null}
        </ul>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------- changing a request -- */

/**
 * Editing in place, while the request is still Open.
 *
 * Nobody has agreed to anything yet, so this writes straight to the request.
 * The fields offered are the ones the request actually carries: a request bound
 * for Purchases has no amount to change.
 */
function EditInPlace({ r, busy, error, onCancel, onSave }: {
  r: FinanceRequestDetail;
  busy: boolean; error: unknown;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [description, setDescription] = useState(r.description);
  const [moreDetails, setMore] = useState(r.moreDetails ?? '');
  const [dueDate, setDue] = useState(r.dueDate);
  const [amount, setAmount] = useState(
    r.requestedAmount === null ? '' : String(r.requestedAmount));

  return (
    <Card title="Edit this request">
      <div className="stackform">
        <p className="field__hint">
          Nobody has approved it yet, so you can change it outright.
        </p>

        <label className="field">
          <span className="field__label">Description</span>
          <input className="input" value={description} maxLength={300}
                 onChange={(e) => setDescription(e.target.value)} />
        </label>

        <label className="field">
          <span className="field__label">More details</span>
          <textarea className="input" rows={3} value={moreDetails} maxLength={1000}
                    onChange={(e) => setMore(e.target.value)} />
        </label>

        <div className="formrow">
          <label className="field">
            <span className="field__label">Needed by</span>
            <input className="input" type="date" value={dueDate} min={today()}
                   onChange={(e) => setDue(e.target.value)} />
          </label>
          {r.requestedAmount !== null ? (
            <label className="field">
              <span className="field__label">Amount (EGP)</span>
              <input className="input" type="number" min="0.01" step="0.01" value={amount}
                     onChange={(e) => setAmount(e.target.value)} />
            </label>
          ) : null}
        </div>

        {error ? <ErrorState error={error} compact /> : null}

        <div className="formrow--actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn--primary" disabled={busy}
                  onClick={() => onSave({
                    description, moreDetails: moreDetails || undefined, dueDate,
                    ...(r.requestedAmount !== null
                      ? { requestedAmount: Number(amount) } : {}),
                  })}>
            Save
          </button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Asking for a change to a request that has already been approved.
 *
 * This changes nothing by itself. It goes back to the department manager and
 * then to Finance, and only when both agree does the request move -- because
 * the figure they approved is the one they agreed to, and a different one is a
 * different decision.
 */
function AskForChange({ r, busy, error, onCancel, onSend }: {
  r: FinanceRequestDetail;
  busy: boolean; error: unknown;
  onCancel: () => void;
  onSend: (body: Record<string, unknown>) => void;
}) {
  const [amount, setAmount] = useState(
    r.requestedAmount === null ? '' : String(r.requestedAmount));
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');

  const amountChanged = amount !== ''
    && Number(amount) !== (r.requestedAmount ?? NaN);
  const ready = reason.trim() && (amountChanged || description.trim());

  return (
    <Card title="Ask for a change">
      <div className="stackform">
        <p className="field__hint">
          This has been approved, so a change needs agreeing again — your
          manager first, then Finance. Nothing moves until both say yes.
        </p>

        <div className="formrow">
          {r.requestedAmount !== null ? (
            <label className="field">
              <span className="field__label">
                New amount (EGP)
                <span className="field__opt"> now {money(r.requestedAmount)}</span>
              </span>
              <input className="input" type="number" min="0.01" step="0.01" value={amount}
                     onChange={(e) => setAmount(e.target.value)} />
            </label>
          ) : null}
          <label className="field">
            <span className="field__label">
              New description <span className="field__opt">leave empty to keep it</span>
            </span>
            <input className="input" value={description} maxLength={300}
                   onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span className="field__label">Why is the change needed?</span>
          <textarea className="input" rows={2} value={reason} maxLength={1000}
                    placeholder="The studio raised its day rate"
                    onChange={(e) => setReason(e.target.value)} />
        </label>

        {error ? <ErrorState error={error} compact /> : null}

        <div className="formrow--actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn--primary" disabled={!ready || busy}
                  onClick={() => onSend({
                    ...(amountChanged ? { newAmount: Number(amount) } : {}),
                    ...(description.trim() ? { newDescription: description } : {}),
                    reason,
                  })}>
            Send for approval
          </button>
        </div>
      </div>
    </Card>
  );
}

/** Changes asked for on this request, and the decision on each. */
function ChangeList({ changes, onDecide, onWithdraw, busy, error }: {
  changes: FinanceEdit[];
  onDecide: (editId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) => void;
  onWithdraw: (editId: string) => void;
  busy: boolean; error: unknown;
}) {
  const [reason, setReason] = useState('');

  return (
    <Card title="Requested changes">
      {error ? <ErrorState error={error} compact /> : null}
      <ul className="changelist">
        {changes.map((c) => (
          <li key={c.id} className={`changelist__item changelist__item--${c.status.toLowerCase()}`}>
            <div className="changelist__head">
              <strong>{c.requestedBy.fullName}</strong>
              <span className={`idtag idtag--${
                c.status === 'APPLIED' ? 'good'
                : c.status === 'REJECTED' ? 'danger'
                : c.status === 'WITHDRAWN' ? 'muted' : 'warn'}`}>
                {c.status === 'MANAGER_PENDING' ? 'With the manager'
                 : c.status === 'FINANCE_PENDING' ? 'With Finance'
                 : c.status === 'APPLIED' ? 'Applied'
                 : c.status === 'REJECTED' ? 'Refused' : 'Withdrawn'}
              </span>
              <span className="muted">{formatDate(c.createdAt)}</span>
            </div>

            {c.newAmount !== null ? (
              <p className="changelist__money">
                {c.amountBefore !== null ? <s className="muted">{money(c.amountBefore)}</s> : null}
                {' → '}<strong>{money(c.newAmount)}</strong>
              </p>
            ) : null}
            {c.newDescription ? <p>“{c.newDescription}”</p> : null}
            <p className="muted">{c.reason}</p>
            {c.decisionReason ? <p className="muted">Decision: {c.decisionReason}</p> : null}

            {c.canDecide ? (
              <div className="decideblock">
                <label className="field">
                  <span className="field__label">
                    Reason <span className="field__opt">required to refuse</span>
                  </span>
                  <textarea className="input" rows={2} value={reason} maxLength={1000}
                            onChange={(e) => setReason(e.target.value)} />
                </label>
                <div className="formrow--actions decideblock__actions">
                  <button type="button" className="btn btn--danger btn--sm"
                          disabled={!reason.trim() || busy}
                          onClick={() => onDecide(c.id, 'REJECTED', reason)}>
                    Refuse
                  </button>
                  <button type="button" className="btn btn--primary btn--sm" disabled={busy}
                          onClick={() => onDecide(c.id, 'APPROVED', reason || undefined)}>
                    Agree
                  </button>
                </div>
              </div>
            ) : null}

            {c.canWithdraw ? (
              <div className="formrow--actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
                        onClick={() => onWithdraw(c.id)}>
                  Take it back
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* --------------------------------------------------- pricing and files -- */

/**
 * What Purchases fills in when it approves.
 *
 * The same questions the request form asks a department that prices its own
 * spending, because it is the same question answered by somebody else. The
 * server validates all of it again: this is the form, not the rule.
 */
function PricingFields({ value, onChange, banks }: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  banks: { name: string; nameAr: string | null }[];
}) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const needsBeneficiary =
    value.paymentMethod === 'Bank Account Number' || value.paymentMethod === 'IBAN';
  const needsBank = value.paymentMethod === 'Bank Account Number';

  return (
    <div className="pricingblock">
      <p className="field__hint">
        This request arrived without a cost. Say what it comes to and how it
        should be paid — Finance cannot pay an approval with no figure.
      </p>

      <div className="formrow">
        <label className="field">
          <span className="field__label">Kind of spending</span>
          <select className="input" value={value.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">Choose…</option>
            <option>Petty Cash</option>
            <option>Vendors Payments</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Amount (EGP)</span>
          <input className="input" type="number" min="0.01" step="0.01"
                 value={value.requestedAmount}
                 onChange={(e) => set('requestedAmount', e.target.value)} />
        </label>
      </div>

      <div className="formrow">
        <label className="field">
          <span className="field__label">
            Supplier <span className="field__opt">optional</span>
          </span>
          <input className="input" value={value.vendorName} maxLength={200}
                 onChange={(e) => set('vendorName', e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">How should the money be sent?</span>
          <select className="input" value={value.paymentMethod}
                  onChange={(e) => onChange({ ...value, paymentMethod: e.target.value, bankName: '' })}>
            <option value="">Choose…</option>
            <option>Wallet Number</option>
            <option>InstaPay Number</option>
            <option>Bank Account Number</option>
            <option>IBAN</option>
          </select>
        </label>
      </div>

      <div className="formrow">
        {needsBank ? (
          <label className="field">
            <span className="field__label">Bank</span>
            <select className="input" value={value.bankName}
                    onChange={(e) => set('bankName', e.target.value)}>
              <option value="">Choose…</option>
              {banks.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span className="field__label">
            {value.paymentMethod === 'IBAN' ? 'IBAN'
             : value.paymentMethod === 'Bank Account Number' ? 'Account number'
             : value.paymentMethod || 'Number'}
          </span>
          <input className="input mono" value={value.accountNumber} maxLength={200}
                 onChange={(e) => set('accountNumber', e.target.value)} />
        </label>
        {needsBeneficiary ? (
          <label className="field">
            <span className="field__label">Beneficiary (the account holder)</span>
            <input className="input" value={value.beneficiaryName} maxLength={100}
                   onChange={(e) => set('beneficiaryName', e.target.value)} />
          </label>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Files on a request: quotations, invoices, photographs.
 *
 * Three steps per file — ask for a URL, put the bytes straight into S3, tell
 * the API to look at what arrived. The bytes never pass through the API, and
 * every download link here was issued moments ago after a check of who is
 * asking: unlike the shared Drive folder this replaces, a link is no use to
 * anybody it was not issued to.
 */
function FilesCard({ requestId, files, onChanged }: {
  requestId: string;
  files: FinanceFile[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(picked)) {
        const ticket = await api<FinanceFileUploadTicket>(
          `/finance/requests/${requestId}/files`, {
            method: 'POST',
            body: { name: file.name, type: file.type, size: file.size },
          });
        const put = await fetch(ticket.uploadUrl, {
          method: 'PUT', headers: ticket.headers, body: file,
        });
        if (!put.ok) throw new Error(`${file.name} could not be uploaded.`);
        await api(`/finance/files/${ticket.fileId}/confirm`, { method: 'POST' });
      }
      onChanged();
    } catch (e: any) {
      setError(e?.message ?? 'The file could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (fileId: string) => {
    setBusy(true);
    try {
      await api(`/finance/files/${fileId}`, { method: 'DELETE' });
      onChanged();
    } catch (e: any) {
      setError(e?.message ?? 'The file could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`Files${files.length ? ` (${files.length})` : ''}`}>
      {files.length ? (
        <ul className="filelist">
          {files.map((f) => (
            <li key={f.id} className="filelist__item">
              {f.thumbUrl ? (
                <a href={f.url} target="_blank" rel="noreferrer" className="filelist__thumb">
                  <img src={f.thumbUrl} alt="" loading="lazy" />
                </a>
              ) : (
                <span className="filelist__thumb filelist__thumb--doc">PDF</span>
              )}
              <div className="filelist__meta">
                <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a>
                <span className="muted">
                  {f.kind === 'RECEIPT' ? 'Receipt · ' : ''}
                  {f.bytes ? `${Math.round(f.bytes / 1024)} KB` : ''}
                </span>
              </div>
              {f.canRemove ? (
                <button type="button" className="linkbtn" disabled={busy}
                        onClick={() => void remove(f.id)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing attached.</p>
      )}

      {error ? <p className="state state--error">{error}</p> : null}

      <label className="btn btn--ghost btn--sm filelist__add">
        <Icon name="plus" size={13} /> {busy ? 'Uploading…' : 'Attach a file'}
        <input type="file" hidden multiple disabled={busy}
               accept="image/jpeg,image/png,image/webp,application/pdf"
               onChange={(e) => void add(e.target.files)} />
      </label>
    </Card>
  );
}

/* ------------------------------------------------------------- payments -- */

/**
 * What has been paid, and recording the next one.
 *
 * Every attempt carries a key generated here, so a double click or a retry
 * after a slow network becomes one payment rather than two. The key is made
 * when the form opens and replaced after a success, which is what makes a
 * retry of the *same* attempt collide and a genuinely new payment not.
 */
function PaymentsCard({ requestId, requestType, data, canRecord, onChanged }: {
  requestId: string;
  /** Decides which accounts are asked for: petty cash moves between two
   *  accounts, an ordinary expense needs an expense line. */
  requestType: string | null;
  data: FinancePayments | undefined;
  canRecord: boolean;
  onChanged: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');

  /* Which Zoho accounts the money moves between. Asked here rather than
     configured, because the expense account differs per request -- the chart
     has nearly two hundred lines and picking one is the point. */
  const [payFrom, setPayFrom] = useState('');
  const [expenseAccount, setExpenseAccount] = useState('');
  const [custodyTo, setCustodyTo] = useState('');

  const accounts = useQuery({
    queryKey: qk.financeZohoAccounts,
    queryFn: () => api<ZohoAccountLists>('/finance/zoho/accounts'),
    /* Two hundred odd rows that change when somebody opens a bank account. */
    staleTime: 60 * 60_000,
    enabled: canRecord,
  });

  const isPettyCash = requestType === 'Petty Cash';
  const isVendorPayment = requestType === 'Vendors Payments';
  /* Zoho is connected when the cache has something in it. Without it a payment
     can still be recorded -- it simply will not be posted, and the queue says
     so -- so the fields are hidden rather than the form being blocked. */
  const zohoReady = (accounts.data?.payFrom.length ?? 0) > 0;
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = data?.remaining ?? null;

  const record = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/finance/requests/${requestId}/payments`, {
        method: 'POST',
        body: {
          amount: Number(amount),
          reference: reference || undefined,
          paidAt: paidAt ? new Date(paidAt).toISOString() : undefined,
          idempotencyKey: attemptKey,
          /* Only what this kind of payment actually needs. A vendor payment
             has no expense line; petty cash has a destination instead. */
          ...(zohoReady ? {
            zohoPaidThroughAccountId: payFrom || undefined,
            ...(isPettyCash ? { zohoToAccountId: custodyTo || undefined } : {}),
            ...(!isPettyCash && !isVendorPayment
              ? { zohoExpenseAccountId: expenseAccount || undefined } : {}),
          } : {}),
        },
      });
      setAmount(''); setReference(''); setPaidAt('');
      /* A fresh key: the next payment is a different payment. */
      setAttemptKey(crypto.randomUUID());
      onChanged();
    } catch (e: any) {
      setError(e?.message ?? 'The payment could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  /* A browser prompt is not a place to explain why money is being taken back
     off the record: it cannot be styled, cannot be read on a phone, and is
     dismissed by accident. The reason is kept on the request's notes as well,
     where somebody reading the request will actually come across it. */
  const [reversing, setReversing] = useState<string | null>(null);

  const reverse = async (paymentId: string, why: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/finance/payments/${paymentId}/reverse`, {
        method: 'POST', body: { reason: why },
      });
      setReversing(null);
      onChanged();
    } catch (e: any) {
      setError(e?.message ?? 'The payment could not be reversed.');
    } finally {
      setBusy(false);
    }
  };

  const beingReversed = data?.payments.find((x) => x.id === reversing) ?? null;

  return (
    <Card title="Payments">
      {beingReversed ? (
        <ReverseDialog
          payment={beingReversed}
          busy={busy}
          onCancel={() => setReversing(null)}
          onConfirm={(why) => void reverse(beingReversed.id, why)}
        />
      ) : null}

      {data && data.paid !== null ? (
        <dl className="kv">
          <dt>Paid</dt><dd><strong>{money(data.paid)}</strong></dd>
          {remaining !== null ? (
            <>
              <dt>Still owing</dt>
              <dd>{remaining <= 0
                ? <span className="idtag idtag--good">Nothing</span>
                : <strong>{money(remaining)}</strong>}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {data?.payments.length ? (
        <ul className="paylist">
          {data.payments.map((pm) => (
            <li key={pm.id} className={pm.isReversal ? 'paylist__item is-reversal' : 'paylist__item'}>
              <span className="paylist__amount">
                {pm.amount < 0 ? `− ${money(-pm.amount)}` : money(pm.amount)}
              </span>
              <span className="paylist__meta">
                {formatDate(pm.paidAt)}
                {pm.recordedBy ? ` · ${pm.recordedBy}` : ''}
                {pm.reference ? ` · ${pm.reference}` : ''}
                {pm.isReversal ? ' · reversed' : ''}
              </span>
              {pm.canReverse ? (
                <button type="button" className="linkbtn" disabled={busy}
                        onClick={() => setReversing(pm.id)}>
                  Reverse
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="muted">Nothing paid yet.</p>}

      {canRecord && (remaining === null || remaining > 0) ? (
        <div className="decideblock">
          <div className="formrow">
            <label className="field">
              <span className="field__label">
                Amount (EGP)
                {remaining !== null
                  ? <span className="field__opt"> {money(remaining)} owing</span> : null}
              </span>
              <input className="input" type="number" min="0.01" step="0.01" value={amount}
                     onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">
                Paid on <span className="field__opt">today if left empty</span>
              </span>
              <input className="input" type="date" value={paidAt}
                     onChange={(e) => setPaidAt(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span className="field__label">
              Reference <span className="field__opt">transfer or cheque number</span>
            </span>
            <input className="input" value={reference} maxLength={200}
                   onChange={(e) => setReference(e.target.value)} />
          </label>

          {zohoReady ? (
            <div className="pricingblock">
              <p className="field__hint">
                Where this lands in Zoho Books. Nothing is posted until the
                payment is saved, and never while the connection is in dry mode.
              </p>
              <div className="formrow">
                <label className="field">
                  <span className="field__label">Paid from</span>
                  <select className="input" value={payFrom}
                          onChange={(e) => setPayFrom(e.target.value)}>
                    <option value="">Choose…</option>
                    {accounts.data!.payFrom.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>

                {isPettyCash ? (
                  <label className="field">
                    <span className="field__label">Into which petty cash</span>
                    <select className="input" value={custodyTo}
                            onChange={(e) => setCustodyTo(e.target.value)}>
                      <option value="">Choose…</option>
                      {accounts.data!.custody.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </label>
                ) : isVendorPayment ? null : (
                  <label className="field">
                    <span className="field__label">Expense account</span>
                    <select className="input" value={expenseAccount}
                            onChange={(e) => setExpenseAccount(e.target.value)}>
                      <option value="">Choose…</option>
                      {accounts.data!.expense.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.parentName ? `${a.parentName} › ` : ''}{a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
          ) : canRecord && accounts.isFetched ? (
            <p className="field__hint">
              Zoho Books is not connected on this server, so this payment will be
              recorded here but not posted to the accounts.
            </p>
          ) : null}

          {error ? <p className="state state--error">{error}</p> : null}

          <div className="formrow--actions decideblock__actions">
            <button type="button" className="btn btn--primary"
                    disabled={busy || !(Number(amount) > 0)
                      /* With Zoho connected, a payment that names no accounts
                         would be recorded and then sit dead in the queue. */
                      || (zohoReady && (!payFrom
                        || (isPettyCash && !custodyTo)
                        || (!isPettyCash && !isVendorPayment && !expenseAccount)))}
                    onClick={() => void record()}>
              {busy ? 'Recording…' : 'Record payment'}
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------- to pay -- */

/** What is approved and still owing, for whoever pays it. */
export function FinanceToPay() {
  const list = useQuery({
    queryKey: qk.financeOutstanding,
    queryFn: () => api<FinanceOutstanding[]>('/finance/payments/outstanding'),
  });

  if (list.isLoading) return <LoadingState label="Loading" />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const items = list.data ?? [];
  const total = items.reduce((n, x) => n + (x.remaining ?? 0), 0);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">To Pay</h1>
          <p className="pagehead__sub">
            Approved requests with money still owing, soonest first.
          </p>
        </div>
        {items.length ? (
          <div className="pagehead__tools">
            <span className="idtag idtag--warn">{money(total)} owing</span>
          </div>
        ) : null}
      </header>

      {!items.length ? (
        <EmptyState icon="check" title="Nothing owing"
                    hint="Every approved request has been paid." />
      ) : (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th className="col--desc">Description</th>
                <th>Department</th>
                <th>Due</th>
                <th>Send to</th>
                <th className="num">Asked</th>
                <th className="num">Paid</th>
                <th className="num">Owing</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/finance/requests/${r.id}`}>{r.reference}</Link></td>
                  <td className="col--desc" title={r.description}>
                    <span className="clip">{r.description}</span>
                  </td>
                  <td>{r.departmentName}</td>
                  <td>{formatDate(r.dueDate)}</td>
                  <td className="col--desc" title={r.paymentDetails ?? ''}>
                    <span className="clip">{r.paymentMethod ?? '—'}</span>
                  </td>
                  <td className="num">
                    {r.requestedAmount === null ? '—' : money(r.requestedAmount)}
                  </td>
                  <td className="num">{money(r.paid)}</td>
                  <td className="num"><strong>
                    {r.remaining === null ? '—' : money(r.remaining)}
                  </strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Taking a payment back off the record.
 *
 * Asked for in a dialogue rather than a browser prompt, because the reason is
 * part of the financial record: it is kept with the reversal and copied onto
 * the request's notes, so somebody reading the request later finds out why the
 * figure moved without having to go looking for an audit log.
 */
function ReverseDialog({ payment, busy, onCancel, onConfirm }: {
  payment: FinancePayment;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Reverse a payment">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onCancel} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">Reverse {money(payment.amount)}?</h2>
        </header>
        <div className="modal__body">
          <p className="muted">
            Recorded {formatDate(payment.paidAt)}
            {payment.recordedBy ? ` by ${payment.recordedBy}` : ''}
            {payment.reference ? ` · ${payment.reference}` : ''}.
          </p>
          <p className="field__hint">
            The payment stays on the record and a matching reversal is added
            beside it. Nothing is deleted.
          </p>
          <label className="field">
            <span className="field__label">Why is it being reversed?</span>
            <textarea className="input" rows={3} value={reason} maxLength={1000} autoFocus
                      placeholder="Paid to the wrong supplier"
                      onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn--danger"
                  disabled={!reason.trim() || busy}
                  onClick={() => onConfirm(reason.trim())}>
            {busy ? 'Reversing…' : 'Reverse the payment'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ purchase orders -- */

/**
 * The draft purchase order a supplier is shown.
 *
 * Created in Zoho as a **draft** and never approved from here: approving one
 * is a decision taken in Zoho, where purchase orders already have an approval
 * chain of their own.
 *
 * The reference is not typed. It continues the supplier's own numbering and is
 * worked out from their bills, because a gap or a repeat in that sequence is
 * the supplier's problem and they will notice it.
 */
function PurchaseOrderCard({ requestId, canDraft, onChanged }: {
  requestId: string;
  canDraft: boolean;
  onChanged: () => void;
}) {
  const [vendorId, setVendorId] = useState('');
  const [lines, setLines] = useState<{ name: string; quantity: string; rate: string }[]>(
    [{ name: '', quantity: '1', rate: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = useQuery({
    queryKey: qk.financePurchaseOrder(requestId),
    queryFn: () => api<PurchaseOrder | null>(`/finance/requests/${requestId}/purchase-order`),
  });

  const vendors = useQuery({
    queryKey: qk.financeVendors,
    queryFn: () => api<ZohoVendor[]>('/finance/vendors'),
    staleTime: 60 * 60_000,
    enabled: canDraft,
  });

  /* Shown while typing so somebody can see what the supplier will receive
     before committing to it. The server recomputes it anyway — this is a
     preview, not the value that is used. */
  const suggested = useQuery({
    queryKey: ['finance', 'po-ref', vendorId],
    queryFn: () => api<{ reference: string }>(
      `/finance/vendors/${vendorId}/next-reference`),
    enabled: canDraft && !!vendorId,
  });

  const total = lines.reduce(
    (n, l) => n + (Number(l.quantity) || 0) * (Number(l.rate) || 0), 0);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const vendor = vendors.data?.find((v) => v.id === vendorId);
      await api(`/finance/requests/${requestId}/purchase-order`, {
        method: 'POST',
        body: {
          vendorId,
          vendorName: vendor?.name ?? '',
          lines: lines
            .filter((l) => l.name.trim())
            .map((l) => ({
              name: l.name,
              quantity: Number(l.quantity) || 1,
              rate: Number(l.rate) || 0,
            })),
        },
      });
      onChanged();
    } catch (e: any) {
      setError(e?.message ?? 'The purchase order could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const po = existing.data;

  /* Already drafted: show it and stop. A second order against one request
     would leave the payment ambiguous about which it is an advance on. */
  if (po?.status === 'DRAFTED') {
    return (
      <Card title="Purchase order">
        <dl className="kv">
          <dt>Supplier</dt><dd>{po.vendorName}</dd>
          <dt>Reference</dt><dd><strong>{po.reference ?? '—'}</strong></dd>
          {po.zohoPoNumber ? <><dt>In Zoho</dt><dd>{po.zohoPoNumber}</dd></> : null}
          <dt>Total</dt><dd>{po.total !== null ? money(po.total) : '—'}</dd>
        </dl>
        <ul className="polines">
          {po.lines.map((l, i) => (
            <li key={i}>
              <span>{l.name}</span>
              <span className="muted">{l.quantity} × {money(l.rate)}</span>
            </li>
          ))}
        </ul>
        <p className="field__hint">
          Created as a draft in Zoho Books. Approving it is done there.
        </p>
      </Card>
    );
  }

  if (!canDraft) {
    return (
      <Card title="Purchase order">
        <p className="muted">Purchases will raise one before this is paid.</p>
      </Card>
    );
  }

  const ready = vendorId && lines.some((l) => l.name.trim());

  return (
    <Card title="Raise a purchase order">
      {po?.status === 'FAILED' && po.error ? (
        <p className="state state--error">
          The last attempt failed: {po.error}
        </p>
      ) : null}

      <div className="stackform">
        <div className="formrow">
          <label className="field">
            <span className="field__label">Supplier</span>
            <select className="input" value={vendorId}
                    onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Choose…</option>
              {vendors.data?.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">
              Reference <span className="field__opt">continues their numbering</span>
            </span>
            <input className="input mono" readOnly
                   value={suggested.data?.reference ?? (vendorId ? 'working it out…' : '')} />
          </label>
        </div>

        <div className="polines polines--edit">
          {lines.map((l, i) => (
            <div key={i} className="polines__row">
              <input className="input" placeholder="What is being bought"
                     value={l.name} maxLength={200}
                     onChange={(e) => setLines((xs) =>
                       xs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input className="input" type="number" min="0.01" step="0.01"
                     placeholder="Qty" value={l.quantity}
                     onChange={(e) => setLines((xs) =>
                       xs.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} />
              <input className="input" type="number" min="0" step="0.01"
                     placeholder="Rate" value={l.rate}
                     onChange={(e) => setLines((xs) =>
                       xs.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} />
              <button type="button" className="linkbtn"
                      disabled={lines.length === 1}
                      onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="formrow--actions">
          <button type="button" className="btn btn--ghost btn--sm"
                  disabled={lines.length >= 40}
                  onClick={() => setLines((xs) => [...xs, { name: '', quantity: '1', rate: '' }])}>
            <Icon name="plus" size={13} /> Add a line
          </button>
          <span className="polines__total">Total {money(total)}</span>
        </div>

        {error ? <p className="state state--error">{error}</p> : null}

        <div className="formrow--actions">
          <button type="button" className="btn btn--primary"
                  disabled={!ready || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create the draft in Zoho'}
          </button>
        </div>
      </div>
    </Card>
  );
}