/**
 * Which kind of process this is.
 *
 * The worker boots the whole application module so that an event is applied by
 * the same code either way -- and that also boots every scheduler in it. A
 * scheduler in the worker is not wanted: its job is the webhook queue, the API
 * already runs the schedule, and a second copy means every job that is not
 * behind a distributed lock (abandoned checkouts, the tasks sweep) runs twice.
 * On a system already being throttled by Shopify, that is load nobody asked for.
 *
 * Read when a scheduler starts, not when this file is imported, so the worker
 * can declare itself before the application context is created without
 * depending on the order its imports are evaluated in.
 */
export const isWorkerProcess = (): boolean => process.env.PROCESS_ROLE === 'worker';

/** Called once, first thing in the worker's entry point. */
export const declareWorkerProcess = (): void => { process.env.PROCESS_ROLE = 'worker'; };