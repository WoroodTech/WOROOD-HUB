/**
 * A long list, a page at a time.
 *
 * The warehouse's registers run to hundreds of rows — a hundred and fifty
 * rolls in stock, two hundred finished job orders — and rendering all of
 * them puts a scrollbar a thumbnail high on the page and several thousand
 * table cells in the browser. Neither helps anybody find a roll.
 *
 * Paging here rather than on the server because the rows are already in
 * hand: they came from one read of a sheet, and asking for them again a
 * page at a time would be slower and would re-read a tab that changes under
 * it. Filtering first and paging the result is also what people expect —
 * narrow it, then walk what is left.
 */
import { useEffect, useState } from 'react';

export function Paged<Row>({ rows, perPage = 25, render }: {
  rows: Row[];
  perPage?: number;
  render: (page: Row[]) => React.ReactNode;
}) {
  const [page, setPage] = useState(0);

  const pages = Math.max(1, Math.ceil(rows.length / perPage));

  /*
   * Back to the first page when the list changes under us.
   *
   * Filtering down to three rows while sitting on page four shows an empty
   * table and no way to tell why — the control that caused it is at the top
   * of the screen and the emptiness is at the bottom.
   */
  useEffect(() => {
    if (page >= pages) setPage(0);
  }, [pages, page]);

  const from = page * perPage;
  const shown = rows.slice(from, from + perPage);

  return (
    <>
      {render(shown)}

      {/* One page is not a pager. */}
      {pages > 1 ? (
        <div className="pager no-print">
          <button type="button" className="btn btn--ghost btn--sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </button>
          <span className="muted">
            {/* Which rows, not just which page: "26–50 of 154" answers how
                far through this is, where "page 2 of 7" does not. */}
            {from + 1}–{Math.min(from + perPage, rows.length)} of {rows.length}
          </span>
          <button type="button" className="btn btn--ghost btn--sm"
                  disabled={page >= pages - 1}
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}