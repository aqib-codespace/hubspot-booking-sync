import { setTimeout as sleep } from 'node:timers/promises';

import { logger } from '../logger/index.js';

const log = logger.child('Retry');

const RETRYABLE_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    'EPIPE',
]);

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

const DEFAULTS = { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 30_000, backoffMultiplier: 2 };

// A 401 or 400 will never succeed on a second attempt — retrying only wastes quota.
export function isRetryable(error) {
    if (!error) return false;
    if (RETRYABLE_CODES.has(error.code)) return true;

    // Axios reports its own timeouts as ECONNABORTED rather than ETIMEDOUT.
    if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message ?? '')) return true;

    const status = error.response?.status;
    if (typeof status === 'number') return status >= 500 || RETRYABLE_STATUSES.has(status);

    return false;
}

// Prefer the server's own Retry-After over a guessed backoff.
function retryAfterMs(error) {
    const header = error?.response?.headers?.['retry-after'];
    if (header === undefined) return null;

    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

    const dateMs = Date.parse(header);
    return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

export async function retryWithBackoff(operation, operationName, options = {}) {
    const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } = { ...DEFAULTS, ...options };

    let delayMs = initialDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxAttempts) {
                log.error(`${operationName}: all ${maxAttempts} attempt(s) exhausted`, {
                    errorMessage: error.message,
                    status: error.response?.status,
                });
                throw error;
            }

            if (!isRetryable(error)) {
                log.error(`${operationName}: permanent failure on attempt ${attempt}`, {
                    errorMessage: error.message,
                    code: error.code,
                    status: error.response?.status,
                });
                throw error;
            }

            const serverDelay = retryAfterMs(error);
            const waitMs = serverDelay ?? delayMs;

            log.warn(`${operationName}: attempt ${attempt} failed — retrying`, {
                errorMessage: error.message,
                status: error.response?.status,
                nextAttempt: attempt + 1,
                waitMs,
            });

            await sleep(waitMs);
            delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
        }
    }

    throw new Error(`${operationName}: retry loop exited unexpectedly`);
}
