/**
 * Company news, and the comments underneath it.
 *
 * The rule running through all of this: reading is for everybody, writing is
 * for whoever holds `announcements.manage`, and a comment belongs to the person
 * who wrote it. There is no per-department visibility and deliberately so --
 * this is the noticeboard in the corridor, and a noticeboard only works because
 * everyone walks past the same one.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Principal, can } from '../../common/auth';
import { one, query, tx } from '../../common/db';
import { ObjectStoreService } from '../../core/object-store.service';
import { NotificationsService } from '../../core/core.module';
import {
  ACCEPTED_TYPES, MAX_UPLOAD_BYTES, compressImage, sniff,
} from '../../core/upload-files';

const MANAGE = 'announcements.manage';
const MAX_IMAGES = 12;

/** How long a notice stays up when nobody says otherwise. Long enough for a
 *  fortnight's leave not to miss it, short enough that the board is current. */
const DEFAULT_DAYS = 21;

@Injectable()
export class AnnouncementsService {
  private readonly log = new Logger('Announcements');

  constructor(
    private readonly store: ObjectStoreService,
    private readonly notifications: NotificationsService,
  ) {}

  private assertManager(p: Principal) {
    if (!can(p, MANAGE)) {
      throw new ForbiddenException('Only the people who look after company news can do that.');
    }
  }

  /* --------------------------------------------------------------- reading */

  /**
   * What belongs on the home page right now.
   *
   * Live means published, started, and not yet expired -- evaluated in the
   * database against now() rather than filtered afterwards, so a notice that
   * runs out while somebody has the page open disappears on their next load
   * instead of lingering until a cache somewhere gives up.
   */
  async live(p: Principal, limit = 8) {
    const rows = await query<any>(
      `SELECT a.*, u.full_name AS author_name
         FROM hr_announcements a
         JOIN core_users u ON u.id = a.author_id
        WHERE a.status = 'PUBLISHED'
          AND a.deleted_at IS NULL
          AND a.publish_at <= now()
          AND (a.expires_at IS NULL OR a.expires_at > now())
        ORDER BY a.pinned DESC, a.publish_at DESC
        LIMIT $1`, [Math.min(Math.max(limit, 1), 20)]);
    return Promise.all(rows.map((r) => this.view(p, r)));
  }

  /**
   * The archive: everything, newest first.
   *
   * Managers see drafts and expired notices as well, because they are the
   * people who need to find the one from last quarter and put it back up.
   */
  async list(p: Principal, { limit = 20, offset = 0 } = {}) {
    const manager = can(p, MANAGE);
    const rows = await query<any>(
      `SELECT a.*, u.full_name AS author_name
         FROM hr_announcements a
         JOIN core_users u ON u.id = a.author_id
        WHERE a.deleted_at IS NULL
          AND ($3::boolean OR (a.status = 'PUBLISHED' AND a.publish_at <= now()))
        ORDER BY a.publish_at DESC
        LIMIT $1 OFFSET $2`,
      [Math.min(Math.max(limit, 1), 50), Math.max(offset, 0), manager]);

    const total = await one<any>(
      `SELECT count(*) AS n FROM hr_announcements
        WHERE deleted_at IS NULL
          AND ($1::boolean OR (status = 'PUBLISHED' AND publish_at <= now()))`, [manager]);

    return {
      announcements: await Promise.all(rows.map((r) => this.view(p, r))),
      total: Number(total?.n ?? 0),
    };
  }

