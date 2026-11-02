/**
 * Company news: the archive, one notice, and the form that writes them.
 *
 * Three screens in one file because they are one small thing, and splitting
 * them would mean three files that only ever change together.
 *
 * The composer is here rather than behind its own module tab: whoever writes
 * the news also reads it, and a "write" button on the page they are already
 * looking at is one step instead of two.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Announcement, AnnouncementDetail, AnnouncementsResponse,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { NoticeComposer } from '../components/NoticeComposer';
import { NoticeReactions } from '../components/Noticereactions';
import { ConfirmDialog } from '../components/Confirmdialog';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';
import { pick } from '../portlets/CompanyNews';

const lang = () => document.documentElement.lang || 'en';

/* ---------------------------------------------------------------- archive -- */

export function News() {
  const [composing, setComposing] = useState(false);
  const list = useQuery({
    queryKey: qk.newsList(20, 0),
    queryFn: () => api<AnnouncementsResponse>('/news?limit=20&offset=0'),
  });

  if (list.isLoading) return <LoadingState label="Loading the news" />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const items = list.data?.announcements ?? [];
  /* The server already decides this — it is the same permission that lets the
     write endpoints through — so the button appears exactly when it would work. */
  const canManage = items.some((a) => a.canManage) || composing;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Company News</h1>
          <p className="muted">Announcements, events and the people behind them.</p>
        </div>
        {canManage ? (
          <button type="button" className="btn btn--primary" onClick={() => setComposing(true)}>
            <Icon name="sparkles" size={14} /> Write an announcement
          </button>
        ) : null}
      </header>

      {/* The same form the manage screen uses. Two copies drift: one grows a
          field, the other does not, and the difference only surfaces when
          somebody asks why a notice written from one place behaves
          differently. */}
      {composing ? (
        <Card title="Write a notice">
          <NoticeComposer
            onSaved={() => { setComposing(false); void list.refetch(); }}
            onCancel={() => setComposing(false)}
          />
        </Card>
      ) : null}

      {!items.length ? (
        <EmptyState icon="bell" title="Nothing yet"
                    hint="When HR posts something, it will show here and on the home page." />
      ) : (
        <ul className="newslist">
          {items.map((a) => <NewsRow key={a.id} item={a} />)}
        </ul>
      )}
    </div>
  );
}

