/**
 * Looking after the notice board.
 *
 * The reading page shows what is on the board. This shows everything that
 * exists, which is a different and larger thing: drafts nobody has finished,
 * notices waiting for their date, ones that came down by themselves last
 * quarter, and ones somebody took down on purpose.
 *
 * The idea the screen is built around: **`PUBLISHED` does not mean "on the
 * board"**. A notice can be published and invisible because its date has not
 * arrived, or because it expired a month ago. Those are three different
 * situations wearing one word, and the database cannot tell them apart in a
 * column. So the status shown here is the answer to "is this up right now,
 * and if not, why" -- which is the only version of the question anybody
 * actually asks.
 *
 * Everything else follows the portal's existing furniture. A notice board is
 * not the place to introduce a second visual language.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Icon } from '../components/Icon';
import { useAuth } from '../lib/auth';
import { NoticeComposerModal } from '../components/NoticeComposer';
import { ConfirmDialog } from '../components/Confirmdialog';
import type {
  Announcement, AnnouncementFilter, AnnouncementsResponse,
} from '../contract';

const PAGE = 20;

/* No "Scheduled" tab. Publishing happens the moment somebody presses the
   button, so a notice cannot be published-but-waiting -- the tab could only
   ever be empty, and an empty tab that can never fill teaches people to
   ignore tabs. The API can still schedule if the form ever offers it. */

/** The tabs, in the order somebody works through them. */
const TABS: { key: AnnouncementFilter; label: string; hint: string }[] = [
  { key: 'live', label: 'On the board', hint: 'Everyone can see these right now.' },
  { key: 'draft', label: 'Drafts', hint: 'Not published. Only you can see these.' },
  { key: 'expired', label: 'Came down', hint: 'Published, but past the date they were set to end.' },
  { key: 'archived', label: 'Archived', hint: 'Taken down on purpose. Can be put back up.' },
];

/**
 * What is actually true of this notice, now.
 *
 * Derived here rather than read from `status`, because `status` answers a
 * narrower question than the one being asked. A manager looking at a row
 * wants to know whether people can see it, and `PUBLISHED` does not say.
 */
function standing(a: Announcement): { label: string; tone: string; why: string | null } {
  const now = Date.now();
  const starts = new Date(a.publishAt).getTime();
  const ends = a.expiresAt ? new Date(a.expiresAt).getTime() : null;

  if (a.status === 'DRAFT') {
    return { label: 'Draft', tone: 'is-draft', why: 'Nobody else can see it yet.' };
  }
  if (a.status === 'ARCHIVED') {
    return { label: 'Archived', tone: 'is-archived', why: 'Taken down.' };
  }
  if (starts > now) {
    /* Not reachable from the form, but the API allows it and a row written
       any other way should still read correctly rather than claim to be up. */
    return {
      label: 'Not up yet', tone: 'is-scheduled',
      why: `Goes up ${new Date(a.publishAt).toLocaleDateString(undefined,
        { day: 'numeric', month: 'short' })}.`,
    };
  }
  if (ends !== null && ends <= now) {
    return {
      label: 'Came down', tone: 'is-expired',
      why: `Ended ${new Date(ends).toLocaleDateString(undefined,
        { day: 'numeric', month: 'short' })}.`,
    };
  }
  return {
    label: 'On the board', tone: 'is-live',
    why: ends
      ? `Until ${new Date(ends).toLocaleDateString(undefined,
          { day: 'numeric', month: 'short' })}.`
      : 'Until somebody takes it down.',
  };
}

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined,
    { day: 'numeric', month: 'short', year: 'numeric' });

