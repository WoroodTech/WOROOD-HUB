/**
 * Files attached to a request: quotations, invoices, photographs of what is
 * needed, and later the receipts that prove money went out.
 *
 * The legacy app keeps these in one Google Drive folder shared by link, and
 * the check on who may download is the department tab the request sits in.
 * Four departments share the Purchases tab, so an Office member can download a
 * Purchases receipt -- and a receipt carries bank details. That is the hole
 * this closes: every download here is a short-lived signed URL issued after a
 * server-side check of who is asking.
 *
 * The upload is the same two-step the announcements use. A row is created, the
 * browser puts the bytes straight into S3, and only then does the API look at
 * what actually arrived -- size from S3, type from the file's own first bytes.
 * Nothing the browser claimed is believed.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Principal, can } from '../../common/auth';
import { one, query } from '../../common/db';
import { ObjectStoreService } from '../../core/object-store.service';
import {
  ACCEPTED_TYPES, MAX_UPLOAD_BYTES, compressImage, sniff,
} from '../../core/upload-files';

const MANAGE = 'finance.request.manage';
const REPORT = 'finance.report.view';
const PURCHASES = 'finance.purchases.decide';

/** Enough for a quotation and the photographs that go with it. */
const MAX_FILES = 10;

@Injectable()
export class FinanceFilesService {
  private readonly log = new Logger('FinanceFiles');

  constructor(private readonly store: ObjectStoreService) {}

  /**
   * Who may see a request's files at all.
   *
   * Narrower than who may see the request. A quotation names a supplier and a
   * receipt carries bank details, so a colleague who may see that a request
   * exists has no business opening its attachments: the author, the people
   * deciding it, and Finance.
   *
   * Deliberately NOT "anyone in the same department", which is the legacy
   * rule and the one that leaks across the four departments sharing a tab.
   */
  private async access(p: Principal, requestId: string) {
    const r = await one<any>(
      `SELECT r.*, f.lite AS department_is_lite
         FROM fin_requests r
         LEFT JOIN fin_departments f ON f.department_id = r.department_id
        WHERE r.id = $1 AND r.deleted_at IS NULL`, [requestId]);
    if (!r) throw new NotFoundException('No such request.');

    const own = r.requester_id === p.id;
    const managesIt = (p.managedDepartmentIds ?? []).includes(r.department_id);
    const financeEyes = can(p, MANAGE) || can(p, REPORT) || can(p, PURCHASES);

    if (!own && !managesIt && !financeEyes) {
      throw new NotFoundException('No such request.');
    }
    /* Uploading is the author's while the request is still being decided, and
       Purchases' when it is pricing one. Finance may attach at any point. */
    const mayUpload = own || can(p, MANAGE) || can(p, PURCHASES);
    return { request: r, mayUpload };
  }

  async list(p: Principal, requestId: string) {
    await this.access(p, requestId);
    const rows = await query<any>(
      `SELECT id, kind, original_name, content_type, bytes, width, height,
              file_key, thumb_key, created_at, uploaded_by
         FROM fin_request_files
        WHERE request_id = $1 AND status = 'READY' AND deleted_at IS NULL
        ORDER BY created_at`, [requestId]);

    return Promise.all(rows.map(async (f) => ({
      id: f.id,
      kind: f.kind,
      name: f.original_name,
      contentType: f.content_type,
      bytes: f.bytes === null ? null : Number(f.bytes),
      width: f.width, height: f.height,
      /* Short-lived and issued now, after the check above. Nothing is stored
         that would let the URL be shared usefully. */
      url: await this.store.presignDownload(f.file_key, 600,
        `inline; filename*=UTF-8''${encodeURIComponent(f.original_name ?? 'file')}`),
      thumbUrl: f.thumb_key ? await this.store.presignDownload(f.thumb_key, 600) : null,
      uploadedAt: new Date(f.created_at).toISOString(),
      canRemove: f.uploaded_by === p.id || can(p, MANAGE),
    })));
  }

