/**
 * A card per department.
 *
 * This replaces two charts — "requests by department" and "spend by
 * department" — whose numbers differed with nothing on screen to say why.
 * They differed correctly: one counts requests raised, the other sums money
 * that has actually left. Side by side and unlabelled, that reads as a bug.
 *
 * So: one card per department with every figure named, and the reason the
 * two money figures differ written underneath.
 */
import { Link } from 'react-router-dom';

export interface DepartmentCard {
  departmentId: string;
  department: string;
  raised: number;
  approved: number;
  rejected: number;
  waiting: number;
  asked: number;
  spent: number;
}

export interface DepartmentsPayload {
  kind: 'departments';
  cards: DepartmentCard[];
  totals: Omit<DepartmentCard, 'departmentId' | 'department'>;
  note: string;
}

const money = (n: number, currency: string) =>
  `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`;

export function DepartmentCards({ payload, currency }: {
  payload: DepartmentsPayload; currency: string;
}) {
  if (!payload.cards.length) {
    return <p className="muted">Nothing from any department in this range.</p>;
  }

  return (
    <>
      <div className="deptgrid">
        {payload.cards.map((c) => (
          <article className="deptcard" key={c.departmentId}>
            <header className="deptcard__head">
              <h4>{c.department}</h4>
              {/* Straight to that department's requests, filtered — the
                  card is a way in, not just a number. */}
              <Link className="ordername"
                    to={`/finance?department=${encodeURIComponent(c.departmentId)}`}>
                open
              </Link>
            </header>

            <p className="deptcard__spend">
              {money(c.spent, currency)}
              <small>spent — money that actually left</small>
            </p>

            <dl className="deptcard__rows">
              <div>
                <dt>Asked for</dt>
                <dd className="mono">{money(c.asked, currency)}</dd>
              </div>
              <div>
                <dt>Raised</dt>
                <dd className="mono">{c.raised}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd className="mono">{c.approved}</dd>
              </div>
              <div>
                <dt>Rejected</dt>
                <dd className={`mono${c.rejected ? ' is-bad' : ''}`}>
                  {c.rejected || '—'}
                </dd>
              </div>
              <div>
                <dt>Still waiting</dt>
                {/* As things stand, not within the range: a request raised
                    in January and still open belongs on today's list. */}
                <dd className={`mono${c.waiting ? ' is-warn' : ''}`}>
                  {c.waiting || '—'}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      <p className="muted deptnote">{payload.note}</p>
    </>
  );
}