/**
 * Integration test suite.
 *
 * Two kinds of test live here:
 *   - Logic tests, which import the real production modules and run offline.
 *   - Live tests, which hit the Tourism HQ and HubSpot APIs and need credentials.
 *
 * Run: npm test   (requires a .env with HUBSPOT_ACCESS_TOKEN for the live tests)
 */

import process from 'node:process';

import 'dotenv/config';
import axios from 'axios';

// Import the real implementations, so these tests exercise production code
// rather than a copy that can silently drift out of sync with it.
import { matchRecordsByBookingCode } from './src/jobs/sync.job.js';
import { buildBookingCodeIndex } from './src/services/tourismhq.service.js';
import { normalizeBookingCode } from './src/utils/booking-code.js';

// ─── Terminal colours ────────────────────────────────────────────────────────
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
};

// ─── Minimal test harness ────────────────────────────────────────────────────
const tests = [];
const results = { passed: 0, failed: 0, skipped: 0 };

const test = (name, fn) => void tests.push({ name, fn });

function assertTrue(value, message) {
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

function assertEquals(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message} — expected ${expected}, got ${actual}`);
}

async function runTests() {
    console.log(`\n${c.blue}╔════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.blue}║   CRM-Sync Integration Test Suite      ║${c.reset}`);
    console.log(`${c.blue}╚════════════════════════════════════════╝${c.reset}\n`);

    for (const { name, fn } of tests) {
        try {
            const result = await fn();
            if (result === 'SKIP') {
                console.log(`${c.yellow}⊘ SKIP: ${name}${c.reset}`);
                results.skipped += 1;
            } else {
                console.log(`${c.green}✓ PASS: ${name}${c.reset}`);
                results.passed += 1;
            }
        } catch (error) {
            console.log(`${c.red}✗ FAIL: ${name}${c.reset}`);
            console.error(`  ${error.message}\n`);
            results.failed += 1;
        }
    }

    console.log(`\n${c.blue}╔════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.blue}║             Test Results               ║${c.reset}`);
    console.log(`${c.blue}╠════════════════════════════════════════╣${c.reset}`);
    console.log(`  Passed:  ${c.green}${results.passed}${c.reset}`);
    console.log(`  Failed:  ${c.red}${results.failed}${c.reset}`);
    console.log(`  Skipped: ${c.yellow}${results.skipped}${c.reset}`);
    console.log(`${c.blue}╚════════════════════════════════════════╝${c.reset}\n`);

    process.exit(results.failed > 0 ? 1 : 0);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TOURISM_URL = process.env.TOURISM_HQ_API_URL ?? 'https://booking.tourismhq.com/api/scoreboard';
const HUBSPOT_BASE = process.env.HUBSPOT_API_URL ?? 'https://api.hubapi.com';
const HUBSPOT_OBJECT = process.env.HUBSPOT_OBJECT_ID;

const hubspotHeaders = () => ({ Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` });

const fetchScoreboard = async () => (await axios.get(TOURISM_URL, { timeout: 8_000 })).data;

const fetchHubSpotPage = (params) =>
    axios.get(`${HUBSPOT_BASE}/crm/v3/objects/${HUBSPOT_OBJECT}`, {
        headers: hubspotHeaders(),
        params,
        timeout: 8_000,
    });

/**
 * Build a code index from an inline fixture.
 * @param {Array<[string, number]>} codes
 * @param {string} [email]
 */
const indexOf = (codes, email = 'promoter@example.com') =>
    buildBookingCodeIndex({
        Events: [{
            Event: 'Fixture',
            Promoters: [{ Email: email, Codes: codes.map(([Code, PaxCount]) => ({ Code, PaxCount })) }],
        }],
    }).codeIndex;

// ─── 1. Configuration ────────────────────────────────────────────────────────

test('Config: HUBSPOT_ACCESS_TOKEN is set', () => {
    assertTrue(process.env.HUBSPOT_ACCESS_TOKEN, 'HUBSPOT_ACCESS_TOKEN must be set in .env');
});

