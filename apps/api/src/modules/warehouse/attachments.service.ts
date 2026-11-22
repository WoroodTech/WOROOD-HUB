/**
 * Files attached to warehouse work.
 *
 * A return and a return issue both want a photograph — what arrived, what
 * state it was in. The Apps Script asked for a Drive link pasted into a text
 * box, so the picture lived in somebody's own Drive, was readable by anybody
 * holding the link, and broke when that person left or tidied up.
 *
 * Three steps per file, the same three Finance uses: ask for a URL, put the
 * bytes straight into S3, tell the API to look at what arrived. The bytes
 * never pass through the API, and every download link is issued moments
 * before it is used, after a check of who is asking.
 */
import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { one, query } from '../../common/db';
import { Principal, can } from '../../common/auth';
import { ObjectStoreService } from '../../core/object-store.service';
import {
  ACCEPTED_TYPES, MAX_UPLOAD_BYTES, compressImage, sniff,
} from '../../core/upload-files';

/** What a file can belong to. The sheet holds the subject, not this table. */
export type SubjectKind = 'RETURN_ISSUE' | 'MOVEMENT';

/**
 * Enough for the photographs a return actually needs, few enough that one
 * person cannot fill the bucket from a phone in an afternoon.
 */
const MAX_FILES = 6;

@Injectable()
export class WarehouseAttachmentsService {
  constructor(private readonly store: ObjectStoreService) {}

  /**
   * Who may attach to this kind of subject.
   *
   * Reading is open to anybody who can see warehouse stock — a photograph of
   * a damaged return is not more sensitive than the movement it belongs to.
   * Writing follows the work: logging an issue and posting a movement are
   * each their own permission, and attaching to one is part of doing it.
   */
  private mayWrite(p: Principal, kind: SubjectKind): boolean {
    /* Named rather than imported: the permission table lives in the module
       that also imports this service, and pointing them at each other would
       be a cycle for two strings. */
    return kind === 'RETURN_ISSUE'
      ? can(p, 'warehouse.returns.handle')
      : can(p, 'warehouse.tx.write');
  }

  /** Every live file on one subject, with links that expire. */
  async list(p: Principal, kind: SubjectKind, subjectId: string) {
    const rows = await query<any>(
      `SELECT * FROM wh_attachments
        WHERE subject_kind = $1 AND subject_id = $2
          AND status = 'READY' AND deleted_at IS NULL
        ORDER BY created_at`, [kind, subjectId]);

    return Promise.all(rows.map(async (f) => ({
      id: f.id,
      name: f.original_name,
      bytes: Number(f.bytes ?? 0),
      contentType: f.content_type,
      /* Ten minutes: long enough to open, short enough that a link copied
         out of the page is useless by the time it is pasted anywhere. */
      url: await this.store.presignDownload(f.file_key, 600, f.original_name),
      thumbUrl: f.thumb_key
        ? await this.store.presignDownload(f.thumb_key, 600) : null,
      uploadedAt: f.ready_at,
      /* Whoever attached it may take it off again; nobody else, so a
         photograph cannot quietly disappear from somebody's issue. */
      canRemove: f.uploaded_by === p.id,
    })));
  }

  /** A URL to put the bytes at, and a row waiting for them. */
  async requestUpload(
    p: Principal, kind: SubjectKind, subjectId: string,
    dto: { name: string; type: string; size: number },
  ) {
    if (!this.mayWrite(p, kind)) {
      throw new ForbiddenException('You cannot attach files here.');
    }
    if (!subjectId.trim()) {
      throw new BadRequestException('There is nothing to attach this to.');
    }
    if (!ACCEPTED_TYPES.includes(dto.type)) {
      throw new BadRequestException('Files must be JPEG, PNG, WebP or PDF.');
    }
    if (dto.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Files can be up to 10 MB.');
    }

    const count = await one<any>(
      `SELECT count(*) AS n FROM wh_attachments
        WHERE subject_kind = $1 AND subject_id = $2
          AND status <> 'DELETED' AND deleted_at IS NULL`, [kind, subjectId]);
    if (Number(count?.n ?? 0) >= MAX_FILES) {
      throw new BadRequestException(`Up to ${MAX_FILES} files here.`);
    }

    const fileId = randomUUID();
    const incomingKey = `incoming/${fileId}`;
    await query(
      `INSERT INTO wh_attachments
         (id, subject_kind, subject_id, status, incoming_key,
          original_name, uploaded_by)
       VALUES ($1,$2,$3,'PENDING',$4,$5,$6)`,
      [fileId, kind, subjectId, incomingKey, dto.name.slice(0, 200), p.id]);

    return {
      fileId,
      uploadUrl: await this.store.presignUpload(incomingKey, dto.type, 300),
      headers: { 'Content-Type': dto.type },
    };
  }

