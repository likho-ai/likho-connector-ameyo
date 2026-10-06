/**
 * The connector's settings, from the environment and the .env files of LIKHO_ENV (see env-files.ts).
 *
 * Three systems meet here: the dialer (its API for the audio and, when allowed, its reporting
 * database for the call details), Likho (likho-api with an API key, and the event bus), and
 * the CRM (an optional write-back of the transcript). Everything company-specific - hosts,
 * keys, the SQL that names tables and campaigns - lives in .env.<environment>.local and in
 * queries/*.local.sql, never in this repository.
 */
import { z } from 'zod';
import { withEnvFiles } from './env-files.js';

const seconds = z.coerce.number().int().min(0);
const flag = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const ConfigSchema = z.object({
  LIKHO_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** /healthz and /readyz. */
  HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(4060),
  /** likho.dialer.v1: the dialer's campaigns, agents and calls, for likho-api. */
  GRPC_PORT: z.coerce.number().int().min(0).max(65535).default(5060),
  /**
   * The zone of the dialer's clock (its call_time is written without a zone). Empty = TZ, else UTC.
   * Windows asked for in UTC are turned into this clock before the queries run.
   */
  DIALER_TIMEZONE: z.string().default(''),
  /** Read the schedule, policy, budget and write-back from the workspace's settings in likho-api. */
  SETTINGS_FROM_LIKHO: flag.default(true),
  /** While Likho has not answered yet, how often its settings are asked for again. */
  SETTINGS_RETRY_SECONDS: z.coerce.number().int().min(1).default(30),

  /** The connector's own state: which calls were fetched, the schedule's cursor. */
  DATABASE_URL: z
    .string()
    .default('postgres://likho_connector:likho_connector@localhost:5433/likho_connector'),
  NATS_URL: z.string().default('nats://localhost:4222'),
  /** How long the start keeps trying to reach NATS before giving up. */
  NATS_CONNECT_TIMEOUT_SECONDS: seconds.default(120),
  CONSUMER_GROUP: z.string().default('likho-connector-ameyo'),
  CONSUMERS_ENABLED: flag.default(true),
  /** Metrics are always at GET /metrics; set this to also push them (OTLP/HTTP). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),

  /** likho-api, with an API key of the workspace the calls go to. */
  LIKHO_API_URL: z.string().default('http://localhost:8080'),
  LIKHO_API_KEY: z.string().default(''),
  /** The workspace that key belongs to; import requests of other workspaces are not this connector's. */
  WORKSPACE_ID: z.string().default(''),
  /** The name this connector gives as the source of a recording, and answers requests for. */
  SOURCE: z.string().default('ameyo'),

  /** The dialer's voice-log API: GET <url>/command?command=downloadVoiceLog&data=... */
  AMEYO_VOICELOG_URL: z.string().default(''),
  AMEYO_HASH_KEY: z.string().default(''),
  AMEYO_POLICY_NAME: z.string().default(''),
  AMEYO_REQUESTING_HOST: z.string().default(''),
  AMEYO_TIMEOUT_SECONDS: seconds.default(120),
  /**
   * The dialer's voice-log archiver, for recordings the live server no longer has: a plain GET
   * of <url>?dacxURI=dacx://voicelog-archiver-storage-path/<call_id>&fileId=...&mediaType=AUDIO,
   * by the leg's call_id (from the dialer's database). Empty = not looked for.
   */
  AMEYO_ARCHIVAL_URL: z.string().default(''),
  AMEYO_ARCHIVAL_FILE_ID: z.string().default('123'),

  /**
   * The dialer's reporting database (PostgreSQL), read only, for the call details and the
   * schedule. Empty = no details: a call is fetched by its id alone. The SQL files say which
   * calls (see queries/).
   */
  DIALER_DATABASE_URL: z.string().default(''),
  CALLS_QUERY_FILE: z.string().default('queries/calls.example.sql'),
  CALL_QUERY_FILE: z.string().default('queries/call.example.sql'),
  /** A leg's call_id to its interaction's crt_object_id (people paste call ids from reports). */
  CRT_QUERY_FILE: z.string().default('queries/crt.example.sql'),
  /** The lists people choose from: the campaigns, the agents and the calls of a window (see src/lists.ts). */
  CAMPAIGNS_LIST_QUERY_FILE: z.string().default('queries/campaigns.example.sql'),
  AGENTS_QUERY_FILE: z.string().default('queries/agents.example.sql'),
  WINDOW_QUERY_FILE: z.string().default('queries/window.example.sql'),

  /** The schedule: fetch new calls every so often, within a daily budget (one CPU is finite). */
  SCHEDULE_ENABLED: flag.default(false),
  POLL_INTERVAL_SECONDS: seconds.default(300),
  BATCH_LIMIT: z.coerce.number().int().min(1).default(50),
  DAILY_LIMIT: z.coerce.number().int().min(1).default(200),
  /** Where the schedule begins the first time (the dialer's call_time text, e.g. 2026-10-03 00:00:00). */
  SCHEDULE_START: z.string().default(''),
  /** The policy: campaigns to take (comma-separated; empty = all) and the shortest talk time. */
  CAMPAIGNS: z.string().default(''),
  MIN_TALK_SECONDS: seconds.default(20),
  /** Keep only the last digits of a phone number in the attributes. 0 = no phone at all. */
  PHONE_DIGITS: z.coerce.number().int().min(0).max(10).default(4),

  /** Write the transcript back to the CRM (MS SQL Server) when a transcription completes. */
  WRITEBACK_ENABLED: flag.default(false),
  CRM_DATABASE_URL: z.string().default(''),
  WRITEBACK_QUERY_FILE: z.string().default('queries/writeback.example.sql'),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Reads the settings from the environment and the .env files, and checks them. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const { env: merged } = withEnvFiles(env, cwd);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`configuration: ${problems}`);
  }
  const config = parsed.data;
  const real = config.LIKHO_ENV === 'staging' || config.LIKHO_ENV === 'production';
  if (real && !config.LIKHO_API_KEY)
    throw new Error('configuration: LIKHO_API_KEY must be set in ' + config.LIKHO_ENV);
  if (config.SCHEDULE_ENABLED && !config.DIALER_DATABASE_URL)
    throw new Error('configuration: the schedule needs DIALER_DATABASE_URL (where the new calls are listed)');
  if (config.WRITEBACK_ENABLED && !config.CRM_DATABASE_URL)
    throw new Error('configuration: the write-back needs CRM_DATABASE_URL');
  try {
    new Intl.DateTimeFormat('en', { timeZone: dialerZone(config) });
  } catch {
    throw new Error(`configuration: DIALER_TIMEZONE ${config.DIALER_TIMEZONE} is not a known zone`);
  }
  return config;
}

/** The zone of the dialer's clock: DIALER_TIMEZONE, else TZ, else UTC. */
export function dialerZone(config: Pick<Config, 'DIALER_TIMEZONE'>): string {
  return config.DIALER_TIMEZONE || process.env.TZ || 'UTC';
}

/** The campaigns the policy takes, or an empty list for all. */
export function campaignsOf(config: Pick<Config, 'CAMPAIGNS'>): string[] {
  return config.CAMPAIGNS.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}
