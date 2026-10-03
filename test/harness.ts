/**
 * Tests that need the likho-infra stack (PostgreSQL for the state, NATS for the service) get a
 * schema of their own, dropped at the end. Without the stack they are skipped; with
 * LIKHO_REQUIRE_STACK=1 (set in CI) they fail instead.
 */
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import pg from 'pg';
import { loadConfig, type Config } from '../src/config.js';

function reachable(address: string): Promise<boolean> {
  const [host, port] = address.split(':');
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port), timeout: 1000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
  });
}

function hostOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port}`;
}

export async function requireStack(): Promise<boolean> {
  const config = loadConfig({ LIKHO_ENV: 'test' }, 'D:/nowhere');
  const missing: string[] = [];
  for (const [name, address] of [
    ['PostgreSQL', hostOf(config.DATABASE_URL)],
    ['NATS', hostOf(config.NATS_URL)],
  ]) {
    if (!(await reachable(address!))) missing.push(name!);
  }
  if (missing.length === 0) return true;
  const message = `${missing.join(', ')} not reachable; start the likho-infra stack`;
  if (process.env.LIKHO_REQUIRE_STACK === '1') throw new Error(message);
  console.warn(message + ' (tests skipped)');
  return false;
}

export interface TestDb {
  url: string;
  schema: string;
  drop(): Promise<void>;
}

/** A schema of its own in the local likho_connector database, and a URL that uses it. */
export async function testDb(): Promise<TestDb> {
  const base = loadConfig({ LIKHO_ENV: 'test' }, 'D:/nowhere').DATABASE_URL;
  const schema = 'test_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return {
    url: url.toString(),
    schema,
    async drop() {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export function testConfig(db: TestDb, overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ LIKHO_ENV: 'test' }, 'D:/nowhere'),
    DATABASE_URL: db.url,
    CONSUMER_GROUP: db.schema,
    HTTP_PORT: 0,
    LIKHO_API_KEY: 'lk_test',
    WORKSPACE_ID: 'wsp_01TEST0000000000000000000A',
    // Requests of earlier test runs are still in the shared stream; a source of its own keeps them out.
    SOURCE: `test-${db.schema}`,
    ...overrides,
  };
}