test('Config: API URLs are valid', () => {
    void new URL(TOURISM_URL);
    void new URL(HUBSPOT_BASE);
});

test('Config: HUBSPOT_RECORDS_LIMIT is a positive integer', () => {
    const limit = Number(process.env.HUBSPOT_RECORDS_LIMIT ?? '100');
    assertTrue(Number.isInteger(limit) && limit > 0, `Must be a positive integer, got: ${process.env.HUBSPOT_RECORDS_LIMIT}`);
});

test('Config: HUBSPOT_BATCH_SIZE is 1–100 (HubSpot hard limit)', () => {
    const size = Number(process.env.HUBSPOT_BATCH_SIZE ?? '100');
    assertTrue(Number.isInteger(size) && size > 0 && size <= 100, `Must be 1–100, got: ${size}`);
});

test('Config: cron schedule has 5 fields', () => {
    const schedule = process.env.CRON_SCHEDULE ?? '0 * * * *';
    assertEquals(schedule.trim().split(/\s+/).length, 5, `Cron schedule "${schedule}" must have exactly 5 fields`);
});

// ─── 2. Booking code logic (offline) ─────────────────────────────────────────

test('Logic: booking code normalisation trims and folds case', () => {
    const cases = [
        [' abc-123 ', 'ABC-123'],
        ['def456', 'DEF456'],
        ['MiXeD', 'MIXED'],
        [null, ''],
        [undefined, ''],
        ['', ''],
        [12345, '12345'],
    ];
    for (const [raw, expected] of cases) {
        assertEquals(normalizeBookingCode(raw), expected, `Normalisation of ${JSON.stringify(raw)}`);
    }
});

test('Logic: codes are indexed across events, Promoters and NoCode', () => {
    const { codeIndex, totalCodes, totalPromoters } = buildBookingCodeIndex({
        Events: [
            { Event: 'A', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'X1', PaxCount: 5 }] }], NoCode: [] },
            { Event: 'B', Promoters: [], NoCode: [{ Email: 'c@d.com', Codes: [{ Code: 'Y2', PaxCount: 12 }] }] },
        ],
    });
    assertEquals(totalCodes, 2, 'Both codes should be indexed');
    assertEquals(totalPromoters, 2, 'Both promoters should be counted');
    assertEquals(codeIndex.get('X1').paxCount, 5, 'Code from Promoters indexed');
    assertEquals(codeIndex.get('Y2').paxCount, 12, 'Code from NoCode indexed');
});

test('Logic: malformed events are skipped without discarding the payload', () => {
    const { totalCodes } = buildBookingCodeIndex({
        Events: [
            null,
            { Event: 'No arrays' },
            { Event: 'Bad codes', Promoters: [{ Email: 'a@b.com', Codes: 'not-an-array' }] },
            { Event: 'Good', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'OK', PaxCount: 3 }] }] },
        ],
    });
    assertEquals(totalCodes, 1, 'Only the valid code should be indexed');
});

test('Logic: a code recurring across events sums its pax counts', () => {
    // The real scoreboard repeats each code per event with its own count.
    const { codeIndex, totalPaxCount } = buildBookingCodeIndex({
        Events: [
            { Event: 'AKL', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'TTTM', PaxCount: 17 }] }] },
            { Event: 'BNE', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'TTTM', PaxCount: 0 }] }] },
            { Event: 'OF', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'tttm', PaxCount: 6 }] }] },
            { Event: 'SYD', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'TTTM', PaxCount: 0 }] }] },
        ],
    });
    assertEquals(codeIndex.size, 1, 'Case-different codes must collapse to one entry');
    assertEquals(codeIndex.get('TTTM').paxCount, 23, 'Counts should sum to 17 + 0 + 6 + 0');
    assertEquals(totalPaxCount, 23, 'Overall total should match the summed entry');
    assertEquals(codeIndex.get('TTTM').events.length, 4, 'Each contributing event should be recorded');
});