  async get(p: Principal, id: string) {
    const row = await one<any>(
      `SELECT a.*, u.full_name AS author_name
         FROM hr_announcements a JOIN core_users u ON u.id = a.author_id
        WHERE a.id = $1 AND a.deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('No such announcement.');

    const visible = row.status === 'PUBLISHED' && new Date(row.publish_at) <= new Date();
    if (!visible && !can(p, MANAGE)) throw new NotFoundException('No such announcement.');

    return { ...(await this.view(p, row)), comments: await this.comments(p, id) };
  }

  /** The shape the portal reads, with signed URLs for the pictures. */
  private async view(p: Principal, row: any) {
    const images = await query<any>(
      `SELECT id, file_key, thumb_key, content_type, width, height, caption, caption_ar
         FROM hr_announcement_images
        WHERE announcement_id = $1 AND status = 'READY' AND deleted_at IS NULL
        ORDER BY position, created_at`, [row.id]);

    const commentCount = await one<any>(
      `SELECT count(*) AS n FROM hr_announcement_comments
        WHERE announcement_id = $1 AND deleted_at IS NULL`, [row.id]);

    return {
      id: row.id,
      title: row.title, titleAr: row.title_ar,
      body: row.body, bodyAr: row.body_ar,
      status: row.status,
      publishAt: new Date(row.publish_at).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      pinned: row.pinned,
      commentsEnabled: row.comments_enabled,
      commentCount: Number(commentCount?.n ?? 0),
      author: { id: row.author_id, fullName: row.author_name },
      createdAt: new Date(row.created_at).toISOString(),
      canManage: can(p, MANAGE),
      images: await Promise.all(images.map(async (im) => ({
        id: im.id,
        url: await this.store.presignDownload(im.file_key, 3600),
        thumbUrl: im.thumb_key ? await this.store.presignDownload(im.thumb_key, 3600) : null,
        width: im.width, height: im.height,
        caption: im.caption, captionAr: im.caption_ar,
      }))),
    };
  }

  /* --------------------------------------------------------------- writing */

  async create(p: Principal, dto: {
    title?: string; titleAr?: string; body?: string; bodyAr?: string;
    publishAt?: string; expiresAt?: string; days?: number;
    pinned?: boolean; commentsEnabled?: boolean;
  }) {
    this.assertManager(p);
    if (!dto.title && !dto.titleAr) {
      throw new BadRequestException('An announcement needs a title, in Arabic or English.');
    }

    const publishAt = dto.publishAt ? new Date(dto.publishAt) : new Date();
    const expiresAt = this.resolveExpiry(publishAt, dto);

    const row = await one<any>(
      `INSERT INTO hr_announcements
         (title, title_ar, body, body_ar, status, publish_at, expires_at,
          pinned, comments_enabled, author_id)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9) RETURNING *`,
      [dto.title ?? null, dto.titleAr ?? null, dto.body ?? null, dto.bodyAr ?? null,
       publishAt, expiresAt, dto.pinned ?? false, dto.commentsEnabled ?? true, p.id]);

    return this.view(p, { ...row, author_name: p.fullName });
  }

  /**
   * How long it stays up.
   *
   * `days` is what the form actually asks -- "how long should this stay on the
   * home page" is a question somebody can answer; "what instant should it stop
   * being shown" is not. An explicit `expiresAt` still wins when one is given,
   * and `days: 0` means it stays until taken down by hand.
   */
  private resolveExpiry(publishAt: Date, dto: { expiresAt?: string; days?: number }): Date | null {
    if (dto.expiresAt) {
      const at = new Date(dto.expiresAt);
      if (at <= publishAt) {
        throw new BadRequestException('An announcement cannot stop showing before it starts.');
      }
      return at;
    }
    if (dto.days === 0) return null;
    const days = dto.days ?? DEFAULT_DAYS;
    return new Date(publishAt.getTime() + days * 24 * 3600_000);
  }

  async update(p: Principal, id: string, dto: Record<string, any>) {
    this.assertManager(p);
    const row = await one<any>(
      `SELECT * FROM hr_announcements WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('No such announcement.');

    const publishAt = dto.publishAt ? new Date(dto.publishAt) : new Date(row.publish_at);
    const expiresAt = dto.expiresAt !== undefined || dto.days !== undefined
      ? this.resolveExpiry(publishAt, dto)
      : row.expires_at;

    const updated = await one<any>(
      `UPDATE hr_announcements SET
         title = COALESCE($2, title), title_ar = COALESCE($3, title_ar),
         body  = COALESCE($4, body),  body_ar  = COALESCE($5, body_ar),
         publish_at = $6, expires_at = $7,
         pinned = COALESCE($8, pinned),
         comments_enabled = COALESCE($9, comments_enabled),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, dto.title ?? null, dto.titleAr ?? null, dto.body ?? null, dto.bodyAr ?? null,
       publishAt, expiresAt, dto.pinned ?? null, dto.commentsEnabled ?? null]);

    return this.view(p, { ...updated, author_name: row.author_name ?? '' });
  }

  /**
   * Put it on the board, and tell everybody once.
   *
   * The notification is sent here and not on creation, because a draft is not
   * news yet. Publishing an already-published notice does not notify again:
   * fixing a typo must not ring fifty bells, and the guard is the status change
   * itself rather than a separate flag that could drift from it.
   */
  async publish(p: Principal, id: string) {
    this.assertManager(p);

    const row = await one<any>(
      `UPDATE hr_announcements
          SET status = 'PUBLISHED', updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL AND status <> 'PUBLISHED'
        RETURNING *`, [id]);

    if (!row) {
      const existing = await one<any>(
        `SELECT status FROM hr_announcements WHERE id=$1 AND deleted_at IS NULL`, [id]);
      if (!existing) throw new NotFoundException('No such announcement.');
      // Already live: return it unchanged rather than notifying a second time.
      return this.get(p, id);
    }

    await this.announce(row);
    return this.get(p, id);
  }

  /**
   * One notification each, to everyone with an account.
   *
   * No email, by choice: this is news rather than something anybody must act
   * on, and a company that gets an email for every notice stops reading both.
   * The bell is enough, and the home page is where it actually lands.
   *
   * Failures here do not fail the publish. The notice is up -- that is the part
   * that mattered -- and a bell that did not ring is worth a log line, not a
   * rolled-back publication.
   */
  private async announce(row: any) {
    try {
      const people = await query<{ id: string }>(
        `SELECT id FROM core_users WHERE deleted_at IS NULL AND status = 'ACTIVE'`);
      const title = row.title ?? row.title_ar ?? 'Company news';
      await Promise.all(people.map((u) => this.notifications.notify(
        u.id, 'announcements', title,
        (row.body ?? row.body_ar ?? '').slice(0, 200),
        'INFO', `/news/${row.id}`).catch(() => undefined)));
      this.log.log(`announced "${title}" to ${people.length} people`);
    } catch (e: any) {
      this.log.warn(`could not notify everyone about ${row.id}: ${e?.message ?? e}`);
    }
  }

  /** Take it down without destroying it. */
  async archive(p: Principal, id: string) {
    this.assertManager(p);
    const row = await one<any>(
      `UPDATE hr_announcements SET status='ARCHIVED', updated_at=now()
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
    if (!row) throw new NotFoundException('No such announcement.');
    return { archived: true };
  }

  async remove(p: Principal, id: string) {
    this.assertManager(p);
    const row = await one<any>(
      `UPDATE hr_announcements SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL
        RETURNING id`, [id]);
    if (!row) throw new NotFoundException('No such announcement.');

    /* The pictures go with it. The rows cascade; the objects have to be asked
       for by name, and are removed on a best effort -- a stray object costs
       storage, and failing the delete would leave the notice up. */
    const images = await query<any>(
      `SELECT file_key, thumb_key FROM hr_announcement_images WHERE announcement_id=$1`, [id]);
    for (const im of images) {
      for (const key of [im.file_key, im.thumb_key].filter(Boolean)) await this.store.remove(key);
    }
    return { removed: true };
  }

  /* ---------------------------------------------------------------- images */

  async requestImageUpload(p: Principal, id: string, dto: { name: string; type: string; size: number }) {
    this.assertManager(p);
    if (!ACCEPTED_TYPES.includes(dto.type)) {
      throw new BadRequestException('Pictures must be JPEG, PNG or WebP.');
    }
    if (dto.size > MAX_UPLOAD_BYTES) throw new BadRequestException('Pictures can be up to 10 MB.');

    const count = await one<any>(
      `SELECT count(*) AS n FROM hr_announcement_images
        WHERE announcement_id=$1 AND status <> 'DELETED' AND deleted_at IS NULL`, [id]);
    if (Number(count?.n ?? 0) >= MAX_IMAGES) {
      throw new BadRequestException(`An announcement can carry up to ${MAX_IMAGES} pictures.`);
    }

    const imageId = randomUUID();
    const incomingKey = `incoming/${imageId}`;
    await query(
      `INSERT INTO hr_announcement_images
         (id, announcement_id, status, incoming_key, original_name, uploaded_by, position)
       VALUES ($1,$2,'PENDING',$3,$4,$5,$6)`,
      [imageId, id, incomingKey, dto.name.slice(0, 200), p.id, Number(count?.n ?? 0)]);

    return {
      imageId,
      uploadUrl: await this.store.presignUpload(incomingKey, dto.type, 300),
      headers: { 'Content-Type': dto.type },
    };
  }

  /**
   * The bytes have arrived; decide whether to keep them.
   *
   * Nothing the browser claimed is trusted: the size comes from S3 and the type
   * from the file's own first bytes. A PDF renamed to .jpg is refused here
   * rather than becoming a broken picture on the home page.
   */
  async confirmImage(p: Principal, imageId: string) {
    this.assertManager(p);
    const row = await one<any>(`SELECT * FROM hr_announcement_images WHERE id=$1`, [imageId]);
    if (!row || row.status !== 'PENDING') throw new NotFoundException('No such upload.');

    const reject = async (message: string): Promise<never> => {
      await this.store.remove(row.incoming_key);
      await query(`UPDATE hr_announcement_images SET status='DELETED', deleted_at=now()
                    WHERE id=$1`, [imageId]);
      throw new BadRequestException(message);
    };

    const head = await this.store.head(row.incoming_key);
    if (!head) throw new BadRequestException('The upload has not arrived. Try again.');
    if (head.size <= 0 || head.size > MAX_UPLOAD_BYTES) return reject('Pictures can be up to 10 MB.');

    const input = await this.store.read(row.incoming_key);
    const kind = sniff(input);
    if (!kind || kind === 'pdf') return reject('That file is not a JPEG, PNG or WebP image.');

    const out = await compressImage(input);
    const fileKey = `announcements/${imageId}.webp`;
    const thumbKey = `announcements/${imageId}.thumb.webp`;
    await this.store.put(fileKey, out.main, 'image/webp');
    if (out.thumb) await this.store.put(thumbKey, out.thumb, 'image/webp');
    await this.store.remove(row.incoming_key);

    await query(
      `UPDATE hr_announcement_images
          SET status='READY', file_key=$2, thumb_key=$3, content_type='image/webp',
              bytes=$4, width=$5, height=$6, incoming_key=NULL, ready_at=now()
        WHERE id=$1`,
      [imageId, fileKey, out.thumb ? thumbKey : null, out.main.length, out.width, out.height]);

    return { id: imageId, ready: true };
  }

  async removeImage(p: Principal, imageId: string) {
    this.assertManager(p);
    const row = await one<any>(
      `UPDATE hr_announcement_images SET status='DELETED', deleted_at=now()
        WHERE id=$1 AND deleted_at IS NULL RETURNING *`, [imageId]);
    if (!row) throw new NotFoundException('No such picture.');
    for (const key of [row.file_key, row.thumb_key, row.incoming_key].filter(Boolean)) {
      await this.store.remove(key);
    }
    return { removed: true };
  }

  /** The order HR dragged them into. */
  async reorderImages(p: Principal, id: string, imageIds: string[]) {
    this.assertManager(p);
    await tx(async (c) => {
      for (let i = 0; i < imageIds.length; i++) {
        await c.query(
          `UPDATE hr_announcement_images SET position=$3
            WHERE id=$1 AND announcement_id=$2`, [imageIds[i], id, i]);
      }
    });
    return { reordered: true };
  }

  /* -------------------------------------------------------------- comments */

  async comments(p: Principal, id: string) {
    const rows = await query<any>(
      `SELECT c.id, c.body, c.created_at, c.author_id, u.full_name AS author_name
         FROM hr_announcement_comments c
         JOIN core_users u ON u.id = c.author_id
        WHERE c.announcement_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at`, [id]);
    return rows.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: new Date(c.created_at).toISOString(),
      author: { id: c.author_id, fullName: c.author_name },
      /* Your own, or anyone's if you look after the board. Decided here rather
         than in the browser, which can only hide the button. */
      canRemove: c.author_id === p.id || can(p, MANAGE),
    }));
  }

  async comment(p: Principal, id: string, body: string) {
    const a = await one<any>(
      `SELECT status, comments_enabled, publish_at FROM hr_announcements
        WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!a) throw new NotFoundException('No such announcement.');
    if (a.status !== 'PUBLISHED' || new Date(a.publish_at) > new Date()) {
      throw new BadRequestException('This announcement is not open for replies yet.');
    }
    if (!a.comments_enabled) {
      throw new BadRequestException('Replies are turned off for this announcement.');
    }
    const text = body.trim();
    if (!text) throw new BadRequestException('Write something first.');
    if (text.length > 2000) throw new BadRequestException('Replies can be up to 2000 characters.');

    const row = await one<any>(
      `INSERT INTO hr_announcement_comments (announcement_id, author_id, body)
       VALUES ($1,$2,$3) RETURNING id, body, created_at`, [id, p.id, text]);

    return {
      id: row.id, body: row.body,
      createdAt: new Date(row.created_at).toISOString(),
      author: { id: p.id, fullName: p.fullName },
      canRemove: true,
    };
  }

  /**
   * Remove a reply.
   *
   * Your own always; anyone's with the permission. The row stays with a
   * `deleted_at` rather than going, so a thread does not quietly reshuffle
   * under the people reading it, and so there is a record of a removal having
   * happened at all.
   */
  async removeComment(p: Principal, commentId: string) {
    const row = await one<any>(
      `SELECT author_id FROM hr_announcement_comments
        WHERE id=$1 AND deleted_at IS NULL`, [commentId]);
    if (!row) throw new NotFoundException('No such reply.');
    if (row.author_id !== p.id && !can(p, MANAGE)) {
      throw new ForbiddenException('You can only remove your own replies.');
    }
    await query(
      `UPDATE hr_announcement_comments SET deleted_at=now(), deleted_by_id=$2 WHERE id=$1`,
      [commentId, p.id]);
    return { removed: true };
  }
}