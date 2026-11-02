/**
 * Writing a notice.
 *
 * One component, used by the reading page and by the manage screen, because
 * two copies of a form drift: one grows a field, the other does not, and the
 * difference is only found when somebody asks why a notice written from one
 * place behaves differently.
 *
 * It works in two steps, and the order is forced by how uploads work rather
 * than chosen. A picture needs somewhere to belong before it can be uploaded,
 * so the notice is saved as a draft first and the pictures are attached to it
 * afterwards. The bytes go straight to storage on a signed URL and never pass
 * through the API, which is what stops a dozen photographs from occupying a
 * request worker for as long as the upload takes.
 *
 * Nothing here publishes. A notice leaves this form as a draft, and putting it
 * on the board is a separate, deliberate act -- which is what makes it safe to
 * write one in pieces.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';
import type {
  Announcement, AnnouncementDetail, AnnouncementUploadTicket,
} from '../contract';

/**
 * How long a notice stays up.
 *
 * Asked as a span rather than an end date, because that is the question
 * somebody can answer without opening a calendar. It starts at a day: a
 * notice about today -- the lift is out, lunch is early -- is the shortest
 * real case, and without it somebody would pick a week and then have to
 * remember to take it down.
 */
const SPANS = [
  { days: 1, label: 'A day' },
  { days: 7, label: 'A week' },
  { days: 21, label: 'Three weeks' },
  { days: 90, label: 'A quarter' },
  { days: 0, label: 'Until taken down' },
];

/** What may be attached, as the server will also check it. */
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

export function NoticeComposer({ onSaved, onCancel }: {
  /** Called with the saved draft once there is nothing left to attach. */
  onSaved: (draft: Announcement) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [days, setDays] = useState(21);
  const [commentsEnabled, setComments] = useState(true);

  const [draft, setDraft] = useState<AnnouncementDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasTitle = !!title.trim();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api<Announcement>('/news', {
        method: 'POST',
        body: {
          title: title.trim(),
          body: body.trim() || undefined,
          /* Not pinned from here. Keeping something at the top is a decision
             about the board as a whole -- which notice outranks the others --
             and it is taken on the board screen where the others are visible,
             not while writing one in isolation. */
          days, commentsEnabled,
        },
      });
      const full = await api<AnnouncementDetail>(`/news/${created.id}`);
      setDraft(full);
    } catch (e: any) {
      setError(e?.message ?? 'The notice could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const addImages = async (files: FileList | null) => {
    if (!files?.length || !draft) return;
    setUploading(true);
    setError(null);
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
        /* Confirmed one at a time rather than at the end: a run that fails
           halfway leaves the pictures that did arrive attached, instead of
           losing all of them along with the one that broke. */
        await api(`/news/images/${ticket.imageId}/confirm`, { method: 'POST' });
      }
      setDraft(await api<AnnouncementDetail>(`/news/${draft.id}`));
    } catch (e: any) {
      setError(e?.message ?? 'The pictures could not be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  const removeImage = async (imageId: string) => {
    if (!draft) return;
    try {
      await api(`/news/images/${imageId}`, { method: 'DELETE' });
      setDraft(await api<AnnouncementDetail>(`/news/${draft.id}`));
    } catch (e: any) {
      setError(e?.message ?? 'That picture could not be removed.');
    }
  };

  /* ------------------------------------------------- step two: pictures -- */
  if (draft) {
    return (
      <div className="composer">
        <p className="composer__hint">
          Saved as a draft. Attach anything you want to go with it, then put it
          on the board from the notice board screen.
        </p>

        {draft.images.length ? (
          <div className="composer__gallery">
            {draft.images.map((f) => (
              <figure key={f.id} className="composer__shot">
                {/* A PDF has no thumbnail to show -- nothing renders a page
                    here -- so it appears as the document it is. */}
                {f.kind === 'document' ? (
                  <span className="composer__doc" title={f.name ?? 'Document'}>
                    <Icon name="receipt" size={20} />
                    <span className="composer__docname">{f.name ?? 'Document'}</span>
                  </span>
                ) : (
                  <img src={f.thumbUrl ?? f.url} alt={f.caption ?? ''} />
                )}
                <button type="button" className="linkbtn linkbtn--danger"
                        onClick={() => void removeImage(f.id)}>
                  Remove
                </button>
              </figure>
            ))}
          </div>
        ) : null}

        <label className="field">
          <span className="field__label">
            Pictures or documents <span className="field__opt">optional</span>
          </span>
          <input type="file" className="input" accept={ACCEPT} multiple
                 disabled={uploading}
                 onChange={(e) => void addImages(e.target.files)} />
          <span className="field__hint">JPEG, PNG, WebP or PDF. Up to 10 MB each.</span>
        </label>

        {uploading ? <p className="state">Uploading…</p> : null}
        {error ? <p className="state state--error">{error}</p> : null}

        <div className="composer__actions">
          <button type="button" className="btn btn--primary"
                  disabled={uploading} onClick={() => onSaved(draft)}>
            Done
          </button>
        </div>
      </div>
    );
  }

  /* -------------------------------------------------- step one: writing -- */
  /* One field per row. A notice is a short form read top to bottom, and
     side-by-side fields only pay for themselves when the two belong together
     -- which none of these do. */
  return (
    <div className="composer composer--stacked">
      <label className="field">
        <span className="field__label">Title</span>
        <input className="input input--lead" value={title} maxLength={200}
               autoFocus placeholder="What this is about"
               onChange={(e) => setTitle(e.target.value)} />
        <span className="field__count">{title.length}/200</span>
      </label>

      <label className="field">
        <span className="field__label">
          Description <span className="field__opt">optional</span>
        </span>
        <textarea className="input" rows={6} value={body} maxLength={8000}
                  placeholder="Anything people need to know."
                  onChange={(e) => setBody(e.target.value)} />
      </label>

      <label className="field">
        <span className="field__label">How long it stays up</span>
        <select className="input" value={days}
                onChange={(e) => setDays(Number(e.target.value))}>
          {SPANS.map((s) => (
            <option key={s.days} value={s.days}>{s.label}</option>
          ))}
        </select>
      </label>

      <label className="field field--check">
        <input type="checkbox" checked={commentsEnabled}
               onChange={(e) => setComments(e.target.checked)} />
        <span>Let people comment</span>
      </label>

      {error ? <p className="state state--error">{error}</p> : null}

      <div className="composer__actions">
        {onCancel ? (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="button" className="btn btn--primary"
                disabled={busy || !hasTitle} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}

/** The same form, in a dialog. */
export function NoticeComposerModal({ onSaved, onClose }: {
  onSaved: (draft: Announcement) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Write a notice">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel modal__panel--wide">
        <header className="modal__head">
          <h2>Write a notice</h2>
          <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}>
            <Icon name="minus" size={16} />
          </button>
        </header>
        <div className="modal__body">
          <NoticeComposer
            onSaved={(d) => { onSaved(d); onClose(); }}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}