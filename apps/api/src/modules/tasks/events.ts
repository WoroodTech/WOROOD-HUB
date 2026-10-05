/**
 * The one way an event reaches a ticket's timeline.
 *
 * Its own file because two services write events -- the ticket lifecycle and
 * attachments -- and each needs the other for something else. Living in either
 * of them made the import circular, which works or fails depending on which
 * file Node happens to load first.
 */
export async function writeEvent(c: any, itemId: string, actorId: string | null,
                                 type: string, payload: unknown) {
  await c.query(
    `INSERT INTO tk_events (item_id, actor_id, type, payload) VALUES ($1,$2,$3,$4)`,
    [itemId, actorId, type, JSON.stringify(payload ?? {})]);
}