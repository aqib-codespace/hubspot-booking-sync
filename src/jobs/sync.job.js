import { logger } from '../logger/index.js';
import * as hubspot from '../services/hubspot.service.js';
import * as tourismHQ from '../services/tourismhq.service.js';
import { isSameCount, normalizeBookingCode } from '../utils/booking-code.js';

const log = logger.child('SyncJob');

// Caps the per-record detail lists so one huge run cannot flood the logs.
const MAX_SAMPLE_SIZE = 200;

// In-flight run, or null when idle. Doubles as the execution lock and as the
// handle a graceful shutdown awaits.
let activeRun = null;

export async function executeSyncJob() {
    if (activeRun) {
        log.warn('Sync job already running — skipping this execution');
        return {
            success: false,
            reason: 'Previous execution still in progress',
            timestamp: new Date().toISOString(),
        };
    }

    activeRun = runSync().finally(() => {
        activeRun = null;
    });

    return activeRun;
}

async function runSync() {
    const jobId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const startedAt = Date.now();

    log.info('Starting sync job', { jobId });

    try {
        const [tourism, records] = await Promise.allSettled([
            tourismHQ.fetchTourismHQData(),
            hubspot.fetchHubSpotRecords(),
        ]);

        // Either source failing makes matching impossible — abort without writing.
        const failures = [
            tourism.status === 'rejected' && `TourismHQ: ${tourism.reason?.message}`,
            records.status === 'rejected' && `HubSpot: ${records.reason?.message}`,
        ].filter(Boolean);

        if (failures.length > 0) {
            const error = failures.join(' | ');
            log.error('Source fetch failed — aborting run without writing', { jobId, error });
            return { success: false, jobId, executionTimeMs: Date.now() - startedAt, error, timestamp: new Date().toISOString() };
        }

        const { codeIndex, totalCodes, totalPromoters } = tourism.value;
        const hubspotRecords = records.value;

        log.info('Both sources fetched', {
            jobId,
            tourismCodes: totalCodes,
            tourismPromoters: totalPromoters,
            hubspotRecords: hubspotRecords.length,
        });

        const { updates, skipped, samples } = matchRecordsByBookingCode(hubspotRecords, codeIndex, jobId);

        if (samples.unmatchedCodes.length > 0) {
            log.warn('HubSpot booking codes absent from Tourism HQ', {
                jobId,
                count: skipped.codeNotFound,
                sample: samples.unmatchedCodes,
                truncated: skipped.codeNotFound > samples.unmatchedCodes.length,
            });
        }

        const matched = updates.length;
        let updated = 0;
        let failed = 0;

        if (matched > 0) {
            const result = await hubspot.batchUpdateHubSpotRecords(updates);
            updated = result.totalUpdated;
            failed = result.totalFailed;

            // What HubSpot actually stored, echoed back from its response.
            log.info('HubSpot confirmed updates', {
                jobId,
                records: result.results.slice(0, MAX_SAMPLE_SIZE).map((r) => ({
                    recordId: r.id,
                    deposit_count: r.properties?.deposit_count ?? '(not returned)',
                    updatedAt: r.updatedAt ?? '(not returned)',
                })),
                truncated: result.results.length > MAX_SAMPLE_SIZE,
            });
        } else {
            log.info('No records required an update', { jobId });
        }

        const executionTimeMs = Date.now() - startedAt;
        const summary = {
            hubspotRecordsTotal: hubspotRecords.length,
            tourismCodesTotal: totalCodes,
            matched,
            updated,
            failed,
            skippedTotal: skipped.noBookingCode + skipped.codeNotFound + skipped.alreadyCurrent,
            skippedBreakdown: skipped,
        };

        log.info('Sync job completed', { jobId, executionTimeMs, ...summary });

        return { success: failed === 0, jobId, executionTimeMs, summary, timestamp: new Date().toISOString() };
    } catch (error) {
        const executionTimeMs = Date.now() - startedAt;
        log.error('Sync job failed', { jobId, executionTimeMs, error });
        return { success: false, jobId, executionTimeMs, error: error.message, timestamp: new Date().toISOString() };
    }
}

/**
 * Queues a record when it has a booking_code, that code exists upstream, and the
 * stored deposit_count differs. Pure apart from logging, so it can be tested directly.
 */
export function matchRecordsByBookingCode(records, codeIndex, jobId) {
    const updates = [];
    const skipped = { noBookingCode: 0, codeNotFound: 0, alreadyCurrent: 0 };
    const samples = { unmatchedCodes: [], queued: [] };

    for (const record of records) {
        const bookingCode = normalizeBookingCode(record.properties?.booking_code);

        if (!bookingCode) {
            skipped.noBookingCode += 1;
            continue;
        }

        const indexed = codeIndex.get(bookingCode);

        if (!indexed) {
            skipped.codeNotFound += 1;
            if (samples.unmatchedCodes.length < MAX_SAMPLE_SIZE) {
                samples.unmatchedCodes.push({ recordId: record.id, bookingCode });
            }
            continue;
        }

        const storedCount = record.properties?.deposit_count;

        // Rewriting an unchanged value costs an API call and bumps updatedAt for nothing.
        if (isSameCount(storedCount, indexed.paxCount)) {
            skipped.alreadyCurrent += 1;
            continue;
        }

        if (samples.queued.length < MAX_SAMPLE_SIZE) {
            samples.queued.push({
                recordId: record.id,
                bookingCode,
                from: storedCount ?? '(empty)',
                to: indexed.paxCount,
            });
        }

        updates.push({ id: record.id, depositCount: indexed.paxCount });
    }

    log.info('Booking code matching complete', { jobId, toUpdate: updates.length, skipped });

    if (samples.queued.length > 0) {
        log.info('Records queued for update (before -> after)', {
            jobId,
            records: samples.queued,
            truncated: updates.length > samples.queued.length,
        });
    }

    return { updates, skipped, samples };
}

export function getJobStatus() {
    return { isExecuting: activeRun !== null, timestamp: new Date().toISOString() };
}

// Lets shutdown wait for a run in progress instead of killing it mid-write.
export async function waitForIdle() {
    if (activeRun) await activeRun.catch(() => {});
}

export async function runHealthChecks() {
    const [tourism, hubspotHealth] = await Promise.allSettled([
        tourismHQ.healthCheck(),
        hubspot.healthCheck(),
    ]);

    const status = {
        tourismHQ: tourism.status === 'fulfilled' && tourism.value,
        hubspot: hubspotHealth.status === 'fulfilled' && hubspotHealth.value,
    };

    const result = { ...status, allHealthy: status.tourismHQ && status.hubspot };

    if (result.allHealthy) log.info('All services passed health checks', result);
    else log.warn('One or more services failed health checks', result);

    return result;
}
