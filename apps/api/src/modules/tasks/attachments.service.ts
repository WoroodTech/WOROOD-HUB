/**
 * Files on tickets and comments.
 *
 * The browser uploads straight to S3 with a presigned URL; the API never
 * carries the bytes in. That keeps a twenty-photo upload off the instance that
 * serves the portal, and off nginx's request limits. What the API does own is
 * every decision: who may upload, what the file really is, what is kept, and
 * who may see it.
 *
 *   1. ask    -> a row PENDING, and a five-minute URL for `incoming/<uuid>`
 *   2. upload -> browser to S3 directly
 *   3. confirm-> the API reads the object, checks its first bytes, compresses
 *                images, writes `files/` and `thumbs/`, deletes `incoming/`
 *
 * Nothing under `incoming/` is ever shown, and the bucket deletes it after a
 * day. Reading is a one-hour signed URL issued only after the same visibility
 * check that guards the ticket, so a link pasted outside stops working.
 */
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { Principal, can } from '../../common/auth';
import { config } from '../../common/config';
import { one, query, tx } from '../../common/db';
import { TASK_PERMISSIONS } from './permissions';
import { assertCan, loadWithAccess } from './visibility.service';
import { writeEvent } from './events';
import {
  ACCEPTED_TYPES, MAX_UPLOAD_BYTES, compressImage, sniff,
} from './attachment-files';

const PER_TICKET = 10;
const PER_COMMENT = 5;
const CLOSED = ['DONE', 'CANCELLED', 'REJECTED'];

export interface AttachmentView {
  id: string;
  kind: 'IMAGE' | 'PDF';
  name: string;
  bytes: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbUrl: string | null;
  commentId: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
  canDelete: boolean;
}

@Injectable()
export class AttachmentsService {
  private readonly log = new Logger('Attachments');
  private client: S3Client | null = null;

  private get s3(): S3Client {
    /* Built lazily, so a boot without a bucket never resolves the instance
       role, and a slow metadata service delays the first upload rather than
       every start. */
    if (!this.client) this.client = new S3Client({ region: config.attachments.region });
    return this.client;
  }

  private get bucket(): string {
    if (!config.attachments.bucket) {
      throw new ServiceUnavailableException(
        'Attachments are not set up on this server (S3_ATTACHMENTS_BUCKET is empty).');
    }
    return config.attachments.bucket;
  }

  /* -------------------------------------------------------------- upload -- */

  /**
   * Issue an upload URL.
   *
   * On the ticket itself only the person who raised it may attach, because the
   * files are part of the request. During the lifecycle files travel with a
   * comment, and only that comment's author may attach to it -- so a file is
   * always somebody's, said by somebody, at a point in the story.
   */
  async requestUpload(p: Principal, itemId: string, dto: {
    name: string; type: string; size: number; commentId?: string;
  }) {
    const bucket = this.bucket;
    const { item, access } = await loadWithAccess(p, itemId);

    if (CLOSED.includes(item.status)) {
      throw new ConflictException('This ticket is closed. Nothing more can be attached to it.');
    }
    if (!ACCEPTED_TYPES.includes(dto.type)) {
      throw new BadRequestException('Only JPEG, PNG and WebP images, and PDFs, can be attached.');
    }
    if (!Number.isFinite(dto.size) || dto.size <= 0 || dto.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Files can be up to 10 MB.');
    }

    if (dto.commentId) {
      const comment = await one<{ author_id: string }>(
        `SELECT author_id FROM tk_comments
          WHERE id = $1 AND item_id = $2 AND deleted_at IS NULL`, [dto.commentId, itemId]);
      if (!comment) throw new NotFoundException('That comment is not on this ticket.');
      if (comment.author_id !== p.id) {
        throw new ForbiddenException('Files can only be added to your own comment.');
      }
      const [n] = await query<{ n: string }>(
        `SELECT count(*) AS n FROM tk_attachments
          WHERE comment_id = $1 AND status <> 'DELETED'`, [dto.commentId]);
      if (Number(n.n) >= PER_COMMENT) {
        throw new ConflictException(`A comment can carry up to ${PER_COMMENT} files.`);
      }
    } else {
      /* Anybody who can comment can attach.
      
         This was the requester alone, on the reasoning that files on the ticket
         itself are part of the original request. In practice it meant a person
         with a photograph had to write a sentence they did not have in order to
         share it -- and a sentence invented to satisfy a form is worse than no
         sentence. The timeline records who added each file and when, so the
         story is kept either way. */
      assertCan(access, 'canComment', 'You can read this ticket but not add to it.');
      const [n] = await query<{ n: string }>(
        `SELECT count(*) AS n FROM tk_attachments
          WHERE item_id = $1 AND comment_id IS NULL AND status <> 'DELETED'`, [itemId]);
      if (Number(n.n) >= PER_TICKET) {
        throw new ConflictException(`A ticket can carry up to ${PER_TICKET} files.`);
      }
    }

    /* The key is a uuid and nothing else. The person's file name is stored as
       data and offered back as the download name; it never becomes part of a
       path, so no name can choose where anything is written. */
    const id = randomUUID();
    const incomingKey = `incoming/${id}`;
    const name = dto.name.replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 255) || 'file';