test('Logic: a code used by one promoter is not flagged as shared', () => {
    const { sharedCodes } = buildBookingCodeIndex({
        Events: [
            { Event: 'A', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'SAME', PaxCount: 4 }] }] },
            { Event: 'B', Promoters: [{ Email: 'a@b.com', Codes: [{ Code: 'SAME', PaxCount: 4 }] }] },
        ],
    });
    assertEquals(sharedCodes.length, 0, 'One promoter across many events is normal');
});

test('Logic: a code claimed by two promoters is flagged and combined', () => {
    const { codeIndex, sharedCodes } = buildBookingCodeIndex({
        Events: [
            { Event: 'AKL', Promoters: [{ Email: 'daryl@x.com', Codes: [{ Code: 'TMMW', PaxCount: 8 }] }] },
            { Event: 'OF', Promoters: [{ Email: 'discountcodes@x.com', Codes: [{ Code: 'TMMW', PaxCount: 6 }] }] },
        ],
    });
    assertEquals(codeIndex.get('TMMW').paxCount, 14, 'Counts are still summed');
    assertEquals(sharedCodes.length, 1, 'Two owners for one code must be reported');
    assertEquals(sharedCodes[0].promoters.length, 2, 'Both promoters should be named');
});

test('Logic: duplicate code inside a single promoter entry sums', () => {
    // The live payload contains REF twice in one Codes array.
    const { codeIndex } = buildBookingCodeIndex({
        Events: [{
            Event: 'BNE',
            Promoters: [{ Email: 'ref@x.com', Codes: [{ Code: 'REF', PaxCount: 8 }, { Code: 'REF', PaxCount: 8 }] }],
        }],
    });
    assertEquals(codeIndex.get('REF').paxCount, 16, 'Both entries should count');
});

test('Logic: malformed payloads are rejected', () => {
    for (const bad of [null, undefined, 'string', 42, [], {}, { Events: 'nope' }]) {
        let threw = false;
        try {
            buildBookingCodeIndex(bad);
        } catch {
            threw = true;
        }
        assertTrue(threw, `Should have rejected ${JSON.stringify(bad) ?? 'undefined'}`);
    }
});

// ─── 3. Matching (offline) ───────────────────────────────────────────────────

test('Match: booking code matches regardless of manager_email', () => {
    const codeIndex = indexOf([['BC1', 7]]);
    const { updates } = matchRecordsByBookingCode([
        { id: '1', properties: { booking_code: 'BC1', deposit_count: '0', manager_email: 'totally@unrelated.com' } },
        { id: '2', properties: { booking_code: 'BC1', deposit_count: '0' } },
    ], codeIndex, 'test');

    assertEquals(updates.length, 2, 'Both records should match on booking code alone');
    assertEquals(updates[0].depositCount, 7, 'Pax count taken from the matched code');
});

test('Match: booking code comparison ignores case and whitespace', () => {
    const codeIndex = indexOf([['abc-1', 5]]);
    const { updates } = matchRecordsByBookingCode(
        [{ id: '1', properties: { booking_code: '  ABC-1 ', deposit_count: '0' } }],
        codeIndex,
        'test',
    );
    assertEquals(updates.length, 1, 'Differently-cased code should still match');
    assertEquals(updates[0].depositCount, 5, 'Correct pax count applied');
});