  async requestUpload(
    p: Principal, requestId: string,
    dto: { name: string; type: string; size: number; kind?: 'ATTACHMENT' | 'RECEIPT' },
  ) {
    const { mayUpload } = await this.access(p, requestId);
    if (!mayUpload) throw new ForbiddenException('You cannot attach files to this request.');

    /* A receipt is proof that money went out, so only the people who record
       payments may attach one. The column exists from phase 2 so that the two
       kinds never end up in separate tables with separate rules. */
    const kind = dto.kind ?? 'ATTACHMENT';
    if (kind === 'RECEIPT' && !can(p, MANAGE)) {
      throw new ForbiddenException('Only Finance can attach a receipt.');
    }

    if (!ACCEPTED_TYPES.includes(dto.type)) {
      throw new BadRequestException('Files must be JPEG, PNG, WebP or PDF.');
    }
    if (dto.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Files can be up to 10 MB.');
    }

    const count = await one<any>(
      `SELECT count(*) AS n FROM fin_request_files
        WHERE request_id = $1 AND status <> 'DELETED' AND deleted_at IS NULL`, [requestId]);
    if (Number(count?.n ?? 0) >= MAX_FILES) {
      throw new BadRequestException(`A request can carry up to ${MAX_FILES} files.`);
    }

    const fileId = randomUUID();
    const incomingKey = `incoming/${fileId}`;
    await query(
      `INSERT INTO fin_request_files
         (id, request_id, kind, status, incoming_key, original_name, uploaded_by)
       VALUES ($1,$2,$3,'PENDING',$4,$5,$6)`,
      [fileId, requestId, kind, incomingKey, dto.name.slice(0, 200), p.id]);

    return {
      fileId,
      uploadUrl: await this.store.presignUpload(incomingKey, dto.type, 300),
      headers: { 'Content-Type': dto.type },
    };
  }

  /**
   * The bytes have arrived; decide whether to keep them.
   *
   * The type comes from the file's own first bytes, not from what the browser
   * said it was uploading. A PDF renamed to .jpg is refused here rather than
   * becoming a broken image on the request.
   */
  async confirm(p: Principal, fileId: string) {
    const row = await one<any>(`SELECT * FROM fin_request_files WHERE id=$1`, [fileId]);
    if (!row || row.status !== 'PENDING') throw new NotFoundException('No such upload.');
    const { mayUpload } = await this.access(p, row.request_id);
    if (!mayUpload) throw new ForbiddenException('You cannot attach files to this request.');

    const reject = async (message: string): Promise<never> => {
      await this.store.remove(row.incoming_key);
      await query(`UPDATE fin_request_files SET status='DELETED', deleted_at=now()
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
      /* A PDF is kept as it is: a quotation has to arrive exactly as it was
         sent, and re-encoding one would be changing evidence. */
      const fileKey = `finance/${fileId}.pdf`;
      await this.store.put(fileKey, input, 'application/pdf');
      await this.store.remove(row.incoming_key);
      await query(
        `UPDATE fin_request_files
            SET status='READY', file_key=$2, content_type='application/pdf',
                bytes=$3, incoming_key=NULL, ready_at=now()
          WHERE id=$1`, [fileId, fileKey, input.length]);
      return { id: fileId, ready: true };
    }

    const out = await compressImage(input);
    const fileKey = `finance/${fileId}.webp`;
    const thumbKey = `finance/${fileId}.thumb.webp`;
    await this.store.put(fileKey, out.main, 'image/webp');
    if (out.thumb) await this.store.put(thumbKey, out.thumb, 'image/webp');
    await this.store.remove(row.incoming_key);

    await query(
      `UPDATE fin_request_files
          SET status='READY', file_key=$2, thumb_key=$3, content_type='image/webp',
              bytes=$4, width=$5, height=$6, incoming_key=NULL, ready_at=now()
        WHERE id=$1`,
      [fileId, fileKey, out.thumb ? thumbKey : null, out.main.length, out.width, out.height]);

    return { id: fileId, ready: true };
  }

  async remove(p: Principal, fileId: string) {
    const row = await one<any>(
      `SELECT * FROM fin_request_files WHERE id=$1 AND deleted_at IS NULL`, [fileId]);
    if (!row) throw new NotFoundException('No such file.');
    await this.access(p, row.request_id);

    if (row.uploaded_by !== p.id && !can(p, MANAGE)) {
      throw new ForbiddenException('You can only remove files you attached.');
    }
    await query(
      `UPDATE fin_request_files SET status='DELETED', deleted_at=now() WHERE id=$1`, [fileId]);
    for (const key of [row.file_key, row.thumb_key, row.incoming_key].filter(Boolean)) {
      await this.store.remove(key);
    }
    return { removed: true };
  }
}