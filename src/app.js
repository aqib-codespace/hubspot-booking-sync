import { schedule as scheduleCron, validate as validateCron } from 'node-cron';

import { config, validateConfig } from './config/index.js';
import * as syncJob from './jobs/sync.job.js';
import { logger } from './logger/index.js';

const log = logger.child('App');

let task = null;
let running = false;

export async function startApp() {
    log.info('Starting application', { nodeEnv: config.NODE_ENV, logLevel: config.LOG_LEVEL });

    validateConfig();

    // Advisory only: a service that is briefly down should not stop the scheduler
    // from coming up and retrying on the next tick.
    const health = await syncJob.runHealthChecks();
    if (!health.allHealthy) {
        log.warn('Starting despite failed health checks — the next run will retry', health);
    }

    if (!validateCron(config.CRON_SCHEDULE)) {
        throw new Error(`Invalid CRON_SCHEDULE: "${config.CRON_SCHEDULE}"`);
    }

    task = scheduleCron(config.CRON_SCHEDULE, async () => {
        log.info('Cron fired', { schedule: config.CRON_SCHEDULE });
        // executeSyncJob resolves rather than rejects, so nothing escapes into the scheduler.
        await syncJob.executeSyncJob();
    });

    log.info('Sync job scheduled', { schedule: config.CRON_SCHEDULE });

    if (config.NODE_ENV === 'development') {
        log.info('Development mode — running an initial sync immediately');
        await syncJob.executeSyncJob();
    }

    running = true;
    log.info('Application started', { cronSchedule: config.CRON_SCHEDULE, environment: config.NODE_ENV });
}

export async function stopApp() {
    log.info('Stopping application');

    if (task) {
        await task.stop();
        task = null;
    }

    // Let a run in progress finish so shutdown never interrupts a half-written batch.
    if (syncJob.getJobStatus().isExecuting) {
        log.info('Waiting for the in-flight sync job to finish');
        await syncJob.waitForIdle();
    }

    running = false;
    log.info('Application stopped');
}

export function getAppStatus() {
    return {
        isRunning: running,
        environment: config.NODE_ENV,
        cronSchedule: config.CRON_SCHEDULE,
        jobStatus: syncJob.getJobStatus(),
        timestamp: new Date().toISOString(),
    };
}
