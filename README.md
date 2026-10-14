# TourismHQ → HubSpot CRM Sync

A lightweight, scheduled Node.js service that reads pax counts from the Tourism HQ scoreboard API and batch-updates `deposit_count` on matching records in a HubSpot custom object.

**Records are matched on `booking_code`.** The promoter email is fetched and logged for traceability but takes no part in matching.

---

## How it works

```
Cron fires (default: every hour)
        │
        ├─── GET Tourism HQ scoreboard  ──► Index all codes: { bookingCode → PaxCount }
        │
        ├─── GET HubSpot custom object  ──► Paginate all records: { id, booking_code, deposit_count }
        │
        └─── Match booking_code ──► POST /batch/update ──► deposit_count written to HubSpot
```

1. Both API calls run concurrently via `Promise.allSettled`. If either fails, the run aborts without writing.
2. Every booking code across every event, promoter and `NoCode` entry is flattened into one global index.
3. HubSpot records are matched by `booking_code` (trimmed, case-insensitive) — see [`src/utils/booking-code.js`](src/utils/booking-code.js) for the shared normalisation rule.
4. Records whose `deposit_count` already equals the indexed pax count are skipped, so unchanged records are not rewritten.
5. Remaining records are sent via `POST /crm/v3/objects/{objectId}/batch/update`, chunked at 100 per request. Chunks are isolated — one failing chunk does not block the rest.
6. An execution lock prevents overlapping runs if a job takes longer than its cron interval.

---

## Project structure

```
├── src/
│   ├── main.js                     Entry point — signals, exit codes, error traps
│   ├── app.js                      Lifecycle: config validation, cron scheduling, shutdown
│   ├── config/
│   │   └── index.js                Loads, defaults and validates environment variables
│   ├── jobs/
│   │   └── sync.job.js             Orchestrates fetch → match → update; owns the run lock
│   ├── services/
│   │   ├── tourismhq.service.js    Scoreboard client + booking-code indexing
│   │   └── hubspot.service.js      HubSpot client (paginated fetch, batch update)
│   ├── utils/
│   │   ├── booking-code.js         Shared booking-code normalisation (the join key)
│   │   ├── retry.js                Exponential backoff + retryable-error classification
│   │   └── validator.js            Tourism HQ response structure validation
│   └── logger/
│       └── index.js                Structured logger (JSON in production, coloured otherwise)
├── test-integration.js             Test suite (offline logic + live API checks)
├── .env.example                    Environment variable template
└── package.json
```

The codebase is **ES modules** (`"type": "module"`). Relative imports carry explicit
`.js` extensions, as Node's ESM resolver requires.

---

## Prerequisites

- Node.js ≥ 18
- A HubSpot Private App access token with scopes:
  - `crm.objects.custom.read`
  - `crm.objects.custom.write`

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your env file
cp .env.example .env

# 3. Fill in the required values in .env (see Configuration below)

# 4. Run
npm start          # production
npm run dev        # development — auto-restarts on change, runs one sync immediately
```

---

## Configuration

All configuration is via environment variables. See `.env.example` for the full template.

### Required

| Variable | Description |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot Private App token |
| `HUBSPOT_OBJECT_ID` | Custom object ID (format `2-XXXXXXXXX`) |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `TOURISM_HQ_API_URL` | `https://booking.tourismhq.com/api/scoreboard` | Scoreboard endpoint |
| `HUBSPOT_API_URL` | `https://api.hubapi.com` | HubSpot base URL (change for AP1 region) |
| `HUBSPOT_RECORDS_LIMIT` | `100` | Records per page when fetching HubSpot |
| `HUBSPOT_BATCH_SIZE` | `100` | Records per batch/update request (HubSpot max: 100) |
| `CRON_SCHEDULE` | `0 * * * *` | Cron expression — every hour |
| `REQUEST_TIMEOUT_MS` | `10000` | Per-request HTTP timeout |
| `MAX_RETRIES` | `3` | Total attempts per operation, including the first |
| `RETRY_BACKOFF_MS` | `1000` | Initial backoff delay (doubles each attempt) |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `NODE_ENV` | `development` | Set to `production` in production |

### HubSpot region note

If your HubSpot account is in the Asia-Pacific region, set:
```
HUBSPOT_API_URL=https://api-ap1.hubapi.com
```

---

## Sync logic in detail

### Booking code indexing (Tourism HQ)

The scoreboard is nested three levels deep. Every code across every event, every
promoter and every `NoCode` entry is flattened into one global index:

```
Events[] → { Promoters[], NoCode[] } → { Email, Codes[] } → { Code, PaxCount }
                                                  ↓
                              codeIndex: { NORMALISED_CODE → PaxCount }
```

**Codes recur across events, and their counts are summed.** A promoter's code
appears in every event with its own per-event pax count, so `deposit_count` holds
the total that code brought everywhere:

```
TTTM   AKL 17 | BNE 0 | OF 6 | SYD 0   ->  deposit_count = 23
```

**Codes shared by more than one promoter** are still summed, but logged as a
warning — it means two people's numbers are landing on one HubSpot record, which
is usually a data-entry problem rather than intent.

