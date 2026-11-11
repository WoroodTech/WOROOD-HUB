/**
 * Draining the warehouse queue.
 *
 * Runs in every process that loads the module, as the Finance worker does.
 * That is safe rather than wasteful: events are claimed with `FOR UPDATE SKIP
 * LOCKED`, so two processes never take the same row, and whichever is free
 * picks the next one up.
 *
 * It also means a movement still reaches the sheet if the dedicated worker is
 * down — which, on this server, has happened.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { hostname } from 'os';
import { config } from '../../../common/config';
import { WarehouseQueueService } from './warehouse-queue.service';

@Injectable()
export class WarehouseWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WarehouseWorker');
  private timer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private busy = false;

  /** Who holds a lease, so an expired one can be traced to a process. */
  private readonly owner = `${hostname()}:${process.pid}:warehouse`;

  constructor(private readonly queue: WarehouseQueueService) {}

  onModuleInit() {
    if (config.warehouseSheets.mode === 'off') {
      /*
       * Nothing is lost by not starting: events keep queuing and go out when
       * the connection is turned on. Said plainly in the log, because "the
       * warehouse is not writing" is otherwise a puzzle.
       */
      this.log.log('the warehouse sheet is off; the queue will hold until it is live');
      return;
    }

    this.log.log(
      `draining the warehouse queue in ${config.warehouseSheets.mode} mode as ${this.owner}`);

    this.timer = setInterval(() => void this.tick(), 15_000);

    /* Leases from processes that died. Rarely needed, cheap when it is not. */
    this.sweeper = setInterval(
      () => void this.queue.reclaimExpiredLeases().catch(() => undefined), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.log.log('stopped draining the warehouse queue');
  }

  /**
   * One pass.
   *
   * Guarded against overlapping with itself: a slow pass must not have a
   * second one started on top of it, which would double the API calls
   * against a document that is already rate-limited.
   */
  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const { written, failed } = await this.queue.drain(this.owner);
      if (written || failed) {
        this.log.log(`warehouse queue: ${written} written, ${failed} failed`);
      }
    } catch (e: any) {
      /* Never throws out of the interval: an unhandled rejection here takes
         the process down and stops everything else it runs. */
      this.log.error(`warehouse queue pass failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }
}