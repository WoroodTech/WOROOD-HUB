/**
 * Reconciliation paging and the watermark.
 *
 *   npx tsx test/reconcile.test.ts
 *
 * No database and no Shopify: both effects are injected, so the cases that
 * matter here can actually be staged. The property under test is the one whose
 * failure is silent and permanent -- a watermark that moves past orders the run
 * never fetched. Those orders are not late; the next query asks for changes
 * after the watermark, so they are never requested again.
 *
 * The regression these pin is specific. The old loop ended on `!hasNextPage`
 * and on exhausting its page budget through the same `break`, and the caller
 * set the watermark to now() either way. Past roughly two thousand changed
 * orders in one window, the remainder was dropped.
 */
import {
  RECONCILE_MAX_PAGES, RESUME_MAX_AGE_MS, nextResume, nextWatermark,
  paginateOrders, resumePlan, type OrderPage,
} from '../src/modules/sales-dashboard/sync/reconcile-pages';

let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`); }
}
const eq = (name: string, a: any, b: any) =>
  check(name, JSON.stringify(a) === JSON.stringify(b),
    `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (t: string) => console.log(`\n${t}`);

/** Shopify sorted ascending by updated_at, served one page at a time. */
function fakeShop(totalPages: number, perPage = 2, startMs = Date.UTC(2026, 0, 1)) {
  const requested: Array<string | null> = [];
  return {
    requested,
    fetchPage: async (cursor: string | null): Promise<OrderPage> => {
      requested.push(cursor);
      const page = cursor === null ? 0 : Number(cursor.replace('p', ''));
      const nodes = Array.from({ length: perPage }, (_, i) => ({
        id: `gid://shopify/Order/${page * perPage + i}`,
        updatedAt: new Date(startMs + (page * perPage + i) * 60_000).toISOString(),
      }));
      return {
        nodes,
        hasNextPage: page + 1 < totalPages,
        endCursor: `p${page + 1}`,
      };
    },
  };
}
const writer = () => {
  const seen: any[][] = [];
  return { seen, writePage: async (nodes: any[]) => { seen.push(nodes); return nodes.length; } };
};

