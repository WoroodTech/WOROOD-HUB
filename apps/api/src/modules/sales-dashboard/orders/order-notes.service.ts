/**
 * Notes staff add to an order, kept here and published to Shopify.
 *
 * Shopify has no way to add a timeline comment: `CommentEvent` is read-only in
 * the Admin API and no mutation creates one. What `orderUpdate` can write is
 * the order's `note`, and changing that does reach the timeline -- as a
 * note-changed event carrying the text, not as a comment from a named person.
 *
 * `note` is one string. Writing it replaces everything, so the whole set is
 * rebuilt from our rows after every change rather than appended to blindly:
 * appending would duplicate on every retry, and a second writer would erase
 * the first.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { one, query } from '../../../common/db';
import { Principal, can } from '../../../common/auth';
import { AuditService } from '../../../core/core.module';
import { ShopifyService } from '../shopify/shopify.service';

/** Who may write on an order. */
export const NOTE_WRITE = 'sales.order.note.write';

/*
 * No marker in the published note.
 *
 * It used to carry `--- WOROOD HUB ---` so the next publish could tell our
 * block from whatever the merchant had typed by hand. That worked, and it put
 * a line of plumbing in front of a human reader on every order.
 *
 * Instead we remember the exact text we last wrote, on the order, and remove
 * that from the note before writing the new text. It identifies our block
 * just as precisely and leaves nothing in the note that is not a note.
 *
 * When the remembered text is not found -- somebody edited our lines in the
 * Shopify Admin, or this is the first publish onto a note they wrote -- the
 * new block is simply added after whatever is there. The alternative is
 * guessing which lines were ours and deleting them, and a wrong guess
 * destroys something nobody can get back.
 */

@Injectable()
export class OrderNotesService {
  private readonly log = new Logger('OrderNotes');

  constructor(
    private readonly shopify: ShopifyService,
    private readonly audit: AuditService,
  ) {}

  /** The notes on an order, newest last. */
  async list(p: Principal, orderId: string) {
    const order = await one<any>(
      `SELECT id, name, notes_published_at, notes_publish_error
         FROM sd_orders WHERE id = $1 AND deleted_at IS NULL`, [orderId]);
    if (!order) throw new NotFoundException('No such order.');

    const rows = await query<any>(
      `SELECT n.id, n.body, n.created_at, n.updated_at,
              u.full_name AS author_name, n.author_id
         FROM sd_order_notes n
         JOIN core_users u ON u.id = n.author_id
        WHERE n.order_id = $1 AND n.deleted_at IS NULL
        ORDER BY n.created_at`, [orderId]);

    return {
      orderName: order.name,
      canWrite: can(p, NOTE_WRITE),
      notes: rows.map((r) => ({
        id: r.id,
        body: r.body,
        authorName: r.author_name,
        createdAt: r.created_at,
        edited: r.updated_at > r.created_at,
        /* Only your own, and only while it is yours to change. Somebody
           else's note is a record of what they said. */
        mine: r.author_id === p.id,
      })),
      publishedAt: order.notes_published_at,
      /* Surfaced rather than logged: a note that never reached Shopify looks
         identical to one that did, and the person who wrote it is the one who
         needs to know. */
      publishError: order.notes_publish_error,
    };
  }

  async add(p: Principal, orderId: string, body: string) {
    if (!can(p, NOTE_WRITE)) {
      throw new ForbiddenException('You cannot add notes to orders.');
    }
    const text = (body ?? '').trim();
    if (!text) throw new BadRequestException('A note needs something in it.');

    const order = await one<any>(
      `SELECT id, name FROM sd_orders WHERE id = $1 AND deleted_at IS NULL`,
      [orderId]);
    if (!order) throw new NotFoundException('No such order.');

    const row = await one<any>(
      `INSERT INTO sd_order_notes (order_id, body, author_id)
       VALUES ($1,$2,$3) RETURNING id`, [orderId, text, p.id]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'sales-dashboard', action: 'order.note.add',
      entityType: 'sd_order', entityId: orderId,
      payload: { noteId: row.id, order: order.name },
    });