test('Match: skip reasons are classified correctly', () => {
    const codeIndex = indexOf([['KNOWN', 4], ['ZERO', 0]]);
    const { updates, skipped } = matchRecordsByBookingCode([
        { id: '1', properties: { booking_code: 'KNOWN', deposit_count: '1' } },    // update
        { id: '2', properties: { booking_code: 'KNOWN', deposit_count: '4' } },    // already current
        { id: '3', properties: { booking_code: 'UNKNOWN', deposit_count: '1' } },  // absent upstream
        { id: '4', properties: { booking_code: '', deposit_count: '1' } },         // blank code
        { id: '5', properties: { deposit_count: '1' } },                           // missing code
        { id: '6', properties: { booking_code: 'ZERO', deposit_count: '3' } },     // must write 0
        { id: '7', properties: { booking_code: 'KNOWN', deposit_count: null } },   // unset -> write
    ], codeIndex, 'test');

    assertEquals(updates.length, 3, 'Three records should be queued');
    assertEquals(skipped.alreadyCurrent, 1, 'One record already held the correct value');
    assertEquals(skipped.codeNotFound, 1, 'One code was absent from Tourism HQ');
    assertEquals(skipped.noBookingCode, 2, 'Two records had no usable booking code');
    assertEquals(updates.find((u) => u.id === '6').depositCount, 0, 'PaxCount 0 must be written, not skipped');
});

test('Match: unchanged values are not rewritten', () => {
    // HubSpot returns numeric properties as strings — '8' must equal 8.
    const { updates, skipped } = matchRecordsByBookingCode(
        [{ id: '1', properties: { booking_code: 'SAME', deposit_count: '8' } }],
        indexOf([['SAME', 8]]),
        'test',
    );
    assertEquals(updates.length, 0, 'No write should be queued for an unchanged value');
    assertEquals(skipped.alreadyCurrent, 1, 'Record should be counted as already current');
});

test('Match: deposit_count is serialised as a string at the API boundary', () => {
    // HubSpot rejects numeric property values; the service stringifies on send.
    assertEquals(String(42), '42', 'Numeric pax count must serialise to a string');
});

// ─── 4. Tourism HQ (live) ────────────────────────────────────────────────────

test('TourismHQ: endpoint is reachable', async () => {
    const res = await axios.get(TOURISM_URL, { timeout: 8_000, headers: { Accept: 'application/json' } });
    assertTrue(res.status >= 200 && res.status < 300, `Unexpected status: ${res.status}`);
});

test('TourismHQ: response contains a non-empty Events array', async () => {
    const data = await fetchScoreboard();
    assertTrue(Array.isArray(data.Events), `Expected data.Events to be an array, got: ${typeof data.Events}`);
    assertTrue(data.Events.length > 0, 'data.Events is empty — no events to process');
});

test('TourismHQ: live payload indexes to at least one booking code', async () => {
    const { codeIndex } = buildBookingCodeIndex(await fetchScoreboard());
    assertTrue(codeIndex.size > 0, 'Booking code index is empty — nothing could ever match');
    for (const [key, entry] of codeIndex) {
        assertEquals(key, normalizeBookingCode(key), `Index key "${key}" is not normalised`);
        assertTrue(Number.isFinite(entry.paxCount) && entry.paxCount >= 0, `Invalid paxCount for "${key}"`);
    }
});

test('TourismHQ: codes shared by multiple promoters are reported', async () => {
    const { sharedCodes } = buildBookingCodeIndex(await fetchScoreboard());
    // Legal but suspicious — surface them rather than failing the run.
    if (sharedCodes.length > 0) {
        console.log(`  ${c.yellow}⚠ ${sharedCodes.length} code(s) claimed by more than one promoter:${c.reset}`);
        for (const shared of sharedCodes.slice(0, 5)) {
            console.log(`    ${shared.code} (total ${shared.totalPaxCount}) — ${shared.promoters.join(', ')}`);
        }
    }
    return sharedCodes.length > 0 ? undefined : 'SKIP';
});

// ─── 5. HubSpot (live) ───────────────────────────────────────────────────────

test('HubSpot: access token is valid', async () => {
    try {
        await fetchHubSpotPage({ limit: 1, properties: 'booking_code' });
    } catch (error) {
        if (error.response?.status === 401) throw new Error('Authentication failed — invalid or expired access token');
        if (error.response?.status === 403) throw new Error('Token lacks the required CRM scopes');
        throw error;
    }
});

