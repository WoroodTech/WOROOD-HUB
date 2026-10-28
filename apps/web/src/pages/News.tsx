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
  Announcement, AnnouncementDetail, AnnouncementsResponse, AnnouncementUploadTicket,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
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

      {composing ? <Composer onDone={() => setComposing(false)} /> : null}

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

        {a.images.length ? (
          <div className="newsarticle__gallery">
            {a.images.map((im) => (
              <figure key={im.id}>
                <img src={im.url} alt={pick(im.caption, im.captionAr, lang()) ?? ''} loading="lazy" />
                {pick(im.caption, im.captionAr, lang())
                  ? <figcaption>{pick(im.caption, im.captionAr, lang())}</figcaption> : null}
              </figure>
            ))}
          </div>
        ) : null}

        {body ? <div className="newsarticle__body">{body}</div> : null}

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
                    onClick={() => { if (confirm('Delete this announcement?')) remove.mutate(); }}>
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
function Composer({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [titleAr, setTitleAr] = useState('');
  const [body, setBody] = useState('');
  const [bodyAr, setBodyAr] = useState('');
  const [days, setDays] = useState(21);
  const [pinned, setPinned] = useState(false);
  const [commentsEnabled, setComments] = useState(true);
  const [draft, setDraft] = useState<Announcement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<Announcement>('/news', {
      method: 'POST',
      body: {
        title: title || undefined, titleAr: titleAr || undefined,
        body: body || undefined, bodyAr: bodyAr || undefined,
        days, pinned, commentsEnabled,
      },
    }),
    onSuccess: (a) => setDraft(a),
  });

  const publish = useMutation({
    mutationFn: () => api(`/news/${draft!.id}/publish`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.news });
      void qc.invalidateQueries({ queryKey: ['news', 'list'] });
      onDone();
    },
  });

  /**
   * Three steps per picture: ask for a URL, put the bytes straight into S3, and
   * tell the API to look at what arrived. The bytes never pass through the API,
   * which is what keeps a dozen photographs from occupying a request worker for
   * as long as the upload takes.
   */
  const addImages = async (files: FileList | null) => {
    if (!files?.length || !draft) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        const ticket = await api<AnnouncementUploadTicket>(`/news/${draft.id}/images`, {
          method: 'POST',
          body: { name: file.name, type: file.type, size: file.size },
        });
        const put = await fetch(ticket.uploadUrl, {
          method: 'PUT', headers: ticket.headers, body: file,
        });
        if (!put.ok) throw new Error(`${file.name} could not be uploaded.`);
        await api(`/news/images/${ticket.imageId}/confirm`, { method: 'POST' });
      }
      const fresh = await api<AnnouncementDetail>(`/news/${draft.id}`);
      setDraft(fresh);
    } catch (e: any) {
      setUploadError(e?.message ?? 'The pictures could not be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card title={draft ? 'Add pictures, then publish' : 'Write an announcement'}>
      {!draft ? (
        <div className="composer">
          <div className="composer__row">
            <label className="field">
              <span>Title (English)</span>
              <input className="input" value={title} maxLength={200}
                     onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span>العنوان (عربي)</span>
              <input className="input" dir="rtl" value={titleAr} maxLength={200}
                     onChange={(e) => setTitleAr(e.target.value)} />
            </label>
          </div>
          <p className="muted composer__hint">
            One language is enough — fill in whichever this notice is written in.
          </p>

          <div className="composer__row">
            <label className="field">
              <span>Details (English)</span>
              <textarea className="input" rows={4} value={body} maxLength={8000}
                        onChange={(e) => setBody(e.target.value)} />
            </label>
            <label className="field">
              <span>التفاصيل (عربي)</span>
              <textarea className="input" dir="rtl" rows={4} value={bodyAr} maxLength={8000}
                        onChange={(e) => setBodyAr(e.target.value)} />
            </label>
          </div>

          <div className="composer__row">
            <label className="field">
              <span>Stay on the home page for</span>
              <select className="input" value={days}
                      onChange={(e) => setDays(Number(e.target.value))}>
                <option value={7}>a week</option>
                <option value={14}>two weeks</option>
                <option value={21}>three weeks</option>
                <option value={30}>a month</option>
                <option value={92}>a quarter</option>
                {/* The quarterly awards want this one far more often than a date. */}
                <option value={0}>until I take it down</option>
              </select>
            </label>
            <label className="field field--check">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <span>Show before everything else</span>
            </label>
            <label className="field field--check">
              <input type="checkbox" checked={commentsEnabled}
                     onChange={(e) => setComments(e.target.checked)} />
              <span>Allow replies</span>
            </label>
          </div>

          {create.isError ? <ErrorState error={create.error} compact /> : null}

          <div className="composer__actions">
            <button type="button" className="btn" onClick={onDone}>Cancel</button>
            <button type="button" className="btn btn--primary"
                    disabled={(!title.trim() && !titleAr.trim()) || create.isPending}
                    onClick={() => create.mutate()}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="composer">
          <p className="muted">
            Saved as a draft. Nobody has been notified yet — add the pictures, then publish.
          </p>

          <div className="composer__gallery">
            {draft.images.map((im) => (
              <img key={im.id} src={im.thumbUrl ?? im.url} alt="" />
            ))}
          </div>

          <label className="btn btn--sm">
            <Icon name="plus" size={13} /> {uploading ? 'Uploading…' : 'Add pictures'}
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden
                   disabled={uploading} onChange={(e) => void addImages(e.target.files)} />
          </label>
          {uploadError ? <p className="state state--error">{uploadError}</p> : null}
          {publish.isError ? <ErrorState error={publish.error} compact /> : null}

          <div className="composer__actions">
            <button type="button" className="btn" onClick={onDone}>Leave as draft</button>
            <button type="button" className="btn btn--primary"
                    disabled={publish.isPending || uploading}
                    onClick={() => publish.mutate()}>
              Publish and notify everyone
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}