    await this.publish(orderId);
    return this.list(p, orderId);
  }

  async edit(p: Principal, noteId: string, body: string) {
    const text = (body ?? '').trim();
    if (!text) throw new BadRequestException('A note needs something in it.');

    const note = await one<any>(
      `SELECT id, order_id, author_id FROM sd_order_notes
        WHERE id = $1 AND deleted_at IS NULL`, [noteId]);
    if (!note) throw new NotFoundException('No such note.');

    /* Your own only. Editing somebody else's note would change the record of
       what they said while keeping their name on it. */
    if (note.author_id !== p.id) {
      throw new ForbiddenException('You can only change your own notes.');
    }

    await query(
      `UPDATE sd_order_notes SET body = $2, updated_at = now() WHERE id = $1`,
      [noteId, text]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'sales-dashboard', action: 'order.note.edit',
      entityType: 'sd_order', entityId: note.order_id, payload: { noteId },
    });

    await this.publish(note.order_id);
    return this.list(p, note.order_id);
  }

  async remove(p: Principal, noteId: string) {
    const note = await one<any>(
      `SELECT id, order_id, author_id FROM sd_order_notes
        WHERE id = $1 AND deleted_at IS NULL`, [noteId]);
    if (!note) throw new NotFoundException('No such note.');

    /* The author, or somebody who manages the module -- a note published to
       Shopify is visible to the merchant, and taking one down should not wait
       for the person who wrote it to be at a desk. */
    const mine = note.author_id === p.id;
    if (!mine && !can(p, 'sales.sync.manage')) {
      throw new ForbiddenException('You can only remove your own notes.');
    }

    await query(
      `UPDATE sd_order_notes SET deleted_at = now(), deleted_by_id = $2
        WHERE id = $1`, [noteId, p.id]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'sales-dashboard', action: 'order.note.remove',
      entityType: 'sd_order', entityId: note.order_id,
      payload: { noteId, mine },
    });

    await this.publish(note.order_id);
    return { ok: true };
  }

  /* ------------------------------------------------------- publishing -- */

  /**
   * The portal's notes, as one block of text.
   *
   * The name and what was said, nothing else. Shopify's note carries no
   * author so the name has to be on the line; the time does not, because the
   * timeline event beside it is already stamped with when the note changed.
   */
  private render(notes: { body: string; authorName: string }[]): string {
    if (!notes.length) return '';
    return notes.map((n) => `${n.authorName}: ${n.body}`).join('\n');
  }

  /**
   * Write the order's note in Shopify.
   *
   * Whatever the merchant wrote by hand is kept above the fence and left
   * alone. Without that, the first publish would delete it and nothing would
   * say it had been there.
   *
   * Never throws. A note is saved here first and published second: failing
   * the request after the row is committed would tell somebody their note was
   * lost when it was not. The error is recorded on the order and shown beside
   * the notes instead.
   */
  private async publish(orderId: string): Promise<void> {
    const order = await one<any>(
      `SELECT id, shopify_gid, notes_published_body FROM sd_orders WHERE id = $1`,
      [orderId]);
    if (!order?.shopify_gid) return;

    const notes = await query<any>(
      `SELECT n.body, n.created_at, u.full_name AS author_name
         FROM sd_order_notes n
         JOIN core_users u ON u.id = n.author_id
        WHERE n.order_id = $1 AND n.deleted_at IS NULL
        ORDER BY n.created_at`, [orderId]);

    const ours = this.render(notes.map((n) => ({
      body: n.body, authorName: n.author_name,
    })));

    try {
      /* Read first. The merchant's own note is not ours to replace, and an
         order's note can have changed in the Admin since we last wrote. */
      const current = await this.shopify.source.graphql<any>(
        `query($id: ID!) { order(id: $id) { id note } }`,
        { id: order.shopify_gid });

      const existing: string = current?.order?.note ?? '';
      const previous: string = order.notes_published_body ?? '';

      /* Take our last block out by exact match. Anything left is theirs --
         typed in the Admin, before or after ours -- and is kept. */
      const theirs = (previous && existing.includes(previous)
        ? existing.replace(previous, '')
        : existing
      ).trim();

      const next = [theirs, ours].filter(Boolean).join('\n\n');

      /* Nothing changed: a retry after a network failure, or an edit that
         produced the same text. Writing anyway would put a pointless event on
         the merchant's timeline. */
      if (ours === (order.notes_published_body ?? '') && next === existing) {
        return;
      }

      const res = await this.shopify.source.graphql<any>(
        `mutation($input: OrderInput!) {
           orderUpdate(input: $input) {
             order { id note }
             userErrors { field message }
           }
         }`,
        { input: { id: order.shopify_gid, note: next } });

      const errors = res?.orderUpdate?.userErrors ?? [];
      if (errors.length) {
        /* userErrors is how Shopify reports a refusal: the HTTP call
           succeeded, so without this check a rejected write would look like a
           successful one. */
        throw new Error(errors.map((e: any) => e.message).join('; '));
      }

      await query(
        `UPDATE sd_orders
            SET notes_published_at = now(), notes_published_body = $2,
                notes_publish_error = NULL
          WHERE id = $1`,
        /* Our block alone, never the whole note. Storing the whole thing
           meant the next publish removed the merchant's lines along with
           ours -- they were inside the text being matched. */
        [orderId, ours]);

      this.log.log(`published ${notes.length} note(s) to order ${order.shopify_gid}`);
    } catch (e: any) {
      const said = String(e?.message ?? e);
      /* The commonest cause by far, and the one whose own message explains
         nothing: the app was never granted write access. */
      const likely = /access denied|not approved|scope/i.test(said)
        ? 'The Shopify app does not have write_orders. Add the scope in the '
          + 'Partner dashboard and reinstall the app on the shop.'
        : null;

      await query(
        `UPDATE sd_orders SET notes_publish_error = $2 WHERE id = $1`,
        [orderId, (likely ? `${likely} (${said})` : said).slice(0, 2000)]);

      this.log.error(`could not publish notes for order ${orderId}: ${said}`);
    }
  }

  /**
   * Try the orders this failed for again.
   *
   * The usual reason for a batch of failures is one cause -- the scope was
   * missing -- so the fix is one change and then this.
   */
  async retryFailed(p: Principal) {
    if (!can(p, 'sales.sync.manage')) {
      throw new ForbiddenException('You cannot republish order notes.');
    }
    const stuck = await query<any>(
      `SELECT id FROM sd_orders
        WHERE notes_publish_error IS NOT NULL AND deleted_at IS NULL
        LIMIT 100`);
    for (const o of stuck) await this.publish(o.id);
    return { attempted: stuck.length };
  }
}