To change the aggregation (e.g. to highest-single-event), edit
[`buildBookingCodeIndex`](src/services/tourismhq.service.js) — the rule is the
single `existing.paxCount += paxCount` line.

### Matching

A HubSpot record is queued for update when **all** of the following hold:

1. It carries a non-empty `booking_code`.
2. That code exists in the Tourism HQ index.
3. Its stored `deposit_count` differs from the indexed pax count.

Anything else is skipped and counted under one of `noBookingCode`,
`codeNotFound` or `alreadyCurrent`, so every record in the run is accounted for.

Codes are compared trimmed and case-insensitively — the rule lives in
[`src/utils/booking-code.js`](src/utils/booking-code.js) so both sides can never drift apart.

`manager_email` is fetched and logged for traceability but takes **no part** in matching.

A pax count of `0` is a real value and is written; only `undefined` (code absent
upstream) causes a skip.

### Batch update

Uses `POST /crm/v3/objects/{objectId}/batch/update` (not `batch/upsert`).
HubSpot's `batch/upsert` endpoint rejects `hs_object_id` as a match key; `batch/update`
accepts native record IDs directly.

Chunks are isolated: a chunk that fails outright is logged and counted, and the
remaining chunks are still written. Partial (HTTP 207) responses are counted per
record rather than per chunk.

---

## Error handling

| Error type | Retryable | Behaviour |
|---|---|---|
| Network errors (`ECONNREFUSED`, `ETIMEDOUT`, etc.) | Yes | Exponential backoff |
| HTTP 5xx | Yes | Exponential backoff |
| HTTP 429 (rate limit) | Yes | Exponential backoff |
| HTTP 4xx (other) | No | Fails immediately |
| Invalid response structure | No | Fails immediately |

If either the Tourism HQ or HubSpot **fetch** fails after all retries, the sync job for that run is aborted and the error is logged. No partial writes are made.

---

## Testing

```bash
npm test
```

The suite has two halves:

**Offline logic tests** — import the real production modules, need no credentials
and no network:

- Booking-code normalisation (trimming, case folding, null/numeric inputs)
- Indexing across events, `Promoters` and `NoCode`; tolerance of malformed events
- Duplicate-code conflict detection and pax-count totalling
- Matching: email-independence, skip classification, `PaxCount: 0`, no-op suppression

**Live tests** — need `HUBSPOT_ACCESS_TOKEN` and network access:

- Tourism HQ reachability and response shape
- HubSpot authentication, object accessibility, pagination, property shape
- A read-only end-to-end dry run that proves every record is either queued or
  explicitly skipped
- Performance baselines against configured timeouts

Live tests failing while the logic tests pass means credentials or connectivity,
not a code fault.

Quick API smoke tests:

```bash
npm run test:tourism   # print raw Tourism HQ response
npm run test:hubspot   # print first HubSpot page (requires HUBSPOT_ACCESS_TOKEN)
```

---

## Deployment

### PM2

```bash
pm2 start index.js --name crm-sync
pm2 save
```

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "index.js"]
```

```bash
docker build -t crm-sync .
docker run -d --env-file .env --name crm-sync crm-sync
```

The container has no exposed ports — it is a pure background worker.

---

## Logging

**Development** — coloured, human-readable:
```
[2026-01-01T10:00:00.000Z] [INFO] [CRM-Sync:SyncJob] Sync job completed
{
  "jobId": "sync-1234567890-abc123",
  "executionTimeMs": 842,
  "summary": { "hubspotRecordsTotal": 45, "matched": 12, "updated": 12, "skipped": 33, "failed": 0 }
}
```

**Production** (`NODE_ENV=production`) — JSON per line, suitable for log aggregators:
```json
{"timestamp":"2026-01-01T10:00:00.000Z","level":"info","context":"CRM-Sync:SyncJob","message":"Sync job completed","jobId":"sync-...","executionTimeMs":842}
```

Set `LOG_LEVEL=debug` for detailed per-record and per-page traces.

---

## Troubleshooting

**`Missing required environment variables: HUBSPOT_ACCESS_TOKEN`**  
→ Make sure `.env` exists and contains a valid token.

**HubSpot returns 401**  
→ Token is invalid or expired. Regenerate under HubSpot → Settings → Private Apps.

**HubSpot returns 403**  
→ Token is missing the `crm.objects.custom.write` scope. Edit the Private App and add it.

**`matched: 0` on every run**  
→ No `manager_email` values in your HubSpot records match any promoter email in Tourism HQ. Check casing, trailing spaces, and that the correct custom object ID is configured.

**`Sync job already running, skipping`**  
→ The previous run is taking longer than the cron interval. Either increase `CRON_SCHEDULE` frequency or investigate slow API responses with `LOG_LEVEL=debug`.

---

## Dependencies

| Package | Purpose |
|---|---|
| `axios` | HTTP client |
| `dotenv` | Environment variable loading |
| `node-cron` | Cron scheduler |
| `nodemon` *(dev)* | Auto-restart on file change |

## Author

Built by **Muhammad Aqib**, full-stack and automation engineer.

[Portfolio](https://aqib-portfolio-mern.vercel.app) · [LinkedIn](https://www.linkedin.com/in/aqib-engineer2/) · [GitHub](https://github.com/aqib-codespace)
