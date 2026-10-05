/**
 * The event bus (NATS JetStream). Events are CloudEvents 1.0 as JSON (likho-contracts/events).
 *
 *   takes      likho.import.requested      a person or a schedule asked for a call by its id
 *              likho.recording.deleted     the recording is gone: the call may be fetched again
 *              likho.transcription.completed   a transcript exists: write it back to the CRM
 *   publishes  likho.import.completed / likho.import.failed
 */
import {
  AckPolicy,
  connect,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  type NatsConnection,
  StringCodec,
} from 'nats';
import { newId } from './ids.js';
import { describe, type Logger } from './log.js';

export const SOURCE = 'likho-connector-ameyo';
const codec = StringCodec();

export interface CloudEvent<T = Record<string, unknown>> {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  time: string;
  subject: string;
  datacontenttype: 'application/json';
  data: T;
}

export function event<T extends Record<string, unknown>>(
  type: string,
  subject: string,
  data: T,
): CloudEvent<T> {
  return {
    specversion: '1.0',
    id: newId('evt'),
    source: SOURCE,
    type,
    time: new Date().toISOString(),
    subject,
    datacontenttype: 'application/json',
    data,
  };
}

export type Handler = (event: CloudEvent) => Promise<void>;

interface Consumer {
  stop: () => void;
  done: Promise<void>;
}

export class Bus {
  private connection: NatsConnection | null = null;
  private jetstream: JetStreamClient | null = null;
  private manager: JetStreamManager | null = null;
  private readonly consumers: Consumer[] = [];
  private readonly durables: string[] = [];
  /** Told what became of every event taken: ok, retry, dropped (for the metrics). */
  handled: ((subject: string, outcome: 'ok' | 'retry' | 'dropped') => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly group: string,
    private readonly log: Logger,
  ) {}

  /**
   * Connects, trying again while NATS is not there yet (it may be starting at the same time),
   * for `timeoutSeconds`; once connected, the client reconnects on its own.
   */
  async connect(timeoutSeconds = 0): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let wait = 1000;
    for (;;) {
      try {
        await this.open();
        this.log.info(`connected to ${this.url}`);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.connection?.close().catch(() => undefined);
        this.connection = null;
        if (Date.now() + wait > deadline) {
          throw new Error(`the event bus at ${this.url} did not answer in time: ${reason}`);
        }
        this.log.warn(`event bus not ready (${reason}); trying again in ${wait / 1000} s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, 10_000);
      }
    }
  }

  private async open(): Promise<void> {
    this.connection = await connect({
      servers: this.url,
      name: SOURCE,
      maxReconnectAttempts: -1,
      timeout: 5_000,
    });
    this.jetstream = this.connection.jetstream();
    this.manager = await this.connection.jetstreamManager();
    try {
      await this.manager.streams.info('LIKHO');
    } catch {
      throw new Error('stream LIKHO does not exist; create the streams first (likho-infra: scripts/up.sh)');
    }
  }

  get connected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }

  async publish(subject: string, body: CloudEvent): Promise<void> {
    if (!this.jetstream) throw new Error('the bus is not connected');
    await this.jetstream.publish(subject, codec.encode(JSON.stringify(body)), {
      msgID: body.id,
      timeout: 5_000,
    });
  }

  /**
   * Takes events from a subject through a durable pull consumer named <group>-<name>. The handler
   * acknowledges by returning; a thrown error means try again later (five times, then dropped).
   */
  async consume(options: {
    stream: 'LIKHO';
    name: string;
    subject: string;
    handler: Handler;
  }): Promise<void> {
    if (!this.manager || !this.jetstream) throw new Error('the bus is not connected');
    const durable = `${this.group}-${options.name}`;
    await this.manager.consumers.add(options.stream, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      ack_wait: 120_000_000_000, // 120 s in nanoseconds: a download may take a while
      max_deliver: 5,
      deliver_policy: DeliverPolicy.All,
      filter_subject: options.subject,
    });
    this.durables.push(durable);
    const consumer = await this.jetstream.consumers.get(options.stream, durable);
    const messages = await consumer.consume({ max_messages: 1 });
    const done = (async () => {
      for await (const message of messages) await this.handle(message, options.handler);
    })();
    this.consumers.push({ stop: () => messages.stop(), done });
    this.log.info(`taking ${options.subject} as ${durable}`);
  }

  private async handle(message: JsMsg, handler: Handler): Promise<void> {
    let parsed: CloudEvent;
    try {
      parsed = JSON.parse(codec.decode(message.data)) as CloudEvent;
      if (!parsed?.type || !parsed.id || typeof parsed.data !== 'object') throw new Error('not a CloudEvent');
    } catch (error) {
      this.log.error(`dropping a message on ${message.subject} that is not an event`, {
        error: describe(error),
      });
      message.term();
      this.handled?.(message.subject, 'dropped');
      return;
    }
    try {
      await handler(parsed);
      message.ack();
      this.handled?.(message.subject, 'ok');
    } catch (error) {
      const attempt = message.info.redeliveryCount;
      this.log.warn(`${parsed.type} ${parsed.id} attempt ${attempt} failed`, { error: describe(error) });
      if (attempt >= 5) {
        message.term();
        this.handled?.(message.subject, 'dropped');
      } else {
        message.nak(Math.min(attempt, 5) * 10_000);
        this.handled?.(message.subject, 'retry');
      }
    }
  }

  /** Deletes the durable consumers this connection made (tests use names of their own). */
  async forget(): Promise<void> {
    for (const consumer of this.consumers) consumer.stop();
    for (const durable of this.durables) {
      try {
        await this.manager?.consumers.delete('LIKHO', durable);
      } catch {
        /* already gone */
      }
    }
  }

  async close(): Promise<void> {
    for (const consumer of this.consumers) consumer.stop();
    await Promise.allSettled(this.consumers.map((c) => c.done));
    await this.connection?.close();
  }
}