export function NewsManage() {
  const { can: may } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<AnnouncementFilter>('live');
  const [page, setPage] = useState(0);
  const [writing, setWriting] = useState(false);
  /* What is waiting to be confirmed, if anything. Held as the row itself so
     the dialog can name it rather than say "this item". */
  const [deleting, setDeleting] = useState<Announcement | null>(null);

  const canManage = may('announcements.manage');

  const list = useQuery({
    queryKey: [...qk.newsManage(tab), page],
    queryFn: () => api<AnnouncementsResponse>(
      `/news?status=${tab}&limit=${PAGE}&offset=${page * PAGE}`),
    enabled: canManage,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['news'] });
  };

  const act = useMutation({
    mutationFn: ({ id, what, pinned }: {
      id: string; what: 'publish' | 'archive' | 'delete' | 'pin'; pinned?: boolean;
    }) =>
      what === 'delete' ? api(`/news/${id}`, { method: 'DELETE' })
      : what === 'pin' ? api(`/news/${id}`, { method: 'PATCH', body: { pinned } })
      : api(`/news/${id}/${what}`, { method: 'POST' }),
    onSuccess: refresh,
  });

  if (!canManage) {
    return (
      <main className="page">
        <p className="state">This page is for whoever looks after the notice board.</p>
      </main>
    );
  }

  const rows = list.data?.announcements ?? [];
  const total = list.data?.total ?? 0;
  const active = TABS.find((t) => t.key === tab)!;

  return (
    <main className="page">
      {deleting ? (
        <ConfirmDialog
          title={`Delete “${deleting.title || deleting.titleAr || 'this notice'}”?`}
          body="It has never been published, so nobody has seen it. This cannot be undone."
          confirmLabel="Delete it"
          danger
          busy={act.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            act.mutate({ id: deleting.id, what: 'delete' });
            setDeleting(null);
          }}
        />
      ) : null}

      {writing ? (
        <NoticeComposerModal
          onClose={() => setWriting(false)}
          onSaved={() => {
            /* Straight to Drafts, where it now is. Leaving the manager on
               "On the board" after writing something would look like the
               notice had vanished. */
            setTab('draft');
            setPage(0);
            refresh();
          }}
        />
      ) : null}

      <header className="pagehead">
        <div>
          <h1>The notice board</h1>
          <p className="muted">
            Everything that exists, not just what is up. {total} here.
          </p>
        </div>
        {/* Opens here rather than sending somebody to the reading page: the
            notice they are about to write lands in Drafts on this screen, so
            leaving it would mean coming straight back. */}
        <button type="button" className="btn btn--primary"
                onClick={() => setWriting(true)}>
          <Icon name="plus" size={14} /> Write a notice
        </button>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key} type="button" role="tab"
            aria-selected={tab === t.key}
            className={`tabs__tab ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => { setTab(t.key); setPage(0); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* The tab's own sentence, not a tooltip: which of these five a notice
          is in is the thing people get wrong, and the explanation belongs
          where they are already looking. */}
      <p className="muted boardhint">{active.hint}</p>

      {list.isLoading ? (
        <p className="state">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyBoard tab={tab} />
      ) : (
        <div className="tablewrap">
          <table className="table board">
            <thead>
              <tr>
                <th>Notice</th>
                <th>Standing</th>
                <th>Written</th>
                <th>By</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const s = standing(a);
                const title = a.title || a.titleAr || '(untitled)';
                return (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/news/${a.id}`} className="board__title">{title}</Link>
                      <span className="board__marks">
                        {a.pinned ? (
                          <span className="idtag" title="Kept at the top">Pinned</span>
                        ) : null}
                        {a.images.length ? (
                          <span className="idtag idtag--muted">
                            {a.images.length} {a.images.length === 1 ? 'image' : 'images'}
                          </span>
                        ) : null}
                        {a.commentsEnabled ? (
                          <span className="idtag idtag--muted">
                            {a.commentCount} {a.commentCount === 1 ? 'comment' : 'comments'}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <span className={`standing ${s.tone}`}>{s.label}</span>
                      {s.why ? <span className="standing__why">{s.why}</span> : null}
                    </td>
                    <td className="nowrap">{when(a.createdAt)}</td>
                    <td>{a.author.fullName}</td>
                    <td className="board__actions">
                      {/* Pinning lives here rather than in the form: which
                          notice outranks the others is a decision about the
                          board, taken where the others are visible. */}
                      {a.status === 'PUBLISHED' ? (
                        <button type="button" className="btn btn--sm btn--ghost"
                                disabled={act.isPending}
                                onClick={() => act.mutate({
                                  id: a.id, what: 'pin', pinned: !a.pinned })}>
                          {a.pinned ? 'Unpin' : 'Pin to top'}
                        </button>
                      ) : null}
                      {a.status !== 'PUBLISHED' ? (
                        <button type="button" className="btn btn--sm btn--primary"
                                disabled={act.isPending}
                                onClick={() => act.mutate({ id: a.id, what: 'publish' })}>
                          {a.status === 'ARCHIVED' ? 'Put back up' : 'Publish'}
                        </button>
                      ) : (
                        <button type="button" className="btn btn--sm btn--ghost"
                                disabled={act.isPending}
                                onClick={() => act.mutate({ id: a.id, what: 'archive' })}>
                          Take down
                        </button>
                      )}
                      {/* Deleting is only offered for a draft. Anything that
                          has been on the board was read by people, and taking
                          it down is the honest way to retire it. */}
                      {a.status === 'DRAFT' ? (
                        <button type="button" className="btn btn--sm btn--danger"
                                disabled={act.isPending}
                                onClick={() => setDeleting(a)}>
                          Delete
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {act.isError ? (
        <p className="state state--error">
          {(act.error as any)?.message ?? 'That did not work.'}
        </p>
      ) : null}

      {total > PAGE ? (
        <nav className="pager">
          <button type="button" className="btn btn--ghost btn--sm"
                  disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
            Previous
          </button>
          <span className="muted">
            {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
          </span>
          <button type="button" className="btn btn--ghost btn--sm"
                  disabled={(page + 1) * PAGE >= total}
                  onClick={() => setPage((n) => n + 1)}>
            Next
          </button>
        </nav>
      ) : null}
    </main>
  );
}

/** An empty tab says what would put something in it. */
function EmptyBoard({ tab }: { tab: AnnouncementFilter }) {
  const said: Record<string, string> = {
    live: 'Nothing is on the board. Publish a draft and it appears here.',
    draft: 'No drafts. Anything you start and do not publish waits here.',
    scheduled: 'Nothing is waiting for a date.',
    expired: 'Nothing has come down by itself.',
    archived: 'Nothing has been taken down.',
    all: 'No notices yet.',
  };
  return (
    <p className="state">
      {said[tab] ?? said.all}{' '}
      {tab === 'live' || tab === 'draft'
        ? 'Use the button above.'
        : null}
    </p>
  );
}