async function main() {
  const RUN_AT = new Date('2026-03-01T10:00:00Z');

  /* ------------------------------------------------------- several pages -- */
  section('Several pages, run finishes');
  {
    const shop = fakeShop(3);
    const w = writer();
    const r = await paginateOrders({ fetchPage: shop.fetchPage, writePage: w.writePage });

    eq('every page is fetched', r.pages, 3);
    eq('every order is seen', r.seen, 6);
    eq('every order is written', r.written, 6);
    check('the run reports itself complete', r.complete === true);
    eq('the cursor is carried between pages', shop.requested, [null, 'p1', 'p2']);
    eq('each page is handed to the writer once', w.seen.length, 3);

    const mark = nextWatermark(r, RUN_AT);
    eq('a complete run moves the watermark to when it started',
      mark?.toISOString(), RUN_AT.toISOString());
  }

  /* ------------------------------------------- more pages than the budget -- */
  section('More than forty pages of changes');
  {
    const shop = fakeShop(100);
    const w = writer();
    const r = await paginateOrders({ fetchPage: shop.fetchPage, writePage: w.writePage });

    eq('it stops at the ceiling', r.pages, RECONCILE_MAX_PAGES);
    check('and does NOT claim to be complete', r.complete === false);

    /* The regression. now() here would put the watermark past sixty unfetched
       pages, and the next run would ask for changes after it. */
    check('the watermark does not move at all', nextWatermark(r, RUN_AT) === null);

    /* Progress is carried by the cursor instead, which is the only thing that
       can point between two orders rather than at a moment in time. */
    const resume = nextResume(r, RUN_AT);
    const lastWritten = w.seen.at(-1)!.at(-1)!;
    eq('the resume point is the last page that was written', resume.cursor, r.lastCursor);
    check('which is the page holding the final order handed to the writer',
      r.lastUpdatedAt?.toISOString() === new Date(lastWritten.updatedAt).toISOString(),
      r.lastUpdatedAt?.toISOString());
    check('and the query it belongs to is kept with it', resume.since !== null);
  }

  /* --------------------------------- a next page remaining exactly at the limit */
  section('A further page remaining exactly at the limit');
  {
    // Forty pages of work and a forty-first waiting: the boundary the old loop
    // could not see, because it left through the same break as a finished run.
    const shop = fakeShop(RECONCILE_MAX_PAGES + 1);
    const w = writer();
    const r = await paginateOrders({ fetchPage: shop.fetchPage, writePage: w.writePage });

    eq('exactly the budget is used', r.pages, RECONCILE_MAX_PAGES);
    check('one page behind is enough to be incomplete', r.complete === false);
    check('so the watermark is left alone', nextWatermark(r, RUN_AT) === null);
    check('and a resume point is kept', nextResume(r, RUN_AT).cursor !== null);
  }
  {
    // And the page before that: the last page IS the budget, nothing behind it.
    const shop = fakeShop(RECONCILE_MAX_PAGES);
    const w = writer();
    const r = await paginateOrders({ fetchPage: shop.fetchPage, writePage: w.writePage });
    eq('a run that ends exactly on the budget is complete', r.complete, true);
    eq('and moves to the run time', nextWatermark(r, RUN_AT)?.toISOString(), RUN_AT.toISOString());
  }

  /* ------------------------------------------------- failure while paging -- */
  section('Failure part-way through');
  {
    const shop = fakeShop(10);
    const w = writer();
    const r = await paginateOrders({
      fetchPage: async (c) => {
        if (c === 'p2') throw new Error('502 from Shopify');
        return shop.fetchPage(c);
      },
      writePage: w.writePage,
    });

    check('the error is reported rather than swallowed', r.failure?.message === '502 from Shopify');
    eq('pages before the failure were written', w.seen.length, 2);
    check('the run is not complete', r.complete === false);
    check('the watermark does not move', nextWatermark(r, RUN_AT) === null);
    check('but the written pages are checkpointed, so the retry resumes',
      nextResume(r, RUN_AT).cursor === 'p2', String(r.lastCursor));
  }
  {
    // A writer that throws must not let the high-water mark pass the page it
    // failed on; otherwise that page's orders are marked done and never retried.
    const shop = fakeShop(10);
    let pages = 0;
    const r = await paginateOrders({
      fetchPage: shop.fetchPage,
      writePage: async (nodes) => {
        pages++;
        /* A writer that fails half way, which upsertOrders can: it writes
           order by order and is not one transaction. */
        if (pages === 3) throw new Error('deadlock on sd_orders');
        return nodes.length;
      },
    });
    check('a write failure stops the run', r.failure?.message === 'deadlock on sd_orders');
    eq('the failing page was attempted', pages, 3);
    check('the checkpoint stops at the last page that finished writing',
      r.lastCursor === 'p2', String(r.lastCursor));
    check('so the half-written page is covered again by the next run',
      nextResume(r, RUN_AT).cursor === 'p2');
    check('and no order from it is behind the checkpoint',
      r.lastUpdatedAt!.toISOString() === new Date(Date.UTC(2026, 0, 1) + 3 * 60_000).toISOString(),
      r.lastUpdatedAt?.toISOString());
  }

  /* ---------------------------------------------- backlogs actually drain -- */
  section('A backlog drains across runs, and is never stranded');
  {
    /* The whole cycle, not the helper alone: watermark -> since -> query ->
       pages -> watermark and cursor -> next run. A helper that paginates
       correctly can still be driven by a caller that strands work, which is
       exactly what the first version of this fix did. */
    const PAGE = 50, T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

    /* Cursors shaped the way Shopify's are: base64 JSON naming the last record
       and its sort value, so they resume between two orders sharing one
       `updated_at`. An array index would hide the bug under test, and a bare
       string would be refused by the tie guard -- rightly, since neither is
       what Shopify emits. */
    const key = (o: any) => `${o.updatedAt}|${o.id}`;
    const encode = (o: any) =>
      Buffer.from(JSON.stringify({ last_id: o.id, last_value: o.updatedAt })).toString('base64');
    const decode = (c: string) => {
      const p = JSON.parse(Buffer.from(c, 'base64').toString('utf8'));
      return `${p.last_value}|${p.last_id}`;
    };
    const store = (orders: Array<{ id: string; updatedAt: string }>) => {
      const sorted = [...orders].sort((a, b) => (key(a) < key(b) ? -1 : 1));
      return (sinceISO: string, cursor: string | null): OrderPage => {
        let m = sorted.filter((o) => o.updatedAt >= sinceISO);
        if (cursor) { const k = decode(cursor); m = m.filter((o) => key(o) > k); }
        const slice = m.slice(0, PAGE);
        return {
          nodes: slice, hasNextPage: m.length > PAGE,
          endCursor: slice.length ? encode(slice[slice.length - 1]) : null,
        };
      };
    };

    type State = { watermark: Date | null; cursor: string | null; since: Date | null };

    /* One reconcile() run.
    
       The resume decision, the watermark rule and the checkpoint rule are the
       production functions, called here exactly as reconcile() calls them --
       not a second copy that could agree with the test and disagree with the
       service. What remains below is only the plumbing reconcile() does around
       them: read the row, run the pages, write the row back. */
    const oneRun = async (q: any, st: State, done: Set<string>, now: Date, failAtPage?: number) => {
      const { since, startCursor } = resumePlan(
        { watermark: st.watermark, resume_cursor: st.cursor, resume_since: st.since }, now);
      let n = 0;
      const r = await paginateOrders({
        startCursor,
        fetchPage: async (c) => {
          n++;
          if (failAtPage && n === failAtPage) throw new Error('502 from Shopify');
          return q(since.toISOString(), c);
        },
        writePage: async (nodes: any[]) => { nodes.forEach((x) => done.add(x.id)); return nodes.length; },
      });
      const rs = nextResume(r, since);
      return {
        st: { watermark: nextWatermark(r, now) ?? st.watermark, cursor: rs.cursor, since: rs.since },
        r, since,
      };
    };

    const drain = async (orders: any[], failAtPage?: number) => {
      const q = store(orders);
      const done = new Set<string>();
      let st: State = { watermark: new Date(T0 - 60_000), cursor: null, since: null };
      const windows: number[] = [];
      for (let i = 1; i <= 10; i++) {
        const out = await oneRun(q, st, done, new Date(T0 + 600_000 + i * 900_000),
          i === 1 ? failAtPage : undefined);
        st = out.st;
        windows.push(out.r.seen);
        if (out.r.complete) break;
      }
      return { done, runs: windows, missing: orders.filter((o) => !done.has(o.id)).length };
    };

    // 2500 orders whose updated_at values all fall inside five minutes. The
    // first attempt at this fix stranded 500 of them for ever, because the
    // next run subtracted the overlap and landed before the window started.
    const spread = Array.from({ length: 2500 }, (_, i) => ({
      id: `o${String(i).padStart(5, '0')}`,
      updatedAt: new Date(T0 + Math.floor(i / 10) * 1000).toISOString(),
    }));
    const a = await drain(spread);
    eq('a 2500-order backlog in one five-minute window is fully processed', a.missing, 0);
    check('in a small number of runs, not an endless cycle', a.runs.length <= 3, a.runs.join(','));
    check('and the second run does not refetch the whole set',
      a.runs[1] < a.runs[0], a.runs.join(','));

    // The case a timestamp cannot checkpoint at all: one bulk edit, one
    // updated_at, split across many page boundaries.
    const tie = Array.from({ length: 2500 }, (_, i) => ({
      id: `t${String(i).padStart(5, '0')}`, updatedAt: new Date(T0).toISOString(),
    }));
    const b = await drain(tie);
    eq('2500 orders sharing one updated_at are all reached', b.missing, 0);
    check('including the ones split across a page boundary', b.done.has('t01999') && b.done.has('t02000'));
    check('without repeating the full forty pages every run', b.runs.length <= 3, b.runs.join(','));

    // And the same with a failure part way through the first run.
    const c = await drain(tie, 7);
    eq('a failure mid-backlog still ends with everything processed', c.missing, 0);
    check('the failed run kept its progress rather than starting over',
      c.runs[0] < 2000 && c.runs.length <= 4, c.runs.join(','));
  }

  /* ------------------------------------------------- concurrent updates -- */
  section('An order changed while the run was in flight');
  {
    /* The watermark for a finished run is the instant it began, never the
       instant it ended. An order edited during a long run carries an
       updated_at inside the run's own window; marking the end would put it
       behind the next query and lose it. */
    /* A ten-minute run: longer than the five-minute overlap, which is the
       case where taking the mark at the end stops being merely untidy and
       starts losing orders. */
    const started = new Date('2026-06-01T12:00:00Z');
    const r = await paginateOrders({
      fetchPage: async () => ({
        nodes: [{ updatedAt: '2026-06-01T11:59:00Z' }], hasNextPage: false, endCursor: null,
      }),
      writePage: async (n) => n.length,
    });

    const mark = nextWatermark(r, started)!;
    eq('the watermark is the start of the run', mark.toISOString(), started.toISOString());

    // An order edited two minutes in, after its own page had been read.
    const editedDuringRun = new Date('2026-06-01T12:02:00Z');
    const finished = new Date('2026-06-01T12:10:00Z');
    check('the edit happened after the page was read and before the run ended',
      editedDuringRun > mark && editedDuringRun < finished);

    const nextSince = new Date(mark.getTime() - 5 * 60_000);
    check('the next run asks from a point before the edit, so it is refetched',
      new Date(editedDuringRun) >= nextSince,
      `${editedDuringRun.toISOString()} vs ${nextSince.toISOString()}`);

    // The regression this guards: had the mark been taken at the end.
    const wrong = new Date(finished.getTime() - 5 * 60_000);
    check('whereas marking the end of the run would have skipped it',
      editedDuringRun < wrong, `${editedDuringRun.toISOString()} vs ${wrong.toISOString()}`);
  }

  /* ------------------------------- an order edited behind the cursor -- */
  section('An order edited after the cursor has passed its position');
  {
    /* Shopify sorts by updated_at, so editing an order moves it to the end of
       the result set -- past the cursor, not behind it. That is what makes a
       positional cursor safe to resume from: the edit cannot hide in the part
       already traversed. Proven rather than assumed, because if it were false
       the resumed run would skip the new version silently. */
    const PAGE = 50, T0 = Date.UTC(2026, 7, 1, 9, 0, 0);
    const key = (o: any) => `${o.updatedAt}|${o.id}`;
    const encode = (o: any) =>
      Buffer.from(JSON.stringify({ last_id: o.id, last_value: o.updatedAt })).toString('base64');
    const decode = (c: string) => {
      const p = JSON.parse(Buffer.from(c, 'base64').toString('utf8'));
      return `${p.last_value}|${p.last_id}`;
    };
    const rows = new Map<string, { id: string; updatedAt: string }>();
    for (let i = 0; i < 2500; i++) {
      rows.set(`o${String(i).padStart(5, '0')}`,
        { id: `o${String(i).padStart(5, '0')}`, updatedAt: new Date(T0 + i * 1000).toISOString() });
    }
    const q = (sinceISO: string, cursor: string | null): OrderPage => {
      let m = [...rows.values()].filter((o) => o.updatedAt >= sinceISO)
        .sort((a, b) => (key(a) < key(b) ? -1 : 1));
      if (cursor) { const k = decode(cursor); m = m.filter((o) => key(o) > k); }
      const slice = m.slice(0, PAGE);
      return { nodes: slice.map((o) => ({ ...o })), hasNextPage: m.length > PAGE,
               endCursor: slice.length ? encode(slice[slice.length - 1]) : null };
    };

    const versions = new Map<string, string>();
    const writePage = async (nodes: any[]) => {
      nodes.forEach((n) => versions.set(n.id, n.updatedAt));
      return nodes.length;
    };

    const now1 = new Date(T0 + 3_000_000);
    const p1 = resumePlan({ watermark: new Date(T0 - 60_000) }, now1);
    const r1 = await paginateOrders({
      startCursor: p1.startCursor,
      fetchPage: async (c) => q(p1.since.toISOString(), c),
      writePage,
    });
    check('the first run stops with the backlog unfinished', r1.complete === false);
    const resume1 = nextResume(r1, p1.since);
    check('an order early in the set was written at its old version',
      versions.get('o00005') === new Date(T0 + 5000).toISOString());

    /* Now that order is edited. It sits far behind the cursor by its old
       position, and its new updated_at is later than anything yet seen. */
    const editedAt = new Date(T0 + 4_000_000).toISOString();
    rows.set('o00005', { id: 'o00005', updatedAt: editedAt });

    const now2 = new Date(T0 + 3_900_000);
    const p2 = resumePlan(
      { watermark: new Date(T0 - 60_000), resume_cursor: resume1.cursor, resume_since: resume1.since },
      now2);
    check('the second run resumes from the cursor', p2.resuming === true);

    let r2 = await paginateOrders({
      startCursor: p2.startCursor,
      fetchPage: async (c) => q(p2.since.toISOString(), c),
      writePage,
    });
    // Drain whatever remains, the way successive scheduled runs would.
    let plan = p2;
    let res = nextResume(r2, p2.since);
    for (let i = 0; i < 5 && !r2.complete; i++) {
      plan = resumePlan(
        { watermark: new Date(T0 - 60_000), resume_cursor: res.cursor, resume_since: res.since },
        new Date(T0 + 4_500_000));
      r2 = await paginateOrders({
        startCursor: plan.startCursor,
        fetchPage: async (c) => q(plan.since.toISOString(), c),
        writePage,
      });
      res = nextResume(r2, plan.since);
    }

    check('the backlog finishes', r2.complete === true);
    eq('the edited order is synchronised at its NEW version',
      versions.get('o00005'), editedAt);
  }

  /* ----------------------------------- crash windows around persistence -- */
  section('Crash windows: page write, checkpoint write');
  {
    /* The ordering that must hold: a page is durable before the checkpoint
       that covers it. Recorded as an interleaved log so the claim is read off
       the sequence rather than inferred. */
    const order: string[] = [];
    const shop = fakeShop(4);
    const r = await paginateOrders({
      fetchPage: async (c) => { order.push(`fetch(${c ?? 'start'})`); return shop.fetchPage(c); },
      writePage: async (nodes) => { order.push(`write(${nodes.length})`); return nodes.length; },
    });
    // The checkpoint the caller would store, taken after the loop.
    order.push(`checkpoint(${nextResume(r, RUN_AT).cursor ?? 'none'})`);
    check('every page write precedes the checkpoint that covers it',
      order.lastIndexOf('write(2)') < order.length - 1, order.join(' '));
    check('and a page is fetched before it is written',
      order.indexOf('fetch(start)') < order.indexOf('write(2)'));
  }
  {
    // Page write succeeds, then the checkpoint write fails. The caller's
    // markSync throws, so neither the watermark nor the cursor is stored.
    const shop = fakeShop(60);
    const written = new Set<string>();
    const r = await paginateOrders({
      fetchPage: shop.fetchPage,
      writePage: async (nodes) => { nodes.forEach((n: any) => written.add(n.id)); return nodes.length; },
    });
    check('pages were written', written.size > 0);

    let stored: any = { watermark: new Date('2026-01-01T00:00:00Z'), resume_cursor: null, resume_since: null };
    const before = JSON.stringify(stored);
    try {
      throw new Error('markSync failed: connection terminated');
    } catch { /* nothing is stored */ }
    eq('a failed checkpoint write leaves the stored state untouched',
      JSON.stringify(stored), before);

    /* The consequence to prove is that the next run cannot skip: it starts
       from the unchanged watermark, so the written pages are simply read
       again. */
    const plan = resumePlan(stored, new Date('2026-01-01T01:00:00Z'));
    check('so the next run restarts from the watermark, not past it',
      plan.resuming === false && plan.since < new Date('2026-01-01T00:00:00Z'),
      plan.since.toISOString());
  }
  {
    // A page that is half written, then fails. upsertOrders is not one
    // transaction, so this is a real state, not a hypothetical.
    const shop = fakeShop(10, 4);
    const written = new Set<string>();
    let page = 0;
    const r = await paginateOrders({
      fetchPage: shop.fetchPage,
      writePage: async (nodes) => {
        page++;
        if (page === 3) {
          written.add(nodes[0].id);          // first order lands
          throw new Error('deadlock on sd_orders');   // the rest do not
        }
        nodes.forEach((n: any) => written.add(n.id));
        return nodes.length;
      },
    });
    check('the run stops', r.failure !== null);
    const resume = nextResume(r, RUN_AT);
    eq('the checkpoint names the last page that finished, not the half one',
      resume.cursor, 'p2');
    check('so every order on the half-written page is covered again',
      r.lastUpdatedAt!.toISOString()
        === new Date(Date.UTC(2026, 0, 1) + 7 * 60_000).toISOString(),
      r.lastUpdatedAt?.toISOString());
    check('and the watermark does not move', nextWatermark(r, RUN_AT) === null);
  }

  /* ------------------------------------------- a cursor Shopify rejects -- */
  section('An expired or rejected cursor');
  {
    const stored = {
      watermark: new Date('2026-04-01T10:00:00Z'),
      resume_cursor: 'stale-cursor',
      resume_since: new Date('2026-04-01T09:55:00Z'),
    };

    // Shopify refuses the cursor outright.
    const r = await paginateOrders({
      startCursor: resumePlan(stored, new Date('2026-04-01T10:15:00Z')).startCursor,
      fetchPage: async () => { throw new Error('invalid cursor'); },
      writePage: async (n) => n.length,
    });
    check('the run fails without writing anything', r.failure !== null && r.written === 0);

    const resume = nextResume(r, stored.resume_since);
    check('the rejected cursor is dropped rather than reissued for ever',
      resume.cursor === null, String(resume.cursor));
    check('the watermark still does not move', nextWatermark(r, RUN_AT) === null);

    const next = resumePlan(
      { ...stored, resume_cursor: resume.cursor, resume_since: resume.since },
      new Date('2026-04-01T10:30:00Z'));
    check('the next run falls back to the watermark', next.resuming === false);
    check('with the overlap reapplied, so nothing between is skipped',
      next.since < stored.watermark, next.since.toISOString());
  }
  {
    // Age alone retires a cursor, so a stall is bounded even if Shopify keeps
    // accepting it.
    const base = new Date('2026-04-01T10:00:00Z');
    const fresh = resumePlan(
      { watermark: base, resume_cursor: 'c', resume_since: base },
      new Date(base.getTime() + RESUME_MAX_AGE_MS - 60_000));
    check('a recent cursor is used', fresh.resuming === true);

    const old = resumePlan(
      { watermark: base, resume_cursor: 'c', resume_since: base },
      new Date(base.getTime() + RESUME_MAX_AGE_MS + 60_000));
    check('an aged cursor is abandoned', old.resuming === false);
    check('and the run restarts from the watermark with the overlap',
      old.since.getTime() === base.getTime() - 5 * 60_000, old.since.toISOString());
  }

  /* --------------------------- a tied group spanning many pages -- */
  section('A tied group of orders spanning many page boundaries');
  {
    /* The hazard Shopify designed relative cursors around: sorting on a
       non-unique field and remembering only that field's last value would,
       in their words, potentially skip records. Their cursors therefore carry
       a secondary unique key -- the last value AND the last id -- which is why
       `after:` can resume in the middle of a tied run rather than stepping
       over the rest of it.

         https://shopify.engineering/pagination-relative-cursors

       This models that contract and pins the consequence: a single bulk edit
       giving 2,500 orders one updated_at, cut by 50 page boundaries, is fully
       synchronised. Were the cursor value-only, every page after the first
       would jump the whole group and almost all of it would be lost. */
    const PAGE = 50;
    const T = new Date('2026-11-02T06:00:00Z').toISOString();

    const all = Array.from({ length: 2500 }, (_, i) => ({
      id: `b${String(i).padStart(5, '0')}`, updatedAt: T,
    }));
    const sortKey = (o: any) => `${o.updatedAt}|${o.id}`;

    /* Shopify's documented cursor: last sort value plus last id. */
    const encode = (o: any) => Buffer.from(JSON.stringify(
      { last_value: o.updatedAt, last_id: o.id })).toString('base64');
    const shopify = (sinceISO: string, cursor: string | null): OrderPage => {
      let m = all.filter((o) => o.updatedAt >= sinceISO).sort((a, b) =>
        (sortKey(a) < sortKey(b) ? -1 : 1));
      if (cursor) {
        const p = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        m = m.filter((o) => sortKey(o) > `${p.last_value}|${p.last_id}`);
      }
      const slice = m.slice(0, PAGE);
      return { nodes: slice, hasNextPage: m.length > PAGE,
               endCursor: slice.length ? encode(slice[slice.length - 1]) : null };
    };

    const done = new Set<string>();
    let st = { watermark: new Date(Date.parse(T) - 60_000) as Date | null,
               cursor: null as string | null, since: null as Date | null };
    let runs = 0;
    for (let i = 0; i < 6; i++) {
      runs++;
      const plan = resumePlan(
        { watermark: st.watermark, resume_cursor: st.cursor, resume_since: st.since },
        new Date(Date.parse(T) + i * 900_000));
      const r = await paginateOrders({
        startCursor: plan.startCursor,
        fetchPage: async (c) => shopify(plan.since.toISOString(), c),
        writePage: async (n: any[]) => { n.forEach((x) => done.add(x.id)); return n.length; },
      });
      const rs = nextResume(r, plan.since);
      st = { watermark: nextWatermark(r, new Date(Date.parse(T) + i * 900_000)) ?? st.watermark,
             cursor: rs.cursor, since: rs.since };
      if (r.complete) break;
    }

    eq('every order in the tied group is synchronised', 2500 - done.size, 0);
    check('across many page boundaries, all sharing one updated_at',
      done.has('b00049') && done.has('b00050') && done.has('b01999') && done.has('b02000'));
    check('in a bounded number of runs', runs <= 3, String(runs));
    check('and only then does the watermark move past the group',
      st.watermark!.getTime() > Date.parse(T), st.watermark?.toISOString());
    check('with the resume point cleared once it is finished', st.cursor === null);
  }

  /* ------------------------------------------- the resume decision itself -- */
  section('The resume plan reconcile() uses');
  {
    const now = new Date('2026-05-01T12:00:00Z');

    const cold = resumePlan(null, now);
    check('no state at all means a day back, not all of history',
      cold.since.getTime() === now.getTime() - 24 * 60 * 60_000, cold.since.toISOString());
    check('and no cursor', cold.startCursor === null && cold.resuming === false);

    const wm = new Date('2026-05-01T11:00:00Z');
    const normal = resumePlan({ watermark: wm }, now);
    check('a watermark with no cursor applies the five-minute overlap',
      normal.since.getTime() === wm.getTime() - 5 * 60_000, normal.since.toISOString());

    const rs = new Date('2026-05-01T11:30:00Z');
    const resumed = resumePlan({ watermark: wm, resume_cursor: 'c9', resume_since: rs }, now);
    eq('resuming reuses the cursor\'s own query, unchanged',
      resumed.since.toISOString(), rs.toISOString());
    check('with no overlap reapplied — that reopening was the livelock',
      resumed.since.getTime() === rs.getTime());
    eq('and continues from the cursor', resumed.startCursor, 'c9');

    const halfRow = resumePlan({ watermark: wm, resume_cursor: 'c9' }, now);
    check('a cursor with no query to go with it is unusable and ignored',
      halfRow.resuming === false);
  }

  /* ------------------------------------------------------- empty and odd -- */
  section('Empty results and malformed pages');
  {
    const r = await paginateOrders({
      fetchPage: async () => ({ nodes: [], hasNextPage: false, endCursor: null }),
      writePage: async () => { throw new Error('writer must not be called for an empty page'); },
    });
    eq('nothing changed is a complete run', r.complete, true);
    eq('with nothing seen', r.seen, 0);
    check('and no cursor to keep', nextResume(r, RUN_AT).cursor === null);
    eq('so it still moves to the run time', nextWatermark(r, RUN_AT)?.toISOString(),
      RUN_AT.toISOString());
  }
  {
    // hasNextPage true with no cursor would re-request page one to the ceiling.
    let calls = 0;
    const r = await paginateOrders({
      fetchPage: async () => {
        calls++;
        return { nodes: [{ updatedAt: RUN_AT.toISOString() }], hasNextPage: true, endCursor: null };
      },
      writePage: async (n) => n.length,
    });
    eq('a next page with no cursor stops the run', calls, 1);
    check('and is reported incomplete rather than finished', r.complete === false);
  }
  {
    const r = await paginateOrders({
      fetchPage: async () => ({
        nodes: [{ updatedAt: null }, { updatedAt: 'not-a-date' }],
        hasNextPage: false, endCursor: null,
      }),
      writePage: async (n) => n.length,
    });
    check('unparseable timestamps do not become the watermark', r.lastUpdatedAt === null);
  }

  /* ---------------------------------------------- the watermark rule itself -- */
  section('Watermark rule');
  {
    const since = new Date('2026-02-02T02:02:00Z');
    eq('only a finished run moves it, and to the moment it started',
      nextWatermark({ complete: true }, RUN_AT)?.toISOString(), RUN_AT.toISOString());
    check('an unfinished run leaves it exactly where it was',
      nextWatermark({ complete: false }, RUN_AT) === null);

    eq('a finished run clears the resume point',
      nextResume({ complete: true, lastCursor: 'p9' }, since),
      { cursor: null, since: null });
    eq('an unfinished one keeps the cursor and the query it belongs to',
      nextResume({ complete: false, lastCursor: 'p9' }, since),
      { cursor: 'p9', since: since.toISOString() });
    eq('an unfinished run that wrote nothing has no resume point',
      nextResume({ complete: false, lastCursor: null }, since),
      { cursor: null, since: null });
  }

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });