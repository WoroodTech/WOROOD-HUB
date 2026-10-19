/**
 * The worker process.
 *
 * Compiled to dist/worker.js, which the release copies to api/worker.js --
 * exactly where deploy/systemd/worood-hub-worker.service expects it. That unit
 * already existed and is not enabled; this is the program it was waiting for.
 *
 * An application context, not an HTTP server: the worker takes its work from
 * PostgreSQL and listens on nothing. It shares the module graph with the API so
 * that an event is applied by the same code either way -- a second
 * implementation of "what does orders/updated mean" is how the two drift.
 *
 * No migrations here on purpose. They run once per deploy, in the API unit's
 * ExecStartPre; two units racing to migrate one database is a bad kind of bug.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { config } from './common/config';
import { WebhookWorker } from './modules/sales-dashboard/webhooks/webhook-worker';
import { closeDb } from './common/db';
import { declareWorkerProcess } from './common/process-role';

async function main() {
  /* Before the application context is created: the schedulers decide whether to
     start in onModuleInit, which runs inside createApplicationContext. */
  declareWorkerProcess();

  const log = new Logger('Worker');

  /* Refuse to start rather than run alongside the API's inline processing.
     Both would handle the same events, and only one of them claims. */
  if (!config.webhookWorker.enabled) {
    log.error('WEBHOOK_WORKER_ENABLED is not "true" — refusing to start, because the API is still processing webhooks inline and both would do the same work.');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  /* Nest calls onApplicationShutdown on SIGTERM, which is what systemd sends.
     The worker uses it to finish the event in hand and release its claim, so a
     restart costs nothing rather than a lease interval. */
  app.enableShutdownHooks();

  const worker = app.get(WebhookWorker);
  worker.start();

  log.log(`worker ${config.webhookWorker.id} ready`);

  const shutdown = async (signal: string) => {
    try {
      await app.close();      // runs onApplicationShutdown
      await closeDb();
      process.exit(0);
    } catch (e: any) {
      log.error(`shutdown after ${signal} failed: ${e?.message ?? e}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('worker failed to start:', e);
  process.exit(1);
});