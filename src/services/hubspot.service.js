import axios from 'axios';

import { config } from '../config/index.js';
import { logger } from '../logger/index.js';
import { retryWithBackoff } from '../utils/retry.js';

const log = logger.child('HubSpot');

// manager_email is fetched for traceability only; it takes no part in matching.
const RECORD_PROPERTIES = 'booking_code,deposit_count,manager_email';
const MAX_LOGGED_ERRORS = 10;
const MAX_LOGGED_RECORDS = 200;

function createClient() {
    return axios.create({
        baseURL: config.HUBSPOT_API_URL,
        timeout: config.REQUEST_TIMEOUT_MS,
        headers: {
            Authorization: `Bearer ${config.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'CRM-Sync/1.0',
        },
    });
}

const objectEndpoint = () => `/crm/v3/objects/${config.HUBSPOT_OBJECT_ID}`;

const retryOptions = { maxAttempts: config.MAX_RETRIES, initialDelayMs: config.RETRY_BACKOFF_MS };

function chunk(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

export async function fetchHubSpotRecords() {
    log.info('Fetching HubSpot records', {
        objectId: config.HUBSPOT_OBJECT_ID,
        pageSize: config.HUBSPOT_RECORDS_LIMIT,
    });

    const http = createClient();
    const endpoint = objectEndpoint();
    const records = [];

    let cursor;
    let page = 1;

    try {
        while (true) {
            const params = {
                limit: config.HUBSPOT_RECORDS_LIMIT,
                properties: RECORD_PROPERTIES,
                ...(cursor !== undefined && { after: cursor }),
            };

            // Retry per page, so a transient failure on page 12 does not restart the walk.
            const response = await retryWithBackoff(
                () => http.get(endpoint, { params }),
                `HubSpot page ${page}`,
                retryOptions,
            );

            const results = response.data?.results;
            if (!Array.isArray(results)) {
                throw new Error(`HubSpot page ${page}: response is missing the results array`);
            }

            records.push(...results);

            // HubSpot signals the last page by omitting paging.next.after.
            const nextCursor = response.data?.paging?.next?.after;
            if (!nextCursor) break;

            cursor = nextCursor;
            page += 1;
        }

        log.info('HubSpot fetch complete', { totalPages: page, totalRecords: records.length });

        // Full picture of what HubSpot returned, for production verification.
        log.info('HubSpot records found', {
            records: records.slice(0, MAX_LOGGED_RECORDS).map((r) => ({
                recordId: r.id,
                booking_code: r.properties?.booking_code || '(empty)',
                deposit_count: r.properties?.deposit_count ?? '(empty)',
                manager_email: r.properties?.manager_email || '(empty)',
            })),
            truncated: records.length > MAX_LOGGED_RECORDS,
        });

        return records;
    } catch (error) {
        log.error('HubSpot fetch failed', {
            page,
            recordsFetchedBeforeFailure: records.length,
            status: error.response?.status,
            errorMessage: error.message,
            responseBody: error.response?.data ?? '(no body)',
        });
        throw error;
    }
}

/**
 * Writes deposit_count for many records.
 *
 * Uses batch/update rather than batch/upsert: upsert rejects hs_object_id as a
 * match key (400 VALIDATION_ERROR) and demands a custom unique property, whereas
 * update accepts native record ids directly.
 */
export async function batchUpdateHubSpotRecords(updates) {
    if (!Array.isArray(updates) || updates.length === 0) {
        return { totalUpdated: 0, totalFailed: 0, chunksTotal: 0, chunksFailed: 0, results: [] };
    }

    const http = createClient();
    const endpoint = `${objectEndpoint()}/batch/update`;
    const chunks = chunk(updates, config.HUBSPOT_BATCH_SIZE);

    log.info('Starting batch update', { totalRecords: updates.length, chunksTotal: chunks.length });

    const results = [];
    let totalUpdated = 0;
    let totalFailed = 0;
    let chunksFailed = 0;

    for (const [index, batch] of chunks.entries()) {
        const label = `chunk ${index + 1}/${chunks.length}`;

        // HubSpot requires property values as strings, including numerics.
        const inputs = batch.map(({ id, depositCount }) => ({
            id: String(id),
            properties: { deposit_count: String(depositCount) },
        }));

        try {
            const response = await retryWithBackoff(
                () => http.post(endpoint, { inputs }),
                `HubSpot batch update ${label}`,
                retryOptions,
            );

            const succeeded = response.data?.results ?? [];
            // HTTP 207 means partial success; errors[] names the records that failed.
            const errors = response.data?.errors ?? [];

            results.push(...succeeded);
            totalUpdated += succeeded.length;
            totalFailed += errors.length;

            if (errors.length > 0) {
                chunksFailed += 1;
                log.warn(`Batch ${label} partially failed`, {
                    succeeded: succeeded.length,
                    failed: errors.length,
                    sample: errors.slice(0, MAX_LOGGED_ERRORS),
                });
            }
        } catch (error) {
            // Isolate the failure so the remaining chunks still get written.
            chunksFailed += 1;
            totalFailed += batch.length;
            log.error(`Batch ${label} failed entirely`, {
                recordsInChunk: batch.length,
                status: error.response?.status,
                errorMessage: error.message,
                responseBody: error.response?.data ?? '(no body)',
            });
        }
    }

    log.info('Batch update finished', {
        totalSent: updates.length,
        totalUpdated,
        totalFailed,
        chunksTotal: chunks.length,
        chunksFailed,
    });

    return { totalUpdated, totalFailed, chunksTotal: chunks.length, chunksFailed, results };
}

export async function healthCheck() {
    try {
        const response = await createClient().get(objectEndpoint(), {
            params: { limit: 1, properties: RECORD_PROPERTIES },
        });

        // Zero records is a valid state, not a fault.
        const healthy = response.status === 200 && Array.isArray(response.data?.results);

        log.info(`HubSpot health check ${healthy ? 'passed' : 'failed'}`, {
            status: response.status,
            recordsAvailable: response.data?.results?.length ?? 0,
        });

        return healthy;
    } catch (error) {
        log.error('HubSpot health check failed', {
            status: error.response?.status,
            errorMessage: error.message,
            responseBody: error.response?.data ?? '(no body)',
        });
        return false;
    }
}
