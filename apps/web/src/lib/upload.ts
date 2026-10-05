/**
 * Send one file to a ticket.
 *
 * Three steps, and the middle one deliberately does not go through `api()`:
 * the bytes go from the browser straight to S3 on a presigned URL, and adding
 * the portal's Authorization header to that request makes S3 refuse it — it
 * accepts one way of proving who you are, and the URL already is one.
 */
import type { TaskAttachment } from '../contract';
import { api } from './api';

export const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
export const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Checked before anything is sent, so a person learns about a 40 MB file or a
 * .docx immediately rather than after waiting for it to upload. The server
 * checks again and properly; this is courtesy, not security.
 */
export function precheck(file: File): string | null {
  if (!ACCEPT.split(',').includes(file.type)) {
    return `${file.name}: only JPEG, PNG and WebP images, and PDFs.`;
  }
  if (file.size > MAX_BYTES) {
    return `${file.name}: ${(file.size / 1024 / 1024).toFixed(1)} MB — files can be up to 10 MB.`;
  }
  return null;
}

export async function uploadAttachment(
  itemId: string, file: File, commentId?: string,
): Promise<TaskAttachment> {
  const grant = await api<{ attachmentId: string; uploadUrl: string; headers: Record<string, string> }>(
    `/tasks/${itemId}/attachments`,
    { method: 'POST', body: { name: file.name, type: file.type, size: file.size, commentId } });

  const put = await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.headers, body: file });
  if (!put.ok) {
    /* Almost always CORS or an expired URL. Said in words a person can act on
       rather than as the XML S3 returns. */
    throw new Error(`${file.name} could not be uploaded. Try again in a moment.`);
  }

  return api<TaskAttachment>(`/tasks/attachments/${grant.attachmentId}/confirm`, { method: 'POST' });
}

/**
 * Several files, after the ticket or comment they belong to exists.
 *
 * One at a time rather than all at once: the server compresses two images at a
 * time anyway, and a phone on a weak connection uploading ten photos in
 * parallel finishes none of them sooner. A failure does not stop the rest —
 * each file reports for itself.
 */
export async function uploadAll(itemId: string, files: File[], commentId?: string) {
  const failed: string[] = [];
  for (const f of files) {
    try { await uploadAttachment(itemId, f, commentId); }
    catch (e) { failed.push(e instanceof Error ? e.message : f.name); }
  }
  return failed;
}