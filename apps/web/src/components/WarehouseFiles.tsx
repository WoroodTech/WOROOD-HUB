/**
 * Files on a return issue or a movement.
 *
 * Three steps per file — ask for a URL, put the bytes straight into S3, tell
 * the API to look at what arrived. The bytes never pass through the API, and
 * every download link here was issued moments ago after a check of who is
 * asking.
 *
 * This replaces a text box asking for a Drive link. A link meant the picture
 * lived in somebody's own Drive, was readable by anybody who had the link,
 * and broke when that person left or tidied up — on a return dispute, which
 * is exactly when the photograph matters.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon } from './Icon';

export type FileSubject = 'return-issue' | 'movement';

interface WarehouseFile {
  id: string;
  name: string;
  bytes: number;
  contentType: string;
  url: string;
  thumbUrl: string | null;
  uploadedAt: string;
  canRemove: boolean;
}

interface UploadTicket {
  fileId: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

/** Exactly what the server accepts. Offering more lets somebody pick a file,
 *  watch it be refused after the fact, and see only its absence. */
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

export function WarehouseFiles({ kind, subjectId, canAttach = true }: {
  kind: FileSubject;
  /** The sheet's own identifier — an Issue ID, a patch number. */
  subjectId: string;
  canAttach?: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = ['wh', 'files', kind, subjectId];

  const files = useQuery({
    queryKey: key,
    queryFn: () => api<WarehouseFile[]>(
      `/warehouse/attachments/${kind}/${encodeURIComponent(subjectId)}`),
    enabled: !!subjectId,
  });

  const add = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(picked)) {
        const ticket = await api<UploadTicket>(
          `/warehouse/attachments/${kind}/${encodeURIComponent(subjectId)}`, {
            method: 'POST',
            body: { name: file.name, type: file.type, size: file.size },
          });
        const put = await fetch(ticket.uploadUrl, {
          method: 'PUT', headers: ticket.headers, body: file,
        });
        if (!put.ok) throw new Error(`${file.name} could not be uploaded.`);
        await api(`/warehouse/attachments/file/${ticket.fileId}/confirm`,
                  { method: 'POST' });
      }
      void qc.invalidateQueries({ queryKey: key });
    } catch (e: any) {
      /* With the reason. A refused type, a file too big and a network drop
         all looked identical as "could not be uploaded", and the only way to
         tell them apart was to try again and watch. */
      setError(e?.message ?? 'The file could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };

  const remove = useMutation({
    mutationFn: (fileId: string) =>
      api(`/warehouse/attachments/file/${fileId}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); },
    onError: (e: any) => setError(e?.message ?? 'That could not be removed.'),
  });

  const list = files.data ?? [];

  return (
    <div className="field">
      <span className="field__label">
        Photographs <span className="field__opt">what arrived, and its state</span>
      </span>

      {list.length ? (
        <ul className="filelist">
          {list.map((f) => (
            <li key={f.id} className="filelist__item">
              {f.thumbUrl ? (
                <a href={f.url} target="_blank" rel="noreferrer"
                   className="filelist__thumb">
                  <img src={f.thumbUrl} alt="" loading="lazy" />
                </a>
              ) : (
                <span className="filelist__thumb filelist__thumb--doc">PDF</span>
              )}
              <div className="filelist__meta">
                <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a>
                <span className="muted">
                  {f.bytes ? `${Math.round(f.bytes / 1024)} KB` : ''}
                </span>
              </div>
              {f.canRemove ? (
                <button type="button" className="linkbtn"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(f.id)}>
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

      {canAttach ? (
        <label className="btn btn--ghost btn--sm filelist__add">
          <Icon name="plus" size={13} /> {busy ? 'Uploading…' : 'Attach a photo'}
          <input type="file" hidden multiple disabled={busy}
                 accept={ACCEPT}
                 onChange={(e) => {
                   void add(e.target.files);
                   /* Cleared so the same file can be picked again. */
                   e.target.value = '';
                 }} />
        </label>
      ) : null}
    </div>
  );
}