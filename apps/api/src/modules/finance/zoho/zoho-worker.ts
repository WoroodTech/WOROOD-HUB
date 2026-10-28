/**
 * The loop that drains the Zoho queue.
 *
 * Deliberately dull: take one event, post it, take the next. When there is
 * nothing to do it sleeps, and when there is a lot it works through it one at
 * a time -- Zoho allows about thirty calls a minute per organisation, so
 * racing would only earn rate-limit errors, and the queue is not in a hurry.
 *
 * Runs in the worker process beside the Shopify webhook worker. It does not
 * run in the API: a request handler that also drains a queue competes with the
 * people using the portal, and a deployment that restarts the API mid-post is
 * exactly when uncertainty is least welcome.
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { config } from '../../../common/config';
import { ZohoQueueService } from './zoho-queue.service';
import { ZohoBooksClient } from './books-client';

/** Between empty polls. The queue fills a few times a day, not continuously. */
const IDLE_MS = 15_000;

/** Between posts when there is a backlog: comfortably inside Zoho's allowance. */
const BUSY_MS = 2_500;

@Injectable()
export class ZohoWorker implements OnApplicationShutdown {
  private readonly log = new Logger('ZohoWorker');
  private running = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: ZohoQueueService,
    private readonly books: ZohoBooksClient,
  ) {}

  get owner(): string {
    return `${config.webhookWorker.id || 'worker'}:zoho`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.books.mode === 'off') {
      /* Not an error. A server with no Zoho organisation pointed at it should
         queue events and post none of them, which is exactly what `off`
         means -- and is the right state for a staging box. */
      this.log.log('ZOHO_MODE is "off" — events will be queued but not posted');
      return;
    }
    if (!this.books.configured) {
      this.log.error(
        'ZOHO_MODE is set but the credentials are not — refusing to start. '
        + 'Events will queue up safely until this is sorted out.');
      return;
    }

    this.running = true;
    /* Anything this worker was holding when it last stopped is its own to
       release: the lease would expire eventually, but there is no reason to
       make the queue wait for that when the worker is demonstrably back. */
    await this.queue.reclaimOwn(this.owner).catch(() => 0);

    this.log.log(`draining the Zoho queue in ${this.books.mode} mode as ${this.owner}`);
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    let did = false;
    try {
      did = await this.queue.drainOne(this.owner);
    } catch (e: any) {
      /* The loop itself must not die. A failure here is the database or
         something equally structural; the event's own failures are handled
         inside drainOne and never reach this. */
      this.log.error(`the Zoho queue loop stumbled: ${e?.message ?? e}`);
    }
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), did ? BUSY_MS : IDLE_MS);
  }

  /**
   * Stop between events, not during one.
   *
   * The event in hand finishes and releases its claim, so a restart costs
   * nothing instead of a lease interval of silence.
   */
  onApplicationShutdown(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) this.log.log('stopped draining the Zoho queue');
    this.running = false;
  }
}