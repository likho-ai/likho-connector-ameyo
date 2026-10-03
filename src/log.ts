/** One JSON object per line, with the same field names as the other Likho services. */
export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: Level, logger = 'likho-connector-ameyo', out = process.stdout): Logger {
  const write = (at: Level, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < ORDER[level]) return;
    out.write(
      JSON.stringify({ time: new Date().toISOString(), level: at, logger, message, ...fields }) + '\n',
    );
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/** A logger that says nothing (tests). */
export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** What an error is called in a log line, without a stack. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