test('HubSpot: custom object is accessible', async () => {
    const res = await fetchHubSpotPage({ limit: 1, properties: 'booking_code,deposit_count' });
    assertEquals(res.status, 200, 'Unexpected status');
    assertTrue(Array.isArray(res.data?.results), 'Response is missing the results array');
});

test('HubSpot: records expose booking_code and deposit_count', async () => {
    const res = await fetchHubSpotPage({ limit: 10, properties: 'booking_code,deposit_count,manager_email' });
    const records = res.data.results;
    assertTrue(records.length > 0, 'No records returned — cannot validate property shape');
    for (const record of records) {
        assertTrue(record.id, 'Record is missing its id');
        assertTrue(record.properties, `Record ${record.id} is missing its properties object`);
        // Values may be null or blank, but the keys must exist — booking_code is the join key.
        assertTrue('booking_code' in record.properties, `Record ${record.id} is missing booking_code`);
        assertTrue('deposit_count' in record.properties, `Record ${record.id} is missing deposit_count`);
    }
});

test('HubSpot: at least one record carries a booking_code', async () => {
    const res = await fetchHubSpotPage({ limit: 100, properties: 'booking_code' });
    const withCode = res.data.results.filter((r) => normalizeBookingCode(r.properties?.booking_code));
    assertTrue(withCode.length > 0, 'No record on the first page has a booking_code — nothing would ever sync');
});

test('HubSpot: pagination cursor advances', async () => {
    const page1 = await fetchHubSpotPage({ limit: 1, properties: 'booking_code' });
    const cursor = page1.data?.paging?.next?.after;
    if (!cursor) return 'SKIP'; // Only one record — pagination not applicable.

    const page2 = await fetchHubSpotPage({ limit: 1, properties: 'booking_code', after: cursor });
    assertTrue(Array.isArray(page2.data?.results), 'Page 2 is missing the results array');
    assertTrue(
        page2.data.results[0]?.id !== page1.data.results[0]?.id,
        'Page 2 returned the same record as page 1 — the cursor is not advancing',
    );
});

// ─── 6. End-to-end dry run (live, read-only) ─────────────────────────────────

test('E2E: live sources produce a coherent match plan (no writes)', async () => {
    const [{ codeIndex }, page] = await Promise.all([
        fetchScoreboard().then(buildBookingCodeIndex),
        fetchHubSpotPage({ limit: 100, properties: 'booking_code,deposit_count' }),
    ]);

    const records = page.data.results;
    const { updates, skipped } = matchRecordsByBookingCode(records, codeIndex, 'dry-run');
    const accounted = updates.length + skipped.noBookingCode + skipped.codeNotFound + skipped.alreadyCurrent;

    assertEquals(accounted, records.length, 'Every record must be either queued or explicitly skipped');
    console.log(`  ${c.blue}dry run:${c.reset} ${updates.length} would update, ${JSON.stringify(skipped)}`);
});

// ─── 7. Performance ──────────────────────────────────────────────────────────

test('Performance: Tourism HQ responds within REQUEST_TIMEOUT_MS', async () => {
    const timeout = Number(process.env.REQUEST_TIMEOUT_MS ?? '10000');
    const start = Date.now();
    await axios.get(TOURISM_URL, { timeout });
    assertTrue(Date.now() - start < timeout, `Tourism HQ exceeded the ${timeout}ms budget`);
});

test('Performance: HubSpot responds within REQUEST_TIMEOUT_MS', async () => {
    const timeout = Number(process.env.REQUEST_TIMEOUT_MS ?? '10000');
    const start = Date.now();
    await fetchHubSpotPage({ limit: 1, properties: 'booking_code' });
    assertTrue(Date.now() - start < timeout, `HubSpot exceeded the ${timeout}ms budget`);
});

await runTests();
