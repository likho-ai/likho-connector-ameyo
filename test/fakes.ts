/**
 * The two systems the connector talks to over HTTP, as small servers on local ports: the
 * dialer's voice-log API and likho-api's REST API. Tests decide what they answer and read
 * what they were asked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A made-up MP3: an ID3 header and a few bytes. No recording is part of this repository. */
export const MP3 = Uint8Array.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4,
]);

type Answer = { status?: number; type?: string; body: Uint8Array | string };

export class FakeAmeyo {
  /** crt_object_id → what the live server answers; a missing id answers 404. */
  answers = new Map<string, Answer>();
  /** call_id → what the archiver answers; a missing id answers 404. */
  archived = new Map<string, Answer>();
  asked: { id: string; headers: Record<string, string | undefined> }[] = [];
  askedArchive: string[] = [];
  down = false;
  server!: Server;
  url = '';
  archiveUrl = '';

  async start(): Promise<this> {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.url = `${origin}/ameyowebaccess`;
    this.archiveUrl = `${origin}/dacx/download`;
    return this;
  }

  private handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/dacx/download') {
      const match = /^dacx:\/\/voicelog-archiver-storage-path\/(.+)$/.exec(
        url.searchParams.get('dacxURI') ?? '',
      );
      const callId = match?.[1] ?? '';
      this.askedArchive.push(callId);
      this.answer(this.archived.get(callId), response);
      return;
    }
    if (
      url.pathname !== '/ameyowebaccess/command' ||
      url.searchParams.get('command') !== 'downloadVoiceLog'
    ) {
      response.writeHead(404).end();
      return;
    }
    const match = /'crtObjectId':'([^']*)'/.exec(url.searchParams.get('data') ?? '');
    const id = match?.[1] ?? '';
    this.asked.push({
      id,
      headers: {
        hashKey: request.headers['hash-key'] as string,
        policy: request.headers['policy-name'] as string,
      },
    });
    this.answer(this.answers.get(id), response);
  }

  private answer(answer: Answer | undefined, response: ServerResponse) {
    if (this.down) {
      response.writeHead(503).end('down');
      return;
    }
    if (!answer) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'audio/mpeg' });
    response.end(answer.body);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export interface FakeRecording {
  id: string;
  originalName: string;
  status: string;
  externalId: string;
  source: string;
  sha256: string;
  attributes: Record<string, string>;
  latestTranscriptId: string;
}

export class FakeLikho {
  recordings: FakeRecording[] = [];
  uploads: { id: string; bytes: number; contentType: string }[] = [];
  jobs: string[] = [];
  transcripts = new Map<string, { textRoman: string; textScript: string }[]>();
  keys = new Set<string>(['lk_test']);
  counter = 0;
  server!: Server;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://x');
    const path = url.pathname;
    if (path.startsWith('/media/uploads/')) {
      const id = path.split('/')[3]!;
      const bytes = await this.body(request);
      this.uploads.push({ id, bytes: bytes.length, contentType: request.headers['content-type'] ?? '' });
      const recording = this.recordings.find((r) => r.id === id);
      if (recording) recording.status = 'ready';
      response.writeHead(204).end();
      return;
    }
    const key = (request.headers.authorization ?? '').replace('Bearer ', '');
    if (!this.keys.has(key)) {
      this.json(response, 401, { error: { code: 'unauthenticated', message: 'Sign in first.' } });
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/recordings') {
      const input = JSON.parse((await this.body(request)).toString()) as Record<string, any>;
      const existing = this.recordings.find((r) => r.sha256 === input.sha256);
      if (existing) {
        this.json(response, 201, {
          recording: existing,
          uploadUrl: '',
          expiresAt: null,
          duplicateOf: existing,
        });
        return;
      }
      this.counter += 1;
      const recording: FakeRecording = {
        id: `rec_${String(this.counter).padStart(26, '0')}`,
        originalName: input.originalName,
        status: 'uploading',
        externalId: input.externalId ?? '',
        source: input.source ?? 'api',
        sha256: input.sha256 ?? '',
        attributes: input.attributes ?? {},
        latestTranscriptId: '',
      };
      this.recordings.push(recording);
      this.json(response, 201, {
        recording,
        uploadUrl: `${this.url}/media/uploads/${recording.id}?token=t`,
        expiresAt: null,
        duplicateOf: null,
      });
      return;
    }
    const one = /^\/api\/v1\/recordings\/([^/]+)(\/jobs|\/transcript)?$/.exec(path);
    if (one) {
      const recording = this.recordings.find((r) => r.id === one[1]);
      if (!recording) {
        this.json(response, 404, { error: { code: 'not_found', message: 'No such recording.' } });
        return;
      }
      if (one[2] === '/jobs' && request.method === 'POST') {
        if (recording.status !== 'ready' && recording.status !== 'done') {
          this.json(response, 400, { error: { code: 'invalid', message: 'Not ready.' } });
          return;
        }
        this.jobs.push(recording.id);
        recording.status = 'queued';
        this.json(response, 201, { id: 'job_1', status: 'queued' });
        return;
      }
      if (one[2] === '/transcript') {
        const lines = this.transcripts.get(recording.id);
        this.json(response, 200, {
          status: recording.status,
          transcript: lines
            ? { segments: lines.map((l, i) => ({ index: i, startSeconds: i, endSeconds: i + 1, ...l })) }
            : null,
        });
        return;
      }
      this.json(response, 200, recording);
      return;
    }
    this.json(response, 404, { error: { code: 'not_found', message: 'No such route.' } });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
