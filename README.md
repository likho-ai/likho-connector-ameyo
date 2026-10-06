# likho-connector-ameyo

The dialer connector of [Likho](https://github.com/likho-ai): calls come from the Ameyo dialer
into Likho - by a schedule, by a person asking for one by its id, or by a command - and the
transcript goes back to the CRM.

| It does | How |
| --- | --- |
| Fetches a call by its id | The dialer's voice-log API (`downloadVoiceLog`, by `crt_object_id`), then likho-api's REST API: a recording with `source: ameyo`, the call's details as attributes, the audio to likho-media |
| Answers the web app | Takes `likho.import.requested` from the bus (the "From the dialer" panel, `requestImport`), answers `likho.import.completed` or `likho.import.failed` with a reason |
| Follows a schedule | Every few minutes, the new calls from the dialer's reporting database, judged by a policy (campaigns, shortest talk time), within a daily budget |
| Writes back | On `likho.transcription.completed`, the Hinglish transcript into the CRM (MS SQL Server), when switched on |
| Forgets | On `likho.recording.deleted`, the call may be fetched again |
| Lists the dialer's calls | gRPC `likho.dialer.v1.DialerService` on `GRPC_PORT` (5060) for likho-api: the campaigns and agents of a window with their counts, the calls a page at a time, one call, and its own status - what people choose from in the web app |
| Follows the admins | The schedule, the campaigns, the shortest talk time, the budget, the phone digits and the write-back come from the workspace's settings in Likho (Admin), read at start and again on `likho.settings.changed`; the `.env` values stand until Likho answers |

Node 24, TypeScript, NATS JetStream, PostgreSQL (its own state), `pg` for the dialer's reporting
database, `mssql` for the CRM.

## Nothing of the company is in this repository

The dialer's address and credentials, the workspace's API key, and the SQL that names the
company's tables and campaigns live in `.env.<environment>.local` and `queries/*.local.sql`,
both ignored by git. What is committed is the contract each query must meet
([src/dialer.ts](src/dialer.ts)) and an example of each ([queries/](queries/)).

## Run it

```bash
pnpm install
pnpm dev                     # serve: requests from the bus, the schedule, the write-back
pnpm build && node dist/cli.js import d000-0a1b2c3d-vce-0001      # one call, now
node dist/cli.js backfill --from "2026-10-01 00:00:00" --to "2026-10-01 23:59:59" --limit 500
node dist/cli.js status      # what the connector has done
node dist/cli.js check       # can the dialer, Likho and the databases be reached?
```

Before the first run, in `.env.development.local`:

```
LIKHO_API_KEY=lk_...                     # Settings → API keys in the web app
WORKSPACE_ID=wsp_...                     # the key's workspace
AMEYO_VOICELOG_URL=https://<dialer>/ameyowebaccess
AMEYO_HASH_KEY=...                       # the dialer's API credentials
AMEYO_POLICY_NAME=...
AMEYO_REQUESTING_HOST=...
AMEYO_ARCHIVAL_URL=http://<archiver>/dacx/download   # optional: older recordings, by the leg's call_id
DIALER_DATABASE_URL=postgres://...       # read only; optional: without it a call is fetched by its id alone
CALLS_QUERY_FILE=queries/calls.local.sql
CALL_QUERY_FILE=queries/call.local.sql
```

Settings: `.env.development`, `.env.staging`, `.env.production` (read as the other services do).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | the local stack's `likho_connector` | The connector's own state: which calls were fetched, the cursor |
| `NATS_URL`, `CONSUMER_GROUP`, `CONSUMERS_ENABLED` | the local stack's | The bus; off for a command-only use |
| `NATS_CONNECT_TIMEOUT_SECONDS` | `120` | How long the start keeps trying to reach NATS before giving up |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | Also push the metrics there (OTLP/HTTP); `GET /metrics` (calls asked for by outcome and how long they took, bytes fetched, events handled) is always on |
| `LIKHO_API_URL`, `LIKHO_API_KEY`, `WORKSPACE_ID`, `SOURCE` | `http://localhost:8080`, –, –, `ameyo` | Where the calls go; requests of another workspace or source are not this connector's |
| `AMEYO_VOICELOG_URL`, `AMEYO_HASH_KEY`, `AMEYO_POLICY_NAME`, `AMEYO_REQUESTING_HOST`, `AMEYO_TIMEOUT_SECONDS` | –, 120 | The dialer's live voice-log API (the last week or two of recordings) |
| `AMEYO_ARCHIVAL_URL`, `AMEYO_ARCHIVAL_FILE_ID` | –, `123` | The voice-log archiver, asked by the leg's `call_id` (from the dialer's database) when the live server has no recording; the recording's `audioFrom` attribute says `live` or `archive`. Empty = not looked for |
| `DIALER_DATABASE_URL`, `CALLS_QUERY_FILE`, `CALL_QUERY_FILE` | –, the examples | The dialer's reporting database and the two queries |
| `CAMPAIGNS_LIST_QUERY_FILE`, `AGENTS_QUERY_FILE`, `WINDOW_QUERY_FILE` | the examples | The lists: campaigns, agents and the calls of a window (columns in [src/lists.ts](src/lists.ts)) |
| `DIALER_TIMEZONE` | `TZ`, else UTC | The zone of the dialer's clock: a window asked for in UTC is turned into it |
| `GRPC_PORT` | 5060 | The lists for likho-api |
| `SETTINGS_FROM_LIKHO` | true | Take the schedule, policy, budget and write-back from the workspace's settings in Likho; false = the `.env` values only |
| `SCHEDULE_ENABLED`, `POLL_INTERVAL_SECONDS`, `BATCH_LIMIT`, `DAILY_LIMIT`, `SCHEDULE_START` | off, 300, 50, 200, '' | The schedule and its budget (from Likho's settings when `SETTINGS_FROM_LIKHO`); `SCHEDULE_START` is the `call_time` text it begins at |
| `CAMPAIGNS`, `MIN_TALK_SECONDS`, `PHONE_DIGITS` | all, 20, 4 | The policy; how many digits of a phone number are kept |
| `WRITEBACK_ENABLED`, `CRM_DATABASE_URL`, `WRITEBACK_QUERY_FILE` | off, –, the example | The transcript back into the CRM |

## How a call travels

```
schedule / request / command
   → details          the dialer's database (campaign, agent, disposition, call time, talk time, phone masked)
   → audio            GET …/command?command=downloadVoiceLog&data={'crtObjectId':…,'targetFormat':'mp3'}
   → recording        POST /api/v1/recordings {externalId, source: ameyo, attributes}; PUT the file
   → transcription    the workspace's auto-transcribe, or a job when the recording was already there
   → outcome          the state table; likho.import.completed / failed for whoever asked
   → write-back       likho.transcription.completed → GET the transcript → UPDATE the CRM row
```

A call that is already in Likho is not fetched twice (the state remembers it, and likho-media
recognises the same audio). A dialer that does not answer makes the request come back later;
a call the dialer does not have is answered at once with the reason.

## Develop

```bash
pnpm test            # against the local stack (PostgreSQL, NATS); the dialer and likho-api are stand-ins
pnpm lint && pnpm typecheck && pnpm build
docker build -t likho-connector-ameyo .
```
