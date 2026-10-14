import process from 'node:process';

import { startApp, stopApp } from './app.js';
import { logger } from './logger/index.js';

const log = logger.child('Main');

const SHUTDOWN_GRACE_MS = 30_000;

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`${signal} received — shutting down gracefully`);

    // Never let a wedged request block shutdown indefinitely.
    const forceExit = setTimeout(() => {
        log.error('Graceful shutdown timed out — forcing exit', { graceMs: SHUTDOWN_GRACE_MS });
        process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
        await stopApp();
        clearTimeout(forceExit);
        process.exit(0);
    } catch (error) {
        log.error('Error during shutdown', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// An uncaught exception leaves the process in an undefined state.
process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', reason);
});

try {
    await startApp();
} catch (error) {
    log.error('Fatal error during startup', error);
    process.exit(1);
}
