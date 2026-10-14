import axios from 'axios';

import { config } from '../config/index.js';
import { logger } from '../logger/index.js';
import { normalizeBookingCode } from '../utils/booking-code.js';
import { retryWithBackoff } from '../utils/retry.js';
import { validateTourismHQResponse } from '../utils/validator.js';

const log = logger.child('TourismHQ');

const MAX_LOGGED_SHARED_CODES = 20;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

function requestConfig(timeoutMs) {
    return {
        timeout: timeoutMs,
        headers: {
            Accept: 'application/json',
            'User-Agent': 'CRM-Sync/1.0',
            ...(config.TOURISM_HQ_API_KEY && { Authorization: `Bearer ${config.TOURISM_HQ_API_KEY}` }),
        },
    };
}

export async function fetchTourismHQData() {
    log.info('Fetching Tourism HQ scoreboard', { url: config.TOURISM_HQ_API_URL });

    return retryWithBackoff(
        async () => {
            let response;
            try {
                response = await axios.get(config.TOURISM_HQ_API_URL, requestConfig(config.REQUEST_TIMEOUT_MS));
            } catch (error) {
                // The body usually carries the real reason (e.g. "IP not whitelisted").
                log.error('Tourism HQ request failed', {
                    status: error.response?.status,
                    code: error.code,
                    errorMessage: error.message,
                    responseBody: error.response?.data ?? '(no body)',
                });
                throw error;
            }

            const indexed = buildBookingCodeIndex(response.data);

            log.info('Tourism HQ scoreboard indexed', {
                totalEvents: indexed.totalEvents,
                totalCodes: indexed.totalCodes,
                totalPromoters: indexed.totalPromoters,
                totalPaxCount: indexed.totalPaxCount,
                sharedCodes: indexed.sharedCodes.length,
            });

            // Full picture of what the API returned, for production verification.
            log.info('Tourism HQ codes found (code -> summed pax)', {
                codes: Object.fromEntries(
                    [...indexed.codeIndex].map(([code, entry]) => [code, entry.paxCount]),
                ),
            });

            return indexed;
        },
        'Tourism HQ fetch',
        { maxAttempts: config.MAX_RETRIES, initialDelayMs: config.RETRY_BACKOFF_MS },
    );
}

/**
 * Flattens the scoreboard into one index keyed by booking code.
 *
 * The payload nests three levels deep:
 *   Events[] -> { Promoters[], NoCode[] } -> { Email, Codes[] } -> { Code, PaxCount }
 *
 * Codes are indexed globally because the code alone identifies the record to
 * update — the owning promoter takes no part in matching.
 *
 * A code recurs in every event with its own per-event pax count, so the counts
 * are SUMMED: deposit_count holds the total that code brought across all events.
 */
export function buildBookingCodeIndex(data) {
    const { Events } = validateTourismHQResponse(data);

    const codeIndex = new Map();
    const allPromoters = new Set();
    let totalPaxCount = 0;

    for (const event of Events) {
        const eventName = event?.Event ?? '(unnamed event)';

        // Promoters and NoCode share the same entry shape; both carry usable codes.
        const entries = [
            ...(Array.isArray(event?.Promoters) ? event.Promoters : []),
            ...(Array.isArray(event?.NoCode) ? event.NoCode : []),
        ];

        for (const entry of entries) {
            if (!Array.isArray(entry?.Codes)) continue;

            const promoterEmail = String(entry.Email ?? '').toLowerCase().trim();
            if (promoterEmail) allPromoters.add(promoterEmail);

            for (const codeEntry of entry.Codes) {
                const normalised = normalizeBookingCode(codeEntry?.Code);
                if (!normalised) continue;

                const paxCount = Number(codeEntry?.PaxCount) || 0;
                totalPaxCount += paxCount;

                const existing = codeIndex.get(normalised);

                if (existing) {
                    existing.paxCount += paxCount;
                    existing.events.push({ event: eventName, paxCount });
                    if (promoterEmail) existing.promoters.add(promoterEmail);
                } else {
                    codeIndex.set(normalised, {
                        code: String(codeEntry.Code).trim(),
                        paxCount,
                        events: [{ event: eventName, paxCount }],
                        promoters: new Set(promoterEmail ? [promoterEmail] : []),
                    });
                }
            }
        }
    }

    // Recurring codes are expected and are summed. A code claimed by more than one
    // promoter is not — it means two people's numbers are landing on one record.
    const sharedCodes = [...codeIndex.entries()]
        .filter(([, entry]) => entry.promoters.size > 1)
        .map(([code, entry]) => ({
            code,
            totalPaxCount: entry.paxCount,
            promoters: [...entry.promoters],
        }));

    if (sharedCodes.length > 0) {
        log.warn('Booking codes claimed by more than one promoter — counts were combined', {
            sharedCodeCount: sharedCodes.length,
            sample: sharedCodes.slice(0, MAX_LOGGED_SHARED_CODES),
            truncated: sharedCodes.length > MAX_LOGGED_SHARED_CODES,
        });
    }

    return {
        codeIndex,
        sharedCodes,
        totalCodes: codeIndex.size,
        totalPaxCount,
        totalPromoters: allPromoters.size,
        totalEvents: Events.length,
    };
}

export async function healthCheck() {
    try {
        const response = await axios.get(config.TOURISM_HQ_API_URL, requestConfig(HEALTH_CHECK_TIMEOUT_MS));
        const healthy = response.status === 200 && Array.isArray(response.data?.Events);

        log.info(`Tourism HQ health check ${healthy ? 'passed' : 'failed'}`, {
            status: response.status,
            hasEventsArray: Array.isArray(response.data?.Events),
        });

        return healthy;
    } catch (error) {
        log.error('Tourism HQ health check failed', {
            status: error.response?.status,
            code: error.code,
            errorMessage: error.message,
        });
        return false;
    }
}
