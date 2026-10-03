/**
 * The .env files of the current environment.
 *
 * LIKHO_ENV (development, staging or production; default development) picks the files. They are
 * read in this order, each one overriding the one before, and a variable that is already set in
 * the real environment wins over all of them:
 *
 *     .env  .env.local  .env.<LIKHO_ENV>  .env.<LIKHO_ENV>.local
 *
 * The .env.<LIKHO_ENV> files are committed and hold no secrets; the .local files are ignored by
 * git and hold the secrets of that environment on this machine. A file that does not exist is
 * skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function envFileNames(env: string): string[] {
  return ['.env', '.env.local', `.env.${env}`, `.env.${env}.local`];
}

/** Returns the environment with the files applied, and the names of the files that were read. */
export function withEnvFiles(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): { env: NodeJS.ProcessEnv; read: string[] } {
  const name = env.LIKHO_ENV ?? 'development';
  const fromFiles: Record<string, string> = {};
  const read: string[] = [];
  for (const file of envFileNames(name)) {
    const path = `${cwd}/${file}`;
    if (!existsSync(path)) continue;
    Object.assign(fromFiles, parseEnv(readFileSync(path, 'utf8')));
    read.push(file);
  }
  const merged: NodeJS.ProcessEnv = { ...fromFiles };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
  return { env: merged, read };
}