    await query(
      `INSERT INTO tk_attachments (id, item_id, comment_id, uploaded_by,
                                   original_name, declared_type, incoming_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, itemId, dto.commentId ?? null, p.id, name, dto.type, incomingKey]);

    /* Content-Type is signed, so the upload must declare what it was approved
       as. Size is not -- a presigned PUT cannot carry a range -- which is why
       confirmation checks it and why `incoming/` expires after a day: an
       oversized upload costs at most a day of storage and is never kept. */
    const uploadUrl = await getSignedUrl(this.s3,
      new PutObjectCommand({ Bucket: bucket, Key: incomingKey, ContentType: dto.type }),
      { expiresIn: 300 });

    return { attachmentId: id, uploadUrl, headers: { 'Content-Type': dto.type } };
  }

  /**
   * The upload has finished; decide what to keep.
   *
   * Nothing the browser said is trusted here. The size comes from S3, and the
   * type from the file's first bytes. A file that is not what it claims, or is
   * larger than allowed, is deleted and the row marked as such -- it never
   * becomes visible.
   */
  async confirm(p: Principal, attachmentId: string): Promise<AttachmentView> {
    const bucket = this.bucket;
    const row = await one<any>(`SELECT * FROM tk_attachments WHERE id = $1`, [attachmentId]);
    if (!row || row.uploaded_by !== p.id) throw new NotFoundException('No such upload.');
    if (row.status !== 'PENDING') throw new ConflictException('This upload was already handled.');

    const reject = async (message: string): Promise<never> => {
      await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.incoming_key }))
        .catch(() => undefined);
      await query(`UPDATE tk_attachments SET status='DELETED', deleted_at=now() WHERE id=$1`, [row.id]);
      throw new BadRequestException(message);
    };

    let size: number;
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: row.incoming_key }));
      size = Number(head.ContentLength ?? 0);
    } catch {
      throw new BadRequestException('The upload has not arrived. Try again.');
    }
    if (size <= 0 || size > MAX_UPLOAD_BYTES) return reject('Files can be up to 10 MB.');

    const obj = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: row.incoming_key }));
    const input = Buffer.from(await obj.Body!.transformToByteArray());

    const kind = sniff(input);
    if (!kind) return reject('That file is not a JPEG, PNG, WebP image or a PDF.');

    let fileKey: string; let thumbKey: string | null = null;
    let bytes: number; let width: number | null = null; let height: number | null = null;
    let contentType: string;

    if (kind === 'pdf') {
      /* PDFs are kept as they are. Nothing in Node compresses them well
         without installing Ghostscript on the server, and a PDF that has been
         re-written badly is worse than one that is a little larger. */
      fileKey = `files/${row.id}.pdf`;
      contentType = 'application/pdf';
      bytes = input.length;
      await this.s3.send(new PutObjectCommand({
        Bucket: bucket, Key: fileKey, Body: input, ContentType: contentType,
      }));
    } else {
      let out;
      try { out = await compressImage(input); }
      catch (e: any) {
        this.log.warn(`could not process ${row.id}: ${e?.message ?? e}`);
        return reject('That image could not be read. It may be damaged, or too large to open.');
      }
      fileKey = `files/${row.id}.webp`;
      thumbKey = `thumbs/${row.id}.webp`;
      contentType = 'image/webp';
      bytes = out.main.length; width = out.width; height = out.height;
      await this.s3.send(new PutObjectCommand({
        Bucket: bucket, Key: fileKey, Body: out.main, ContentType: contentType,
      }));
      await this.s3.send(new PutObjectCommand({
        Bucket: bucket, Key: thumbKey, Body: out.thumb, ContentType: contentType,
      }));
    }

    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.incoming_key }))
      .catch(() => undefined);

    await query(
      `UPDATE tk_attachments
          SET status='READY', kind=$2, file_key=$3, thumb_key=$4, content_type=$5,
              original_bytes=$6, bytes=$7, width=$8, height=$9, ready_at=now()
        WHERE id=$1`,
      [row.id, kind === 'pdf' ? 'PDF' : 'IMAGE', fileKey, thumbKey, contentType,
       size, bytes, width, height]);

    const [view] = await this.forItem(p, row.item_id, [row.id]);
    return view;
  }

  /* ---------------------------------------------------------------- read -- */

  /**
   * Every live attachment on a ticket, with links that work for an hour.
   *
   * Called from the ticket's own detail, after its visibility check -- so the
   * rule about who sees a file is the rule about who sees the ticket, written
   * once. Signing is local computation, not a call to AWS, so a ticket with
   * ten files costs nothing extra to open.
   */
  async forItem(p: Principal, itemId: string, onlyIds?: string[]): Promise<AttachmentView[]> {
    if (!config.attachments.bucket) return [];

    const rows = await query<any>(
      `SELECT a.*, u.full_name AS uploader_name, t.status AS ticket_status
         FROM tk_attachments a
         JOIN core_users u ON u.id = a.uploaded_by
         JOIN tk_items t   ON t.id = a.item_id
        WHERE a.item_id = $1 AND a.status = 'READY'
          AND ($2::uuid[] IS NULL OR a.id = ANY($2::uuid[]))
        ORDER BY a.created_at`, [itemId, onlyIds ?? null]);

    const admin = can(p, TASK_PERMISSIONS.MANAGE_ANY);
    const sign = (key: string, a: any, inline: boolean) => getSignedUrl(this.s3,
      new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        /* The person's own file name on download, encoded the way headers
           require so an Arabic name arrives as written. */
        ResponseContentDisposition:
          `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(
            a.kind === 'IMAGE' ? a.original_name.replace(/\.[^.]+$/, '') + '.webp' : a.original_name)}`,
      }), { expiresIn: 3600 });

    return Promise.all(rows.map(async (a) => ({
      id: a.id,
      kind: a.kind,
      name: a.original_name,
      bytes: a.bytes,
      width: a.width, height: a.height,
      url: await sign(a.file_key, a, true),
      thumbUrl: a.thumb_key ? await sign(a.thumb_key, a, true) : null,
      commentId: a.comment_id,
      uploadedBy: a.uploaded_by,
      uploadedByName: a.uploader_name,
      createdAt: new Date(a.created_at).toISOString(),
      /* The uploader may remove their own file while the ticket is open; once
         it is closed the files are the record and only an administrator can
         take one out -- for the case somebody attached a customer's details
         by mistake. */
      canDelete: admin || (a.uploaded_by === p.id && !CLOSED.includes(a.ticket_status)),
    })));
  }

  /* -------------------------------------------------------------- remove -- */

  /**
   * Take a file off a ticket.
   *
   * Never silent: the timeline records who removed what, the same way it
   * records the reason for a hold. The row stays, marked DELETED, so the
   * history still names the file; the bytes are deleted from S3, because
   * keeping them would make "removed" a lie.
   */
  async remove(p: Principal, attachmentId: string) {
    const row = await one<any>(
      `SELECT a.*, t.status AS ticket_status FROM tk_attachments a
         JOIN tk_items t ON t.id = a.item_id
        WHERE a.id = $1 AND a.status = 'READY'`, [attachmentId]);
    if (!row) throw new NotFoundException('That file is not there any more.');

    // Seeing the ticket is the first condition; this throws if they cannot.
    await loadWithAccess(p, row.item_id);

    const admin = can(p, TASK_PERMISSIONS.MANAGE_ANY);
    if (!admin && row.uploaded_by !== p.id) {
      throw new ForbiddenException('Only the person who added a file can remove it.');
    }
    if (!admin && CLOSED.includes(row.ticket_status)) {
      throw new ConflictException(
        'This ticket is closed, so its files are part of the record. An administrator can remove one if it was added by mistake.');
    }

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_attachments SET status='DELETED', deleted_at=now(), deleted_by=$2 WHERE id=$1`,
        [row.id, p.id]);
      await writeEvent(c, row.item_id, p.id, 'ATTACHMENT_REMOVED',
        { name: row.original_name, byAdmin: admin && row.uploaded_by !== p.id });
    });

    for (const key of [row.file_key, row.thumb_key].filter(Boolean)) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
        .catch((e) => this.log.warn(`could not delete ${key}: ${e?.message ?? e}`));
    }
    return { removed: true };
  }
}