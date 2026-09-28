-- 0016_notification_email.sql
-- Track which notifications have been emailed.
--
-- `core_notifications` has been written to since the meeting-rooms module
-- shipped -- invitations, responses, cancellations and time changes all land
-- there -- and nothing has ever read it. There is no bell, no endpoint, no
-- screen. Every one of those rows has been filed and never seen.
--
-- Two columns, for two different jobs.
--
-- `email_sent_at` is the idempotency record. Sending happens outside the
-- transaction that creates the notification, because SES must never be able to
-- fail a booking; that means a retry, a restart or a double-call can otherwise
-- send the same invitation twice, and a person receiving the same meeting
-- invitation three times stops reading them. Null means not sent; a timestamp
-- means do not send again.
--
-- `email_error` records why, when it did not work. Without it a failure is
-- invisible: the notification exists, the bell shows it, and the person who
-- never opens the portal is simply never told. Surfacing the reason is what
-- lets that be noticed rather than assumed.

ALTER TABLE core_notifications ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;
ALTER TABLE core_notifications ADD COLUMN IF NOT EXISTS email_error text;

-- The sender looks for rows still waiting, which on a healthy install is a
-- handful at a time against a table that only grows. Partial, so it stays the
-- size of the backlog rather than the size of the history.
CREATE INDEX IF NOT EXISTS core_notifications_unsent_idx
  ON core_notifications (created_at)
  WHERE email_sent_at IS NULL;

-- Everything already in the table predates the bell and the mailer. Marked as
-- sent rather than emailed: these are invitations to meetings that have long
-- since happened, and mailing them now would be worse than never mailing them.
UPDATE core_notifications
   SET email_sent_at = created_at
 WHERE email_sent_at IS NULL;