  /**
   * The bytes have arrived; decide whether to keep them.
   *
   * The type comes from the file's own first bytes, not from what the
   * browser said it was uploading. A PDF renamed to .jpg is refused here
   * rather than becoming a broken image on the page.
   */
  async confirm(p: Principal, fileId: string) {
    const row = await one<any>(
      `SELECT * FROM wh_attachments WHERE id=$1`, [fileId]);
    if (!row || row.status !== 'PENDING') {
      throw new NotFoundException('No such upload.');
    }
    if (!this.mayWrite(p, row.subject_kind)) {
      throw new ForbiddenException('You cannot attach files here.');
    }

    const reject = async (message: string): Promise<never> => {
      await this.store.remove(row.incoming_key);
      await query(`UPDATE wh_attachments SET status='DELETED', deleted_at=now()
                    WHERE id=$1`, [fileId]);
      throw new BadRequestException(message);
    };

    const head = await this.store.head(row.incoming_key);
    if (!head) throw new BadRequestException('The upload has not arrived. Try again.');
    if (head.size <= 0 || head.size > MAX_UPLOAD_BYTES) {
      return reject('Files can be up to 10 MB.');
    }

    const input = await this.store.read(row.incoming_key);
    const kind = sniff(input);
    if (!kind) return reject('That file is not a JPEG, PNG, WebP or PDF.');

    if (kind === 'pdf') {
      /* Kept exactly as it was sent: a delivery note is evidence, and
         re-encoding one would be changing it. */
      const fileKey = `warehouse/${fileId}.pdf`;
      await this.store.put(fileKey, input, 'application/pdf');
      await this.store.remove(row.incoming_key);
      await query(
        `UPDATE wh_attachments
            SET status='READY', file_key=$2, content_type='application/pdf',
                bytes=$3, incoming_key=NULL, ready_at=now()
          WHERE id=$1`, [fileId, fileKey, input.length]);
      return { id: fileId, ready: true };
    }

    /* A photograph off a phone is several megabytes of detail nobody needs
       to see whether a scarf is torn. */
    const out = await compressImage(input);
    const fileKey = `warehouse/${fileId}.webp`;
    const thumbKey = `warehouse/${fileId}.thumb.webp`;
    await this.store.put(fileKey, out.main, 'image/webp');
    if (out.thumb) await this.store.put(thumbKey, out.thumb, 'image/webp');
    await this.store.remove(row.incoming_key);

    await query(
      `UPDATE wh_attachments
          SET status='READY', file_key=$2, thumb_key=$3, content_type='image/webp',
              bytes=$4, width=$5, height=$6, incoming_key=NULL, ready_at=now()
        WHERE id=$1`,
      [fileId, fileKey, out.thumb ? thumbKey : null,
       out.main.length, out.width, out.height]);

    return { id: fileId, ready: true };
  }

  /**
   * Take a file off.
   *
   * Marked deleted rather than erased, and the object goes. The row stays so
   * that a file that was once on an issue leaves a trace — an attachment
   * quietly vanishing from a dispute is worse than one that is plainly gone.
   */
  async remove(p: Principal, fileId: string) {
    const row = await one<any>(
      `SELECT * FROM wh_attachments WHERE id=$1 AND deleted_at IS NULL`,
      [fileId]);
    if (!row) throw new NotFoundException('No such file.');
    if (row.uploaded_by !== p.id) {
      throw new ForbiddenException('Only whoever attached it can take it off.');
    }

    for (const key of [row.file_key, row.thumb_key, row.incoming_key]) {
      if (key) await this.store.remove(key).catch(() => undefined);
    }
    await query(
      `UPDATE wh_attachments
          SET status='DELETED', deleted_at=now(),
              file_key=NULL, thumb_key=NULL, incoming_key=NULL
        WHERE id=$1`, [fileId]);

    return { ok: true };
  }
}