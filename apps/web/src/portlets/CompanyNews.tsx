/**
 * The noticeboard, at the top of the home page.
 *
 * This replaces a chat room, and the difference is the point: a message is seen
 * by whoever was looking at the time, a board is seen by whoever walks past. So
 * it is wide, it is first, and it is the one portlet that does not wait to be
 * asked for.
 *
 * It moves on its own when there is more than one notice, because a board
 * showing only its first item is a board with the rest hidden. But automatic
 * movement is a nuisance the moment somebody is trying to read, so it stops on
 * hover, on focus, while a reply is being typed, when the tab is in the
 * background, and for anyone who has asked their system for less motion. The
 * dots are always there to take over by hand.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Announcement } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';

const ROTATE_MS = 7000;

/** Whichever language the notice was written in, preferring the reader's. */
export function pick(en: string | null, ar: string | null, lang: string): string | null {
  const wantsArabic = lang.startsWith('ar');
  return (wantsArabic ? ar || en : en || ar) ?? null;
}

export function CompanyNews({ title }: { title: string }) {
  const lang = document.documentElement.lang || 'en';
  const news = useQuery({
    queryKey: qk.news,
    queryFn: () => api<Announcement[]>('/news/live'),
    /* The signed picture URLs expire in an hour, so a tab left open all day
       would otherwise end up showing broken images. */
    staleTime: 30 * 60_000,
  });

  const items = useMemo(() => news.data ?? [], [news.data]);
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const region = useRef<HTMLDivElement>(null);

  // Clamp when the list shrinks under us -- an expired notice can do that.
  useEffect(() => { if (at >= items.length) setAt(0); }, [items.length, at]);

  const reducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  useEffect(() => {
    if (items.length < 2 || held || reducedMotion) return;
    const t = setInterval(() => {
      /* A background tab should not be silently cycling: it wastes nothing
         visible, but it means coming back to a board that has moved on from
         whatever was being read. */
      if (document.visibilityState !== 'visible') return;
      setAt((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [items.length, held, reducedMotion]);

  if (news.isLoading) return <Card title={title}><LoadingState label="Loading the news" /></Card>;
  if (news.isError) {
    return <Card title={title}><ErrorState error={news.error} onRetry={() => void news.refetch()} /></Card>;
  }
  if (!items.length) {
    return (
      <Card title={title}>
        <EmptyState
          icon="bell"
          title="Nothing just now"
          hint="Company news and events will appear here."
        />
      </Card>
    );
  }

  const current = items[Math.min(at, items.length - 1)];

  return (
    <Card
      title={title}
      actions={<Link className="btn btn--sm" to="/news">All news</Link>}
    >
      <div
        className="newsbanner"
        ref={region}
        /* Held while anybody is reading it, by any of the ways a person shows
           they are. */
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocusCapture={() => setHeld(true)}
        onBlurCapture={() => setHeld(false)}
        aria-roledescription="carousel"
        aria-label="Company news"
      >
        <NewsSlide item={current} lang={lang} />

        {items.length > 1 ? (
          <div className="newsbanner__nav">
            <button type="button" className="iconbtn iconbtn--ghost" aria-label="Previous"
                    onClick={() => setAt((i) => (i - 1 + items.length) % items.length)}>
              <Icon name="chevron-left" size={14} />
            </button>
            <div className="newsbanner__dots" role="tablist" aria-label="Choose an announcement">
              {items.map((it, i) => (
                <button
                  key={it.id}
                  type="button"
                  role="tab"
                  aria-selected={i === at}
                  aria-label={pick(it.title, it.titleAr, lang) ?? `Announcement ${i + 1}`}
                  className={`newsbanner__dot${i === at ? ' is-on' : ''}`}
                  onClick={() => { setAt(i); setHeld(true); }}
                />
              ))}
            </div>
            <button type="button" className="iconbtn iconbtn--ghost" aria-label="Next"
                    onClick={() => setAt((i) => (i + 1) % items.length)}>
              <Icon name="chevron-right" size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** One notice: its pictures, its words, and the way in. */
function NewsSlide({ item, lang }: { item: Announcement; lang: string }) {
  const title = pick(item.title, item.titleAr, lang);
  const body = pick(item.body, item.bodyAr, lang);

  /* A notice's own pictures rotate inside it rather than each becoming a slide
     of its own: five photographs of one event are one announcement, and
     spreading them across the banner would bury the four notices behind it. */
  const [shot, setShot] = useState(0);
  useEffect(() => { setShot(0); }, [item.id]);
  useEffect(() => {
    if (item.images.length < 2) return;
    const t = setInterval(() => setShot((i) => (i + 1) % item.images.length), 3500);
    return () => clearInterval(t);
  }, [item.id, item.images.length]);

  const image = item.images[shot];

  return (
    <article className={`newsslide${image ? '' : ' newsslide--textonly'}`}>
      {image ? (
        <div className="newsslide__media">
          <img
            src={image.url}
            alt={pick(image.caption, image.captionAr, lang) ?? ''}
            loading="lazy"
          />
          {item.images.length > 1 ? (
            <span className="newsslide__count">{shot + 1}/{item.images.length}</span>
          ) : null}
        </div>
      ) : null}

      <div className="newsslide__text">
        <div className="newsslide__meta">
          {item.pinned ? <span className="idtag"><Icon name="check" size={11} /> Pinned</span> : null}
          <span className="muted">{formatDate(item.publishAt)} · {item.author.fullName}</span>
        </div>
        <h3 className="newsslide__title">
          <Link to={`/news/${item.id}`}>{title}</Link>
        </h3>
        {body ? <p className="newsslide__body">{body}</p> : null}
        <div className="newsslide__actions">
          <Link className="btn btn--sm" to={`/news/${item.id}`}>
            {item.commentsEnabled && item.commentCount
              ? `Read and reply (${item.commentCount})`
              : 'Read more'}
          </Link>
        </div>
      </div>
    </article>
  );
}