import 'dotenv/config';

import { logger } from '../logger/index.js';

const log = logger.child('Config');

const HUBSPOT_MAX_BATCH_SIZE = 100;

// Fails fast on a malformed value rather than falling back to a default that hides the typo.
function readInt(key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = process.env[key]?.trim();
    if (!raw) return fallback;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
        throw new Error(`Invalid ${key}: expected an integer, got "${raw}"`);
    }
    if (parsed < min || parsed > max) {
        throw new Error(`Invalid ${key}: expected ${min}–${max}, got ${parsed}`);
    }
    return parsed;
}

const readString = (key, fallback = '') => process.env[key]?.trim() || fallback;

export const config = Object.freeze({
    NODE_ENV: readString('NODE_ENV', 'development'),
    LOG_LEVEL: readString('LOG_LEVEL', 'info'),
    // Max records listed per detail log line. 0 = unlimited.
    LOG_SAMPLE_LIMIT: readInt('LOG_SAMPLE_LIMIT', 100, { min: 0 }),

    TOURISM_HQ_API_URL: readString('TOURISM_HQ_API_URL', 'https://booking.tourismhq.com/api/scoreboard'),
    TOURISM_HQ_API_KEY: readString('TOURISM_HQ_API_KEY', ''),

    HUBSPOT_API_URL: readString('HUBSPOT_API_URL', 'https://api.hubapi.com'),
    HUBSPOT_OBJECT_ID: readString('HUBSPOT_OBJECT_ID', ''),
    HUBSPOT_ACCESS_TOKEN: readString('HUBSPOT_ACCESS_TOKEN', ''),
    HUBSPOT_RECORDS_LIMIT: readInt('HUBSPOT_RECORDS_LIMIT', 100, { max: HUBSPOT_MAX_BATCH_SIZE }),
    HUBSPOT_BATCH_SIZE: readInt('HUBSPOT_BATCH_SIZE', 100, { max: HUBSPOT_MAX_BATCH_SIZE }),

    CRON_SCHEDULE: readString('CRON_SCHEDULE', '0 * * * *'),

    REQUEST_TIMEOUT_MS: readInt('REQUEST_TIMEOUT_MS', 10_000, { min: 1_000 }),
    MAX_RETRIES: readInt('MAX_RETRIES', 3, { max: 10 }),
    RETRY_BACKOFF_MS: readInt('RETRY_BACKOFF_MS', 1_000, { min: 100 }),
});

export function validateConfig() {
    for (const key of ['HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_OBJECT_ID']) {
        if (!config[key]) {
            throw new Error(`Missing required environment variable: ${key}`);
        }
    }

    for (const key of ['TOURISM_HQ_API_URL', 'HUBSPOT_API_URL']) {
        try {
            new URL(config[key]);
        } catch {
            throw new Error(`Invalid ${key}: "${config[key]}" is not a valid URL`);
        }
    }

    log.info('Configuration validated', {
        nodeEnv: config.NODE_ENV,
        cronSchedule: config.CRON_SCHEDULE,
        hubspotObjectId: config.HUBSPOT_OBJECT_ID,
        tourismHqAuthenticated: Boolean(config.TOURISM_HQ_API_KEY),
    });
}