function NewsRow({ item }: { item: Announcement }) {
  const title = pick(item.title, item.titleAr, lang());
  const body = pick(item.body, item.bodyAr, lang());
  const cover = item.images[0];
  const live = item.status === 'PUBLISHED'
    && new Date(item.publishAt) <= new Date()
    && (!item.expiresAt || new Date(item.expiresAt) > new Date());

  return (
    <li className="newsrow">
      {cover ? (
        <Link to={`/news/${item.id}`} className="newsrow__thumb">
          <img src={cover.thumbUrl ?? cover.url} alt="" loading="lazy" />
        </Link>
      ) : null}
      <div className="newsrow__text">
        <div className="newsrow__meta">
          {item.pinned ? <span className="idtag">Pinned</span> : null}
          {/* Managers see drafts and expired notices in this list, so each one
              has to say which it is -- otherwise the archive reads as though
              everything on it is live. */}
          {!live ? <span className="idtag idtag--muted">{item.status === 'DRAFT' ? 'Draft' : 'Not showing'}</span> : null}
          <span className="muted">{formatDate(item.publishAt)} · {item.author.fullName}</span>
        </div>
        <h2><Link to={`/news/${item.id}`}>{title}</Link></h2>
        {body ? <p className="newsrow__body">{body}</p> : null}
        {item.commentCount ? (
          <span className="muted newsrow__replies">
            <Icon name="info" size={12} /> {item.commentCount}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/* ----------------------------------------------------------------- detail -- */

export function NewsItem() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [reply, setReply] = useState('');

  const item = useQuery({
    queryKey: qk.newsItem(id),
    queryFn: () => api<AnnouncementDetail>(`/news/${id}`),
    enabled: !!id,
  });

  const comment = useMutation({
    mutationFn: (body: string) =>
      api(`/news/${id}/comments`, { method: 'POST', body: { body } }),
    onSuccess: () => {
      setReply('');
      void qc.invalidateQueries({ queryKey: qk.newsItem(id) });
      void qc.invalidateQueries({ queryKey: qk.news });
    },
  });

  const removeComment = useMutation({
    mutationFn: (commentId: string) => api(`/news/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.newsItem(id) }),
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => api(`/news/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.news });
      navigate('/news');
    },
  });

  const publish = useMutation({
    mutationFn: () => api(`/news/${id}/publish`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.newsItem(id) });
      void qc.invalidateQueries({ queryKey: qk.news });
    },
  });

  if (item.isLoading) return <LoadingState label="Loading" />;
  if (item.isError || !item.data) {
    return <ErrorState error={item.error} onRetry={() => void item.refetch()} />;
  }

  const a = item.data;
  const title = pick(a.title, a.titleAr, lang());
  const body = pick(a.body, a.bodyAr, lang());

  return (
    <div className="page page--narrow">
      <Link to="/news" className="backlink"><Icon name="left" size={13} /> All news</Link>

      <article className="newsarticle">
        <header>
          <h1>{title}</h1>
          <p className="muted">
            {formatDate(a.publishAt)} · {a.author.fullName}
            {a.expiresAt ? ` · showing until ${formatDate(a.expiresAt)}` : ''}
          </p>
        </header>

        {/* Pictures and documents are shown apart: one is looked at in place,
            the other is opened. Mixing them would mean a row of broken image
            frames where the PDFs are. */}
        {a.images.some((im) => im.kind !== 'document') ? (
          <div className="newsarticle__gallery">
            {a.images.filter((im) => im.kind !== 'document').map((im) => (
              <figure key={im.id}>
                <img src={im.url} alt={pick(im.caption, im.captionAr, lang()) ?? ''} loading="lazy" />
                {pick(im.caption, im.captionAr, lang())
                  ? <figcaption>{pick(im.caption, im.captionAr, lang())}</figcaption> : null}
              </figure>
            ))}
          </div>
        ) : null}

        {body ? <div className="newsarticle__body">{body}</div> : null}

        {a.images.some((im) => im.kind === 'document') ? (
          <ul className="newsdocs">
            {a.images.filter((im) => im.kind === 'document').map((im) => (
              <li key={im.id}>
                {/* The signed URL expires in an hour, which is why this is a
                    plain link to open now rather than something to bookmark. */}
                <a href={im.url} target="_blank" rel="noopener noreferrer">
                  <Icon name="receipt" size={15} />
                  <span>{im.name ?? 'Attachment'}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        <NoticeReactions announcementId={a.id} reactions={a.reactions} />

        {confirmingDelete ? (
          <ConfirmDialog
            title={`Delete “${a.title || a.titleAr || 'this notice'}”?`}
            body={
              /* Said plainly, because it is different for a notice people have
                 already read: the comments and reactions go with it. */
              a.commentCount > 0
                ? `It has ${a.commentCount} ${a.commentCount === 1 ? 'comment' : 'comments'}, which will go with it. This cannot be undone.`
                : 'This cannot be undone.'
            }
            confirmLabel="Delete it"
            danger
            busy={remove.isPending}
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={() => { setConfirmingDelete(false); remove.mutate(); }}
          />
        ) : null}

        {a.canManage ? (
          <div className="newsarticle__admin">
            {a.status !== 'PUBLISHED' ? (
              <button type="button" className="btn btn--primary btn--sm"
                      disabled={publish.isPending} onClick={() => publish.mutate()}>
                Publish and notify everyone
              </button>
            ) : null}
            <button type="button" className="btn btn--sm btn--danger"
                    disabled={remove.isPending}
                    onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          </div>
        ) : null}
      </article>

      <section className="newscomments">
        <h2>Replies {a.comments.length ? `(${a.comments.length})` : ''}</h2>

        {!a.commentsEnabled ? (
          <p className="muted">Replies are turned off for this announcement.</p>
        ) : (
          <>
            <div className="newscomments__compose">
              <textarea
                className="input" rows={2} value={reply} maxLength={2000}
                placeholder="Say something" onChange={(e) => setReply(e.target.value)}
              />
              <button type="button" className="btn btn--primary btn--sm"
                      disabled={!reply.trim() || comment.isPending}
                      onClick={() => comment.mutate(reply)}>
                Reply
              </button>
            </div>
            {comment.isError ? <ErrorState error={comment.error} compact /> : null}
          </>
        )}

        <ul className="newscomments__list">
          {a.comments.map((c) => (
            <li key={c.id}>
              <div className="newscomments__head">
                <strong>{c.author.fullName}</strong>
                <span className="muted">{formatDate(c.createdAt)}</span>
                {c.canRemove ? (
                  <button type="button" className="linkbtn" onClick={() => removeComment.mutate(c.id)}>
                    Remove
                  </button>
                ) : null}
              </div>
              <p>{c.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- composer -- */

/**
 * Writing one.
 *
 * It creates a draft first and publishes as a separate step, which is not
 * ceremony: publishing notifies everybody, and a notice that rings fifty bells
 * the instant a title is typed would be published before its pictures are even
 * uploaded.
 */