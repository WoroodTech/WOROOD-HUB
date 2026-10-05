/**
 * Choosing files before they are sent, and showing them once they are.
 *
 * The picker holds files in the browser only. Nothing uploads until the ticket
 * or comment exists, because a file belongs to something and there is nothing
 * yet for it to belong to. Previews are local object URLs, so they appear
 * instantly and cost no request.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskAttachment } from '../contract';
import { api } from '../lib/api';
import { ACCEPT, precheck } from '../lib/upload';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';

const kb = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/* ---------------------------------------------------------------- picker -- */

export function AttachmentPicker({
  files, onChange, max,
}: { files: File[]; onChange: (f: File[]) => void; max: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  /* Object URLs are released when the files change or the picker goes away.
     Each one holds the whole file in memory until revoked. */
  const previews = useMemo(
    () => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)),
    [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);

  const add = (list: FileList | null) => {
    if (!list) return;
    const ok: File[] = []; const bad: string[] = [];
    for (const f of Array.from(list)) {
      const why = precheck(f);
      if (why) bad.push(why); else ok.push(f);
    }
    const room = max - files.length;
    if (ok.length > room) bad.push(`Only ${max} files fit here; the rest were left out.`);
    setProblems(bad);
    onChange([...files, ...ok.slice(0, Math.max(0, room))]);
  };

  return (
    <div className="apick">
      <div
        className={`apick__drop${over ? ' apick__drop--over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
        onClick={() => input.current?.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
      >
        <Icon name="plus" size={15} />
        <span>
          <strong>Add images or PDFs</strong>
          <span className="apick__sub"> — drop them here or click. Up to {max}, 10 MB each.</span>
        </span>
        {/* The accept list also makes iPhones send JPEG instead of HEIC: Safari
            converts on the way out when HEIC is not on the list. */}
        <input ref={input} type="file" multiple accept={ACCEPT} hidden
               onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      </div>

      {problems.length ? (
        <ul className="apick__problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      ) : null}

      {files.length ? (
        <ul className="apick__list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="apick__item">
              {previews[i]
                ? <img src={previews[i]!} alt="" className="apick__thumb" />
                : <span className="apick__thumb apick__thumb--pdf"><Icon name="receipt" size={16} /></span>}
              <span className="apick__name" title={f.name}>{f.name}</span>
              <span className="apick__size">{kb(f.size)}</span>
              <button type="button" className="apick__remove" aria-label={`Remove ${f.name}`}
                      onClick={() => onChange(files.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- gallery -- */

export function AttachmentGallery({ items }: { items: TaskAttachment[] }) {
  const [open, setOpen] = useState<TaskAttachment | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (id: string) => api(`/tasks/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setOpen(null);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: unknown) =>
      toast.push(e instanceof Error ? e.message : 'That file could not be removed.', 'warning'),
  });

  if (!items.length) return null;

  return (
    <>
      <ul className="agallery">
        {items.map((a) => (
          <li key={a.id}>
            {a.kind === 'IMAGE' ? (
              <button type="button" className="agallery__tile" onClick={() => setOpen(a)}
                      title={`${a.name} — ${kb(a.bytes)}, added by ${a.uploadedByName}`}>
                <img src={a.thumbUrl ?? a.url} alt={a.name} loading="lazy" />
              </button>
            ) : (
              /* A PDF opens in its own tab. It is served from S3's address, not
                 the portal's, so nothing inside it can reach a signed-in
                 session. */
              <a className="agallery__tile agallery__tile--pdf" href={a.url}
                 target="_blank" rel="noopener noreferrer"
                 title={`${a.name} — ${kb(a.bytes)}, added by ${a.uploadedByName}`}>
                <Icon name="receipt" size={20} />
                <span className="agallery__pdfname">{a.name}</span>
                <span className="agallery__pdfsize">PDF · {kb(a.bytes)}</span>
              </a>
            )}
            {a.canDelete ? (
              <button type="button" className="agallery__del" aria-label={`Remove ${a.name}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Remove ${a.name}? The ticket's history will say you removed it.`)) {
                          remove.mutate(a.id);
                        }
                      }}>
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {open ? (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={open.name}
             onClick={() => setOpen(null)}>
          <figure className="lightbox__fig" onClick={(e) => e.stopPropagation()}>
            <img src={open.url} alt={open.name} />
            <figcaption>
              <span>{open.name}</span>
              <span className="muted">{open.uploadedByName} · {kb(open.bytes)}</span>
              <a href={open.url} target="_blank" rel="noopener noreferrer" className="link">Open full size</a>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(null)}>Close</button>
            </figcaption>
          </figure>
        </div>
      ) : null}
    </>
  );
}